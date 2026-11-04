import { AvatarService } from './avatars.js';
import { GroupWorkspace, selectedGroup } from './group-workspace.js';
import { groupHistory } from './group-history.js';
import { GroupSummaries } from './group-summaries.js';
import { GroupHistoryImporter, storedHistoryCursor } from './group-history-import.js';
import http from 'node:http';
import { BlockList, isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store, fail, text, choice, brand, CHANNEL_KINDS, PROVIDERS, MODES, DEMO_CHANNEL_REFUSAL, demoRefusal } from './store.js';
import { WhatsAppGateway, normalizeNumber } from './whatsapp.js';
import { TelegramGateway } from './telegram.js';
import { TelegramUserGateway } from './telegram-user.js';
import { assertTelegramAccountAiAllowed, telegramAccountAiAllowed } from './telegram-account-policy.js';
import { Auth } from './auth.js';
import { SignupTrials } from './signup-trial.js';
import { AccountDeletion } from './commercial-account-deletion.js';
import { FlowService } from './flows.js';
import { AgentRuntime, createHermesProvider, TOOL_POLICIES, agentProfile, applyAgentProfile, AI_QUOTA_REASON } from './agent-runtime.js';
import { checkAgentServiceHealth } from './agent-service-health.js';
import { McpManager, internalConversationHistory, internalContactProfile, internalKnowledgeResult } from './mcp.js';
import { KnowledgeBase } from './knowledge.js';
import { AgentMemory } from './agent-memory.js';
import { encryptedChannelSecrets } from './channel-secrets.js';
import { loadLocalKey } from './wa-auth.js';
import { PostgresBridge } from './postgres-bridge.js';
import { Outbox } from './outbox.js';
import { GoogleIdentity } from './google-auth.js';
import { EmailService } from './email.js';
import { Operations, noteStatus } from './operations.js';
import { ContactService, syncConversationContact } from './contacts.js';
import { MediaService, MEDIA_MAX_BYTES } from './media.js';
import { channelCapabilities, conversationCapabilities, validateAttachmentSelection, assertChannelText } from '../public/channel-capabilities.js';
import { brandStylesheet } from '../public/brand-theme.js';
import { normalizeVoiceRecording } from './audio.js';
import { QuickReplies } from './quick-replies.js';
import { createAttendanceService } from './attendance.js';
import { createScheduledMessages } from './scheduled-messages.js';
import { createConversationFollowUps } from './conversation-follow-ups.js';
import { createForwardingService } from './forwarding.js';
import { resolveReply } from './replies.js';
import { AutomationService } from './automation.js';
import { retainedMediaIds } from './media-backup.js';
import { createConsolidatedInbox } from './consolidated-inbox.js';
import { ContactImportService } from './contact-import.js';
import { TeamChat } from './team-chat.js';
import { SupportAccess } from './support-access.js';
import { ServicePrincipals, serviceGroupContext } from './service-principals.js';
import { serviceResponsePolicy } from './service-response-policy.js';
import { loadPrivateServiceReplyLimits, ServiceReplyRateLimitError, channelReplyPolicy } from './service-reply-limits.js';
import { loadPrivateServiceMediaPolicy } from './service-attachment-media.js';
import { ServiceWebhooks } from './service-webhooks.js';
import { OwnLines } from './own-lines.js';
import { ServiceActivity } from './service-activity.js';
import { connectedProducts } from './connected-products.js';
import { ProductConnections } from './product-connections.js';
import { ServiceApi } from './service-api.js';
import { ServiceNotifications } from './service-notifications.js';
import { createServiceMcpHandler } from './service-mcp.js';
import { ATTENDANT_SKILL_PATH, serveAttendantSkill } from './agent-skill.js';
import { CentralSupport } from './central-support.js';
import { Billing } from './billing.js';
import { StripeBilling, STRIPE_WEBHOOK_MAX_BYTES, stripeCheckoutEnabled, billingReturnPage } from './stripe-billing.js';
import { CommercialAccounts } from './commercial-accounts.js';
import { CommercialUsage, PlanQuotaGuard } from './commercial-usage.js';
import { CommercialPlans } from './commercial-plans.js';
import { WorkspaceDomains } from './workspace-domains.js';
import { createDomainDeploymentInspector,signDomainProbe } from './domain-deployment.js';
import { WebchatGateway } from './channel-webchat.js';
import { WebchatIdentity } from './webchat-identity.js';
import { decodeWebchatMedia, decodeWebchatMediaMetadata, WEBCHAT_MEDIA_FRAME_MAX_BYTES } from './webchat-media.js';
import { EmailChannelGateway } from './channel-email.js';
import { MetaGateway } from './channel-meta.js';
import { PANEL_STATIC_FILES, PANEL_ASSETS, BRAND_STYLESHEET_PATH } from './panel-assets.js';
import { createPublicSite } from './public-site.js';
import { publicSiteHtmlHint, publicRootVary, publicSiteCsp } from './public-site-http.js';
import { createEventBus, createEventStreamHub } from './events.js';
import { AgentAutopilot, autopilotCovers, normalizeAutopilotConfig } from './agent-autopilot.js';
import { ChannelOnboarding } from './channel-onboarding.js';
import { pollChannel } from './whatsapp-polls.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version: appVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// Single allowlist of panel pages and assets, shared with scripts/verify.mjs (FRONTEND-V2 §8.1).
const staticFiles = PANEL_STATIC_FILES;
// Neutral on purpose: the same page answers on resellers' own domains, so it names no product.
const NOT_FOUND_PAGE = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Página não encontrada</title></head>'
  + '<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#193149;background:#f6f8fa"><main style="max-width:32rem;margin:18vh auto 0;padding:0 16px;line-height:1.6">'
  + '<h1 style="font-size:1.5rem;margin:0 0 .5rem">Página não encontrada</h1><p style="margin:0 0 1rem">Este endereço não existe neste painel. <span lang="en">This page does not exist.</span></p>'
  + '<p style="margin:0"><a href="/" style="color:#27644b">Ir para o início</a> · <a href="/login" style="color:#27644b">Entrar</a></p></main></body></html>';
// The visitor widget's complete audited ESM graph contains only public client
// code. Keep this allowlist separate from panel assets and all API responses.
const publicWidgetAssets = new Set(['/widget.js', '/widget-saas.js', '/channel-capabilities.js', '/webchat-media.js', '/i18n.js', '/locales-media.js']);
// Server capabilities announced in GET /api/bootstrap (FRONTEND-V2 §7.4). The panel uses only what is listed, so a newer
// panel works against an older API and each capability appears together with the route that serves it.
export const API_FEATURES = Object.freeze(['inbox-since', 'inbox-agent-state', 'tenant-summary', 'conversation-delta', 'attention', 'events',
  'agent-runs', 'agent-preview', 'knowledge-preview', 'principal-last-seen', 'source-run-id', 'contacts-limit', 'agent-autopilot', 'channel-onboarding']);
// Public message DTO: sender transport identities and internal job links never leave the server.
// providerJid/providerTs (the WhatsApp key kept as a history anchor) are server-only, like the sender JIDs.
const publicMessage = ({ senderId, senderJid, senderJidAlt, providerJid, providerTs, supportAssistantJobId, autopilotJobId, ...message }) => message;
const ACTIVE_RUNS = new Set(['queued', 'running', 'draft', 'waiting_approval', 'tool_running']);
/** Writes a demo company refuses before any work: channels, external agents and model calls (Store.mutate keeps the transport invariant). */
const DEMO_AGENT_REFUSAL = 'Empresa de demonstração não conecta agentes externos nem chama modelos de IA. Use uma empresa real.';
export function demoRouteRefusal(action, method) {
  if (method === 'GET' || method === 'HEAD') return null;
  if (action === 'channels' || action.startsWith('channels/')) return DEMO_CHANNEL_REFUSAL;
  if (['agents', 'service-principals', 'mcp/servers'].includes(action) || /^(service-principals|mcp\/servers)\//.test(action)
    || /^agents\/[^/]+(?:\/(?:preview|mcp-grants))?$/.test(action) || /^conversations\/[^/]+\/(?:run|group-summary|history-import|group-history-import)$/.test(action)) return DEMO_AGENT_REFUSAL;
  return null;
}
/** If-None-Match uses the weak comparison (RFC 9110): W/ is ignored, so a tag weakened by a compressing proxy still matches. */
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header.trim() || header.length > 8192) return false;
  if (header.trim() === '*') return true;
  const opaque = value => value.trim().replace(/^W\//, '');
  return header.split(',').some(value => opaque(value) === opaque(etag));
}

export function createApp({ databasePath = resolve(root, 'data/sandbox.sqlite'), conversationJournal = false, realtimeOptions = {}, gatewayOptions = {}, telegramOptions = {}, telegramUserOptions = {}, webchatOptions = {}, emailChannelOptions = {}, metaOptions = {}, domainOptions = {}, releaseRevision=process.env.MEPCHAT_SOURCE_REVISION||'', scheduledOptions = {}, mediaOptions = {}, voiceNormalizer = normalizeVoiceRecording, automationOptions = {}, allowDemo = false, postgres = false, providerCall, publicOrigin=process.env.MEPCHAT_PUBLIC_ORIGIN||'',allowRegistration=true,publicTrialEnabled=process.env.MEPCHAT_PUBLIC_TRIAL_ENABLED==='true',googleOptions={},emailOptions={},serviceKey,agentOrigins = (process.env.MEPCHAT_AGENT_ORIGINS || '').split(',').filter(Boolean),agentProfileOrigins=(process.env.MEPCHAT_AGENT_PROFILE_ORIGINS||'').split(',').filter(Boolean),mcpOrigins=(process.env.MEPCHAT_MCP_ORIGINS||'').split(',').filter(Boolean),mcpPrivateOrigins=(process.env.MEPCHAT_MCP_PRIVATE_ORIGINS||'').split(',').filter(Boolean),mcpFetchImpl,trustedProxies=(process.env.MEPCHAT_TRUSTED_PROXIES||'').split(',').map(item=>item.trim()).filter(Boolean),healthOptions={},autopilotOptions={},serviceReplyLimits=loadPrivateServiceReplyLimits(databasePath),serviceMediaPolicy=loadPrivateServiceMediaPolicy(databasePath),webhookOptions={},siteOptions={},stripeOptions={} } = {}) {
  // Keep the trial implementation and existing reservations; an offer is opt-in.
  if (typeof publicTrialEnabled !== 'boolean') throw Error('A oferta de teste público exige uma configuração booleana.');
  if (typeof conversationJournal !== 'boolean') throw Error('O journal de conversas exige uma configuração booleana.');
  // Origins of full Hermes profiles (the agents gateway) are agent services too, and their agents bring their own
  // company knowledge. The operator declares them; a tenant can only pick an origin from these lists.
  if(!Array.isArray(agentProfileOrigins)||agentProfileOrigins.some(value=>{try{return new URL(value).origin!==value;}catch{return true;}}))throw Error('Origem de perfil Hermes inválida.');
  agentOrigins=[...new Set([...agentOrigins,...agentProfileOrigins])];
  const ownProfileKnowledge=agent=>{try{return agent?.configured===true&&agentProfileOrigins.includes(new URL(agent.endpoint).origin);}catch{return false;}};
  // Tests may pass a predicate to simulate a direct (untrusted) peer; production lists proxy IPs/CIDRs or "gateway".
  const trustedProxy=typeof trustedProxies==='function'?trustedProxies:trustedProxyCheck(trustedProxies);
  if(Array.isArray(trustedProxies)&&trustedProxies.some(entry=>String(entry).trim().toLowerCase()==='gateway')&&!defaultGateway())console.error('Gateway do container não identificado; limites por cliente usam o endereço da conexão.');
  const publicURL=publicOrigin?new URL(publicOrigin):null;
  if(publicURL&&(publicURL.protocol!=='https:'||publicURL.origin!==publicOrigin))throw Error('Origem pública HTTPS inválida.');
  // Tests pass siteOptions.pricing; production publishes only the prices approved in src/public-site.js.
  const publicSite=publicURL?createPublicSite({...siteOptions,origin:publicOrigin,registration:allowRegistration,trial:publicTrialEnabled&&allowRegistration,checkout:stripeCheckoutEnabled({env:stripeOptions.env||process.env,config:stripeOptions.config,publicOrigin:stripeOptions.publicOrigin??publicOrigin})/* stripe-billing hook: checkout copy only when the billing API is enabled */}):null;
  const store = new Store(databasePath, { conversationJournal }), sessions = new Map();
  // Agent as attendant (agent-autopilot.js): built after the runtime, operations and outbox; read lazily by their hooks.
  let autopilot = null;
  // In-process change bus (FRONTEND-V2 §7.4): Store.mutate publishes pointer events after each commit.
  const events = createEventBus({ onError: () => console.error('Assinante de eventos falhou; a mudança foi preservada.') });
  store.events = events;
  store.onEventError = () => console.error('Evento de mudança não publicado; a mudança foi preservada.');
  const gateway = new WhatsAppGateway(store, gatewayOptions);
  // Own lines of a workspace never get agents on both sides of a pair; the activity of connected agents feeds the panel.
  const serviceActivity = new ServiceActivity();
  const ownLines = new OwnLines(store.db, { onBlocked: entry => serviceActivity.record({ type: 'own-line', ...entry }) });
  gateway.ownLines = ownLines;
  const telegram = new TelegramGateway(store, telegramOptions);
  const telegramUser = new TelegramUserGateway(store, {authKey:serviceKey||gatewayOptions.authKey||telegramOptions.authKey, ...telegramUserOptions});
  let invitationKey;
  const invitationKeyLoader = async () => invitationKey ||= serviceKey || await loadLocalKey();
  const signupTrials = new SignupTrials(store.db, { keyLoader: invitationKeyLoader });
  // Inside one synchronous event-stream tick, permission snapshots of every open stream share one read of each company;
  // outside a tick (every request) each check reads the live private header afresh, never a history or cached authority.
  let tenantMemo=null;
  const tenantForPermission=(actor,id)=>{
    if(!tenantMemo)return store.readonlyTenantHeader(actor,id);
    if(actor.role==='operator'&&!(actor.tenantIds||[actor.tenantId]).includes(id))fail(403,'Esta empresa não está no seu acesso.');
    const key=actor.resellerId+'\u0000'+id;if(!tenantMemo.has(key))tenantMemo.set(key,store.readonlyTenantHeader(actor,id));return tenantMemo.get(key);
  };
  const withTenantMemo=work=>{const previous=tenantMemo;tenantMemo=new Map();try{return work();}finally{tenantMemo=previous;}};
  const auth = new Auth(store.db, { validateTenant: (actor, id) => tenantForPermission(actor, id), invitationKey: invitationKeyLoader, registrationTrial: publicTrialEnabled ? signupTrials : undefined }), flows = new FlowService(store);
  const operations = new Operations(store, auth), contacts = new ContactService(store, auth);
  const teamChat = new TeamChat(store,auth);
  const contactImport = new ContactImportService(store, auth);
  const quickReplies = new QuickReplies(store, auth);
  const media = new MediaService(store,{directory:databasePath===':memory:'?null:resolve(dirname(databasePath),'media'),authKey:serviceKey||gatewayOptions.authKey||telegramOptions.authKey,...mediaOptions});
  const avatars = new AvatarService(store,{gateway,telegram,telegramUser});
  gateway.media=media;telegram.media=media;telegramUser.media=media;
  gateway.operations = operations; telegram.operations = operations;telegramUser.operations=operations;
  const google = new GoogleIdentity(store.db,{clientId:process.env.MEPCHAT_GOOGLE_CLIENT_ID||'',...googleOptions});
  const email = new EmailService(store.db,{apiKey:process.env.MEPCHAT_EMAIL_KEY||'',from:process.env.MEPCHAT_EMAIL_FROM||'',publicOrigin:publicOrigin||'http://127.0.0.1:4318',...emailOptions});
  const bridge = new PostgresBridge(store,{enabled:Boolean(postgres),...(typeof postgres==='object'?postgres:{})});
  const outbox = new Outbox(store,{beforeSend:()=>bridge.flush(), authorize: (actor, id, conversation) => operations.canReply(actor,id,conversation)});
  let secrets;
  const agentSecrets = async () => secrets ||= encryptedChannelSecrets(store.db,serviceKey||await loadLocalKey());
  const agentSecretId = (tenantId,agentId) => `agent:${tenantId}:${agentId}`;
  const agentConfig = (vault,tenantId,agentId) => {
    const scoped = vault.get(agentSecretId(tenantId,agentId));
    if(scoped)return scoped;
    // Legacy keys are usable only when their identity belongs to exactly one tenant.
    const owners=store.db.prepare('SELECT id,data FROM tenants').all().filter(row=>JSON.parse(row.data).agents?.some(agent=>agent.id===agentId));
    return owners.length===1&&owners[0].id===tenantId?vault.get(`agent:${agentId}`):null;
  };
  const provision = input=>store.provisionReseller(input);
  const platformOwner = actor => auth.isPlatformAdmin(actor);
  const accounts=new CommercialAccounts(store,{validateActor:actor=>auth.resolveActor(actor),isPlatformAdmin:platformOwner});
  // Live transports of a deleted account stop before its rows disappear: the WhatsApp device is logged out (unlinked
  // from the phone), Telegram bot polling and personal sessions end. Rows (wa_auth, channel secrets) go with the account.
  const stopDeletedChannels=async channels=>{
    // Resolves true on success, false on error or timeout; failures are counted (no PII) in the deletion audit.
    let failures=0;
    const bounded=async task=>{const ok=await Promise.race([Promise.resolve().then(task).then(()=>true,()=>false),new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),2000);timer.unref?.();})]);if(!ok)failures++;};
    for(const {channelId} of channels){
      const wa=gateway.entries?.get(channelId);
      if(wa){clearTimeout(wa.timer);wa.expected=false;wa.stopped=true;wa.generation=(wa.generation||0)+1;wa.historyCursors?.clear?.();try{gateway.historyImporter?.connectionChanged?.(wa);}catch{}
        await bounded(()=>wa.socket?.logout?.());try{wa.socket?.end?.(new Error('Conta excluída.'));}catch{}gateway.entries.delete(channelId);}
      const bot=telegram.entries?.get(channelId);
      if(bot){bot.stopped=true;bot.abort?.abort?.();clearTimeout(bot.timer);bot.wake?.();telegram.entries.delete(channelId);}
      const personal=telegramUser.entries?.get(channelId);
      if(personal){await bounded(()=>telegramUser.stop(personal));telegramUser.entries.delete(channelId);}
    }
    return {failures};
  };
  // LGPD account deletion: owner self-service and platform administration share guards and one SQLite transaction.
  const accountDeletion=new AccountDeletion(store,{auth,isPlatformAdmin:platformOwner,stopChannels:channels=>stopDeletedChannels(channels)});
  const stripeBilling=new StripeBilling(accounts,{...stripeOptions,publicOrigin:stripeOptions.publicOrigin??publicOrigin}); // stripe-billing hook (return URLs only from publicOrigin)
  const planQuota=typeof stripeBilling.subscriptionQuotas==='function'?new PlanQuotaGuard(store.db,{subscriptionQuotas:workspaceId=>stripeBilling.subscriptionQuotas(workspaceId)}):null; // quota-enforcement hook
  gateway.planQuota=planQuota;auth.planQuota=planQuota; // quota-enforcement hook
  const commercialPlans=new CommercialPlans(accounts);
  const sourceRevision=releaseRevision;
  const domains=new WorkspaceDomains(accounts,{canonicalHost:process.env.MEPCHAT_DOMAIN_CANONICAL_HOST||'elozi.je4ndev.com',inspectDeployment:/^[a-f0-9]{40}$/.test(sourceRevision)?createDomainDeploymentInspector({sourceRevision,keyLoader:invitationKeyLoader}):null,...domainOptions});
  const webchat=new WebchatGateway(store,{operations,media,...webchatOptions});
  webchat.identity ||= new WebchatIdentity(store,{secrets:{get:key=>{if(!secrets)fail(503,'Custódia do canal indisponível.');return secrets.get(key);},set:(key,value)=>{if(!secrets)fail(503,'Custódia do canal indisponível.');return secrets.set(key,value);}},channelContext:input=>webchat.identityContext(input),now:webchat.now});
  const emailChannel=new EmailChannelGateway(store,{operations,authKey:serviceKey||gatewayOptions.authKey,loadSecrets:agentSecrets,getDeliveryConfiguration:async()=>{const settings=await integrations();return {apiKey:settings.emailApiKey||process.env.MEPCHAT_EMAIL_KEY||'',from:settings.emailFrom||process.env.MEPCHAT_EMAIL_FROM||''};},...emailChannelOptions});
  const meta=new MetaGateway(store,{operations,media,authKey:serviceKey||gatewayOptions.authKey,secretLoader:agentSecrets,...metaOptions});
  const adapterFor=channel=>channel?.transport==='baileys'?gateway:channel?.transport==='telegram-bot'?telegram:channel?.transport==='telegram-user'?telegramUser:channel?.transport==='elozi-webchat'?webchat:channel?.transport==='mepmail-channel'?emailChannel:['meta-instagram','meta-messenger'].includes(channel?.transport)?meta:null;
  const channelOnboarding=new ChannelOnboarding(store,{auth,available:(tenant,channel)=>{
    if(channel.enabled===false)return false;
    const scopedEntry=adapter=>{const entry=adapter.entries.get(channel.id);return !adapter.closing&&entry?.tenantId===tenant.id&&entry.state==='connected'&&!entry.stopped?entry:null;};
    if(channel.transport==='baileys'){const entry=scopedEntry(gateway);return channel.state==='connected'&&entry?.matched===true&&entry.expectedNumber===channel.expectedNumber;}
    if(channel.transport==='telegram-bot'){const entry=scopedEntry(telegram);return channel.state==='connected'&&Boolean(channel.botAccountId)&&entry?.botId===channel.botAccountId;}
    if(channel.transport==='telegram-user'){const entry=scopedEntry(telegramUser);return channel.state==='connected'&&channel.telegramUser?.configured===true&&Boolean(channel.telegramUser.accountId)&&entry?.accountId===channel.telegramUser.accountId;}
    if(channel.transport==='elozi-webchat')return !webchat.closed&&channel.state==='connected'&&channel.webchat?.enabled===true&&channel.webchat.version>=1&&Boolean(channel.webchat.origins?.length);
    if(channel.transport==='mepmail-channel')return !emailChannel.closed&&channel.state==='configured'&&channel.email?.enabled===true&&channel.email.version>=1&&Boolean(channel.email.epoch);
    if(['meta-instagram','meta-messenger'].includes(channel.transport))return !meta.closed&&channel.state==='configured'&&channel.meta?.enabled===true&&channel.meta.version>=1&&channel.meta.credentialsConfigured===true&&Boolean(channel.meta.resourceId);
    return false;
  }});
  const automation = new AutomationService(store,auth,flows,{
    channelAvailable:(tenantId,channel)=>{
      if(channel?.transport==='elozi-webchat')return webchat.closed===false;
      const adapter=adapterFor(channel),entry=adapter?.entries?.get(channel?.id);
      return entry?.tenantId===tenantId&&entry.channelId===channel?.id&&entry.state==='connected'
        &&!adapter.closing&&entry.stopped!==true&&!entry.abort?.signal?.aborted
        &&(channel?.transport!=='baileys'||entry.matched===true);
    },...automationOptions
  });
  const capabilitiesFor=channel=>channelCapabilities(channel,['meta-instagram','meta-messenger'].includes(channel?.transport)?meta.mediaCapabilities(channel.kind):channel?.transport==='elozi-webchat'?webchat.capabilities(channel):{});
  const telegramAvailability=(actor,id,c)=>{const value=(store.tenant(actor,id).channels.find(ch=>ch.id===c.channelId)?.transport==='telegram-user'?telegramUser:telegram).replyPolicy(actor,id,c.id);return {group:{canSend:value.allowed,sendPermissions:value.sendPermissions}};};
  const capabilitiesForConversation=(actor,id,c,channel)=>conversationCapabilities(capabilitiesFor(channel),['telegram-bot','telegram-user'].includes(channel?.transport)&&c.conversationKind==='group'?telegramAvailability(actor,id,c):undefined,channel?.transport);
  auth.commercialAuthority=(actor,id)=>accounts.authorizeAdministration(actor,id);
  const integrations = async () => (await agentSecrets()).get('platform-services') || {};
  const loadIntegrations = async () => {const settings=await integrations();if(settings.googleClientId)google.configure(settings.googleClientId);if(settings.emailApiKey||settings.emailFrom)email.configure({apiKey:settings.emailApiKey||'',from:settings.emailFrom||'',publicOrigin:publicOrigin||'http://127.0.0.1:4318'});};
  const verificationEmail = async actor => {if(!actor.email||actor.emailVerified)return;const token=auth.emailChallenge(actor.userId);await email.enqueueVerification({userId:actor.userId,email:actor.email,name:actor.name,token});email.flush().catch(()=>{});};
  // Internal MCP lookups revalidate the run initiator synchronously: the responsible person, the exact service principal
  // with conversation.read, or the own support job. Results stay within this company, conversation and the run's agent.
  const internalScope=(actor,id,cid,request={})=>{
    const tenant=store.tenant(actor,id),run=typeof request.runId==='string'?(tenant.runs||[]).find(item=>item.id===request.runId):null;
    assertTelegramAccountAiAllowed(tenant,{conversationId:cid});
    const contactSafe=conversation=>{
      const contact=(tenant.contacts||[]).find(item=>item.id===conversation.contactId);
      if((contact?.identities||[]).some(identity=>!telegramAccountAiAllowed(tenant,{channelId:identity.channelId})))return false;
      return !(tenant.conversations||[]).some(item=>conversation.contactId&&item.contactId===conversation.contactId&&!telegramAccountAiAllowed(tenant,item));
    };
    if(!run||run.conversationId!==cid||run.state!=='tool_running')fail(409,'A consulta não pertence a uma execução ativa deste atendimento.');
    const sameScope=conversation=>item=>telegramAccountAiAllowed(tenant,item)&&item.channelId===conversation.channelId&&(item.departmentId||null)===(conversation.departmentId||null);
    if(actor?.serviceId){
      const row=store.db.prepare('SELECT capabilities FROM service_principals WHERE id=? AND tenant_id=?').get(actor.serviceId,id);
      if(run.serviceId!==actor.serviceId||!row||!JSON.parse(row.capabilities).includes('conversation.read')||servicePrincipals.runCurrent(run)!==true)fail(403,'O serviço perdeu a leitura deste atendimento.');
      const conversation=store.getConversation(tenant,cid);return {tenant,run,conversation,readable:sameScope(conversation),contactVisible:false};
    }
    if(actor?.kind==='service'){
      // Internal identities bound to one run: the platform's own support job or the live autopilot execution of this process.
      if(actor.autopilot===true){if(!autopilot?.ownsActor(actor)||!actor.supportAssistantId||run.id!==actor.supportAssistantId||run.serviceId||run.actorUserId||autopilot.runCurrent(run)!==true)fail(403,'O piloto automático perdeu acesso a este atendimento.');}
      else if(!actor.supportAssistantId||run.id!==actor.supportAssistantId||run.serviceId||run.actorUserId||centralSupport?.runCurrent(run)!==true)fail(403,'O suporte perdeu acesso a este atendimento.');
      const conversation=store.getConversation(tenant,cid);return {tenant,run,conversation,readable:sameScope(conversation),contactVisible:false};
    }
    const conversation=conversationFor(actor,id,cid,'inbox.reply');requireResponsible(actor,id,conversation);
    // One synchronous snapshot for this lookup (same decisions as can()); never kept past this call.
    const readable=tenantPermission(actor,'inbox.read',id);
    return {tenant,run,conversation,readable:item=>telegramAccountAiAllowed(tenant,item)&&readable(contextFor(id,item,tenant)),contactVisible:contactSafe(conversation)&&can(actor,'contacts.read',contextFor(id,conversation,tenant))};
  };
  const mcp=new McpManager(store,{vault:()=>secrets,allowedOrigins:mcpOrigins,privateOrigins:mcpPrivateOrigins,fetchImpl:mcpFetchImpl,internalContext:(actor,id,cid,request={})=>{
    const {tenant,run,conversation,readable,contactVisible}=internalScope(actor,id,cid,request);
    if(request.tool==='elozi_knowledge_search'){
      const agent=tenant.agents.find(item=>item.id===run.agentId);if(!agent)fail(409,'O agente desta execução mudou.');
      return {knowledge:internalKnowledgeResult(knowledge.search(tenant,agent,request.arguments?.query||''))};
    }
    if(request.tool==='elozi_contact_profile')return {contact:internalContactProfile(tenant,conversation,{readable,contactVisible})};
    if(request.tool==='elozi_conversation_history')return {history:internalConversationHistory(conversation,request.arguments||{})};
    const channel=tenant.channels.find(item=>item.id===conversation.channelId);
    const live=channel?.transport==='baileys'?gateway.entries.get(channel.id):channel?.transport==='telegram-bot'?telegram.entries.get(channel.id):null;
    const status=['baileys','telegram-bot','telegram-user'].includes(channel?.transport)?{state:live?.tenantId===id?live.state:'disconnected'}:{state:channel?.state||'configured'};
    return {channel:{id:channel?.id,name:channel?.name,kind:channel?.kind,state:status.state,checkedAt:new Date().toISOString()},attendance:{id:conversation.id,status:conversation.status,owner:conversation.owner,responsible:conversation.assignedUserName||null,department:conversation.department||null,version:conversation.version}};
  }});
  const knowledge = new KnowledgeBase(store);
  const servicePrincipals = new ServicePrincipals(store,auth,{onChange:serviceId=>{
    const row=store.db.prepare('SELECT reseller_id,tenant_id FROM service_principals WHERE id=?').get(serviceId);
    if(row)runtime.invalidateInitiator({role:'reseller',resellerId:row.reseller_id,name:'Controle de acesso do serviço'},row.tenant_id,{serviceId});
  }});
  const serviceNotifications=new ServiceNotifications(store,servicePrincipals,gateway,{media});
  const resolveMemoryActor=run=>{
    if(run.serviceId||!run.actorUserId)return null;
    const row=store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(run.tenantId);
    if(!row)return null;
    return auth.resolveActor({userId:run.actorUserId,resellerId:row.reseller_id,...(run.supportGrantId?{supportGrantId:run.supportGrantId}:{})});
  };
  const memory=new AgentMemory(store,{resolveActor:resolveMemoryActor,access:(actor,tenant,conversation,mode)=>{
    if(actor?.serviceId||actor?.kind==='service')return false;
    if(!telegramAccountAiAllowed(tenant,conversation))return false;
    const context=contextFor(tenant.id,conversation);
    if(!can(actor,'inbox.read',context)||!can(actor,'contacts.read',context))return false;
    if(mode==='write'){
      if(!can(actor,'contacts.write',context)||!can(actor,'inbox.reply',context))return false;
      try{requireResponsible(actor,tenant.id,conversation);return conversation.status!=='closed';}catch{return false;}
    }
    return true;
  }});
  const runtime = new AgentRuntime(store,{mcp,knowledge,memory,media,imageInput:ownProfileKnowledge,validateSupportIdentity:run=>webchat.verifiedConversationCurrent(run.tenantId,run.conversationId),validateInitiator:run=>{
    if(run.id?.startsWith('autopilot_'))return autopilot?.runCurrent(run)===true;
    if(run.id?.startsWith('support_'))return centralSupport?.runCurrent(run)===true;
    if(run.serviceId)return servicePrincipals.runCurrent(run);
    if(run.supportGrantId){const tenant=store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(run.tenantId);if(!tenant)return false;return auth.can(auth.resolveActor({userId:run.actorUserId,resellerId:tenant.reseller_id,supportGrantId:run.supportGrantId}),'inbox.reply',{tenantId:run.tenantId,channelId:run.channelIdAtStart,departmentId:run.departmentIdAtStart||'unassigned'});}
    if(!run.actorUserId)return allowDemo;
    return can(resolveMemoryActor(run),'inbox.reply',{tenantId:run.tenantId,channelId:run.channelIdAtStart,departmentId:run.departmentIdAtStart||'unassigned'});
  },providerCall:providerCall || (async context=>{
    const config=secrets&&agentConfig(secrets,context.tenantId,context.agentId);
    if(!config)fail(503,'Configure um serviço dedicado para este agente.');
    const providerKey=new URL(config.endpoint).origin==='http://mepchat-hermes:8660'?secrets.get('platform-services')?.commandCodeApiKey||'':'';
    return createHermesProvider({...config,providerKey,apiKey:config.token,allowedOrigins:agentOrigins})(context);
  })});
  const serviceApi = new ServiceApi(store,servicePrincipals,runtime,{
    ownLines,activity:serviceActivity,
    privateReplyLimits:serviceReplyLimits,
    privateMediaPolicy:serviceMediaPolicy,readAttachment:(attachmentId,context)=>media.read(attachmentId,context),
    assertGroup:assertServiceGroup,
    sendGroup:(_actor,options)=>dispatchServiceGroup(options.internalActor,options.context.tenantId,options.context.conversationId,{version:options.input.version,text:options.input.text,channelId:options.context.channelId,idempotencyKey:options.idempotencyKey},{reauthorize:options.reauthorize}),
    // Agent as attendant (MCP/REST): private replies through the same outbox and transports, conversation changes and waits.
    sendPrivate:(_actor,options)=>dispatchServicePrivate(options.internalActor,options.context.tenantId,options.context.conversationId,{version:options.input.version,text:options.input.text,channelId:options.context.channelId,idempotencyKey:options.idempotencyKey,...(options.input.attachment?{attachment:options.input.attachment}:{}),...(options.input.poll?{poll:options.input.poll}:{})},{reauthorize:options.reauthorize}),
    // presence.typing ("digitando…"): the live adapter of the conversation's channel, when it has a typing signal.
    sendTyping:(_actor,options)=>{const adapter=adapterFor(options.channel);return typeof adapter?.sendTyping==='function'?adapter.sendTyping(options):{supported:false,sent:false,reason:'channel'};},
    operations,events,
    onManaged:(tenantId,conversationId,operation,internalActor)=>{
      try{runtime.invalidateConversation(internalActor,tenantId,conversationId);}catch{console.error('Rascunhos da conversa revalidados na próxima leitura.');}
      autopilot?.invalidate({tenantId,conversationId});
      // A transfer to a department with circular distribution reaches the next available person, as an incoming message would.
      if(operation==='transfer')try{operations.routeIncoming(tenantId,conversationId);}catch{console.error('Distribuição da transferência adiada; a conversa segue na fila.');}
    },
    scheduleGroup:(_actor,options)=>{options.reauthorize();return scheduled.create(options.internalActor,options.context.tenantId,options.context.conversationId,{version:options.input.version,text:options.input.text,dueAt:options.input.dueAt,commandId:options.idempotencyKey});}
  });
  // Signed push of the same event pointers to a product backend; the long wait stays the reconciliation path.
  const serviceWebhooks = new ServiceWebhooks({ store, principals: servicePrincipals, api: serviceApi, bus: events, loadSecrets: agentSecrets, ...webhookOptions }).start();
  const productConnections = new ProductConnections({ store, principals: servicePrincipals, webhooks: serviceWebhooks });
  const serviceMcp = createServiceMcpHandler(serviceApi, { allowedOrigins: publicURL ? [publicURL.origin] : [], authorizeRequest: (actor, req) => {
    const hostname = (req.headers.host || '').split(':')[0].toLowerCase(), binding = domains.resolve(hostname);
    if (req.eloziDomain && (!binding || binding.workspaceId !== req.eloziDomain.workspaceId || binding.host !== req.eloziDomain.host)) fail(403, 'O vínculo deste painel mudou.');
    if (binding && actor.workspaceId !== binding.workspaceId) fail(403, 'O serviço pertence a outro painel.');
    return true;
  } });
  const centralSupport = new CentralSupport(store, { auth, runtime, knowledge, operations, webchat, publicOrigin, ownKnowledge:ownProfileKnowledge, imageInput:ownProfileKnowledge,
    handoffEnabled:context=>{const {channel}=webchat.channel(context.actor,context.tenantId,context.channelId);return Boolean(channel.webchat?.widget?.handoffMessage?.['pt-BR'] || channel.webchat?.widget?.handoffMessage?.en);},
    onHandoff:async context=>{
      const authorize=()=>{if(context.signal?.aborted||context.reauthorize()!==true||centralSupport.authorizeHandoff(context)!==true)fail(403,'A transferência mudou.');return true;};
      authorize();const {channel}=webchat.channel(context.actor,context.tenantId,context.channelId),recipient=channel.webchat?.widget?.handoffNotificationEmail;
      let queued=null,notification={state:'unconfirmed'};
      if(recipient){
        try{
          const getContext=()=>{
            authorize();const fresh=webchat.channel(context.actor,context.tenantId,context.channelId),conversation=store.getConversation(fresh.tenant,context.conversationId);
            if(conversation.channelId!==fresh.channel.id||fresh.channel.webchat?.widget?.handoffNotificationEmail?.toLowerCase()!==recipient.toLowerCase())fail(409,'O destino da notificação mudou.');
            const session=store.db.prepare('SELECT origin FROM webchat_sessions WHERE id=? AND tenant_id=? AND channel_id=? AND conversation_id=?').get(conversation.remoteSessionId,context.tenantId,context.channelId,context.conversationId);
            return {...fresh,conversation,identityVerified:webchat.verifiedConversationCurrent(context.tenantId,context.conversationId),sourceOrigin:session?.origin};
          };
          queued=await email.enqueueSupportHandoff({tenantId:context.tenantId,channelId:context.channelId,conversationId:context.conversationId,jobId:context.jobId,email:recipient,reason:context.reason,authorize,getContext});authorize();
          store.mutate(context.actor,context.tenantId,'Suporte: aviso por e-mail enfileirado',tenant=>{authorize();store.getConversation(tenant,context.conversationId).handoffEmail={id:queued.id,state:queued.state};});
          notification={state:['pending','in_flight','confirmed'].includes(queued.state)?'queued':'unconfirmed',outboxState:queued.state};
        }catch{queued=null;}
      }
      // Publishing a queue receipt is not proof of sending/delivery. The visitor copy receives the exact registration outcome.
      const result=webchat.publishHandoff({...context,ticketState:notification.state});
      if(queued){
        const receiptId=queued.id;
        const receiptAuthority=()=>{
          const fresh=webchat.channel(context.actor,context.tenantId,context.channelId),conversation=store.getConversation(fresh.tenant,context.conversationId);
          if(!centralSupport.proofs.has(context.actor)||!centralSupport.scopes().some(scope=>scope.tenantId===context.tenantId&&scope.channelId===context.channelId&&scope.resellerId===context.actor.resellerId)
            ||fresh.channel.supportAssistant?.enabled!==true||fresh.channel.supportAssistant.agentId!==context.agentId||conversation.channelId!==context.channelId
            ||conversation.handoffEmail?.id!==receiptId||conversation.supportAssistantHandoff?.messageId!==context.replyToMessageId)fail(403,'O recibo do suporte mudou.');
          return true;
        };
        // Fresh, metadata-only completion update, tied to this exact receipt; never export encrypted payloads.
        email.flush().then(()=>{
          const status=email.supportHandoffStatus({id:receiptId,tenantId:context.tenantId,authorize:receiptAuthority});
          if(status)store.mutate(context.actor,context.tenantId,'Suporte: estado do aviso por e-mail atualizado',tenant=>{receiptAuthority();store.getConversation(tenant,context.conversationId).handoffEmail={id:status.id,state:status.state};});
        }).catch(()=>{});
      }
      return {...result,notification,metadata:{...result.metadata,ticketState:notification.state,notificationState:notification.outboxState||'unconfirmed'}};
    }
  });
  webchat.assistantState=(tenantId,channelId,conversationId)=>centralSupport.publicState(tenantId,channelId,conversationId);
  // Autonomous replies follow the workspace's commercial state: an active account or a trial still in force.
  const autopilotAuthorize=({workspaceId})=>{try{const lifecycle=accounts.lifecycle.describe(accounts.accountRow(workspaceId));return lifecycle.state==='active'||lifecycle.state==='trial'&&lifecycle.trialExpired!==true;}catch{return false;}};
  autopilot = new AgentAutopilot(store,{runtime,knowledge,operations,authorize:autopilotAuthorize,send:input=>sendAutopilotReply(input),logger:console,ownLines,...autopilotOptions});
  // Intake comes from the change bus (customer messages and assignments), after automation and routing of the same change.
  autopilot.attach(events);
  // Operations.canReply asks the autopilot itself: only its live execution in `sending`, in that conversation.
  operations.authorizeAutopilotReply=(actor,id,conversation)=>autopilot.authorizeReply(actor,id,conversation)===true;
  const support = new SupportAccess(store,auth,{onChange:record=>{
    const systemActor={role:'reseller',resellerId:record.workspaceId,name:'Fim do suporte temporário'};
    for(const id of record.tenantIds||[])runtime.invalidateInitiator(systemActor,id,{supportGrantId:record.grantId});
    for(const changed of operations.releaseSupportGrant(record))runtime.invalidateConversation(systemActor,changed.tenantId,changed.conversationId);
  }});
  const billing = new Billing(store.db,{validateActor:actor=>auth.resolveActor(actor),isPlatformAdmin:actor=>auth.isPlatformAdmin(actor),
    getWorkspaces:()=>store.db.prepare('SELECT id,data FROM resellers').all().map(row=>{const data=JSON.parse(row.data);return {id:row.id,name:data.name,accountKind:data.accountKind||(row.id==='mep-demo'?'platform':'reseller'),parentWorkspaceId:data.parentWorkspaceId||null};}),
    // A demo company is never a billing target nor part of the measured usage.
    getTenants:(actor,workspaceId)=>store.db.prepare("SELECT id,data FROM tenants WHERE reseller_id=? AND json_extract(data,'$.demo') IS NULL").all(workspaceId).map(row=>({id:row.id,name:JSON.parse(row.data).name})),
    getUsage:(actor,{workspaceId,tenantId})=>{
      const rows=store.db.prepare("SELECT id,data FROM tenants WHERE reseller_id=? AND json_extract(data,'$.demo') IS NULL").all(workspaceId).filter(row=>!tenantId||row.id===tenantId);
      const people=store.db.prepare('SELECT id,role,tenant_ids FROM auth_users WHERE reseller_id=? AND disabled_at IS NULL').all(workspaceId).filter(row=>!tenantId||row.role==='reseller'||JSON.parse(row.tenant_ids).includes(tenantId));
      return {connections:rows.reduce((n,row)=>n+(JSON.parse(row.data).channels||[]).filter(c=>['baileys','telegram-bot','telegram-user'].includes(c.transport)).length,0),users:people.length,
        agent_service:store.db.prepare('SELECT tenant_id FROM service_principals WHERE reseller_id=? AND active=1 AND expires_at>?').all(workspaceId,Date.now()).filter(row=>!tenantId||row.tenant_id===tenantId).length};
    }});
  const commercialUsage = new CommercialUsage(accounts, billing);
  // Only the fields the automation contract accepts: a media receipt also carries attachmentId (and a capped contact
  // sync carries contactSync), which made automation refuse and skip the support assistant for every attachment.
  const onIncoming=(entry,conversationId,messageId,flags={})=>{const marks=Object.fromEntries(['conversationVersion','newConversation','reopened'].filter(key=>flags?.[key]!==undefined).map(key=>[key,flags[key]]));const result=automation.onIncoming(entry.tenantId,{conversationId,messageId,...marks});if(result?.applied)runtime.invalidateConversation(entry.actor,entry.tenantId,conversationId);try{
    centralSupport.receive(entry,conversationId,messageId);
    const channel=conversationTenant(entry.actor,entry.tenantId,conversationId).channels.find(item=>item.id===entry.channelId);
    if(webchatOptions.supportImmediate!==false && channel?.webchat?.widget?.assistantInstructions)queueMicrotask(()=>centralSupport.drain().catch(()=>console.error('Preparação do suporte adiada; mensagem preservada.')));
  }catch{console.error('Mensagem preservada; preparação do suporte adiada.');}return result;};
  gateway.onIncoming=onIncoming;telegram.onIncoming=onIncoming;telegramUser.onIncoming=(entry,conversationId,messageId)=>{runtime.invalidateConversation(entry.actor,entry.tenantId,conversationId);return {applied:false};};webchat.onIncoming=onIncoming;emailChannel.onIncoming=onIncoming;meta.onIncoming=onIncoming;
  const uploads=new Set(),publicMediaReads=new Set();
  const cleanupMedia=async()=>{if(databasePath===':memory:')return;const pinnedIds=await retainedMediaIds(resolve(dirname(databasePath),'backups'));if(pinnedIds)await media.cleanupOrphans({pinnedIds});};
  const emailLimits=new Map(),accessLimiter=createAccessLimiter();
  const requestClient=req=>req.eloziClient||=rateLimitKey(clientAddress(req,trustedProxy));
  const hitLimit=(key,maximum,message)=>accessLimiter.hit(key,maximum,message);
  function limitAccess(req,kind,maximum=20) { hitLimit(kind+':'+requestClient(req),maximum,'Aguarde um minuto antes de tentar novamente.'); }
  const authenticationMode=()=>google.clientId?'local-and-google':'local';
  // In-memory copies of the allowlisted panel files with their SHA-256 ETag. A stat per request revalidates the copy
  // (mtime and size), so a replaced file is served at once; the allowlist bounds the cache.
  const assetCache=new Map();
  async function staticAsset(file) {
    const path=resolve(root,'public',file),info=await stat(path),cached=assetCache.get(file);
    if(cached&&cached.mtimeMs===info.mtimeMs&&cached.size===info.size)return cached;
    const content=await readFile(path),entry={content,etag:`"${createHash('sha256').update(content).digest('hex')}"`,mtimeMs:info.mtimeMs,size:content.length};
    assetCache.set(file,entry);return entry;
  }
  // Versioned asset URLs: /v/<version>/<file> serves the bytes of /<file> with a one-year immutable cache, and the HTML pages
  // (no-store) point their stylesheets and scripts there; relative module imports inherit the prefix. A browser never
  // revalidates a module and still loads the new files after each release, because the version is the hash of every
  // panel asset's ETag (scripts/verify.mjs recomputes it from the source). The unversioned paths stay as they were
  // (no-cache + ETag): fonts and images that CSS names by absolute path, the widget on customer sites, and the web app
  // manifest, whose address an installed app keeps.
  const panelAssetSet=new Set(PANEL_ASSETS.filter(file=>/^[a-z0-9][a-z0-9.-]*\.(?:css|js)$/.test(file)));let versionMemo=null;
  async function assetVersion(){
    const now=Date.now();if(versionMemo&&now-versionMemo.at<2000)return versionMemo.value;
    const etags=await Promise.all(PANEL_ASSETS.map(file=>staticAsset(file).then(asset=>asset.etag)));
    versionMemo={at:now,value:createHash('sha256').update(etags.join('\n')).digest('hex').slice(0,12)};return versionMemo.value;
  }
  const versionedPage=(content,version)=>content.toString('utf8').replace(/(\b(?:href|src)=")\/([a-z0-9][a-z0-9.-]*\.(?:css|js))"/g,(match,attribute,file)=>panelAssetSet.has(file)?`${attribute}/v/${version}/${file}"`:match);
  const supportEmailProjection=(actor,tenantId,conversation,receipt)=>{
    if(!receipt)return undefined;
    try{
      const authorize=()=>{
        const tenant=store.tenant(actor,tenantId),current=store.getConversation(tenant,conversation.id);
        requirePermission(actor,'inbox.read',contextFor(tenantId,current,tenant));
        if(current.channelId!==conversation.channelId||current.handoffEmail?.id!==receipt.id)fail(403,'O recibo do suporte mudou.');
        return true;
      };
      const current=email.supportHandoffStatus({id:receipt.id,tenantId,authorize});
      return {id:receipt.id,state:current?.state||'unknown'};
    }catch{return {id:receipt.id,state:'unknown'};}
  };
  const safeConversation = ({ remoteJid, remoteAliases, remoteChatId, chatAliases, scheduledMessages, followUps, participants, attendanceAccess, supportAssistantHandoff, handoffEmail, ...conversation }, actor, tenantId, snapshot, channelList, state) => {
    const access=actor?.userId?(snapshot||operations.attendanceSnapshots(actor,tenantId,[conversation]).get(conversation.id)):{participants:[],attendance:{canReply:conversation.status!=='closed'&&conversation.owner==='human',canManageParticipants:false}};
    const channel=(channelList||store.tenant(actor,tenantId).channels||[]).find(item=>item.id===conversation.channelId);
    let availability=['meta-instagram','meta-messenger'].includes(channel?.transport)?{replyWindow:meta.replyWindow(actor,tenantId,conversation.id,{tenant:state})}:undefined;
    if(['telegram-bot','telegram-user'].includes(channel?.transport)&&conversation.conversationKind==='group')availability=telegramAvailability(actor,tenantId,conversation);
    return { ...conversation, ...(handoffEmail?{handoffEmail:supportEmailProjection(actor,tenantId,conversation,handoffEmail)}:{}), ...(supportAssistantHandoff?.active?{supportAssistantHandoff:{active:true,reason:supportAssistantHandoff.reason,...(supportAssistantHandoff.pauseAutomation===false?{pauseAutomation:false}:{})}}:{}), participants:access.participants, attendanceAccess:access.attendance, ...(availability?{channelAvailability:availability}:{}), ...(Array.isArray(conversation.messages) ? { messages: conversation.messages.map(publicMessage) } : {}) };
  };
  const safeTenant = (tenant,actor,{state}={}) => {
    const snapshots=actor?.userId?operations.attendanceSnapshots(actor,tenant.id,tenant.conversations,{state}):null;
    return { ...tenant, quickReplies: undefined, agentMemories:undefined, supportAssistantJobs:undefined, agentAutopilotJobs:undefined, agentAdminProposals:undefined, runs:(tenant.runs||[]).map(({memorySnapshot,memoryReferences,supportMemorySnapshot,supportVisitorHash,...run})=>({...run,...(memorySnapshot||supportMemorySnapshot?{draft:null}: {})})), channels: tenant.channels.map(({ expectedNumber, allowedGroups, groupNames, telegramGroups, telegramUser:accountSelection, supportAssistant, centralSupportScope, onboarding, ...channel }) => ({ ...channel, capabilities:capabilitiesFor(channel), enabledGroups: allowedGroups?.length || 0, ...(channel.transport==='telegram-user'?{groupSelectionMode:'selected',selectedGroups:(accountSelection?.dialogs||[]).filter(d=>d.type==='group').length,telegramAccountConfigured:accountSelection?.configured===true}:{}), ...(channel.transport==='telegram-bot'?{groupSelectionMode:telegramGroups?.mode||'all',selectedGroups:telegramGroups?.groupIds?.length||0}: {}) })), conversations: tenant.conversations.map(c=>safeConversation(c,actor,tenant.id,snapshots?.get(c.id),tenant.channels,state)) };
  };
  const can = (actor, permission, context) => allowDemo && !actor.userId ? true : auth.can(actor, permission, context);
  const requirePermission = (actor, permission, context) => { if (!can(actor,permission,context)) fail(403,'Seu acesso não permite esta ação.'); };
  // Listings reuse one authorization snapshot per request, company and permission: the same decision as can() for each
  // context, reading the person and the company once instead of once per conversation. Never kept across an await.
  const tenantPermission = (actor, permission, tenantId) => {
    if (allowDemo && !actor.userId) return () => true;
    let checker;try{checker=auth.createTenantPermissionChecker(actor,permission,tenantId);}catch{return () => false;}
    return context => {try{return checker.can(context)===true;}catch{return false;}};
  };
  // A caller that already holds this request's company snapshot passes it to resolve legacy department names without re-reading.
  const contextFor = (id,c,tenant) => {const data=c.departmentId?null:tenant||JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get(id)?.data||'{}');return {tenantId:id,channelId:c.channelId,departmentId:c.departmentId||(data?.departments||[]).find(d=>d.name===c.department)?.id||'unassigned'};};
  const conversationFor = (actor,id,cid,permission='inbox.read',version) => {const c=store.getConversation(store.tenant(actor,id),cid,version);requirePermission(actor,permission,contextFor(id,c));return c;};
  function conversationTenant(actor,id,cid) {
    const read=typeof store.readonlyConversationTenant==='function'?store.readonlyConversationTenant:store.conversationTenant;
    return typeof read==='function'?read.call(store,actor,id,cid):store.tenant(actor,id);
  }
  function invalidatePrivateDrafts(actor,id,cid) {
    const tenant=conversationTenant(actor,id,cid);
    if ((tenant.runs||[]).some(run=>run.conversationId===cid&&ACTIVE_RUNS.has(run.state))) return runtime.invalidateConversation(actor,id,cid);
    return [];
  }
  function serviceContext(actor,id,conversation) {
    const tenant=conversation.conversationKind==='group'?store.tenant(actor,id):null;
    return {workspaceId:actor.resellerId||actor.workspaceId,tenantId:id,agentId:actor.agentId,conversationId:conversation.id,conversationVersion:conversation.version,channelId:conversation.channelId,departmentId:conversation.departmentId||'unassigned',...(conversation.conversationKind==='group'?serviceGroupContext(tenant,conversation):{})};
  }
  function assertServiceGroup(actor,context) {
    const tenant=store.tenant({role:'operator',resellerId:actor.workspaceId||actor.resellerId,tenantIds:[actor.tenantId]},context.tenantId);
    const conversation=store.getConversation(tenant,context.conversationId),channel=tenant.channels.find(item=>item.id===conversation.channelId);
    const actual=serviceGroupContext(tenant,conversation);
    if(actor.tenantId!==tenant.id||context.channelId!==channel?.id||context.departmentId!==(conversation.departmentId||'unassigned')||context.groupId!==actual.groupId||context.channelTransport!==actual.channelTransport||!selectedGroup(channel,conversation))fail(403,'A seleção ou o escopo deste grupo mudou.');
    return true;
  }
  operations.authorizeServiceReply=(actor,id,conversation)=>{
    if(!['reply.send','message.schedule'].includes(actor.serviceCapability))fail(403,'O serviço não tem uma ação de envio autorizada.');
    const context=serviceContext(actor,id,conversation);
    // Private replies: revalidate already required the conversation to be owned by the identity's MCP agent.
    servicePrincipals.authorizeInternalActor(actor,actor.serviceCapability,context);
    return conversation.conversationKind==='group'?assertServiceGroup(actor,context):true;
  };
  const authorizeHumanGroup=(actor,id,conversation,summary=false)=>{
    requirePermission(actor,'inbox.read',contextFor(id,conversation));
    if(summary)requirePermission(actor,'inbox.reply',contextFor(id,conversation));
    const channel=store.tenant(actor,id).channels.find(item=>item.id===conversation.channelId);
    if(!actor.userId||!selectedGroup(channel,conversation))fail(403,'Habilite este grupo na conexão antes de acessá-lo.');
    return true;
  };
  const groups=new GroupWorkspace(store,{gateway,telegram,telegramUser,authorize:(actor,id,c)=>authorizeHumanGroup(actor,id,c)});
  // A direct WhatsApp QR conversation: a person with access to it and to the inbox (older messages on demand).
  const authorizeHumanDirect=(actor,id,conversation)=>{
    requirePermission(actor,'inbox.read',contextFor(id,conversation));
    const channel=store.tenant(actor,id).channels.find(item=>item.id===conversation.channelId);
    if(!actor.userId||conversation.conversationKind==='group'||channel?.kind!=='whatsapp_qr'||channel.transport!=='baileys')fail(403,'Esta conversa não é do WhatsApp por QR.');
    return true;
  };
  const groupHistoryImporter=new GroupHistoryImporter(store,{
    authorize:(actor,id,c)=>{auth.admin(actor);store.admin(actor);return c.conversationKind==='group'?authorizeHumanGroup(actor,id,c):authorizeHumanDirect(actor,id,c);},
    resolveConnection:(_actor,_id,channelId)=>gateway.closing?null:gateway.entries.get(channelId),
    // The oldest message that kept its provider key comes first (the search continues further back), then the live cursor.
    resolveCursor:(entry,{groupId,conversation})=>storedHistoryCursor(conversation)||entry.historyCursors?.get(groupId),
    onCursor:(entry,groupId,cursor)=>entry.historyCursors?.set(groupId,cursor)
  });
  gateway.historyImporter=groupHistoryImporter;
  const groupSummaries=new GroupSummaries(store,{authorize:(actor,id,c)=>authorizeHumanGroup(actor,id,c,true),providerCall:context=>runtime.providerCall({...context,runId:'group_summary_'+randomUUID()})});
  const inbox = createConsolidatedInbox(store,{can,permissions:tenantPermission,channelState:(tenantId,channel)=>{
    if (!['baileys','telegram-bot','telegram-user'].includes(channel.transport)) return channel.state || 'configured';
    const entry=adapterFor(channel).entries.get(channel.id);
    return entry?.tenantId===tenantId?entry.state:'disconnected';
  }});
  const requireResponsible=(actor,id,c)=>{operations.canReply(actor,id,c);if(c.owner!=='human'||c.assignedUserId!==actor.userId)fail(409,'Somente o responsável coordena o copiloto e as ferramentas deste atendimento.');};
  const messagePolicy=(actor,id,cid,input)=>{
    const scoped=actor.kind==='service'&&(actor.serviceId||actor.autopilot===true)?conversationTenant(actor,id,cid):null;
    const c=scoped?store.getConversation(scoped,cid,input.version):conversationFor(actor,id,cid,'inbox.reply',input.version),channel=(scoped||store.tenant(actor,id)).channels.find(item=>item.id===c.channelId),capabilities=capabilitiesForConversation(actor,id,c,channel);
    operations.canReply(actor,id,c);
    // A native poll leaves only through the WhatsApp QR line of a direct conversation; no other transport sends its text instead.
    if(input.poll!==undefined&&(!pollChannel(channel)||c.conversationKind==='group'||input.attachmentIds?.length))fail(400,'Enquete só numa conversa direta do WhatsApp por QR.');
    if(['telegram-bot','telegram-user'].includes(channel?.transport))adapterFor(channel).validateOutgoing(actor,id,cid,input);
    if(['meta-instagram','meta-messenger'].includes(channel?.transport)){meta.validateOutgoing(channel.kind,input);meta.sendContext(actor,id,cid,input);if(input.attachmentIds?.length){const metadata=media.record(input.attachmentIds[0],{tenantId:id,conversationId:cid,channelId:c.channelId},{uploadOnly:true}).metadata;if(metadata.status!=='ready')fail(409,'O arquivo ainda não está pronto para envio.');validateAttachmentSelection({type:metadata.mime,size:metadata.size},capabilities,{voice:metadata.voice===true});assertChannelText(input.text??'',capabilities,{attachment:true,audio:metadata.kind==='audio'});}}
    else{
      if(channel?.transport==='elozi-webchat')webchat.validateOutgoing(actor,id,cid,input);
      const attachment=Boolean(input.attachmentIds?.length);let metadata;
      if(attachment){if(!capabilities.uploadKinds.length)fail(400,'Esta conexão ainda não permite enviar arquivos.');metadata=media.record(input.attachmentIds[0],{tenantId:id,conversationId:cid,channelId:c.channelId},{uploadOnly:true}).metadata;if(metadata.status!=='ready')fail(409,'O arquivo ainda não está pronto para envio.');validateAttachmentSelection({type:metadata.mime,size:metadata.size},capabilities,{voice:metadata.voice===true});}
      assertChannelText(input.text??'',capabilities,{attachment,audio:metadata?.kind==='audio'});
    }
    return true;
  };
  const attendance = createAttendanceService(store,{authorize:(actor,id,c,permission)=>requirePermission(actor,permission,contextFor(id,c)),requireReply:(actor,id,c)=>operations.canReply(actor,id,c)});
  const forwarding=createForwardingService({store,media,outbox,uploads,adapterFor,messagePolicy,capabilities:capabilitiesForConversation,
    authorize:(actor,id,cid,version)=>{conversationFor(actor,id,cid,'inbox.read');const c=conversationFor(actor,id,cid,'inbox.reply',version);requireResponsible(actor,id,c);return c;},
    onResult:(actor,id,cid)=>runtime.invalidateConversation(actor,id,cid)});
  const followUps=createConversationFollowUps(store,{authorize:(actor,id,c,permission)=>{requirePermission(actor,permission,contextFor(id,c));return true;}});
  const scheduled = createScheduledMessages(store,{
    authorize:(actor,id,c,permission)=>actor.kind==='service'&&actor.serviceId?operations.canReply(actor,id,c):requirePermission(actor,permission,contextFor(id,c)),
    resolveActor:(userId,resellerId,record)=>auth.resolveActor({userId,resellerId,...(record?.supportGrantId?{supportGrantId:record.supportGrantId}:{})}),
    resolveServiceActor:record=>servicePrincipals.resolveServiceActor(record),
    validateSchedule:(actor,id,c,input)=>{const channel=store.tenant(actor,id).channels.find(item=>item.id===c.channelId);assertChannelText(input.text,capabilitiesForConversation(actor,id,c,channel));if(channel?.transport==='telegram-bot')telegram.assertGroupAllowed(actor,id,c.channelId,c.remoteChatId,{method:'sendMessage'});if(channel?.transport==='telegram-user')telegramUser.validateOutgoing(actor,id,c.id,{text:input.text,channelId:c.channelId,version:c.version});if(channel?.transport==='elozi-webchat')webchat.validateSchedule(actor,id,c.id,input);if(['meta-instagram','meta-messenger'].includes(channel?.transport))meta.validateSchedule(actor,id,c.id,input);return true;},
    isTransportReady:(actor,id,c)=>{const channel=store.tenant(actor,id).channels.find(ch=>ch.id===c.channelId),adapter=adapterFor(channel);if(!adapter)return false;if(['baileys','telegram-bot','telegram-user'].includes(channel.transport)){const entry=adapter.entries.get(c.channelId);return entry?.tenantId===id&&entry.state==='connected';}return channel.transport==='mepmail-channel'?channel.state==='configured'&&channel.email?.enabled===true:channel.state==='connected';},
    send:async(actor,id,cid,input,authority)=>{if(actor.kind==='service'&&actor.serviceId)return dispatchServiceGroup(actor,id,cid,input,authority);const userId=actor.userId,resellerId=actor.resellerId,supportGrantId=actor.supportGrantId;const reauthorize=()=>{const latest=auth.resolveActor({userId,resellerId,...(supportGrantId?{supportGrantId}:{})});for(const key of Object.keys(actor))delete actor[key];Object.assign(actor,latest);const current=conversationFor(actor,id,cid,'inbox.reply');operations.canReply(actor,id,current);};reauthorize();const c=conversationFor(actor,id,cid,'inbox.reply',input.version),channel=store.tenant(actor,id).channels.find(ch=>ch.id===c.channelId),adapter=adapterFor(channel);if(!adapter)fail(409,'A conexão do agendamento mudou.');const result=await outbox.dispatch(actor,id,cid,input,()=>adapter.send(actor,id,cid,input,{reauthorize}),{reauthorize,validate:()=>messagePolicy(actor,id,cid,input)});runtime.invalidateConversation(actor,id,cid);return result;},
    ...scheduledOptions
  });
  /**
   * Autonomous reply of the autopilot (send contract of agent-autopilot.js): the same outbox, send policy and transports as
   * a person's reply. input.reauthorize() runs at every step (outbox, the transaction that records the message and the
   * dispatch checks), the job id is the outbox key and the transports record kind 'agent' with agentId and autopilotJobId.
   * A refusal (400/401/403/404/409/422/503) is thrown only when nothing was dispatched; any other outcome is 502 (unknown).
   */
  async function sendAutopilotReply(input) {
    const {actor,tenantId:id,conversationId:cid}=input;
    const reauthorize=()=>{if(input.signal?.aborted)fail(409,'O envio automático foi interrompido.');if(input.reauthorize()!==true)fail(403,'O envio automático perdeu a autorização.');return true;};
    reauthorize();
    const tenant=store.tenant(actor,id),conversation=store.getConversation(tenant,cid,input.version),channel=(tenant.channels||[]).find(item=>item.id===conversation.channelId),adapter=adapterFor(channel);
    if(!adapter||channel.id!==input.channelId)fail(409,'Esta conexão não envia respostas automáticas.');
    // No quotation: not every transport quotes, and the job is already bound to the customer's message it answers.
    const message={channelId:input.channelId,version:input.version,text:input.text,idempotencyKey:input.idempotencyKey},attribution={agentId:input.agentId,autopilotJobId:input.jobId};
    let result;
    try{result=await outbox.dispatch(actor,id,cid,message,()=>adapter.send(actor,id,cid,message,{reauthorize,attribution}),{reauthorize,validate:()=>messagePolicy(actor,id,cid,message)});}
    catch(error){
      // The outbox knows whether the provider was attempted: only a refusal recorded before any dispatch keeps its status.
      const command=store.db.prepare('SELECT state FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(id,input.idempotencyKey);
      if(command&&command.state!=='failed'&&command.state!=='pending')throw Object.assign(new Error('Envio automático sem confirmação. Confira o canal antes de responder.'),{status:502});
      if(!command||command.state==='pending')throw Object.assign(new Error(error?.status?error.message:'O envio automático não foi despachado.'),{status:error?.status||503});
      throw error;
    }
    const messageOf=list=>(Array.isArray(list)?list:[]).find(item=>item?.kind==='agent'&&item.autopilotJobId===input.jobId);
    let sent=messageOf(result?.messages);
    // Draft provenance, as for a person's send: the message cites its run and the run is marked used. Never undoes the send.
    try{sent=store.mutate(actor,id,'Origem da resposta automática registrada',state=>{
      const current=store.getConversation(state,cid),own=messageOf(current.messages),date=new Date().toISOString();
      if(own&&!own.sourceRunId)own.sourceRunId=input.runId;
      markDraftOutcome(state,{runId:input.runId,draft:input.text},input.text,own?.id,date);
      return own||sent;
    });}catch{console.error('Origem da resposta automática não registrada; a mensagem foi enviada.');}
    return {confirmed:true,messageId:sent?.id||null};
  }
  /** Private reply of a connected agent (ServiceApi.sendReply): the conversation's own transport, outbox and send policy. */
  async function dispatchServicePrivate(actor,id,cid,input,{reauthorize=()=>{}}={}) {
    const {attachment,...message}=input,mediaContext={tenantId:id,conversationId:cid,channelId:input.channelId,reauthorize};
    let created=null;
    try{
      if(attachment){
        // The file becomes an upload of this conversation, then follows the same outbox and send policy as a person's file.
        reauthorize();operations.canReply(actor,id,store.getConversation(conversationTenant(actor,id,cid),cid,input.version));
        created=await media.upload(mediaContext,{bytes:attachment.bytes,name:attachment.name,mime:attachment.mime});
        message.attachmentIds=[created.id];
      }
      const validate=()=>{reauthorize();const current=store.getConversation(conversationTenant(actor,id,cid),cid,input.version);operations.canReply(actor,id,current);return messagePolicy(actor,id,cid,message);};
      validate();
      const tenant=conversationTenant(actor,id,cid),conversation=store.getConversation(tenant,cid,input.version),channel=tenant.channels.find(item=>item.id===conversation.channelId),adapter=adapterFor(channel);
      if(!adapter||conversation.conversationKind==='group')fail(409,'A conexão deste atendimento não aceita resposta do agente.');
      const result=await outbox.dispatch(actor,id,cid,message,()=>adapter.send(actor,id,cid,message,{reauthorize}),{reauthorize,validate});
      try{invalidatePrivateDrafts(actor,id,cid);}catch{console.error('Rascunhos da conversa revalidados na próxima leitura.');}
      const sent=result?.messages?.find(item=>item?.serviceCommandId===input.idempotencyKey);
      return {state:'confirmed',messageId:sent?.id||null};
    }finally{
      // An upload no outbox command references was never sent: discard it. Unknown references keep the file.
      try{if(created&&!store.db.prepare("SELECT 1 FROM outbound_commands WHERE tenant_id=? AND EXISTS(SELECT 1 FROM json_each(payload,'$.attachmentIds') WHERE value=?)").get(id,created.id))await media.discard(created.id,mediaContext).catch(()=>{});}
      catch{/* Database unavailable: retain for the existing orphan policy. */}
    }
  }
  async function dispatchServiceGroup(actor,id,cid,input,{reauthorize=()=>{}}={}) {
    const validate=()=>{reauthorize();const current=store.getConversation(store.tenant(actor,id),cid,input.version);operations.canReply(actor,id,current);return messagePolicy(actor,id,cid,input);};
    validate();
    const conversation=store.getConversation(store.tenant(actor,id),cid,input.version),channel=store.tenant(actor,id).channels.find(item=>item.id===conversation.channelId),adapter=adapterFor(channel);
    if(!['baileys','telegram-bot','telegram-user'].includes(channel?.transport)||!adapter)fail(409,'A conexão de grupo mudou.');
    const result=await outbox.dispatch(actor,id,cid,input,()=>adapter.send(actor,id,cid,input,{reauthorize:validate}),{reauthorize:validate,validate});
    runtime.invalidateConversation(actor,id,cid);
    const message=result.messages?.find(item=>item.serviceCommandId===input.idempotencyKey);
    return {state:'confirmed',messageId:message?.id||null};
  }
  // summary (GET /api/tenants/:id?summary=1): conversations without messages[] (lastMessage + messageCount instead) and
  // only active runs plus the latest 50. Authorization and redaction are exactly those of the full DTO.
  const filteredTenant = (actor,tenant,{summary=false}={}) => {
    const readable = tenantPermission(actor,'inbox.read',tenant.id);
    const permitted = tenant.conversations.filter(c=>readable(contextFor(tenant.id,c,tenant)));
    const ids = new Set(permitted.map(c=>c.id));
    let runs=runtime.list(actor,tenant.id).filter(run=>ids.has(run.conversationId));
    if(summary){const recent=new Set(runs.slice(-50));runs=runs.filter(run=>ACTIVE_RUNS.has(run.state)||recent.has(run));}
    const value = {...tenant,automation:undefined,mcpServers:undefined,knowledgeSources:undefined,agentMemories:undefined,supportAssistantJobs:undefined,agentAutopilotJobs:undefined,agentAdminProposals:undefined,contactMerges:undefined,conversations:summary?permitted.map(({messages,...conversation})=>conversation):permitted,channels:tenant.channels.map(({supportAssistant,centralSupportScope,onboarding,...channel})=>channel).filter(c=>readable({tenantId:tenant.id,channelId:c.id,aggregate:true})),contacts:undefined,flows:can(actor,'flows.read',{tenantId:tenant.id,aggregate:true})?tenant.flows||[]:[],runs};
    if(actor.role!=='reseller'){
      if(value.parentTenantId&&!(actor.tenantIds||[]).includes(value.parentTenantId))value.parentTenantId=null;
      value.departments=(tenant.departments||[]).filter(d=>readable({tenantId:tenant.id,departmentId:d.id,aggregate:true}));
      value.agents=(tenant.agents||[]).map(({knowledgeGrants,versions,...agent})=>({...agent,...(versions?{versions:versions.map(version=>({...version,...(version.config?{config:Object.fromEntries(Object.entries(version.config).filter(([key])=>key!=='knowledgeGrants'))}:{})}))}:{})}));
    }
    const result=safeTenant(value,actor,{state:tenant});
    if(summary){
      const messages=new Map(permitted.map(c=>[c.id,Array.isArray(c.messages)?c.messages:[]]));
      result.conversations=result.conversations.map(c=>{const list=messages.get(c.id)||[],last=list.at(-1);return {...c,messageCount:list.length,lastMessage:last?{id:last.id??null,kind:last.kind??null,text:typeof last.text==='string'?last.text.slice(0,280):'',createdAt:last.createdAt??null,attachmentKind:typeof last.attachments?.[0]?.kind==='string'?last.attachments[0].kind:null}:null};});
    }
    return result;
  };
  /**
   * GET /api/tenants/:id/conversations/:cid: a window of the conversation (FRONTEND-V2 §7.4). Without a cursor, the
   * latest `limit` messages (default 60) with the conversation metadata and its scoped runs; ?after=<messageId> only the
   * newer messages (reset:true with the latest window when the anchor is gone or more than `limit` arrived);
   * ?version=<n> answers {unchanged:true} when nothing changed; ?before=<messageId> the older messages only.
   */
  function conversationPage(actor,id,cid,params) {
    for(const key of new Set(params.keys()))if(!['before','after','version','limit'].includes(key)||params.getAll(key).length>1)fail(400,'Informe somente before, after, version e limit, uma vez cada.');
    const before=params.get('before'),after=params.get('after'),version=params.get('version'),limitValue=params.get('limit');
    if(before!==null&&after!==null)fail(400,'Use before ou after, não os dois.');
    for(const value of [before,after])if(value!==null&&(!value||value.length>200||/[\x00-\x1f\x7f]/.test(value)))fail(400,'Mensagem de referência inválida.');
    if(version!==null&&!/^[1-9]\d{0,14}$/.test(version))fail(400,'Versão da conversa inválida.');
    if(limitValue!==null&&(!/^[1-9]\d{0,2}$/.test(limitValue)||Number(limitValue)>200))fail(400,'Escolha um limite entre 1 e 200 mensagens.');
    const limit=limitValue===null?60:Number(limitValue),tenant=store.tenant(actor,id),conversation=store.getConversation(tenant,cid);
    requirePermission(actor,'inbox.read',contextFor(id,conversation,tenant));
    const messages=Array.isArray(conversation.messages)?conversation.messages:[];
    if(before!==null){
      const index=messages.findLastIndex(message=>message?.id===before);
      if(index<0)return {messages:[],hasMore:false,reset:true,cursor:{before:null},version:conversation.version};
      const start=Math.max(0,index-limit),window=messages.slice(start,index);
      return {messages:window.map(publicMessage),hasMore:start>0,cursor:{before:window[0]?.id??before},version:conversation.version};
    }
    if(version!==null&&Number(version)===conversation.version)return {unchanged:true,version:conversation.version};
    let window,reset=false,delta=false;
    if(after!==null){
      const index=messages.findLastIndex(message=>message?.id===after);
      if(index>=0&&messages.length-1-index<=limit){window=messages.slice(index+1);delta=true;}
      else{window=messages.slice(-limit);reset=true;}
    }else window=messages.slice(-limit);
    const first=messages.length-window.length,{messages:ignored,...metadata}=conversation;
    return {conversation:safeConversation(metadata,actor,id,undefined,tenant.channels),messages:window.map(publicMessage),runs:runtime.list(actor,id,cid),
      hasMore:!delta&&first>0,...(reset?{reset:true}:{}),cursor:{before:window[0]?.id??messages[first-1]?.id??null,after:messages.at(-1)?.id??null},version:conversation.version,messageCount:messages.length};
  }
  const isAdministrator=actor=>{if(allowDemo&&!actor.userId)return actor.role==='reseller';try{auth.admin(actor);store.admin(actor);return true;}catch{return false;}};
  const pendingHandoffs=tenantId=>new Map(store.db.prepare("SELECT conversation_id AS id,count(*) AS n FROM service_handoff_requests WHERE tenant_id=? AND state='pending' GROUP BY conversation_id").all(tenantId).map(row=>[row.id,Number(row.n)]));
  /** GET /api/me/attention for the session's workspace (FRONTEND-V2 §5.3.4, §7.4). */
  function attentionFor(actor,params) {
    for(const key of new Set(params.keys()))if(key!=='since'||params.getAll(key).length>1)fail(400,'Informe somente a revisão das pendências.');
    // A conversation waits for the autopilot only while it can answer now (same intake rules and commercial state).
    let commercial;
    // A connected agent (MCP copilot) with an active identity that may reply on that channel answers through its product:
    // its conversation waits the same stall time as the autopilot before it counts as parked.
    const identities=new Map(),at=servicePrincipals.now();
    const connectedAnswers=(tenantId,tenant,conversation)=>{const agent=(tenant.agents||[]).find(item=>item.id===conversation.agentId);if(agent?.provider!=='mcp'||agent.mode!=='copilot'||agent.configured!==true)return false;
      const key=tenantId+' '+agent.id;if(!identities.has(key))identities.set(key,store.db.prepare('SELECT capabilities,channel_ids,expires_at,active,revoked_at FROM service_principals WHERE tenant_id=? AND agent_id=?').all(tenantId,agent.id));
      return identities.get(key).some(row=>row.active&&row.revoked_at===null&&Number(row.expires_at)>at&&JSON.parse(row.capabilities).includes('reply.send')&&(row.channel_ids===null||JSON.parse(row.channel_ids).includes(conversation.channelId)));};
    const automatic=(tenantId,tenant,conversation)=>{if(connectedAnswers(tenantId,tenant,conversation))return true;if(!autopilotCovers(tenant,conversation))return false;commercial??=autopilotAuthorize({workspaceId:actor.resellerId});return commercial;};
    // The connected agent that may take a queue conversation (an active identity that manages and replies on that channel and
    // department), with its last authenticated call: a queue that waits while that call is old means the agent is not polling.
    const takers=new Map();
    const queueAgent=(tenantId,tenant,conversation)=>{if(!takers.has(tenantId))takers.set(tenantId,store.db.prepare('SELECT p.agent_id,p.name,p.capabilities,p.channel_ids,p.department_ids,s.last_seen_at FROM service_principals p LEFT JOIN service_principal_presence s ON s.principal_id=p.id WHERE p.tenant_id=? AND p.active=1 AND p.revoked_at IS NULL AND p.expires_at>?').all(tenantId,at));
      let best=null;for(const row of takers.get(tenantId)){const capabilities=JSON.parse(row.capabilities);if(!capabilities.includes('conversation.manage')||!capabilities.includes('reply.send'))continue;
        if(row.channel_ids!==null&&!JSON.parse(row.channel_ids).includes(conversation.channelId)||row.department_ids!==null&&!JSON.parse(row.department_ids).includes(conversation.departmentId))continue;
        const seen=Number.isSafeInteger(row.last_seen_at)?row.last_seen_at:null;if(!best||(seen??-1)>(best.seen??-1))best={name:(tenant.agents||[]).find(agent=>agent.id===row.agent_id)?.name||row.name,seen};}
      return best?{name:String(best.name||'').slice(0,80),lastSeenAt:best.seen===null?null:new Date(best.seen).toISOString()}:null;};
    return inbox.attention(actor,{since:params.get('since')||'',admin:isAdministrator(actor),handoffs:pendingHandoffs,quota:(tenantId,tenant)=>runtime.quota(tenantId,tenant),automatic,queueAgent,
      canDecide:(tenantId,conversation)=>{try{requireResponsible(actor,tenantId,conversation);return true;}catch{return false;}}});
  }
  /**
   * Event stream predicate for one person, rebuilt for every delivery round: the /api/inbox scope (company, channel and
   * effective department) decides conversation and run pointers, the aggregate channel read decides channel states and
   * room membership decides team chat. 'previous' = the conversation was visible before it moved out of the scope.
   * attention.changed pointers follow their conversation (support requests) or reach administrators (proposals).
   */
  const streamVisibility=actor=>{
    const view=inbox.scope(actor),rooms=new Map();let admin;
    return event=>{
      if(event.type==='attention.changed'&&typeof event.conversationId!=='string'){
        if(event.audience!=='admin'||!view.tenant(event.tenantId))return null;
        admin??=isAdministrator(actor);return admin?'current':null;
      }
      if(event.type==='channel.state')return view.channel(event.tenantId,event.channelId)?'current':null;
      if(event.type==='teamchat.message'){
        const key=event.tenantId+'\u0000'+event.roomId;
        if(!rooms.has(key)){let member=false;try{teamChat.getRoom(actor,event.tenantId,event.roomId);member=true;}catch{member=false;}rooms.set(key,member);}
        return rooms.get(key)?'current':null;
      }
      if(typeof event.conversationId!=='string')return null;
      if(view.conversation(event.tenantId,event))return 'current';
      const previous=event.previous,moved=previous&&(Object.hasOwn(previous,'channelId')||Object.hasOwn(previous,'departmentId'));
      return moved&&view.conversation(event.tenantId,{channelId:Object.hasOwn(previous,'channelId')?previous.channelId:event.channelId,departmentId:Object.hasOwn(previous,'departmentId')?previous.departmentId:event.departmentId})?'previous':null;
    };
  };
  const realtime=createEventStreamHub({bus:events,visibility:streamVisibility,runTick:withTenantMemo,
    workspaceOf:tenantId=>store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId)?.reseller_id??null,
    tenantsOf:workspaceId=>store.db.prepare('SELECT id FROM tenants WHERE reseller_id=? ORDER BY id').all(workspaceId).map(row=>row.id),
    onError:()=>console.error('Fluxo de eventos de uma sessão encerrado; o painel continua com a atualização periódica.'),...realtimeOptions});
  /** Session of GET /api/events: the same authentication and workspace rules as session(req), revalidated on every round. */
  function streamPrincipal(req,url,hostname) {
    const token=/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1],sessionKey='session:'+createHash('sha256').update(String(token||'')).digest('hex');
    const demo=allowDemo?sessions.get(token):null;
    if(demo&&demo.expires>Date.now())return {workspaceId:demo.resellerId,sessionKey,userKey:sessionKey,resolve:()=>{const current=sessions.get(token);if(!current||current.expires<=Date.now())fail(401,'Sessão expirada.');return current;}};
    const bound=req.eloziDomain?.workspaceId,requested=url.searchParams.get('workspace')??req.headers['x-elozi-workspace'];
    if(bound&&requested&&requested!==bound)fail(403,'Este endereço pertence a outro workspace.');
    const grant=url.searchParams.get('supportGrant')??req.headers['x-elozi-support-grant'];
    const current=()=>auth.workspaceActor(auth.authenticate(token),bound||requested||undefined,grant||undefined),actor=current();
    return {workspaceId:actor.resellerId,sessionKey,userKey:'user:'+actor.userId,resolve:()=>{
      if(bound&&domains.resolve(hostname)?.workspaceId!==bound)fail(403,'O vínculo deste painel mudou.');
      const latest=current();
      if(latest.userId!==actor.userId||latest.resellerId!==actor.resellerId||(latest.supportGrantId||null)!==(actor.supportGrantId||null))fail(403,'A sessão mudou.');
      return latest;
    }};
  }
  const publishPointer=event=>{try{events.publish(event);}catch{store.reportEventFailure(new Error('pointer'));}};
  // Draft provenance (sourceRunId on send): the run must belong to the same conversation; the server, not the client,
  // decides used/edited by comparing the sent text with the draft read before dispatch.
  const draftSource=(actor,id,cid,runId)=>{
    if(typeof runId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(runId))fail(400,'Rascunho de origem inválido.');
    const run=(store.tenant(actor,id).runs||[]).find(item=>item.id===runId);
    if(!run||run.conversationId!==cid)fail(400,'O rascunho de origem não pertence a esta conversa.');
    return {runId,draft:typeof run.draft==='string'&&run.draft?run.draft:null};
  };
  const sameDraft=(draft,sent)=>typeof sent==='string'&&draft.replace(/\r\n?/g,'\n').trim()===sent.replace(/\r\n?/g,'\n').trim();
  const markDraftOutcome=(state,source,sent,messageId,date)=>{
    const run=(state.runs||[]).find(item=>item.id===source.runId);
    if(!run||run.outcome||source.draft===null)return;
    Object.assign(run,{outcome:sameDraft(source.draft,sent)?'used':'edited',outcomeAt:date,outcomeMessageId:messageId??null,updatedAt:date,version:(run.version||1)+1});
  };
  // After a transport send: tag the new message of this person and the run in one mutation. A failure here never undoes the send.
  const recordDraftUse=(actor,id,cid,source,sent,known)=>{
    try{return store.mutate(actor,id,'Origem do rascunho registrada',state=>{
      const conversation=store.getConversation(state,cid),date=new Date().toISOString();
      const message=conversation.messages.findLast(item=>item&&!known.has(item.id)&&item.kind==='human'&&(item.authorUserId||null)===(actor.userId||null));
      if(message&&!message.sourceRunId)message.sourceRunId=source.runId;
      markDraftOutcome(state,source,sent,message?.id,date);
      return conversation;
    });}catch{console.error('Origem do rascunho não registrada; a mensagem foi enviada.');return null;}
  };
  const releaseAssignments = (actor,userId,accessChanged=false,chatScope={}) => {if(chatScope!==false)teamChat.releaseUser(actor,userId,chatScope);for(const changed of operations.releaseUser(actor,userId,accessChanged?{origin:'user-access',reason:'Acesso do atendente alterado.'}:undefined))runtime.invalidateConversation(actor,changed.tenantId,changed.conversationId);};
  flows.authorize=(actor,id,c,apply)=>{requirePermission(actor,'flows.read',{tenantId:id,aggregate:true});if(c){requirePermission(actor,apply?'inbox.transfer':'inbox.read',contextFor(id,c));if(apply&&actor.role!=='reseller'&&c.assignedUserId!==actor.userId)fail(403,'Assuma este atendimento antes de aplicar uma rota.');}};
  flows.routeOutput=(actor,id,tenant,c,output,graph,steps)=>{const d=(tenant.departments||[]).find(d=>d.active!==false&&(d.id===output.department||d.name===output.department));if(output.department!==c.department&&!d)fail(400,'A rota precisa usar um departamento ativo.');const departmentId=d?.id||c.departmentId||null;requirePermission(actor,'inbox.transfer',{tenantId:id,channelId:c.channelId,departmentId:departmentId||'unassigned'});if(graph.nodes.some(n=>n.type==='handoff'&&steps.some(s=>s.nodeId===n.id))||departmentId!==(c.departmentId||null)){const from={owner:c.owner,assignedUserId:c.assignedUserId||null,departmentId:c.departmentId||null};operations.clearParticipants(c,actor,{origin:'flow',reason:'Rota de transferência aplicada.'});c.assignedUserId=null;c.assignedUserName=null;output.owner='queue';output.agentId=null;c.departmentId=departmentId;operations.event(c,actor,{type:'assignment',from,to:{owner:'queue',assignedUserId:null,departmentId},origin:'flow'});}else c.departmentId=departmentId;};
  function session(req) {
    const token = /(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const data = allowDemo ? sessions.get(token) : null;
    if (data && data.expires > Date.now()) return data;
    const bound=req.eloziDomain?.workspaceId;
    if(bound&&req.headers['x-elozi-workspace']&&req.headers['x-elozi-workspace']!==bound)fail(403,'Este endereço pertence a outro workspace.');
    return auth.workspaceActor(auth.authenticate(token), bound||req.headers['x-elozi-workspace'],req.headers['x-elozi-support-grant']);
  }
  const workspaceList=(req,actor)=>auth.workspaces(actor).filter(item=>!req.eloziDomain||item.id===req.eloziDomain.workspaceId);
  const baseSession=req=>auth.authenticate(/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1]);
  async function body(req,maxBytes=32768) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Use JSON.');
    const chunks=[];let bytes=0;
    for await (const chunk of req) { bytes+=chunk.byteLength; if (bytes > maxBytes) fail(413, 'Conteúdo muito grande.'); chunks.push(chunk); }
    try { const buffer=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));const data = JSON.parse(buffer || '{}'); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; } catch { fail(400, 'JSON inválido.'); }
  }
  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  async function binaryBody(req,{maxBytes=MEDIA_MAX_BYTES,reauthorize=()=>{},onChunk=()=>{},timeoutMs=30000}={}) {
    reauthorize();
    const declared=req.headers['content-length'];
    if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes)){req.resume();fail(413,'O arquivo deve ter até 16 MB.');}
    return new Promise((resolveBody,reject)=>{
      const chunks=[];let length=0;
      const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
      const clearChunks=()=>{for(const chunk of chunks)chunk.fill(0);chunks.length=0;};
      const rejectBody=(status,message)=>{cleanup();clearChunks();req.resume();reject(Object.assign(new Error(message),{status}));};
      const data=chunk=>{try{reauthorize();length+=chunk.length;if(length>maxBytes)return rejectBody(413,'O arquivo deve ter até 16 MB.');onChunk(chunk,length);chunks.push(Buffer.from(chunk));}catch(error){rejectBody(error.status||400,error.message||'O upload foi interrompido.');}};
      const end=()=>{try{reauthorize();cleanup();if(!length){clearChunks();return reject(Object.assign(new Error('Escolha um arquivo com conteúdo.'),{status:400}));}const bytes=Buffer.concat(chunks,length);clearChunks();resolveBody(bytes);}catch(error){rejectBody(error.status||400,error.message||'O upload foi interrompido.');}};
      const error=()=>rejectBody(400,'O upload foi interrompido.');
      const aborted=()=>rejectBody(400,'O upload foi interrompido.');
      const timer=setTimeout(()=>rejectBody(408,'O upload demorou demais. Tente novamente.'),timeoutMs);timer.unref?.();
      req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
    });
  }

  // Operational health without tenant names or IDs. "expected" counts connections that should be live: the gateway's
  // own view plus channels persisted as live (a restore that never ran still shows as missing). /api/health is public and
  // the persisted view parses company documents, so it is recomputed at most every 30 s (the HEALTHCHECK interval) and
  // only for documents that mention a QR/bot transport; the gateways' live counts stay current on every request.
  const {cacheMs:healthCacheMs=30000,schedulerStaleMs=120000}=healthOptions;
  let schedulerTimer=null,schedulerStartedAt=null,schedulerTickAt=null,channelSnapshot=null;
  function startScheduler(intervalMs=15000) {
    if(schedulerTimer)return;schedulerStartedAt=Date.now();
    schedulerTimer=setInterval(()=>scheduled.tick().then(()=>{schedulerTickAt=Date.now();},()=>console.error('Ciclo de agendamento interrompido; confira os estados na aplicação.')),intervalMs);schedulerTimer.unref();
  }
  function stopScheduler(){clearInterval(schedulerTimer);schedulerTimer=null;}
  const persistedChannels=()=>{
    const now=Date.now();if(channelSnapshot&&now-channelSnapshot.at<healthCacheMs)return channelSnapshot;
    const counts={whatsapp:0,telegram:0};
    // One company per statement: a malformed document is skipped alone and never erases the other companies' counts.
    const channels=store.db.prepare("SELECT json_extract(c.value,'$.transport') AS transport,json_extract(c.value,'$.state') AS state,json_extract(c.value,'$.linkedAt') IS NOT NULL AS linked FROM tenants,json_each(tenants.data,'$.channels') AS c WHERE tenants.id=? AND json_extract(c.value,'$.transport') IN ('baileys','telegram-bot','telegram-user')");
    for(const {id} of store.db.prepare("SELECT id FROM tenants WHERE instr(data,'baileys')>0 OR instr(data,'telegram-bot')>0 OR instr(data,'telegram-user')>0").all())try{
      for(const row of channels.all(id)){
        if(row.transport==='baileys'&&row.linked&&['connected','reconnecting','starting'].includes(row.state))counts.whatsapp++;
        if(['telegram-bot','telegram-user'].includes(row.transport)&&['connected','reconnecting'].includes(row.state))counts.telegram++;
      }
    }catch{/* Unreadable document: its channels count only through the gateways' live view. */}
    return channelSnapshot={at:now,...counts};
  };
  function health() {
    let local='ok',persisted={whatsapp:0,telegram:0},storage;
    try{store.db.prepare('SELECT 1').get();}catch{local='unavailable';}
    // A company document that cannot be read leaves only the gateways' live view; it does not mean SQLite is down.
    if(local==='ok')try{persisted=persistedChannels();}catch{persisted={whatsapp:0,telegram:0};}
    try{storage=bridge.status();}catch{storage={mode:bridge.enabled?'postgres-backed-local':'local',state:bridge.state,pending:null,syncedAt:bridge.syncedAt};local='unavailable';}
    const whatsappConnected=gateway.connectedCount(),telegramConnected=telegram.connectedCount()+telegramUser.connectedCount();
    const whatsappLive=typeof gateway.expectedCount==='function'?gateway.expectedCount():0;
    const telegramLive=[...telegram.entries.values(),...telegramUser.entries.values()].filter(entry=>!entry.stopped&&['starting','connected','reconnecting'].includes(entry.state)).length;
    const whatsapp={expected:Math.max(persisted.whatsapp,whatsappLive,whatsappConnected),connected:whatsappConnected};
    const telegramCheck={expected:Math.max(persisted.telegram,telegramLive,telegramConnected),connected:telegramConnected};
    const now=Date.now(),schedulerState=!schedulerTimer?'stopped':now-(schedulerTickAt??schedulerStartedAt)>schedulerStaleMs?'stale':'running';
    const level=local!=='ok'||gateway.closing||telegram.closing||telegramUser.closing||storage.state==='closed'?'down'
      :whatsapp.connected<whatsapp.expected||telegramCheck.connected<telegramCheck.expected||['offline','starting'].includes(storage.state)||schedulerState==='stale'?'degraded':'ok';
    return {status:'ok',version:appVersion,mode:publicURL?'hosted-pilot':'local-pilot',authentication:authenticationMode(),storage,externalDelivery:whatsappConnected+telegramConnected>0,whatsappConnections:whatsappConnected,telegramConnections:telegramConnected,level,
      checks:{whatsapp,telegram:telegramCheck,storage:{state:storage.state,pending:storage.pending,syncedAt:storage.syncedAt,local},scheduler:{state:schedulerState,lastTickAt:schedulerTickAt?new Date(schedulerTickAt).toISOString():null}}};
  }

  const server = http.createServer(async (req, res) => {
    const requestStarted=process.hrtime.bigint(),writeHeadOrigin=res.writeHead;
    // Origin processing time only (no body, identity or route detail), so browser timing can separate edge/RTT from server work.
    res.writeHead=function(...args){if(!this.headersSent&&!this.hasHeader('Server-Timing'))this.setHeader('Server-Timing','app;dur='+(Number(process.hrtime.bigint()-requestStarted)/1e6).toFixed(1));return writeHeadOrigin.apply(this,args);};
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${google.clientId?' https://accounts.google.com/gsi/':''}; style-src 'self' 'unsafe-inline'${google.clientId?' https://accounts.google.com/gsi/style':''}; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; connect-src 'self'${google.clientId?' https://accounts.google.com/gsi/':''}; frame-src ${google.clientId?'https://accounts.google.com/gsi/':"'none'"}; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    res.setHeader('Cross-Origin-Opener-Policy','same-origin-allow-popups');
    try {
      const hostname = (req.headers.host || '').split(':')[0].toLowerCase();
      const url = new URL(req.url, `http://${req.headers.host}`), path = url.pathname;
      // stripe-billing hook: dedicated raw-body Stripe webhook, routed before domain/session/body handling. Up to 512 KiB, exact bytes,
      // only on the configured public host; never logs the body or the signature.
      if(path==='/api/stripe/webhook'){if(publicURL&&hostname!==publicURL.hostname)fail(404,'Rota não encontrada.');if(req.method!=='POST')fail(405,'Use POST no webhook de cobrança.');limitAccess(req,'stripe-webhook',120);if(Number(req.headers['content-length'])>STRIPE_WEBHOOK_MAX_BYTES)fail(413,'Evento muito grande.');const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>STRIPE_WEBHOOK_MAX_BYTES)fail(413,'Evento muito grande.');chunks.push(chunk);}return send(res,200,await stripeBilling.receiveWebhook(Buffer.concat(chunks),req.headers['stripe-signature']));}
      // stripe-billing hook (D1): Stripe success/cancel/portal return. Tiny no-store page without app data or script whose meta
      // refresh is a same-site navigation (carries the SameSite=Strict session) to /?billing=<state>&workspace=<id>#settings/billing.
      if(path==='/billing/return'&&['GET','HEAD'].includes(req.method)){const page=Buffer.from(billingReturnPage(url.searchParams));res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':page.length});return res.end(req.method==='HEAD'?undefined:page);}
      const boundDomain=domains.resolve(hostname);req.eloziDomain=boundDomain;
      const publicRequest=Boolean(publicURL&&hostname===publicURL.hostname||boundDomain);
      const probeNonce=typeof req.headers['x-elozi-domain-nonce']==='string'&&/^[a-f0-9]{64}$/.test(req.headers['x-elozi-domain-nonce'])?req.headers['x-elozi-domain-nonce']:null;
      const probeRow=path==='/api/domain-check'&&req.method==='GET'&&req.headers['x-elozi-domain-check']==='1'?store.db.prepare("SELECT id FROM resellers WHERE json_extract(data,'$.workspaceDomain.host')=? AND (json_extract(data,'$.workspaceDomain.state') IN ('verified','active') OR (?=1 AND json_extract(data,'$.workspaceDomain.state')='pending'))").get(hostname,Number(Boolean(probeNonce))):null;
      if(probeRow&&/^[a-f0-9]{40}$/.test(sourceRevision)){
        const binding=domains.metadata(accounts.accountRow(probeRow.id));
        if(binding?.verifiedAt||probeNonce){
          const proof={workspaceId:probeRow.id,host:hostname,canonicalHost:domains.canonicalHost,sourceRevision};
          if(probeNonce){const key=await invitationKeyLoader(),latest=accounts.accountRow(probeRow.id),current=domains.metadata(latest);if(!current||current.host!==hostname||current.challenge!==binding.challenge||current.state==='disabled')fail(409,'O vínculo de domínio mudou.');Object.assign(proof,{nonce:probeNonce,signature:signDomainProbe(proof,{nonce:probeNonce,challenge:current.challenge,version:latest.version},key)});}
          res.setHeader('X-Elozi-Domain-Check','1');return send(res,200,proof);
        }
      }
      if (!['127.0.0.1', 'localhost'].includes(hostname)&&!publicRequest) fail(403, 'Host não autorizado.');
      const domainTenant=tenantId=>{if(boundDomain&&store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId)?.reseller_id!==boundDomain.workspaceId)fail(403,'O canal pertence a outro painel.');};
      const publicWebchat=/^\/api\/public\/webchat\/([A-Za-z0-9_-]{1,120})\/([A-Za-z0-9_-]{1,120})\/(config|challenge|session|messages|history|media|contact|identity|feedback|logout)(?:\/([A-Za-z0-9_-]{1,120}))?$/.exec(path);
      if(publicWebchat){
        const webchatStarted=process.hrtime.bigint();
        const [,tenantId,channelId,action,attachmentId]=publicWebchat,origin=req.headers.origin;
        // Cross-origin widget API: only the webchat timing below, never the panel's app;dur.
        const writeHead=writeHeadOrigin,timedPost=req.method==='POST'&&['history','identity','messages'].includes(action);
        res.writeHead=function(status,...args){
          if(!this.headersSent&&(timedPost||req.method==='OPTIONS'&&status===204))this.setHeader('Server-Timing','webchat;dur='+(Number(process.hrtime.bigint()-webchatStarted)/1e6).toFixed(3));
          return writeHead.call(this,status,...args);
        };
        const freshDomain=()=>{if(boundDomain){const current=domains.resolve(hostname);if(!current||current.workspaceId!==boundDomain.workspaceId||current.host!==boundDomain.host||store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId)?.reseller_id!==current.workspaceId)fail(403,'O vínculo deste painel mudou.');}return true;};
        freshDomain();domainTenant(tenantId);let access;
        // A live channel opened from a site outside its list gets one readable refusal, on the public configuration only: its
        // preflight passes and the POST answers 403 webchat_origin_denied, so the widget can say what is wrong. Every other
        // route (session, history, messages, media) keeps refusing that origin without CORS.
        try{access=webchat.publicAccess(tenantId,channelId,origin);}catch(error){
          if(error?.code!=='webchat_origin_denied'||action!=='config'||attachmentId||url.search)throw error;
          res.setHeader('Access-Control-Allow-Origin',error.origin);res.setHeader('Vary','Origin');
          if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Max-Age','60');res.writeHead(204);return res.end();}
          throw error;
        }
        res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
        if(url.search||attachmentId&&action!=='media')fail(400,'Rota do webchat inválida.');
        if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Max-Age','300');res.writeHead(204);return res.end();}
        if(req.method!=='POST')fail(405,'Use POST no webchat.');
        await agentSecrets();freshDomain();webchat.publicAccess(tenantId,channelId,origin);
        if(action==='media'&&!attachmentId){
          if(req.headers['content-type']!=='application/octet-stream')fail(415,'Envie o arquivo como application/octet-stream.');
          const bearer=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');if(!bearer)fail(401,'Sessão de visitante necessária.');
          const identity={token:bearer[1],tenantId,channelId,origin},context=webchat.mediaAccess(identity),authorize=()=>{freshDomain();context.reauthorize();};
          limitAccess(req,'webchat-media-'+context.conversationId,120);
          const uploadKey='webchat:'+context.conversationId;if(uploads.size>=4||uploads.has(uploadKey)){req.resume();fail(429,'Aguarde o upload atual e tente novamente.');}uploads.add(uploadKey);
          let frame,decoded,fileBytes,normalized;const prefix=Buffer.alloc(8196);let prefixBytes=0,metadataLength=0,metadataChecked=false;
          const inspectChunk=chunk=>{
            const copied=Math.min(chunk.length,prefix.length-prefixBytes);if(copied>0){chunk.copy(prefix,prefixBytes,0,copied);prefixBytes+=copied;}
            if(!metadataLength&&prefixBytes>=4){metadataLength=prefix.readUInt32BE(0);if(!metadataLength||metadataLength>8192)fail(metadataLength>8192?413:400,'Cabeçalho de arquivo inválido.');}
            if(metadataLength&&!metadataChecked&&prefixBytes>=4+metadataLength){decodeWebchatMediaMetadata(prefix.subarray(4,4+metadataLength));metadataChecked=true;const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared-4-metadataLength>MEDIA_MAX_BYTES)fail(413,'O arquivo deve ter até 16 MB.');}
          };
          try{
            authorize();frame=await binaryBody(req,{maxBytes:WEBCHAT_MEDIA_FRAME_MAX_BYTES,reauthorize:authorize,onChunk:inspectChunk,timeoutMs:120000});authorize();decoded=decodeWebchatMedia(frame);fileBytes=decoded.attachment.bytes;
            const originalContentHash=createHash('sha256').update(frame).digest('hex');
            if(decoded.attachment.voice){normalized=await voiceNormalizer(decoded.attachment.bytes,{mime:decoded.attachment.mime});authorize();decoded.attachment={...decoded.attachment,...normalized,voice:true};}
            return send(res,200,await webchat.receiveMedia({...decoded,...identity},{reauthorize:authorize,originalContentHash}));
          }finally{frame?.fill(0);fileBytes?.fill(0);decoded?.attachment?.bytes?.fill(0);normalized?.bytes?.fill(0);prefix.fill(0);uploads.delete(uploadKey);}
        }
        if(['config','challenge','session'].includes(action))limitAccess(req,'webchat-'+tenantId+'-'+channelId,120);
        const input=await body(req);freshDomain();
        if(action==='media'){
          if(Object.keys(input).some(key=>key!=='token'))fail(400,'Informe somente a sessão para acessar este arquivo.');
          const identity={...input,tenantId,channelId,origin},context=webchat.mediaAccess(identity),authorize=()=>{freshDomain();context.reauthorize();};
          limitAccess(req,'webchat-download-'+context.conversationId,120);authorize();
          if(publicMediaReads.size>=4)fail(429,'Aguarde o carregamento atual e tente novamente.');const readKey=randomUUID();publicMediaReads.add(readKey);let file,reading=true;
          const release=()=>{file?.bytes.fill(0);if(!reading)publicMediaReads.delete(readKey);};
          const readAuthorize=()=>{authorize();if(res.destroyed)fail(400,'O carregamento foi interrompido.');};
          res.once('close',release);
          try{file=await webchat.readMedia({...identity,attachmentId},{reauthorize:readAuthorize});reading=false;readAuthorize();const {metadata,bytes}=file,disposition=metadata.preview?'inline':'attachment';res.writeHead(200,{'Content-Type':metadata.mime,'Content-Length':bytes.length,'Content-Disposition':`${disposition}; filename="arquivo"; filename*=UTF-8''${encodeURIComponent(metadata.name)}`});return res.end(bytes);}catch(error){reading=false;release();throw error;}
        }
        if(action==='challenge'){if(Object.keys(input).length)fail(400,'Não informe dados na abertura do webchat.');return send(res,200,{...access,...webchat.challenge({tenantId,channelId,origin})});}
        if(action==='config'){if(Object.keys(input).length)fail(400,'Não informe dados na configuração pública.');return send(res,200,webchat.publicAccess(tenantId,channelId,origin));}
        const context={...input,tenantId,channelId,origin};
        if(['identity','logout'].includes(action)){limitAccess(req,'webchat-'+action+'-'+tenantId+'-'+channelId,120);return send(res,200,action==='identity'?webchat.renewIdentity(context):webchat.logout(context));}
        if(action!=='session'){const visitor=webchat.visitorAccess({token:input.token,tenantId,channelId,origin},{allowExpiredIdentity:action==='history'&&Object.hasOwn(input,'identityToken')});limitAccess(req,'webchat-'+action+'-'+visitor.conversationId,120);}
        if(action==='contact'||action==='feedback')return send(res,200,action==='contact'?webchat.updateContact(context):webchat.feedback(context));
        return send(res,200,action==='session'?webchat.openSession(context):action==='messages'?await webchat.receive(context,{reauthorize:freshDomain}):webchat.history(context));
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        const expected = boundDomain?`https://${hostname}`:publicRequest?publicOrigin:`http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expected) fail(403, 'Origem não autorizada.');
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Origem não autorizada.');
      }
      const setSession=result=>{if(boundDomain){try{auth.workspaceActor(result.actor,boundDomain.workspaceId);}catch(error){auth.logout(result.token);throw error;}}res.setHeader('Set-Cookie',`mep_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.sessionTtlMs/1000)}${publicRequest?'; Secure':''}`);};
      const googleChallenge=()=>{const {token,...challenge}=google.issue();if(token)res.setHeader('Set-Cookie',`mep_google=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300${publicRequest?'; Secure':''}`);return challenge;};
      const incomingWebhook=/^\/api\/webhooks\/(email|meta)\/([A-Za-z0-9_-]{1,120})\/([A-Za-z0-9_-]{1,120})$/.exec(path);
      if(incomingWebhook){
        const [,kind,tenantId,channelId]=incomingWebhook;
        domainTenant(tenantId);
        if(kind==='meta'&&req.method==='GET'){const challenge=await meta.verifyWebhook(tenantId,channelId,Object.fromEntries(url.searchParams));res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end(String(challenge));}
        if(req.method==='POST'){
          const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>262144)fail(413,'Evento muito grande.');chunks.push(chunk);}
          const rawBody=Buffer.concat(chunks),receipt=kind==='meta'?await meta.receiveWebhook(tenantId,channelId,rawBody,req.headers['x-hub-signature-256']):await emailChannel.receiveWebhook({tenantId,channelId,rawBody,timestamp:req.headers['x-elozi-timestamp'],signature:req.headers['x-elozi-signature']});
          return send(res,200,{accepted:true,...receipt});
        }
        fail(405,'Método de webhook indisponível.');
      }
      // /api/health stays 200 for monitors (level tells ok/degraded/down); /ready answers 503 only when down, for cutover and HEALTHCHECK.
      if (path === '/api/health' && req.method === 'GET') return send(res, 200, health());
      if (path === '/api/health/ready' && req.method === 'GET') {const report=health();return send(res, report.level==='down'?503:200, report);}
      if (path === '/api/agent/mcp' && await serviceMcp(req, res)) return;
      // Public attendant skill of Hermes (docs/HERMES-SKILL.md): brand of the host only, no session, tenant or secret.
      if (path === ATTENDANT_SKILL_PATH) return serveAttendantSkill(req, res, { custom: Boolean(boundDomain), brand: boundDomain?.brand, origin: boundDomain ? `https://${hostname}` : publicOrigin || `http://${req.headers.host}` });
      // Login brand of this address (FRONTEND-V2 §8.11): the derived accent tokens of the active custom domain, else the
      // default brand. Public (no session, tenant or secret) and revalidated on every load, like the other assets.
      if (path === BRAND_STYLESHEET_PATH && req.method === 'GET') {
        const css = brandStylesheet(boundDomain?.brand?.accent), etag = `"${createHash('sha256').update(css).digest('hex')}"`;
        res.setHeader('Cache-Control', 'no-cache'); res.setHeader('ETag', etag);
        if (etagMatches(req.headers['if-none-match'], etag)) { res.writeHead(304); return res.end(); }
        res.writeHead(200, { 'Content-Type': types['.css'], 'Content-Length': Buffer.byteLength(css) }); return res.end(css);
      }
      if(path==='/api/auth/status' && req.method==='GET')return send(res,200,{setupRequired:!publicRequest&&auth.status().setupRequired,registrationEnabled:allowRegistration&&!boundDomain,publicTrial:publicTrialEnabled&&allowRegistration&&!boundDomain?{days:7,documentRequired:true}:null,google:boundDomain?{enabled:false}:googleChallenge(),emailConfigured:email.status().configured,productName:boundDomain?.brand?.name||'Elozi',brand:boundDomain?.brand||null});
      if(path.startsWith('/api/service/v1/')){
        const serviceActor=servicePrincipals.authenticate(req.headers.authorization);
        if(boundDomain&&serviceActor.workspaceId!==boundDomain.workspaceId)fail(403,'O serviço pertence a outro painel.');
        if(path==='/api/service/v1/inbox'&&req.method==='POST')return send(res,200,serviceApi.inbox(serviceActor,await body(req)));
        if(path==='/api/service/v1/search'&&req.method==='POST')return send(res,200,serviceApi.searchConversations(serviceActor,await body(req)));
        if(path==='/api/service/v1/conversation-history'&&req.method==='POST')return send(res,200,serviceApi.readConversationHistory(serviceActor,await body(req)));
        if(path==='/api/service/v1/groups'&&req.method==='POST')return send(res,200,serviceApi.listGroups(serviceActor,await body(req)));
        if(path==='/api/service/v1/group-history'&&req.method==='POST')return send(res,200,serviceApi.readGroupHistory(serviceActor,await body(req)));
        if(path==='/api/service/v1/group-messages'&&req.method==='POST')return send(res,200,await serviceApi.sendGroup(serviceActor,await body(req)));
        if(path==='/api/service/v1/group-schedules'&&req.method==='POST')return send(res,201,await serviceApi.scheduleGroup(serviceActor,await body(req)));
        if(path==='/api/service/v1/company'&&req.method==='GET')return send(res,200,serviceApi.readCompany(serviceActor,req.headers['x-elozi-request-id']));
        if(path==='/api/service/v1/admin-proposals'&&req.method==='POST')return send(res,201,serviceApi.proposeAdmin(serviceActor,await body(req)));
        if(path==='/api/service/v1/me'&&req.method==='GET')return send(res,200,{...serviceApi.me(serviceActor),webhook:serviceWebhooks.describe(serviceActor.principalId)});
        if(path==='/api/service/v1/notification-contract'&&req.method==='GET'){
          const policy=serviceNotifications.policy(serviceActor);
          return send(res,200,{schema:'elozi-notification/v1',channelId:policy.channel_id,appOrigin:policy.app_origin,productName:policy.product_name,inferenceRequired:false,receiptLookup:'original-request-id',deliveryConfirmation:'provider-acceptance',recipientAttestation:'trusted-product-backend'});
        }
        if(path==='/api/service/v1/notifications'&&req.method==='POST')return send(res,200,await serviceNotifications.notify(serviceActor,await body(req)));
        const notificationReceipt=/^\/api\/service\/v1\/notifications\/([A-Za-z0-9_-]{8,120})$/.exec(path);
        if(notificationReceipt&&req.method==='GET')return send(res,200,serviceNotifications.readOutcome(serviceActor,notificationReceipt[1],url.searchParams.get('channelId')));
        const notificationRecipient=/^\/api\/service\/v1\/notification-recipients\/([A-Za-z0-9_-]{8,120})(?:\/(revoke|messages|media\/([A-Za-z0-9_-]{8,120})))?$/.exec(path);
        if(notificationRecipient){const [,recipientId,operation,attachmentId]=notificationRecipient;
          if(!operation&&req.method==='PUT')return send(res,200,serviceNotifications.bind(serviceActor,recipientId,await body(req)));
          if(!operation&&req.method==='GET')return send(res,200,serviceNotifications.readRecipient(serviceActor,recipientId));
          if(operation==='revoke'&&req.method==='POST')return send(res,200,serviceNotifications.revoke(serviceActor,recipientId,await body(req)));
          if(operation==='messages'&&req.method==='GET')return send(res,200,serviceNotifications.history(serviceActor,recipientId));
          if(attachmentId&&req.method==='GET'){
            const {metadata,bytes}=await serviceNotifications.attachment(serviceActor,recipientId,attachmentId);
            res.writeHead(200,{'Content-Type':metadata.mime,'Content-Length':bytes.length,'Content-Disposition':'attachment; filename="arquivo"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.once('close',()=>bytes.fill(0));return res.end(bytes);
          }
        }
        // Agent as attendant: change events (long wait, aborted when the client leaves), private replies and conversation changes.
        if(path==='/api/service/v1/events/wait'&&req.method==='POST'){const input=await body(req),disconnect=new AbortController();res.once('close',()=>disconnect.abort());return send(res,200,await serviceApi.waitForEvents(serviceActor,input,{signal:disconnect.signal}));}
        // A reply may carry one base64 file of up to 10 MiB (about 14 MiB encoded); the bearer was already authenticated.
        if(path==='/api/service/v1/replies'&&req.method==='POST')return send(res,200,await serviceApi.sendReply(serviceActor,await body(req,15*1024*1024)));
        if(path==='/api/service/v1/agent-handovers'&&req.method==='POST')return send(res,200,serviceApi.handOverConversation(serviceActor,await body(req)));
        // REST twin of elozi_read_attachment: bytes only in this authenticated response, revalidated right before delivery.
        if(path==='/api/service/v1/attachment-reads'&&req.method==='POST'){
          const input=await body(req),result=await serviceApi.readAttachment(serviceActor,input);
          try{serviceApi.revalidateAttachmentRead(serviceActor,input,result);}catch(error){result.attachment.data='';throw error;}
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});return res.end(JSON.stringify(result));
        }
        if(path==='/api/service/v1/conversation-claims'&&req.method==='POST')return send(res,200,serviceApi.claimConversation(serviceActor,await body(req)));
        if(path==='/api/service/v1/human-transfers'&&req.method==='POST')return send(res,200,serviceApi.transferToHuman(serviceActor,await body(req)));
        if(path==='/api/service/v1/conversation-tags'&&req.method==='POST')return send(res,200,serviceApi.setTags(serviceActor,await body(req)));
        if(path==='/api/service/v1/conversation-closures'&&req.method==='POST')return send(res,200,serviceApi.closeConversation(serviceActor,await body(req)));
        const readService=/^\/api\/service\/v1\/conversations\/([A-Za-z0-9_-]{1,120})$/.exec(path);
        if(readService&&req.method==='GET')return send(res,200,serviceApi.read(serviceActor,readService[1],req.headers['x-elozi-request-id']));
        if(path==='/api/service/v1/drafts'&&req.method==='POST')return send(res,200,await serviceApi.draft(serviceActor,await body(req)));
        if(path==='/api/service/v1/external-drafts'&&req.method==='POST')return send(res,200,serviceApi.submitDraft(serviceActor,await body(req)));
        if(path==='/api/service/v1/handoff-requests'&&req.method==='POST')return send(res,201,serviceApi.handoff(serviceActor,await body(req)));
        const receiptService=/^\/api\/service\/v1\/receipts\/([A-Za-z0-9_-]{1,120})$/.exec(path);
        if(receiptService&&req.method==='GET')return send(res,200,{receipt:servicePrincipals.getReceipt(serviceActor,receiptService[1])});
        fail(404,'Operação de serviço não encontrada.');
      }
      if(path==='/api/auth/invitations/preview'&&req.method==='POST'){
        limitAccess(req,'invite-preview',30);const input=await body(req),preview=auth.previewInvitation(input.token);
        if(boundDomain&&preview.workspace.id!==boundDomain.workspaceId)fail(403,'Este convite pertence a outro endereço de acesso.');
        return send(res,200,{...preview,workspaceName:preview.workspace.name,tenantNames:preview.tenants.map(t=>t.name),...(boundDomain?{productBrand:boundDomain.brand}:{})});
      }
      if(path==='/api/auth/invitations/accept'&&req.method==='POST'){
        limitAccess(req,'invite-accept',10);const input=await body(req),{token,...identity}=input;
        if(boundDomain&&auth.previewInvitation(token).workspace.id!==boundDomain.workspaceId)fail(403,'Este convite pertence a outro endereço de acesso.');
        const result=await auth.acceptInvitation(token,identity);setSession(result);
        return send(res,200,{user:auth.me(result.actor)});
      }
      if(path==='/api/auth/password/forgot'&&req.method==='POST'){
        limitAccess(req,'password-forgot',10);const input=await body(req),configured=email.status().configured;
        if(typeof input.email!=='string'||input.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))fail(400,'Informe um e-mail válido.');
        if(configured){
          const challenge=auth.passwordResetChallenge(input.email);
          if(challenge)try{await email.enqueuePasswordReset(challenge);email.flush().catch(()=>{});}catch{console.error('Envio de recuperação de senha adiado.');}
        }
        return send(res,200,{requested:true,configured});
      }
      if(path==='/api/auth/password/reset'&&req.method==='POST'){
        limitAccess(req,'password-reset',10);const input=await body(req);
        await auth.consumePasswordReset(input.token,{password:input.password});return send(res,200,{reset:true});
      }
      if(path==='/api/auth/password/change'&&req.method==='POST'){
        session(req);const input=await body(req),actor=session(req),sessionToken=/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];
        return send(res,200,await auth.changePassword(actor,input,{sessionToken}));
      }
      if(path==='/api/auth/sessions'&&req.method==='GET'){
        const actor=session(req),token=/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];return send(res,200,auth.sessions(actor,token));
      }
      const revokeSession=/^\/api\/auth\/sessions\/([^/]+)\/revoke$/.exec(path);
      if(revokeSession&&req.method==='POST'){
        session(req);await body(req);const actor=session(req),token=/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];
        const result=auth.revokeSession(actor,revokeSession[1],token);
        if(result.current)res.setHeader('Set-Cookie',`mep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${publicRequest?'; Secure':''}`);
        return send(res,200,result);
      }
      if(['/api/auth/setup','/api/auth/login','/api/auth/register','/api/auth/google'].includes(path)&&req.method==='POST'){
        hitLimit('login:'+requestClient(req),20,'Muitas tentativas. Aguarde um minuto.');
        const input=await body(req);let result;
        if(path.endsWith('/setup')){if(publicRequest)fail(403,'O primeiro administrador é criado pelo acesso privado da plataforma.');result=await auth.setup(input);}
        else if(path.endsWith('/register')){if(!allowRegistration||boundDomain)fail(403,'O cadastro está fechado neste ambiente.');result=await auth.register(input,{provision});await verificationEmail(result.actor);}
        else if(path.endsWith('/google')){if(boundDomain)fail(409,'O login Google ainda precisa autorizar este domínio.');const token=/(?:^|;\s*)mep_google=([^;]+)/.exec(req.headers.cookie||'')?.[1];const profile=await google.verify(input.credential,token);result=await auth.googleLogin(profile,{provision,accountKind:input.accountKind??'business',allowRegistration,fiscalDocument:input.fiscalDocument,locale:input.locale});}
        else result=await auth.login(input);
        setSession(result);
        return send(res,200,{session:{role:result.actor.role,name:result.actor.name,userId:result.actor.userId}});
      }
      if(path==='/api/auth/me'&&req.method==='GET')return send(res,200,{user:auth.me(session(req)),google:googleChallenge(),emailConfigured:email.status().configured});
      if(path==='/api/auth/me'&&req.method==='PATCH'){session(req);const input=await body(req);return send(res,200,{user:auth.updateProfile(session(req),input)});}
      if(path==='/api/auth/presence'&&req.method==='PATCH'){session(req);const input=await body(req);return send(res,200,{user:auth.updatePresence(session(req),input.presence)});}
      if(path==='/api/workspaces'&&req.method==='GET'){const actor=session(req);return send(res,200,{workspaces:workspaceList(req,actor),currentResellerId:actor.resellerId});}
      // Connected products: the operator of the workspace (role reseller, outside temporary support) sees every company's lines and agents.
      if(path==='/api/platform/connected-products'&&req.method==='GET'){const actor=session(req);store.admin(actor);if(!actor.userId||actor.supportGrantId)fail(403,'Somente a administração da operação vê os produtos conectados.');return send(res,200,connectedProducts({store,actor,principals:servicePrincipals,webhooks:serviceWebhooks,ownLines,activity:serviceActivity}));}
      // Connect a product: one idempotent call creates the agent, the identity scoped to the channel, the reply policy and the webhook (off).
      if(path==='/api/platform/product-connections'&&req.method==='POST'){const actor=session(req);store.admin(actor);if(!actor.userId||actor.supportGrantId)fail(403,'Somente a administração da operação conecta produtos.');const input=await body(req);const result=await productConnections.connect(actor,input);return send(res,result.replay?200:201,result);}
      if(path==='/api/platform/users'&&req.method==='GET')return send(res,200,auth.listPlatformUsers(session(req),{q:url.searchParams.get('q')||'',offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50,state:url.searchParams.get('state')||'all',role:url.searchParams.get('role')||'all'}));
      const accountDeleteRoute=/^\/api\/(?:account|platform\/accounts\/([^/]+))\/delete$/.exec(path);
      if(accountDeleteRoute){
        if(req.method!=='POST'){res.setHeader('Allow','POST');fail(405,'A exclusão da conta aceita somente POST.');}
        const actor=session(req),platformRoute=accountDeleteRoute[1]!==undefined;
        hitLimit('account-delete:'+(actor.userId||requestClient(req)),10,'Muitas tentativas de exclusão. Aguarde um minuto.');
        const input=await body(req);
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['dryRun','confirmName','password'].includes(key)))fail(400,'Informe somente a confirmação da exclusão.');
        if(input.dryRun===true)hitLimit('account-delete-dry-run:'+(actor.userId||requestClient(req)),3,'Muitas tentativas de exclusão. Aguarde um minuto.');
        let target=actor.resellerId;
        if(platformRoute){
          try{target=decodeURIComponent(accountDeleteRoute[1]);}catch{target='';}
          if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(target))throw Object.assign(new Error('Identificador de conta inválido.'),{status:400,code:'account_delete_invalid_id'});
        }
        const result=await accountDeletion.remove(session(req),target,{mode:platformRoute?'platform':'self',dryRun:input.dryRun===true,confirmName:input.confirmName,password:input.password});
        if(result.deleted&&!platformRoute)res.setHeader('Set-Cookie',`mep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${publicRequest?'; Secure':''}`);
        return send(res,200,result);
      }
      if(['/api/platform/accounts','/api/accounts'].includes(path)){
        const filters={view:path==='/api/platform/accounts'?'platform':url.searchParams.get('view')||'account',q:url.searchParams.get('q')||'',kind:url.searchParams.get('kind')||'all',state:url.searchParams.get('state')||'all',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||50)};
        if(req.method==='GET')return send(res,200,accounts.list(session(req),filters));
        if(req.method==='POST'&&path==='/api/accounts'){session(req);const input=await body(req);return send(res,201,accounts.create(session(req),input));}
      }
      const accountUsageRoute=/^\/api\/accounts\/([^/]+)\/usage$/.exec(path);
      if(accountUsageRoute){
        const actor=session(req);
        if(req.method!=='GET'){res.setHeader('Allow','GET');fail(405,'O relatório de consumo aceita somente consulta.');}
        if([...url.searchParams.keys()].some(key=>key!=='scope')||url.searchParams.getAll('scope').length>1)fail(400,'Informe somente o escopo do relatório.');
        return send(res,200,commercialUsage.overview(actor,accountUsageRoute[1],{scope:url.searchParams.has('scope')?url.searchParams.get('scope'):'own'}));
      }
      const accountLifecycleRoute=/^\/api\/accounts\/([^/]+)\/lifecycle$/.exec(path);
      if(accountLifecycleRoute){
        const id=accountLifecycleRoute[1];
        if(req.method==='GET')return send(res,200,{lifecycle:accounts.lifecycle.overview(session(req),id)});
        if(req.method==='PATCH'){session(req);const input=await body(req),result=accounts.lifecycle.update(session(req),id,input);return send(res,200,{...result,account:accounts.overview(session(req),id)});}
      }
      const domainRoute=/^\/api\/accounts\/([^/]+)\/domain(?:\/(verify|activate|disable))?$/.exec(path);
      if(domainRoute){
        const [,id,action]=domainRoute;
        if(req.method==='GET'&&!action)return send(res,200,domains.status(session(req),id));
        if(['POST','DELETE'].includes(req.method)){session(req);const input=await body(req),actor=session(req);
          if(req.method==='DELETE'&&!action)return send(res,200,domains.remove(actor,id,input));
          if(req.method==='POST'){const method=action==='verify'?'verify':action==='activate'?'confirmDeployment':action==='disable'?'disable':'register';return send(res,200,await domains[method](actor,id,input));}
        }
      }
      if(path==='/api/commercial/plans'&&req.method==='GET')return send(res,200,commercialPlans.list(session(req),{workspaceId:url.searchParams.get('workspaceId')||undefined,q:url.searchParams.get('q')||'',state:url.searchParams.get('state')||'all',targetKind:url.searchParams.get('targetKind')||'all',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||25)}));
      const planRoute=/^\/api\/accounts\/([^/]+)\/plans(?:\/([^/]+)(?:\/(contract-draft))?)?$/.exec(path);
      if(planRoute){
        const [,workspaceId,planId,action]=planRoute;
        if(req.method==='GET'&&planId&&!action)return send(res,200,commercialPlans.detail(session(req),workspaceId,planId));
        if(req.method==='POST'&&!planId){session(req);const input=await body(req);return send(res,201,commercialPlans.create(session(req),workspaceId,input));}
        if(req.method==='PATCH'&&planId&&!action){session(req);const input=await body(req);return send(res,200,commercialPlans.update(session(req),workspaceId,planId,input));}
        if(req.method==='POST'&&action==='contract-draft'){session(req);const input=await body(req);return send(res,200,commercialPlans.contractDraft(session(req),workspaceId,planId,input));}
      }
      const accountRoute=/^\/api\/accounts\/([^/]+)(?:\/(invitations|platform-access)(?:\/([^/]+)\/revoke)?)?$/.exec(path);
      if(accountRoute){
        const id=accountRoute[1];
        if(!accountRoute[2]&&req.method==='GET')return send(res,200,{account:accounts.overview(session(req),id)});
        if(!accountRoute[2]&&req.method==='PATCH'){session(req);const input=await body(req);return send(res,200,accounts.update(session(req),id,input));}
        if(accountRoute[2]==='platform-access'&&req.method==='POST'){
          session(req);const input=await body(req);
          return send(res,200,auth.transaction(()=>{
            const actor=session(req),{account}=accounts.authorizeAdministration(actor,id);
            if(!platformOwner(actor)||actor.supportGrantId)fail(403,'Acesso administrativo reservado ao administrador principal.');
            if(!input||Object.keys(input).some(key=>key!=='version')||input.version!==account.version)fail(409,'A conta mudou. Atualize antes de abrir a operação.');
            const inserted=store.db.prepare('INSERT OR IGNORE INTO auth_workspace_access(user_id,reseller_id,created_at) VALUES (?,?,?)').run(actor.userId,id,Date.now());
            if(inserted.changes)accounts.audit(actor,accounts.accountRow(id),'account.platform-access.granted');
            return {workspaceId:id,workspaces:auth.workspaces(actor),auditRecorded:Boolean(inserted.changes)};
          }));
        }
        if(accountRoute[2]==='invitations'){
          const actor=session(req);accounts.authorizeAdministration(actor,id);
          if(req.method==='GET')return send(res,200,{invitations:auth.listInvitations(actor,{targetWorkspaceId:id}),emailConfigured:email.status().configured});
          if(req.method==='POST'&&accountRoute[3]){await body(req);return send(res,200,{invitation:auth.revokeInvitation(session(req),accountRoute[3],{targetWorkspaceId:id})});}
          if(req.method==='POST'){
            const input=await body(req),{sendEmail=false,...access}=input;
            if(typeof sendEmail!=='boolean'||access.role&&access.role!=='reseller'||access.tenantIds?.length||access.permissions!==undefined||access.scopeRules!==undefined)fail(400,'Convide somente o administrador desta conta, com acesso ao próprio painel.');
            if(sendEmail&&(!access.email||!email.status().configured))fail(409,'Informe um e-mail e ative o MepMail, ou use um convite por link.');
            const result=await auth.createInvitation(session(req),{...access,role:'reseller',tenantIds:[]},{targetWorkspaceId:id});
            let job=null;
            if(sendEmail){const preview=auth.previewInvitation(result.token);job=await email.enqueueInvitation({invitationId:result.invitation.id,email:preview.email,name:preview.name||'',token:result.token,workspaceName:preview.workspace.name,expiresAt:preview.expiresAt});email.flush().catch(()=>{});}
            return send(res,201,{invitation:result.invitation,inviteUrl:`${publicOrigin||`http://${req.headers.host}`}/accept-invite#token=${encodeURIComponent(result.token)}`,email:{queued:Boolean(job),configured:email.status().configured}});
          }
        }
      }
      if(path==='/api/auth/google/link'&&req.method==='POST'){session(req);const input=await body(req),token=/(?:^|;\s*)mep_google=([^;]+)/.exec(req.headers.cookie||'')?.[1],profile=await google.verify(input.credential,token);return send(res,200,{user:auth.linkGoogle(session(req),profile)});}
      if(path==='/api/auth/email/resend'&&req.method==='POST'){const actor=session(req),now=Date.now();if((emailLimits.get(actor.userId)||0)>now)fail(429,'Aguarde um minuto antes de pedir outro e-mail.');emailLimits.set(actor.userId,now+60000);for(const [id,until]of emailLimits)if(until<now)emailLimits.delete(id);await verificationEmail(actor);return send(res,200,{queued:true,configured:email.status().configured});}
      if(path==='/api/auth/verify-email'&&req.method==='POST'){const input=await body(req);auth.consumeEmailChallenge(input.token);return send(res,200,{verified:true});}
      if(path==='/api/auth/logout'&&req.method==='POST'){
        auth.logout(/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1]);res.setHeader('Set-Cookie',`mep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${publicRequest?'; Secure':''}`);return send(res,200,{ok:true});
      }
      if(path==='/api/integrations'){
        const actor=session(req);if(!platformOwner(actor))fail(403,'Integrações da plataforma são reservadas ao proprietário.');
        if(req.method==='GET'){const settings=await integrations();if(!platformOwner(session(req)))fail(403,'Seu acesso à plataforma mudou.');return send(res,200,{googleClientId:google.clientId,email:email.status(),google:{enabled:Boolean(google.clientId)},commandCode:{configured:Boolean(settings.commandCodeApiKey),model:'deepseek/deepseek-v4.1-flash'}});}
        if(req.method==='POST'){
          const input=await body(req),vault=await agentSecrets();if(!platformOwner(session(req)))fail(403,'Seu acesso à plataforma mudou.');
          if(Object.hasOwn(input,'commandCodeApiKey')&&typeof input.commandCodeApiKey!=='string'||Object.hasOwn(input,'disableCommandCode')&&typeof input.disableCommandCode!=='boolean')fail(400,'Informe uma chave de texto e a opção de desativação válida.');
          const saved=vault.get('platform-services')||{},settings={...saved,googleClientId:input.googleClientId??saved.googleClientId??'',emailApiKey:input.disableEmail?'':input.emailApiKey||saved.emailApiKey||'',emailFrom:input.emailFrom??saved.emailFrom??'',commandCodeApiKey:input.disableCommandCode?'':input.commandCodeApiKey||saved.commandCodeApiKey||''};
          if(settings.commandCodeApiKey&&(typeof settings.commandCodeApiKey!=='string'||! /^[\x21-\x7e]{16,4096}$/.test(settings.commandCodeApiKey)))fail(400,'Informe uma chave válida da API CommandCode.');
          const emailSettings={apiKey:settings.emailApiKey,from:settings.emailFrom,publicOrigin:publicOrigin||'http://127.0.0.1:4318'};
          google.validate(settings.googleClientId);email.validateConfiguration(emailSettings);vault.set('platform-services',settings);google.configure(settings.googleClientId);email.configure(emailSettings);
          email.flush().catch(()=>{});return send(res,200,{googleEnabled:Boolean(google.clientId),email:email.status(),commandCode:{configured:Boolean(settings.commandCodeApiKey),model:'deepseek/deepseek-v4.1-flash'}});
        }
      }
      if(path==='/api/users/invitations'){
        session(req);
        if(req.method==='GET')return send(res,200,{invitations:auth.listInvitations(session(req)),emailConfigured:email.status().configured});
        if(req.method==='POST'){
          const input=await body(req),{sendEmail=false,...access}=input;
          if(typeof sendEmail!=='boolean')fail(400,'Escolha se deseja enviar o convite por e-mail.');
          if(sendEmail&&!access.email)fail(400,'Informe o e-mail para enviar este convite.');
          if(sendEmail&&!email.status().configured)fail(409,'Ative o MepMail em Integrações ou crie um convite por link.');
          await invitationKeyLoader();const actor=session(req),result=await auth.createInvitation(actor,access);
          let job=null;
          if(sendEmail){const preview=auth.previewInvitation(result.token);job=await email.enqueueInvitation({invitationId:result.invitation.id,email:preview.email,name:preview.name||'',token:result.token,workspaceName:preview.workspace.name,expiresAt:preview.expiresAt});email.flush().catch(()=>{});}
          return send(res,201,{invitation:result.invitation,inviteUrl:`${publicOrigin||`http://${req.headers.host}`}/accept-invite#token=${encodeURIComponent(result.token)}`,email:{queued:Boolean(job),configured:email.status().configured,...(job?{state:job.state}:{})}});
        }
      }
      const revokeInvitation=/^\/api\/users\/invitations\/([^/]+)\/revoke$/.exec(path);
      if(revokeInvitation&&req.method==='POST'){session(req);await body(req);return send(res,200,{invitation:auth.revokeInvitation(session(req),revokeInvitation[1])});}
      if(path==='/api/users'){
        const actor=session(req);
        if(req.method==='GET')return send(res,200,{users:auth.listUsers(actor)});
        if(req.method==='POST'){const input=await body(req),current=session(req);store.admin(current);for(const tenantId of input.tenantIds||[])store.tenant(current,tenantId);return send(res,201,await auth.createUser(current,input));}
      }
      const disableUser=/^\/api\/users\/([^/]+)\/disable$/.exec(path);
      if(disableUser&&req.method==='POST'){const actor=session(req),result=auth.disableUser(actor,disableUser[1]);releaseAssignments(actor,disableUser[1]);return send(res,200,result);}
      const editUser=/^\/api\/users\/([^/]+)(?:\/(reactivate))?$/.exec(path);
      if(editUser&&req.method==='PATCH'&&!editUser[2]){
        session(req);const input=await body(req),actor=session(req);
        const accessStatement=store.db.prepare('SELECT role,tenant_ids,permissions,scope_rules FROM auth_users WHERE id=?');
        const previous=accessStatement.get(editUser[1]);
        const result=auth.updateUser(actor,editUser[1],input);
        const updated=accessStatement.get(editUser[1]);
        const accessSnapshot=row=>JSON.stringify({...row,tenant_ids:JSON.parse(row.tenant_ids).sort()});
        const accessChanged=accessSnapshot(previous)!==accessSnapshot(updated);
        const revoked=previous?.role==='operator'?JSON.parse(previous.tenant_ids).filter(id=>!result.tenantIds.includes(id)):[];
        const chatScope=previous?.role!==result.role?{}:revoked.length?{tenantIds:revoked}:false;
        if(accessChanged)releaseAssignments(actor,editUser[1],true,chatScope);
        return send(res,200,result);
      }
      if(editUser&&req.method==='POST'&&editUser[2])return send(res,200,auth.reactivateUser(session(req),editUser[1]));
      if(path==='/api/backups'&&req.method==='POST'){
        const actor=session(req);store.admin(actor);
        if(!platformOwner(actor))fail(403,'Backup global reservado ao proprietário da plataforma.');
        const {createLocalBackup}=await import('./backup.js');
        const result=await createLocalBackup(store.db);return send(res,201,{id:result.id,createdAt:result.createdAt,verification:result.verification});
      }
      if (allowDemo && path === '/api/demo-session' && req.method === 'POST') {
        const input = await body(req), role = choice(input.role, ['reseller', 'operator']);
        const token = randomUUID();
        sessions.set(token, { role, name: role === 'reseller' ? 'Revenda demo' : 'Atendente demo', resellerId: 'mep-demo', tenantId: 'playtech-demo', expires: Date.now() + 8 * 3600000 });
        res.setHeader('Set-Cookie', `mep_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(res, 200, { role });
      }
      if (path === '/api/bootstrap' && req.method === 'GET') {
        const actor = session(req);
        const accountOnboarding = actor.role === 'reseller' && !actor.supportGrantId ? (() => {
          const lifecycle = accounts.lifecycle.describe(accounts.accountRow(actor.resellerId));
          return { lifecycle: { state: lifecycle.state, trialStartsAt: lifecycle.trialStartsAt, trialEndsAt: lifecycle.trialEndsAt,
            trialExpiresAt: lifecycle.trialExpiresAt || null, trialExpired: lifecycle.trialExpired, daysRemaining: lifecycle.daysRemaining ?? null,
            serverTime: lifecycle.serverTime || accounts.timestamp() }, publicTrialEnabled, documentRegistered: signupTrials.registered(actor.resellerId) };
        })() : null;
        // One fresh synchronous snapshot supplies metadata, counts and the existing permission checker.
        // Select IDs first; metadata comes from the private header, counts from history-free summaries.
        const tenants=withTenantMemo(()=>store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(actor.resellerId)
          .filter(({id})=>actor.role!=='operator'||(actor.tenantIds||[actor.tenantId]).includes(id))
          .map(({id})=>{
            const tenant=store.readonlyTenantHeader(actor,id,{conversationSummaries:true});
            tenantMemo.set(actor.resellerId+'\u0000'+id,tenant);
            const readable=tenantPermission(actor,'inbox.read',id);
            const parentVisible=actor.role!=='operator'||(actor.tenantIds||[actor.tenantId]).includes(tenant.parentTenantId);
            return {id,name:tenant.name,segment:tenant.segment,parentTenantId:parentVisible?tenant.parentTenantId||null:null,
              identityVersion:tenant.identityVersion||1,plan:tenant.plan,brand:tenant.brand,demo:Boolean(tenant.demo),
              channels:tenant.channels.filter(c=>readable({tenantId:id,channelId:c.id,aggregate:true})).length,
              conversations:tenant.conversations.filter(c=>c.status!=='closed'&&readable(contextFor(id,c,tenant))).length};
          }));
        return send(res, 200, { version: appVersion, accountOnboarding, session: { role: actor.role, name: actor.name,userId:actor.userId,resellerId:actor.resellerId,avatar:actor.avatar??null,locale:actor.locale||'pt-BR',presence:actor.presence||'available',permissions:actor.permissions??null,scopeRules:actor.scopeRules??null,platformOwner:platformOwner(actor),supportGrantId:actor.supportGrantId||null,supportExpiresAt:actor.supportExpiresAt||null,supportReason:actor.supportReason||null }, workspaces:actor.userId?workspaceList(req,actor):[], reseller: {...store.reseller(actor),id:actor.resellerId}, tenants,publicOrigin:boundDomain?`https://${hostname}`:publicOrigin||`http://${req.headers.host}`,canonicalPublicOrigin:publicOrigin||`http://${req.headers.host}`, sandbox: !publicURL,authentication:authenticationMode(),storage:bridge.status(), channelKinds: CHANNEL_KINDS, features: [...API_FEATURES], capabilities: { whatsappQr: true, whatsappGroups: true, telegramBot: true, telegramGroups: true,telegramAccount:true,telegramAccountAi:false,flows:true,agentCopilot:true,contacts:true,departments:true,teamPermissions:true,delegatedSupport:true,serviceAgents:true,billing:true,commercialAccounts:true,unitHierarchy:true,platformAdministrativeAccess:true } });
      }
      if(path==='/api/support/available'&&req.method==='GET')return send(res,200,{grants:support.available(baseSession(req)).filter(grant=>!boundDomain||grant.workspaceId===boundDomain.workspaceId)});
      if(path==='/api/support/directory'&&req.method==='GET')return send(res,200,support.directory(session(req),{q:url.searchParams.get('q')||'',limit:20}));
      if(path==='/api/support/grants'){
        if(req.method==='GET')return send(res,200,{grants:support.list(session(req)).grants});
        if(req.method==='POST'){session(req);const input=await body(req);return send(res,201,{grant:support.create(session(req),input)});}
      }
      const supportRoute=/^\/api\/support\/grants\/([A-Za-z0-9_-]{1,120})(?:\/(revoke|audit))?$/.exec(path);
      if(supportRoute){const [,grantId,action]=supportRoute;
        if(req.method==='GET'&&!action){const grant=support.preview(baseSession(req),grantId);if(boundDomain&&grant.workspaceId!==boundDomain.workspaceId)fail(403,'O suporte pertence a outro painel.');return send(res,200,{grant});}
        if(req.method==='GET'&&action==='audit')return send(res,200,support.audit(session(req),grantId));
        if(req.method==='POST'&&action==='revoke'){session(req);const input=await body(req);return send(res,200,{grant:support.revoke(session(req),grantId,input)});}
      }
      // stripe-billing hook: self-serve subscription (owner of a direct business workspace only).
      if(path==='/api/billing/subscription'&&req.method==='GET')return send(res,200,stripeBilling.overview(session(req),url.searchParams.get('workspaceId')));
      if((path==='/api/billing/checkout'||path==='/api/billing/portal'||path==='/api/billing/change')&&req.method==='POST'){session(req);limitAccess(req,'stripe-billing',30);const input=await body(req);return send(res,200,path==='/api/billing/checkout'?await stripeBilling.checkout(session(req),input):path==='/api/billing/change'?await stripeBilling.change(session(req),input):await stripeBilling.portal(session(req),input));}
      if(path==='/api/billing'&&req.method==='GET')return send(res,200,billing.overview(session(req),Object.fromEntries(url.searchParams)));
      if(path==='/api/billing/contracts'&&req.method==='POST'){session(req);const input=await body(req);return send(res,201,billing.createContract(session(req),input));}
      const billingContract=/^\/api\/billing\/contracts\/([A-Za-z0-9_-]{1,120})(?:\/(usage|invoices))?$/.exec(path);
      if(billingContract){const [,contractId,action]=billingContract;
        if(req.method==='GET'&&!action)return send(res,200,billing.detail(session(req),contractId));
        if(['POST','PATCH'].includes(req.method)){session(req);const input=await body(req),actor=session(req);
          if(req.method==='PATCH'&&!action)return send(res,200,billing.updateContract(actor,contractId,input));
          if(req.method==='POST'&&action==='usage')return send(res,201,billing.recordUsage(actor,contractId,input));
          if(req.method==='POST'&&action==='invoices')return send(res,201,billing.createInvoice(actor,contractId,input));
        }
      }
      const billingInvoice=/^\/api\/billing\/invoices\/([A-Za-z0-9_-]{1,120})(?:\/(events))?$/.exec(path);
      if(billingInvoice){const [,invoiceId,action]=billingInvoice;
        if(req.method==='GET'&&!action)return send(res,200,billing.invoiceDetail(session(req),invoiceId,Object.fromEntries(url.searchParams)));
        if(req.method==='POST'&&action==='events'){session(req);const input=await body(req);return send(res,200,billing.changeInvoice(session(req),invoiceId,input));}
      }
      if (path === '/api/tenants' && req.method === 'POST'){session(req);const input=await body(req),actor=session(req);if(actor.userId||!allowDemo)auth.admin(actor);return send(res,201,store.createTenant(actor,input));}
      if (path === '/api/tenants/demo' && req.method === 'POST'){session(req);const input=await body(req),actor=session(req);if(Object.keys(input).length)fail(400,'A empresa de demonstração não recebe dados.');if(actor.userId||!allowDemo)auth.admin(actor);return send(res,201,store.createDemoTenant(actor));}
      if (path === '/api/inbox' && req.method === 'GET') return send(res, 200, inbox.list(session(req), url.searchParams));
      if (path === '/api/me/attention' && req.method === 'GET') return send(res, 200, attentionFor(session(req), url.searchParams));
      if (path === '/api/events' && req.method === 'GET') {
        for(const key of new Set(url.searchParams.keys()))if(!['workspace','supportGrant','cursor'].includes(key)||url.searchParams.getAll(key).length>1)fail(400,'Informe somente workspace, supportGrant e cursor, uma vez cada.');
        const principal=streamPrincipal(req,url,hostname),lastEventId=req.headers['last-event-id'];
        const cursor=typeof lastEventId==='string'&&lastEventId?lastEventId:url.searchParams.get('cursor');
        if(cursor!==null&&(cursor.length>64||/[\x00-\x1f\x7f]/.test(cursor)))fail(400,'Cursor de eventos inválido.');
        realtime.open(res,principal,{cursor});return;
      }
      if (path === '/api/reseller/brand' && req.method === 'PATCH') {
        session(req);const input=await body(req),actor=session(req);
        if(actor.userId||!allowDemo)auth.admin(actor);
        return send(res, 200, { reseller: store.setResellerBrand(actor, brand(input)), domainProvisioned: false });
      }
      const tenantRoute = /^\/api\/tenants\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (tenantRoute) {
        let actor = session(req);const id = tenantRoute[1], action = tenantRoute[2] || '',identity={userId:actor.userId,resellerId:actor.resellerId,supportGrantId:actor.supportGrantId||null};
        if(action==='identity'&&req.method==='PATCH'){const input=await body(req),current=session(req);auth.admin(current);return send(res,200,store.updateTenantIdentity(current,id,input));}
        if(!action&&req.method==='DELETE'){const current=session(req);if(current.userId||!allowDemo)auth.admin(current);return send(res,200,store.removeDemoTenant(current,id));}
        const demoRefused=demoRouteRefusal(action,req.method);
        if(demoRefused&&store.isDemoTenant(actor.resellerId,id))throw demoRefusal(demoRefused);
        const reauthorize=()=>{const latest={...session(req)};if(latest.userId!==identity.userId||latest.resellerId!==identity.resellerId||(latest.supportGrantId||null)!==identity.supportGrantId)fail(403,'A sessão mudou.');for(const key of Object.keys(actor))delete actor[key];Object.assign(actor,latest);};
        const bodyForTenant=async(maxBytes)=>{const input=await body(req,maxBytes);reauthorize();return input;};
        const contactMutation=mutate=>{
          const before=new Map(store.tenant(actor,id).conversations.map(conversation=>[conversation.id,conversation.version]));
          const result=mutate(),links=result.links||[{conversationId:result.conversationId,version:result.version}];
          for(const link of links)if(link.version!==before.get(link.conversationId))runtime.invalidateConversation(actor,id,link.conversationId);
          return result;
        };
        if(action==='service-principals'){
          if(req.method==='GET'){
            // Manager authorization happens in list before reading adapter metadata. This
            // projection is the same descriptive contract as elozi_me, never send authority.
            const listed=servicePrincipals.list(actor,id);
            const metadata=store.serviceTenant(actor.resellerId,id,{conversationId:null});
            const responsePolicies=Object.fromEntries(listed.principals.map(principal=>[
              principal.id,serviceResponsePolicy(principal,metadata.agents?.find(agent=>agent.id===principal.agentId))
            ]));
            return send(res,200,{...listed,responsePolicies,principals:listed.principals.map(principal=>({...principal,webhook:serviceWebhooks.dto(serviceWebhooks.row(principal.id))}))});
          }
          if(req.method==='POST')return send(res,201,servicePrincipals.create(actor,id,await bodyForTenant()));
        }
        const principalRoute=/^service-principals\/([A-Za-z0-9_-]{1,120})(?:\/(rotate|revoke|receipts|notification-policy|webhook|webhook\/rotate))?$/.exec(action);
        if(principalRoute){const [,principalId,operation]=principalRoute;
          if(operation==='webhook'||operation==='webhook/rotate'){
            auth.admin(actor);store.admin(actor);if(!actor.userId||actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa configura o webhook.');
            res.setHeader('Cache-Control','no-store');
            if(operation==='webhook'&&req.method==='GET')return send(res,200,serviceWebhooks.read(actor,id,principalId));
            if(operation==='webhook'&&req.method==='PUT')return send(res,200,await serviceWebhooks.configure(actor,id,principalId,await bodyForTenant(2048)));
            if(operation==='webhook/rotate'&&req.method==='POST')return send(res,200,await serviceWebhooks.rotate(actor,id,principalId,await bodyForTenant(1024)));
            fail(405,'Use GET/PUT no webhook ou POST na troca do segredo.');
          }
          if(req.method==='PATCH'&&!operation)return send(res,200,{principal:servicePrincipals.update(actor,id,principalId,await bodyForTenant())});
          if(req.method==='GET'&&operation==='receipts')return send(res,200,servicePrincipals.receipts(actor,id,principalId));
          if(req.method==='PUT'&&operation==='notification-policy')return send(res,200,serviceNotifications.configure(actor,id,principalId,await bodyForTenant()));
          if(req.method==='POST'&&operation==='rotate')return send(res,200,servicePrincipals.rotate(actor,id,principalId,await bodyForTenant()));
          if(req.method==='POST'&&operation==='revoke')return send(res,200,{principal:servicePrincipals.revoke(actor,id,principalId,await bodyForTenant())});
        }
        const handoffRoute=/^conversations\/([A-Za-z0-9_-]{1,120})\/service-handoffs(?:\/([A-Za-z0-9_-]{1,120}))?$/.exec(action);
        if(handoffRoute){const [,cid,requestId]=handoffRoute;
          if(req.method==='GET'&&!requestId){conversationFor(actor,id,cid);return send(res,200,serviceApi.handoffs(actor,id,cid));}
          if(req.method==='POST'&&requestId){const input=await bodyForTenant();const c=conversationFor(actor,id,cid,'inbox.reply');requireResponsible(actor,id,c);return send(res,200,serviceApi.decide(actor,id,cid,requestId,input));}
        }
        if(action==='team-chat/directory'&&req.method==='GET')return send(res,200,teamChat.directory(actor,id));
        if(action==='team-chat/rooms'){
          if(req.method==='GET')return send(res,200,teamChat.listRooms(actor,id));
          if(req.method==='POST')return send(res,201,teamChat.createRoom(actor,id,await bodyForTenant()));
        }
        const teamRoomRoute=/^team-chat\/rooms\/([^/]+)(?:\/(messages|members|read))?$/.exec(action);
        if(teamRoomRoute){
          const [,roomId,operation]=teamRoomRoute;
          const numberParam=name=>{const value=url.searchParams.get(name);if(value===null)return undefined;if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))fail(400,'Paginação inválida.');return Number(value);};
          if(req.method==='GET'&&!operation)return send(res,200,teamChat.getRoom(actor,id,roomId));
          if(req.method==='GET'&&operation==='messages')return send(res,200,teamChat.messages(actor,id,roomId,{before:numberParam('before'),after:numberParam('after'),limit:numberParam('limit')}));
          if(req.method==='POST'){
            const input=await bodyForTenant();
            if(operation==='messages'){const result=teamChat.send(actor,id,roomId,input);publishPointer({type:'teamchat.message',tenantId:id,roomId});return send(res,200,result);}
            if(operation==='members'){const result=teamChat.updateMembers(actor,id,roomId,input);publishPointer({type:'teamchat.message',tenantId:id,roomId});return send(res,200,result);}
            if(operation==='read')return send(res,200,teamChat.markRead(actor,id,roomId,input));
          }
          fail(404,'Recurso de chat interno não encontrado.');
        }
        if(action==='groups'&&req.method==='GET')return send(res,200,groups.directory(actor,id));
        // Older messages of a direct WhatsApp QR conversation, on demand: the same importer, jobs and limits as groups.
        const directHistoryRoute=/^conversations\/([^/]+)\/history-import$/.exec(action);
        if(directHistoryRoute){
          const cid=directHistoryRoute[1],identity=[actor.userId,actor.resellerId,actor.supportGrantId||null];
          const resolveDirect=()=>{const current=session(req);if(JSON.stringify(identity)!==JSON.stringify([current.userId,current.resellerId,current.supportGrantId||null]))fail(403,'O acesso a esta conversa mudou.');authorizeHumanDirect(current,id,conversationFor(current,id,cid));return current;};
          const params={};for(const [key,value]of url.searchParams){if(req.method!=='GET'||key!=='commandId'||Object.hasOwn(params,key))fail(400,'Informe somente o comando da importação.');params[key]=value;}
          const current=resolveDirect();
          if(req.method==='GET')return send(res,200,groupHistoryImporter.status(current,id,cid,params,{reauthorize:resolveDirect}));
          if(req.method==='POST'){
            const input=await bodyForTenant(),jobActor=resolveDirect();
            const token=/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1],workspaceId=jobActor.resellerId;
            const reauthorizeJob=()=>{
              const latest=auth.workspaceActor(auth.authenticate(token),workspaceId);
              if(JSON.stringify(identity)!==JSON.stringify([latest.userId,latest.resellerId,latest.supportGrantId||null]))fail(403,'O acesso a esta conversa mudou.');
              for(const key of Object.keys(jobActor))delete jobActor[key];Object.assign(jobActor,latest);
              auth.admin(jobActor);store.admin(jobActor);authorizeHumanDirect(jobActor,id,conversationFor(jobActor,id,cid));return true;
            };
            return send(res,202,await groupHistoryImporter.start(jobActor,id,cid,input,{reauthorize:reauthorizeJob}));
          }
          fail(404,'Recurso de importação não encontrado.');
        }
        const groupRoute=/^conversations\/([^/]+)\/(group-context|group-history|group-summary|group-history-import)$/.exec(action);
        if(groupRoute){
          const [,cid,operation]=groupRoute,identity=[actor.userId,actor.resellerId,actor.supportGrantId||null];
          const fresh=()=>{const current=session(req);if(JSON.stringify(identity)!==JSON.stringify([current.userId,current.resellerId,current.supportGrantId||null]))fail(403,'O acesso a este grupo mudou.');return current;};
          const resolveGroup=(summary=false)=>{const current=fresh(),conversation=conversationFor(current,id,cid);authorizeHumanGroup(current,id,conversation,summary);return {current,conversation};};
          if(operation==='group-history-import'){
            const params={};for(const [key,value]of url.searchParams){if(req.method!=='GET'||key!=='commandId'||Object.hasOwn(params,key))fail(400,'Informe somente o comando da importação.');params[key]=value;}
            const current=resolveGroup().current;
            if(req.method==='GET')return send(res,200,groupHistoryImporter.status(current,id,cid,params,{reauthorize:()=>resolveGroup().current}));
            if(req.method==='POST'){
              const input=await bodyForTenant(),jobActor=resolveGroup().current;
              // Keep only immutable session coordinates, not the HTTP request/body, for late history events.
              const token=/(?:^|;\s*)mep_session=([^;]+)/.exec(req.headers.cookie||'')?.[1],workspaceId=jobActor.resellerId;
              const reauthorizeJob=()=>{
                const latest=auth.workspaceActor(auth.authenticate(token),workspaceId);
                if(JSON.stringify(identity)!==JSON.stringify([latest.userId,latest.resellerId,latest.supportGrantId||null]))fail(403,'O acesso a este grupo mudou.');
                for(const key of Object.keys(jobActor))delete jobActor[key];Object.assign(jobActor,latest);
                auth.admin(jobActor);store.admin(jobActor);authorizeHumanGroup(jobActor,id,conversationFor(jobActor,id,cid));return true;
              };
              return send(res,202,await groupHistoryImporter.start(jobActor,id,cid,input,{reauthorize:reauthorizeJob}));
            }
            fail(404,'Recurso de importação não encontrado.');
          }
          if(operation==='group-context'&&req.method==='GET'){
            const result=await groups.context(actor,id,cid,{reauthorize:()=>resolveGroup().current});
            const {current,conversation}=resolveGroup();
            return send(res,200,{...result,canSummarize:can(current,'inbox.reply',contextFor(id,conversation))});
          }
          if(operation==='group-history'&&req.method==='GET'){
            const input={};for(const [key,value]of url.searchParams){if(!['after','before','limit','cursor'].includes(key)||Object.hasOwn(input,key))fail(400,'Informe somente os filtros do histórico.');if(key==='limit'){if(!/^[1-9]\d{0,2}$/.test(value))fail(400,'Limite do histórico inválido.');input[key]=Number(value);}else input[key]=value;}
            return send(res,200,groupHistory(resolveGroup().conversation,input,{tenantId:id}));
          }
          if(operation==='group-summary'&&req.method==='POST'){
            const input=await bodyForTenant();await agentSecrets();const current=resolveGroup(true).current;
            return send(res,200,await groupSummaries.summarize(current,id,cid,input,{reauthorize:()=>resolveGroup(true).current}));
          }
          fail(404,'Recurso de grupo não encontrado.');
        }
        const avatarRoute=/^(conversations|contacts|channels)\/([^/]+)\/avatar$/.exec(action);
        if(avatarRoute&&req.method==='GET'){
          const kind=avatarRoute[1],resourceId=avatarRoute[2];
          const resolveAvatar=current=>{
            const tenant=store.tenant(current,id);
            if(kind==='conversations'){const c=conversationFor(current,id,resourceId);return {conversationId:c.id,channelId:c.channelId};}
            if(kind==='contacts'){
              const contact=contacts.get(current,id,resourceId);
              const readable=tenantPermission(current,'contacts.read',id),c=tenant.conversations.find(item=>item.contactId===contact.id&&contact.identities.some(identity=>identity.channelId===item.channelId)&&readable(contextFor(id,item,tenant)));
              return c?{conversationId:c.id,channelId:c.channelId}:{};
            }
            const channel=tenant.channels.find(item=>item.id===resourceId);if(!channel)fail(404,'Canal não encontrado.');
            const scope={tenantId:id,channelId:channel.id,aggregate:true};if(!can(current,'inbox.read',scope)&&!can(current,'contacts.read',scope))fail(403,'Seu acesso não permite ver esta foto.');
            return {channelId:channel.id};
          };
          const before=resolveAvatar(actor),image=before.conversationId?await avatars.conversation(actor,id,before.conversationId):before.channelId?await avatars.channel(actor,id,before.channelId):null;
          const after=resolveAvatar(session(req));
          if(after.conversationId!==before.conversationId||after.channelId!==before.channelId)fail(409,'O contexto da foto mudou. Atualize a página.');
          const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
          if(!image){res.writeHead(204,headers);return res.end();}
          res.writeHead(200,{...headers,'Content-Type':image.mime,'Content-Length':image.bytes.length});return res.end(image.bytes);
        }
        if(action==='automation'){if(req.method==='GET')return send(res,200,automation.get(actor,id));if(req.method==='PUT')return send(res,200,automation.configure(actor,id,await bodyForTenant()));}
        if(action==='sla'&&req.method==='GET')return send(res,200,automation.sla(actor,id));
        const attachmentRoute=/^conversations\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(action);
        if(attachmentRoute){
          const convId=attachmentRoute[1],attachmentId=attachmentRoute[2];
          if(req.method==='POST'&&!attachmentId){
            const version=Number(req.headers['x-elozi-conversation-version']);if(!Number.isSafeInteger(version)||version<1)fail(400,'Informe a versão da conversa.');
            let c=conversationFor(actor,id,convId,'inbox.reply',version);operations.canReply(actor,id,c);
            const channel=store.tenant(actor,id).channels.find(item=>item.id===c.channelId);
            const capabilities=capabilitiesForConversation(actor,id,c,channel);
            if(!capabilities.uploadKinds.length)fail(capabilities.telegramSendPermissions?409:400,capabilities.telegramSendPermissions?'O bot não tem permissão para enviar arquivos neste grupo.':'Esta conexão ainda não permite enviar arquivos.');
            let name;try{name=decodeURIComponent(req.headers['x-elozi-filename']||'');}catch{fail(400,'Nome do arquivo inválido.');}
            const voice=req.headers['x-elozi-voice'];
            if(voice!==undefined&&voice!=='1')fail(400,'Tipo de gravação inválido.');
            const mime=req.headers['content-type']?.split(';')[0]||'application/octet-stream';
            const declaredLength=Number(req.headers['content-length']),hasDeclaredLength=Number.isSafeInteger(declaredLength)&&declaredLength>0;
            validateAttachmentSelection({type:mime,size:hasDeclaredLength?declaredLength:1},capabilities,{voice:voice==='1',sizeUnknown:!hasDeclaredLength});
            const uploadKey=actor.userId||actor.resellerId;if(uploads.size>=4||uploads.has(uploadKey)){req.resume();fail(429,'Aguarde o upload atual e tente novamente.');}uploads.add(uploadKey);
            const authorize=()=>{const latest=session(req),current=conversationFor(latest,id,convId,'inbox.reply',version);operations.canReply(latest,id,current);const liveChannel=store.tenant(latest,id).channels.find(item=>item.id===current.channelId);if(current.channelId!==channel.id||liveChannel?.transport!==channel.transport)fail(409,'A conexão deste atendimento mudou.');if(liveChannel.transport==='telegram-bot'){telegram.assertGroupAllowed(latest,id,current.channelId,current.remoteChatId);validateAttachmentSelection({type:normalized?.mime||mime,size:normalized?.bytes.length||(bodyComplete&&bytes?.length)||(hasDeclaredLength?declaredLength:1)},capabilitiesForConversation(latest,id,current,liveChannel),{voice:voice==='1',sizeUnknown:!normalized&&!bodyComplete&&!hasDeclaredLength});}if(liveChannel.transport==='telegram-user'&&!telegramUser.replyPolicy(latest,id,convId).allowed)fail(409,'Esta conversa não está selecionada ou não permite envio.');if(liveChannel.transport==='elozi-webchat')webchat.assertReplySession(latest,id,convId,{channelId:channel.id,version});if(['meta-instagram','meta-messenger'].includes(liveChannel.transport)&&!meta.replyWindow(latest,id,convId).open)fail(409,'A janela de resposta desta conexão expirou.');};
            const context={tenantId:id,conversationId:convId,channelId:c.channelId,reauthorize:authorize};let uploaded,bytes,normalized,bodyComplete=false;
            try{
              authorize();
              bytes=await binaryBody(req,{reauthorize:authorize});
              bodyComplete=true;
              authorize();
              normalized=voice==='1'?await voiceNormalizer(bytes,{mime}):null;
              authorize();
              validateAttachmentSelection({type:normalized?.mime||mime,size:normalized?.bytes.length||bytes.length},capabilitiesForConversation(session(req),id,c,channel),{voice:voice==='1'});
              uploaded=await media.upload(context,normalized||{bytes,name,mime});
              authorize();return send(res,201,uploaded);
            }
            catch(error){if(uploaded?.id)await media.discard(uploaded.id,context).catch(()=>{});throw error;}
            finally{bytes?.fill(0);normalized?.bytes?.fill(0);uploads.delete(uploadKey);}
          }
          if(req.method==='GET'&&attachmentId){
            const c=conversationFor(actor,id,convId),context={tenantId:id,conversationId:convId,channelId:c.channelId,reauthorize:()=>conversationFor(session(req),id,convId)};
            if(!c.messages.some(message=>message.attachments?.some(item=>item.id===attachmentId)))fail(404,'Anexo não encontrado nesta conversa.');
            const {metadata,bytes}=await media.read(attachmentId,context);
            conversationFor(session(req),id,convId);
            const disposition=metadata.preview?'inline':'attachment';
            res.writeHead(200,{'Content-Type':metadata.mime,'Content-Length':bytes.length,'Content-Disposition':`${disposition}; filename="arquivo"; filename*=UTF-8''${encodeURIComponent(metadata.name)}`});res.once('close',()=>bytes.fill(0));return res.end(bytes);
          }
        }
        if (req.method === 'GET' && !action) {
          const summary=url.searchParams.getAll('summary');
          if(summary.length>1||summary.length&&!['1','0','true','false'].includes(summary[0]))fail(400,'Use summary=1 para o resumo da empresa.');
          const tenant=store.tenant(actor,id);return send(res, 200, { ...filteredTenant(actor,tenant,{summary:['1','true'].includes(summary[0])}), audit: actor.role==='reseller'?store.audit(actor, id):[] });
        }
        const followUpRoute=/^conversations\/([^/]{1,200})\/follow-ups(?:\/([^/]{1,200}))?$/.exec(action);
        if(followUpRoute){
          const [,conversationId,itemId]=followUpRoute;res.setHeader('Cache-Control','no-store');
          if(req.method==='GET'&&!itemId){
            if(url.searchParams.size)fail(400,'A consulta de acompanhamentos não aceita filtros extras.');
            const current=session(req),conversation=conversationFor(current,id,conversationId);
            return send(res,200,{...followUps.list(current,id,conversationId),canWrite:can(current,'inbox.reply',contextFor(id,conversation))});
          }
          if(req.method==='POST'&&!itemId){const input=await bodyForTenant();return send(res,201,followUps.create(session(req),id,conversationId,input));}
          if(req.method==='PATCH'&&itemId){const input=await bodyForTenant();return send(res,200,followUps.update(session(req),id,conversationId,itemId,input));}
          fail(405,'Método indisponível para acompanhamentos.');
        }
        const conversationWindow=/^conversations\/([^/]{1,200})$/.exec(action);
        if(conversationWindow&&req.method==='GET')return send(res,200,conversationPage(actor,id,conversationWindow[1],url.searchParams));
        if(action==='agent-admin-proposals'&&req.method==='GET')return send(res,200,serviceApi.adminProposals.list(session(req),id));
        const proposalDecision=/^agent-admin-proposals\/([^/]+)\/decide$/.exec(action);
        if(proposalDecision&&req.method==='POST'){
          const input=await body(req),current=session(req);auth.admin(current);
          return send(res,200,serviceApi.adminProposals.decide(current,id,proposalDecision[1],input));
        }
        if(action==='support-assistant/catalog'&&req.method==='GET')return send(res,200,centralSupport.catalog(session(req),id));
        const centralRoute=/^channels\/([^/]+)\/support-assistant$/.exec(action);
        if(centralRoute&&req.method==='PATCH'){
          const input=await body(req),current=session(req),authorize=()=>centralSupport.admin(session(req),id);
          authorize();return send(res,200,centralSupport.configure(current,id,centralRoute[1],input,{reauthorize:authorize}));
        }
        if(action==='assignees'&&req.method==='GET'){store.readonlyTenantHeader(actor,id);const cid=url.searchParams.get('conversationId');const c=cid?conversationFor(actor,id,cid):null,departmentId=url.searchParams.get('departmentId')||(c?contextFor(id,c).departmentId:null);requirePermission(actor,'inbox.read',c?{tenantId:id,channelId:c.channelId,departmentId}:{tenantId:id,aggregate:true});return send(res,200,{assignees:c?operations.assignees(actor,id,{channelId:c.channelId,departmentId}):auth.assignees(actor,id,{aggregate:true})});}
        if(action==='departments'){if(req.method==='GET')return send(res,200,{departments:operations.list(actor,id)});if(req.method==='POST')return send(res,201,operations.create(actor,id,await bodyForTenant()));}
        const departmentRoute=/^departments\/([^/]+)$/.exec(action);
        if(departmentRoute&&req.method==='PATCH')return send(res,200,operations.update(actor,id,departmentRoute[1],await bodyForTenant()));
        if(action==='metrics'&&req.method==='GET'){requirePermission(actor,'metrics.read',{tenantId:id,aggregate:true});return send(res,200,operations.metrics(actor,id,{from:url.searchParams.get('from')||undefined,to:url.searchParams.get('to')||undefined}));}
        if(action==='contacts'){if(req.method==='GET'){
          const options={search:url.searchParams.get('search')||'',includeArchived:url.searchParams.get('archived')==='true'},limit=url.searchParams.get('limit');
          // limit (1–200) trims a plain listing, e.g. the 8 suggestions of a picker; the snapshot keeps its whole-agenda revision.
          if(limit!==null&&(url.searchParams.getAll('limit').length>1||url.searchParams.get('snapshot')==='true'||!/^[1-9]\d{0,2}$/.test(limit)||Number(limit)>200))fail(400,'Escolha um limite entre 1 e 200 contatos, sem snapshot.');
          if(url.searchParams.get('snapshot')==='true')return send(res,200,contacts.snapshot(actor,id,options,url.searchParams.get('since')||''));
          const list=contacts.list(actor,id,options);
          return send(res,200,limit===null?{contacts:list}:{contacts:list.slice(0,Number(limit)),hasMore:list.length>Number(limit)});
        }if(req.method==='POST')return send(res,201,contacts.create(actor,id,await bodyForTenant()));}
        if(action==='contacts/import/preview'&&req.method==='POST')return send(res,200,contactImport.preview(actor,id,await bodyForTenant(6*1024*1024)));
        if(action==='contacts/import/apply'&&req.method==='POST')return send(res,200,contactImport.apply(actor,id,await bodyForTenant()));
        if(action==='contacts/sync'&&req.method==='POST'){store.admin(actor);auth.admin(actor);const count=store.mutate(actor,id,'Contatos das conversas vinculados ao CRM',tenant=>{for(const c of tenant.conversations){const channel=tenant.channels.find(channel=>channel.id===c.channelId);if(channel&&['baileys','telegram-bot','telegram-user'].includes(channel.transport))syncConversationContact(tenant,c,channel);}return (tenant.contacts||[]).length;});return send(res,200,{count});}
        const contactRoute=/^contacts\/([^/]+)(?:\/(archive|reactivate|history|open))?$/.exec(action);
        if(contactRoute){const cid=contactRoute[1],op=contactRoute[2];if(req.method==='GET'&&!op)return send(res,200,contacts.get(actor,id,cid));if(req.method==='PATCH'&&!op)return send(res,200,contacts.update(actor,id,cid,await bodyForTenant()));if(req.method==='POST'&&['archive','reactivate'].includes(op))return send(res,200,contacts[op](actor,id,cid,await bodyForTenant()));if(req.method==='GET'&&op==='history')return send(res,200,{conversations:contacts.history(actor,id,cid)});if(req.method==='POST'&&op==='open'){const input=contacts.openInput(actor,id,cid,await bodyForTenant());const c=await gateway.beginConversation(actor,id,{...input,contactId:cid});return send(res,200,safeConversation(c,actor,id));}}
        const association=/^conversations\/([^/]+)\/contact$/.exec(action);
        if(association&&req.method==='POST'){const input=await bodyForTenant();return send(res,200,contactMutation(()=>contacts.associateConversation(actor,id,association[1],input)));}
        const associationPreview=/^conversations\/([^/]+)\/contact-preview$/.exec(action);
        if(associationPreview&&req.method==='GET')return send(res,200,contacts.associationPreview(actor,id,associationPreview[1],url.searchParams.get('contactId')));
        const contactMerge=/^contacts\/([^/]+)\/(merge-preview|merge|merge-undo-preview|merge-undo)$/.exec(action);
        if(contactMerge){
          const contactId=contactMerge[1],operation=contactMerge[2];
          if(req.method==='GET'&&operation==='merge-preview')return send(res,200,contacts.mergePreview(actor,id,contactId,url.searchParams.get('targetId')));
          if(req.method==='GET'&&operation==='merge-undo-preview')return send(res,200,contacts.mergeUndoPreview(actor,id,contactId,url.searchParams.get('mergeId')));
          if(req.method==='POST'&&operation==='merge'){const input=await bodyForTenant();return send(res,200,contactMutation(()=>contacts.merge(actor,id,contactId,input)));}
          if(req.method==='POST'&&operation==='merge-undo'){const input=await bodyForTenant();return send(res,200,contactMutation(()=>contacts.mergeUndo(actor,id,contactId,input)));}
        }
        if(action==='flows'){
          if(req.method==='GET'){requirePermission(actor,'flows.read',{tenantId:id,aggregate:true});return send(res,200,{flows:flows.list(actor,id)});}
          if(req.method==='POST')return send(res,201,flows.create(actor,id,await bodyForTenant()));
        }
        const flowRoute=/^flows\/([^/]+)(?:\/(publish|simulate))?$/.exec(action);
        if(flowRoute){const fid=flowRoute[1];if(req.method==='PUT'&&!flowRoute[2])return send(res,200,flows.save(actor,id,fid,await bodyForTenant()));if(req.method==='POST'&&flowRoute[2])return send(res,200,flows[flowRoute[2]](actor,id,fid,await bodyForTenant()));if(req.method==='DELETE'&&!flowRoute[2])return send(res,200,flows.remove(actor,id,fid,await bodyForTenant()));}
        if(action==='agents/runs'&&req.method==='GET'){
          store.admin(actor);auth.admin(actor);
          for(const key of new Set(url.searchParams.keys()))if(!['agentId','state','from','to','cursor','limit'].includes(key)||url.searchParams.getAll(key).length>1)fail(400,'Informe somente os filtros do histórico, uma vez cada.');
          const limit=url.searchParams.get('limit'),value=key=>url.searchParams.get(key)??undefined;
          if(limit!==null&&!/^[1-9]\d{0,2}$/.test(limit))fail(400,'Escolha um limite entre 1 e 100 execuções.');
          return send(res,200,runtime.history(actor,id,{agentId:value('agentId'),state:value('state'),from:value('from'),to:value('to'),cursor:value('cursor'),limit:limit===null?50:Number(limit)}));
        }
        const previewRoute=/^agents\/([^/]+)\/preview$/.exec(action);
        if(previewRoute&&req.method==='POST'){
          store.admin(actor);auth.admin(actor);const input=await bodyForTenant();await agentSecrets();const current=session(req);store.admin(current);auth.admin(current);
          // Revalidated synchronously before each provider call: same session, still an administrator.
          const authorize=()=>{const latest=session(req);if(latest.userId!==current.userId||latest.resellerId!==current.resellerId)fail(403,'A sessão mudou.');store.admin(latest);auth.admin(latest);return true;};
          return send(res,200,await runtime.preview(current,id,previewRoute[1],input,{authorize}));
        }
        if(action==='knowledge/search-preview'&&req.method==='POST'){
          store.admin(actor);auth.admin(actor);const input=await bodyForTenant(),current=session(req);store.admin(current);auth.admin(current);
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['agentId','query'].includes(key))||typeof input.agentId!=='string'||typeof input.query!=='string'||!input.query.trim()||input.query.length>1300)fail(400,'Informe um agente e uma pergunta com até 1300 caracteres.');
          const tenant=store.tenant(current,id),agent=tenant.agents.find(item=>item.id===input.agentId);if(!agent)fail(404,'Agente não encontrado nesta empresa.');
          const result=knowledge.search(tenant,agent,input.query),references=result.references||[];
          return send(res,200,{state:result.state,matches:references.map(({sourceId,title,excerpt,score})=>({sourceId,title,excerpt,score})),truncated:references.length>=5});
        }
        if(action==='agents/usage'&&req.method==='GET'){
          store.admin(actor);auth.admin(actor);const days=url.searchParams.get('days');
          if(days!==null&&!/^[1-9]\d?$/.test(days))fail(400,'Escolha um período entre 1 e 90 dias.');
          return send(res,200,runtime.usage(actor,id,{days:days===null?30:Number(days)}));
        }
        if(action==='agents/usage/limit'&&req.method==='PUT'){
          store.admin(actor);auth.admin(actor);const input=await bodyForTenant(),current=session(req);store.admin(current);auth.admin(current);
          return send(res,200,runtime.setDailyLimit(current,id,input));
        }
        const agentRoute=/^agents\/([^/]+)$/.exec(action);
        if(action==='knowledge/sources'&&['GET','POST'].includes(req.method)){
          store.admin(actor);auth.admin(actor);
          if(req.method==='GET')return send(res,200,{sources:knowledge.list(actor,id,{includeArchived:url.searchParams.get('archived')==='true'})});
          const input=await bodyForTenant(65536),current=session(req);store.admin(current);auth.admin(current);
          return send(res,201,knowledge.create(current,id,input));
        }
        const knowledgeSource=/^knowledge\/sources\/([^/]+)(?:\/(publish|unpublish|archive|reactivate))?$/.exec(action);
        if(knowledgeSource){
          store.admin(actor);auth.admin(actor);const sourceId=knowledgeSource[1],operation=knowledgeSource[2];
          if(req.method==='GET'&&!operation)return send(res,200,knowledge.get(actor,id,sourceId));
          if(req.method==='PATCH'&&!operation||req.method==='POST'&&operation){
            const input=await bodyForTenant(operation?32768:65536),current=session(req);store.admin(current);auth.admin(current);
            const result=operation?knowledge[operation](current,id,sourceId,input):knowledge.update(current,id,sourceId,input);
            if(operation&&operation!=='reactivate')runtime.list(current,id);
            // A preparation running over the previous publication re-runs over the current sources.
            autopilot.invalidate({tenantId:id});
            return send(res,200,result);
          }
        }
        const knowledgeGrants=/^agents\/([^/]+)\/knowledge-grants$/.exec(action);
        if(knowledgeGrants&&['GET','PUT'].includes(req.method)){
          store.admin(actor);auth.admin(actor);
          if(req.method==='GET')return send(res,200,knowledge.grants(actor,id,knowledgeGrants[1]));
          const input=await bodyForTenant(),current=session(req);store.admin(current);auth.admin(current);
          const result=knowledge.setGrants(current,id,knowledgeGrants[1],input);runtime.list(current,id);autopilot.invalidate({tenantId:id,agentId:knowledgeGrants[1]});return send(res,200,result);
        }
        if(action==='knowledge/search'&&req.method==='POST'){
          store.admin(actor);auth.admin(actor);const input=await bodyForTenant(),current=session(req);store.admin(current);auth.admin(current);
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['agentId','query'].includes(key))||typeof input.agentId!=='string'||typeof input.query!=='string'||input.query.length>1300)fail(400,'Informe um agente e uma pergunta com até 1300 caracteres.');
          const tenant=store.tenant(current,id),agent=tenant.agents.find(item=>item.id===input.agentId);if(!agent)fail(404,'Agente não encontrado nesta empresa.');
          return send(res,200,knowledge.search(tenant,agent,input.query));
        }
        if(action==='mcp/servers'&&['GET','POST'].includes(req.method)){
          store.admin(actor);auth.admin(actor);const input=req.method==='POST'?await bodyForTenant():null;await agentSecrets();const current=session(req);store.admin(current);auth.admin(current);
          return send(res,input?201:200,input?mcp.create(current,id,input):mcp.list(current,id));
        }
        const mcpServer=/^mcp\/servers\/([^/]+)(?:\/(discover))?$/.exec(action);
        if(mcpServer&&(req.method==='PATCH'&&!mcpServer[2]||req.method==='POST'&&mcpServer[2])){
          store.admin(actor);auth.admin(actor);const input=await bodyForTenant();await agentSecrets();const current=session(req);store.admin(current);auth.admin(current);
          const authorize=()=>{const latest=session(req);if(latest.userId!==current.userId||latest.resellerId!==current.resellerId)fail(403,'A sessão mudou.');store.admin(latest);auth.admin(latest);return latest;};
          return send(res,200,mcpServer[2]?await mcp.discover(current,id,mcpServer[1],input,{authorize}):mcp.update(current,id,mcpServer[1],input));
        }
        const grantRoute=/^agents\/([^/]+)\/mcp-grants$/.exec(action);
        if(grantRoute&&['GET','PUT'].includes(req.method)){
          store.admin(actor);auth.admin(actor);const input=req.method==='PUT'?await bodyForTenant():null;const current=session(req);store.admin(current);auth.admin(current);
          return send(res,200,input?mcp.setGrants(current,id,grantRoute[1],input):mcp.grants(current,id,grantRoute[1]));
        }
        const agentProbe=/^agents\/([^/]+)\/test$/.exec(action);
        if(agentProbe&&req.method==='POST'){
          store.admin(actor);const vault=await agentSecrets(),currentActor=session(req);store.admin(currentActor);
          const agent=store.tenant(currentActor,id).agents.find(item=>item.id===agentProbe[1]),config=agent&&agentConfig(vault,id,agent.id);
          if(!agent||!config)fail(409,'Configure este agente antes de verificar o serviço.');
          const testedVersion=agent.version;
          try{
            const health=await checkAgentServiceHealth({endpoint:config.endpoint,allowedOrigins:agentOrigins,apiKey:config.token,model:config.model});
            const latest=session(req);store.admin(latest);const checkedAt=new Date().toISOString();
            store.mutate(latest,id,'Serviço de agente verificado',state=>{const current=state.agents.find(item=>item.id===agent.id);if(!current||current.version!==testedVersion)fail(409,'O agente mudou. Verifique novamente.');current.serviceCheckedAt=checkedAt;});
            return send(res,200,{...health,checkedAt});
          }catch(error){if(error.status)throw error;fail(502,'O serviço não respondeu com o modelo configurado.');}
        }
        if(agentRoute&&req.method==='PATCH'){
          store.admin(actor);const input=await bodyForTenant(),vault=await agentSecrets(),currentActor=session(req);store.admin(currentActor);
          if(!Number.isSafeInteger(input.version)||input.version<1)fail(400,'Informe a versão atual do agente.');
          if(input.toolPolicy!==undefined&&!TOOL_POLICIES.includes(input.toolPolicy))fail(400,'Escolha uma política de ferramentas válida.');
          const agent=store.tenant(currentActor,id).agents.find(a=>a.id===agentRoute[1]);if(!agent)fail(404,'Agente não encontrado.');
          if(agent.provider!=='hermes')fail(400,'Este corte conecta o copiloto Hermes.');
          const profileKeys=['name','description','instructions','toolPolicy','autopilot'],keys=Object.keys(input),profile=agentProfile(input);
          // Autonomous replies are an administrator decision: a delegated support session or an operator never changes them.
          const autopilotChange=Object.hasOwn(input,'autopilot');if(autopilotChange&&(currentActor.userId||!allowDemo))auth.admin(currentActor);
          const applyAutopilot=(state,current)=>{if(!autopilotChange)return;if(input.autopilot===null)delete current.autopilot;else current.autopilot=normalizeAutopilotConfig(input.autopilot,{tenant:state});};
          // Profile-only change (name, description, operating instructions, tool policy): same CAS and history as a configuration;
          // the version bump changes the agent fingerprint and invalidates runs in progress. History keeps the last 20 revisions.
          const remember=current=>{current.versions||=[];const {versions:ignored,...previous}=current;current.versions.push({version:current.version||1,config:previous});current.versions=current.versions.slice(-20);};
          if(keys.some(key=>profileKeys.includes(key))&&keys.every(key=>key==='version'||profileKeys.includes(key))){
            const label=keys.every(key=>['version','toolPolicy'].includes(key))?'Política de ferramentas do agente atualizada':keys.every(key=>['version','autopilot'].includes(key))?'Piloto automático do agente atualizado':'Perfil do agente atualizado';
            const saved=store.mutate(currentActor,id,label,state=>{const current=state.agents.find(a=>a.id===agent.id);if(!current||(current.version||1)!==input.version)fail(409,'O agente mudou. Atualize antes de salvar.');remember(current);applyAgentProfile(current,profile);applyAutopilot(state,current);current.version=(current.version||1)+1;return {version:current.version,autopilot:current.autopilot??null};});
            autopilot.invalidate({tenantId:id,agentId:agent.id});runtime.list(currentActor,id);return send(res,200,{...profile,...(autopilotChange?{autopilot:saved.autopilot}:{}),version:saved.version});
          }
          const saved=agentConfig(vault,id,agent.id);
          const config={endpoint:text(input.endpoint,500),model:text(input.model,100),token:text(input.token||saved?.token||'',500)};
          try{createHermesProvider({...config,apiKey:config.token,allowedOrigins:agentOrigins});}catch{fail(400,'Endpoint precisa estar na lista de serviços autorizados do servidor.');}
          const version=store.mutate(currentActor,id,'Serviço de agente configurado',state=>{const current=state.agents.find(a=>a.id===agent.id);if(!current||(current.version||1)!==input.version)fail(409,'O agente mudou. Atualize antes de salvar.');remember(current);applyAutopilot(state,current);vault.set(agentSecretId(id,agent.id),config);applyAgentProfile(current,profile);Object.assign(current,{configured:true,state:'configured',mode:'copilot',endpoint:config.endpoint,model:config.model,version:(current.version||1)+1});return current.version;});
          autopilot.invalidate({tenantId:id,agentId:agent.id});return send(res,200,{configured:true,version});
        }
        const runRoute=/^conversations\/([^/]+)\/run$/.exec(action);
        if(runRoute&&req.method==='POST'){
          const input=await bodyForTenant();await agentSecrets();const currentActor=session(req),cid=runRoute[1];
          // Responsibility is checked on the current conversation; the runtime pins the run to the current version and accepts an
          // older client version only when it lags by newer customer messages (owner/route changes still return 409).
          requireResponsible(currentActor,id,conversationFor(currentActor,id,cid,'inbox.reply'));
          const authorize=({conversationId,run})=>{const latest=session(req);if(latest.userId!==currentActor.userId||latest.resellerId!==currentActor.resellerId)fail(403,'A sessão mudou.');requireResponsible(latest,id,conversationFor(latest,id,conversationId,'inbox.reply',run.conversationVersion));};
          return send(res,202,runtime.enqueue(currentActor,id,cid,input,{authorize}));
        }
        const memoryRoute=/^conversations\/([A-Za-z0-9_-]{1,120})\/memories(?:\/([A-Za-z0-9_-]{1,120})(?:\/(archive|reactivate))?)?$/.exec(action);
        if(memoryRoute){
          const [,cid,mid,operation]=memoryRoute;
          const authorizeMemory=current=>{const c=conversationFor(current,id,cid);requirePermission(current,'contacts.read',contextFor(id,c));};
          if(req.method==='GET'&&!mid){authorizeMemory(actor);return send(res,200,memory.list(actor,id,cid,{agentId:url.searchParams.get('agentId')}));}
          if(req.method==='POST'&&!mid||req.method==='PATCH'&&mid&&!operation||req.method==='POST'&&mid&&operation){
            const input=await bodyForTenant(8192),current=session(req);authorizeMemory(current);
            const result=!mid?memory.create(current,id,cid,input):operation?memory[operation](current,id,cid,mid,input):memory.update(current,id,cid,mid,input);
            runtime.list(current,id);
            return send(res,mid?200:201,result);
          }
        }
        const runsRoute=/^conversations\/([^/]+)\/runs$/.exec(action);
        if(runsRoute&&req.method==='GET'){const currentActor=session(req);conversationFor(currentActor,id,runsRoute[1]);return send(res,200,{runs:runtime.list(currentActor,id,runsRoute[1])});}
        const cancelRun=/^runs\/([^/]+)\/cancel$/.exec(action);
        const toolDecision=/^runs\/([^/]+)\/tool\/(approve|reject)$/.exec(action);
        if(toolDecision&&req.method==='POST'){
          const input=await bodyForTenant();await agentSecrets();const current=session(req),run=runtime.list(current,id).find(item=>item.id===toolDecision[1]);if(!run)fail(404,'Execução não encontrada.');
          const authorize=({conversationId,run})=>{const latest=session(req);if(latest.userId!==current.userId||latest.resellerId!==current.resellerId)fail(403,'A sessão mudou.');requireResponsible(latest,id,conversationFor(latest,id,conversationId,'inbox.reply',run.conversationVersion));};
          authorize({conversationId:run.conversationId,run});
          return send(res,toolDecision[2]==='approve'?202:200,runtime[toolDecision[2]==='approve'?'approveTool':'rejectTool'](current,id,run.id,input,{authorize}));
        }
        if(cancelRun&&req.method==='POST'){const currentActor=session(req),run=runtime.list(currentActor,id).find(r=>r.id===cancelRun[1]);if(!run)fail(404,'Execução não encontrada.');requireResponsible(currentActor,id,conversationFor(currentActor,id,run.conversationId,'inbox.reply'));return send(res,200,runtime.cancel(currentActor,id,cancelRun[1]));}
        if(action==='outbox'&&req.method==='GET'){const tenant=store.tenant(actor,id),readable=tenantPermission(actor,'inbox.read',id),ids=new Set(tenant.conversations.filter(c=>readable(contextFor(id,c,tenant))).map(c=>c.id));return send(res,200,{commands:outbox.list(actor,id).filter(c=>ids.has(c.conversationId))});}
        const details=/^conversations\/([^/]+)\/details$/.exec(action);
        if(details&&req.method==='POST'){
          const input=await bodyForTenant();if(!Number.isInteger(input.version)||input.version<1)fail(400,'Informe a versão da conversa.');
          const result=store.mutate(actor,id,'Conversa atualizada',state=>{const c=store.getConversation(state,details[1],input.version);requirePermission(actor,'inbox.transfer',contextFor(id,c));if(actor.role!=='reseller'&&c.assignedUserId&&c.assignedUserId!==actor.userId)fail(403,'Somente o responsável pode alterar este atendimento.');const previous=c.status;if(input.status!==undefined)c.status=choice(input.status,['open','pending','closed']);if(input.department!==undefined&&input.department!==c.department)fail(400,'Use Transferir para mudar o departamento.');if(input.tags!==undefined){if(!Array.isArray(input.tags)||input.tags.length>20)fail(400,'Informe até vinte etiquetas.');c.tags=[...new Set(input.tags.map(tag=>text(tag,40)))];}if(previous!==c.status&&(previous==='closed'||c.status==='closed'))operations.clearParticipants(c,actor,{origin:'panel',reason:'Atendimento encerrado ou reaberto.'});if(previous==='closed'&&c.status!=='closed'){c.owner='queue';c.assignedUserId=null;c.assignedUserName=null;c.agentId=null;}noteStatus(c,actor,previous,{reason:input.reason,origin:'panel'});c.version++;c.updatedAt=new Date().toISOString();return c;});runtime.invalidateConversation(actor,id,details[1]);return send(res,200,safeConversation(result,actor,id));
        }
        if (req.method === 'PATCH' && action === 'brand') {
          store.admin(actor);
          const branding = { ...store.tenant(actor,id).brand, ...brand(await bodyForTenant()) };
          store.mutate(actor, id, 'Identidade da empresa atualizada', state => { state.brand = branding; });
          return send(res, 200, { brand: branding, domainProvisioned: false });
        }
        if (req.method === 'POST' && action === 'channels') {
          store.admin(actor); const input = await bodyForTenant();
          if(actor.userId)auth.admin(actor);
          const channel = { id: randomUUID(), name: text(input.name, 48), kind: choice(input.kind, CHANNEL_KINDS), state: 'planned', label: 'Integração pendente' };
          if (input.real === true) {
            if (!['whatsapp_qr', 'telegram','telegram_user','webchat','email','instagram','messenger'].includes(channel.kind)) fail(400, 'Este conector ainda não está disponível.');
            channel.state = 'disconnected';
            if (channel.kind === 'whatsapp_qr') {
              channel.expectedNumber = normalizeNumber(input.expectedNumber);
              channel.transport = 'baileys'; channel.label = `Número de teste · final ${channel.expectedNumber.slice(-4)}`;
            } else if(channel.kind==='telegram') { channel.transport = 'telegram-bot'; channel.label = 'Bot aguardando conexão'; }
            else if(channel.kind==='telegram_user'){channel.transport='telegram-user';channel.label='Conta Telegram aguardando conexão';channel.telegramUser={version:0,selectedPeerIds:[],dialogs:[]};}
            else {channel.transport={webchat:'elozi-webchat',email:'mepmail-channel',instagram:'meta-instagram',messenger:'meta-messenger'}[channel.kind];channel.label='Aguardando configuração do canal';}
          }
          store.mutate(actor, id, channel.transport === 'baileys' ? 'Número de teste cadastrado' : 'Canal planejado cadastrado', state => { if (state.channels.length >= 20) fail(400, 'Limite do piloto atingido.'); if (channel.transport === 'baileys') gateway.reserveNumber(channel, id); state.channels.push(channel); });
          const { expectedNumber, ...publicChannel } = channel;
          return send(res, 201, publicChannel);
        }
        if(action==='channels/onboarding'&&req.method==='GET'){
          const authorize=()=>{reauthorize();auth.admin(actor);store.admin(actor);if(!actor.userId||actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa valida o canal.');};
          res.setHeader('Cache-Control','no-store');return send(res,200,channelOnboarding.list(actor,id,{reauthorize:authorize}));
        }
        const channelOnboardingRoute=/^channels\/([^/]+)\/onboarding$/.exec(action);
        if(channelOnboardingRoute){
          const authorize=()=>{reauthorize();auth.admin(actor);store.admin(actor);if(!actor.userId||actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa valida o canal.');};
          authorize();res.setHeader('Cache-Control','no-store');
          if(req.method==='GET')return send(res,200,channelOnboarding.get(actor,id,channelOnboardingRoute[1],{reauthorize:authorize}));
          if(req.method==='POST'){const input=await bodyForTenant(2048);authorize();return send(res,200,channelOnboarding.update(actor,id,channelOnboardingRoute[1],input,{reauthorize:authorize}));}
          res.setHeader('Allow','GET, POST');fail(405,'A validação aceita somente consulta, início ou confirmação.');
        }
        // Reply policy of a channel (service-reply-limits.js channelReplyPolicy): support default or product assistant.
        const replyPolicyRoute=/^channels\/([^/]+)\/reply-policy$/.exec(action);
        if(replyPolicyRoute&&req.method==='POST'){
          auth.admin(actor);store.admin(actor);if(!actor.userId||actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa define a política de respostas.');
          const policy=channelReplyPolicy(await bodyForTenant(2048));
          return send(res,200,store.mutate(actor,id,'Política de respostas do canal atualizada',state=>{
            const channel=state.channels.find(item=>item.id===replyPolicyRoute[1]);
            if(!channel)fail(404,'Canal não encontrado nesta empresa.');
            if(policy)channel.replyPolicy={...policy};else delete channel.replyPolicy;
            return {channelId:channel.id,replyPolicy:policy?{...policy}:{profile:'attendance'}};
          }));
        }
        // Team/QA conversation of the company: the connected agent's hourly reply limit does not apply, only the loop guard.
        const replyExemptionRoute=/^conversations\/([^/]+)\/reply-exemption$/.exec(action);
        if(replyExemptionRoute&&req.method==='POST'){
          auth.admin(actor);store.admin(actor);if(!actor.userId||actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa marca conversas de equipe/QA.');
          const input=await bodyForTenant(256);
          if(Object.keys(input).length!==1||typeof input.exempt!=='boolean')fail(400,'Informe somente exempt verdadeiro ou falso.');
          return send(res,200,store.mutate(actor,id,'Conversa de equipe/QA atualizada',state=>{
            const conversation=store.getConversation(state,replyExemptionRoute[1]);
            if(conversation.conversationKind==='group')fail(400,'Marque somente conversas diretas como equipe/QA.');
            if(input.exempt){conversation.replyExempt=true;conversation.replyExemptBy=actor.userId;conversation.replyExemptAt=new Date().toISOString();}
            else{delete conversation.replyExempt;delete conversation.replyExemptBy;delete conversation.replyExemptAt;}
            return {conversationId:conversation.id,replyExempt:input.exempt};
          }));
        }
        // Default connected agent of a WhatsApp QR channel (whatsapp.js assignChannelAgent); null turns automatic assignment off.
        const defaultAgentRoute=/^channels\/([^/]+)\/default-agent$/.exec(action);
        if(defaultAgentRoute&&req.method==='POST'){
          auth.admin(actor);store.admin(actor);if(!actor.userId||actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa define o agente padrão do canal.');
          const input=await bodyForTenant(1024);
          if(Object.keys(input).length!==1||!Object.hasOwn(input,'agentId')||input.agentId!==null&&typeof input.agentId!=='string')fail(400,'Informe somente agentId, ou null para desligar.');
          return send(res,200,store.mutate(actor,id,'Agente padrão do canal atualizado',state=>{
            const channel=state.channels.find(item=>item.id===defaultAgentRoute[1]);
            if(!channel)fail(404,'Canal não encontrado nesta empresa.');
            if(channel.kind!=='whatsapp_qr'||channel.transport!=='baileys')fail(400,'O agente padrão está disponível para canais WhatsApp por QR.');
            if(input.agentId===null){delete channel.defaultAgentId;return {channelId:channel.id,defaultAgentId:null};}
            const agent=(state.agents||[]).find(item=>item.id===input.agentId);
            if(!agent||agent.provider!=='mcp'||agent.mode!=='copilot'||agent.configured!==true)fail(409,'Escolha um agente conectado via MCP, em modo copiloto, desta empresa.');
            channel.defaultAgentId=agent.id;return {channelId:channel.id,defaultAgentId:agent.id};
          }));
        }
        // Logo of a webchat's site for the cards of Canais (site-icon.js); administrators only, the body is ignored.
        const siteIconRoute=/^channels[/]([^/]+)[/]site-icon$/.exec(action);
        if(siteIconRoute&&req.method==='POST'){auth.admin(actor);store.admin(actor);await bodyForTenant();return send(res,200,await webchat.refreshSiteIcon(actor,id,siteIconRoute[1],{reauthorize}));}
        const widgetConfigurationRoute=/^channels\/([^/]+)\/widget-configuration$/.exec(action);
        if(widgetConfigurationRoute&&['GET','POST'].includes(req.method)){
          auth.admin(actor);store.admin(actor);if(actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa configura o suporte.');
          const input=req.method==='POST'?await bodyForTenant():undefined;
          const result=webchat.widgetConfiguration(actor,id,widgetConfigurationRoute[1],input,{reauthorize});
          if(input)centralSupport.reload();
          return send(res,200,result);
        }
        const widgetIdentityRoute=/^channels\/([^/]+)\/identity\/(status|configure|create-key|rotate-key|revoke-key)$/.exec(action);
        if(widgetIdentityRoute){
          const [,channelId,operation]=widgetIdentityRoute;
          const authorize=()=>{reauthorize();auth.admin(actor);store.admin(actor);if(actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa configura a identidade.');};
          authorize();await agentSecrets();authorize();
          if(operation==='status'&&req.method==='GET')return send(res,200,webchat.identity.status(actor,id,channelId,{},{reauthorize:authorize}));
          if(req.method!=='POST'||operation==='status')fail(405,'Método indisponível.');
          const input=await bodyForTenant();authorize();
          const method={configure:'configure','create-key':'createKey','rotate-key':'rotateKey','revoke-key':'revokeKey'}[operation];
          res.setHeader('Cache-Control','no-store');return send(res,200,webchat.identity[method](actor,id,channelId,input,{reauthorize:authorize}));
        }
        const configurationRoute=/^channels\/([^/]+)\/configuration$/.exec(action);
        if(configurationRoute&&['GET','POST'].includes(req.method)){
          const channelId=configurationRoute[1];auth.admin(actor);store.admin(actor);
          const before=store.tenant(actor,id).channels.find(item=>item.id===channelId);
          const adapter=before?.kind==='webchat'?webchat:before?.kind==='email'?emailChannel:['instagram','messenger'].includes(before?.kind)?meta:null;
          if(!adapter)fail(404,'Configuração deste conector não encontrada.');
          const status=req.method==='POST'?await adapter.configure(actor,id,channelId,await bodyForTenant(),{reauthorize}):await adapter.status(actor,id,channelId);
          if(req.method==='POST')autopilot.invalidate({tenantId:id,channelId});
          reauthorize();auth.admin(actor);const channel=store.tenant(actor,id).channels.find(item=>item.id===channelId);
          const enabled=Boolean(channel?.webchat?.enabled||channel?.email?.enabled||channel?.meta?.enabled),origin=publicOrigin||`http://${req.headers.host}`;
          const install=channel.kind==='webchat'?{scriptUrl:origin+'/widget.js',embedSnippet:`<script type="module" src="${origin}/widget.js" data-tenant-id="${id}" data-channel-id="${channelId}"></script>`,
            authenticatedSnippet:`import { createSaasWebchat } from ${JSON.stringify(origin+'/widget-saas.js')};\n\nconst support = createSaasWebchat({\n  apiOrigin: ${JSON.stringify(origin)},\n  tenantId: ${JSON.stringify(id)},\n  channelId: ${JSON.stringify(channelId)},\n  identity: { accountId: 'CONTA_ATUAL', userId: 'USUARIO_ATUAL' },\n  getIdentityToken: async ({ accountId, userId }) => {\n    const query = new URLSearchParams({ accountId, userId });\n    const response = await fetch('/api/support/identity?' + query, { credentials: 'same-origin', cache: 'no-store' });\n    if (!response.ok) throw new Error('Identidade indisponível');\n    return (await response.json()).token;\n  }\n});\n\n// Ao trocar de conta: support.setAccount({ accountId, userId });\n// Ao sair: support.setAccount(null);\n// Ao desmontar a página: support.destroy();`}:undefined;
          return send(res,200,{...status,tenantId:id,channelId,kind:channel.kind,enabled,capabilities:capabilitiesFor(channel),...(status.mediaSupported===undefined?{mediaSupported:false}:{}),...(install?{install}:{}),...(['email','instagram','messenger'].includes(channel.kind)?{webhookUrl:`${origin}/api/webhooks/${channel.kind==='email'?'email':'meta'}/${id}/${channelId}`}:{})});
        }
        const telegramGroupsRoute=/^channels\/([^/]+)\/telegram\/groups$/.exec(action);
        if(telegramGroupsRoute){const cid=telegramGroupsRoute[1];if(req.method==='GET')return send(res,200,telegram.groups(actor,id,cid));if(req.method==='POST')return send(res,200,telegram.setGroups(actor,id,cid,await bodyForTenant(),{reauthorize}));}
        const telegramAccountRoute=/^channels\/([^/]+)\/telegram-account\/(status|configuration|disconnect|auth\/(?:start|submit|cancel)|dialogs|history)$/.exec(action);
        if(telegramAccountRoute){
          const [,channelId,operation]=telegramAccountRoute;
          auth.admin(actor);store.admin(actor);
          if(actor.supportGrantId||actor.kind==='service')fail(403,'Somente o administrador da empresa conecta esta conta.');
          const authorize=()=>{reauthorize();auth.admin(actor);store.admin(actor);if(actor.supportGrantId||actor.kind==='service')fail(403,'O acesso à conta Telegram mudou.');};
          authorize();
          let result;
          if(req.method==='GET'&&operation==='status')result=telegramUser.status(actor,id,channelId);
          else if(req.method==='GET'&&operation==='dialogs')result=await telegramUser.dialogs(actor,id,channelId,{reauthorize:authorize});
          else if(req.method==='POST'){
            const input=await bodyForTenant();authorize();
            const methods={configuration:'configure',disconnect:'disconnect','auth/start':'startLogin','auth/submit':'submitLogin','auth/cancel':'cancelLogin',dialogs:'setDialogs',history:'importHistory'};
            if(!methods[operation])fail(405,'Método inválido para a conta Telegram.');
            result=await telegramUser[methods[operation]](actor,id,channelId,input,{reauthorize:authorize});
          }else fail(405,'Método inválido para a conta Telegram.');
          authorize();return send(res,200,result);
        }
        const deviceReadSyncRoute=/^channels\/([^/]+)\/read-state-sync$/.exec(action);
        if(deviceReadSyncRoute&&req.method==='POST'){
          const authorize=()=>{reauthorize();auth.admin(actor);store.admin(actor);if(actor.supportGrantId||actor.kind==='service')fail(403,'Somente a administração da empresa pode atualizar as leituras deste WhatsApp.');};
          authorize();const input=await bodyForTenant();
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)fail(400,'Esta atualização não recebe dados de mensagens.');
          const result=await gateway.syncDeviceReadState(actor,id,deviceReadSyncRoute[1],{reauthorize:authorize});
          authorize();return send(res,200,result);
        }
        const connectionRoute = /^channels\/([^/]+)\/(connect|connection|groups|profile|address-book|address-book-sync)$/.exec(action);
        if (connectionRoute) {
          const channelId = connectionRoute[1], channel = store.tenant(actor, id).channels.find(item => item.id === channelId);
          const adapter = channel?.transport === 'telegram-bot' ? telegram : gateway;
          if(channel?.transport==='telegram-user')fail(400,'Use a conexão de conta Telegram para administrar este canal.');
          if (connectionRoute[2] === 'connect' && req.method === 'POST') { const input = await bodyForTenant(); autopilot.invalidate({ tenantId: id, channelId }); return send(res, 200, await adapter.start(actor, id, channelId, input.token)); }
          if (connectionRoute[2] === 'connection' && req.method === 'GET') return send(res, 200, adapter.status(actor, id, channelId));
          if (connectionRoute[2] === 'groups' && req.method === 'GET') return send(res, 200, await gateway.groups(actor, id, channelId, { reauthorize }));
          if (connectionRoute[2] === 'groups' && req.method === 'POST') return send(res, 200, await gateway.setGroups(actor, id, channelId, await bodyForTenant(), { reauthorize }));
          if (connectionRoute[2] === 'profile' && req.method === 'POST') return send(res, 200, await telegram.setProfile(actor, id, channelId, await bodyForTenant()));
          // Address book of a WhatsApp QR connection (whatsapp-agenda.js): sync the saved names, list them for the CRM import.
          if (connectionRoute[2] === 'address-book-sync' && req.method === 'POST') { await bodyForTenant(); return send(res, 200, await gateway.syncAddressBook(actor, id, channelId, { reauthorize })); }
          if (connectionRoute[2] === 'address-book' && req.method === 'GET') return send(res, 200, gateway.addressBook(actor, id, channelId, { reauthorize }));
        }
        if (req.method === 'POST' && action === 'agents') {
          store.admin(actor); const input = await bodyForTenant();
          const agent = { id: randomUUID(), name: text(input.name, 48), provider: choice(input.provider, PROVIDERS), mode: choice(input.mode, MODES), state: 'planned', description: text(input.description, 200), tools: ['conversation.read', 'reply.draft'] };
          if (input.toolPolicy !== undefined) { if (!TOOL_POLICIES.includes(input.toolPolicy)) fail(400, 'Escolha uma política de ferramentas válida.'); agent.toolPolicy = input.toolPolicy; }
          // The autopilot answers with the platform's Hermes runtime; agents connected by MCP answer through their own tools.
          if (input.autopilot !== undefined && input.autopilot !== null) { if (agent.provider !== 'hermes') fail(400, 'O piloto automático usa um agente Hermes desta empresa; agentes conectados respondem pelas ferramentas de atendimento.'); if (actor.userId || !allowDemo) auth.admin(actor); }
          if (agent.provider === 'mcp') {
            if (agent.mode !== 'copilot') fail(400, 'Agentes via MCP começam em modo copiloto.');
            Object.assign(agent, { configured: true, state: 'awaiting_connection', version: 1, tools: ['conversation.read', 'reply.submit'] });
          }
          store.mutate(actor, id, 'Adaptador de agente planejado', state => { if (state.agents.length >= 20) fail(400, 'Limite do sandbox atingido.'); if (input.autopilot !== undefined && input.autopilot !== null) agent.autopilot = normalizeAutopilotConfig(input.autopilot, { tenant: state }); state.agents.push(agent); });
          return send(res, 201, agent);
        }
        if (req.method === 'POST' && action === 'conversations') {
          const input=await bodyForTenant();if(Object.keys(input).some(key=>!['channelId','name','number'].includes(key)))fail(400,'Informe somente nome, número e canal de origem.');const tenant=store.tenant(actor,id),d=(tenant.departments||[]).find(d=>d.active!==false&&d.id===tenant.defaultDepartmentId);requirePermission(actor,'inbox.reply',{tenantId:id,channelId:input.channelId,departmentId:d?.id||'unassigned'});
          const conversation = await gateway.beginConversation(actor, id, input);
          return send(res, 200, safeConversation(conversation,actor,id));
        }
        if (action === 'quick-replies' && req.method === 'GET') return send(res,200,{replies:quickReplies.list(actor,id)});
        if (action === 'quick-replies' && req.method === 'POST') return send(res,201,quickReplies.create(actor,id,await bodyForTenant()));
        const quickReplyRoute = /^quick-replies\/([^/]+)$/.exec(action);
        if (quickReplyRoute && req.method === 'PATCH') return send(res,200,quickReplies.update(actor,id,quickReplyRoute[1],await bodyForTenant()));
        const participantsRoute = /^conversations\/([^/]+)\/participants$/.exec(action);
        if(participantsRoute){const cid=participantsRoute[1];if(req.method==='GET')return send(res,200,operations.participants(actor,id,cid));if(req.method==='POST'){const result=operations.updateParticipants(actor,id,cid,await bodyForTenant());runtime.invalidateConversation(actor,id,cid);return send(res,200,safeConversation(result,actor,id));}}
        const attendanceRoute = /^conversations\/([^/]+)\/(notes|read-state)$/.exec(action);
        if(attendanceRoute && req.method==='POST') {
          const [ ,cid,operation]=attendanceRoute,input=await bodyForTenant(),before=store.getConversation(store.tenant(actor,id),cid).version;
          // Native reading is an explicit, responsible-only action. Existing clients keep the local command.
          const hasSync=operation==='read-state'&&input&&Object.hasOwn(input,'syncDevice');
          let command=input,syncDevice=false;
          if(hasSync){
            if(typeof input.syncDevice!=='boolean'||input.syncDevice&&input.unread!==false)fail(400,'A sincronização é permitida somente ao marcar como lida.');
            ({syncDevice,...command}=input);
            if(syncDevice){
              const conversation=conversationFor(actor,id,cid,'inbox.read',input.version),channel=store.tenant(actor,id).channels.find(item=>item.id===conversation.channelId);
              if(actor.supportGrantId||actor.kind==='service'||!actor.userId||conversation.owner!=='human'||conversation.assignedUserId!==actor.userId)fail(409,'Somente o responsável pode marcar esta conversa como lida no WhatsApp.');
              if(channel?.transport!=='baileys'||channel.kind!=='whatsapp_qr')fail(400,'Esta conexão não oferece sincronização de leitura com o WhatsApp.');
            }
          }
          const result=operation==='notes'?attendance.addNote(actor,id,cid,command):attendance.readState(actor,id,cid,command);
          if(result.version!==before)runtime.invalidateConversation(actor,id,cid);
          if(syncDevice){
            const authorizeRead=()=>{reauthorize();conversationFor(actor,id,cid,'inbox.read');};
            let readSync;
            try{
              const receipt=await gateway.syncReadToDevice(actor,id,cid,{version:result.version,channelId:result.channelId},{reauthorize:authorizeRead});
              readSync={state:receipt?.state==='synced'?'synced':'pending'};
            }catch{readSync={state:'pending'};}
            // Never return a captured conversation after an await: inbound messages and ownership can change.
            authorizeRead();
            return send(res,200,{...safeConversation(store.getConversation(store.tenant(actor,id),cid),actor,id),readSync});
          }
          return send(res,200,safeConversation(result,actor,id));
        }
        const scheduleRoute=/^conversations\/([^/]+)\/scheduled(?:\/(cancel))?$/.exec(action);
        if(scheduleRoute){const cid=scheduleRoute[1];if(req.method==='GET'&&!scheduleRoute[2])return send(res,200,{schedules:scheduled.list(actor,id,cid)});if(req.method==='POST'){const before=store.getConversation(store.tenant(actor,id),cid).version,input=await bodyForTenant(),result=scheduleRoute[2]?scheduled.cancel(actor,id,cid,input):scheduled.create(actor,id,cid,input);if(result.version!==before)runtime.invalidateConversation(actor,id,cid);return send(res,200,result);}}
        const convRoute = /^conversations\/([^/]+)\/(messages|owner|draft)$/.exec(action);
        const forwardRoute=/^conversations\/([^/]+)\/forward$/.exec(action);
        if(forwardRoute&&req.method==='POST')return send(res,200,safeConversation(await forwarding.forward(actor,id,forwardRoute[1],await bodyForTenant(),{reauthorize}),actor,id));
        if (convRoute && req.method === 'POST') {
          const input = await bodyForTenant(), convId = convRoute[1], command = convRoute[2];
          let origin = null;
          if (!Number.isInteger(input.version) || input.version < 1) fail(400, 'Informe a versão da conversa.');
          conversationFor(actor,id,convId,command==='owner'?'inbox.read':'inbox.reply',command==='messages'?undefined:input.version);
          if(command==='owner'){const result=operations.assign(actor,id,convId,input);runtime.invalidateConversation(actor,id,convId);return send(res,200,safeConversation(result,actor,id));}
          if (command === 'messages') {
            if (Object.keys(input).some(key => !['text','version','channelId','attachmentIds','idempotencyKey','replyToMessageId','sourceRunId'].includes(key))) fail(400,'Informe somente texto, arquivos e referência desta conversa.');
            // Transports, the outbox hash and the send policy never see the draft provenance.
            const { sourceRunId, ...message } = input, source = sourceRunId === undefined ? null : draftSource(actor, id, convId, sourceRunId);
            const tenant = store.tenant(actor, id), conversation = store.getConversation(tenant, convId);
            operations.canReply(actor,id,conversation);
            const channel = tenant.channels.find(item => item.id === conversation.channelId), known = new Set((conversation.messages || []).map(item => item?.id));
            const sent = result => safeConversation(source ? recordDraftUse(actor,id,convId,source,message.text,known) || result : result, actor, id);
            if (channel?.transport === 'baileys') {
              return send(res, 200, sent(await outbox.dispatch(actor,id,convId,message,()=>gateway.send(actor, id, convId, message,{reauthorize}),{reauthorize,validate:()=>messagePolicy(actor,id,convId,message)})));
            }
            if (['telegram-bot','telegram-user'].includes(channel?.transport)) return send(res, 200, sent(await outbox.dispatch(actor,id,convId,message,()=>adapterFor(channel).send(actor, id, convId, message,{reauthorize}),{reauthorize,validate:()=>messagePolicy(actor,id,convId,message)})));
            if(['elozi-webchat','mepmail-channel','meta-instagram','meta-messenger'].includes(channel?.transport))return send(res,200,sent(await outbox.dispatch(actor,id,convId,message,()=>adapterFor(channel).send(actor,id,convId,message,{reauthorize}),{reauthorize,validate:()=>messagePolicy(actor,id,convId,message)})));
            if(channel?.kind==='telegram_user'||channel?.transport&&channel.transport!=='sandbox')fail(409,'A conexão deste atendimento não está disponível.');
            if(message.attachmentIds?.length)fail(400,'Anexos disponíveis nas conexões WhatsApp e Telegram.');
            origin = source;
          }
          const result = store.mutate(actor, id, { messages: 'Mensagem enviada no sandbox', owner: 'Responsável alterado no sandbox', draft: 'Rascunho simulado solicitado' }[command], state => {
            const conversation = store.getConversation(state, convId, input.version);
            if (command === 'draft') {
              const agent = state.agents.find(item => item.id === input.agentId);
              if (!agent) fail(404, 'Agente não encontrado nesta empresa.');
              return { text: `Olá, ${conversation.contact.split(' ')[0]}! Vou te ajudar com ${conversation.department.toLowerCase()}. Pode me contar um pouco mais para eu orientar o próximo passo?`, version: conversation.version, simulated: true, providerCalled: false, agent: agent.name };
            }
            {
              operations.canReply(actor,id,conversation);
              if (input.channelId !== conversation.channelId) fail(400, 'A resposta precisa usar o canal de origem.');
              const reply = resolveReply(conversation,input), messageId = randomUUID(), date = new Date().toISOString(), source = origin;
              conversation.messages.push({ id: messageId, kind: 'human', text: text(input.text, 4000),authorUserId:actor.userId||null,authorName:actor.name, createdAt: date, delivery: 'sandbox',...(reply ? {replyToMessageId:reply.messageId} : {}),...(source ? { sourceRunId: source.runId } : {}) });
              if (source) markDraftOutcome(state, source, input.text, messageId, date);
              conversation.unread = 0;
            }
            conversation.version++; conversation.updatedAt = new Date().toISOString();
            return conversation;
          });
          if(command==='owner')runtime.invalidateConversation(actor,id,convId);
          return send(res, 200, command==='draft'?result:safeConversation(result,actor,id));
        }
        fail(404, 'Recurso não encontrado.');
      }
      const versioned=req.method==='GET'?/^\/v\/([a-f0-9]{12})\/([a-z0-9][a-z0-9.-]*)$/.exec(path):null;
      if(versioned&&panelAssetSet.has(versioned[2])){
        const file=versioned[2],asset=await staticAsset(file),current=versioned[1]===await assetVersion();
        // An old page asking for an earlier version gets today's bytes without the long cache.
        res.setHeader('Cache-Control',current?'public, max-age=31536000, immutable':'no-cache');res.setHeader('ETag',asset.etag);
        if(etagMatches(req.headers['if-none-match'],asset.etag)){res.writeHead(304);return res.end();}
        res.writeHead(200,{'Content-Type':types[extname(file)],'Content-Length':asset.content.length});return res.end(asset.content);
      }
      // Elozi's own public host presents the product and its prices (src/public-site.js); resellers' domains never do (white label).
      const ownSiteRequest=publicSite&&!boundDomain&&hostname===publicURL.hostname&&['GET','HEAD'].includes(req.method);
      if(ownSiteRequest&&path==='/')res.setHeader('Vary',publicRootVary(res.getHeader('Vary')));
      // stripe-billing hook (D1): `/?billing=` is a panel return, never the marketing home (app shell / login instead).
      const sitePage=ownSiteRequest&&!(path==='/'&&url.searchParams.has('billing'))
        ?publicSite(path,{signedIn:/(?:^|;\s*)mep_session=/.test(req.headers.cookie||''),html:publicSiteHtmlHint(path,req.headers.accept)}):null;
      if(sitePage?.location){res.writeHead(sitePage.status,{Location:sitePage.location});return res.end();}
      if(sitePage){if(sitePage.type.startsWith('text/html'))res.setHeader('Content-Security-Policy',publicSiteCsp(res.getHeader('Content-Security-Policy')));res.writeHead(sitePage.status,{'Content-Type':sitePage.type,'Content-Length':sitePage.body.length});return res.end(req.method==='HEAD'?undefined:sitePage.body);}
      // A browser opening the panel without a session goes straight to sign-in instead of an app shell that only says
      // "Preparando seu workspace…". Only real page loads (Sec-Fetch-Mode: navigate) move; the deep link's fragment
      // survives the redirect and login.js resumes it after signing in.
      if(path==='/'&&req.method==='GET'&&req.headers['sec-fetch-mode']==='navigate'&&!/(?:^|;\s*)mep_session=/.test(req.headers.cookie||'')){res.writeHead(302,{Location:'/login'});return res.end();}
      if ((req.method === 'GET' || req.method === 'HEAD' && publicWidgetAssets.has(path)) && staticFiles[path]) {
        const file = staticFiles[path], asset = await staticAsset(file);
        // GSI needs the page origin; strict-origin also strips same-origin paths and queries.
        if(google.clientId&&!boundDomain&&['index.html','login.html'].includes(file))res.setHeader('Referrer-Policy','strict-origin');
        if(publicWidgetAssets.has(path)){res.setHeader('Access-Control-Allow-Origin','*');res.writeHead=writeHeadOrigin;} // cross-origin widget assets carry no origin timing
        // HTML keeps no-store (set for every response above). Scripts, styles, images and fonts revalidate by content:
        // no-cache + a strong ETag that is the same SHA-256 scripts/verify.mjs checks, answered with 304 when unchanged.
        if(extname(file)!=='.html'){
          res.setHeader('Cache-Control','no-cache');res.setHeader('ETag',asset.etag);
          if(etagMatches(req.headers['if-none-match'],asset.etag)){res.writeHead(304);return res.end();}
        }
        if(['index.html','login.html'].includes(file)){
          const page=Buffer.from(versionedPage(asset.content,await assetVersion()));
          res.writeHead(200,{'Content-Type':types['.html'],'Content-Length':page.length});return res.end(req.method==='HEAD'?undefined:page);
        }
        res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': asset.content.length }); return res.end(req.method === 'HEAD' ? undefined : asset.content);
      }
      // A page the panel does not have (/pricing, a typo) gets a page, not the JSON of the API.
      if(req.method==='GET'&&!path.startsWith('/api/')&&/\btext\/html\b/.test(req.headers.accept||'')){
        const page=Buffer.from(NOT_FOUND_PAGE);res.writeHead(404,{'Content-Type':'text/html; charset=utf-8','Content-Length':page.length});return res.end(page);
      }
      fail(404, 'Recurso não encontrado.');
    } catch (error) {
      // Unexpected failures get a neutral message and a requestId that matches the operator log (method, route shape and
      // redacted stack only: no body, cookie, query string or token).
      const internal=!error?.status||error.status===500,requestId=internal?randomUUID():null;
      if(internal)console.error('Falha interna na requisição.',JSON.stringify({requestId,method:String(req.method||'').slice(0,16),route:routePattern(req.url),...describeError(error)}));
      if (!res.headersSent) {
        if(requestId)res.setHeader('X-Request-Id',requestId);
        if(error?.status===429&&error.retryAfter)res.setHeader('Retry-After',String(error.retryAfter));
        // ai_quota_exceeded lets the panel tell the daily AI limit apart from other 429s (FRONTEND-V2 §7.4).
        const quota=error?.status===429&&(error.code==='ai_quota_exceeded'||error.message===AI_QUOTA_REASON);
        // The reply guardrail tells REST callers the same machine-readable refusal that MCP structuredContent carries.
        const replyLimit=error instanceof ServiceReplyRateLimitError?{code:error.code,admissionRejected:true,retryAfter:error.retryAfter,limit:{...error.rateLimit},noticeSent:error.noticeSent===true}:{};
        send(res, error?.status || 500, { error: error?.status ? error.message : 'Falha interna inesperada. Tente novamente em instantes.',...(requestId?{requestId}:{}),...replyLimit,...(/^(?:account_delete_[a-z_]+|OUTBOUND_(?:UNCONFIRMED|FAILED|REGISTERED)|OWN_LINE_AGENT_PAIR|DEMO_COMPANY|webchat_origin_denied|plan_limit|subscription_(?:exists|pending)|manual_contract|not_owner|same_order|billing_(?:unavailable|invalid_request|not_self_serve|no_subscription|no_customer|checkout_pending|provider_error|unsupported_items)|identity_(?:invalid|expired|replay|origin_denied|revoked|configchanged|account_changed))$/.test(error?.code||'')?{code:error.code}:{}),...(quota?{code:'ai_quota_exceeded'}:{}) });
      }
      else res.end();
    }
  });
  const supportTimer=setInterval(()=>{try{support.sweep();}catch{console.error('Ciclo de suporte temporário adiado.');}},5000);supportTimer.unref();
  const assistantTimer=setInterval(()=>centralSupport.drain().catch(()=>console.error('Ciclo do suporte automático adiado.')),1500);assistantTimer.unref();
  // The autopilot stops (intake, timers, running work) before the bus it listens to.
  server.on('close',()=>{clearInterval(supportTimer);clearInterval(assistantTimer);stopScheduler();groupSummaries.close();centralSupport.close().catch(()=>{});autopilot.close().catch(()=>{});realtime.close();events.close();});
  // Event streams never end by themselves: closing the server ends them first so close() can complete.
  const closeServer=server.close.bind(server);
  server.close=callback=>{realtime.close();return closeServer(callback);};
  support.sweep();
  server.once('close',()=>groupHistoryImporter.close());
  return { server, store, stripeBilling, events, serviceWebhooks, realtime, autopilot, gateway, telegram, telegramUser, auth, flows, runtime, mcp, knowledge, memory, bridge, outbox,google,email,loadIntegrations,health,startScheduler,stopScheduler,operations,contacts,media,automation,avatars,groups,groupSummaries,groupHistoryImporter,cleanupMedia,attendance,scheduled,followUps,teamChat,support,servicePrincipals,serviceApi,serviceNotifications,billing,accounts,commercialPlans,domains,webchat,emailChannel,meta,centralSupport };
}

// Real client address for rate limits. Forwarded headers count only when the TCP peer is a trusted local proxy
// (loopback, plus MEPCHAT_TRUSTED_PROXIES); a direct peer is always keyed by its own socket address. nginx overwrites
// X-Real-IP and appends its peer as the last X-Forwarded-For hop. CF-Connecting-IP is used only when that peer is a
// published Cloudflare edge, so a client reaching the origin directly cannot rotate or impersonate addresses.
const CLOUDFLARE_EDGES = ['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22','2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32','2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32'];
const ipFamily = address => isIP(address) === 6 ? 'ipv6' : 'ipv4';
function plainAddress(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  let address = value.trim();
  if (/^\[[^\]]+\]$/.test(address)) address = address.slice(1, -1);
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(address)) address = address.slice(7);
  return isIP(address) ? address.toLowerCase() : '';
}
function subnetList(entries) {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix, ...rest] = String(entry).trim().split('/'), plain = plainAddress(address), family = plain && ipFamily(plain), bits = prefix === undefined ? (family === 'ipv6' ? 128 : 32) : Number(prefix);
    if (!plain || rest.length || prefix !== undefined && !/^\d{1,3}$/.test(prefix) || bits > (family === 'ipv6' ? 128 : 32)) throw Error('MEPCHAT_TRUSTED_PROXIES precisa listar IPs, faixas CIDR válidas ou gateway.');
    list.addSubnet(plain, bits, family);
  }
  return list;
}
const cloudflareEdges = subnetList(CLOUDFLARE_EDGES);
/**
 * IPv4 default gateway of this network namespace (Linux /proc/net/route), as one exact address, or '' when there is none.
 * In the documented container topology the host nginx reaches the port published on host loopback through Docker, so the
 * container sees this bridge address, never loopback. Other containers on the network keep their own addresses and stay
 * untrusted, which is why the network range is never trusted. Route values are little-endian hex (x86-64 and arm64).
 */
export function defaultGateway(routeTable) {
  let table = routeTable;
  if (table === undefined) try { table = readFileSync('/proc/net/route', 'utf8'); } catch { return ''; }
  for (const line of String(table).split('\n').slice(1, 257)) {
    const [, destination, gateway, flags, , , , mask] = line.trim().split(/\s+/);
    if (destination !== '00000000' || mask !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gateway || '') || /^0{8}$/.test(gateway) || !(parseInt(flags, 16) & 2)) continue;
    return [6, 4, 2, 0].map(at => parseInt(gateway.slice(at, at + 2), 16)).join('.');
  }
  return '';
}
/**
 * Loopback is always a trusted local proxy. Extra proxies are explicit IPs/CIDRs, or "gateway": the exact default gateway
 * of the container (resolved once at startup; nothing is trusted when it cannot be resolved).
 */
export function trustedProxyCheck(entries = [], resolveGateway = defaultGateway) {
  const expanded = entries.flatMap(entry => String(entry).trim().toLowerCase() === 'gateway' ? [resolveGateway()].filter(Boolean) : [entry]);
  const list = subnetList(['127.0.0.0/8', '::1/128', ...expanded]);
  return address => { const plain = plainAddress(address); return Boolean(plain) && list.check(plain, ipFamily(plain)); };
}
export function clientAddress(req, trusted = trustedProxyCheck()) {
  const peer = plainAddress(req.socket?.remoteAddress) || 'unknown';
  if (peer === 'unknown' || !trusted(peer)) return peer;
  const header = name => { const value = req.headers?.[name]; return Array.isArray(value) ? value.at(-1) : value; };
  const forwarded = plainAddress(header('x-real-ip')) || plainAddress(String(header('x-forwarded-for') || '').split(',').at(-1));
  if (!forwarded) return peer;
  const edge = cloudflareEdges.check(forwarded, ipFamily(forwarded)) ? plainAddress(header('cf-connecting-ip')) : '';
  return edge || forwarded;
}
/** IPv6 clients usually own a whole /64; keying by prefix keeps one attacker from rotating around the limit. */
export function rateLimitKey(value) {
  const address = plainAddress(value) || String(value);
  if (isIP(address) !== 6) return address;
  const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
  const groups = value => value ? value.split(':').flatMap(part => part.includes('.') ? ['0', '0'] : [part]) : [];
  const left = groups(head), right = groups(tail), full = tail === null ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return full.slice(0, 4).map(part => parseInt(part || '0', 16).toString(16)).join(':') + '::/64';
}
/**
 * Fixed windows per key (real client plus action). A window is inserted when it opens, so the map stays in expiry order:
 * pruning stops at the first live window and a full map evicts the oldest one. Memory is bounded and no request scans the
 * whole table, even when many addresses keep it at capacity.
 */
export function createAccessLimiter({ capacity = 50000, windowMs = 60000, now = Date.now } = {}) {
  const windows = new Map();
  return {
    get size() { return windows.size; },
    hit(key, maximum, message) {
      const at = now();
      for (const [id, value] of windows) { if (value.until > at) break; windows.delete(id); }
      let entry = windows.get(key);
      if (!entry || entry.until <= at) {
        windows.delete(key); while (windows.size >= capacity) windows.delete(windows.keys().next().value);
        entry = { count: 0, until: at + windowMs }; windows.set(key, entry);
      }
      if (++entry.count > maximum) throw Object.assign(new Error(message), { status: 429, retryAfter: Math.max(1, Math.ceil((entry.until - at) / 1000)) });
    }
  };
}

// Operator diagnostics: never request bodies, cookies, query strings or tokens. Messages keep their shape, not their data.
// This runs on the single event loop for every unexpected failure, and library errors can carry kilobytes of remote data:
// the text is cut first (a cut word is dropped, never shown in half) and every pattern stays linear on what remains.
const LOG_SECRET_KEY = /authorization|cookie|token|password|passwd|secret|api[_-]?key|apikey|session|credential|mep_google/i;
function redactKeyedValues(text) {
  // key=value or key: value whose key names a secret. Only a secret's value is consumed, so a secret key inside a neutral
  // value (a=token=x) is still found; keys are bounded so a long run without a separator cannot backtrack.
  const key = /([\w-]{1,128})\s*[:=]\s*(?=[^\s,;&'"])/g, value = /[^\s,;&'"]+/y; let output = '', last = 0, match;
  while ((match = key.exec(text))) {
    if (!LOG_SECRET_KEY.test(match[1])) continue;
    value.lastIndex = key.lastIndex; value.test(text);
    output += text.slice(last, key.lastIndex) + '[oculto]'; last = key.lastIndex = value.lastIndex;
  }
  return output + text.slice(last);
}
export function redactLog(value, limit = 2000) {
  let text = String(value);
  if (text.length > limit) { let end = limit; if (!/\s/.test(text[limit])) while (end > 0 && !/\s/.test(text[end - 1])) end--; text = text.slice(0, end) + '…'; }
  // A quote left open (or cut) hides the rest of its line instead of leaking it.
  text = text.replace(/"[^"\n]*(?:"|$)/gm, '"…"')
    .replace(/\bbot\d{3,}:[\w-]{20,}/gi, 'bot[oculto]').replace(/\b\d{6,}:[\w-]{30,}\b/g, '[oculto]')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, '$1 [oculto]');
  return redactKeyedValues(text)
    .replace(/([?&][^=\s&#]{1,64}=)[^\s&#]+/g, '$1[oculto]').replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi, '$1[oculto]@')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[oculto]');
}
export function describeError(error) {
  try {
    if (!error || typeof error !== 'object' || typeof error.message !== 'string') return { type: error === null ? 'null' : typeof error };
    const stack = String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 12).map(line => redactLog(line.trim()).slice(0, 300));
    return { name: redactLog(String(error.name || 'Error')).slice(0, 60), ...(error.code !== undefined ? { code: redactLog(String(error.code)).slice(0, 60) } : {}), message: redactLog(error.message).slice(0, 300), stack };
  } catch { return { type: 'object' }; }
}
const ROUTE_COLLECTIONS = new Set(['tenants','conversations','contacts','channels','agents','flows','departments','users','invitations','sessions','accounts','plans','grants','contracts','invoices','service-principals','rooms','servers','sources','runs','attachments','quick-replies','receipts','agent-admin-proposals','memories','webchat','service-handoffs','follow-ups','tools','jobs']);
const ROUTE_WORDS = new Set(['usage', 'import', 'sync', 'invitations']);
/** Route shape for logs: identifiers become :id and the query string is never included. */
export function routePattern(url) {
  const path = String(url || '').split(/[?#]/)[0];
  if (!path.startsWith('/api/')) return staticFiles[path] || publicWidgetAssets.has(path) ? path : '/:arquivo';
  const segments = path.split('/').slice(1, 15);
  return '/' + segments.map((segment, index) => index > 1 && ROUTE_COLLECTIONS.has(segments[index - 1]) && !ROUTE_WORDS.has(segment) || !/^[a-z][a-z0-9-]{0,40}$/.test(segment) || /\d/.test(segment) && !/^v\d{1,2}$/.test(segment) ? ':id' : segment).join('/');
}
// Transport/socket failures escaping a provider (Baileys, Telegram, PostgreSQL) do not corrupt the SQLite state or the
// other sessions: log and continue. Anything else leaves the process in an unknown state (Node guidance): stop safely.
const RECOVERABLE_CODES = new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','EPIPE','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH','ENETDOWN','EPROTO','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END','ERR_STREAM_PREMATURE_CLOSE','ERR_SOCKET_CLOSED','UND_ERR_SOCKET','UND_ERR_CLOSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_ABORTED']);
// fetch wraps the socket failure in a TypeError('fetch failed'), so one level of cause is read as well.
export function isRecoverableProcessError(error) {
  try {
    if (!error || typeof error !== 'object') return false;
    const cause = error.cause && typeof error.cause === 'object' ? error.cause : null;
    return error.isBoom === true || RECOVERABLE_CODES.has(error.code) || ['AbortError', 'TimeoutError'].includes(error.name) || Boolean(cause && RECOVERABLE_CODES.has(cause.code));
  } catch { return false; }
}
// Unhandled rejections follow the same rule as exceptions (Node's default is to stop on both): transport failures share
// one budget and keep the sessions; any other reason, including a non-Error value, stops safely for the restart policy.
export function installProcessGuards({ onFatal = () => process.exit(1), log = console.error, maxRecoverable = 10, windowMs = 60000, target = process } = {}) {
  let recent = [];
  const record = (message, value) => { try { log(message, JSON.stringify(describeError(value))); } catch { log(message); } };
  const guard = (error, messages) => {
    const now = Date.now(); recent = recent.filter(at => now - at < windowMs);
    const recoverable = isRecoverableProcessError(error) && recent.length < maxRecoverable;
    if (recoverable) recent.push(now);
    record(recoverable ? messages[0] : messages[1], error);
    if (!recoverable) try { onFatal(error); } catch { process.exit(1); }
  };
  const rejection = reason => guard(reason, ['Promessa rejeitada por falha de transporte; conexões e sessões mantidas.', 'Promessa rejeitada sem tratamento; encerrando com segurança para reinício.']);
  const exception = error => guard(error, ['Falha de transporte sem tratamento; conexões e sessões mantidas.', 'Exceção sem tratamento; encerrando com segurança para reinício.']);
  target.on('unhandledRejection', rejection); target.on('uncaughtException', exception);
  return () => { target.off('unhandledRejection', rejection); target.off('uncaughtException', exception); };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MEPCHAT_PORT || 4318);
  const app = createApp({postgres:true,conversationJournal:process.env.MEPCHAT_CONVERSATION_JOURNAL==='true'});
  let stopping=false,mediaCleanup=null,mediaDeletionSweep=null;
  // Graceful stop. A fatal error exits 1 (the container restart policy brings it back) with a hard limit if a close hangs;
  // a failing close is logged and never leaves the process half-stopped.
  const stop = async (code=0) => {
    if(stopping)return;stopping=true;let exitCode=code;
    if(code)setTimeout(()=>process.exit(code),10000).unref();
    try{clearInterval(mediaCleanup);clearInterval(mediaDeletionSweep);app.stopScheduler();await app.scheduled.waitIdle().catch(()=>{});await app.centralSupport.close();await app.autopilot.close();await Promise.all([app.gateway.close(), app.telegram.close(),app.telegramUser.close(),app.email.close(),app.webchat.close(),app.emailChannel.close(),app.meta.close()]); await app.bridge.flush().catch(()=>{}); await app.bridge.close();}
    catch(error){exitCode=1;console.error('Encerramento com pendências; dados locais preservados.',JSON.stringify(describeError(error)));}
    app.server.close(() => { try{app.store.close();}finally{process.exit(exitCode);} });
  };
  installProcessGuards({onFatal:()=>stop(1)});
  app.scheduled.recover();
  await app.loadIntegrations();
  await app.cleanupMedia().catch(()=>console.error('Limpeza de anexos adiada; arquivos preservados.'));
  mediaCleanup=setInterval(()=>app.cleanupMedia().catch(()=>{}),86400000);mediaCleanup.unref();
  // Files of deleted accounts queued in media_deletion_spool (a crash between COMMIT and unlink is completed here).
  await app.media.sweepDeletionSpool().catch(()=>console.error('Remoção de anexos de contas excluídas adiada; fila preservada.'));
  mediaDeletionSweep=setInterval(()=>app.media.sweepDeletionSpool().catch(()=>{}),300000);mediaDeletionSweep.unref();
  await app.bridge.start().catch(()=>console.error('PostgreSQL indisponível; gravações locais preservadas.'));
  // After the vault is loaded (loadIntegrations): recovery of interrupted jobs plus the periodic drain of the autopilot.
  try{app.autopilot.start({intervalMs:5000});}catch{console.error('Piloto automático não iniciou; mensagens preservadas para a equipe.');}
  app.server.listen(port,process.env.MEPCHAT_BIND_ADDRESS||'127.0.0.1', () => {
    console.log(`Elozi ${appVersion} · ${process.env.MEPCHAT_PUBLIC_ORIGIN||`http://127.0.0.1:${port}`}`);
    Promise.allSettled([app.gateway.restore(),app.telegram.restore(),app.telegramUser.restore()]).then(results=>{
      for(const [index,result] of results.entries())if(result.status==='rejected')console.error(`Uma conexão ${index===0?'WhatsApp':'Telegram'} não pôde ser retomada.`);
      if(stopping)return;
      app.startScheduler();
    });
  });
  process.on('SIGINT', ()=>stop(0)); process.on('SIGTERM', ()=>stop(0));
}
