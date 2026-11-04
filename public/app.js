import { t, txt, html, h, raw, markup, labels, getLocale, setLocale, translateStatic, translateError } from './i18n.js';
import './locales-shell.js';
import { icon } from './icons.js';
import { toasts, installUI, emptyState, companyMark, messageTextMarkup, badge as uiBadge, kbd, tabs as uiTabs, tabPanel, avatar as uiAvatar } from './ui.js';
import { deriveBrandTokens, applyBrandTokens } from './brand-theme.js';
import { createBrandDrafts } from './brand-drafts.js';
import { createJsonRead } from './json-read.js';
import { canSyncDeviceRead, readStateCommand, readActionLabel, readSyncNotice, attendanceResponseIsCurrent, canRefreshDeviceReads, deviceReadStateNotice } from './attendance-read-ui.js';
import { createModalRouteLifecycle, modalRouteContext, modalScopeContext } from './modal-route-lifecycle.js';
import { syncThemePrefs, updateThemePrefs, motionOK } from './theme-prefs.js';
import { parseHash, formatHash } from './router.js';
import { navContext, legacyVisible, resolveView, viewForRoute, routeForView, hashForView, conversationHash, navigationDescriptions, HUBS, SCREEN_VIEWS } from './nav-config.js';
import { shellMarkup, shellLayout, shellTitle, shellCrumbs, menuEntries, sidebarNav, shortcutsMarkup, installShell, setShellDrawer, applyShellLayout, setShellChoice, setShellPresence, applyFavicon, shellNoticeDismissed, dismissShellNotice, SHELL_MOBILE_QUERY, SHELL_WIDE_QUERY, SHELL_XWIDE_QUERY } from './shell-ui.js';
import { captureLocaleFormState, restoreLocaleFormState } from './locale-ui.js';
import { createOverviewMarkup } from './overview-ui.js';
import { createCustomerContextUI } from './customer-context-ui.js';
import { createGuideMarkup } from './guide-ui.js';
import { createServiceHandoffsUI } from './service-handoffs-ui.js';
import { mountGoogleButton } from './google-ui.js';
import { createWorkspaceUI, clientRecordMarkup } from './workspace-ui.js';
import { createContactRefresh } from './contact-refresh.js';
import { createContactLinksUI } from './contact-links-ui.js';
import { createMediaUI } from './media-ui.js';
import { channelCapabilities, conversationCapabilities, assertChannelText, textLength } from './channel-capabilities.js';
import { createTelegramAccountUI } from './telegram-account-ui.js';
import { createTelegramGroupsUi } from './telegram-groups-ui.js';
import { flowEditorGraph, validateFlowEditorGraph, flowDepartmentOptions } from './flow-departments-ui.js';
import { createFlowTemplate, createFlowDraftGuard } from './flow-workspace-ui.js';
import './locales-product-review.js';
import { createVoiceRecorder } from './voice-recorder.js';
import { createSendIntent } from './send-intent.js';
import { installPendingSendUnloadGuard } from './send-unload-guard.js';
import './locales-send-recovery.js';
import { createInboxTimeline, earlierMarkup } from './inbox-live.js';
import { createRepliesUI } from './replies-ui.js';
import { createChatLayout } from './chat-layout.js';
import { createAutomationUI } from './automation-ui.js';
import { createAvatarUI } from './avatar-ui.js';
import { createIntegrationsUI } from './integrations-ui.js';
import { createAccountSecurityUI } from './account-security-ui.js';
import { createMcpUI } from './mcp-ui.js';
import { createAgentRail, activeRunStates } from './agent-rail-ui.js';
import { createKnowledgeUI } from './knowledge-ui.js';
import { createAgentMemoryUI } from './agent-memory-ui.js';
import { selectAttendance, attendanceCounts, attendanceHistory, createInternalNoteDrafts } from './attendance-ui.js';
import { createConversationTools } from './conversation-tools.js';
import { createFollowUpsUI } from './follow-ups-ui.js';
import { createGroupHistoryImportUI } from './group-history-import-ui.js';
import { createForwarding } from './forwarding.js';
import { createParticipantsUI, attendanceReplyAccess, attendanceParticipantRole, attendanceManagementAccess } from './participants-ui.js';
import { createConsolidatedInboxUI, inboxIdentity, inboxChoice } from './consolidated-inbox-ui.js';
import { inboxRouteFilters, inboxFilterQuery } from './inbox-route-filters.js';
import './locales-inbox-route-recovery.js';
import { createContactImportUI } from './contact-import-ui.js';
import { createPlatformUsersUI } from './platform-users-ui.js';
import { createConnectedProductsUI } from './connected-products-ui.js';
import { createTeamChatUI } from './team-chat-ui.js';
import { createSupportUI } from './support-ui.js';
import { createServicePrincipalsUI } from './service-principals-ui.js';
import { renderSupportAssistant, bindSupportAssistant } from './support-assistant-ui.js';
import { renderAgentAdminProposals, bindAgentAdminProposals } from './agent-admin-proposals-ui.js';
import { createBillingUI } from './billing-ui.js';
import { createAccountsUI } from './accounts-ui.js';
import { createCommercialUsageUI } from './commercial-usage-ui.js';
import { createGroupsWorkspaceUI } from './groups-workspace-ui.js';
import { createPlansUI } from './plans-ui.js';
import { createSubscriptionUI } from './subscription-ui.js'; /*@subscription:import*/
import { createAccountDeletionUI, ownerEligible as accountDeletionEligible, ownerSectionMarkup as accountDeletionSection, afterSelfDeletionUrl } from './account-deletion-ui.js';
import { createChannelConnectorsUI } from './channel-connectors-ui.js';
import { createWorkspaceDomainsUI } from './workspace-domains-ui.js';
import { createUnitsUI } from './units-ui.js';
import { createAccountInvitationsUI } from './account-invitations-ui.js';
// Seams of FRONTEND-V2 §8.1 (commit 1f): the packages of wave 1 rewrite these modules, never app.js.
import { registerAction, registerActions, registerScreen, dispatchAction, dispatchSubmit } from './actions.js';
import { createLive } from './live.js';
import { createConnectionStatus } from './connection-status.js';
import { sessionExpired, reauthPending } from './session-guard.js';
import { createDataSource } from './data-source.js';
import { createAttention } from './attention.js';
import { createNotify } from './notify.js';
import { keyboard } from './keyboard.js';
import { createCommandPalette } from './command-palette.js';
import { createComposerBridge, composerModeMarkup, composerOriginMarkup, composerChoiceMarkup } from './composer-ui.js';
// Atendimento v2 (FRONTEND-V2 §5.2, P3): keyed list with frozen order, timeline window and the context tabs.
import { inboxListMarkup, createInboxList, defaultLens, autopilotOn, INBOX_PAGE, INBOX_MAX_ROWS } from './inbox-list-ui.js';
import { replyPace } from './agent-pace.js';
import { createAgentsHub } from './agents-hub-ui.js';
import { createChannelsUI } from './channels-ui.js';
import { createChannelVisitorTestUI } from './channel-visitor-test-ui.js';
let channelVisitorTestUI=null;
import { createAgentConnectWizard } from './agent-connect-wizard.js';
import { createPending } from './pending-ui.js';
import { createOnboarding, loadPortfolio, onHomeData } from './onboarding-ui.js';
import { createSettings, screenFrame } from './settings-ui.js';
setLocale(getLocale(), { persist: false, notify: false });
translateStatic(document);
installUI(document);
// Shell popovers (scope, account, "Mais"): installed before the app's own keydown listeners so Esc
// closes an open popover first and leaves the drawer and the expanded chat for the next Esc.
const shellUI = installShell(document, { onNoticeDismiss: () => { if (state.boot) dismissShellNotice(state.boot.session.userId); } });
const $ = selector => document.querySelector(selector);
const readJsonResponse = createJsonRead();
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const state = { boot: null, tenant: null, workspaceId: null, view: 'overview', conversation: null, inboxCompany:'all',assignedUser:'all',inboxSelecting:false,inboxSelectionSequence:0, filter: 'all', search: '', channel: 'all', status: 'active', unread:false,department:'all',kind:'all',sort:'recent',composerMode:'reply',busy: false, brandScope: 'tenant', users: [], flows: [], flowId: null, flowDraft: null, flowNode: null, flowDirty: false, flowResult: null, profileDraft: null, avatarLoading: false, contextCollapsed: matchMedia('(max-width: 1279.98px)').matches, menuOpen: false, mobileChat:false };
const brandDrafts = createBrandDrafts();
const modalRouteLifecycle = createModalRouteLifecycle({ getModal: () => $('#modal'), getContext: () => modalRouteContext(state), getScopeContext: () => modalScopeContext(state),
  getRoute: () => { const route = parseHash(location.hash); return route && viewForRoute(route) === state.view && (!route.workspaceId || route.workspaceId === state.workspaceId) ? location.hash : currentRouteHash(); },
  confirmDiscard: () => globalThis.confirm(`${t('Descartar alterações?')}\n\n${t('O que você preencheu neste formulário ainda não foi salvo.')}`),
  protectedNavigation: modal => Boolean(state.routeIntent || modal.querySelector('[data-flow-draft-guard]')) });
// Default lens of the inbox (§5.2.2): Comigo for an attendant, Todos for an admin, until the person
// picks a lens in this workspace (changeInboxFilter records the choice).
{ let lens = 'all'; Object.defineProperty(state, 'filter', { enumerable: true, configurable: true, get() { return state.boot && state.lensWorkspace !== state.workspaceId ? defaultLens(state.boot.session) : lens; }, set(value) { lens = value; } }); }
const channelNames = labels({ whatsapp_qr: 'WhatsApp · QR Code', whatsapp_cloud: 'WhatsApp · Cloud API', telegram: 'Telegram', telegram_user:'Telegram pessoal', instagram: 'Instagram', messenger: 'Messenger', webchat: 'Webchat', email: 'Email' });
/*@anchor:provider-names*/
const providerNames = labels({ hermes: 'Hermes', mcp: 'Agente via MCP', claude: 'Claude', codex: 'Codex', webhook: 'API / webhook' });
/*@end:provider-names*/
const statusNames = labels({ open: 'Aberta', pending: 'Pendente', closed: 'Encerrada' });
const runNames = labels({ queued: 'Na fila', running: 'Preparando resposta', waiting_approval: 'Aguardando sua aprovação', tool_running: 'Executando ferramenta', tool_unknown: 'Execução não confirmada', rejected: 'Ferramenta recusada', draft: 'Rascunho pronto', completed: 'Rascunho pronto', succeeded: 'Rascunho pronto', cancelled: 'Cancelada', invalidated: 'Contexto atualizado', stale: 'Contexto atualizado', failed: 'Falha', pending: 'Aguardando' });
const badge = (text, type = 'neutral') => html`<span class="badge ${type}">${escape(text)}</span>`;
const button = (label, action, variant = '', glyph = '') => html`<button class="button ${variant}" data-action="${action}">${glyph ? icon(glyph) : ''}${escape(label)}</button>`;
/*@anchor:channel-helpers*/
const channels = () => state.tenant?.channels || [];
const channelFor = conversation => channels().find(channel => channel.id === conversation?.channelId);
const isRealConversation = conversation => ['baileys','telegram-bot','telegram-user','elozi-webchat','mepmail-channel','meta-instagram','meta-messenger'].includes(channelFor(conversation)?.transport);
const capabilitiesFor = conversation => {const channel=channelFor(conversation);return conversationCapabilities(channel?.capabilities||channelCapabilities(channel),conversation?.channelAvailability,channel?.transport);};
const supportsMedia = conversation => capabilitiesFor(conversation).uploadKinds.length > 0;
const supportsVoice = conversation => capabilitiesFor(conversation).voice;
const supportsAvatar = conversation => capabilitiesFor(conversation).avatar;
const windowOpen = conversation => !conversation?.channelAvailability?.replyWindow || conversation.channelAvailability.replyWindow.open && Date.parse(conversation.channelAvailability.replyWindow.expiresAt)>Date.now();
const groupOpen = conversation => conversation?.channelAvailability?.group?.canSend !== false;
const canSendTo = conversation => canReplyTo(conversation) && windowOpen(conversation) && groupOpen(conversation);
const supportsQuote = conversation => !['meta-instagram','meta-messenger'].includes(channelFor(conversation)?.transport);
const transportName = conversation => ({whatsapp_qr:'WhatsApp',telegram:'Telegram',telegram_user:'Telegram',webchat:'Webchat',email:'E-mail',instagram:'Instagram',messenger:'Messenger'}[channelFor(conversation)?.kind]||t('Canal'));
/*@end:channel-helpers*/
const connectionStateNames = labels({ disconnected: 'Desconectado', starting: 'Iniciando', qr: 'Aguardando QR', connecting: 'Conectando', reconnecting: 'Reconectando', connected: 'Conectado', logged_out: 'Sessão encerrada', wrong_number: 'Número diferente', failed: 'Falha de conexão', configured:'Configurado · validar recebimento' });
const time = date => new Date(date).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
const roleLabel = user => user.platformOwner || user.platformAdmin ? t('Administrador da plataforma') : user.role === 'reseller' ? state.boot?.reseller.accountKind==='business'?t('Administrador da empresa'):t('Administrador da revenda') : t('Atendente');
const avatarUI = createAvatarUI({ escape, context: () => ({ userId: state.boot?.session.userId, workspaceId: state.workspaceId, tenantId: state.tenant?.id, tenantIds: (state.boot?.tenants || []).map(tenant => tenant.id), accessVersion: JSON.stringify([state.boot?.csrfToken || state.boot?.session.csrfToken,state.boot?.session.role,state.boot?.session.permissions,state.boot?.session.scopeRules,state.supportGrantId,state.boot?.session.supportExpiresAt]) }) });
const avatarMarkup = avatarUI.markup;
const conversationAvatar = (c, cls = 'mint') => avatarMarkup(c.contact, c.avatar, cls, supportsAvatar(c) ? { kind: 'conversations', id: c.id } : null);
const contactAvatar = (c, cls = 'mint') => avatarMarkup(c.name, c.avatar, cls, c.identities?.length ? { kind: 'contacts', id: c.id } : null);
/*@anchor:permissions-attendance*/
/*@anchor:permissions*/
const hasPermission = permission => {
  const session = state.boot?.session;
  return Boolean(session && (session.role === 'reseller' || session.permissions == null || session.permissions.includes(permission)));
};
/*@end:permissions*/
/*@anchor:reply-access*/
const canReplyTo = c => attendanceReplyAccess(c,{userId:state.boot?.session.userId,hasPermission:hasPermission('inbox.reply'),selecting:state.inboxSelecting});
/*@end:reply-access*/
const attendanceRole = c => attendanceParticipantRole(c,{userId:state.boot?.session.userId});
const canCoordinate = c => canReplyTo(c)&&attendanceRole(c)==='responsible';
/*@end:permissions-attendance*/
const canManageAttendance = c => attendanceManagementAccess(c,{userId:state.boot?.session.userId,role:state.boot?.session.role,hasPermission:hasPermission('inbox.transfer')});
// The agent of a conversation owned by an agent (its name is shown instead of a generic label).
const conversationAgent = c => c?.owner==='agent'&&c.agentId?(state.tenant?.agents||[]).find(agent=>agent.id===c.agentId)||null:null;
const ownerLabel = c => c.assignedUserId===state.boot.session.userId?(c.assignedUserName||state.boot.session.name)+t(' · Com você'):c.assignedUserId?c.assignedUserName||t('Com a equipe'):c.owner==='agent'?(conversationAgent(c)?.name?t('Com {agent}',{agent:conversationAgent(c).name}):t('Copiloto atribuído')):t('Na fila');

/*@anchor:api*/
async function api(path, options = {}) {
  const csrf = state.boot?.csrfToken || state.boot?.session?.csrfToken;
  const { response, result, parsed } = await readJsonResponse(path, { ...options, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(state.workspaceId ? { 'X-Elozi-Workspace': state.workspaceId } : {}), ...(state.supportGrantId?{'X-Elozi-Support-Grant':state.supportGrantId}:{}), ...options.headers } });
  const incorrectCurrentPassword = path === '/api/auth/password/change' && response.status === 401 && result?.error === 'Senha atual incorreta.';
  if (response.status === 401 && !incorrectCurrentPassword) { sessionExpired({ reason: 'session-expired', initial: !state.boot?.session||state.starting&&!state.workspaceReady, abort: () => { channelVisitorTestUI?.reset();state.refreshSequence=(state.refreshSequence||0)+1;state.scopedRunsEpoch=(state.scopedRunsEpoch||0)+1;contactLinksUI.reset();contactRefresh.reset();memoryUI.reset(); }, discard: () => { mediaUI.reset();state.sendIntent=null;if(typeof followUpsUI!=='undefined')followUpsUI.reset(); } }); throw Object.assign(new Error(t('Entre para continuar.')), { status: 401 }); }
  if (!response.ok) {
    const fallback = response.status === 413 ? t('O arquivo excede o limite de envio. Reduza o tamanho ou divida a importação em lotes.') : [502, 503].includes(response.status) ? t('O serviço está temporariamente indisponível. Tente novamente em alguns instantes.') : t('Não foi possível concluir a solicitação. Tente novamente.');
    const message = [413, 502, 503].includes(response.status) ? fallback : typeof result?.error === 'string' && result.error.trim() ? result.error : fallback;
    throw Object.assign(new Error(typeof result?.error === 'string' ? translateError(message) : message), { status: response.status,...(/^(?:account_delete_[a-z_]+|OUTBOUND_(?:UNCONFIRMED|FAILED|REGISTERED)|DEMO_COMPANY|subscription_exists|manual_contract|not_owner|same_order|subscription_pending|plan_limit|billing_checkout_pending|billing_unsupported_items)$/.test(result?.code||'')/*@subscription:codes*/?{code:result.code}:{}) });
  }
  if (!parsed) throw Object.assign(new Error(t('O servidor retornou uma resposta inválida. Tente novamente.')), { status: response.status });
  return result;
}
/*@end:api*/
const tenantApi = action => `/api/tenants/${encodeURIComponent(state.tenant.id)}${action ? '/' + action : ''}`;
/*@anchor:inbox-selection-state*/
const selectedInboxRef=()=>state.workspaceId&&state.tenant?.id&&state.conversation?{workspaceId:state.workspaceId,tenantId:state.tenant.id,conversationId:state.conversation}:null;
/*@end:inbox-selection-state*/
// GETs of the live poll (data-source.js, P2): inbox page, tenant DTO and runs of the open conversation.
const dataSource=createDataSource({request:api});
const consolidatedInbox=createConsolidatedInboxUI({request:api,dataSource,context:()=>({workspaceId:state.workspaceId,userId:state.boot?.session.userId,authorityKey:JSON.stringify([state.boot?.session.role,state.boot?.session.platformOwner,state.boot?.session.permissions,state.boot?.session.scopeRules,(state.boot?.tenants||[]).map(t=>t.id)])})});
const contactImportUI=createContactImportUI({getContext:()=>({userId:state.boot?.session.userId,workspaceId:state.workspaceId,tenantId:state.tenant?.id,channels:state.tenant?.channels||[],canWrite:hasPermission('contacts.write')}),request:api,openModal,escape,icon,refresh,toast});
const platformUsersUI=createPlatformUsersUI({request:api,openModal,escape,getModal:()=>$('#modal'),onRender:render,getContext:()=>({workspaceId:state.workspaceId,userId:state.boot?.session.userId,platformOwner:Boolean(state.boot?.session.platformOwner),supportGrantId:state.supportGrantId,active:state.view==='platform-users',authorityKey:inboxContactAuthority()}),toast});
const connectedProductsUI=createConnectedProductsUI({request:api,onRender:()=>{if(state.view==='connected-products')render();},getContext:()=>({workspaceId:state.workspaceId,supportGrantId:state.supportGrantId}),toast,openChannels:async tenantId=>{if(await changeTenant(tenantId))navigate('channels');}});
const teamChatUI=createTeamChatUI({getContext:()=>({active:state.view==='team-chat',workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot?.session.userId,isAdmin:state.boot?.session.role==='reseller',authorityKey:state.boot?.csrfToken||state.boot?.session.csrfToken,tenantName:state.tenant?.name,conversations:state.tenant?.conversations||[]}),request:api,openModal,getModal:()=>$('#modal'),getConversations:()=>state.tenant?.conversations||[],avatarHTML:person=>avatarMarkup(person.name,person.avatar,'small navy'),onRender:()=>avatarUI.bind(),onOpenConversation:async(cid,tenantId)=>{teamChatUI.reset();navigate('inbox');await selectInboxConversation(tenantId,cid);},onError:message=>toast(message,true)});
/*@anchor:groups-workspace-ui*/
const groupsWorkspaceUI=createGroupsWorkspaceUI({
  api,escape,toast,openModal,getModal:()=>$('#modal'),
  context:()=>({active:(state.view==='groups'||state.view==='inbox')&&hasPermission('inbox.read'),workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot?.session.userId,authorityKey:JSON.stringify([inboxContactAuthority(),state.boot?.session.supportExpiresAt||null]),canSummarize:hasPermission('inbox.reply'),canManageChannels:state.boot?.session.role==='reseller',canReadInbox:hasPermission('inbox.read'),supportGrantId:state.supportGrantId||state.boot?.session.supportGrantId||null,kind:state.boot?.session.kind||'human',csrfToken:state.boot?.csrfToken||state.boot?.session.csrfToken||'',boot:state.boot,session:state.boot?.session}),
  avatar:group=>avatarUI.markup(group.title,null,'',{kind:'conversations',id:group.conversationId}),
  onPaint:()=>avatarUI.bind(),
  getAgents:()=>state.tenant?.agents||[],
  openConversation:openGroupConversation
});
async function openGroupConversation(conversationId,tenantId,{intent=null}={}) {
  if(state.view!=='groups'||state.tenant?.id!==tenantId||!hasPermission('inbox.read'))return;
  const authority=inboxContactAuthority(),boot=state.boot,session=state.boot.session;
  const sameAuthority=()=>state.boot===boot&&state.boot.session===session&&inboxContactAuthority()===authority;
  const conversation=await selectInboxConversation(tenantId,conversationId,{fromContact:true,isCurrent:()=>state.view==='groups'&&state.tenant?.id===tenantId&&sameAuthority()});
  if(!conversation||!sameAuthority()||state.view!=='inbox'||state.tenant?.id!==tenantId||state.conversation!==conversationId)return;
  if(intent==='reply'){
    if(!canReplyTo(conversation)){toast(t('Assuma este atendimento antes de responder ao grupo.'),true);return;}
    setComposerMode('reply');
  }else if(intent==='schedule'){
    if(!canCoordinate(conversation)){toast(t('O responsável pelo atendimento pode agendar mensagens para o grupo.'),true);return;}
    await attendanceAction('schedule-message');
  }
}
/*@end:groups-workspace-ui*/
// Older messages of a direct WhatsApp QR conversation (same dialog and limits as groups; group-history-import.js).
const directHistoryUI=createGroupHistoryImportUI({api,escape,toast,openModal,getModal:()=>$('#modal'),
  getContext:()=>({active:state.view==='inbox'&&hasPermission('inbox.read'),workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot?.session.userId,authorityKey:JSON.stringify([inboxContactAuthority(),state.boot?.session.supportExpiresAt||null]),canManageChannels:state.boot?.session.role==='reseller',canReadInbox:hasPermission('inbox.read'),supportGrantId:state.supportGrantId||state.boot?.session.supportGrantId||null,kind:state.boot?.session.kind||'human',csrfToken:state.boot?.csrfToken||state.boot?.session.csrfToken||'',boot:state.boot,session:state.boot?.session}),
  onFinished:async()=>{await refresh();render();}});
const directHistoryAllowed=conversation=>{const channel=channelFor(conversation);return Boolean(conversation&&conversation.conversationKind!=='group'&&channel?.kind==='whatsapp_qr'&&channel.transport==='baileys'&&state.boot?.session.role==='reseller'&&!state.supportGrantId&&!state.boot?.session.supportGrantId&&hasPermission('inbox.read'));};
/*@anchor:support-factories*/
const supportUI=createSupportUI({state,escape,api,openModal,closeModal:()=>$('#modal').close(),toast,render,setSupportContext:context=>changeWorkspace(context?.workspaceId||null,context?.grantId||null)});
const servicePrincipalsUI=createServicePrincipalsUI({getContext:()=>({workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot?.session.userId,authorityKey:JSON.stringify([state.boot?.session.role,state.supportGrantId]),isAdmin:state.boot?.session.role==='reseller'&&!state.supportGrantId,publicOrigin:state.boot?.canonicalPublicOrigin||state.boot?.publicOrigin,agents:state.tenant?.agents||[],channels:state.tenant?.channels||[],departments:state.tenant?.departments||[]}),request:api,openModal,getModal:()=>$('#modal'),toast,onUpdate:render});
const billingUI=createBillingUI({state,escape,icon,api,openModal,render,toast,openPlans:()=>plansUI.open()});
const plansUI=createPlansUI({state,api,escape,openModal,toast,getModal:()=>$('#modal'),render:()=>render(),onDraft:draft=>billingUI.openFromPlan(draft)});
/*@subscription:create*/
const subscriptionUI=createSubscriptionUI({request:api,toast,onRender:()=>{if(state.view==='billing')render();},getContext:()=>({workspaceId:state.workspaceId,eligible:state.boot?.session?.role==='reseller'&&state.boot?.reseller?.accountKind==='business'&&!state.supportGrantId&&!state.boot?.session?.platformOwner,authorityKey:JSON.stringify([state.boot?.session?.userId,state.boot?.csrfToken||state.boot?.session?.csrfToken])})});
registerScreen('subscription',{act:(name,id)=>subscriptionUI.act(name,id)});
// LGPD account deletion: owner section in Financeiro, platform action in the accounts view (same dialog).
let accountDeletionInstance=null;const accountDeletionUI={open:input=>(accountDeletionInstance||=createAccountDeletionUI({request:api,openModal,getModal:()=>$('#modal'),toast,onDeleted:async({mode})=>{if(mode==='self'){location.assign(afterSelfDeletionUrl(getLocale()));return;}$('#modal')?.close?.();await accountsUI.load(true);render();}})).open(input)};
registerScreen('account-deletion',{act:async name=>{if(name!=='account-deletion:open')return false;await accountDeletionUI.open({mode:'self',workspaceId:state.workspaceId,name:state.boot?.reseller?.name||''});return true;}});
// Stripe return (?billing=success|cancel&workspace=<id>): strip the query, open Financeiro and let the UI poll the API.
async function handleSubscriptionReturn(){const query=new URLSearchParams(location.search),result=query.get('billing');if(result!=='success'&&result!=='cancel'&&result!=='portal')return;const target=query.get('workspace');history.replaceState(history.state,'',location.pathname+location.hash);if(target&&target!==state.workspaceId&&state.boot.workspaces?.some(item=>item.id===target))await changeWorkspace(target,null).catch(error=>toast(error.message,true));if(target!==state.workspaceId)return;navigate('billing');subscriptionUI.handleReturn(result,target).catch(error=>toast(error.message,true));}
/*@subscription:create:end*/
const telegramAccountUI=createTelegramAccountUI({state,api,company:()=>state.tenant,dialog:{open:openModal,get:()=>$('#modal')},i18n:{t},onUpdate:async()=>{await refresh();render();},toast});
const telegramGroupsUI=createTelegramGroupsUi({state,api,escape,openModal,toast,getModal:()=>$('#modal'),onUpdate:async()=>{await refresh();render();}});
const whatsappGroupsUI=createWhatsAppGroupsUI({state,api,escape,openModal,toast,getModal:()=>$('#modal'),onUpdate:result=>{const channel=state.tenant.channels.find(item=>item.id===result.channelId);Object.assign(channel,{enabledGroups:result.enabledGroups,whatsappGroupsVersion:result.version});render();}});
const channelConnectorsUI=createChannelConnectorsUI({state,api,escape,openModal,toast,getModal:()=>$('#modal'),onUpdate:async()=>{await refresh();render();},onTestJourney:({channelId,tenantId,workspaceId})=>{
  if(state.workspaceId!==workspaceId||state.tenant?.id!==tenantId||!channels().some(channel=>channel.id===channelId))return;
  location.hash=formatHash({section:'channels',params:{channelId,tab:'test'},query:{}});
}});
const workspaceDomainsUI=createWorkspaceDomainsUI({state,api,escape,openModal,toast,getModal:()=>$('#modal'),onUpdate:()=>accountsUI.load(state.view==='platform')});
const accountInvitationsUI=createAccountInvitationsUI({state,api,escape,openModal,getModal:()=>$('#modal'),toast,onUpdate:()=>accountsUI.load(state.view==='platform')});
const commercialUsageUI=createCommercialUsageUI({state,api,escape,icon,openModal,toast,getModal:()=>$('#modal')});
const accountsUI=createAccountsUI({state,api,escape,icon,openModal,render,toast,changeWorkspace,getModal:()=>$('#modal'),onUsage:account=>commercialUsageUI.open(account),onInvite:account=>accountInvitationsUI.open(account),onDomains:account=>workspaceDomainsUI.open(account),onDelete:account=>accountDeletionUI.open({mode:'platform',workspaceId:account.id,name:account.name}),onFinance:account=>openAccountFinance(account),onSupport:account=>openModal(t('Suporte à conta'),account.name,html`<div class="dialog-detail"><p>O administrador da conta pode conceder acesso em Suporte com prazo, escolhendo empresas, canais e validade. Depois disso, a conta aparece no seu seletor de acesso temporário.</p>${state.boot.session.platformOwner?markup('<p>Como administrador principal, você também pode usar o acesso administrativo registrado no painel de contas.</p>'):''}<button class="button" data-close-modal>Entendi</button></div>`),onOperationalAccess:account=>{state.accountAccessIntent={id:account.id,version:account.version,key:JSON.stringify([state.workspaceId,state.boot.session.userId,state.supportGrantId])};openModal(t('Acessar como administrador'),account.name,html`<form data-dialog-form="platform-account-access"><p>Seu acesso administrativo a esta conta será registrado. Você poderá gerenciar a operação, equipe, canais e agentes deste painel.</p><p>Esta ação é exclusiva do administrador principal e não concede acesso à revenda responsável.</p><p class="form-error" role="alert"></p><div class="modal-actions"><button class="button" type="button" data-close-modal>Cancelar</button><button class="button primary" type="submit">Registrar acesso e abrir painel</button></div></form>`);}});
const unitsUI=createUnitsUI({state,escape,icon,api,formModal,refresh,render,toast,getModal:()=>$('#modal'),changeTenant:id=>changeTenant(id)});
async function submitPlatformAccess(form){
  const intent=state.accountAccessIntent,key=()=>JSON.stringify([state.workspaceId,state.boot.session.userId,state.supportGrantId]);
  if(!intent||intent.key!==key()||!state.boot.session.platformOwner||state.supportGrantId||state.busy)return;
  const submit=form.querySelector('[type="submit"]');submit.disabled=true;
  try{
    const result=await api(`/api/accounts/${encodeURIComponent(intent.id)}/platform-access`,{method:'POST',body:JSON.stringify({version:intent.version})});
    if(state.accountAccessIntent!==intent||key()!==intent.key||!form.isConnected)return;
    if(result.workspaceId!==intent.id||!Array.isArray(result.workspaces))throw new Error(t('O acesso não foi confirmado. Atualize os dados da conta.'));
    state.boot.workspaces=result.workspaces;$('#modal').close();await changeWorkspace(intent.id,null);if(state.workspaceId===intent.id)navigate('overview');
  }catch(error){if(form.isConnected)form.querySelector('.form-error').textContent=error.message;}
  finally{if(form.isConnected)submit.disabled=false;}
}
/*@end:support-factories*/
/*@anchor:view-panels*/
async function loadViewPanels(){
  const view=state.view,sequence=state.viewPanelsSequence=(state.viewPanelsSequence||0)+1;
  const authorityKey=()=>JSON.stringify([state.workspaceId,state.supportGrantId||null,state.tenant?.id,state.boot?.session.userId,state.boot?.csrfToken||state.boot?.session.csrfToken,state.boot?.session.role,state.boot?.session.platformOwner,state.boot?.session.permissions,state.boot?.session.scopeRules,(state.boot?.tenants||[]).map(t=>t.id),state.refreshSequence,state.inboxRouteEpoch]);
  const authority=authorityKey(),current=()=>sequence===state.viewPanelsSequence&&view===state.view&&authority===authorityKey();
  try{
  if(view==='support'){
    if(state.boot.session.role==='reseller'){
      const supportTenants=await Promise.all(state.boot.tenants.map(t=>api(`/api/tenants/${encodeURIComponent(t.id)}`)));
      if(!current())return;
      state.supportTenants=supportTenants;
    }
    await supportUI.load();
  }
  if(view==='service-agents'||view==='overview'&&state.boot?.session.role==='reseller'&&!state.supportGrantId)await servicePrincipalsUI.load();
  if(view==='platform-users')await platformUsersUI.load();
  if(view==='automation')await automationUI.refresh();
  if(view==='knowledge')await knowledgeUI.load({force:true});
  if(view==='connected-products')await connectedProductsUI.load();
  if(['billing','platform-billing'].includes(view))await billingUI.load({renderAfter:false});
  if(['platform','accounts'].includes(view))await accountsUI.load(view==='platform');
  if(current())render();
}catch(error){if(current())toast(error.message,true);}}
/*@anchor:inbox-contact-authority*/
const inboxContactAuthority=()=>JSON.stringify([state.workspaceId,state.supportGrantId||null,state.boot?.session.userId,state.boot?.csrfToken||state.boot?.session.csrfToken,state.boot?.session.role,state.boot?.session.platformOwner,state.boot?.session.permissions,state.boot?.session.scopeRules,(state.boot?.tenants||[]).map(t=>t.id)]);
function focusedContactConversation(){
 const focus=state.inboxContactFocus,ref=selectedInboxRef();
 if(!focus||focus.authority!==inboxContactAuthority()||inboxIdentity(focus.ref)!==inboxIdentity(ref))return null;
 const c=state.tenant?.conversations.find(item=>item.id===ref.conversationId);if(!c)return null;
 const channel=channelFor(c),message=(c.messages||[]).findLast(item=>['customer','human','agent'].includes(item.kind)),attachment=message?.attachments?.[0];
 return {...c,tenantId:state.tenant.id,tenantName:state.tenant.name,conversationId:c.id,channelName:channel?.name||'',channelState:channel?.state||'disconnected',channelTransport:channel?.transport||null,preview:message?{text:String(message.text||'').slice(0,280),attachmentKind:attachment?.kind,attachmentName:attachment?.name?.slice(0,160)}:null};
}
/*@end:view-panels*/
function consolidatedList(){return String(inboxListMarkup({data:consolidatedInbox.data,filters:state,selection:selectedInboxRef(),focus:focusedContactConversation(),workspaceId:state.workspaceId,userId:state.boot?.session.userId,tenants:state.boot?.tenants||[],loading:consolidatedInbox.loading,error:consolidatedInbox.error,...inboxListExtras()}));}
/*@end:inbox-contact-authority*/
// Agents of the companies whose DTO this tab has seen: the owner=agent chip of a row says whether the
// agent answers alone (autopilot) only when it knows. The open company is refreshed by every poll; the
// snapshot of another company counts for one minute in the same access, then its rows say "Com agente"
// again (an admin may have switched the autopilot in another tab meanwhile).
const knownAgents=new Map(),KNOWN_AGENTS_MS=60000;
function inboxListExtras(){
 const session=state.boot?.session,admin=session?.role==='reseller'&&!state.supportGrantId,scope=JSON.stringify([state.workspaceId,state.supportGrantId||null]);
 if(state.tenant?.id&&Array.isArray(state.tenant.agents))knownAgents.set(state.tenant.id,{scope,at:Date.now(),agents:state.tenant.agents});
 const agentsOf=tenantId=>{const known=knownAgents.get(tenantId);return known&&known.scope===scope&&(tenantId===state.tenant?.id||Date.now()-known.at<KNOWN_AGENTS_MS)?known.agents:null;};
 return {agents:agentsOf,listGlyph:item=>agentRail.listGlyph(item),
  hasDraft:item=>Boolean(consolidatedInbox.getDraft({workspaceId:state.workspaceId,tenantId:item.tenantId,conversationId:item.conversationId||item.id})),
  presence:session?.presence||'available',canCreate:hasPermission('inbox.reply')&&channels().some(c=>c.transport==='baileys'&&c.state==='connected'),canManageChannels:admin};
}
// The list is patched by key on every update (inbox-list-ui.js): rows keep their nodes and the focus,
// and the order freezes under the pointer or the focus (new conversations wait behind the pill).
function updateConsolidatedList(){
 if(!$('#inbox-list'))return;
 inboxList.patch({data:consolidatedInbox.data,filters:state,selection:selectedInboxRef(),focus:focusedContactConversation(),workspaceId:state.workspaceId,userId:state.boot?.session.userId,tenants:state.boot?.tenants||[],loading:consolidatedInbox.loading,error:consolidatedInbox.error,...inboxListExtras()});
 avatarUI.bind();
 const nav=$('.nav-count');if(nav)nav.textContent=consolidatedInbox.data.counts.active||0;
}
/*@anchor:refresh-inbox-list*/
async function refreshInboxList({offset=0}={}){
 const promise=consolidatedInbox.load({...state},{offset});updateConsolidatedList();
 try{const result=await promise;if(result&&state.view==='inbox')updateConsolidatedList();return result;}
 catch(error){if(error.status===403){state.inboxCompany='all';state.channel='all';state.department='all';await refresh(state.tenant?.id,{skipInboxList:true});render();}updateConsolidatedList();throw error;}
}
/*@end:refresh-inbox-list*/
/*@anchor:drop-inbox-detail*/
function dropInboxDetail(tenantId){
 state.inboxOpeningController?.abort();state.inboxHistoryController?.abort();
 contactLinksUI.reset();contactRefresh.reset();memoryUI.reset();
 consolidatedInbox.forgetTenant(tenantId);mediaUI.forgetTenant(tenantId);if(state.tenant?.id!==tenantId)return;
 state.inboxSelectionSequence++;state.inboxSelecting=false;state.busy=false;state.conversation=null;state.renderedInboxRef=null;state.inboxContactFocus=null;state.contacts=[];state.flows=[];state.schedules=[];state.sendIntent=null;state.noteIntent=null;
 state.tenant={...state.tenant,conversations:[],runs:[],agents:[]};repliesUI.reset();voiceRecorder.reset();noteDrafts.reset();conversationTools.reset();forwarding.reset();participantsUI.reset();inboxTimeline.reset();contactImportUI.reset();
 if(state.view==='inbox')render();
}
/*@end:drop-inbox-detail*/
/*@anchor:select-inbox-conversation*/
const inboxMessagePages=new Map();
const inboxPageKey=(tenantId,conversationId)=>JSON.stringify([inboxContactAuthority(),tenantId,conversationId]);
const inboxOpeningError=()=>Object.assign(new Error(t('O servidor retornou dados inválidos do workspace. Tente novamente.')),{status:502});
const inboxOpeningController=()=>typeof AbortController==='function'?new AbortController():{signal:undefined,abort(){}};
function validateInboxWindow(page,conversationId,{older=false}={}){
 if(!page||!Array.isArray(page.messages)||page.messages.length>60||!Number.isSafeInteger(page.version)||page.version<1||typeof page.hasMore!=='boolean'||!page.cursor||page.cursor.before!==null&&typeof page.cursor.before!=='string')throw inboxOpeningError();
 const ids=new Set();for(const message of page.messages){if(!message||typeof message.id!=='string'||!message.id||ids.has(message.id)||typeof message.createdAt!=='string'||!Number.isFinite(Date.parse(message.createdAt)))throw inboxOpeningError();ids.add(message.id);}
 if(page.hasMore&&(!page.messages.length||page.cursor.before!==page.messages[0].id))throw inboxOpeningError();
 if(!older&&(!page.conversation||page.conversation.id!==conversationId||page.conversation.version!==page.version||!Number.isSafeInteger(page.messageCount)||page.messageCount<page.messages.length||!Array.isArray(page.runs)||page.runs.some(run=>!run||run.conversationId!==conversationId||Object.hasOwn(run,'memorySnapshot'))))throw inboxOpeningError();
 return page;
}
async function loadInboxOpening(ref,signal){
 const sameTenant=state.tenant?.id===ref.tenantId,snapshot=sameTenant?state.tenant:null;
 const [page,tenant]=await Promise.all([dataSource.conversationPage(ref.tenantId,ref.conversationId,{workspaceId:ref.workspaceId,signal,limit:60}),sameTenant?snapshot:dataSource.tenantSummary(ref.tenantId,{workspaceId:ref.workspaceId,signal})]);
 validateInboxWindow(page,ref.conversationId);
 if(!tenant||tenant.id!==ref.tenantId||!Array.isArray(tenant.conversations)||!Array.isArray(tenant.channels)||!sameTenant&&!tenant.conversations.some(item=>item.id===ref.conversationId))throw Object.assign(inboxOpeningError(),{status:403});
 const cached=tenant.conversations.find(item=>item.id===ref.conversationId),first=page.messages[0]?.id,index=Array.isArray(cached?.messages)?cached.messages.findIndex(item=>item.id===first):-1;
 if(cached?.version>page.version)throw Object.assign(inboxOpeningError(),{status:409});
 const messages=[...(index>0&&cached.version===page.version?cached.messages.slice(0,index):[]),...page.messages],conversation={...page.conversation,messages,messageCount:page.messageCount};
 const conversations=tenant.conversations.map(item=>item.id===conversation.id?conversation:{...item,messages:Array.isArray(item.messages)?item.messages:[]});if(!cached)conversations.push(conversation);
 const resultTenant={...tenant,conversations,runs:[...(tenant.runs||[]).filter(run=>run.conversationId!==conversation.id),...page.runs]};
 return {tenant:resultTenant,page:{before:messages[0]?.id||null,hasMore:messages.length<page.messageCount,messageCount:page.messageCount},
  contacts:sameTenant?state.contacts||[]:[],flows:sameTenant?state.flows||[]:[],assignees:sameTenant?state.assignees||[]:[],metrics:sameTenant?state.metrics||null:null,mcpServers:sameTenant?state.mcpServers||[]:[],mcpLoaded:sameTenant&&Boolean(state.mcpLoaded),overviewLoaded:sameTenant?state.overviewLoaded||{}:{contacts:false,assignees:false}};
}
async function hydrateInboxOpening(ref,{signal,current}){
 const base='/api/tenants/'+encodeURIComponent(ref.tenantId),headers={'X-Elozi-Workspace':ref.workspaceId};
 const tasks=[['contacts','/contacts?archived=true'],['flows','/flows'],['assignees','/assignees'],...(hasPermission('metrics.read')?[['metrics','/metrics']]:[]),...(state.boot.session.role==='reseller'?[['mcp','/mcp/servers']]:[])];
 await Promise.allSettled(tasks.map(async([name,tail])=>{
  let value=null;try{value=await api(base+tail,{headers,signal});}catch(error){if(error.name==='AbortError'||!current())return;}
  if(!current())return;
  if(name==='contacts'){state.contacts=value?.contacts||[];state.overviewLoaded={...state.overviewLoaded,contacts:Boolean(value)};updateClientRecord();}
  else if(name==='flows')state.flows=value?.flows||[];
  else if(name==='assignees'){state.assignees=value?.assignees||[];state.overviewLoaded={...state.overviewLoaded,assignees:Boolean(value)};}
  else if(name==='metrics')state.metrics=value;
  else{state.mcpServers=value?.servers||[];state.mcpLoaded=Boolean(value);}
 }));
}
function remoteInboxEarlierMarkup(conversation){
 const page=inboxMessagePages.get(inboxPageKey(state.tenant?.id,conversation?.id));if(!page||!conversation)return '';
 if(conversation.messages.length>=page.messageCount){page.hasMore=false;return '';}
 if(!page.hasMore||inboxTimeline.slice(conversation.messages,`${state.tenant?.id}:${conversation.id}`).hidden)return '';
 return earlierMarkup(Math.max(1,page.messageCount-conversation.messages.length)).replace('data-message-id="__earlier"','data-inbox-remote-earlier').replace('data-action="inbox:earlier"',`data-action="inbox:earlier"${page.loading?' disabled aria-busy="true"':''}`);
}
function syncRemoteInboxEarlier(element,conversation=currentConversation()){
 if(!element||!conversation)return;const markup=remoteInboxEarlierMarkup(conversation),old=element.querySelector('[data-inbox-remote-earlier]');
 if(!markup){old?.remove();return;}
 const template=document.createElement('template');template.innerHTML=markup;const fresh=template.content.firstElementChild;
 if(old){const control=old.querySelector('button'),next=fresh.querySelector('button');control.disabled=next.disabled;control.setAttribute('aria-busy',String(next.disabled));const label=control.querySelector('.ui-btn__label');if(label)label.textContent=next.querySelector('.ui-btn__label').textContent;if(element.firstElementChild!==old)element.insertBefore(old,element.firstElementChild);}
 else element.insertBefore(fresh,element.firstElementChild);
}
function installInboxPagination(timeline){const update=timeline.update;timeline.update=(element,messages,options)=>{const result=update(element,messages,options);if(state.view==='inbox')syncRemoteInboxEarlier(element);return result;};return timeline;}
async function showInboxEarlier(){
 const conversation=currentConversation(),timeline=$('#messages');if(!conversation||!timeline||state.inboxSelecting)return;
 const focusAtStart=document.activeElement,restoreTimelineFocus=timeline.contains(focusAtStart);
 const tenantId=state.tenant.id,conversationId=conversation.id,authority=inboxContactAuthority(),selection=state.inboxSelectionSequence,key=inboxPageKey(tenantId,conversationId),page=inboxMessagePages.get(key);
 const current=()=>state.view==='inbox'&&!state.inboxSelecting&&authority===inboxContactAuthority()&&selection===state.inboxSelectionSequence&&state.tenant?.id===tenantId&&state.conversation===conversationId&&$('#messages')===timeline;
 if(inboxTimeline.slice(conversation.messages,`${tenantId}:${conversationId}`).hidden){const top=timeline.scrollTop,height=timeline.scrollHeight;inboxTimeline.showEarlier(timeline,conversation.messages);syncRemoteInboxEarlier(timeline);timeline.scrollTop=top+timeline.scrollHeight-height;}
 else if(page?.hasMore&&!page.loading){
  const controller=inboxOpeningController(),version=conversation.version;state.inboxHistoryController?.abort();state.inboxHistoryController=controller;page.loading=true;syncRemoteInboxEarlier(timeline);
  try{const older=await dataSource.conversationPage(tenantId,conversationId,{workspaceId:state.workspaceId,before:page.before,limit:60,signal:controller.signal});if(!current())return;validateInboxWindow(older,conversationId,{older:true});if(older.reset||older.version!==currentConversation()?.version||version!==currentConversation()?.version||older.messages.some(item=>currentConversation().messages.some(existing=>existing.id===item.id)))throw inboxOpeningError();
   const active=currentConversation(),top=timeline.scrollTop,height=timeline.scrollHeight;active.messages=[...older.messages,...active.messages];page.before=older.cursor.before;page.hasMore=older.hasMore;page.messageCount=Math.max(page.messageCount,active.messages.length);inboxTimeline.showEarlier(timeline,active.messages);syncRemoteInboxEarlier(timeline);timeline.scrollTop=top+timeline.scrollHeight-height;
  }catch(error){if(current()&&error.name!=='AbortError'){if([403,404].includes(error.status))dropInboxDetail(tenantId);else toast(error.message,true);}}
  finally{page.loading=false;if(current())syncRemoteInboxEarlier(timeline);}
 }
 if(!current())return;if(conversationTools.opened)updateConversationTools(true);mediaUI.bindPlayers();mediaUI.hydrate(currentConversation(),tenantApi(`conversations/${encodeURIComponent(conversationId)}`),refreshMessageAttachments);avatarUI.bind();if(restoreTimelineFocus&&!timeline.contains(document.activeElement)&&(document.activeElement===focusAtStart||document.activeElement===document.body))(timeline.querySelector('[data-action="inbox:earlier"]')||timeline).focus?.({preventScroll:true});
}
async function selectInboxConversation(tenantId,conversationId,{fromContact=false,isCurrent=()=>true}={}){
 if(!isCurrent())return;
 if(!fromContact&&inboxIdentity(selectedInboxRef())===inboxIdentity({workspaceId:state.workspaceId,tenantId,conversationId})&&!state.inboxSelecting){state.mobileChat=true;$('.inbox-workspace')?.classList.add('mobile-chat');void markConversationRead(currentConversation());return currentConversation();}
 if((state.busy&&!state.inboxSelecting)||mediaUI.sending||voiceRecorder.busy)return;
 if(blockPendingSend())return;
 if(state.flowDirty&&tenantId!==state.tenant?.id&&!await flowDraftGuard.confirm())return;
 const saveNoteBeforeSelection=()=>{const note=$('#internal-note-text');if(note&&noteDrafts.key&&!noteDrafts.save(note.value)){toast(t('Limite de notas em rascunho atingido. Salve ou limpe uma nota antes de trocar.'),true);return false;}return true;};
 if(!saveNoteBeforeSelection())return;
 const before=selectedInboxRef(),field=$('#message-text');if(before&&!consolidatedInbox.saveDraft(before,field?.value??mediaUI.draft)){toast(t('Limite de rascunhos atingido. Envie ou limpe uma mensagem.'),true);return;}
 contactLinksUI.reset();contactRefresh.reset();memoryUI.reset();
 state.inboxOpeningController?.abort();state.inboxHistoryController?.abort();const controller=state.inboxOpeningController=inboxOpeningController();
 const ticket=++state.inboxSelectionSequence,workspaceId=state.workspaceId,originView=state.view,authority=inboxContactAuthority(),refreshSequence=state.refreshSequence=(state.refreshSequence||0)+1;state.inboxSelecting=true;state.busy=true;participantsUI.reset();updateVoiceControls();
 try{
  const result=await consolidatedInbox.select({workspaceId,tenantId,conversationId},ref=>loadInboxOpening(ref,controller.signal));
  if(!result||!isCurrent()||ticket!==state.inboxSelectionSequence||refreshSequence!==state.refreshSequence||workspaceId!==state.workspaceId||authority!==inboxContactAuthority()||state.view!==(fromContact?originView:'inbox'))return;
  if((tenantId!==state.tenant?.id||conversationId!==state.conversation||fromContact&&state.view!=='inbox')&&!modalRouteLifecycle.canLeave())return;
  if(!saveNoteBeforeSelection())return;
  if(before&&!consolidatedInbox.saveDraft(before,$('#message-text')?.value??mediaUI.draft)){toast(t('Limite de rascunhos atingido. Envie ou limpe uma mensagem.'),true);return;}
  mediaUI.retainConversations(result.tenant.conversations.map(item=>item.id),result.tenant.id);
  if(mediaUI.syncContext({...attendanceContext(),tenantId:result.tenant.id,conversationId:result.ref.conversationId,active:true},$('#message-text')?.value??mediaUI.draft)===false){toast(t('Limite de rascunhos atingido. Envie ou limpe uma mensagem antes de trocar.'),true);return;}
  const tenantChanged=state.tenant?.id!==result.tenant.id;
  if(result.page){inboxMessagePages.set(inboxPageKey(tenantId,conversationId),result.page);while(inboxMessagePages.size>100)inboxMessagePages.delete(inboxMessagePages.keys().next().value);}
  if(tenantChanged){contactImportUI.reset();automationUI.reset();mcpUI.reset();resetScreens();knowledgeUI.reset();memoryUI.reset();state.quickReplies=[];state.flowId=null;state.flowDraft=null;state.flowNode=null;state.flowDirty=false;state.flowResult=null;state.pendingFlowApplication=null;brandDrafts.reset();state.brandDraft=null;}
  Object.assign(state,{tenant:result.tenant,conversation:result.ref.conversationId,contacts:result.contacts,overviewLoaded:result.overviewLoaded,flows:result.flows,assignees:result.assignees,metrics:result.metrics,mcpServers:result.mcpServers,mcpLoaded:result.mcpLoaded,mobileChat:true,sendIntent:null,noteIntent:null,scheduleIntent:null,attendanceModal:null,schedules:[],inboxSelecting:false,busy:false,inboxContactFocus:fromContact?{authority,ref:{workspaceId,tenantId:result.tenant.id,conversationId:result.ref.conversationId}}:null});
  if(fromContact){state.view='inbox';state.menuOpen=false;location.hash=currentRouteHash();}else history.replaceState(history.state,'',currentRouteHash());
  render();
  void markConversationRead(currentConversation());
  if(result.page)void hydrateInboxOpening({workspaceId,tenantId,conversationId},{signal:controller.signal,current:()=>!controller.signal?.aborted&&(fromContact||isCurrent())&&ticket===state.inboxSelectionSequence&&refreshSequence===state.refreshSequence&&workspaceId===state.workspaceId&&authority===inboxContactAuthority()&&state.view==='inbox'&&state.tenant?.id===tenantId&&state.conversation===conversationId});
  if(fromContact)refreshInboxList({offset:consolidatedInbox.data.offset}).catch(error=>{if(ticket===state.inboxSelectionSequence&&authority===inboxContactAuthority())toast(error.message,true);});
  if(tenantChanged)Promise.all([automationUI.refresh(),knowledgeUI.load({force:true})]).then(()=>{if(ticket===state.inboxSelectionSequence&&workspaceId===state.workspaceId&&['knowledge','automation'].includes(state.view))render();}).catch(error=>{if(ticket===state.inboxSelectionSequence&&workspaceId===state.workspaceId)toast(error.message,true);});
  return result.tenant.conversations.find(item=>item.id===result.ref.conversationId);
 }catch(error){if(isCurrent()&&ticket===state.inboxSelectionSequence&&refreshSequence===state.refreshSequence&&workspaceId===state.workspaceId&&authority===inboxContactAuthority()&&state.view===(fromContact?originView:'inbox')){if([403,404].includes(error.status))dropInboxDetail(tenantId);toast(error.message,true);}}
 finally{if(ticket===state.inboxSelectionSequence){state.inboxSelecting=false;state.busy=false;updateVoiceControls();}}
}
/*@end:select-inbox-conversation*/
function changeInboxFilter(name,value){
 if(name==='filter')state.lensWorkspace=state.workspaceId;
 state[name]=value;state.inboxContactFocus=null;consolidatedInbox.setLimit(INBOX_PAGE);
 if(name==='inboxCompany'){state.channel='all';state.department='all';}
 if(['channel','department'].includes(name)){const choice=inboxChoice(value);if(choice?.tenantId){state.inboxCompany=choice.tenantId;const other=name==='channel'?'department':'channel';if(inboxChoice(state[other])?.tenantId!==choice.tenantId)state[other]='all';}}
 syncInboxFilterHash();clearTimeout(state.inboxSearchTimer);return refreshInboxList().catch(error=>toast(error.message,true));
}

/*@anchor:media-ui*/
const mediaUI = createMediaUI({ escape, icon, getPendingSend:()=>Boolean(state.sendIntent), getCapabilities:()=>capabilitiesFor(state.tenant?.conversations.find(c=>c.id===state.conversation)), download: async (path, signal) => {
  const response = await fetch(path, { signal, headers: { ...(state.workspaceId ? { 'X-Elozi-Workspace': state.workspaceId } : {}),...(state.supportGrantId?{'X-Elozi-Support-Grant':state.supportGrantId}:{}) } });
  if (response.status === 401) { sessionExpired({ reason: 'session-expired', abort: () => { channelVisitorTestUI?.reset();state.scopedRunsEpoch=(state.scopedRunsEpoch||0)+1;contactLinksUI.reset();contactRefresh.reset();memoryUI.reset(); }, discard: () => { mediaUI.reset();state.sendIntent=null;if(typeof followUpsUI!=='undefined')followUpsUI.reset(); } }); throw new Error(t('Entre novamente para acessar o arquivo.')); }
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || t('Não foi possível carregar o arquivo.')); }
  if (Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024) throw new Error(t('Este arquivo ultrapassa o limite de download desta versão.'));
  return response.blob();
} });
/*@end:media-ui*/
/*@anchor:pending-send-unload*/
installPendingSendUnloadGuard({ pending: () => Boolean(state.sendIntent || mediaUI.sending || noteDrafts.count && !noteDrafts.persistent) });
/*@end:pending-send-unload*/
const voiceRecorder = createVoiceRecorder({
  onState: () => updateVoiceControls(),
  onError: message => { mediaUI.fail(message); updateVoiceControls(); toast(message,true); },
  onFile: file => {
    const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation);
    if(state.view!=='inbox'||!canSendTo(conversation)||!supportsVoice(conversation))return;
    mediaUI.choose(file,$('#message-text')?.value ?? mediaUI.draft);
    if(mediaUI.selected?.file===file)mediaUI.selected.voice=true;
    render(); $('#message-text')?.focus();
  }
});
const inboxTimeline=installInboxPagination(createInboxTimeline({renderMessage:conversationMessage,extras:()=>{const c=currentConversation();return c?agentRail.timelineItems(c):[];},pill:()=>$('#new-message-indicator')}));
const repliesUI=createRepliesUI({escape,icon});
/*@anchor:current-conversation-participants*/
/*@anchor:current-conversation*/
const currentConversation=()=>state.tenant?.conversations.find(c=>c.id===state.conversation);
/*@anchor:attendance-context*/
const attendanceContext=()=>({workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot?.session.userId,conversationId:state.conversation,active:state.view==='inbox',canReply:canReplyTo(currentConversation()),channels:state.tenant?.channels||[],authorityKey:JSON.stringify([state.boot?.csrfToken||state.boot?.session?.csrfToken,state.supportGrantId||null,state.boot?.session.role,state.boot?.session.platformOwner, state.boot?.session.permissions||null])});
/*@end:current-conversation*/
function blockPendingSend(){if(!state.sendIntent)return false;toast(t('Confira o envio pendente ou descarte o rascunho antes de trocar ou editar.'),true);return true;}
function pendingSendMarkup(){return state.sendIntent?markup('<div class="pg-inbox__notice pg-inbox__notice--warning" role="status"><p>Envio sem confirmação. Confira a conversa no destino. Se repetir, usaremos o mesmo comando, sem alterar texto ou arquivo.</p><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="verify-send"><span class="ui-btn__label">Repetir o mesmo envio</span></button><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-action="discard-send"><span class="ui-btn__label">Descartar rascunho</span></button></div>'):'';}
function validatePendingSend(input){if(state.sendIntent)createSendIntent(state.sendIntent,input,{randomUUID:()=>{throw Error(t('Confira o envio anterior antes de alterar texto, arquivo ou citação.'));}});}
async function changeTenant(tenantId){
 if(tenantId===state.tenant?.id)return true;
 if(state.busy||mediaUI.sending||voiceRecorder.busy||blockPendingSend())return false;
 if(state.flowDirty&&tenantId!==state.tenant?.id&&!await flowDraftGuard.confirm())return false;
 if(!modalRouteLifecycle.canLeave())return false;
 if(mediaUI.syncContext({...attendanceContext(),active:false},$('#message-text')?.value??mediaUI.draft)===false){toast(t('Limite de rascunhos atingido. Envie ou limpe uma mensagem antes de trocar.'),true);return false;}
 modalRouteLifecycle.close();
 state.busy=true;resetWorkspaceSelection({preserveMediaDrafts:true});
 try{await refresh(tenantId);render();return true;}finally{state.busy=false;}
}
/*@end:attendance-context*/
/*@end:current-conversation-participants*/
const participantsUI=createParticipantsUI({getContext:()=>{const c=currentConversation();return {...attendanceContext(),selecting:state.inboxSelecting,channelId:c?.channelId,version:c?.version,contact:c?.contact,canManageParticipants:c?.attendanceAccess?.canManageParticipants};},request:api,openModal,getModal:()=>$('#modal'),escape,icon,applyConversation:applyAttendance,avatarHTML:person=>avatarMarkup(person.name,person.avatar,'participants-avatar '+person.kind),onRender:()=>avatarUI.bind(),onError:message=>toast(message,true)});
const noteDrafts=createInternalNoteDrafts();
/*@anchor:follow-ups-ui*/
const followUpsUI=createFollowUpsUI({
  getContext:()=>{const c=currentConversation();return {workspaceId:state.workspaceId,tenantId:state.tenant?.id,conversationId:c?.id,channelId:c?.channelId,userId:state.boot?.session.userId,authorityKey:inboxContactAuthority(),active:state.view==='inbox'&&!state.inboxSelecting,canRead:Boolean(c&&hasPermission('inbox.read')),canWrite:Boolean(c&&hasPermission('inbox.reply')),version:c?.version};},
  request:api,getHost:()=>state.view==='inbox'?$('#conversation-follow-ups'):null,
  onMutation:(result,scope)=>{const c=currentConversation();if(!c||state.view!=='inbox'||scope.workspaceId!==state.workspaceId||scope.tenantId!==state.tenant?.id||scope.conversationId!==c.id||scope.channelId!==c.channelId||scope.userId!==state.boot?.session.userId||scope.authorityKey!==inboxContactAuthority())return;if(Number.isSafeInteger(result.version)&&result.version>c.version)c.version=result.version;const label=$('#conversation-context .pg-inbox__version strong');if(label)label.textContent=t('Versão {version}',{version:c.version});},
  onError:error=>toast(typeof error==='string'?error:error?.message||t('Não foi possível concluir a solicitação. Tente novamente.'),true)
});
/*@end:follow-ups-ui*/
const conversationTools=createConversationTools({escape,icon,conversation:currentConversation,navigateToMessage:jumpAttendanceMessage,
  getHistoryCoverage:({tenantId,conversationId,channelId})=>{
    const c=currentConversation();
    if(state.tenant?.id!==tenantId||c?.id!==conversationId||c?.channelId!==channelId)return null;
    const page=inboxMessagePages.get(inboxPageKey(tenantId,conversationId));
    return page?{hasMore:page.hasMore,messageCount:page.messageCount}:null;
  },
  mediaAction:({action,id,messageId,contextKey,origin})=>{const c=currentConversation(),pairs=(c?.messages||[]).flatMap(m=>(m.attachments||[]).filter(a=>String(a.id)===id).map(a=>({message:m,attachment:a})));if(!c||contextKey!==conversationTools.contextKey||pairs.length!==1||String(pairs[0].message.id)!==messageId)throw Error(t('O arquivo mudou. Abra novamente a galeria.'));return mediaUI.handleAction({dataset:{mediaAction:action,id},closest:selector=>origin?.closest(selector),focus:options=>origin?.focus(options),isConnected:origin?.isConnected},{conversation:c,base:tenantApi(`conversations/${encodeURIComponent(c.id)}`),canReply:canReplyTo(c),renderMessages:refreshMessageAttachments});},
  onChange:({resultsOnly})=>updateConversationTools(resultsOnly)});
/*@anchor:service-handoffs*/
const serviceHandoffsUI=createServiceHandoffsUI({getContext:()=>{const c=currentConversation();return {...attendanceContext(),selecting:state.inboxSelecting,canDecide:canCoordinate(c),supportGrantId:state.supportGrantId,supportExpiresAt:state.boot?.session.supportExpiresAt,channelId:c?.channelId,departmentId:c?.departmentId,assignedUserId:c?.assignedUserId,assignedSupportGrantId:c?.assignedSupportGrantId,status:c?.status};},request:api,openModal,getModal:()=>$('#modal'),toast});
/*@end:service-handoffs*/
function customerContextState(){
  const conversation=currentConversation(),session=state.boot?.session;
  return {...attendanceContext(),tenantName:state.tenant?.name,conversation,
    conversations:state.tenant?.conversations,channels:state.tenant?.channels,
    contacts:state.overviewLoaded?.contacts?state.contacts:null,
    assignees:state.overviewLoaded?.assignees?state.assignees:null,agents:state.tenant?.agents,
    selecting:state.inboxSelecting,busy:state.busy||mediaUI.sending||voiceRecorder.busy,
    supportGrantId:state.supportGrantId,supportExpiresAt:session?.supportExpiresAt,
    canReadInbox:hasPermission('inbox.read'),canReadContacts:hasPermission('contacts.read'),
    capabilities:{takeover:Boolean(conversation&&conversation.status!=='closed'&&!canReplyTo(conversation)&&hasPermission('inbox.reply')&&(!conversation.assignedUserId||conversation.assignedUserId===session?.userId||session?.role==='reseller')),
      transfer:canManageAttendance(conversation)&&conversation?.status!=='closed',
      participants:Boolean(conversation&&hasPermission('inbox.read')),
      handoffs:canCoordinate(conversation),prepareDraft:canCoordinate(conversation)&&state.tenant?.agents.some(agent=>agent.provider==='hermes'&&agent.configured===true)}};
}
const customerContextUI=createCustomerContextUI({getContext:customerContextState,escape,icon,onUpdate:updateCustomerContext,
  onOpenConversation:async target=>{
    const context=customerContextState(),destination=context.conversations?.find(item=>item.id===target.conversationId);
    if(!context.active||context.busy||context.selecting||!context.canReadInbox||context.workspaceId!==target.workspaceId||context.tenantId!==target.tenantId||!context.conversation?.contactId||destination?.contactId!==context.conversation.contactId)return;
    await selectInboxConversation(target.tenantId,target.conversationId);
  },
  onAction:async (action,target)=>{
    const context=customerContextState(),conversation=context.conversation;
    if(!context.active||context.busy||context.selecting||!context.canReadInbox||context.workspaceId!==target.workspaceId||context.tenantId!==target.tenantId||conversation?.id!==target.conversationId||conversation?.version!==target.version)return;
    if(action==='service-handoffs'){if(context.capabilities.handoffs)await serviceHandoffsUI.open();return;}
    const capability={takeover:'takeover','transfer-conversation':'transfer','conversation-participants':'participants','run-agent':'prepareDraft'}[action];
    if(capability&&context.capabilities[capability]===true)await act(action);
  }});
/*@anchor:forwarding*/
const forwarding=createForwarding({getContext:attendanceContext,getConversation:currentConversation,getTargets:()=>state.tenant?.conversations||[],request:api,
  onChange:()=>updateForwardingStatus()});
/*@end:forwarding*/
function syncAttendanceTools(){const c=currentConversation(),ids=state.tenant?.conversations.map(c=>c.id)||[],s=state.boot?.session||{};noteDrafts.sync({...attendanceContext(),persistenceKey:JSON.stringify([s.role,s.platformOwner,s.permissions,s.scopeRules,state.supportGrantId,s.supportExpiresAt,(state.boot?.tenants||[]).map(t=>t.id).sort()]),allowedIds:ids});conversationTools.syncContext({...attendanceContext(),channelId:c?.channelId},ids);participantsUI.sync();serviceHandoffsUI.sync();memoryUI.syncContext();}
function jumpAttendanceMessage(id){if(!currentConversation()?.messages.some(m=>String(m.id)===String(id)))return false;const entry=[...($('#messages')?.querySelectorAll('[data-message-id]')||[])].find(el=>el.dataset.messageId===String(id));if(!entry)return false;conversationTools.close();entry.tabIndex=-1;entry.focus({preventScroll:true});entry.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});entry.classList.add('message-reference-highlight');entry.addEventListener('blur',()=>entry.classList.remove('message-reference-highlight'),{once:true});return true;}
function updateConversationTools(resultsOnly=false){const host=$('#conversation-tools-host');if(!host)return;const results=host.querySelector('[data-conversation-tool-results]');if(resultsOnly&&results)results.innerHTML=conversationTools.results();else host.innerHTML=conversationTools.panel();if(!resultsOnly&&conversationTools.opened)host.querySelector('[data-conversation-tool-search]')?.focus();}
function updateInboxList(){updateConsolidatedList();}
/*@anchor:composer-status*/
function composerStatus(){const note=state.composerMode==='note',field=note?$('#internal-note-text'):$('#message-text'),counter=$('[data-composer-count]'),caps=capabilitiesFor(currentConversation()),limit=note?2000:mediaUI.selected?caps.captionMaxLength:caps.maxTextLength;if(counter&&field)counter.textContent=`${(note?field.value.length:textLength(field.value,caps)).toLocaleString(getLocale())} / ${limit.toLocaleString(getLocale())}`;}
/*@end:composer-status*/
function setComposerMode(mode){if(voiceRecorder.busy||mediaUI.sending){toast(t('Finalize a gravação ou o envio antes de trocar.'),true);syncComposerMode();return;}state.composerMode=mode==='note'?'note':'reply';syncComposerMode();composerStatus();(state.composerMode==='note'?$('#internal-note-text'):$('#message-text'))?.focus();}
// Composer v2 (§5.2.3): exactly two modes. The note has its own background (data-mode="note"), its
// label and "Salvar nota"; the reply keeps "Responder por [monograma] Empresa › Canal …número".
function syncComposerMode(){
 const note=state.composerMode==='note',host=$('.pg-inbox__composer');
 if(host)host.dataset.mode=note?'note':'reply';
 if($('#message-form'))$('#message-form').hidden=note;if($('#internal-note-form'))$('#internal-note-form').hidden=!note;
 for(const input of document.querySelectorAll('input[name="composer-mode"]'))input.checked=input.value===(note?'note':'reply');
 const seg=host?.querySelector('.ui-seg');if(seg){seg.style.setProperty('--seg-index',note?'1':'0');seg.removeAttribute('data-state');}
 const origin=$('[data-composer-origin]'),c=currentConversation();if(origin&&c){const template=document.createElement('template');template.innerHTML=composerOriginFor(c);origin.replaceWith(template.content.firstElementChild);}
 for(const tab of document.querySelectorAll('[data-composer-mode]')){tab.classList.toggle('selected',tab.dataset.composerMode===state.composerMode);tab.setAttribute('aria-selected',String(tab.dataset.composerMode===state.composerMode));}
}
function composerOriginFor(c){return String(composerOriginMarkup({mode:state.composerMode==='note'?'note':'reply',tenant:state.tenant,channel:channelFor(c),channelKind:transportName(c),access:canReplyTo(c)&&attendanceRole(c)!=='collaborator'?'':attendanceComposerText(c)}));}
function updateForwardingStatus(){const p=forwarding.preview(),form=$('[data-attendance-form="forward"]');if(!form)return;const status=form.querySelector('[data-forward-status]');status.textContent=p?.error||p?.status||t('O atendimento mudou. Abra novamente o encaminhamento.');form.querySelector('button[type=submit]').disabled=!p||p.busy||!p.destination||p.confirmed;form.querySelector('select').disabled=!p||p.busy;}
let layoutStorage;try{layoutStorage=localStorage;}catch{}
const chatLayout=createChatLayout({icon,storage:layoutStorage,onConversations:()=>{
  state.mobileChat=false;$('.inbox-workspace')?.classList.remove('mobile-chat');
  $('#conversation-search')?.focus({preventScroll:true});
}});
// Keyed list controller (inbox-list-ui.js): Enter/o or a click opens the conversation and only then
// marks it as read; j/k and the arrows only move the focus.
const inboxList=createInboxList({doc:document,onOpen:(tenantId,conversationId)=>openInboxConversation(tenantId,conversationId)});
/*@anchor:voice-controls*/
function updateVoiceControls(){
  const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation);
  const disabled=!canSendTo(conversation)||!supportsVoice(conversation)||mediaUI.sending||Boolean(state.sendIntent);
  const controls=$('#voice-controls');
  const form=$('#message-form');
  const pending=$('#pending-send-host');if(pending)pending.innerHTML=pendingSendMarkup();
  if(form){mediaUI.updateComposer(!canSendTo(conversation));if(voiceRecorder.busy)for(const control of form.querySelectorAll('button,input,textarea'))if(!control.matches('[data-voice-action]'))control.disabled=true;}
  if(controls){
    const key=JSON.stringify([voiceRecorder.state,disabled,Boolean(mediaUI.selected)]);
    if(controls.dataset.voiceKey!==key){controls.innerHTML=voiceRecorder.markup(disabled||Boolean(mediaUI.selected));controls.dataset.voiceKey=key;}
    else{const timer=controls.querySelector('.voice-recorder-timer');const markup=document.createElement('template');markup.innerHTML=voiceRecorder.markup(disabled||Boolean(mediaUI.selected));if(timer)timer.textContent=markup.content.querySelector('.voice-recorder-timer')?.textContent||'';}
    for(const button of controls.querySelectorAll('[data-voice-action]'))button.disabled=disabled||(button.dataset.voiceAction==='start'&&(!voiceRecorder.supported||Boolean(mediaUI.selected)));
  }
  if(form){
    const schedule=form.querySelector('[data-action="schedule-message"]'),agent=form.querySelector('[data-action="run-agent"]');
    if(schedule)schedule.disabled=Boolean(state.sendIntent)||!canSendTo(conversation)||capabilitiesFor(conversation).textSupported===false||!isRealConversation(conversation)||mediaUI.sending||voiceRecorder.busy||!canCoordinate(conversation);
    if(agent)agent.disabled=Boolean(state.sendIntent)||!canCoordinate(conversation)||mediaUI.sending||voiceRecorder.busy||!state.tenant?.agents.some(item=>item.configured);
  }
}
/*@end:voice-controls*/
function bindInboxMedia(){
  const conversation=state.view==='inbox'&&state.tenant?.conversations.find(item=>item.id===state.conversation);
  if(!conversation){inboxTimeline.reset();return;}
  inboxTimeline.bind($('#messages'),conversation.messages);
  bindGroupPanel();
  inboxTimeline.pin($('#messages'));
  mediaUI.bindPlayers();
  mediaUI.hydrate(conversation,tenantApi(`conversations/${encodeURIComponent(conversation.id)}`),refreshMessageAttachments);
  updateVoiceControls();
}
/*@anchor:inbox-polling*/
let inboxPolling=false;
/*@anchor:poll-inbox*/
async function pollInbox(){
  if(inboxPolling||state.view!=='inbox'||state.busy||mediaUI.sending||participantsUI.busy||$('#modal').open&&!participantsUI.opened||!state.tenant)return;
  const tenantId=state.tenant.id,workspaceId=state.workspaceId,conversationId=state.conversation,refreshSequence=state.refreshSequence,authority=inboxContactAuthority();
  const runsContext=conversationId?captureScopedRuns():null;
  inboxPolling=true;
  try{
    await refreshInboxList({offset:consolidatedInbox.data.offset});
    if(!conversationId)return;
    const [tenant,runs]=await Promise.all([dataSource.tenant(tenantId,{workspaceId,conversationId}),readScopedRuns(runsContext)]);
    if(!currentScopedRuns(runsContext)||!Array.isArray(runs))return;
    if(state.view!=='inbox'||state.busy||mediaUI.sending||state.refreshSequence!==refreshSequence||authority!==inboxContactAuthority()||state.tenant?.id!==tenantId||state.workspaceId!==workspaceId||state.conversation!==conversationId)return;
    if(tenant.conversations.find(item=>item.id===conversationId)?.version<currentConversation()?.version)return;
    const aligned=scopedRunsAligned(tenant,runsContext,runs);
    state.tenant=aligned?{...tenant,runs:[...(tenant.runs||[]).filter(run=>run.conversationId!==conversationId),...runs]}:tenant;
    consolidatedInbox.retainConversations(tenantId,tenant.conversations.map(item=>item.id));
    mediaUI.retainConversations(tenant.conversations.map(item=>item.id),tenantId);
    repliesUI.retainConversations(tenant.conversations.map(item=>item.id));
    syncAttendanceTools();
    const conversation=tenant.conversations.find(item=>item.id===conversationId);
    if(!conversation){state.renderedInboxRef=null;state.conversation=null;state.sendIntent=null;state.noteIntent=null;state.scheduleIntent=null;voiceRecorder.reset();repliesUI.reset();render();return;}
    const reply=canReplyTo(conversation);
    repliesUI.syncContext({workspaceId,tenantId,conversationId,messages:conversation.messages,active:true});
    repliesUI.updateQuoteComposer(!reply);
    if(!reply)voiceRecorder.reset();
    updateAttendanceAccess(conversation);
    updateAttendanceSummary(conversation);
    updateClientRecord();
    if(conversationTools.opened)updateConversationTools(true);
    const result=inboxTimeline.update($('#messages'),conversation.messages);
    if(result.added&&!result.nearBottom)$('#new-message-indicator').hidden=false;
    updateInboxList();
    const count=$('.nav-count');if(count)count.textContent=consolidatedInbox.data.counts.active||0;
    renderConversationRuns();
    void markConversationRead(conversation,{opened:false});
    mediaUI.bindPlayers();mediaUI.hydrate(conversation,tenantApi(`conversations/${encodeURIComponent(conversation.id)}`),refreshMessageAttachments);
    avatarUI.bind();
    if(!aligned)void refreshScopedConversationRuns();
  }catch(error){
    if(error.code==='SCOPED_RUN_DTO'&&currentScopedRuns(runsContext)){replaceScopedRuns(runsContext,[]);toast(error.message,true);}
    else if([403,404].includes(error.status)&&(!runsContext||currentScopedRuns(runsContext))&&state.view==='inbox'&&state.refreshSequence===refreshSequence&&authority===inboxContactAuthority()&&state.tenant?.id===tenantId&&state.workspaceId===workspaceId&&state.conversation===conversationId){
      dropInboxDetail(tenantId);toast(t('Seu acesso a este atendimento mudou. A caixa será atualizada.'),true);
    }
    // Transient failures keep drafts, attachments and players for the next poll.
  }
  finally{inboxPolling=false;}
}
/*@end:poll-inbox*/
/*@end:inbox-polling*/
function toast(message, error = false) { toasts.show({ message: error ? translateError(message) : message, tone: error ? 'error' : 'info' }); }
/*@anchor:refresh*/
async function refresh(tenantId = state.tenant?.id,{skipInboxList=false,skipOverviewPanels=false}={}) {
  contactLinksUI.reset();contactRefresh.reset();memoryUI.reset();
  const previousSelection=selectedInboxRef();
  const previousNoteUser=state.boot?.session.userId;
  const previousTenants=state.boot?.tenants||[],previousMediaScope=JSON.stringify([attendanceContext().userId,attendanceContext().workspaceId,attendanceContext().authorityKey]);
  const sequence = state.refreshSequence = (state.refreshSequence || 0) + 1;
  const authorityKey=()=>JSON.stringify([state.workspaceId,state.supportGrantId||null,state.boot?.session.userId,state.boot?.csrfToken||state.boot?.session.csrfToken,state.boot?.session.role,state.boot?.session.platformOwner,state.boot?.session.permissions,state.boot?.session.scopeRules,(state.boot?.tenants||[]).map(item=>item.id)]);
  const authority=authorityKey(),current=()=>sequence===state.refreshSequence&&authority===authorityKey();
  const boot = await api('/api/bootstrap');
  if (!current()) return false;
  if (!boot || typeof boot !== 'object' || Array.isArray(boot) || !boot.session || typeof boot.session !== 'object' || Array.isArray(boot.session) || !Array.isArray(boot.tenants)) throw new Error(t('O servidor retornou dados inválidos do workspace. Tente novamente.'));
  const workspaceId = boot.session.resellerId || null;
  const scopedApi = path => api(path, { headers: workspaceId ? { 'X-Elozi-Workspace': workspaceId } : {} });
  const savedId=localStorage.getItem(`elozi-tenant:${workspaceId}`);
  const nextId = boot.tenants.some(item => item.id === tenantId) ? tenantId : boot.tenants.some(item=>item.id===savedId)?savedId:boot.tenants.find(item=>!item.id.endsWith('-demo')&&!item.demo)?.id||boot.tenants[0]?.id;
  const optional = async path => {try{return await scopedApi(path);}catch(error){if(error.status===403)return null;throw error;}};
  const base=nextId?`/api/tenants/${encodeURIComponent(nextId)}`:null,admin=boot.session.role==='reseller',metricsAllowed=admin||boot.session.permissions==null||boot.session.permissions.includes('metrics.read');
  // These reads share the freshly authorized workspace and do not depend on each other's DTOs.
  const [tenant,flows,users,invitations,account,security,integrations,loadedContacts,loadedAssignees,loadedMetrics,loadedMcp]=await Promise.all([
    base?scopedApi(base):null,base?optional(base+'/flows'):[],admin?scopedApi('/api/users'):[],admin?scopedApi('/api/users/invitations'):null,
    scopedApi('/api/auth/me'),scopedApi('/api/auth/sessions'),boot.session.platformOwner?scopedApi('/api/integrations'):null,
    base?optional(base+'/contacts?archived=true'):null,base?optional(base+'/assignees'):null,
    base&&metricsAllowed?optional(base+`/metrics${state.metricsFrom&&state.metricsTo?'?from='+encodeURIComponent(state.metricsFrom+'T00:00:00-03:00')+'&to='+encodeURIComponent(state.metricsTo+'T23:59:59.999-03:00'):''}`):null,
    base&&admin?optional(base+'/mcp/servers'):null
  ]);
  if(!current())return false;
  if(!account?.user||boot.session.userId&&account.user.id!==boot.session.userId||tenant&&(tenant.id!==nextId||!Array.isArray(tenant.conversations)))throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
  state.boot = boot; state.workspaceId = workspaceId; state.supportGrantId=boot.session.supportGrantId||null;state.tenant = tenant;
  state.flows = Array.isArray(flows) ? flows : flows?.flows || [];
  state.users = Array.isArray(users) ? users : users.users || [];
  state.invitations = invitations?.invitations || []; state.invitationEmailConfigured = Boolean(invitations?.emailConfigured);
  state.securitySessions = security.sessions || [];
  state.account = account; state.integrations = integrations;
  setLocale(account.user.locale, { notify: false });
  state.contacts=loadedContacts?.contacts||[];state.assignees=loadedAssignees?.assignees||[];state.overviewLoaded={contacts:Boolean(loadedContacts),assignees:Boolean(loadedAssignees)};state.metrics=loadedMetrics;
  state.mcpServers=loadedMcp?.servers||[];state.mcpLoaded=Boolean(loadedMcp);
  if(tenant)localStorage.setItem(`elozi-tenant:${workspaceId}`,tenant.id);
  if(!previousSelection||previousSelection.workspaceId!==workspaceId||previousSelection.tenantId!==tenant?.id||!tenant?.conversations.some(item=>item.id===previousSelection.conversationId))state.conversation=null;
  consolidatedInbox.sync();
  const mediaScope=JSON.stringify([attendanceContext().userId,attendanceContext().workspaceId,attendanceContext().authorityKey]);
  if(previousMediaScope!==mediaScope){mediaUI.reset();state.sendIntent=null;state.renderedInboxRef=null;if($('#message-text'))$('#message-text').value='';if(previousNoteUser)noteDrafts.reset();}
  else for(const previous of previousTenants)if(!boot.tenants.some(item=>item.id===previous.id))mediaUI.forgetTenant(previous.id);
  if(tenant){const ids=tenant.conversations.map(item=>item.id);consolidatedInbox.retainConversations(tenant.id,ids);mediaUI.retainConversations(ids,tenant.id);}
  if(previousSelection&&!state.conversation){state.renderedInboxRef=null;state.sendIntent=null;repliesUI.reset();noteDrafts.reset();}
  const committedAuthority=authorityKey(),committedCurrent=()=>sequence===state.refreshSequence&&committedAuthority===authorityKey()&&state.tenant?.id===tenant?.id;
  if(state.view==='inbox'&&!skipInboxList)await refreshInboxList({offset:consolidatedInbox.data.offset});
  // Page-specific reads must not hold the authenticated shell behind unrelated modules.
  if(!committedCurrent())return false;
  if(['overview','support','service-agents','platform-users','connected-products','billing','platform-billing','platform','accounts','automation','knowledge'].includes(state.view)&&!(state.view==='overview'&&skipOverviewPanels))await loadViewPanels();
  return committedCurrent();
}
function focusViewContent() {
  const heading = $('#main-content h1') || $('#main-content');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}
function loadNavigatedPanels(view) {
  return loadViewPanels().finally(() => {
    if (state.view === view && document.activeElement === document.body && !document.querySelector('dialog[open]')) focusViewContent();
  });
}
/*@end:refresh*/
/*@anchor:navigate*/
// Canonical hash of what is on screen (router.js grammar): the open conversation is a deep link,
// with ?w= when the person has more than one workspace, so a reload can reopen it.
// The #groups link keeps its own address while its filter is on, so "Atendimento" in the menu is a real
// navigation (hashchange) back to every conversation.
function currentRouteHash(){const workspaceId=state.boot?.workspaces?.length>1?state.workspaceId:null;if(state.view==='inbox'&&state.tenant&&state.conversation)return conversationHash({tenantId:state.tenant.id,conversationId:state.conversation,workspaceId});if(state.view==='inbox'){const query=inboxFilterQuery(state);if(query.lens===defaultLens(state.boot?.session))delete query.lens;if(Object.keys(query).length&&!(state.kindFromLink&&query.kind==='group'&&Object.keys(query).length===1))return formatHash({section:'inbox',workspaceId,query});}return hashForView(state.view==='inbox'&&state.kind==='group'&&state.kindFromLink?'groups':state.view);}
function syncInboxFilterHash(){if(state.view==='inbox'&&!state.conversation)history.replaceState(history.state,'',currentRouteHash());}
function navigate(view) { const targetView=view==='groups'?'inbox':view;
  state.inboxRouteEpoch=(state.inboxRouteEpoch||0)+1;
  if(targetView!==state.view&&(mediaUI.sending||voiceRecorder.busy||blockPendingSend()))return;
  const seenRoute=state.screenRoutes?.[targetView],targetRoute=seenRoute!==undefined?routeForView(targetView):null;
  if((targetView!==state.view||seenRoute!==undefined&&seenRoute!==JSON.stringify([targetRoute?.section||null,targetRoute?.params||{}]))&&!modalRouteLifecycle.canLeave())return;
  if(view==='groups'){view='inbox';state.kind='group';state.kindFromLink=true;}
  // "Atendimento" in the menu after the Grupos link shows every conversation again (a Grupos toggle chosen in the list stays).
  else if(view==='inbox'&&state.kindFromLink){state.kindFromLink=false;if(state.kind==='group')changeInboxFilter('kind','all');}
  const changed=view!==state.view;if(changed){contactLinksUI.reset();platformUsersUI.reset();commercialUsageUI.reset();groupsWorkspaceUI.reset();}contactRefresh.reset();memoryUI.reset();if(state.view==='team-chat'&&changed)teamChatUI.reset();state.menuOpen = false; state.view = view; location.hash = currentRouteHash();
  const show=()=>{render(); if(view==='contacts')contactRefresh.refresh({force:true});if(view==='inbox')refreshInboxList().catch(error=>toast(error.message,true));if(['overview','support','service-agents','platform-users','connected-products','billing','platform-billing','platform','accounts','automation','knowledge'].includes(view))loadNavigatedPanels(view); $('#main-content')?.scrollTo(0, 0); window.scrollTo(0,0);if(changed)focusViewContent();};
  if(changed)swapScreen(show);else show(); }
// Screen change of an explicit navigation (FRONTEND-V2 §6 "Troca de tela"): with View Transitions and
// motion allowed (theme-prefs.js motionOK), the new screen is drawn inside
// document.startViewTransition, so the browser crossfades <main> while the sidebar and the topbar keep
// their place (fixed view-transition-name in shell.css); otherwise the same steps run at once. Polls,
// list patches and re-renders of the same screen never come through here. The DOM of a transition
// changes in its update callback, so everything that reads the new screen runs inside `update`; a newer
// navigation supersedes an update that has not run yet. True when the update was deferred.
let screenSwaps=0;
function swapScreen(update){
  const doc=globalThis.document;
  if(typeof doc?.startViewTransition!=='function'||typeof motionOK!=='function'||!motionOK()||doc.visibilityState==='hidden'){update();return false;}
  const ticket=++screenSwaps;
  try{
    const transition=doc.startViewTransition(()=>{if(ticket!==screenSwaps)return;try{update();}catch(error){toast(error.message,true);}});
    for(const settled of [transition?.ready,transition?.finished])settled?.catch?.(()=>{});
    return true;
  }catch{update();return false;}
}

/*@end:navigate*/
function profileDraft() {
  const user = state.account.user;
  if (!state.profileDraft || state.profileDraft.userId !== user.id) state.profileDraft = { userId: user.id, name: user.name, phone: user.phone || '', bio: user.bio || '', avatar: user.avatar || null, avatarChanged: false };
  return state.profileDraft;
}

function brandDraft() {
  state.brandDraft = brandDrafts.get({ workspaceId:state.workspaceId, tenantId:state.tenant.id, scope:state.brandScope, brand:state.brandScope === 'reseller' ? state.boot.reseller.brand : state.tenant.brand });
  return state.brandDraft;
}
// Marca e domínio repaints logo, light and dark previews and the contrast report from the draft (settings-ui.js).
function updateBrandPhoto() { settingsUI.paintBrand(); }
function updateProfilePreview() {
  const preview = $('#profile-avatar-preview');
  if (preview) preview.innerHTML = String(uiAvatar({ kind: 'person', name: profileDraft().name, src: profileDraft().avatar, size: 56 }));
}
// Minha conta (settings-ui.js): the profile draft and the sections that stay in their modules.
function accountScreenData() {
  const user = state.account?.user; if (!user) return null;
  return { user, draft: profileDraft(), role: roleLabel(user), loading: Boolean(state.avatarLoading), google: state.account.google || {}, emailConfigured: Boolean(state.account.emailConfigured), security: accountSecurityUI.markup() };
}
onHomeData(key => { if (key.startsWith('portfolio:') && state.view === 'accounts' && state.boot) render(); });
// Financeiro of an account opened from its detail: Plataforma › Cobrança for the platform owner,
// Clientes › Financeiro (#accounts/billing) for a reseller and Configurações › Financeiro otherwise.
async function openAccountFinance(account) {
  state.billingTargetId = account.id;
  if (state.boot.session.platformOwner) { navigate('platform-billing'); return; }
  if (state.boot.reseller?.accountKind !== 'reseller') { navigate('billing'); return; }
  if (state.view === 'accounts' && location.hash === '#accounts/billing') { await billingUI.load(); return; }
  location.hash = '#accounts/billing';
}
// Clientes › Planos and Clientes › Financeiro load when their tab opens (settings-ui.js mount).
// Contas also lists "Clientes que precisam de você" from the portfolio Visão geral caches (onboarding-ui.js).
function loadClientsTab(tab) {
  const session = state.boot?.session;
  if (tab === 'accounts' && state.boot?.reseller?.accountKind === 'reseller' && session?.role === 'reseller' && !state.supportGrantId) loadPortfolio(api, { workspaceId: state.workspaceId, userId: session.userId });
  if (tab === 'billing') billingUI.ensure().catch(error => toast(error.message, true));
  if (tab === 'plans') plansUI.ensurePage().catch(error => toast(error.message, true));
}

async function prepareProfilePhoto(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('Escolha uma foto PNG, JPEG ou WebP.'));
  if (file.size > 5 * 1024 * 1024) throw new Error(t('Escolha uma foto com até 5 MB.'));
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = {
    'image/png': [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte),
    'image/jpeg': bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    'image/webp': [82, 73, 70, 70].every((byte, index) => bytes[index] === byte) && [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte)
  };
  if (!matches[file.type]) throw new Error(t('O conteúdo do arquivo não corresponde ao formato da foto.'));
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 192;
    const context = canvas.getContext('2d');
    if (!context || !bitmap.width || !bitmap.height) throw new Error();
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 192, 192);
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 192, 192);
    for (const quality of [.85, .75, .65, .55, .45, .35, .25, .15]) {
      const photo = canvas.toDataURL('image/jpeg', quality);
      if (photo.startsWith('data:image/jpeg;base64,') && photo.length <= 24 * 1024) return photo;
    }
    throw new Error();
  } catch { throw new Error(t('Não foi possível preparar esta foto. Escolha outra imagem PNG, JPEG ou WebP.')); }
  finally { bitmap?.close(); }
}

/*@anchor:change-workspace*/
async function changeWorkspace(workspaceId,supportGrantId=null) {
  if(blockPendingSend())return;
  if (state.busy&&!state.inboxSelecting || workspaceId === state.workspaceId&&(state.supportGrantId||null)===supportGrantId) return;
  if(state.flowDirty&&!await flowDraftGuard.confirm()){if($('#workspace-select'))$('#workspace-select').value=JSON.stringify([state.workspaceId,state.supportGrantId||null]);return;}
  if(!modalRouteLifecycle.canLeave()){if($('#workspace-select'))$('#workspace-select').value=JSON.stringify([state.workspaceId,state.supportGrantId||null]);return;}
  const previous = state.workspaceId,previousGrant=state.supportGrantId||null;
  state.busy = true; state.workspaceId = workspaceId;state.supportGrantId=supportGrantId;
  resetWorkspaceSelection(); state.tenant = null; state.conversation = null; state.users = []; state.flows = [];
  $('#modal').close();
  $('#app').innerHTML = markup('<div class="loading" role="status">Abrindo o workspace escolhido…</div>');
  try { await refresh(null); render(); toast(t('Workspace alterado.')); }
  catch (error) {
    state.workspaceId = previous;state.supportGrantId=previousGrant;
    try { await refresh(null); render(); toast(error.message, true); }
    catch { $('#app').innerHTML = html`<div class="startup-error"><h1>Não foi possível abrir o workspace.</h1><p>${escape(error.message)}</p><button class="button primary" data-action="refresh">Tentar novamente</button></div>`; }
  } finally { state.busy = false; }
}

/*@end:change-workspace*/
/*@anchor:navigation-heading*/
/*@anchor:navigation-render*/
const navigation = [
  ['platform','Painel principal','grid'],['accounts','Contas comerciais','building'],['platform-users','Usuários globais','users'],['connected-products','Produtos conectados','link'],
  ['overview','Visão geral','grid'], ['inbox','Atendimento','chat'], ['groups','Grupos','users'], ['team-chat','Chat da equipe','chat'], ['contacts','Contatos','users'], ['metrics','Indicadores','activity'], ['channels','Canais','link'],
  ['agents','Agentes','agent'], ['knowledge','Conhecimento','document'], ['agent-tools','Ferramentas','code'], ['flows','Fluxos','activity'], ['automation','Automações e SLA','clock'], ['quick-replies','Respostas rápidas','document'],
  ['team','Equipe','users'], ['tenants','Empresas e filiais','building'], ['integrations','Integrações','link'], ['brand','Marca e domínio','palette'], ['support','Suporte com prazo','shield'],['service-agents','Agentes conectados','agent'],['billing','Financeiro','building'],['platform-billing','Cobrança da plataforma','building'],['account','Minha conta','users'], ['guide','Ajuda e APIs','help'], ['architecture','Mapa do produto','code'],
  ['pending','Pendências','bell'], ['setup','Primeiro uso','check']
];
// Access rules live in nav-config.js (tests/navigation-matrix.test.js compares them with the rules they replaced).
const navigationContext = () => navContext({ session: state.boot.session, supportGrantId: state.supportGrantId, hasTenant: Boolean(state.tenant), hasPermission, accountKind: state.boot.reseller?.accountKind || null });
function allowedNavigation(key) { return legacyVisible(key, navigationContext()); }
// The menu the shell renders (shellMarkup builds it from the same menuEntries over nav-config NAV_ITEMS);
// items keep data-view, so a click goes through navigate(). Tests read the served menu through it.
function navigationMarkup() { return String(sidebarNav(menuEntries(navigationContext(), state.view))); }
/*@end:navigation-render*/
// Persistent shell (FRONTEND-V2 §7.5, §8.11). render() keeps its prologue (composer draft, internal
// note, media and voice context saved before anything is redrawn) and then draws the frame only when
// its signature changes: workspace and brand, role and menu (with the slots of its counters), person,
// locale and the support or sandbox banners. Otherwise renderMain swaps <main> (a new node, as before
// P10: screens attach listeners to it in mount()) and patches what follows the route: data-view, the
// aria-current of the menu, the breadcrumb, the scope block and chip, the rail, the drawer and the
// presence ring. The sidebar, the topbar and the bottom bar keep their nodes, focus, scroll, open
// popovers and the counters patched by the live modules.
const SHELL_ROUTE_PARTS=['.sh-scope','.sh-scopechip','.sh-crumbs'];
let shellFrame=null;
function shellSignature(frame){
  return String(shellMarkup({...frame,view:'',viewLabel:'',mainClass:'',content:'',layout:'full',toggleable:true,mobile:false,menuOpen:false,notice:null,prefs:{},
    workspaces:[],tenant:frame.tenant?{id:'',name:'',brand:{}}:null,tenants:[],user:{...frame.user,presence:null}}));
}
// Screen on <main>: the view and the path of the hash (the query of the inbox filters is not a new screen).
const mainScreenKey=view=>view+'|'+String(globalThis.location?.hash||'').split('?')[0];
function renderShell(frame,content,signature){
  $('#app').innerHTML=String(shellMarkup({...frame,content}));
  const root=$('.sh-app');
  shellFrame=root?{root,signature,view:frame.view,screen:mainScreenKey(frame.view),presence:frame.user.presence,parts:Object.fromEntries(SHELL_ROUTE_PARTS.map(selector=>[selector,root.querySelector(selector)?.outerHTML??'']))}:null;
}
function renderMain(frame,content,signature){
  const root=$('.sh-app'),main=$('#main-content');
  if(!shellFrame||!root||root!==shellFrame.root||!main||!root.contains(main)||shellFrame.signature!==signature)return false;
  const template=document.createElement('template');template.innerHTML=String(shellMarkup({...frame,content:''}));
  const fresh=template.content.firstElementChild,nextMain=fresh?.querySelector('#main-content');if(!nextMain)return false;
  const viewChanged=shellFrame.view!==frame.view,screen=mainScreenKey(frame.view),sameScreen=!viewChanged&&shellFrame.screen===screen;
  root.setAttribute('data-view',frame.view);
  for(const selector of SHELL_ROUTE_PARTS){
    const next=fresh.querySelector(selector),html=next?.outerHTML??'';
    if(shellFrame.parts[selector]===html)continue;
    shellFrame.parts[selector]=html;
    const live=root.querySelector(selector);if(live&&next)live.replaceWith(next);
  }
  // Menu, bottom bar and "Mais" links of the frame (links inside <main> belong to the screen).
  const frameLinks=node=>[...node.querySelectorAll('a[data-view]')].filter(link=>!link.closest('#main-content'));
  const links=frameLinks(root),nextLinks=frameLinks(fresh);
  if(links.length===nextLinks.length)links.forEach((link,index)=>{const current=nextLinks[index].getAttribute('aria-current');if(current)link.setAttribute('aria-current',current);else link.removeAttribute('aria-current');});
  applyShellLayout(document,{layout:frame.layout,toggleable:frame.toggleable});
  state.menuOpen=setShellDrawer(document,frame.menuOpen,{mobile:frame.mobile});
  if(shellFrame.presence!==frame.user.presence)shellFrame.presence=setShellPresence(document,frame.user.presence,frame.user.name);
  // Another screen: an open popover of the shell (account menu, scope, "Mais") belonged to the last one.
  if(viewChanged)shellUI.close();
  const scroll=main.scrollTop;
  nextMain.innerHTML=String(content);
  main.replaceWith(nextMain);
  nextMain.scrollTop=sameScreen?scroll:0;
  Object.assign(shellFrame,{view:frame.view,screen});
  // The sheet of the inbox context marks the rest of #app inert; <main> changed under it.
  syncContextSheet();
  return true;
}
function render() {
  channelVisitorTestUI?.syncContext();
  if(typeof telegramAccountUI!=='undefined')telegramAccountUI.sync();
  state.scopedRunsEpoch = (state.scopedRunsEpoch || 0) + 1;
  modalRouteLifecycle.syncScope();
  commercialUsageUI.syncContext();
  memoryUI.syncContext();
  if(state.renderedInboxRef&&$('#message-text')&&!consolidatedInbox.saveDraft(state.renderedInboxRef,$('#message-text').value)){toast(t('Limite de rascunhos atingido. Envie ou limpe uma mensagem.'),true);return;}
  if($('#internal-note-text')&&noteDrafts.key&&!noteDrafts.save($('#internal-note-text').value)){Object.assign(state,state.renderedInboxContext);toast(t('Limite de notas em rascunho atingido. Salve ou limpe uma nota antes de trocar.'),true);return;}
  if(mediaUI.syncContext(attendanceContext(), $('#message-text')?.value)===false){Object.assign(state,state.renderedInboxContext);toast(t('O limite de rascunhos foi atingido. Envie ou limpe uma mensagem antes de trocar.'),true);return;}
  state.renderedInboxContext={view:state.view,conversation:state.conversation};
  const nextInboxRef=selectedInboxRef();
  if(inboxIdentity(state.renderedInboxRef)!==inboxIdentity(nextInboxRef)&&!mediaUI.draft)mediaUI.draft=consolidatedInbox.getDraft(nextInboxRef);
  state.renderedInboxRef=state.view==='inbox'?nextInboxRef:null;
  const recordingConversation=state.tenant?.conversations.find(item=>item.id===state.conversation);
  const nextComposerContext=JSON.stringify([state.boot?.session.userId,state.workspaceId,state.supportGrantId||null,state.tenant?.id,state.conversation]);
  if(state.composerContext!==nextComposerContext){state.composerMode='reply';state.composerContext=nextComposerContext;forwarding.close();}
  syncAttendanceTools();
  repliesUI.retainConversations(state.tenant?.conversations.map(c=>c.id)||[]);
  repliesUI.syncContext({workspaceId:state.workspaceId,tenantId:state.tenant?.id,conversationId:state.conversation,messages:recordingConversation?.messages||[],active:state.view==='inbox'});
  voiceRecorder.syncContext(state.view==='inbox'&&canSendTo(recordingConversation)&&supportsVoice(recordingConversation)?JSON.stringify([state.workspaceId,state.tenant?.id,state.conversation]):'');
  state.view=resolveView(state.view,navigationContext());
  groupsWorkspaceUI.syncContext();
  state.googleWidget?.destroy();state.googleWidget=null;
  const current = navigation.find(item => item[0] === state.view) || navigation[0];
  const resellerBrand = state.boot.reseller.brand, brandTokens = deriveBrandTokens(resellerBrand.accent);
  applyBrandTokens(document.documentElement, brandTokens);
  const prefs = syncThemePrefs(document.documentElement, state.boot.session.userId);
  // Shell (shell-ui.js): plain data in, markup out. The legacy view goes into <main> unchanged and
  // every name the person reads about the product comes from the workspace brand (white label).
  const session = state.boot.session, ctx = navigationContext(), mobile = matchMedia(SHELL_MOBILE_QUERY).matches;
  if (!mobile) state.menuOpen = false;
  const frame = { view: state.view, viewLabel: t(current[1]), ctx, brand: resellerBrand, workspace: { id: state.workspaceId, name: state.boot.reseller.name, kind: state.boot.reseller.accountKind },
    workspaces: state.boot.workspaces || [], supportGrantId: state.supportGrantId, support: state.supportGrantId ? { reason: session.supportReason, expiresAt: session.supportExpiresAt } : null,
    tenant: state.tenant, tenants: state.boot.tenants, user: { name: session.name, avatar: session.avatar, role: roleLabel(session), presence: session.presence || 'available' },
    locale: getLocale(), prefs, version: session.platformOwner && !state.supportGrantId ? state.boot.version : null, sandbox: Boolean(state.boot.sandbox),
    notice: shellNoticeDismissed(session.userId) ? null : session.role === 'reseller' && !state.supportGrantId ? 'admin' : 'operator',
    ...shellLayout({ wide: matchMedia(SHELL_WIDE_QUERY).matches, xwide: matchMedia(SHELL_XWIDE_QUERY).matches, view: state.view, collapsed: chatLayout.collapsed }),
    mobile, menuOpen: Boolean(state.menuOpen), mainClass: state.view === 'inbox' ? 'inbox-content' : state.view === 'team-chat' ? 'team-chat-content' : '' };
  const content = raw(screenFrame(state.view, ctx, views[state.view]())), signature = shellSignature(frame);
  modalRouteLifecycle.sync();
  if (!renderMain(frame, content, signature)) renderShell(frame, content, signature);
  chatLayout.sync();
  document.title = shellTitle({ screen: shellCrumbs({ view: state.view, viewLabel: frame.viewLabel }).screen, brand: resellerBrand.name });
  applyFavicon(document, { brand: resellerBrand, tokens: brandTokens });
  afterRender(state.view);
  avatarUI.bind();
  if (state.view === 'agents') mcpUI.mountUsage();
  if(state.view === 'integrations') integrationsUI.bind?.();
/*@anchor:render-agent-bindings*/
  if(state.view==='agents'&&state.boot.session.role==='reseller'&&!state.supportGrantId)bindAgentAdminProposals({root:$('#app'),tenantId:state.tenant.id,api,toast,refresh:async()=>{await refresh();render();},admin:true});
  if(state.view==='agents'&&(state.boot.session.role==='reseller'||state.boot.session.role===undefined&&state.boot.session.platformOwner===true)&&!state.supportGrantId&&!state.boot.session.supportGrantId&&(state.boot.session.platformOwner===true||$('#app')?.querySelector?.('[data-support-assistant-root]')))bindSupportAssistant({root:$('#app'),tenantId:state.tenant.id,api,toast,refresh:async()=>{await refresh();render();},admin:true,platformAdmin:state.boot.session.platformOwner===true,supportGrantId:state.supportGrantId||state.boot.session.supportGrantId||null});
/*@end:render-agent-bindings*/
  if(state.view === 'team-chat') teamChatUI.bind();
  if(state.view === 'groups') void groupsWorkspaceUI.bind().catch(()=>toast(t('Não foi possível abrir os grupos. Atualize a página e tente novamente.'),true));
  if ($('#message-text')) $('#message-text').value = mediaUI.draft;
  bindInboxMedia();
  composerStatus();
  if(typeof followUpsUI!=='undefined')void Promise.resolve(followUpsUI.sync()).catch(error=>toast(error.message,true));
  if(state.view==='inbox')void refreshScopedConversationRuns();
  if(state.view==='account'&&state.account.google.enabled&&!state.account.user.googleLinked){const element=$('#account-google');mountGoogleButton(element,state.account.google,async credential=>{try{await api('/api/auth/google/link',{method:'POST',body:JSON.stringify({credential})});await refresh();render();toast(t('Conta Google vinculada.'));}catch(error){toast(error.message,true);await refresh();render();}}).then(widget=>{if(element.isConnected)state.googleWidget=widget;else widget?.destroy();}).catch(()=>{if(element.isConnected)$('#account-google-status').textContent=t('O Google não carregou. Tente atualizar esta página.');});}
}

/*@end:navigation-heading*/
function pageHeading(eyebrow, title, description, actions = '') {
  return html`<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function metric(title, value, detail, glyph, color = '') { return html`<article class="metric"><div class="metric-top"><span>${title}</span><span class="metric-icon ${color}">${icon(glyph)}</span></div><strong class="metric-value">${value}</strong><div class="metric-detail">${detail}</div></article>`; }
/*@anchor:generated-channel-labels*/
const generatedChannelLabels = new Set([
  'Número A · demonstração', 'Número B · demonstração', 'Widget de demonstração', 'Integração pendente',
  'Webchat por origens autorizadas', 'Webchat desativado',
  'Meta configurada · aceite da conta pendente', 'Meta desativada', 'Webhook Meta recebido',
  'MepMail e relay assinado; caixa postal externa necessária', 'Canal de e-mail desativado',
  'Bot aguardando conexão', 'Aguardando configuração do canal'
]);
function displayChannelLabel(channel) {
  const label = channel?.label;
  if (typeof label !== 'string') return label;
  if (generatedChannelLabels.has(label)) return t(label);
  const testNumber = label.match(/^Número de teste · final (\d{4})$/);
  return testNumber?.[0] === label ? txt`Número de teste · final ${testNumber[1]}` : label;
}
/*@end:generated-channel-labels*/
const views = {
  'platform-users': () => platformUsersUI.view(),
  'connected-products': () => connectedProductsUI.view(),
  guide: () => createGuideMarkup({escape,icon,session:state.boot.session,accountKind:state.boot.reseller.accountKind,supportGrantId:state.supportGrantId,hasTenant:Boolean(state.tenant)}),
  platform: () => accountsUI.markup(true),
  accounts: () => accountsUI.markup(false),
  'team-chat': () => teamChatUI.render(),
  groups: () => groupsWorkspaceUI.render(),
  knowledge: () => knowledgeUI.panel(),
  overview() {
    const admin=state.boot.session.role==='reseller'&&!state.supportGrantId,services=servicePrincipalsUI.summary;
    return createOverviewMarkup({tenant:state.tenant,workspaceId:state.workspaceId,session:state.boot.session,
      accountOnboarding:state.boot.accountOnboarding,conversations:state.tenant?.conversations,channels:channels(),
      contacts:state.overviewLoaded?.contacts?state.contacts:null,assignees:state.overviewLoaded?.assignees?state.assignees:null,
      agents:state.tenant?.agents,runs:state.tenant?.runs,servicePrincipals:services?.loaded?services.items:null,metrics:state.metrics,
      loadState:{conversations:Array.isArray(state.tenant?.conversations)?'partial':'unavailable',channels:Array.isArray(state.tenant?.channels)?'loaded':'unavailable',
        contacts:state.overviewLoaded?.contacts?'loaded':'unavailable',assignees:state.overviewLoaded?.assignees?'loaded':'unavailable',
        agents:Array.isArray(state.tenant?.agents)?'loaded':'unavailable',runs:Array.isArray(state.tenant?.runs)?'partial':'unavailable',
        servicePrincipals:services?.error?'error':services?.loading?'loading':services?.loaded?'loaded':'unavailable',metrics:state.metrics?'loaded':'unavailable'},
      supportMode:Boolean(state.supportGrantId),access:{inboxRead:hasPermission('inbox.read'),contactsRead:hasPermission('contacts.read'),
        contactsWrite:hasPermission('contacts.write'),metricsRead:hasPermission('metrics.read'),manageChannels:admin,manageTeam:admin,
        manageAgents:admin,manageServices:admin,manageCompany:admin,teamChatRead:!state.supportGrantId},icon,avatarMarkup});
  },
  inbox() {
    // Atendimento v2 (§5.2.1): list | conversation | context. ≥1280 px three panels; 900–1279 px the
    // context is a non-modal drawer (ⓘ or i); <900 px one panel and the context in a sheet.
    const conversation=currentConversation(),open=Boolean(conversation)&&!state.contextCollapsed;
    return String(h`<div class="pg-inbox inbox-workspace${state.mobileChat&&conversation?' mobile-chat':''}" data-context="${open?'open':'closed'}" data-chat="${conversation?'open':'empty'}">${raw(consolidatedList())}<section class="pg-inbox__chat" id="chat-pane" aria-label="${conversation?t('Conversa com {name}',{name:conversation.contact}):t('Conversa atual')}">${conversation?raw(conversationPane(conversation)):h`<div class="pg-inbox__chat-empty">${emptyState({icon:'chat',title:t('Escolha uma conversa à esquerda ou use J/K.'),body:t('A empresa e o canal de cada conversa ficam sempre visíveis antes de responder.'),level:2})}</div>`}</section>${conversation?raw(conversationContext(conversation)):''}<button type="button" class="pg-inbox__scrim" data-action="toggle-context" aria-label="Fechar contexto do atendimento" tabindex="-1"${open?'':' hidden'}></button></div>`);
  },
  // Automação (automation, flows, quick-replies) comes from automation-ui.js below.
  tenants() { return unitsUI.markup(); },
  // Marca e domínio, Minha conta and Plataforma › Saúde e versão are drawn by settings-ui.js (P8);
  // Integrações by integrations-ui.js. SCREENS (below) routes those views to their modules.
  brand: () => '', account: () => '', architecture: () => '', integrations: () => ''
};

const flowTypes = { start: t('Entrada'), condition: t('Condição'), tag: t('Etiqueta'), department: t('Departamento'), handoff: t('Transferência'), end: t('Concluir') };
const workspaceUI=createWorkspaceUI({state,escape,icon,badge,button,avatarMarkup,contactAvatar,pageHeading,api,tenantApi,formModal,openModal,refresh,render,toast,navigate,hasPermission,canReplyTo,openContactConversation:(tenantId,id,isCurrent)=>selectInboxConversation(tenantId,id,{fromContact:true,isCurrent}),roleLabel,metric,updateContacts:()=>updateContactsPage()});
/*@anchor:contact-link-result-refresh*/
/*@anchor:contact-link-result*/
function applyContactLinkResult(result) {
  const c=currentConversation(),link=result.operation==='associate'?{conversationId:result.conversationId,contactId:result.contact.id,version:result.version,...(result.contactSyncStatus?{contactSyncStatus:result.contactSyncStatus}:{})}:result.links.find(link=>link.conversationId===c?.id);
  if(c&&link?.conversationId===c.id){c.contactId=link.contactId||null;c.version=link.version;if(link.contactSyncStatus)c.contactSyncStatus=link.contactSyncStatus;else delete c.contactSyncStatus;const footer=$('.context-version');if(footer)footer.innerHTML=icon('shield')+t(' Versão ')+c.version+html`<p>Alterações da conversa invalidam respostas preparadas no contexto anterior.</p>`;}
  contactLinksUI.reset();contactRefresh.reset();memoryUI.reset();updateContactsPage();updateClientRecord();toast(result.operation==='associate'?t('Cadastro vinculado.'):result.operation==='undo'?t('União desfeita. Cadastros e vínculos restaurados.'):t('Contatos unidos. O cadastro de origem foi preservado.'));
}
/*@end:contact-link-result*/
const contactLinksUI=createContactLinksUI({
  getContext:()=>({workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot?.session.userId,authorityKey:inboxContactAuthority(),view:state.view,sequence:state.inboxSelectionSequence,refreshSequence:state.refreshSequence,canRead:hasPermission('contacts.read'),canWrite:hasPermission('contacts.write'),canTransfer:hasPermission('inbox.transfer')}),
  getConversation:currentConversation,request:api,formModal,getModal:()=>$('#modal'),escape,
  applyContacts:contacts=>{for(const contact of contacts){const index=state.contacts.findIndex(c=>c.id===contact.id);if(index<0)state.contacts.push(contact);else state.contacts[index]=contact;}},
  onApplied:applyContactLinkResult
});
/*@end:contact-link-result-refresh*/
/*@anchor:contact-refresh*/
const contactRefresh=createContactRefresh({
  getContext:()=>({workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot?.session.userId,supportGrantId:state.supportGrantId,authorityKey:inboxContactAuthority(),refreshSequence:state.refreshSequence,view:state.view,canRead:hasPermission('contacts.read'),paused:Boolean(state.busy||state.inboxSelecting||mediaUI.sending||voiceRecorder.busy||$('#modal')?.open)}),
  request:api,
  onContacts:contacts=>{state.contacts=contacts;updateContactsPage();updateClientRecord();},
  onDenied:()=>{state.contacts=[];workspaceUI.resetContacts();const modal=$('#modal');if(modal?.open&&modal.querySelector('[data-dialog-form="contact"], [data-dialog-form="contact-open"], [data-dialog-form="contact-link-select"], [data-dialog-form="contact-link-confirm"], .contact-history'))modal.close();updateContactsPage();updateClientRecord();toast(t('Seu acesso aos contatos mudou. Atualize o workspace.'),true);}
});
/*@end:contact-refresh*/
const accountSecurityUI=createAccountSecurityUI({state,escape,icon,badge,button,api,openModal,refresh,render,toast});
Object.assign(views,workspaceUI.views);
Object.assign(views,{'support':()=>supportUI.markup(),'billing':()=>subscriptionUI.markup()+billingUI.render()+(accountDeletionEligible(state.boot,{supportGrantId:state.supportGrantId})?accountDeletionSection():'')/*@subscription:mount*/,'platform-billing':billingUI.render});
/*@anchor:contacts-page*/
function updateContactsPage(){
  if(state.view!=='contacts')return;
  const panel=$('.crm-panel');if(!panel)return;
  const active=document.activeElement,direction=active?.dataset.contactDirection,action=active?.dataset.action,id=active?.dataset.id,template=document.createElement('template');template.innerHTML=workspaceUI.views.contacts();
  for(const selector of ['tbody','[data-contact-pagination]','[data-contact-summary]']){const target=panel.querySelector(selector),fresh=template.content.querySelector(selector);if(target&&fresh)target.innerHTML=fresh.innerHTML;}
  if(direction){const button=panel.querySelector(`[data-contact-direction="${direction}"]`);if(button&&!button.disabled)button.focus({preventScroll:true});}
  else if(action&&id){const button=[...panel.querySelectorAll('button[data-action][data-id]')].find(item=>item.dataset.action===action&&item.dataset.id===id);button?.focus({preventScroll:true});}
  avatarUI.bind();
}
function updateClientRecord(){
  if(state.view!=='inbox')return;
  updateCustomerContext();
  const old=$('.context-client-record'),conversation=currentConversation();if(!old||!conversation)return;
  const markup=clientRecordMarkup(conversation,{contacts:state.contacts,canRead:hasPermission('contacts.read'),canWrite:hasPermission('contacts.write'),canTransfer:hasPermission('inbox.transfer'),escape,icon});
  if(old.outerHTML===markup)return;
  const active=document.activeElement,focus=old.contains(active)?{action:active.dataset.action,id:active.dataset.id}:null,notesOpen=Boolean(old.querySelector('.client-notes')?.open);
  if(!markup){old.remove();return;}
  const template=document.createElement('template');template.innerHTML=markup;const fresh=template.content.firstElementChild;
  if(notesOpen&&fresh.querySelector('.client-notes'))fresh.querySelector('.client-notes').open=true;
  old.replaceWith(fresh);
  if(focus?.action&&focus.id)[...fresh.querySelectorAll('button[data-action][data-id]')].find(item=>item.dataset.action===focus.action&&item.dataset.id===focus.id)?.focus({preventScroll:true});
}
function updateCustomerContext(){
  if(state.view!=='inbox')return;
  const old=$('[data-customer-context-panel]');if(!old)return;
  const nextMarkup=customerContextUI.markup();if(old.outerHTML===nextMarkup)return;
  const active=document.activeElement,focus=old.contains(active)?{action:active.dataset.customerContextAction,id:active.dataset.conversationId}:null;
  const opened=[...old.querySelectorAll('details')].map(item=>item.open);
  const template=document.createElement('template');template.innerHTML=nextMarkup;const fresh=template.content.firstElementChild;
  if(!fresh){old.remove();return;}
  [...fresh.querySelectorAll('details')].forEach((detail,index)=>{detail.open=opened[index]===true;});
  old.replaceWith(fresh);
  if(focus?.action)[...fresh.querySelectorAll('[data-customer-context-action]')].find(item=>item.dataset.customerContextAction===focus.action&&item.dataset.conversationId===focus.id)?.focus({preventScroll:true});
}
/*@end:contacts-page*/
const automationUI=createAutomationUI({state,escape,icon,badge,button,avatarMarkup,pageHeading,api,tenantApi,formModal,openModal,refresh,render,toast,navigate,hasPermission,roleLabel,metric});
Object.assign(views,automationUI.views);
const mcpUI=createMcpUI({state,escape,icon,badge,api,tenantApi,formModal,refresh,render,toast,navigate});
// Agent rail (agent-rail-ui.js, P4): run cards, approval decisions and the "Acionar copiloto" form,
// moved out of mcp-ui.js unchanged; composerBridge (composer-ui.js, P3) is how it reaches the composer.
const composerBridge=createComposerBridge({doc:document,getMode:()=>state.composerMode});
const agentRail=createAgentRail({state,escape,icon,badge,api,tenantApi,formModal,refresh,render,toast,canReplyTo:canCoordinate,renderRuns:renderConversationRuns,captureRuns:captureScopedRuns,loadRuns:refreshScopedConversationRuns,runNames,composerBridge,
  knowledgeReferences:run=>knowledgeUI.runReferences(run),memoryReferences:run=>memoryUI.runReferences(run)});
const knowledgeUI=createKnowledgeUI({state,escape,icon,badge,button,pageHeading,api,tenantApi,formModal,openModal,refresh,render,toast,navigate,renderRuns:renderConversationRuns});
const memoryUI=createAgentMemoryUI({state,escape,attr:escape,icon,api,tenantApi,formModal,closeModal:()=>$('#modal').close(),toast});
// Plataforma › Integrações (integrations-ui.js, P8): Google, e-mail and the copilot provider of the
// platform, the backup and the catalog of the selected company. The MCP panel lives in Agentes › Ferramentas.
const integrationsUI = createIntegrationsUI({state,escape,icon,openModal,mcpSummary:mcpUI.summary});
views.integrations = integrationsUI.view;
/*@anchor:delegated-screens*/
// Delegated screens (FRONTEND-V2 §8.1 seam 2, contracts of §8.2): the owner package rewrites its module
// and never app.js. Commit 1f moved the legacy markup into them unchanged (agents, channels,
// service-agents) and routed the new #pending and #setup and the tabs of the Configurações and
// Plataforma hubs through them. Each screen gets the route on screen (router.js object) in view(route),
// answers its '<ns>:*' actions and data-form="<ns>:…" forms through the registry (actions.js) and may
// expose mount(main, route), called after each render of its view. render() keeps the hub tabs.
// Commit 1g: the Ferramentas tab of the agents hub ('agent-tools', #agents/tools, workspace admin) is
// drawn by agents-hub-ui with the MCP panel of mcp-ui (servers, catalog and grants of the company).
// Every tab of the agents hub that is a screen of nav-config's SCREEN_VIEWS (not a legacy view) goes
// to agents-hub-ui too, so a new hub tab (P5: Atividade, Uso) needs nav-config only, never app.js.
const agentsHub=createAgentsHub({state,escape,pageHeading,renderAgentAdminProposals,renderSupportAssistant,mcpPanel:()=>mcpUI.panel()});
// Support-only render seam: the hub keeps its legacy owner panel; other admins see their own catalog.
const supportAgentsView=agentsHub.view;
agentsHub.view=route=>supportAgentsView(route)+(!route?.params?.agentId&&!route?.params?.tab&&state.boot?.session?.platformOwner!==true?renderSupportAssistant(state):'');
channelVisitorTestUI=createChannelVisitorTestUI({state,api,channels,getRoute:()=>parseHash(location.hash),canUse:()=>!reauthPending(),onChange:()=>render()});
const channelsUI=createChannelsUI({state,channels,durableOnboarding:true,visitorTestUI:channelVisitorTestUI,openTelegramAccount:channel=>telegramAccountUI.open(channel)});
const connectWizard=createAgentConnectWizard({pageHeading,principals:()=>servicePrincipalsUI.markup(),state,request:api,toast:(message,error)=>toast(message,error),refresh:async()=>{await refresh();render();}});
const pendingUI=createPending({pageHeading,state,request:api,attention:()=>attention,toast:(message,error)=>toast(message,error)});
const onboardingUI=createOnboarding({pageHeading,durableOnboarding:true});
// P8: settings-ui.js draws the tabs of Configurações and Plataforma (with Registro de atividades and
// Visão), Clientes (#accounts), Indicadores (#metrics), Ajuda (#help) and Minha conta (#account); the
// markup of each tab still comes from its module (legacyHubViews). Every dependency is read lazily.
const legacyHubViews={...views};
const settingsUI=createSettings({legacy:key=>legacyHubViews[key](),state,request:(...args)=>api(...args),render:()=>render(),refresh:async()=>{await refresh();render();},toast:(message,error)=>toast(message,error),
  brandDraft:()=>brandDraft(),account:()=>accountScreenData(),plans:()=>plansUI.page(),plansAction:(name,id)=>plansUI.pageAction(name,id),plansSubmit:form=>plansUI.pageSubmit(form),clients:tab=>loadClientsTab(tab),openAccount:id=>accountsUI.open(id),
  platformSummary:()=>accountsUI.summary(true),reloadPlatform:()=>accountsUI.load(true),mcp:()=>mcpUI});
const SCREENS={agents:agentsHub,channels:channelsUI,'service-agents':connectWizard,pending:pendingUI,setup:onboardingUI,
  ...Object.fromEntries(HUBS.agents.tabs.filter(tab=>Object.hasOwn(SCREEN_VIEWS,tab.view)).map(tab=>[tab.view,agentsHub])),
  ...Object.fromEntries([...HUBS.settings.tabs,...HUBS.platform.tabs].map(tab=>[tab.view,settingsUI])),accounts:settingsUI,metrics:settingsUI,guide:settingsUI,account:settingsUI};
for(const view of Object.keys(SCREENS))views[view]=()=>SCREENS[view].view(screenRoute(view));
for(const [namespace,screen] of [['agents',agentsHub],['channels',channelsUI],['connect',connectWizard],['pending',pendingUI],['setup',onboardingUI],['settings',settingsUI],['rail',agentRail]])registerScreen(namespace,screen);
// Route of a delegated screen: the hash when it opens this view (tab, ids, step), else the canonical
// route of the view. The route each screen received is kept so a hash change inside it re-renders.
function screenRoute(view){
  const parsed=parseHash(location.hash),route=parsed&&viewForRoute(parsed)===view?parsed:routeForView(view);
  (state.screenRoutes||={})[view]=JSON.stringify([route?.section||null,route?.params||{}]);
  return route;
}
// Workspace or company changed: the agent rail and every delegated screen forget their state.
function resetScreens(){agentRail.reset();for(const screen of new Set(Object.values(SCREENS)))screen.reset();}
// Live modules of P2, created once (stubs with today's behaviour in commit 1f).
const attention=createAttention({request:api,pending:pendingUI,context:()=>({workspaceId:state.workspaceId,userId:state.boot?.session.userId,supportGrantId:state.supportGrantId||null,view:state.view,tenantId:state.tenant?.id||null,tenantName:state.tenant?.name||'',admin:state.boot?.session.role==='reseller'&&!state.supportGrantId,runs:state.tenant?.runs||[],channels:state.tenant?.channels||[],features:state.boot?.features||[]})});
const notify=createNotify({attention});
let live=null;
const connection=createConnectionStatus({live:{state:()=>live?.state()||{running:false,tasks:[],connection:null}}});
// After every render (the frame persists since P10 and <main> is new): P2 patches the shell (connection
// indicator, counters, title and favicon), the keyboard learns the screen and a delegated screen mounts.
function afterRender(view){
  connection.apply(document);notify.apply(document);keyboard.setScope(view);
  const screen=SCREENS[view];if(typeof screen?.mount==='function')screen.mount(document.getElementById('main-content'),screenRoute(view));
}
/*@end:delegated-screens*/

// Fluxos: the screen is flow-workspace-ui.js (P8-B); app.js keeps the versioned steps it calls by their
// legacy names (selectFlow, saveFlow, the draft guard, new-flow, save-flow, publish-flow, flow-json).
function flowTemplate(kind = 'linear', departmentId = '') {
  return createFlowTemplate(kind, { departmentId, departments: state.tenant?.departments || [] });
}
function selectFlow(id) {
  const flow = state.flows.find(item => item.id === id);
  state.flowId = flow?.id || null; state.flowDraft = flow ? flowEditorGraph(flow) : null; state.flowNode = flow?.graph.nodes[0]?.id || null; state.flowDirty = false; state.flowResult = null;
}
function attendanceSummary(conversation) {
  const tags=Array.isArray(conversation.tags)?conversation.tags:[],labels=tags.slice(0,2);
  return String(h`<div class="pg-inbox__summary" data-attendance-summary aria-label="Resumo do atendimento">${uiBadge(statusNames[conversation.status]||t('Atendimento'),conversation.status==='pending'?'warning':conversation.status==='closed'?'neutral':'info')}<span class="pg-inbox__summary-item" title="Departamento">${raw(icon('users'))}${conversation.department||t('Sem departamento')}</span>${conversation.conversationKind==='group'?uiBadge(conversation.threadId?t('Grupo · tópico ')+conversation.threadId:t('Grupo'),'accent'):''}<span class="pg-inbox__summary-tags">${labels.map(tag=>uiBadge(tag))}${tags.length>2?h`<button type="button" class="ui-btn ui-btn--link ui-btn--sm" data-action="show-context" aria-label="${t('Ver todas as {count} etiquetas do atendimento',{count:tags.length})}"><span class="ui-btn__label">+${tags.length-2}</span></button>`:''}</span></div>`);
}
function updateAttendanceSummary(conversation) {
  const current=$('[data-attendance-summary]');
  if(current){const template=document.createElement('template');template.innerHTML=attendanceSummary(conversation);if(current.innerHTML!==template.content.firstElementChild.innerHTML)current.replaceWith(template.content.firstElementChild);}
  const banner=$('[data-agent-banner]'),markup=String(agentOwnerBanner(conversation));if(banner&&banner.dataset.markup!==markup){banner.innerHTML=markup;banner.dataset.markup=markup;}
}
// owner=agent (§5.2.3): the conversation is with an agent. Without autopilot on its channel nobody
// answers the customer automatically ("Sem resposta automática · Assuma"); with autopilot the agent
// answers alone and a person can still take over. The take-over button follows the same rule as the
// Atendimento tab (never offered when the server would refuse it).
function canTakeOver(c){const session=state.boot?.session;return Boolean(c&&c.status!=='closed'&&!canReplyTo(c)&&hasPermission('inbox.reply')&&(!c.assignedUserId||c.assignedUserId===session?.userId||session?.role==='reseller'));}
function agentOwnerBanner(c){
  if(!c||c.owner!=='agent'||c.status==='closed')return '';
  const agent=(state.tenant?.agents||[]).find(item=>item.id===c.agentId),name=agent?.name||t('Agente'),auto=autopilotOn(agent||null,c.channelId)===true;
  const action=canTakeOver(c)?h`<button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="takeover"><span class="ui-btn__label">Assumir</span></button>`:'';
  // Assignment identifies a connected adapter; it does not prove execution or delivery.
  if(agent?.provider==='mcp')return connectedAgentBanner(c,agent,action);
  return auto
    ? h`<div class="pg-inbox__notice pg-inbox__notice--agent" role="note"><span class="pg-inbox__notice-glyph" aria-hidden="true">✦</span><p><strong>Piloto automático ativo</strong> · ${t('{agent} responde sozinho neste canal. Pedido de pessoa, mídia ou falta de base passam para a equipe.',{agent:name})}</p>${action}</div>`
    : h`<div class="pg-inbox__notice pg-inbox__notice--warning" role="note"><span class="pg-inbox__notice-glyph" aria-hidden="true">✦</span><p><strong>Sem resposta automática</strong> · ${t('Este atendimento está com o agente {agent}, que não responde automaticamente nesta empresa.',{agent:name})}${action?'':h` ${t('Peça a quem coordena o atendimento para assumir.')}`}</p>${action}</div>`;
}
function connectedAgentBanner(c,agent,action){
  const channel=channelFor(c),pace=replyPace({messages:c.messages||[],policy:channel?.replyPolicy||null,exempt:c.replyExempt===true,now:Date.now()});
  const paceText=pace.mode==='team'?t('Equipe/QA: sem limite por hora · {minute} de {max} no minuto',{minute:pace.minute,max:pace.perMinute})
    :pace.mode==='assistant'?t('Ritmo: {minute} de {perMinute} no minuto · {hour} de {perHour} na hora',{minute:pace.minute,perMinute:pace.perMinute,hour:pace.hour,perHour:pace.perHour})
    :t('{hour} respostas do agente na última hora',{hour:pace.hour});
  const admin=state.boot?.session?.role==='reseller'&&!state.supportGrantId&&c.conversationKind!=='group';
  const qa=admin?h`<button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-action="conversation-reply-exempt" data-exempt="${c.replyExempt===true?'false':'true'}"><span class="ui-btn__label">${c.replyExempt===true?t('Tirar de equipe/QA'):t('Marcar como equipe/QA')}</span></button>`:'';
  return h`<div class="pg-inbox__notice pg-inbox__notice--agent" role="note" data-connected-agent="${agent.id}"><span class="pg-inbox__notice-glyph" aria-hidden="true">✦</span><p><strong>${t('Atendimento atribuído a {agent}',{agent:agent.name||t('Agente')})}</strong> · ${t('Agente conectado por MCP; atribuição não comprova resposta em execução. Assuma para escrever você e interromper o agente.')}<span class="pg-inbox__notice-meta" data-agent-pace="${pace.mode}">${paceText}</span></p>${qa}${action}</div>`;
}
function attendanceRoleText(conversation){return {responsible:t('Responsável'),collaborator:t('Colaborando'),observer:t('Observando')}[attendanceRole(conversation)];}
function attendanceComposerText(conversation){return attendanceRole(conversation)==='collaborator'?t('Colaborando neste atendimento'):canReplyTo(conversation)?t('Responder por esta conexão'):t('Observando');}
function attendancePrimaryActions(conversation){
  const manage=canManageAttendance(conversation),actionButton=(label,action,glyph,disabled=false)=>html`<button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__action" data-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${disabled?'disabled':''}>${icon(glyph)}<span class="pg-inbox__action-label" aria-hidden="true">${escape(label)}</span></button>`;
  return actionButton(t('Acompanhamentos'),'conversation-follow-ups','clock')+actionButton(t('Buscar nesta conversa'),'conversation-search','search')+(directHistoryAllowed(conversation)?actionButton(t('Buscar mensagens anteriores no WhatsApp'),'conversation-older-history','clock'):'')+actionButton(t('Arquivos da conversa'),'conversation-gallery','paperclip')+html`<button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__action" data-action="conversation-participants" aria-label="Participantes do atendimento" title="Participantes do atendimento">${icon('users')}<span class="pg-inbox__action-label" aria-hidden="true">Participantes</span></button>`+(canRefreshDeviceReads(conversation,readDeviceContext())?actionButton(t('Atualizar leituras do celular neste canal'),'conversation-refresh-device-reads','refresh'):'')+actionButton(readActionLabel(conversation,readDeviceContext()),'conversation-read','chat')+(canSyncDeviceRead(conversation,readDeviceContext())?actionButton(t('Sincronizar leitura com WhatsApp'),'conversation-sync-read','refresh'):'')+(conversation.status==='closed'?actionButton(t('Reabrir atendimento'),'conversation-reopen','refresh',!manage):actionButton(t('Transferir atendimento'),'transfer-conversation','arrow',!manage)+actionButton(t('Devolver à fila'),'attendance-queue','arrow',!manage)+actionButton(conversation.status==='pending'?t('Retomar atendimento'):t('Marcar como pendente'),'conversation-pending','clock',!manage)+actionButton(t('Encerrar atendimento'),'conversation-close','check',!manage));
}
function attendanceAccessBanner(conversation){
  if(canReplyTo(conversation)&&!groupOpen(conversation))return html`<div class="pg-inbox__notice pg-inbox__notice--warning">${icon("users")}<p>Respostas para este grupo estão bloqueadas. Confira a seleção, a presença do bot e possíveis conflitos em Canais → Grupos. O histórico e as notas internas continuam disponíveis.</p></div>`;
  if(canSendTo(conversation)&&capabilitiesFor(conversation).textSupported===false)return html`<div class="pg-inbox__notice pg-inbox__notice--info">${icon("users")}<p>O Telegram restringiu respostas de texto neste grupo. Você pode anexar os tipos de arquivo permitidos; as notas internas continuam disponíveis.</p></div>`;
  if(canReplyTo(conversation)&&!windowOpen(conversation))return html`<div class="pg-inbox__notice pg-inbox__notice--warning">${icon('clock')}<p>Janela de resposta encerrada. Aguarde uma nova mensagem do contato. As notas internas continuam disponíveis.</p></div>`;
  if(attendanceRole(conversation)==='collaborator')return html`<div class="pg-inbox__notice pg-inbox__notice--info">${icon('users')}<p><strong>Colaborando</strong> · ${escape(conversation.assignedUserName||t('O responsável'))} coordena o atendimento. Você pode responder, enviar arquivos e registrar notas internas.</p></div>`;
  if(canReplyTo(conversation))return '';
  const manage=canManageAttendance(conversation);
  return html`<div class="pg-inbox__notice pg-inbox__notice--neutral">${icon('users')}<p>${conversation.status==='closed'?t('Atendimento encerrado. Reabra para voltar à fila.'):conversation.assignedUserId?t('Observando · atendimento com ')+escape(conversation.assignedUserName||t('outro atendente'))+'.':conversationAgent(conversation)?escape(t('{agent} está respondendo. Ao assumir, o agente para.',{agent:conversationAgent(conversation).name||t('Agente')})):t('Assuma o atendimento para responder.')}</p>${conversation.status==='closed'?html`<button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="conversation-reopen" ${!manage?'disabled':''}><span class="ui-btn__label">Reabrir</span></button>`:html`<button type="button" class="ui-btn ui-btn--primary ui-btn--sm" data-action="takeover" ${!hasPermission('inbox.reply')||conversation.assignedUserId&&conversation.assignedUserId!==state.boot.session.userId&&state.boot.session.role!=='reseller'?'disabled':''}><span class="ui-btn__label">${conversation.assignedUserId&&conversation.assignedUserId!==state.boot.session.userId?t('Assumir de ')+escape(conversation.assignedUserName||t('outro atendente')):t('Assumir')}</span></button>`}</div>`;
}
/*@anchor:attendance-access*/
function updateAttendanceAccess(conversation=currentConversation()){
  if(!conversation||state.view!=='inbox')return;
  const reply=canReplyTo(conversation),coordinate=canCoordinate(conversation),manage=canManageAttendance(conversation),channel=channelFor(conversation),role=attendanceRole(conversation);
  const origin=$('.chat-origin');if(origin)origin.textContent=`${channel?.name||''} · ${ownerLabel(conversation)}`;
  const roleNode=$('[data-attendance-role]');if(roleNode){roleNode.textContent=attendanceRoleText(conversation);roleNode.className='attendance-role '+role;}
  const actions=$('.chat-primary-actions'),actionsKey=JSON.stringify([conversation.status,conversation.unread,manage,role,conversation.assignedUserId,channel?.kind,channel?.transport,state.supportGrantId||null]);
  if(actions&&actions.dataset.accessKey!==actionsKey){actions.innerHTML=attendancePrimaryActions(conversation);actions.dataset.accessKey=actionsKey;}
  const banner=$('[data-attendance-banner]'),bannerKey=JSON.stringify([role,reply,conversation.status,conversation.assignedUserId,conversation.assignedUserName,manage,windowOpen(conversation),groupOpen(conversation),capabilitiesFor(conversation).textSupported,conversation.channelAvailability?.group?.sendPermissions]);
  if(banner&&banner.dataset.accessKey!==bannerKey){banner.innerHTML=attendanceAccessBanner(conversation);banner.dataset.accessKey=bannerKey;}
  const composerOrigin=$('[data-composer-access]');if(composerOrigin)composerOrigin.textContent=reply&&role!=='collaborator'?'':attendanceComposerText(conversation);
  updateVoiceControls();repliesUI.updateQuoteComposer(!reply||!supportsQuote(conversation));
  for(const control of $('#internal-note-form')?.querySelectorAll('textarea,button')||[])control.disabled=!reply||state.busy;
  for(const control of $('#messages')?.querySelectorAll('[data-reply-action="quote"]')||[])control.disabled=!reply||!supportsQuote(conversation);
  for(const control of $('#messages')?.querySelectorAll('[data-action="forward-message"]')||[]){control.disabled=!coordinate||!capabilitiesFor(conversation).forward;control.hidden=!coordinate||!capabilitiesFor(conversation).forward;}
  const details=$('#conversation-details-form fieldset');if(details)details.disabled=!manage;
  const responsible=$('.attendant-name');if(responsible)responsible.textContent=ownerLabel(conversation);
  for(const control of $('#conversation-context')?.querySelectorAll('[data-action="transfer-conversation"]')||[])control.disabled=!manage||conversation.status==='closed';
  const flow=$('[data-action="conversation-flow"]');if(flow)flow.disabled=!manage||!state.flows.some(item=>item.publishedVersion);
  const assignedAgent=$('#assigned-agent');if(assignedAgent)assignedAgent.disabled=!coordinate;
  for(const control of $('#conversation-context')?.querySelectorAll('[data-action="run-agent"]')||[])control.disabled=!coordinate||!state.tenant.agents.some(item=>item.configured);
  const help=$('#conversation-context .group-help');if(help)help.textContent=coordinate?t('O copiloto prepara. Você revisa e envia.'):t('O responsável coordena o copiloto, os agendamentos e os encaminhamentos.');
  if(!reply){if(state.sendIntent){mediaUI.clearSent();consolidatedInbox.clearDraft(selectedInboxRef());if($('#message-text'))$('#message-text').value='';toast(t('O acesso mudou. Confira no destino o envio anterior sem confirmação.'),true);}state.sendIntent=null;state.noteIntent=null;voiceRecorder.reset();}
  participantsUI.sync();serviceHandoffsUI.sync();memoryUI.syncContext();
  if(typeof followUpsUI!=='undefined')void Promise.resolve(followUpsUI.sync()).catch(error=>toast(error.message,true));
}
/*@end:attendance-access*/
function conversationPane(conversation) {
  // Conversation v2 (§5.2.3): header with the origin always visible, the agent alert, the timeline
  // (role=log, window of 60), the agent rail host (P4 draws its content) and the 2-mode composer.
  const channel=channelFor(conversation),capabilities=capabilitiesFor(conversation),real=isRealConversation(conversation),media=supportsMedia(conversation),sendReply=canSendTo(conversation),platform=transportName(conversation),group=conversation.conversationKind==='group',reply=canReplyTo(conversation);
  const mode=state.composerMode==='note'?'note':'reply',contextOpen=!state.contextCollapsed;
  const agentReady=state.tenant.agents.some(a=>a.configured&&a.provider==='hermes'&&a.mode==='copilot');
  return html`<header class="pg-inbox__head"><button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__back" data-action="mobile-inbox-back" aria-label="Voltar à lista de conversas" title="Voltar à lista de conversas">${icon('arrow')}</button><span class="pg-inbox__head-avatar">${conversationAvatar(conversation)}</span><div class="pg-inbox__who"><h2 class="pg-inbox__name">${escape(conversation.contact)}</h2><p class="pg-inbox__where">${companyMark(state.tenant)}<span class="pg-inbox__where-sep" aria-hidden="true">›</span><span class="chat-origin">${escape(channel?.name||'')} · ${escape(ownerLabel(conversation))}</span><span class="attendance-role ${attendanceRole(conversation)}" data-attendance-role>${attendanceRoleText(conversation)}</span></p></div><div class="pg-inbox__head-tools"><div class="pg-inbox__actions chat-primary-actions" id="conversation-actions">${attendancePrimaryActions(conversation)}</div><button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__overflow" data-action="inbox:actions" aria-expanded="false" aria-controls="conversation-actions" aria-label="Mais ações do atendimento" title="Mais ações do atendimento">${icon('more')}</button><button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__expand" data-layout-action="expand" aria-controls="chat-pane" aria-expanded="false" aria-label="Expandir chat" title="Expandir chat">${icon('maximize')}</button><button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__context-toggle" data-action="toggle-context" aria-controls="conversation-context" aria-expanded="${contextOpen}" aria-label="${contextOpen?t('Recolher contexto do atendimento'):t('Mostrar contexto do atendimento')}" title="${contextOpen?t('Recolher contexto do atendimento'):t('Mostrar contexto do atendimento')}">${icon('info')}</button></div></header><div class="pg-inbox__banners" data-agent-banner>${agentOwnerBanner(conversation)}</div>${attendanceSummary(conversation)}<div class="pg-inbox__timeline" id="messages" role="log" aria-live="polite" aria-relevant="additions" aria-label="Mensagens da conversa" tabindex="0">${conversationMessages(conversation)}</div><button type="button" id="new-message-indicator" class="pg-inbox__unseen" data-action="latest-messages" hidden><span data-unseen-label>Novas mensagens</span><span aria-hidden="true"> ↓</span></button><div id="conversation-tools-host">${conversationTools.panel()}</div><section class="pg-inbox__rail" id="agent-rail" aria-label="Agente nesta conversa">${conversationRuns(conversation)}</section><div class="pg-inbox__composer" data-mode="${mode}"><div class="pg-inbox__access" data-attendance-banner>${attendanceAccessBanner(conversation)}</div><div class="pg-inbox__composer-top">${composerModeMarkup(mode,{disabled:!reply})}<span class="pg-inbox__hint">${kbd('mod+enter')}</span></div>${composerChoiceMarkup()}${composerOriginFor(conversation)}<form id="message-form" class="pg-inbox__form" ${mode==='note'?'hidden':''} aria-busy="${mediaUI.sending}" data-media-enabled="${media}">${repliesUI.quoteComposer(!reply||!supportsQuote(conversation))}${mediaUI.composer(!sendReply||!media,{audioCaptionAllowed:capabilities.audioCaptionSupported})}<div id="pending-send-host">${pendingSendMarkup()}</div><label class="sr-only" for="message-text">${mediaUI.selected?t('Legenda do arquivo (opcional)'):t('Mensagem ao cliente')}</label><textarea id="message-text" class="pg-inbox__field" name="text" placeholder="${mediaUI.selected?t('Adicione uma legenda ou envie o arquivo…'):capabilities.textSupported===false?t('Anexe um arquivo permitido neste grupo…'):t('Escreva uma resposta… (/ abre as respostas rápidas)')}" maxlength="${mediaUI.selected?Math.max(1,capabilities.captionMaxLength):capabilities.maxTextLength*(capabilities.unicodeLength?2:1)}" aria-describedby="message-media-error${mediaUI.selected?' attachment-caption-note':''}" rows="2" ${!sendReply||!mediaUI.selected&&capabilities.textSupported===false||mediaUI.sending?'disabled':''}></textarea><div class="pg-inbox__composer-bar"><div class="pg-inbox__tools"><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-reply-action="open" aria-label="Respostas rápidas" ${!reply||mediaUI.sending?'disabled':''} title="Respostas rápidas">${icon('document')}<span class="ui-btn__label">Respostas</span></button>${mediaUI.fileButton(!sendReply||!media)}<div id="voice-controls" class="pg-inbox__voice">${voiceRecorder.markup(!sendReply||!capabilities.voice||Boolean(mediaUI.selected))}</div><button type="button" class="ui-iconbtn ui-iconbtn--sm" data-action="composer-emoji" aria-label="Inserir emoji" title="Inserir emoji" ${!reply?'disabled':''}><span aria-hidden="true">☺</span></button><button type="button" class="ui-iconbtn ui-iconbtn--sm" data-action="schedule-message" aria-label="Mensagens agendadas" title="Mensagens agendadas" ${!canCoordinate(conversation)||!real?'disabled':''}>${icon('clock')}</button>${typeof agentRail.composerButton==='function'?String(agentRail.composerButton(conversation)):html`<button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__agent-button" data-action="run-agent" aria-label="Gerar rascunho com o agente" title="Gerar rascunho com o agente" ${!canCoordinate(conversation)||mediaUI.sending||!agentReady?'disabled':''}><span aria-hidden="true">✦</span></button>`}</div><button type="submit" class="ui-btn ui-btn--primary ui-btn--md pg-inbox__send" aria-label="Enviar ao cliente" ${!sendReply||!mediaUI.selected&&capabilities.textSupported===false||mediaUI.sending?'disabled':''}>${icon('send')}<span class="ui-btn__label">Enviar ao cliente</span></button></div></form><form id="internal-note-form" class="pg-inbox__form" ${mode!=='note'?'hidden':''}><label class="sr-only" for="internal-note-text">Nota interna do atendimento</label><textarea id="internal-note-text" class="pg-inbox__field" name="text" maxlength="2000" rows="2" placeholder="Registre o contexto para sua equipe…" ${!reply?'disabled':''}>${escape(noteDrafts.value)}</textarea><div class="form-error" role="alert"></div><div class="pg-inbox__composer-bar"><p class="pg-inbox__note-help">${icon('shield')}<span>Não vai para o cliente nem para o agente.</span></p><button type="submit" class="ui-btn ui-btn--secondary ui-btn--md pg-inbox__save-note" ${!reply?'disabled':''}>${icon('check')}<span class="ui-btn__label">Salvar nota</span></button></div></form><div class="pg-inbox__status"><span>${real?group?t('Resposta para o grupo'):t('Resposta pelo ')+platform:t('Conversa de demonstração')}</span><span data-composer-count>0 / ${state.composerMode==='note'?'2.000':capabilities.maxTextLength.toLocaleString(getLocale())}</span></div></div>`;
}
/*@anchor:message-date*/
function messageDate(value){const date=new Date(value);return Number.isNaN(date.valueOf())?t('Histórico'):date.toLocaleDateString(getLocale(),{day:'numeric',month:'long',year:'numeric'});}
function conversationMessage(message,previous,index){
 const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation),real=isRealConversation(conversation),group=conversation?.conversationKind==='group';
 const day=messageDate(message.createdAt),divider=!previous||messageDate(previous.createdAt)!==day?html`<span class="day-divider">${escape(day)}</span>`:'';
 const outgoing=['human','agent'].includes(message.kind),author=message.kind==='agent'?t('Agente')+' · '+(message.authorName||state.tenant?.agents?.find(agent=>agent.id===message.agentId)?.name||t('Equipe')):message.kind==='human'?(message.authorName||t('Equipe')):group?(message.senderName||t('Participante')):message.kind==='customer'?t('Cliente'):'';
 const meta=time(message.createdAt)+(message.kind==='human'?(real?' · '+({pending:t('Enviando'),sent:t('Enviado'),delivered:t('Entregue'),read:t('Lido'),failed:t('Falhou'),unconfirmed:t('Não confirmado')}[message.delivery]||message.delivery||t('Enviado')):t(' · salvo no sandbox')):'');
 let body;
 if(message.kind==='internal') body=html`<div class="message internal-note"><strong class="message-author">${icon('shield')}Nota interna · ${escape(message.authorName||t('Equipe'))}</strong><span class="message-text">${escape(message.text).replace(/\n/g,markup('<br>'))}</span><small class="message-meta">${escape(time(message.createdAt))} · só equipe</small></div>`;
 else if(message.kind==='system') body=html`<div class="system-message">${icon('refresh')}${escape(message.text)}</div>`;
 else body=html`<div class="message ${outgoing?'outgoing':'incoming'}${message.kind==='agent'?' agent-message':''}">${author?html`<strong class="message-author">${escape(author)}</strong>`:''}${repliesUI.messageQuote(message)}${mediaUI.messageAttachments(message)}${message.text?html`<div class="message-text">${messageTextMarkup(message.text)}</div>`:''}<small class="message-meta">${escape(meta)}</small>${repliesUI.messageReplyButton(message,!canReplyTo(conversation)||!supportsQuote(conversation))}${['customer','human'].includes(message.kind)&&canCoordinate(conversation)&&capabilitiesFor(conversation).forward?html`<button type="button" class="message-forward-button icon-button" data-action="forward-message" data-id="${escape(message.id)}" aria-label="Encaminhar mensagem" title="Encaminhar">${icon('arrow')}</button>`:''}</div>`;
 return html`<div class="message-entry" data-message-id="${escape(message.id||('position-'+index))}">${divider}${body}</div>`;
}
/*@end:message-date*/
// Window of 60 messages (inbox-live.js): the first paint and every later update share the same slice.
function conversationMessages(conversation){const markup=inboxTimeline.markup(conversation.messages,`${state.tenant?.id}:${conversation.id}`);return remoteInboxEarlierMarkup(conversation)+markup;}
function refreshMessageAttachments(){
 const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation),container=$('#messages');
 if(!conversation||!container)return;
 inboxTimeline.update(container,conversation.messages);mediaUI.bindPlayers();
}
/*@anchor:scoped-runs-context*/
/*@anchor:scoped-runs*/
// Scoped runtime DTOs are requested afresh; private memory metadata never comes from the tenant DTO.
let scopedRunsController = null;
function scopedRunsKey() {
  const c = currentConversation();
  return JSON.stringify([inboxContactAuthority(), state.view, state.tenant?.id, state.conversation,
    c?.channelId, c?.departmentId, c?.contactId, c?.version, c?.status, c?.owner, c?.assignedUserId, c?.agentId,
    state.refreshSequence || 0, state.inboxSelectionSequence || 0]);
}
function captureScopedRuns() {
  if (state.view !== 'inbox' || state.inboxSelecting || !state.boot?.session || !currentConversation()) return null;
  scopedRunsController?.abort();
  const controller = scopedRunsController = new AbortController();
  return { epoch: state.scopedRunsEpoch || 0, ticket: state.scopedRunsTicket = (state.scopedRunsTicket || 0) + 1,
    key: scopedRunsKey(), workspaceId: state.workspaceId, tenantId: state.tenant.id, conversationId: state.conversation, conversationVersion: currentConversation().version, controller };
}
function currentScopedRuns(context) {
  return Boolean(context && !context.controller.signal.aborted && context.epoch === (state.scopedRunsEpoch || 0)
    && context.ticket === state.scopedRunsTicket && context.key === scopedRunsKey());
}
async function readScopedRuns(context) {
  if (!currentScopedRuns(context)) return null;
  const result = await dataSource.conversation(context.tenantId, context.conversationId, { workspaceId: context.workspaceId, signal: context.controller.signal });
  if (!currentScopedRuns(context)) return null;
  const fail = () => { throw Object.assign(new Error(t('O servidor não confirmou as execuções deste atendimento. Atualize a consulta.')),{code:'SCOPED_RUN_DTO'}); };
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.runs)) fail();
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
  const ids = new Set();
  return result.runs.map(run => {
    if (!run || typeof run !== 'object' || Array.isArray(run) || !identity(run.id)
      || run.conversationId !== context.conversationId || ids.has(run.id) || Object.hasOwn(run, 'memorySnapshot')) fail();
    ids.add(run.id);
    if (run.memoryReferences !== undefined && (!Array.isArray(run.memoryReferences) || run.memoryReferences.length > 12)) fail();
    const referenceIds = new Set();
    const references = run.memoryReferences?.map(ref => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(k => !['id', 'scope', 'version'].includes(k))
        || !identity(ref.id) || referenceIds.has(ref.id) || !['contact', 'operation'].includes(ref.scope)
        || !Number.isSafeInteger(ref.version) || ref.version < 1) fail();
      referenceIds.add(ref.id);return { id: ref.id, scope: ref.scope, version: ref.version };
    });
    return { ...run, ...(references ? { memoryReferences: references } : {}) };
  });
}
function replaceScopedRuns(context, runs) {
  if (!currentScopedRuns(context) || !Array.isArray(runs)) return false;
  state.tenant.runs = [...(state.tenant.runs || []).filter(run => run.conversationId !== context.conversationId), ...runs];
  renderConversationRuns(); return true;
}
function scopedRunsAligned(tenant, context, runs) {
  if(tenant.conversations.find(c=>c.id===context.conversationId)?.version!==context.conversationVersion)return false;
  return runs.every(run=>{const general=(tenant.runs||[]).find(item=>item.id===run.id);return !general||
    !((general.version||0)>(run.version||0)||general.memoryUnavailable&&!run.memoryUnavailable||general.knowledgeUnavailable&&!run.knowledgeUnavailable);});
}
async function refreshScopedConversationRuns(conversationId = state.conversation, expectedScope = `${state.workspaceId}:${state.tenant?.id}`, origin = null) {
  if (conversationId !== state.conversation || expectedScope !== `${state.workspaceId}:${state.tenant?.id}`) return false;
  if (origin && !currentScopedRuns(origin)) return false;
  const context = captureScopedRuns(); if (!context) return false;
  try { return replaceScopedRuns(context, await readScopedRuns(context)); }
  catch (error) {
    if (!currentScopedRuns(context)) return false;
    // A current failure must remove stale metadata/drafts from this panel and remain visible to the person.
    replaceScopedRuns(context, []); toast(error.message, true); return false;
  }
}

/*@end:scoped-runs*/
// The run cards belong to the agent rail (agent-rail-ui.js, P4); app.js keeps the #copilot-runs host.
function conversationRuns(conversation) {
  return html`<div id="copilot-runs" aria-live="polite">${agentRail.render(conversation)}</div>`;
}
function renderConversationRuns() {
  const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation),panel=$('#copilot-runs');
  if(state.view==='inbox'&&conversation&&panel)panel.outerHTML=conversationRuns(conversation);
  if(state.view==='inbox'&&conversation)openForApproval(conversation);
}
// §5.2.1: from 900 to 1279 px the context opens by itself on the Agente tab when an approval waits
// (once per pending approval, never taking the focus from what the person is typing).
function openForApproval(conversation){
  const waiting=(state.tenant?.runs||[]).filter(run=>run.conversationId===conversation.id&&run.state==='waiting_approval').map(run=>run.id).join(',');
  if(!waiting||!agentRail.status?.(conversation)?.approval||state.approvalOpened===`${conversation.id}:${waiting}`)return;
  state.approvalOpened=`${conversation.id}:${waiting}`;
  const panel=$('#conversation-context');
  // The tab changes only when the focus is not inside the panel: hiding the tab the person is working
  // in (Etiquetas, the client record) would drop the focus; the • of the Agente tab still tells.
  if(panel&&state.contextTabChoice?.conversationId!==conversation.id&&panel.querySelector('#context-tabs-panel-agent')&&!panel.contains(document.activeElement)){
    panel.dataset.tab='agent';
    for(const button of panel.querySelectorAll('[role="tab"]')){const on=button.dataset.tab==='agent';button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;}
    for(const section of panel.querySelectorAll('[role="tabpanel"]'))section.hidden=section.id!=='context-tabs-panel-agent';
  }
  const workspace=$('.pg-inbox'),drawer=globalThis.matchMedia?.('(min-width: 900px)').matches&&!globalThis.matchMedia?.('(min-width: 1280px)').matches;
  // Same opening as ⓘ (expanded state, label and title of the toggle), without taking the focus.
  if(workspace&&panel&&drawer&&state.contextCollapsed)setContextOpen(true,{focus:false});
}
/*@end:scoped-runs-context*/
function conversationContext(conversation) {
  // Context panel v2 (§5.2.3): tabs Cliente | Atendimento | Agente (+ Grupo). It opens on Agente when a
  // run is active or waits for a decision; the Agente tab hosts agentRail.contextTab (P4).
  const agent = state.tenant.agents.find(item => item.id === conversation.agentId), group=conversation.conversationKind==='group';
  const runs=(state.tenant.runs||[]).filter(run=>run.conversationId===conversation.id),railStatus=agentRail.status?.(conversation),busy=railStatus?Boolean(railStatus.approval||railStatus.active):runs.some(run=>activeRunStates.has(run.state||run.status));
  const tab=contextTabFor(conversation,busy),railTab=String(agentRail.contextTab(conversation)||''),manage=canManageAttendance(conversation);
  const items=[{id:'client',label:t('Cliente')},{id:'attendance',label:t('Atendimento')},{id:'agent',label:t('Agente'),count:busy?'•':null},...(group?[{id:'group',label:t('Grupo')}]:[])].map(item=>({...item,action:'inbox:context-tab'}));
  const client=html`<div class="pg-inbox__person">${conversationAvatar(conversation, 'extra-large mint')}<h3 data-pii>${escape(conversation.contact)}</h3><p>${isRealConversation(conversation) ? t('Contato do ') + transportName(conversation) + t(' conectado') : t('Contato fictício da prévia')}</p></div>${customerContextUI.markup()}${clientRecordMarkup(conversation,{contacts:state.contacts,canRead:hasPermission('contacts.read'),canWrite:hasPermission('contacts.write'),canTransfer:hasPermission('inbox.transfer'),escape,icon})}${attendanceHistory(conversation,{escape,icon})}`;
  const attendance=html`<div class="pg-inbox__section"><h3 class="pg-inbox__section-title">${icon('users')}<span>Responsável</span></h3><p class="attendant-name">${escape(ownerLabel(conversation))}</p>${manage && conversation.status !== 'closed' ? html`<button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="transfer-conversation">${icon('arrow')}<span class="ui-btn__label">Transferir atendimento</span></button>` : ''}</div><div class="pg-inbox__section"><h3 class="pg-inbox__section-title">${icon('building')}<span>Organização</span></h3><form id="conversation-details-form" class="pg-inbox__details"><fieldset ${!manage?'disabled':''}><label>Status<select name="status">${Object.entries(statusNames).map(([key, name]) => html`<option value="${key}" ${conversation.status === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label>Departamento<input value="${escape(conversation.department || t('Sem departamento'))}" readonly/></label><label>Etiquetas<input name="tags" maxlength="500" value="${escape(conversation.tags.join(', '))}" placeholder="Cliente, Suporte"/><small>Separe por vírgulas.</small></label><div class="form-error" role="alert"></div><button class="ui-btn ui-btn--secondary ui-btn--sm" type="submit"><span class="ui-btn__label">Salvar contexto</span></button></fieldset></form></div>${serviceHandoffsUI.markup()}<div class="pg-inbox__section"><h3 class="pg-inbox__section-title">${icon('activity')}<span>Fluxo da conversa</span></h3><p>Aplicar uma rota publicada atualiza etiquetas, departamento e responsável.</p><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="conversation-flow" ${!manage||!state.flows.some(flow => flow.publishedVersion) ? 'disabled' : ''}><span class="ui-btn__label">Escolher fluxo</span></button></div><div class="pg-inbox__version">${icon('shield')}<strong>${escape(t('Versão {version}',{version:conversation.version}))}</strong><p>Alterações da conversa invalidam respostas preparadas no contexto anterior.</p></div>`;
  const memory=hasPermission('contacts.read')&&state.tenant.agents.some(a=>a.provider==='hermes'&&a.mode==='copilot'&&a.configured)?html`<div class="pg-inbox__section"><h3 class="pg-inbox__section-title">${icon('document')}<span>Memória do agente</span></h3><p>Fatos revisados por cliente e operação.</p><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="memory-open"><span class="ui-btn__label">Abrir memória</span></button></div>`:'';
  const agentTab=html`${railTab}<div class="pg-inbox__section"><h3 class="pg-inbox__section-title">${icon('agent')}<span>Agente do atendimento</span></h3><p>${agent ? escape(agent.name) : t('Escolha quem prepara a resposta')}</p><label class="sr-only" for="assigned-agent">Escolher agente</label><select id="assigned-agent" ${!canCoordinate(conversation)?'disabled':''}>${state.tenant.agents.map(item => html`<option value="${item.id}" ${agent?.id === item.id ? 'selected' : ''}>${escape(item.name)}${item.configured ? '' : t(' · configurar')}</option>`).join('')}</select>${railTab?'':html`<button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="run-agent" ${!canCoordinate(conversation)||!state.tenant.agents.some(item => item.configured) ? 'disabled' : ''}><span aria-hidden="true">✦</span><span class="ui-btn__label">Gerar rascunho</span></button>`}<small class="group-help">${canCoordinate(conversation)?t('O copiloto prepara. Você revisa e envia.'):t('O responsável coordena o copiloto, os agendamentos e os encaminhamentos.')}</small></div>${memory}`;
  const panels={client,attendance:attendance+'<section id="conversation-follow-ups" class="pg-inbox__section" aria-live="polite"></section>',agent:agentTab,...(group?{group:groupContextMarkup(conversation)}:{})};
  return String(h`<aside class="pg-inbox__context" id="conversation-context" aria-label="Contexto do atendimento" data-tab="${tab}"><header class="pg-inbox__context-head">${uiTabs({id:'context-tabs',items,active:tab,label:t('Contexto do atendimento')})}<button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__context-close" data-action="toggle-context" aria-label="Recolher contexto do atendimento" title="Recolher contexto do atendimento">${raw(icon('close'))}</button></header><div class="pg-inbox__context-body">${Object.entries(panels).map(([id,content])=>tabPanel({tabsId:'context-tabs',id,active:id===tab,content:raw(content),focusable:false}))}</div></aside>`);
}
// Tab of the context panel: the person's choice for this conversation, else Agente while a run is
// active (§5.2.3 "abre na aba Agente quando há execução ativa ou decisão pendente"), else Cliente.
function contextTabFor(conversation,busy){
  const chosen=state.contextTabChoice?.conversationId===conversation.id?state.contextTabChoice.tab:null;
  const valid=['client','attendance','agent',...(conversation.conversationKind==='group'?['group']:[])];
  return valid.includes(chosen)?chosen:busy?'agent':'client';
}
// Grupo tab (§2.2): what the conversation says about its group; the summary and the history import of
// the old Grupos screen are opened from here (groups-workspace-ui, P3) and the group selection lives in
// Canais › canal › Grupos (P7).
function groupContextMarkup(conversation){
  const availability=conversation.channelAvailability?.group||{},channel=channelFor(conversation);
  const sending=availability.canSend===false?t('Respostas bloqueadas neste grupo'):t('Respostas permitidas');
  return html`<div class="pg-inbox__section" data-group-context><h3 class="pg-inbox__section-title">${icon('users')}<span>Grupo</span></h3><p><strong>${escape(conversation.contact)}</strong></p><dl class="pg-inbox__facts"><dt>Canal</dt><dd>${escape(channel?.name||transportName(conversation))}</dd><dt>Envio</dt><dd>${escape(sending)}</dd>${conversation.threadId?html`<dt>Tópico</dt><dd>${escape(conversation.threadId)}</dd>`:''}</dl></div>${groupsWorkspaceUI.render({panelFor:conversation.id})}`;
}

/*@anchor:open-modal*/
function openModal(title, description, content) {
  const modal = $('#modal');
  modal.innerHTML = html`<div class="modal-heading"><div><h2 id="modal-title">${escape(title)}</h2><p id="modal-description">${escape(description)}</p></div><button class="icon-button" data-close-modal aria-label="Fechar janela">${icon('close')}</button></div>${content}`;
  modal.showModal();
  modalRouteLifecycle.opened();
}
/*@end:open-modal*/
function captureAttendance(){const c=currentConversation();if(!c)throw Error(t('Escolha um atendimento.'));return {...attendanceContext(),key:JSON.stringify([state.boot.session.userId,state.workspaceId,state.supportGrantId||null,state.tenant.id,c.id,c.channelId]),base:tenantApi(`conversations/${encodeURIComponent(c.id)}`),version:c.version,channelId:c.channelId};}
function readDeviceContext(){return {userId:state.boot.session.userId,role:state.boot.session.role,supportGrantId:state.supportGrantId,channels:state.tenant?.channels||[]};}
function checkAttendance(context){const c=currentConversation();if(state.view!=='inbox'||!context||!c||context.key!==JSON.stringify([state.boot.session.userId,state.workspaceId,state.supportGrantId||null,state.tenant?.id,c.id,c.channelId]))throw Error(t('O atendimento mudou. Abra esta ação novamente.'));return c;}
async function attendanceRequest(context,tail,options={}){checkAttendance(context);const result=await api(context.base+'/'+tail,{...options,headers:{...options.headers,'X-Elozi-Workspace':context.workspaceId}});checkAttendance(context);return result;}
function applyAttendance(c){queueMicrotask(()=>refreshInboxList({offset:consolidatedInbox.data.offset}).catch(error=>toast(error.message,true)));const index=state.tenant.conversations.findIndex(item=>item.id===c.id);if(index<0||c.id!==state.conversation||c.channelId!==currentConversation()?.channelId)throw Error(t('O atendimento mudou. Atualize a tela.'));if(!attendanceResponseIsCurrent(c,state.tenant.conversations[index]))return false;state.tenant.conversations[index]=c;repliesUI.syncContext({workspaceId:state.workspaceId,tenantId:state.tenant.id,conversationId:c.id,messages:c.messages,active:true});syncAttendanceTools();updateInboxList();updateAttendanceSummary(c);updateAttendanceAccess(c);updateClientRecord();inboxTimeline.update($('#messages'),c.messages);mediaUI.bindPlayers();if(conversationTools.opened)updateConversationTools(true);renderConversationRuns();return true;}
function attendanceModal(title,content,submitLabel){state.attendanceModal=captureAttendance();openModal(title,currentConversation().contact,html`<form data-attendance-form="status">${content}<div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-close-modal>Cancelar</button><button type="submit" class="button primary">${escape(submitLabel)}</button></div></form>`);}
async function showSchedules(){const context=captureAttendance(),result=await attendanceRequest(context,'scheduled');state.attendanceModal=context;state.schedules=result.schedules||[];const c=currentConversation(),caps=capabilitiesFor(c),window=c.channelAvailability?.replyWindow,allowed=canSendTo(c),expires=window?.expiresAt?Date.parse(window.expiresAt):null,defaults=new Date(Math.min(Date.now()+3600000,expires?expires-60000:Infinity)),toLocal=date=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16),local=toLocal(defaults),maximum=expires?toLocal(new Date(expires-60000)):'';openModal(t('Mensagens agendadas'),currentConversation().contact,html`<form data-attendance-form="schedule"><label>Mensagem de texto<textarea name="text" maxlength="${caps.maxTextLength*(caps.unicodeLength?2:1)}" rows="3" required>${escape($('#message-text')?.value||'')}</textarea></label><label>Data e hora (seu fuso local)<input name="dueAt" type="datetime-local" value="${local}" ${maximum?`max="${maximum}"`:""} required/></label><small>O envio depende do canal conectado, do seu acesso e de você continuar responsável por este atendimento. Seu rascunho fica preservado.${window?.expiresAt?txt` A resposta deve ocorrer antes de ${escape(new Date(window.expiresAt).toLocaleString(getLocale()))}, dentro da janela Meta.`:""}${!allowed?t(" Novos agendamentos estão bloqueados até esta conexão permitir responder."):""}</small><div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-close-modal>Fechar</button><button type="submit" class="button primary" ${!allowed?"disabled":""}>Agendar texto ${icon('clock')}</button></div></form><section class="schedule-list" aria-label="Histórico de agendamentos"><h3>Agendamentos deste atendimento</h3>${state.schedules.map(r=>html`<article><div><strong>${escape({pending:t('Agendada'),sending:t('Enviando'),sent:t('Enviada'),cancelled:t('Cancelada'),blocked:t('Envio bloqueado'),failed:t('Falha no envio'),unknown:t('Envio sem confirmação')}[r.state]||r.state)}</strong><small>${escape(new Date(r.dueAt).toLocaleString(getLocale()))} · ${escape(r.authorName)}</small></div><p>${escape(r.text)}</p>${r.reasonCode?markup('<small>Confira o responsável, o canal e as permissões antes de criar um novo agendamento.</small>'):''}${['pending','blocked','failed'].includes(r.state)?html`<button type="button" class="text-button" data-action="cancel-schedule" data-id="${escape(r.id)}">Cancelar agendamento</button>`:''}</article>`).join('')||markup('<p>Nenhuma mensagem agendada.</p>')}</section>`);}
/*@anchor:attendance-action*/
async function attendanceAction(action,id){const c=currentConversation();
  if(action==='conversation-participants'){await participantsUI.open();return true;}
  if(['schedule-message','cancel-schedule','forward-message'].includes(action)&&!canCoordinate(c))throw Error(t('O responsável coordena agendamentos e encaminhamentos.'));
  if(['conversation-close','conversation-pending','conversation-reopen','attendance-queue'].includes(action)&&!canManageAttendance(c))throw Error(t('Somente o responsável ou a gestão pode organizar este atendimento.'));
  if(action==='conversation-search'){conversationTools.open('search');return true;}
  if(action==='conversation-gallery'){conversationTools.open('gallery');return true;}
  if(action==='conversation-follow-ups'){selectContextTab('attendance',{chosen:true});setContextOpen(true,{focus:false});await followUpsUI.open();return true;}
  if(action==='refresh-attendance'){await pollInbox();toast(t('Atendimentos atualizados.'));return true;}
  if(action==='attendance-contacts'){navigate('contacts');return true;}
  if(action==='show-closed'){state.lensWorkspace=state.workspaceId;Object.assign(state,{status:'closed',filter:'all',unread:false,search:''});syncInboxFilterHash();await refreshInboxList();return true;}
  if(action==='conversation-refresh-device-reads'){
    if(!canRefreshDeviceReads(c,readDeviceContext()))throw Error(t('Somente a administração da empresa pode atualizar as leituras deste WhatsApp.'));
    const context=captureAttendance(),result=await api(tenantApi(`channels/${encodeURIComponent(context.channelId)}/read-state-sync`),{method:'POST',body:'{}',headers:{'X-Elozi-Workspace':context.workspaceId}});
    checkAttendance(context);await pollInbox();live?.kick('attention');toast(deviceReadStateNotice(result),result.state!=='synced');return true;
  }
  if(action==='conversation-read'||action==='conversation-sync-read'){
    const context=captureAttendance(),unread=action==='conversation-read'?!c.unread:false;
    if(action==='conversation-sync-read'&&!canSyncDeviceRead(c,readDeviceContext()))throw Error(t('Somente o responsável pode sincronizar a leitura deste WhatsApp.'));
    const result=await attendanceRequest(context,'read-state',{method:'POST',body:JSON.stringify(readStateCommand(c,context.version,unread,readDeviceContext()))});
    applyAttendance(result);
    if(unread)preserveInboxUnread(result);
    live?.kick('attention');
    const read=$('[data-action="conversation-read"]');if(read){read.setAttribute('aria-label',readActionLabel(currentConversation(),readDeviceContext()));read.title=read.getAttribute('aria-label');}
    toast(readSyncNotice(result),result.readSync?.state==='pending');return true;
  }
  // §5.2.3: Encerrar acts at once and offers Reabrir in the toast (the reopening is the normal reopen event).
  if(action==='conversation-close'&&c?.status!=='closed'){const context=captureAttendance(),closed=await attendanceRequest(context,'details',{method:'POST',body:JSON.stringify({status:'closed',version:context.version})});applyAttendance(closed);render();toasts.show({message:t('Atendimento encerrado.'),tone:'success',action:{label:t('Reabrir'),onSelect:()=>{void reopenClosed(context,closed).catch(error=>toast(error.message,true));}}});return true;}
  if(['conversation-close','conversation-pending','conversation-reopen','attendance-queue'].includes(action)){const status=action==='conversation-close'?'closed':action==='conversation-pending'&&c.status!=='pending'?'pending':'open';attendanceModal(action==='attendance-queue'?t('Devolver atendimento à fila'):{closed:t('Encerrar atendimento'),pending:t('Marcar atendimento como pendente'),open:c.status==='closed'?t('Reabrir atendimento'):t('Retomar atendimento')}[status],html`<input type="hidden" name="operation" value="${action==='attendance-queue'?'queue':'status'}"/><input type="hidden" name="status" value="${status}"/><p>${action==='attendance-queue'?t('O atendimento ficará disponível para outro atendente assumir.'):status==='closed'?t('Você poderá reabrir este atendimento quando precisar.'):c.status==='closed'?t('Ao reabrir, o atendimento volta à fila. Assuma para responder.'):t('Atualiza o status sem enviar uma mensagem ao cliente.')}</p><label>Motivo (opcional)<textarea name="reason" maxlength="240" rows="2" placeholder="Contexto para sua equipe"></textarea></label>`,t('Confirmar'));return true;}
  if(action==='schedule-message'){await showSchedules();return true;}
  if(action==='cancel-schedule'){const context=state.attendanceModal;checkAttendance(context);const r=state.schedules.find(item=>item.id===id);if(!r)throw Error(t('Agendamento indisponível.'));await attendanceRequest(context,'scheduled/cancel',{method:'POST',body:JSON.stringify({id,version:r.version})});await refresh(context.tenantId);checkAttendance(context);render();await showSchedules();toast(t('Agendamento cancelado.'));return true;}
  if(action==='forward-message'){forwarding.prepare(id);const p=forwarding.preview(),targets=forwarding.targets();if(!targets.length)throw Error(t('Assuma outro atendimento conectado nesta empresa para encaminhar.'));state.attendanceModal=captureAttendance();openModal(t('Encaminhar mensagem'),c.contact,html`<form data-attendance-form="forward"><div class="notice subtle">${icon('arrow')}<span>O conteúdo será enviado ao destino escolhido pelo número ou bot desse atendimento.</span></div><blockquote>${escape(p.source?.text||p.source?.attachment?.name||t('Arquivo'))}</blockquote><label>Atendimento de destino<select name="destination" required><option value="">Selecione um atendimento com você</option>${targets.map(t=>html`<option value="${escape(t.id)}">${escape(t.contact)} · ${escape(channels().find(ch=>ch.id===t.channelId)?.name)}</option>`).join('')}</select></label><div data-forward-status class="form-error" role="status"></div><div class="modal-actions"><button type="button" class="button" data-close-modal>Cancelar</button><button type="submit" class="button primary" disabled>Encaminhar ${icon('arrow')}</button></div></form>`);return true;}
  if(action==='composer-emoji'){state.attendanceModal=captureAttendance();state.emojiCursor={start:$('#message-text').selectionStart,end:$('#message-text').selectionEnd};openModal(t('Inserir emoji'),t('Escolha um emoji para sua resposta.'),html`<div class="emoji-picker" role="group" aria-label="Emojis">${['😊','👍','✅','🙏','👋','🎉','💚','✨','📌','📞','💬','🤝','🙂','🚀','❤️','😁'].map(e=>html`<button type="button" class="button" data-action="insert-emoji" data-id="${e}" aria-label="${e}">${e}</button>`).join('')}</div>`);return true;}
  if(action==='insert-emoji'){checkAttendance(state.attendanceModal);if(!canReplyTo(c))throw Error(t('Assuma antes de responder.'));const field=$('#message-text'),cursor=state.emojiCursor;if(field.value.length-(cursor.end-cursor.start)+id.length>field.maxLength)throw Error(t('A mensagem atingiu o limite.'));field.setRangeText(id,cursor.start,cursor.end,'end');field.dispatchEvent(new Event('input',{bubbles:true}));$('#modal').close();field.focus();return true;}
  return false;
}
/*@end:attendance-action*/
// "Reabrir" of the Encerrar toast reopens the conversation that was closed (the normal reopen event of
// /details), even when another conversation is open by then. Another person, workspace or support
// grant refuses it; the server decides access and the version (the latest one this tab has seen).
let reopening=false;
async function reopenClosed(context,closed){
  const [userId,workspaceId,grant]=JSON.parse(context.key);
  if(userId!==state.boot?.session.userId||workspaceId!==state.workspaceId||grant!==(state.supportGrantId||null))throw Error(t('O atendimento mudou. Abra esta ação novamente.'));
  if(reopening)return;
  const known=state.tenant?.id===context.tenantId?state.tenant.conversations.find(item=>item.id===closed.id):null;
  reopening=true;
  try{
    const reopened=await api(context.base+'/details',{method:'POST',headers:{'X-Elozi-Workspace':context.workspaceId},body:JSON.stringify({status:'open',version:known?.version??closed.version})});
    if(state.view==='inbox'&&state.tenant?.id===context.tenantId&&state.conversation===reopened.id){applyAttendance(reopened);render();}
    else{const index=state.tenant?.id===context.tenantId?state.tenant.conversations.findIndex(item=>item.id===reopened.id):-1;if(index>=0)state.tenant.conversations[index]=reopened;if(state.view==='inbox')await refreshInboxList({offset:consolidatedInbox.data.offset});}
    toast(t('Atendimento reaberto.'));
  }finally{reopening=false;}
}
async function submitAttendanceModal(form){if(state.busy)return;state.busy=true;const submit=form.querySelector('[type="submit"]'),context=state.attendanceModal;submit.disabled=true;try{checkAttendance(context);const input=Object.fromEntries(new FormData(form));if(['forward','schedule'].includes(form.dataset.attendanceForm)&&!canCoordinate(currentConversation()))throw Error(t('O responsável coordena agendamentos e encaminhamentos.'));if(form.dataset.attendanceForm==='forward'){if(input.destination!==forwarding.preview()?.destination?.id)throw Error(t('Confira novamente o atendimento de destino.'));await forwarding.execute();checkAttendance(context);toast(t('Encaminhamento aceito pelo canal de destino.'));return;}if(form.dataset.attendanceForm==='schedule'){const current=currentConversation(),caps=capabilitiesFor(current);if(!canSendTo(current))throw Error(t('Esta conexão não permite responder agora.'));assertChannelText(input.text,caps);const dueAt=new Date(input.dueAt);if(current.channelAvailability?.replyWindow&&dueAt.getTime()>=Date.parse(current.channelAvailability.replyWindow.expiresAt))throw Error(t('Agende dentro da janela de resposta Meta exibida.'));if(!Number.isFinite(dueAt.valueOf()))throw Error(t('Informe data e hora válidas.'));if(!state.scheduleIntent||state.scheduleIntent.context!==context.key||state.scheduleIntent.text!==input.text||state.scheduleIntent.dueAt!==dueAt.toISOString())state.scheduleIntent={context:context.key,text:input.text,dueAt:dueAt.toISOString(),commandId:crypto.randomUUID(),version:context.version};await attendanceRequest(context,'scheduled',{method:'POST',body:JSON.stringify({text:input.text,dueAt:dueAt.toISOString(),version:state.scheduleIntent.version,commandId:state.scheduleIntent.commandId})});state.scheduleIntent=null;await refresh(context.tenantId);checkAttendance(context);render();await showSchedules();toast(t('Mensagem de texto agendada.'));return;}const result=await attendanceRequest(context,input.operation==='queue'?'owner':'details',{method:'POST',body:JSON.stringify(input.operation==='queue'?{owner:'queue',version:context.version,reason:input.reason}:{status:input.status,version:context.version,reason:input.reason})});applyAttendance(result);$('#modal').close();render();toast(input.operation==='queue'?t('Atendimento devolvido à fila.'):t('Status do atendimento atualizado.'));}catch(error){if(form.isConnected)form.querySelector('.form-error').textContent=error.message;else toast(error.message,true);}finally{state.busy=false;if(submit.isConnected)submit.disabled=false;updateForwardingStatus();}}
const replyContextKey=()=>JSON.stringify([state.workspaceId,state.tenant?.id,state.conversation]);
async function loadQuickReplies(){
  const context=replyContextKey(),tenantId=state.tenant?.id;
  if(!tenantId)throw Error(t('Escolha uma empresa.'));
  const result=await api(tenantApi('quick-replies'));
  if(context!==replyContextKey())throw Error(t('O atendimento mudou. Abra novamente as respostas rápidas.'));
  state.quickReplies=result.replies||[];state.repliesModalContext=context;return state.quickReplies;
}
function showQuickReplies(mode='picker'){
  if(state.repliesModalContext!==replyContextKey())throw Error(t('O contexto mudou. Abra novamente as respostas.'));
  state.repliesModalMode=mode;
  openModal(mode==='manager'?t('Gerenciar respostas rápidas'):t('Respostas rápidas'),state.tenant.name,mode==='manager'?repliesUI.manager(state.quickReplies):repliesUI.picker(state.quickReplies,{admin:state.boot.session.role==='reseller'}));
}
/*@anchor:reply-action*/
async function replyAction(target){
 const action=target.dataset.replyAction,conversation=state.tenant?.conversations.find(c=>c.id===state.conversation);
 if(state.busy||mediaUI.sending||voiceRecorder.busy)return;
 if(action!=='jump'&&blockPendingSend())return;
 if(['quote','clear','jump'].includes(action)){
   if(action==='jump'){repliesUI.jumpToMessage(target.dataset.id);return;}
   if(!canReplyTo(conversation))return;
   if(action==='clear')repliesUI.clearQuote();
   else if(!repliesUI.selectQuote(target.dataset.id)&&repliesUI.error)toast(repliesUI.error,true);
   $('#message-text')?.focus();return;
 }
 if(action==='open'){if(!canReplyTo(conversation))return;await loadQuickReplies();showQuickReplies();return;}
 if(state.repliesModalContext!==replyContextKey()){repliesUI.reset();$('#modal').close();throw Error(t('O contexto mudou. Abra novamente as respostas rápidas.'));}
 if(action==='insert'){
   if(!canReplyTo(conversation))throw Error(t('Assuma a conversa antes de usar uma resposta.'));
   const context=replyContextKey();
   const {replies}=await api(tenantApi('quick-replies'));
   if(context!==replyContextKey()||state.repliesModalContext!==context)throw Error(t('O atendimento mudou.'));
   if(!target.isConnected||!$('#modal').open)return;
   if(!canReplyTo(state.tenant?.conversations.find(c=>c.id===state.conversation)))throw Error(t('A atribuição mudou. Atualize antes de usar a resposta.'));
   const item=replies.find(r=>r.id===target.dataset.id&&r.active);
   if(!item)throw Error(t('Esta resposta foi desativada. Abra a lista novamente.'));
   const result=repliesUI.insert(item,$('#message-text'));
   if(!result.ok)throw Error(result.error);
   mediaUI.draft=$('#message-text').value;state.sendIntent=null;$('#modal').close();$('#message-text').focus();return;
 }
 if(state.boot.session.role!=='reseller')throw Error(t('Somente administradores gerenciam respostas rápidas.'));
 if(action==='manage'||action==='back'){await loadQuickReplies();if(target.isConnected&&$('#modal').open)showQuickReplies('manager');return;}
 if(action==='new'||action==='edit'){
   const item=action==='edit'?state.quickReplies.find(r=>r.id===target.dataset.id):{};
   if(!item)throw Error(t('Resposta indisponível. Reabra o catálogo.'));
   state.repliesModalMode='editor';openModal(action==='new'?t('Nova resposta rápida'):t('Editar resposta rápida'),state.tenant.name,repliesUI.editor(item));return;
 }
 if(action==='toggle'){
   const item=state.quickReplies.find(r=>r.id===target.dataset.id);if(!item)throw Error(t('Resposta indisponível.'));
   const context=replyContextKey();
   await api(tenantApi(`quick-replies/${encodeURIComponent(item.id)}`),{method:'PATCH',body:JSON.stringify({version:item.version,active:!item.active})});
   if(context!==replyContextKey()||!target.isConnected||!$('#modal').open)return;
   await loadQuickReplies();showQuickReplies('manager');toast(item.active?t('Resposta desativada.'):t('Resposta reativada.'));
 }
}
/*@end:reply-action*/
document.addEventListener('click',async event=>{
 const target=event.target.closest('[data-reply-action]');if(!target||target.disabled)return;
 target.disabled=true;
 try{await replyAction(target);}catch(error){const feedback=$('#modal [data-reply-feedback], #modal .form-error');if(feedback)feedback.textContent=error.message;else toast(error.message,true);}finally{if(target.isConnected)target.disabled=false;}
});
document.addEventListener('input',event=>{
 if(event.target.matches('[data-reply-search]')){
  const section=event.target.closest('section'),query=event.target.value;
  if(event.target.dataset.replySearch==='picker')section.querySelector('[data-reply-results]').innerHTML=repliesUI.pickerItems(state.quickReplies||[],{query});
  else{const template=document.createElement('template');template.innerHTML=repliesUI.manager(state.quickReplies||[],{query});section.querySelector('[data-reply-results]').innerHTML=template.content.querySelector('[data-reply-results]').innerHTML;}
 }
 if(event.target.closest('[data-reply-form]'))repliesUI.updatePreview(event.target.closest('form'));
});
document.addEventListener('submit',async event=>{
 const form=event.target;if(!form.matches('[data-reply-form="editor"]'))return;
 event.preventDefault();if(state.busy)return;
 const submit=form.querySelector('[type="submit"]'),context=state.repliesModalContext;
 state.busy=true;submit.disabled=true;
 try{
  if(context!==replyContextKey()||state.boot.session.role!=='reseller')throw Error(t('O acesso ou a empresa mudou. Abra o catálogo novamente.'));
  const {id,version,...input}=repliesUI.readEditor(form);
  await api(tenantApi(id?`quick-replies/${encodeURIComponent(id)}`:'quick-replies'),{method:id?'PATCH':'POST',body:JSON.stringify({...input,...(id?{version}: {})})});
  if(context!==replyContextKey())throw Error(t('Salvo na empresa de origem. Reabra o catálogo atual.'));
  if(!form.isConnected||!$('#modal').open)return;
  await loadQuickReplies();showQuickReplies('manager');toast(t('Resposta rápida salva.'));
 }catch(error){if(form.isConnected)form.querySelector('.form-error').textContent=error.message;else toast(error.message,true);}
 finally{state.busy=false;if(submit.isConnected)submit.disabled=false;}
});
function formModal(title, description, type, fields, submitLabel = t('Salvar cadastro')) {
  openModal(title, description, html`<form data-dialog-form="${type}">${fields}<div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-close-modal>Cancelar</button><button type="submit" class="button primary">${icon('check')} ${escape(submitLabel)}</button></div></form>`);
}
/*@anchor:field-helpers*/
const field = (label, name, maxlength = 48, extra = '') => html`<label>${label}<input name="${name}" maxlength="${maxlength}" required ${extra}/></label>`;
const selectField = (label, name, options) => html`<label>${label}<select name="${name}">${Object.entries(options).map(([key, title]) => html`<option value="${key}">${title}</option>`).join('')}</select></label>`;

/*@end:field-helpers*/
/*@anchor:shell-actions*/
// Shell actions (shell-ui.js data-action="shell:*"). Workspace and company go through changeWorkspace
// and changeTenant with their guards; Pendências and Equipe open their screens until P2 turns them into
// drawers through the action registry; the scope chip opens the drawer on mobile.
const closeShellDrawer=()=>{shellUI.close();state.menuOpen=setShellDrawer(document,false,{mobile:matchMedia(SHELL_MOBILE_QUERY).matches});};
async function shellAction(action,id,element){
  if(action==='shell:workspace'){if(!id)return;closeShellDrawer();await changeWorkspace(id,element?.dataset.grant||null);return;}
  if(action==='shell:tenant'){if(!id)return;closeShellDrawer();await changeTenant(id);return;}
  if(action==='shell:team'){navigate('team-chat');return;}
  if(action==='shell:pending'){
    // Until the Pendências drawer (P2), the bell opens Visão geral on its priority list.
    navigate('overview');const queue=$('#overview-queue-title');
    if(queue&&state.view==='overview'){queue.tabIndex=-1;queue.focus({preventScroll:true});queue.scrollIntoView({block:'start'});}
    return;
  }
  if(action==='shell:shortcuts'){shellUI.close();openModal(t('Atalhos do teclado'),t('Atalhos disponíveis nesta versão.'),String(shortcutsMarkup()));return;}
  if(action==='shell:scope'){const mobile=matchMedia(SHELL_MOBILE_QUERY).matches;if(mobile&&!state.menuOpen)state.menuOpen=setShellDrawer(document,true,{mobile});shellUI.open('scope');}
}
// Account menu of the shell: language, availability and animations, with the guards of the old selects.
async function shellChange(event){
  const name=event.target?.name;
  if(name==='shell-locale'){
    const next=event.target.value,previous=getLocale(),refuse=message=>{setShellChoice(document,'shell-locale',previous);toast(message,true);};
    if(next===previous)return true;
    if($('#modal').open){refuse(t('Finalize ou feche o formulário aberto antes de trocar o idioma.'));return true;}
    if([...$('#app').querySelectorAll('input[type="password"]')].some(input=>input.value)){refuse(t('Salve ou limpe os campos privados antes de trocar o idioma.'));return true;}
    if(state.busy||voiceRecorder.busy||mediaUI.sending||state.avatarLoading||state.localeSaving){refuse(t('Finalize a gravação ou o envio antes de trocar o idioma.'));return true;}
    state.localeSaving=true;
    try{
      const result=await api('/api/auth/me',{method:'PATCH',body:JSON.stringify({locale:next})});
      state.account.user=result.user;state.boot.session.locale=result.user.locale;
      const root=$('#app'),values=captureLocaleFormState(root),scroll=$('#main-content')?.scrollTop||0,messagesScroll=$('#messages')?.scrollTop;
      setLocale(result.user.locale,{notify:false});
      render();restoreLocaleFormState($('#app'),values);
      shellUI.open('account',{focus:'input[name="shell-locale"]:checked'});
      if($('#main-content'))$('#main-content').scrollTop=scroll;
      if($('#messages')&&typeof messagesScroll==='number')$('#messages').scrollTop=messagesScroll;
      toast(t('Idioma salvo.'));
    }catch{setShellChoice(document,'shell-locale',previous);toast(t('Não foi possível salvar o idioma. Sua preferência anterior foi mantida.'),true);}
    finally{state.localeSaving=false;}
    return true;
  }
  if(name==='shell-presence'){
    const previous=state.boot.session.presence||'available';
    if(state.presenceSaving){setShellChoice(document,'shell-presence',previous);return true;}
    state.presenceSaving=true;
    try{const result=await api('/api/auth/presence',{method:'PATCH',body:JSON.stringify({presence:event.target.value})});state.boot.session.presence=result.user.presence;state.account.user=result.user;setShellPresence(document,result.user.presence,state.boot.session.name);toast(t('Disponibilidade atualizada.'));}
    catch(error){setShellPresence(document,previous,state.boot.session.name);toast(error.message,true);}
    finally{state.presenceSaving=false;}
    return true;
  }
  if(name==='shell-motion'){updateThemePrefs(document.documentElement,state.boot.session.userId,{motion:event.target.value});return true;}
  return false;
}
function syncShellLayout(){if(state.boot)applyShellLayout(document,shellLayout({wide:matchMedia(SHELL_WIDE_QUERY).matches,xwide:matchMedia(SHELL_XWIDE_QUERY).matches,view:state.view,collapsed:chatLayout.collapsed}));}
/*@end:shell-actions*/
// The shell:* actions are P1 defaults in the registry (actions.js): the owner package re-registers a
// name to replace it (P2: the Pendências and Equipe drawers). act() asks the registry first.
for(const name of ['shell:workspace','shell:tenant','shell:team','shell:pending','shell:shortcuts','shell:scope'])registerAction(name,({id,element})=>shellAction(name,id,element));
/*@anchor:act*/
async function act(action, id, element) {
  // Conectar produto (product-connect-ui.js): every step action of the wizard on Plataforma › Produtos conectados.
  if(typeof action==='string'&&action.startsWith('product-connect-')&&await connectedProductsUI.action(action,element))return;
  if(action==='startup:retry'){await start();return;}
  if(action==='route-workspace-switch'){await switchRouteWorkspace();return;}
  if(action==='verify-send'){if(state.sendIntent&&!state.busy&&!mediaUI.sending)$('#message-form')?.requestSubmit();return;}
  if(action==='discard-send'){
   if(!state.sendIntent||state.busy||mediaUI.sending)return;
   const intent=state.sendIntent;openModal(t('Descartar rascunho'),t('O envio anterior pode ter chegado ao destino.'),html`<p>Confira a entrega no destino antes de enviar outra mensagem. Descartar remove apenas o rascunho desta tela; o registro do envio fica preservado.</p><div class="modal-actions"><button type="button" class="button" data-close-modal>Voltar</button><button type="button" class="button" id="confirm-discard-send">Descartar sem reenviar</button></div>`);
   $('#confirm-discard-send').addEventListener('click',()=>{if(state.sendIntent!==intent||state.busy||mediaUI.sending)return;state.sendIntent=null;mediaUI.clearSent();repliesUI.clearSent();consolidatedInbox.clearDraft(selectedInboxRef());if($('#message-text'))$('#message-text').value='';$('#modal').close();render();toast(t('Rascunho descartado. Nenhuma mensagem reenviada.'));},{once:true});return;
  }
  if(['composer-emoji','insert-emoji'].includes(action)&&blockPendingSend())return;
  if(await accountSecurityUI.action(action,id))return;
  if(state.inboxSelecting&&!['menu','close-menu','logout'].includes(action))return;
  // Namespaced actions (actions.js registry: shell:* defaults and the screens of wave 1); legacy names never reach it.
  if(action.includes(':')&&await dispatchAction(action,element||null,null,id??null))return;
  if(['run-agent','mcp-approve','mcp-reject','mcp-regenerate'].includes(action)&&!canCoordinate(currentConversation()))throw Error(t('O responsável coordena o copiloto deste atendimento.'));
  if(['transfer-conversation','conversation-flow','apply-conversation-flow'].includes(action)&&!canManageAttendance(currentConversation()))throw Error(t('Somente o responsável ou a gestão pode organizar este atendimento.'));
  if(await supportUI.action(action,id))return;
  if(await billingUI.action(action,id))return;
  if(await unitsUI.action(action,id))return;
  if(await attendanceAction(action,id))return;
  if(await knowledgeUI.act(action,id))return;
  if(action==='memory-open'){await memoryUI.open(currentConversation());return;}
  if(action.startsWith('memory-')&&await memoryUI.action(action,element||id))return;
  if(action.startsWith('mcp-')&&await agentRail.act(action,id,element))return;
  if(await mcpUI.act(action,id))return;
  if(await integrationsUI.act(action,id))return;
  if(await contactLinksUI.action(action,id))return;
  if(await workspaceUI.action(action,id))return;
  if(await automationUI.act(action,id))return;
  const conversation = state.tenant?.conversations.find(item => item.id === state.conversation);
  switch (action) {
    case 'skip-content': focusViewContent();break;
    case 'latest-messages': $('#messages').scrollTop=$('#messages').scrollHeight;$('#new-message-indicator').hidden=true;inboxTimeline.clearUnseen();break;
    case 'show-context': if(state.contextCollapsed)await act('toggle-context'); selectContextTab('attendance'); $('#conversation-details-form [name=tags]')?.focus(); break;
    case 'mobile-inbox-back': state.mobileChat=false;render();inboxList.focusList();break;
    case 'menu': shellUI.close(); state.menuOpen = setShellDrawer(document, !state.menuOpen, { mobile: matchMedia(SHELL_MOBILE_QUERY).matches, focus: true }); break;
    case 'close-menu': shellUI.close(); state.menuOpen = setShellDrawer(document, false, { mobile: matchMedia(SHELL_MOBILE_QUERY).matches, focus: true }); break;
    case 'toggle-context': setContextOpen(state.contextCollapsed);break;
    case 'clear-contact-inbox-focus': state.inboxContactFocus=null;updateConsolidatedList();break;
    // The lens (Todos · Comigo · Fila · Agentes) is not a filter (filtersActive): clearing keeps it.
    case 'clear-inbox-filters': Object.assign(state,{inboxCompany:'all',assignedUser:'all',search:'',channel:'all',status:'active',unread:false,department:'all',kind:'all',sort:'recent',inboxContactFocus:null});syncInboxFilterHash();consolidatedInbox.setLimit(INBOX_PAGE);await refreshInboxList();break;
    case 'contact-import': contactImportUI.open();break;
    case 'conversation-older-history':{const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation);if(directHistoryAllowed(conversation)&&await directHistoryUI.open({conversationId:conversation.id,channelId:conversation.channelId,title:conversation.contact||t('Conversa'),kind:'direct'})){const modal=$('#modal');if(modal&&!modal.dataset.directHistoryBound){modal.dataset.directHistoryBound='1';modal.addEventListener('click',event=>{const node=event.target?.closest?.('[data-group-history-import-action]');if(node)void directHistoryUI.handleAction(node).catch(()=>toast(t('Não foi possível concluir a consulta do histórico. Verifique o progresso antes de fazer outro pedido.'),true));});}}break;}
    case 'contact-import-agenda': await contactImportUI.useAgenda();break;
    case 'navigation-search': navigationSearch.open();break;
    case 'platform-users': navigate('platform-users');break;
    case 'connected-products-refresh': await connectedProductsUI.action(action);break;
    case 'refresh': await refresh(); render(); toast(t('Workspace atualizado.')); break;
    case 'verify-email': {const result=await api('/api/auth/email/resend',{method:'POST',body:'{}'});toast(result.configured?t('Confirmação colocada na fila de envio.'):t('Confirmação na fila. O proprietário precisa ativar o MepMail.'));break;}
    case 'create-backup': {await api('/api/backups',{method:'POST',body:'{}'});toast(t('Backup cifrado criado e restauração local verificada.'));break;}
    case 'switch-tenant': await changeTenant(id);break;
    case 'logout': if(state.flowDirty&&!await flowDraftGuard.confirm())break;channelVisitorTestUI?.reset();state.scopedRunsEpoch=(state.scopedRunsEpoch||0)+1;contactLinksUI.reset();contactRefresh.reset();memoryUI.reset();whatsappGroupsUI.reset();teamChatUI.reset({clearDrafts:true}); participantsUI.reset();consolidatedInbox.reset();contactImportUI.reset();platformUsersUI.reset();commercialUsageUI.reset();groupsWorkspaceUI.reset();state.renderedInboxRef=null;chatLayout.reset();repliesUI.reset(); voiceRecorder.reset(); inboxTimeline.reset();mediaUI.reset();state.sendIntent=null; await api('/api/auth/logout', { method: 'POST', body: '{}' }); automationUI.reset(); avatarUI.reset(); location.assign('/login'); break;
    case 'remove-brand-logo': if(!state.busy&&!state.avatarLoading&&state.boot.session.role==='reseller'){brandDraft().logo=null;brandDraft().logoChanged=true;updateBrandPhoto();$('#brand-logo-status').textContent=t('Logotipo removido da prévia. Salve a identidade para confirmar.');$('[data-action="remove-brand-logo"]').disabled=true;}break;
    case 'choose-profile-photo': if (!state.busy && !state.avatarLoading) $('#profile-photo').click(); break;
    case 'remove-profile-photo': {
      if (state.busy || state.avatarLoading) break;
      const draft = profileDraft(); draft.avatar = null; draft.avatarChanged = true;
      updateProfilePreview(); $('[data-action="remove-profile-photo"]').disabled = true;
      $('#profile-photo').value = ''; $('#profile-photo-status').textContent = t('Foto removida. Salve o perfil para confirmar.'); break;
    }
    case 'new-conversation': formModal(t('Nova conversa no WhatsApp'), t('Escolha o número de origem e o contato. Você escreverá a mensagem na conversa antes de enviar.'), 'conversation', selectField(t('Número de origem'), 'channelId', Object.fromEntries(channels().filter(channel => channel.transport === 'baileys' && channel.state === 'connected').map(channel => [channel.id, `${channel.name} · ${displayChannelLabel(channel)}`]))) + field(t('Nome do contato'), 'name', 80) + field(t('WhatsApp com DDD'), 'number', 20, 'inputmode="tel"'), t('Abrir conversa')); break;
    case 'new-channel': formModal(t('Adicionar canal'), t('Escolha o canal. Depois de criar, configure a conexão e valide o recebimento.'), 'channel', field(t('Nome da conexão'), 'name') + selectField(t('Tipo de canal'), 'kind', Object.fromEntries(Object.entries(channelNames).filter(([kind])=>kind!=='whatsapp_cloud'))) + markup('<label class="checkbox-label"><input type="checkbox" name="real" checked/> Preparar conexão real</label>') + markup('<label>Número esperado com DDD<input name="expectedNumber" inputmode="tel" placeholder="11 9XXXX XXXX" maxlength="20"/><small>Preencha somente para WhatsApp. O token Telegram será cadastrado no passo Conectar bot.</small></label>'));if(id&&Object.hasOwn(channelNames,id)&&id!=='whatsapp_cloud')$('#modal select[name=kind]').value=id;updateChannelRegistration();break;
    case 'configure-channel': await channelConnectorsUI.open(channels().find(channel=>channel.id===id));break;
    case 'personalize-widget': await channelConnectorsUI.openWidget(channels().find(channel=>channel.id===id));break;
    case 'workspace-domain': {const context=JSON.stringify([state.workspaceId,state.boot.session.userId,state.supportGrantId]),workspaceId=state.workspaceId;const {account}=await api(`/api/accounts/${encodeURIComponent(workspaceId)}`);if(context!==JSON.stringify([state.workspaceId,state.boot.session.userId,state.supportGrantId]))break;await workspaceDomainsUI.open(account);break;}
    case 'connect-channel': await connectChannel(id); break;
    case 'connect-telegram': await connectTelegram(id); break;
    case 'connect-telegram-account': await telegramAccountUI.open(channels().find(c=>c.id===id));break;
    case 'telegram-profile': {
      const channel = channels().find(item => item.id === id), profile = channel.botProfile || {};
      formModal(t('Personalizar bot Telegram'), t('Nome, apresentação e comandos serão publicados no perfil deste bot.'), 'telegram-profile', html`<input type="hidden" name="channelId" value="${escape(id)}"/><label>Nome público<input name="name" maxlength="64" required value="${escape(profile.name || state.tenant.brand.name)}"/></label><label>Sobre<input name="about" maxlength="120" required value="${escape(profile.about || `Atendimento de ${state.tenant.name}. Envie sua mensagem para falar com a equipe.`)}"/></label><label>Apresentação<textarea name="description" maxlength="512" required rows="4">${escape(profile.description || `Olá! Este é o atendimento de ${state.tenant.name}.\nEnvie sua dúvida, pedido ou solicitação. Nossa equipe acompanha por aqui.\n/start — iniciar atendimento\n/ajuda — pedir ajuda\n/atendente — solicitar uma pessoa da equipe`)}</textarea></label><p class="group-help">Os comandos entram na caixa de atendimento como solicitações. Respostas de agentes serão conectadas em uma próxima etapa.</p>`, t('Publicar identidade')); break;
    }
    case 'telegram-groups': await telegramGroupsUI.open(channels().find(c=>c.id===id)); break;
    case 'channel-groups': await channelGroups(id); break;
/*@anchor:act-new-agent*/
    case 'new-agent': formModal(t('Adicionar copiloto'), t('O agente prepara rascunhos. O envio continua sob controle da equipe.'), 'agent', field(t('Nome do agente'), 'name') + selectField(t('Tipo de agente'), 'provider', providerNames) + '<input type="hidden" name="mode" value="copilot"/>' + field(t('Função do agente'), 'description', 200) + markup('<p class="muted">Para Claude, Codex, OpenClaw ou Hermes que você já executa, escolha Agente via MCP. Descreva a função desta integração e depois crie seu acesso em Agentes conectados. O cadastro mantém o modo copiloto e não inicia uma conexão.</p>'), t('Adicionar agente')); break;
    case 'configure-agent': {
      const agent = state.tenant.agents.find(item => item.id === id);
      if(agent?.provider!=='hermes')throw new Error(t('Para agentes via MCP, configure uma identidade em Agentes conectados.'));
      formModal(t('Configurar runtime'), txt`Conecte ${agent.name} a um serviço autorizado para preparar respostas.`, 'agent-config', html`<input type="hidden" name="agentId" value="${escape(id)}"/><input type="hidden" name="version" value="${agent.version || 1}"/><label>Nome do copiloto<input name="name" value="${escape(agent.name || '')}" maxlength="48" required/></label><label>Descrição curta<input name="description" value="${escape(agent.description || '')}" maxlength="200"/></label><label>Endpoint do runtime<input type="url" name="endpoint" value="${escape(agent.endpoint || '')}" placeholder="http://127.0.0.1:PORTA/v1/chat/completions" maxlength="300" required/><small>Hermes ou API compatível em um host autorizado pela operação.</small></label><label>Modelo<input name="model" value="${escape(agent.model || 'deepseek/deepseek-v4.1-flash')}" maxlength="100" required/></label><label>Token de acesso<input type="password" name="token" maxlength="500" autocomplete="new-password" spellcheck="false"/><small>${agent.configured ? t('Deixe vazio para manter o token já cadastrado.') : t('A chave é guardada cifrada e não aparece nas consultas.')}</small></label><label>Instruções de operação<textarea name="instructions" maxlength="4000" rows="6" placeholder="Opcional. Ex.: apresente-se como equipe de suporte, confirme o número do pedido antes de responder e nunca prometa prazos.">${escape(agent.instructions || '')}</textarea><small>Até 4.000 caracteres. Entram no início de cada preparação; não ampliam permissões nem dispensam a revisão humana.</small></label><div class="notice subtle">${icon('shield')}<span>A conexão prepara rascunhos; ferramentas MCP e envio autônomo exigem configuração própria.</span></div>`, t('Salvar configuração')); break;
    }
/*@end:act-new-agent*/
    case 'new-flow': if(state.flowDirty&&!await flowDraftGuard.confirm())break;formModal(t('Novo fluxo'), t('Escolha uma rota inicial e adapte os passos à sua operação.'), 'flow', field(t('Nome do fluxo'), 'name', 80) + markup('<label>Descrição<input name="description" maxlength="200"/></label>') + selectField(t('Começar com'), 'template', { linear: t('Entrada → fila da equipe'), conditional: t('Triagem: suporte ou fila') }) + html`<label>Departamento da triagem<select name="initialDepartment">${flowDepartmentOptions('',(state.tenant?.departments||[]).filter(item=>item.active!==false),{format:'id-v1',escape})}</select><small>Usado na triagem condicional. O destino fica vinculado ao ID do departamento.</small></label>`, t('Criar rascunho'));updateFlowRegistration();break;
    case 'save-flow': {const result=await saveFlow();render();toast(result.localChangesRemain?t('Versão enviada salva. Suas alterações mais recentes continuam no editor.'):t('Rascunho do fluxo salvo.'));break;}
    case 'publish-flow': {
      if (state.flowDirty){const result=await saveFlow();if(result.localChangesRemain){render();toast(t('Salve as alterações mais recentes antes de publicar.'),true);break;}}
      const flow = state.flows.find(item => item.id === state.flowId);
      await api(tenantApi(`flows/${flow.id}/publish`), { method: 'POST', body: JSON.stringify({ version: flow.version }) }); await refresh(); selectFlow(flow.id); render(); toast(t('Versão publicada. A rota está disponível no atendimento.')); break;
    }
    case 'flow-json': formModal(t('Estrutura avançada'), t('Ajuste os passos e as conexões. A validação completa acontece ao salvar.'), 'flow-json', html`<label>Grafo do fluxo<textarea name="graph" rows="15" class="code-editor" ${state.boot.session.role !== 'reseller' ? 'readonly' : ''}>${escape(JSON.stringify(state.flowDraft, null, 2))}</textarea></label>`, t('Usar no editor')); break;
    case 'channel-info': {
      const channel = channels().find(item => item.id === id);
      const detail = channel.kind === 'whatsapp_qr' ? t('O gateway próprio emitirá o QR e manterá a sessão do número. Eventos de recebimento, envio, entrega e reconexão entrarão no núcleo do painel.') : channel.kind === 'whatsapp_cloud' ? t('O adaptador da Meta terá onboarding e webhooks próprios. Cloud API e QR serão conexões distintas com capacidades diferentes.') : t('O adaptador normalizará mensagens, estados e anexos para a caixa de atendimento, respeitando as capacidades da plataforma.');
      openModal(channel.name, channelNames[channel.kind], html`<div class="dialog-detail">${badge(t('Integração externa pendente'))}<p>${detail}</p><div class="notice subtle">${icon('shield')}<span>Nenhum QR falso ou credencial de produção é usado nesta prévia.</span></div><button class="button primary" data-close-modal>Entendido</button></div>`); break;
    }
    case 'conversation-reply-exempt':{const exempt=element?.dataset?.exempt==='true';await api(tenantApi(`conversations/${encodeURIComponent(conversation.id)}/reply-exemption`),{method:'POST',body:JSON.stringify({exempt})});toast(exempt?t('Conversa marcada como equipe/QA.'):t('Conversa voltou ao limite do canal.'));await refresh();render();break;}
    case 'takeover': if(conversation.assignedUserId&&conversation.assignedUserId!==state.boot.session.userId){formModal(t('Assumir atendimento'),t('O responsável atual é ')+conversation.assignedUserName+t('. Registre o motivo da intervenção.'),'supervisor-takeover',html`<input type="hidden" name="contextKey" value="${escape(inboxIdentity(selectedInboxRef()))}"/>${field(t('Motivo'),'reason',240)}`,t('Assumir atendimento'));break;}await api(tenantApi(`conversations/${conversation.id}/owner`),{method:'POST',body:JSON.stringify({owner:'human',version:conversation.version})});await refresh();render();toast(t('Você assumiu a conversa.'));break;
    case 'run-agent': {
      const agentId = $('#assigned-agent')?.value || state.tenant.agents.find(agent => agent.configured&&agent.provider==='hermes'&&agent.mode==='copilot')?.id, agent = state.tenant.agents.find(item => item.id === agentId);
      if(agent?.provider==='mcp')throw new Error(t('Este agente prepara o texto no seu cliente MCP. Use Agentes conectados para configurar o acesso e entregar o rascunho.'));
      if (!agent?.configured) throw new Error(t('Configure o runtime do agente selecionado antes de preparar a resposta.'));
      if(!canCoordinate(conversation))throw new Error(t('O responsável coordena o copiloto deste atendimento.'));
      if((state.tenant.runs||[]).some(run=>activeRunStates.has(run.state)&&run.conversationId===conversation.id))throw new Error(t('O copiloto tem uma execução ativa. Aguarde, decida sobre a ferramenta ou cancele.'));
      agentRail.openRun(conversation,agent); break;
    }
/*@anchor:act-test-agent*/
    case 'test-agent': {if(state.tenant.agents.find(agent=>agent.id===id)?.provider!=='hermes')throw new Error(t('A conexão MCP é verificada no cliente do seu agente, com a identidade criada em Agentes conectados.'));await api(tenantApi(`agents/${id}/test`),{method:'POST',body:'{}'});await refresh();render();toast(t('O serviço Hermes respondeu com o modelo configurado.'));break;}
/*@end:act-test-agent*/
    case 'conversation-flow': formModal(t('Aplicar fluxo à conversa'), t('Veja o resultado antes de atualizar o atendimento. Esta ação não envia mensagens.'), 'conversation-flow', selectField(t('Fluxo publicado'), 'flowId', Object.fromEntries(state.flows.filter(flow => flow.publishedVersion).map(flow => [flow.id, `${flow.name} · v${flow.publishedVersion}`]))), t('Ver resultado')); break;
    case 'apply-conversation-flow': {
      const pending = state.pendingFlowApplication;
      if (!pending) throw new Error(t('Escolha novamente o fluxo.'));
      await api(tenantApi(`flows/${pending.flowId}/simulate`), { method: 'POST', body: JSON.stringify({ ...pending, apply: true }) }); state.pendingFlowApplication = null; $('#modal').close(); await refresh(); render(); toast(t('Fluxo aplicado ao contexto da conversa.')); break;
    }
  }
}
/*@end:act*/
/*@anchor:workspace-selection-reset*/
function resetWorkspaceSelection({preserveMediaDrafts=false}={}) { if(typeof followUpsUI!=='undefined')followUpsUI.reset();inboxReadAttempts.clear(); state.inboxOpeningController?.abort();state.inboxHistoryController?.abort();if(typeof inboxMessagePages!=='undefined')inboxMessagePages.clear();contactLinksUI.reset();contactRefresh.reset();memoryUI.reset();whatsappGroupsUI.reset();telegramGroupsUI.reset();if(typeof telegramAccountUI!=='undefined')telegramAccountUI.reset();channelConnectorsUI.reset();workspaceDomainsUI.reset();plansUI.reset();accountsUI.reset();unitsUI.reset();accountInvitationsUI.reset();state.accountAccessIntent=null;supportUI.reset();servicePrincipalsUI.reset();serviceHandoffsUI.reset();customerContextUI.reset();billingUI.reset();subscriptionUI.reset();state.supportTenants=[];accountSecurityUI.reset();teamChatUI.reset();workspaceUI.resetPeople(); workspaceUI.resetContacts();consolidatedInbox.reset();contactImportUI.reset();platformUsersUI.reset();commercialUsageUI.reset();groupsWorkspaceUI.reset();state.inboxSelectionSequence++;state.inboxSelecting=false;state.renderedInboxRef=null;state.inboxCompany='all';state.assignedUser='all';clearTimeout(state.inboxSearchTimer); conversationTools.reset();noteDrafts.reset();forwarding.reset();participantsUI.reset();state.attendanceModal=null;state.schedules=[];state.scheduleIntent=null;state.noteIntent=null;state.composerMode='reply';state.unread=false;state.department='all';state.kind='all';state.sort='recent';chatLayout.reset();repliesUI.reset();state.quickReplies=[];state.repliesModalContext=null; voiceRecorder.reset(); inboxTimeline.reset(); if(!preserveMediaDrafts)mediaUI.reset(); automationUI.reset(); avatarUI.reset(); mcpUI.reset(); resetScreens(); knowledgeUI.reset();memoryUI.reset(); brandDrafts.reset(); state.brandDraft = null; state.mobileChat=false;state.conversation = null; state.inboxContactFocus=null; state.sendIntent = null; state.search = ''; state.channel = 'all'; state.filter = 'all'; state.status = 'active'; state.flowId = null; state.flowDraft = null; state.flowNode = null; state.flowDirty = false; state.flowResult = null; state.pendingFlowApplication = null; }
/*@end:workspace-selection-reset*/
async function saveFlow() {
  if(state.flowSaving)throw new Error(t('Aguarde o salvamento do fluxo.'));
  const flow = state.flows.find(item => item.id === state.flowId);
  if(!flow||!state.flowDraft)throw new Error(t('Escolha um fluxo para salvar.'));
  const scope=()=>JSON.stringify([state.workspaceId,state.supportGrantId||null,state.tenant?.id,state.flowId]);
  const before=scope(),graph=structuredClone(state.flowDraft),serialized=JSON.stringify(graph),base=tenantApi(`flows/${flow.id}`),version=flow.version;
  state.flowSaving=true;
  try{
    await api(base,{method:'PUT',body:JSON.stringify({version,name:flow.name,graph})});
    if(scope()!==before)throw new Error(t('O contexto do fluxo mudou. Reabra o fluxo para conferir a versão salva.'));
    await refresh();
    if(scope()!==before)throw new Error(t('O contexto do fluxo mudou. Reabra o fluxo para conferir a versão salva.'));
    const localChangesRemain=JSON.stringify(state.flowDraft)!==serialized;
    if(!localChangesRemain)selectFlow(flow.id);
    else{state.flowDirty=true;state.flowResult=null;}
    return {saved:true,localChangesRemain};
  }finally{state.flowSaving=false;}
}



function updateChannelRegistration(){
  const form=$('#modal [data-dialog-form="channel"]');if(!form)return;
  const kind=form.elements.namedItem('kind')?.value;
  const number=form.elements.namedItem('expectedNumber');if(number){number.closest('label').hidden=kind!=='whatsapp_qr';number.disabled=kind!=='whatsapp_qr';}
  const native=form.elements.namedItem('real');if(native)native.closest('label').hidden=!['whatsapp_qr','telegram'].includes(kind);
}
function updateFlowRegistration(){
  const form=$('#modal [data-dialog-form="flow"]');if(!form)return;
  const conditional=form.elements.namedItem('template')?.value==='conditional',department=form.elements.namedItem('initialDepartment');
  if(department){department.closest('label').hidden=!conditional;department.required=conditional;department.disabled=!conditional;}
}
$('#modal').addEventListener('change',event=>{
  if(event.target.matches('[name="kind"]'))updateChannelRegistration();
  if(event.target.matches('[name="template"]'))updateFlowRegistration();
});

/*@anchor:flow-draft-guard*/
const flowDraftGuard = createFlowDraftGuard({
  getContext: () => ({key:JSON.stringify([state.workspaceId,state.supportGrantId||null,state.tenant?.id,state.flowId]),revision:state.flows.find(flow=>flow.id===state.flowId)?.version,dirty:state.flowDirty,busy:state.flowSaving,name:state.flows.find(flow=>flow.id===state.flowId)?.name}),
  openModal,getModal:()=>$('#modal'),save:saveFlow,discard:()=>selectFlow(state.flowId),escape
});
/*@end:flow-draft-guard*/
const navigationSearch = createCommandPalette({
  request:api,
  getItems:()=>navigation.filter(([key])=>key!=='architecture'&&(key==='account'||allowedNavigation(key))).map(([key,label,glyph])=>({key,label:t(label),glyph,description:t(navigationDescriptions[key]||'')})),
  getAuthority:()=>inboxContactAuthority(),openModal,getModal:()=>$('#modal'),navigate,escape,icon,
  canOpen:()=>Boolean(state.boot)&&!state.busy&&!mediaUI.sending&&!voiceRecorder.busy&&!state.sendIntent
});
window.addEventListener('keydown',event=>navigationSearch.keydown(event));
window.addEventListener('beforeunload',event=>{if(state.flowDirty){event.preventDefault();event.returnValue='';}});

/*@anchor:app-click*/
$('#app').addEventListener('click', async event => {
  const guideAnchor=event.target.closest('a[data-guide-anchor]');
  if(guideAnchor&&state.view==='guide'){
    event.preventDefault();
    const href=guideAnchor.getAttribute('href')||'';
    const target=/^#guide-[a-z]+$/.test(href)&&document.getElementById(href.slice(1));
    if(target){target.focus({preventScroll:true});target.scrollIntoView({behavior:'auto',block:'start'});}
    return;
  }
  const telegramAction=event.target.closest('[data-telegram-groups-action]');if(telegramAction){await telegramGroupsUI.action(telegramAction);return;}
  const connectorAction=event.target.closest('[data-connector-action]');if(connectorAction){await channelConnectorsUI.action(connectorAction);return;}
  const domainsAction=event.target.closest('[data-domains-action]');if(domainsAction){await workspaceDomainsUI.action(domainsAction);return;}
  const plansAction=event.target.closest('[data-plans-action]');if(plansAction){await plansUI.action(plansAction);return;}
  const usageAction=event.target.closest('[data-commercial-usage-action]');if(usageAction){await commercialUsageUI.handleAction(usageAction);return;}
  const accountsAction=event.target.closest('[data-accounts-action]');if(accountsAction){await accountsUI.handleAction(accountsAction);return;}
  const invitationAction=event.target.closest('[data-account-invitation-action]');if(invitationAction){await accountInvitationsUI.handleAction(invitationAction);return;}
  const handoffAction=event.target.closest('[data-service-handoff-action]');if(handoffAction){await serviceHandoffsUI.handleAction(handoffAction);return;}
  const customerContextAction=event.target.closest('[data-customer-context-action]');if(customerContextAction){try{await customerContextUI.handleAction(customerContextAction);}catch(error){toast(error.message,true);}return;}
  const serviceAction=event.target.closest('[data-service-principal-action]');if(serviceAction){await servicePrincipalsUI.handleAction(serviceAction);return;}

  const teamAction=event.target.closest('[data-team-chat-action]');if(teamAction){await teamChatUI.handleAction(teamAction);return;}
  const tool=event.target.closest('[data-conversation-tool]');if(tool&&!tool.disabled){try{await conversationTools.handleAction(tool);}catch(error){toast(error.message,true);}return;}
  const composerMode=event.target.closest('[data-composer-mode]');if(composerMode){setComposerMode(composerMode.dataset.composerMode);return;}
  const layoutAction=event.target.closest('[data-layout-action]');
  if(layoutAction&&!layoutAction.disabled){
    if(layoutAction.dataset.layoutAction==='sidebar'){chatLayout.toggleSidebar();syncShellLayout();}
    if(layoutAction.dataset.layoutAction==='expand'){state.menuOpen=setShellDrawer(document,false,{mobile:matchMedia(SHELL_MOBILE_QUERY).matches});chatLayout.expand();}
    if(layoutAction.dataset.layoutAction==='conversations'){
      if(voiceRecorder.busy&&matchMedia('(max-width:760px)').matches){toast(t('Finalize ou descarte a gravação antes de abrir a lista.'),true);return;}
      chatLayout.conversations();
    }
    return;
  }
  if (mediaUI.sending) return;
  const voiceAction=event.target.closest('[data-voice-action]');
  if(voiceAction){const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation);if(voiceAction.dataset.voiceAction==='start'&&(!canReplyTo(conversation)||!supportsMedia(conversation)||mediaUI.selected||state.busy))return;await voiceRecorder.handleAction(voiceAction.dataset.voiceAction);return;}
  const mediaAction = event.target.closest('[data-media-action]');
  if (mediaAction) {
    const conversation = state.tenant?.conversations.find(item => item.id === state.conversation);
    if (!conversation) return;
    try { await mediaUI.handleAction(mediaAction, { conversation, base: tenantApi(`conversations/${encodeURIComponent(conversation.id)}`), canReply: canReplyTo(conversation), renderMessages: refreshMessageAttachments }); if (mediaAction.dataset.mediaAction === 'remove') render(); }
    catch (error) { if (error.name !== 'AbortError') toast(error.message, true); }
    return;
  }
  const flowItem = event.target.closest('[data-flow-id]'); if (flowItem) { if(flowItem.dataset.flowId===state.flowId)return;if(state.flowDirty&&!await flowDraftGuard.confirm())return;selectFlow(flowItem.dataset.flowId); render(); return; }
  const brandScope = event.target.closest('[data-brand-scope]'); if (brandScope) { state.brandScope = brandScope.dataset.brandScope; render(); document.querySelector(`[data-brand-scope="${state.brandScope}"]`)?.focus(); return; }
  const overviewConversation=event.target.closest('[data-overview-conversation]');
  if(overviewConversation){if(state.view!=='overview'||overviewConversation.dataset.overviewTenant!==state.tenant?.id)return; const tenantId=state.tenant.id,conversationId=overviewConversation.dataset.overviewConversation; if(!hasPermission('inbox.read')||!state.tenant.conversations.some(c=>c.id===conversationId))return; navigate('inbox'); try{await selectInboxConversation(tenantId,conversationId);}catch(error){toast(error.message,true);}return;}
  // Links of the shell carry the canonical href (open in a new tab with a modifier) and data-view (navigate() and its guards).
  const nav = event.target.closest('button[data-view], a[data-view]'); if (nav) { if (nav.tagName === 'A') { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); } navigate(nav.dataset.view); return; }
  const conv=event.target.closest('[data-conversation]');if(conv){await openInboxConversation(conv.dataset.inboxTenant||state.tenant.id,conv.dataset.conversation);return;}
  const filter=event.target.closest('[data-filter]');if(filter){await changeInboxFilter('filter',filter.dataset.filter);return;}
  const action = event.target.closest('[data-action]');
  if(action&&await platformUsersUI.action(action.dataset.action,action.dataset.id))return;
  if (action) {
    // These GET filters keep the focused button mounted while their list updates.
    const readFilter = ['inbox:channel', 'inbox:toggle-unread', 'inbox:toggle-pending'].includes(action.dataset.action);
    if (!readFilter) action.disabled = true;
    try { await act(action.dataset.action, action.dataset.id, action); }
    catch (error) { toast(error.message, true); }
    finally { if (!readFilter && action.isConnected) action.disabled = false; }
  }
});
/*@end:app-click*/
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#modal').open&&conversationTools.opened){event.preventDefault();conversationTools.close();return;}if(chatLayout.escape(event))return;if(event.key==='Escape'&&!event.defaultPrevented&&state.menuOpen){event.preventDefault();act('close-menu');}});
$('#app').addEventListener('change', async event => {
  if(await shellChange(event))return;
  if(await contactImportUI.handleChange(event))return;
  if(await knowledgeUI.handleChange(event))return;
  if(event.target.id === 'brand-logo-file') {
    const file=event.target.files?.[0],draft=brandDraft(),form=$('#brand-form');
    if(!file||state.busy||state.avatarLoading||state.boot.session.role!=='reseller')return;
    state.avatarLoading=true;form.setAttribute('aria-busy','true');form.querySelector('[type="submit"]').disabled=true;
    $('#brand-logo-status').textContent=t('Preparando o logotipo…');form.querySelector('.form-error').textContent='';
    try {const logo=await prepareProfilePhoto(file);if(state.brandDraft===draft&&form.isConnected){draft.logo=logo;draft.logoChanged=true;updateBrandPhoto();$('#brand-logo-status').textContent=t('Logotipo pronto. Salve a identidade para confirmar.');$('[data-action="remove-brand-logo"]').disabled=false;}}
    catch(error){if(form.isConnected){form.querySelector('.form-error').textContent=error.message;$('#brand-logo-status').textContent=t('Escolha outra imagem.');}}
    finally{state.avatarLoading=false;if(form.isConnected){form.removeAttribute('aria-busy');form.querySelector('[type="submit"]').disabled=state.busy;}event.target.value='';}
    return;
  }

  if (event.target.id === 'message-file') {
    const conversation = state.tenant?.conversations.find(item => item.id === state.conversation);
    if (!conversation || !canReplyTo(conversation) || !supportsMedia(conversation) || state.busy) { event.target.value = ''; return; }
    mediaUI.choose(event.target.files?.[0], $('#message-text')?.value || ''); event.target.value = '';
    render(); $('#message-text')?.focus(); return;
  }
  if(event.target.id==='contacts-archived'){state.showArchived=event.target.checked;state.contactPage=0;updateContactsPage();}
  if (event.target.id === 'profile-photo') {
    const file = event.target.files?.[0];
    if (!file || state.busy || state.avatarLoading) return;
    const draft = profileDraft(), form = $('#profile-form');
    state.avatarLoading = true;
    form.setAttribute('aria-busy', 'true');
    for (const control of form.querySelectorAll('button')) control.disabled = true;
    $('#profile-photo-status').textContent = t('Preparando a foto…'); form.querySelector('.form-error').textContent = '';
    try {
      const photo = await prepareProfilePhoto(file);
      if (state.profileDraft === draft) { draft.avatar = photo; draft.avatarChanged = true; updateProfilePreview(); if ($('#profile-photo-status')) $('#profile-photo-status').textContent = t('Foto pronta. Salve o perfil para confirmar.'); }
    } catch (error) { if (form.isConnected) { form.querySelector('.form-error').textContent = error.message; $('#profile-photo-status').textContent = ''; } else toast(error.message, true); }
    finally {
      state.avatarLoading = false;
      const currentForm = $('#profile-form');
      if (currentForm) { currentForm.removeAttribute('aria-busy'); for (const control of currentForm.querySelectorAll('button')) control.disabled = state.busy; $('[data-action="remove-profile-photo"]').disabled = !profileDraft().avatar || state.busy; }
      event.target.value = '';
    }
  }
  const attendanceFilters={'inbox-company-filter':'inboxCompany','assigned-user-filter':'assignedUser','channel-filter':'channel','conversation-status-filter':'status','department-filter':'department','kind-filter':'kind','sort-filter':'sort','unread-filter':'unread'};
  if(attendanceFilters[event.target.id])await changeInboxFilter(attendanceFilters[event.target.id],event.target.id==='unread-filter'?event.target.checked:event.target.value);
});
$('#app').addEventListener('input', async event => {
  if(await contactImportUI.handleChange(event))return;
  if(conversationTools.handleInput(event.target))return;
  if(event.target.id==='internal-note-text'){if(!noteDrafts.save(event.target.value))toast(t('Limite de notas em rascunho atingido.'),true);composerStatus();}
  if(knowledgeUI.handleInput(event))return;
  if(event.target.closest('#brand-form')&&['name','initials','accent','domain'].includes(event.target.name)){brandDraft()[event.target.name]=event.target.value;if(event.target.name!=='domain')settingsUI.paintBrand();}
  if (event.target.id === 'message-text') { mediaUI.draft = event.target.value; composerStatus(); }
  if(event.target.id==='contact-search'){state.contactSearch=event.target.value;state.contactPage=0;updateContactsPage();}
  if (event.target.closest('#profile-form') && ['name', 'phone', 'bio'].includes(event.target.name)) { profileDraft()[event.target.name] = event.target.value; if (event.target.name === 'name') updateProfilePreview(); }
  if(event.target.id==='conversation-search'){state.search=event.target.value;state.inboxContactFocus=null;syncInboxFilterHash();clearTimeout(state.inboxSearchTimer);consolidatedInbox.cancelLoad();state.inboxSearchTimer=setTimeout(()=>refreshInboxList().catch(error=>toast(error.message,true)),250);}
});
/*@anchor:app-submit*/
/*@anchor:app-submit-listener*/
$('#app').addEventListener('submit', async event => {
  if(event.target.dataset?.form&&await dispatchSubmit(event.target,event))return;
  if(event.target.matches('[data-telegram-account-form]')){event.preventDefault();try{await telegramAccountUI.submit(event.target);}catch(error){toast(error.message,true);}return;}
  if(event.target.matches('[data-telegram-groups-form]')){event.preventDefault();try{await telegramGroupsUI.submit(event.target);}catch(error){toast(error.message,true);}return;}
  if(event.target.matches('[data-connector-form]')){event.preventDefault();try{await channelConnectorsUI.submit(event.target);}catch(error){toast(error.message,true);}return;}
  if(event.target.matches('[data-domains-form]')){event.preventDefault();await workspaceDomainsUI.submit(event.target);return;}
  if(event.target.matches('[data-plans-form]')){event.preventDefault();await plansUI.submit(event.target);return;}
  if(event.target.matches('[data-accounts-form]')){event.preventDefault();await accountsUI.submit(event.target);return;}
  if(event.target.matches('[data-product-connect-form]')){event.preventDefault();await connectedProductsUI.submit(event.target);return;}
  if(event.target.matches('[data-account-invitation-form]')){event.preventDefault();await accountInvitationsUI.submit(event.target);return;}
  if(event.target.matches('[data-units-filter]')){event.preventDefault();unitsUI.filter(event.target);return;}
  if(event.target.matches('[data-support-form]')){event.preventDefault();await supportUI.submit(event.target);return;}
  if(event.target.matches('[data-service-handoff-form]')){event.preventDefault();await serviceHandoffsUI.submit(event.target);return;}
  if(event.target.matches('[data-service-principal-form]')){event.preventDefault();await servicePrincipalsUI.submit(event.target);return;}
  if(event.target.matches('[data-billing-form]')){event.preventDefault();try{await billingUI.submit(event.target);}catch(error){const target=event.target.querySelector('.form-error');if(target)target.textContent=error.message;else toast(error.message,true);}return;}

  if(event.target.matches('[data-team-chat-form]')){event.preventDefault();await teamChatUI.submit(event.target);return;}
  event.preventDefault(); const form = event.target, submit = form.querySelector('[type="submit"]');
  if (state.busy) return; state.busy = true; submit.disabled = true;
  let submittedMediaContext=form.id==='message-form'?mediaUI.contextKey:null;
  try {
    if(await accountSecurityUI.submit(form))return;
    if(await contactLinksUI.submit(form))return;
    if(await workspaceUI.submit(form))return;
    if(await automationUI.submit(form))return;
    if (form.id === 'profile-form') {
      if (state.avatarLoading) throw new Error(t('Aguarde a preparação da foto.'));
      const draft = profileDraft(), input = { name: form.elements.namedItem('name').value, phone: form.elements.namedItem('phone').value, bio: form.elements.namedItem('bio').value };
      Object.assign(draft, input);
      if (draft.avatarChanged) input.avatar = draft.avatar;
      form.querySelector('.form-error').textContent = ''; (submit.querySelector?.('.ui-btn__label') || submit).textContent = t('Salvando perfil…');
      form.setAttribute('aria-busy', 'true');
      for (const control of form.querySelectorAll('input,textarea,button')) control.disabled = true;
      const result = await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify(input) });
      state.account.user = result.user;
      state.boot.session.name = result.user.name; state.boot.session.avatar = result.user.avatar;
      state.users = state.users.map(user => user.id === result.user.id ? result.user : user);
      state.profileDraft = null; render(); toast(t('Perfil salvo.'));
    }
    if (form.id === 'brand-form') {
      const input=Object.fromEntries(new FormData(form));if(state.avatarLoading)throw new Error(t('Aguarde a imagem terminar de carregar.'));if(brandDraft().logoChanged)input.logo=brandDraft().logo;await api(state.brandScope === 'reseller' ? '/api/reseller/brand' : tenantApi('brand'), { method: 'PATCH', body: JSON.stringify(input) }); brandDrafts.invalidate(state.brandScope);state.brandDraft=null;await refresh();render();toast(t('Identidade e logotipo salvos.'));
    }
    if(form.id==='integrations-form'){
      const input=Object.fromEntries(new FormData(form));input.disableEmail=input.disableEmail==='on';input.disableCommandCode=input.disableCommandCode==='on';
      await api('/api/integrations',{method:'POST',body:JSON.stringify(input)});form.reset();await refresh();render();toast(t('Integrações salvas.'));
    }
    if(form.id==='internal-note-form'){
      const context=captureAttendance(),content=form.elements.namedItem('text').value;
      if(!canReplyTo(currentConversation()))throw Error(t('Assuma este atendimento antes de salvar uma nota.'));
      if(!content.trim())throw Error(t('Escreva a nota antes de salvar.'));
      if(!state.noteIntent||state.noteIntent.key!==context.key||state.noteIntent.text!==content)state.noteIntent={key:context.key,text:content,version:context.version,commandId:crypto.randomUUID()};
      const result=await attendanceRequest(context,'notes',{method:'POST',body:JSON.stringify({text:content,version:state.noteIntent.version,commandId:state.noteIntent.commandId})});
      noteDrafts.clear();state.noteIntent=null;form.elements.namedItem('text').value='';applyAttendance(result);composerStatus();toast(t('Nota salva somente para a equipe.'));
    }
    if (form.id === 'message-form') {
      if(submittedMediaContext!==mediaUI.contextKey)return;
      const conversation = state.tenant.conversations.find(item => item.id === state.conversation), message = new FormData(form).get('text');
      if(voiceRecorder.busy)throw new Error(t('Finalize ou descarte a gravação antes de enviar.'));
      if (!canReplyTo(conversation)) throw new Error(t('Assuma esta conversa antes de responder.'));
      if (!message.trim() && !mediaUI.selected) throw new Error(t('Escreva uma mensagem ou escolha um arquivo antes de enviar.'));
      if(!groupOpen(conversation))throw new Error(t('Este grupo está bloqueado para respostas. Seu rascunho foi preservado.'));
      if(!windowOpen(conversation))throw new Error(t('A janela de resposta desta conexão expirou. Seu rascunho foi preservado.'));
      assertChannelText(message,capabilitiesFor(conversation),{attachment:Boolean(mediaUI.selected),audio:mediaUI.selected?.kind==='audio'||mediaUI.selected?.file.type.startsWith('audio/')});
      if (mediaUI.selected && message.length > 1024) throw new Error(t('A legenda do arquivo deve ter até 1.024 caracteres. Seu texto foi preservado.'));
      const whatsappAudio = () => channelFor(conversation)?.transport === 'baileys' && (mediaUI.selected?.kind === 'audio' || mediaUI.selected?.file.type.startsWith('audio/'));
      if (whatsappAudio() && message.trim()) throw new Error(t('Áudio no WhatsApp é enviado sem legenda. Remova o texto ou envie-o em outra mensagem.'));
      const base = tenantApi(`conversations/${encodeURIComponent(conversation.id)}`), version = conversation.version;
      validatePendingSend({workspaceId:state.workspaceId,tenantId:state.tenant.id,conversationId:conversation.id,channelId:conversation.channelId,text:message,version,attachmentIds:mediaUI.selected?.uploadedId?[mediaUI.selected.uploadedId]:[],replyToMessageId:repliesUI.replyToMessageId||undefined});
      submittedMediaContext=mediaUI.contextKey;const selectedFile=mediaUI.selected,sendHeaders={'X-Elozi-Workspace':state.workspaceId,...(state.supportGrantId?{'X-Elozi-Support-Grant':state.supportGrantId}:{})};
      mediaUI.startSending(message);
      if (mediaUI.selected && !mediaUI.selected.uploadedId) {
        const file = mediaUI.selected.file;
        const attachment = await api(`${base}/attachments`, { method: 'POST', body: file, headers: { ...sendHeaders,'Content-Type': file.type || 'application/octet-stream', 'X-Elozi-Filename': encodeURIComponent(file.name), 'X-Elozi-Conversation-Version': String(version), ...(selectedFile.voice ? {'X-Elozi-Voice':'1'} : {}) } });
        if(submittedMediaContext!==mediaUI.contextKey||selectedFile!==mediaUI.selected)return;
        if (!attachment.id) throw new Error(t('O arquivo não foi preparado. Escolha novamente.'));
        mediaUI.uploaded(attachment);
      }
      if (whatsappAudio() && message.trim()) throw new Error(t('Áudio no WhatsApp é enviado sem legenda. Remova o texto ou envie-o em outra mensagem.'));
      const attachmentIds = mediaUI.selected?.uploadedId ? [mediaUI.selected.uploadedId] : [];
      const replyToMessageId=repliesUI.replyToMessageId||undefined;
      state.sendIntent=createSendIntent(state.sendIntent,{workspaceId:state.workspaceId,tenantId:state.tenant.id,conversationId:conversation.id,channelId:conversation.channelId,text:message,version,attachmentIds,replyToMessageId});
      const sourceRunId=state.boot?.features?.includes?.('source-run-id')?composerBridge.sourceRunId:null;
      await api(`${base}/messages`, { method: 'POST', headers:sendHeaders,body: JSON.stringify({ text: message, version:state.sendIntent.version, channelId: conversation.channelId, attachmentIds, replyToMessageId, idempotencyKey: state.sendIntent.idempotencyKey, ...(sourceRunId?{sourceRunId}:{}) }) });
      if(submittedMediaContext!==mediaUI.contextKey||selectedFile!==mediaUI.selected)return;
      state.sendIntent = null;
      mediaUI.clearSent();repliesUI.clearSent();consolidatedInbox.clearDraft(selectedInboxRef()); $('#message-text').value = '';composerBridge.clearSource();
      const real = isRealConversation(conversation);
      const platform = transportName(conversation); await refresh(); render(); $('#messages').scrollTop = $('#messages').scrollHeight; toast(real ? txt`Envio aceito pelo ${platform}. Acompanhe o status na conversa.` : t('Resposta salva somente no sandbox.'));
    }
    if (form.id === 'conversation-details-form') {
      const conversation = state.tenant.conversations.find(item => item.id === state.conversation);if(!canManageAttendance(conversation))throw Error(t('Somente o responsável ou a gestão pode organizar este atendimento.'));const input = Object.fromEntries(new FormData(form)); input.tags = [...new Set(input.tags.split(',').map(tag => tag.trim()).filter(Boolean))];
      await api(tenantApi(`conversations/${conversation.id}/details`), { method: 'POST', body: JSON.stringify({ ...input, version: conversation.version }) }); await refresh(); render(); toast(t('Contexto da conversa atualizado.'));
    }
  } catch (error) {
    if(form.id==='internal-note-form'&&error.status===409){state.noteIntent=null;try{await refresh();render();}catch{}}
    if (form.id === 'message-form'&&(!submittedMediaContext||submittedMediaContext===mediaUI.contextKey)) {
      mediaUI.fail(error.message);
      if([400,409].includes(error.status)&&!['OUTBOUND_UNCONFIRMED','OUTBOUND_REGISTERED'].includes(error.code))state.sendIntent=null;
      if (error.status === 409) { try { await refresh(); render(); } catch { toast(t('A conversa mudou, mas a atualização falhou. Atualize antes de tentar novamente.'), true); } }
    }
    if (form.isConnected && form.querySelector('.form-error')) form.querySelector('.form-error').textContent = error.message;
    else if (form.id !== 'message-form' || error.status !== 409) toast(error.message, true);
  }
  finally {
    const currentOperation=form.id!=='message-form'||(!submittedMediaContext||submittedMediaContext===mediaUI.contextKey);
    if(currentOperation)state.busy = false;
    if(currentOperation&&['message-form','internal-note-form'].includes(form.id))updateAttendanceAccess();
    if (form.id === 'message-form'&&(!submittedMediaContext||submittedMediaContext===mediaUI.contextKey)) {mediaUI.finishSending(!canReplyTo(currentConversation()));updateVoiceControls();}
    if (form.id === 'profile-form' && form.isConnected) {
      form.removeAttribute('aria-busy');
      for (const control of form.querySelectorAll('input,textarea,button')) control.disabled = false;
      $('[data-action="remove-profile-photo"]').disabled = !profileDraft().avatar || state.avatarLoading;
      $('[data-action="choose-profile-photo"]').disabled = state.avatarLoading;
    }
    if (currentOperation&&submit.isConnected) { submit.disabled = ['message-form','internal-note-form'].includes(form.id) ? !canReplyTo(currentConversation()) : state.avatarLoading && form.id === 'profile-form'; if (form.id === 'profile-form') { const label = submit.querySelector?.('.ui-btn__label'); if (label) label.textContent = t('Salvar perfil'); else submit.innerHTML = `${icon('check')} ${t('Salvar perfil')}`; } }
  }
});
/*@end:app-submit-listener*/
$('#modal').addEventListener('input', event => knowledgeUI.handleInput(event));
$('#modal').addEventListener('change', async event => {
  if(servicePrincipalsUI.handleChange(event))return;
  if(event.target.matches('[data-attendance-form="forward"] select')){const form=event.target.closest('form');try{if(event.target.value)forwarding.selectTarget(event.target.value);else forwarding.prepare(forwarding.preview().source.messageId);}catch(error){form.querySelector('[data-forward-status]').textContent=error.message;form.querySelector('[type="submit"]').disabled=true;}return;}
  if(await knowledgeUI.handleChange(event))return;
  if (event.target.matches('[data-dialog-form="user"] select[name="role"]')) {
    const picker = event.target.closest('form').querySelector('.user-tenant-picker');
    picker.hidden = event.target.value !== 'operator'; picker.disabled = picker.hidden;
  }
});
/*@anchor:modal-click*/
$('#modal').addEventListener('click', async event => {
  const telegramAccountAction=event.target.closest('[data-telegram-account-action]');if(telegramAccountAction){await telegramAccountUI.action(telegramAccountAction);return;}
  const whatsappAction=event.target.closest('[data-whatsapp-groups-action]');if(whatsappAction){await whatsappGroupsUI.action(whatsappAction);return;}
  const telegramAction=event.target.closest('[data-telegram-groups-action]');if(telegramAction){await telegramGroupsUI.action(telegramAction);return;}
  const connectorAction=event.target.closest('[data-connector-action]');if(connectorAction){await channelConnectorsUI.action(connectorAction);return;}
  const domainsAction=event.target.closest('[data-domains-action]');if(domainsAction){await workspaceDomainsUI.action(domainsAction);return;}
  const plansAction=event.target.closest('[data-plans-action]');if(plansAction){await plansUI.action(plansAction);return;}
  const usageAction=event.target.closest('[data-commercial-usage-action]');if(usageAction){await commercialUsageUI.handleAction(usageAction);return;}
  const accountsAction=event.target.closest('[data-accounts-action]');if(accountsAction){await accountsUI.handleAction(accountsAction);return;}
  const invitationAction=event.target.closest('[data-account-invitation-action]');if(invitationAction){await accountInvitationsUI.handleAction(invitationAction);return;}
  const handoffAction=event.target.closest('[data-service-handoff-action]');if(handoffAction){await serviceHandoffsUI.handleAction(handoffAction);return;}
  const serviceAction=event.target.closest('[data-service-principal-action]');if(serviceAction){await servicePrincipalsUI.handleAction(serviceAction);return;}

  const teamAction=event.target.closest('[data-team-chat-action]');if(teamAction){await teamChatUI.handleAction(teamAction);return;}
  if (event.target.closest('[data-close-modal]')) {if(modalRouteLifecycle.canLeave({navigation:false}))$('#modal').close();return;}
  const participantAction=event.target.closest('[data-participants-action]');if(participantAction){await participantsUI.handleAction(participantAction);return;}
  const action = event.target.closest('[data-action]'); if (action) { action.disabled = true; try { await act(action.dataset.action, action.dataset.id, action); } catch (error) { toast(error.message, true); } finally { if (action.isConnected) action.disabled = false; } }
});
/*@end:modal-click*/
/*@end:app-submit*/
/*@anchor:modal-submit*/
$('#modal').addEventListener('submit', async event => {
  if(event.target.dataset?.form&&await dispatchSubmit(event.target,event))return;
  if(event.target.matches('[data-dialog-form="groups"]')){event.preventDefault();await whatsappGroupsUI.submit(event.target);return;}
  if(event.target.matches('[data-dialog-form="platform-account-access"]')){event.preventDefault();await submitPlatformAccess(event.target);return;}
  if(event.target.matches('[data-telegram-account-form]')){event.preventDefault();try{await telegramAccountUI.submit(event.target);}catch(error){toast(error.message,true);}return;}
  if(event.target.matches('[data-telegram-groups-form]')){event.preventDefault();try{await telegramGroupsUI.submit(event.target);}catch(error){toast(error.message,true);}return;}
  if(event.target.matches('[data-connector-form]')){event.preventDefault();try{await channelConnectorsUI.submit(event.target);}catch(error){toast(error.message,true);}return;}
  if(event.target.matches('[data-domains-form]')){event.preventDefault();await workspaceDomainsUI.submit(event.target);return;}
  if(event.target.matches('[data-plans-form]')){event.preventDefault();await plansUI.submit(event.target);return;}
  if(event.target.matches('[data-accounts-form]')){event.preventDefault();await accountsUI.submit(event.target);return;}
  if(event.target.matches('[data-account-invitation-form]')){event.preventDefault();await accountInvitationsUI.submit(event.target);return;}
  if(event.target.matches('[data-units-filter]')){event.preventDefault();unitsUI.filter(event.target);return;}
  if(event.target.matches('[data-support-form]')){event.preventDefault();await supportUI.submit(event.target);return;}
  if(event.target.matches('[data-service-handoff-form]')){event.preventDefault();await serviceHandoffsUI.submit(event.target);return;}
  if(event.target.matches('[data-service-principal-form]')){event.preventDefault();await servicePrincipalsUI.submit(event.target);return;}
  if(event.target.matches('[data-billing-form]')){event.preventDefault();try{await billingUI.submit(event.target);}catch(error){const target=event.target.querySelector('.form-error');if(target)target.textContent=error.message;else toast(error.message,true);}return;}

  if(event.target.matches('[data-team-chat-form]')){event.preventDefault();await teamChatUI.submit(event.target);return;}
  if(event.target.matches('[data-participants-form]')){event.preventDefault();await participantsUI.submit(event.target);return;}
  if(event.target.matches('[data-platform-users-form]')){event.preventDefault();await platformUsersUI.submit(event.target);return;}
  if(event.target.matches('[data-contact-import-form]')){event.preventDefault();await contactImportUI.submit(event.target);return;}
  if(event.target.matches('[data-attendance-form]')){event.preventDefault();await submitAttendanceModal(event.target);return;}
  if(event.target.matches('[data-reply-form="editor"]'))return;
  event.preventDefault(); const form = event.target, submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    if(await knowledgeUI.submit(form))return;
    if(form.dataset.dialogForm?.startsWith('memory-')){const runsContext=captureScopedRuns();if(await memoryUI.submit(form.dataset.dialogForm,new FormData(form),form)){if(currentScopedRuns(runsContext))await refreshScopedConversationRuns();return;}}
    if(form.dataset.dialogForm?.startsWith('mcp-')&&await agentRail.submit(form))return;
    if(await mcpUI.submit(form))return;
    if(await accountSecurityUI.submit(form))return;
    if(await contactLinksUI.submit(form))return;
    if(await workspaceUI.submit(form))return;
    if(await unitsUI.submit(form))return;
    if(await automationUI.submit(form))return;
    const input = Object.fromEntries(new FormData(form)), type = form.dataset.dialogForm;
    if (type === 'tenant') { const created = await api('/api/tenants', { method: 'POST', body: JSON.stringify(input) }); await refresh(created.id); }
    if(type==='tenant-identity'){const id=input.id;delete input.id;input.version=Number(input.version);await api(`/api/tenants/${encodeURIComponent(id)}/identity`,{method:'PATCH',body:JSON.stringify(input)});await refresh();}
    if (type === 'channel') { input.real = input.real === 'on'; await api(tenantApi('channels'), { method: 'POST', body: JSON.stringify(input) }); await refresh(); }
    if(type==='supervisor-takeover'){if(input.contextKey!==inboxIdentity(selectedInboxRef()))throw Error(t('O atendimento mudou. Abra a ação novamente.'));const c=currentConversation();await api(tenantApi(`conversations/${encodeURIComponent(c.id)}/owner`),{method:'POST',body:JSON.stringify({owner:'human',version:c.version,reason:input.reason})});await refresh();}
    if (type === 'agent') { await api(tenantApi('agents'), { method: 'POST', body: JSON.stringify(input) }); await refresh(); }
    if (type === 'agent-config') { const agentId = input.agentId; delete input.agentId; input.version=Number(input.version); if (!input.token) delete input.token; await api(tenantApi(`agents/${agentId}`), { method: 'PATCH', body: JSON.stringify(input) }); form.reset(); await refresh(); }
    if (type === 'flow') { const graph = flowTemplate(input.template,input.initialDepartment); delete input.template;delete input.initialDepartment; const result = await api(tenantApi('flows'), { method: 'POST', body: JSON.stringify({ ...input, graph }) }); await refresh(); selectFlow(result.id || result.flow?.id); }
    if (type === 'flow-json') { const graph = validateFlowEditorGraph(JSON.parse(input.graph)); if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.nodes.length || graph.nodes.some(node => !node.id || !flowTypes[node.type]) || graph.edges.some(edge => !graph.nodes.some(node => node.id === edge.from) || !graph.nodes.some(node => node.id === edge.to))) throw new Error(t('Confira os IDs, os tipos dos passos e as conexões.')); state.flowDraft = graph; state.flowNode = graph.nodes[0].id; state.flowDirty = true; state.flowResult = null; }
    if (type === 'conversation-flow') {
      if(!canManageAttendance(currentConversation()))throw Error(t('Somente o responsável ou a gestão pode aplicar um fluxo.'));
      const conversation = state.tenant.conversations.find(item => item.id === state.conversation), flow = state.flows.find(item => item.id === input.flowId), pending = { flowId: flow.id, flowVersion: flow.publishedVersion, conversationId: conversation.id, conversationVersion: conversation.version, text: conversation.messages.filter(message => message.kind !== 'human' && message.kind !== 'system').at(-1)?.text || '' };
      const result = await api(tenantApi(`flows/${flow.id}/simulate`), { method: 'POST', body: JSON.stringify(pending) }); state.pendingFlowApplication = pending; $('#modal').close(); openModal(t('Resultado da rota'), txt`${flow.name} · versão publicada ${flow.publishedVersion}`, html`<div class="dialog-detail"><p>${escape(result.steps?.map(step => flowTypes[step.type]).join(' → '))}</p><div class="flow-result"><dl><dt>Departamento</dt><dd>${escape(result.output?.department || conversation.department)}</dd><dt>Responsável</dt><dd>${escape({ human: t('Atendente'), queue: t('Fila'), agent: t('Agente') }[result.output?.owner] || conversation.owner)}</dd><dt>Etiquetas</dt><dd>${escape(result.output?.tags?.join(', ') || t('Nenhuma'))}</dd></dl></div><p>Aplicar atualiza apenas o contexto desta conversa. Nenhuma mensagem será enviada.</p><div class="modal-actions"><button class="button" data-close-modal>Cancelar</button><button class="button primary" data-action="apply-conversation-flow">Aplicar resultado</button></div></div>`); return;
    }
    if (type === 'conversation') { const conversation = await api(tenantApi('conversations'), { method: 'POST', body: JSON.stringify(input) }); await refresh(); state.conversation = conversation.id; state.search = ''; state.channel = 'all'; state.lensWorkspace = state.workspaceId; state.filter = 'all'; }
    if (type === 'telegram') { await api(tenantApi(`channels/${input.channelId}/connect`), { method: 'POST', body: JSON.stringify({ token: input.token || undefined }) }); form.reset(); await refresh(); }
    if (type === 'telegram-profile') { await api(tenantApi(`channels/${input.channelId}/profile`), { method: 'POST', body: JSON.stringify(input) }); await refresh(); }
    $('#modal').close(); render(); toast(type === 'conversation' ? t('Conversa aberta. Escreva sua mensagem para enviar no WhatsApp.') : type === 'flow-json' ? t('Estrutura carregada. Salve o rascunho para validar.') : t('Configuração salva.'));
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
/*@end:modal-submit*/
/*@anchor:route-sync*/
// Routes (router.js grammar, nav-config.js views). hashchange keeps the guards of the old handler
// (sending, recording, pending send) and the same view switch; a deep link #inbox/<t>/<c> goes
// through selectInboxConversation (same authorization and draft guards as a click in the list) and
// ?w= of another workspace asks before switching (changeWorkspace keeps its own guards).
function routeView(route){const view=viewForRoute(route);return view&&views[view]?view:null;}
// Filters carried by an inbox link (#inbox?kind=group, the #groups alias, ?lens=, ?unread=1, ?q=,
// ?tenant=). Returns true when they changed the list.
function applyInboxRouteQuery(route){
  const epoch=state.inboxRouteEpoch=(state.inboxRouteEpoch||0)+1;
  if(!route){let section;try{section=decodeURIComponent(location.hash.slice(1).split(/[/?]/)[0]);}catch{}if(['inbox','groups'].includes(section))throw Object.assign(Error('INBOX_ROUTE_QUERY'),{code:'INBOX_ROUTE_QUERY'});return false;}
  if(route.section!=='inbox'||route.params?.conversationId)return false;
  const workspaceId=state.workspaceId,boot=state.boot,authority=inboxContactAuthority(),hash=location.hash;
  if(route.workspaceId&&route.workspaceId!==workspaceId)throw Object.assign(Error('INBOX_ROUTE_WORKSPACE'),{code:'INBOX_ROUTE_WORKSPACE'});
  if(!hasPermission('inbox.read'))throw Object.assign(Error('INBOX_ROUTE_ACCESS'),{code:'INBOX_ROUTE_ACCESS'});
  const raw=new URLSearchParams(hash.includes('?')?hash.slice(hash.indexOf('?')+1):'');
  for(const name of ['tenant','channel','department','assignedUser','status','sort'])if(raw.has(name)&&(raw.getAll(name).length!==1||raw.get(name)!==route.query?.[name]))throw Object.assign(Error('INBOX_ROUTE_ID'),{code:'INBOX_ROUTE_ID'});
  const catalog={workspaceId,tenants:boot.tenants||[],channels:[]};
  const scope={workspaceId,defaultLens:defaultLens(boot.session)};
  inboxRouteFilters({...route,query:{...route.query,channel:undefined,department:undefined,assignedUser:undefined}},catalog,scope);
  const commit=rows=>{
    const next=inboxRouteFilters(route,rows,scope),changed=Object.entries(next).some(([name,value])=>state[name]!==value);
    clearTimeout(state.inboxSearchTimer);consolidatedInbox.cancelLoad();state.lensWorkspace=workspaceId;Object.assign(state,next);consolidatedInbox.setLimit(INBOX_PAGE);return changed;
  };
  // Ordinary routes remain synchronous: an unconditional await would weaken immediate ABA invalidation.
  if(!route.query?.channel&&!route.query?.assignedUser&&(!route.query?.department||route.query.department==='unassigned'))return commit(catalog);
  const query=new URLSearchParams({limit:'1'});if(route.query.tenant)query.set('tenantId',route.query.tenant);
  const assertCurrent=()=>{if(epoch!==state.inboxRouteEpoch||workspaceId!==state.workspaceId||boot!==state.boot||authority!==inboxContactAuthority()||hash!==location.hash)throw Object.assign(Error('INBOX_ROUTE_STALE'),{code:'INBOX_ROUTE_STALE'});};
  return api('/api/inbox?'+query).then(rows=>{assertCurrent();return commit(rows);},error=>{assertCurrent();throw error;});
}
function rejectInboxRoute(error){
  if(error?.code==='INBOX_ROUTE_STALE')return;
  history.replaceState(history.state,'',currentRouteHash());navigate('overview');
  toast(t(error?.status>=500||!error?.code||error?.code==='INBOX_ROUTE_CATALOG_UNAVAILABLE'?'Não foi possível conferir o canal deste link. Tente abrir novamente.':'Este canal ou empresa não está no seu acesso atual.'),true);
}
// A delegated screen (#agents → #agents/tools, #pending → #pending/approval/<id>) re-renders when the
// hash moves inside it; legacy views never record a route, so they keep today's behaviour.
function screenRouteChanged(route,view){const seen=state.screenRoutes?.[view];return seen!==undefined&&seen!==JSON.stringify([route?.section||null,route?.params||{}]);}
const routeIntentKey=()=>JSON.stringify([state.workspaceId,state.supportGrantId||null,state.boot?.session.userId]);
function confirmRouteWorkspace(route){
  const target=(state.boot.workspaces||[]).filter(item=>item.id===route.workspaceId).sort((a,b)=>Number(Boolean(a.supportGrantId))-Number(Boolean(b.supportGrantId)))[0];
  if(!target){state.routeIntent=null;history.replaceState(history.state,'',modalRouteLifecycle.originRoute(currentRouteHash()));toast(t('Este link é de um workspace que não está disponível para você.'),true);return;}
  if(!modalRouteLifecycle.canLeave()){history.replaceState(history.state,'',modalRouteLifecycle.originRoute(currentRouteHash()));return;}
  modalRouteLifecycle.close();
  state.routeIntent={route,workspaceId:target.id,grantId:target.supportGrantId||null,key:routeIntentKey()};
  openModal(t('Abrir link de outro workspace'),target.name,h`<p>Este link é do workspace ${target.name}. Trocar de workspace?</p><div class="modal-actions"><button type="button" class="button" data-close-modal>Ficar aqui</button><button type="button" class="button primary" data-action="route-workspace-switch">Trocar</button></div>`);
}
async function switchRouteWorkspace(){
  const intent=state.routeIntent;state.routeIntent=null;$('#modal').close();
  if(!intent||intent.key!==routeIntentKey())return;
  await changeWorkspace(intent.workspaceId,intent.grantId);
  if(state.workspaceId===intent.workspaceId&&(state.supportGrantId||null)===intent.grantId)await applyRoute(intent.route);
  else history.replaceState(history.state,'',currentRouteHash());
}
async function openRouteConversation(route){
  const {tenantId,conversationId}=route?.section==='inbox'?route.params:{};
  if(!tenantId||!conversationId||state.view!=='inbox'||inboxIdentity(selectedInboxRef())===inboxIdentity({workspaceId:state.workspaceId,tenantId,conversationId}))return;
  if(!state.boot.tenants.some(item=>item.id===tenantId)){history.replaceState(history.state,'',currentRouteHash());toast(t('Você não tem acesso a esta conversa.'),true);return;}
  await selectInboxConversation(tenantId,conversationId);
  if(state.view==='inbox'&&state.conversation!==conversationId)history.replaceState(history.state,'',currentRouteHash());
}
async function applyRoute(route){
  const view=routeView(route);
  if(view&&(view!==state.view||screenRouteChanged(route,view))&&!modalRouteLifecycle.canLeave()){history.replaceState(history.state,'',modalRouteLifecycle.originRoute(currentRouteHash()));return;}
  let filtered=false;try{const result=applyInboxRouteQuery(route);filtered=result&&typeof result.then==='function'?await result:result;}catch(error){rejectInboxRoute(error);return;}
  if(filtered&&view===state.view&&view==='inbox')refreshInboxList().catch(error=>toast(error.message,true));
  if(view&&view!==state.view){
    contactLinksUI.reset();platformUsersUI.reset();commercialUsageUI.reset();groupsWorkspaceUI.reset();contactRefresh.reset();memoryUI.reset();if(state.view==='team-chat')teamChatUI.reset();state.menuOpen=false;state.view = view;
    // A screen drawn inside a View Transition (swapScreen) comes after this function returns: the guard
    // of render() may land on another view, and only then the hash can follow it.
    let deferred=false;
    const show=()=>{render();focusViewContent();if(view==='contacts')contactRefresh.refresh({force:true});if(['overview','support','service-agents','platform-users','connected-products','billing','platform-billing','platform','accounts','automation','knowledge'].includes(view))loadNavigatedPanels(view);if(view==='inbox')refreshInboxList().catch(error=>toast(error.message,true));if(deferred&&view!==state.view)history.replaceState(history.state,'',currentRouteHash());};
    deferred=swapScreen(show);
  }
  else if(view&&screenRouteChanged(route,view)){state.menuOpen=false;render();}
  if(view&&(route.alias||view!==state.view))history.replaceState(history.state,'',currentRouteHash());
  await openRouteConversation(route);
}
function routeChanged(){
  state.inboxRouteEpoch=(state.inboxRouteEpoch||0)+1;
  const route=parseHash(location.hash),view=routeView(route);
  if(!state.boot){if(view)state.view=view;return;}
  if (mediaUI.sending||voiceRecorder.busy||view&&view!==state.view&&blockPendingSend()) { location.hash = modalRouteLifecycle.originRoute(currentRouteHash()); return; }
  if(route?.workspaceId&&route.workspaceId!==state.workspaceId){confirmRouteWorkspace(route);return;}
  if(route)return applyRoute(route);
  try{applyInboxRouteQuery(route);}catch(error){rejectInboxRoute(error);}
}
async function startRoute(route){
  state.inboxRouteEpoch=(state.inboxRouteEpoch||0)+1;
  if(!route){try{applyInboxRouteQuery(route);}catch(error){rejectInboxRoute(error);}return;}
  if(route.workspaceId&&route.workspaceId!==state.workspaceId){confirmRouteWorkspace(route);return;}
  let filtered=false;try{const result=applyInboxRouteQuery(route);filtered=result&&typeof result.then==='function'?await result:result;}catch(error){rejectInboxRoute(error);return;}
  if(filtered&&state.view==='inbox'){render();refreshInboxList().catch(error=>toast(error.message,true));}
  if(route.alias||routeView(route)!==state.view)history.replaceState(history.state,'',currentRouteHash());
  await openRouteConversation(route);
}
window.addEventListener('hashchange', routeChanged);
$('#modal').addEventListener('close',()=>{if(!$('#modal').open&&state.routeIntent){state.routeIntent=null;history.replaceState(history.state,'',currentRouteHash());}});
/*@end:route-sync*/
window.addEventListener('pagehide', () => {telegramAccountUI.reset();mediaUI.reset();});
// Crossing 900 px closes the drawer (and its inert state follows the new size); 1280/1600 px change the rail.
matchMedia(SHELL_MOBILE_QUERY).addEventListener('change', event => { shellUI.close(); state.menuOpen = setShellDrawer(document, false, { mobile: event.matches }); syncShellLayout(); });
for (const query of [SHELL_WIDE_QUERY, SHELL_XWIDE_QUERY]) matchMedia(query).addEventListener('change', syncShellLayout);

/*@anchor:start*/
async function start() {
  if(state.starting)return false;
  state.starting=true;
  try {
    const route=parseHash(location.hash),initial=viewForRoute(route);
    state.view=views[initial]?initial:'overview';
    if(!await refresh(undefined,{skipOverviewPanels:true}))return false;if(!location.hash&&state.boot.session.platformOwner)state.view='platform';render();state.workspaceReady=true;if(['overview','platform','accounts'].includes(state.view))await loadViewPanels();
    await startRoute(route).catch(error=>toast(error.message,true));
    /*@subscription:return*/if(typeof handleSubscriptionReturn==='function'&&typeof location.search==='string'&&location.search)await handleSubscriptionReturn();/*@subscription:return:end*/
    return true;
  } catch (error) { if(error.status===401)return false;$('#app').innerHTML = html`<div class="startup-error" role="alert"><h1>Não foi possível abrir o workspace.</h1><p>${escape(error.message)}</p><p>Não foi possível concluir o carregamento. Confira a conexão e tente novamente.</p><button type="button" class="button primary" data-action="startup:retry">Tentar novamente</button></div>`;return false; }
  finally{state.starting=false;}
}
/*@end:start*/
start();

/*@anchor:connection-timer*/
let connectionTimer;
async function connectChannel(channelId) {
  clearTimeout(connectionTimer);
  const path = tenantApi(`channels/${channelId}`);
  openModal(t('Conectar número de teste'), t('No WhatsApp do número cadastrado: Configurações → Aparelhos conectados → Conectar aparelho.'), markup('<div id="connection-panel" class="connection-panel"><p>Preparando o pareamento…</p></div>'));
  const modal = $('#modal'); modal.dataset.connectionChannel = channelId;
  try { await api(path + '/connect', { method: 'POST', body: '{}' }); }
  catch (error) { $('#connection-panel').textContent = error.message; return; }
  async function poll() {
    if (!modal.open || modal.dataset.connectionChannel !== channelId) return;
    try {
      const status = await api(path + '/connection');
      $('#connection-panel').innerHTML = html`<div class="connection-state">${badge(connectionStateNames[status.state] || status.state, status.state === 'connected' ? 'green' : 'blue')}<strong>${escape(displayChannelLabel(status))}</strong></div>${status.qr ? html`<img class="pairing-qr" src="${status.qr}" alt="QR real de pareamento do WhatsApp"/><p>Escaneie com o WhatsApp do número de teste. O QR se renova automaticamente.</p>` : status.state === 'connected' ? html`<div class="connected-symbol">${icon('check')}</div><h3>Número conectado e conferido.</h3><p>Envie uma mensagem de teste para este número a partir de outro WhatsApp e abra Atendimento.</p><button class="button primary" id="connection-inbox">Abrir atendimento</button>` : html`<div class="pairing-wait">${icon('refresh')}</div><p>${escape(status.error || t('Aguardando o WhatsApp preparar a conexão…'))}</p>`}`;
      if (status.state === 'connected') { await refresh(); render(); $('#connection-inbox').addEventListener('click', () => { modal.close(); navigate('inbox'); }); return; }
      if (['failed', 'wrong_number', 'logged_out', 'disconnected'].includes(status.state)) { await refresh(); render(); return; }
      connectionTimer = setTimeout(poll, 2000);
    } catch (error) { if ($('#connection-panel')) $('#connection-panel').textContent = error.message; }
  }
  await poll();
}
/*@end:connection-timer*/
$('#modal').addEventListener('close', () => { if(!$('#modal').open){telegramAccountUI.reset();telegramGroupsUI.reset();accountInvitationsUI.reset();state.accountAccessIntent=null;}clearTimeout(connectionTimer); delete $('#modal').dataset.connectionChannel; });
$('#modal').addEventListener('close',()=>{if(!$('#modal').open){forwarding.close();participantsUI.dismiss();}});
async function connectTelegram(channelId) {
  const status = await api(tenantApi(`channels/${channelId}/connection`));
  if (status.state === 'connected') {
    openModal(t('Telegram conectado'), status.label, html`<div class="dialog-detail">${badge(t('Conectado'), 'green')}<p>Abra o bot no Telegram e envie /start para iniciar o atendimento. Para grupos, adicione este bot ao grupo.</p><p>${status.groupReadMode === 'all' ? t('O bot está configurado para receber todas as mensagens de grupos.') : t('Privacidade ativa: recebe mensagens dirigidas ao bot. Para atendimento completo do grupo, ajuste /setprivacy no BotFather e readicione o bot.')}</p><button class="button primary" data-close-modal>Entendido</button></div>`);
    return;
  }
  formModal(t('Conectar Telegram'), t('Crie um bot exclusivo para esta empresa e cadastre a chave aqui.'), 'telegram', html`<div class="bot-onboarding"><a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">Abrir BotFather ${icon('arrow')}</a><ol><li>Envie /newbot no BotFather.</li><li>Escolha o nome e um username terminado em bot.</li><li>Copie o token e cole no campo abaixo.</li></ol><p>Depois de conectar, envie /start ao bot ou adicione-o a um grupo.</p></div><input type="hidden" name="channelId" value="${escape(channelId)}"/><label>Token do BotFather<input type="password" name="token" maxlength="100" autocomplete="new-password" spellcheck="false" placeholder="Cole o token aqui"/><small>Guardado cifrado. Deixe vazio somente para retomar um bot já cadastrado.</small></label>`, t('Conectar bot'));
}
/*@anchor:channel-groups*/
async function channelGroups(channelId) {
  return whatsappGroupsUI.open(channelId);
}
/*@end:channel-groups*/
/*@anchor:whatsapp-groups-ui*/
function createWhatsAppGroupsUI({state,api,escape,openModal,toast,getModal,onUpdate}) {
  let view=null,sequence=0,readSequence=0,controller=null;
  const identity=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=120&&!/\p{Cc}/u.test(value);
  const groupId=value=>typeof value==='string'&&/^\d+(?:-\d+)?@g\.us$/.test(value);
  const context=()=>{const s=state.boot?.session||{};return {workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:s.userId,csrf:state.boot?.csrfToken||s.csrfToken||'',role:s.role,kind:s.kind,support:state.supportGrantId||s.supportGrantId||null,permissions:s.permissions,scopeRules:s.scopeRules,platformOwner:s.platformOwner,platformAdmin:s.platformAdmin,resellerId:s.resellerId,route:state.view,tenants:(state.boot?.tenants||[]).map(t=>t.id),workspaces:(state.boot?.workspaces||[]).map(w=>[w.id,w.supportGrantId||null])};};
  const key=()=>JSON.stringify(context());
  const allowed=()=>{const c=context();return identity(c.workspaceId)&&identity(c.tenantId)&&identity(c.userId)&&c.role==='reseller'&&!c.support&&c.kind!=='service'&&(state.boot?.tenants||[]).some(tenant=>tenant.id===c.tenantId)&&(!state.tenant?.resellerId||state.tenant.resellerId===c.workspaceId);};
  const channel=record=>state.tenant?.channels?.find(item=>item.id===record?.channelId&&item.kind==='whatsapp_qr'&&item.transport==='baileys'&&item.state==='connected');
  const current=record=>Boolean(record&&view===record&&record.ticket===sequence&&allowed()&&record.key===key()&&channel(record));
  const owns=record=>Boolean(record&&getModal()===record.modal&&record.modal.open&&record.modal.firstElementChild===record.content&&record.modal.querySelector('[data-whatsapp-groups-panel]')===record.panel);
  const shown=record=>current(record)&&owns(record);
  const editor=record=>shown(record)&&record.form?.isConnected&&record.modal.querySelector('[data-dialog-form="groups"]')===record.form;
  const headers=record=>({'X-Elozi-Workspace':record.workspaceId,...(record.csrf?{'X-CSRF-Token':record.csrf}:{})});
  const endpoint=record=>`/api/tenants/${encodeURIComponent(record.tenantId)}/channels/${encodeURIComponent(record.channelId)}/groups`;
  const feedback=(record,message)=>{if(shown(record))record.panel.querySelector('.form-error').textContent=message;};
  const disable=(record,value)=>{if(editor(record))record.form.querySelector('[type="submit"]').disabled=value;};
  const lockSelection=(record,value)=>{if(editor(record))for(const control of record.form.querySelectorAll('input[type="checkbox"]'))control.disabled=value;};
  function reset(){controller?.abort();controller=null;view=null;sequence++;readSequence++;}
  getModal().addEventListener('close',()=>{if(!getModal().open)reset();});
  function show(record,markup){
    if(!current(record))return;
    openModal(t('Grupos do WhatsApp'),t('Selecione os grupos que entram no atendimento. Novas mensagens aparecerão na inbox com seus autores.'),html`<section data-whatsapp-groups-panel>${markup}</section>`);
    record.modal=getModal();record.content=record.modal.firstElementChild;record.panel=record.modal.querySelector('[data-whatsapp-groups-panel]');record.form=record.modal.querySelector('[data-dialog-form="groups"]');
  }
  function dto(result,record){
    if(!result||result.tenantId!==record.tenantId||result.channelId!==record.channelId||!Number.isSafeInteger(result.version)||result.version<0||result.version>=Number.MAX_SAFE_INTEGER||!Array.isArray(result.groups))throw Error(t('O servidor não confirmou os grupos deste canal.'));
    const groups=result.groups.map(group=>{if(!group||!groupId(group.id)||typeof group.name!=='string'||typeof group.selected!=='boolean'||typeof group.announcement!=='boolean')throw Error(t('O servidor não confirmou os grupos deste canal.'));return {id:group.id,name:group.name,selected:group.selected,announcement:group.announcement};});
    if(new Set(groups.map(group=>group.id)).size!==groups.length)throw Error(t('O servidor não confirmou os grupos deste canal.'));
    return {version:result.version,groups};
  }
  const refreshButton=record=>html`<button class="button" type="button" data-whatsapp-groups-action="refresh" data-whatsapp-groups-ticket="${record.ticket}">Atualizar grupos</button>`;
  function picker(groups,selected,available){return groups.map(group=>html`<label class="checkbox-label"><input type="checkbox" name="groupId" value="${escape(group.id)}" ${selected.has(group.id)?'checked':''}/><span>${escape(group.name)}${available&&!available.has(group.id)?markup('<small>Grupo não confirmado nesta revisão. Desmarque para salvar.</small>'):group.announcement?markup('<small>Somente administradores podem publicar.</small>'):''}</span></label>`).join('')||markup('<p>Este número ainda não participa de grupos. Adicione-o ao grupo de teste pelo WhatsApp e volte aqui.</p>');}
  function mount(record,value){
    record.version=value.version;record.groups=value.groups;record.available=new Set(value.groups.map(group=>group.id));record.reviewRequired=false;
    show(record,html`<form data-dialog-form="groups"><input type="hidden" name="channelId" value="${escape(record.channelId)}"/><input type="hidden" name="version" value="${value.version}"/><p data-whatsapp-groups-version>Revisão ${value.version}</p><div class="group-picker">${picker(value.groups,new Set(value.groups.filter(group=>group.selected).map(group=>group.id)))}</div><p class="group-help">Desmarcar interrompe novas entradas e respostas pelo painel. O histórico já recebido permanece. Até 100 grupos por seleção.</p><div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-close-modal>Cancelar</button>${refreshButton(record)}<button type="submit" class="button primary">${escape(t('Salvar grupos'))}</button></div></form>`);
  }
  async function read(record,{preserve=false}={}){
    if(!shown(record)||record.writing)return false;
    controller?.abort();controller=new AbortController();const ticket=++readSequence,signal=controller.signal;
    record.reading=true;disable(record,true);
    try{
      const result=await api(endpoint(record),{method:'GET',headers:headers(record),signal});
      if(!shown(record)||ticket!==readSequence)return false;
      const value=dto(result,record);
      if(!preserve)mount(record,value);
      else if(editor(record)){
        const selected=new Set(new FormData(record.form).getAll('groupId'));
        const available=new Set(value.groups.map(group=>group.id)),removed=record.groups.filter(group=>selected.has(group.id)&&!available.has(group.id));
        record.version=value.version;record.groups=[...value.groups,...removed];record.available=available;record.reviewRequired=false;
        record.form.querySelector('[name="version"]').value=String(value.version);
        record.form.querySelector('[data-whatsapp-groups-version]').textContent=txt`Revisão ${value.version}`;
        record.form.querySelector('.group-picker').innerHTML=picker(record.groups,selected,available);
        feedback(record,t('Revisão atual consultada. Seu rascunho foi mantido; confira os grupos antes de salvar.'));
      }
      return true;
    }catch(error){if(shown(record)&&ticket===readSequence&&error.name!=='AbortError')feedback(record,error.message);return false;}
    finally{if(ticket===readSequence){record.reading=false;disable(record,Boolean(record.reviewRequired));}}
  }
  async function open(channelId){
    if(!allowed()||!identity(channelId)||!channel({channelId})){toast(t('Abra os grupos pelo administrador desta empresa e por um WhatsApp conectado.'),true);return false;}
    if(state.busy){toast(t('Aguarde a operação atual antes de abrir os grupos.'),true);return false;}
    reset();const c=context(),record={...c,channelId,key:key(),ticket:sequence,writing:false,reading:false};view=record;
    show(record,html`<p role="status">Consultando grupos deste número…</p><div class="form-error" role="alert"></div>${refreshButton(record)}`);
    return read(record);
  }
  async function action(node){
    const record=view;
    if(node?.dataset.whatsappGroupsAction!=='refresh')return false;
    if(!shown(record)||String(record.ticket)!==node.dataset.whatsappGroupsTicket||!record.panel.contains(node))return true;
    if(record.writing){feedback(record,t('Aguarde a confirmação da seleção atual.'));return true;}
    await read(record,{preserve:Boolean(record.form)});return true;
  }
  async function submit(form){
    const record=view;
    if(!editor(record)||form!==record.form)return true;
    if(record.writing||record.reading)return true;
    if(state.busy){feedback(record,t('Aguarde a operação atual antes de salvar os grupos.'));return true;}
    if(record.reviewRequired){feedback(record,t('Atualize os grupos e confira o rascunho antes de salvar novamente.'));return true;}
    try{
      const input=new FormData(form),groupIds=input.getAll('groupId');
      if(input.get('channelId')!==record.channelId||input.get('version')!==String(record.version)||groupIds.length>100||new Set(groupIds).size!==groupIds.length||groupIds.some(id=>!record.available.has(id)))throw Error(t('Confira o canal, a revisão e até 100 grupos conhecidos desta seleção.'));
      const version=record.version;record.writing=true;disable(record,true);lockSelection(record,true);feedback(record,'');
      const result=await api(endpoint(record),{method:'POST',headers:headers(record),body:JSON.stringify({version,groupIds})});
      if(!editor(record)||form!==record.form)return true;
      if(!result||result.tenantId!==record.tenantId||result.channelId!==record.channelId||result.version!==version+1||result.enabledGroups!==groupIds.length){record.reviewRequired=true;throw Error(t('O servidor não confirmou esta seleção. Atualize os grupos antes de tentar novamente.'));}
      onUpdate(result);
      if(editor(record)){record.modal.close();toast(t('Grupos de atendimento atualizados.'));}
    }catch(error){if(editor(record)&&form===record.form){if(error.status===409){record.reviewRequired=true;feedback(record,t('A seleção mudou no servidor. Seu rascunho foi mantido; atualize os grupos e confira antes de salvar.'));}else feedback(record,error.message);}}
    finally{record.writing=false;lockSelection(record,false);disable(record,Boolean(record.reviewRequired));}
    return true;
  }
  return {open,action,submit,reset};
}
/*@end:whatsapp-groups-ui*/
/*@anchor:live-tasks*/
// Client scheduler (live.js, P2). P1 keeps the three 5 s timers of before as its tasks; attention is the
// pulse that P2 schedules (no request in P1).
live=createLive({attention,tasks:[
  {name:'inbox',every:5000,run:pollInbox},
  {name:'contacts',every:5000,run:()=>contactRefresh.refresh()},
  {name:'team-chat',every:5000,run:()=>{if(state.view==='team-chat'&&!state.busy)teamChatUI.poll().catch(error=>toast(error.message,true));}}
]});
live.start();
/*@end:live-tasks*/

// ---------------------------------------------------------------------------------------------
// Atendimento v2 (FRONTEND-V2 §5.2, P3): opening a conversation, the context panel, the list
// actions of the registry (inbox:*), the list keys and the single-key shortcuts of the screen.

// Enter, o or a click opens the conversation and only then marks it as read. Marking as read bumps the
// conversation version on the server, so it waits while an agent run is active or a draft of the
// current version is ready (a read receipt never makes an agent's work stale).
async function openInboxConversation(tenantId,conversationId){
  const conversation=await selectInboxConversation(tenantId,conversationId);
  const opened=conversation&&state.view==='inbox'&&state.tenant?.id===tenantId&&state.conversation===conversationId;
  // render() redraws #app: the focus the row had goes to the conversation (Esc goes back to the list).
  if(opened&&(!document.activeElement||document.activeElement===document.body))$('#messages')?.focus({preventScroll:true});
  return conversation;
}
/*@anchor:inbox-read-receipts*/
const inboxReadAttempts=new Map();
function inboxReadKey(c){return JSON.stringify([state.boot?.session?.userId,state.workspaceId,state.supportGrantId||null,state.tenant?.id,c?.channelId,c?.id]);}
function inboxReadAnchor(c){const messages=c?.messages||[];return messages.findLast(message=>message.kind==='customer')?.id||messages.at(-1)?.id||String(c?.version);}
function preserveInboxUnread(c){
  const key=inboxReadKey(c),previous=inboxReadAttempts.get(key);
  if(previous){previous.anchor=inboxReadAnchor(c);return;}
  if(inboxReadAttempts.size>=100){const removable=[...inboxReadAttempts].find(([,value])=>!value.pending);if(removable)inboxReadAttempts.delete(removable[0]);}
  inboxReadAttempts.set(key,{anchor:inboxReadAnchor(c),pending:false});
}
// Only the responsible marks on opening. The unread count belongs to the whole conversation and the
// server moves it (version and updatedAt), so a look by an admin, an observer, a collaborator, someone
// from the queue or a support session never clears it for the person who answers ("Marcar como lida"
// stays available to them).
async function markConversationRead(c,{opened=true}={}){
  if(!c||state.view!=='inbox'||state.conversation!==c.id||currentConversation()?.channelId!==c.channelId||!(Number(c.unread)>0)||!hasPermission('inbox.read')||state.busy||state.inboxSelecting||mediaUI.sending||voiceRecorder.busy||state.sendIntent||state.supportGrantId||document.visibilityState==='hidden'||attendanceRole(c)!=='responsible')return false;
  if(!opened){const timeline=$('#messages');if(!timeline||!(timeline.clientHeight>0)||timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop>=90)return false;}
  const holding=(state.tenant?.runs||[]).some(run=>run.conversationId===c.id&&(activeRunStates.has(run.state)||run.state==='draft'&&run.conversationVersion===c.version));
  if(holding)return false;
  const key=inboxReadKey(c),anchor=inboxReadAnchor(c),previous=inboxReadAttempts.get(key);
  if(previous?.pending||!opened&&previous?.anchor===anchor)return false;
  if(!inboxReadAttempts.has(key)&&inboxReadAttempts.size>=100){const removable=[...inboxReadAttempts].find(([,value])=>!value.pending);if(!removable)return false;inboxReadAttempts.delete(removable[0]);}
  const attempt={anchor,pending:true};inboxReadAttempts.set(key,attempt);
  try{const context=captureAttendance(),result=await attendanceRequest(context,'read-state',{method:'POST',body:JSON.stringify(readStateCommand(c,context.version,false,readDeviceContext()))});applyAttendance(result);live?.kick('attention');if(result.readSync?.state==='pending')toast(readSyncNotice(result),true);return true;}
  catch{return false;}// The next poll shows the real state; a failed read receipt is not an error of the person.
  finally{attempt.pending=false;}
}
function handleInboxReadScroll(event){if(event.target===$('#messages'))void markConversationRead(currentConversation(),{opened:false});}
document.addEventListener('scroll',handleInboxReadScroll,{capture:true,passive:true});
/*@end:inbox-read-receipts*/
// Context panel: beside the conversation from 900 px (three panels from 1280), or a sheet below.
function setContextOpen(open,{focus=true}={}){
  state.contextCollapsed=!open;
  const workspace=$('.pg-inbox'),shown=Boolean(open&&currentConversation());
  if(workspace)workspace.dataset.context=shown?'open':'closed';
  const scrim=$('.pg-inbox__scrim');if(scrim)scrim.hidden=!shown;
  const label=shown?t('Recolher contexto do atendimento'):t('Mostrar contexto do atendimento');
  for(const toggle of document.querySelectorAll('.pg-inbox__context-toggle')){toggle.setAttribute('aria-expanded',String(shown));toggle.setAttribute('aria-label',label);toggle.title=label;}
  const active=document.activeElement;
  syncContextSheet();
  if(shown&&focus&&!matchMedia('(min-width: 1280px)').matches)$('#conversation-context [role="tab"][aria-selected="true"]')?.focus({preventScroll:true});
  else if(!shown&&($('#conversation-context')?.contains(active)||active?.matches?.('.pg-inbox__scrim')))$('.pg-inbox__context-toggle')?.focus({preventScroll:true});
}
// Below 900 px the open context is a modal sheet: a dialog with aria-modal, and the rest of #app
// (list, conversation, shell bars) is inert until it closes; the scrim stays clickable to close it.
// From 900 px it is a non-modal column beside the conversation, and nothing is inert.
function syncContextSheet(){
  for(const node of document.querySelectorAll('[data-sheet-inert]')){node.removeAttribute('inert');node.removeAttribute('data-sheet-inert');}
  const workspace=$('.pg-inbox'),panel=$('#conversation-context');if(!panel)return;
  const sheet=state.view==='inbox'&&workspace?.dataset.context==='open'&&matchMedia('(max-width: 899.98px)').matches;
  if(!sheet){panel.removeAttribute('role');panel.removeAttribute('aria-modal');return;}
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
  for(let node=panel;node?.parentElement&&node.id!=='app';node=node.parentElement){
    for(const sibling of node.parentElement.children)if(sibling!==node&&!sibling.matches('.pg-inbox__scrim')&&!sibling.hasAttribute('inert')){sibling.setAttribute('inert','');sibling.setAttribute('data-sheet-inert','');}
  }
}
matchMedia('(max-width: 899.98px)').addEventListener('change',()=>{if(state.view==='inbox')syncContextSheet();});
// A full render() redraws #app (an open sheet comes back without its modal state): sync it right after.
if(typeof MutationObserver==='function')new MutationObserver(()=>{if(state.view==='inbox')syncContextSheet();}).observe($('#app'),{childList:true});
function selectContextTab(tab,{chosen=false}={}){
  const c=currentConversation(),panel=$('#conversation-context');if(!c||!panel)return false;
  if(!panel.querySelector(`#context-tabs-panel-${CSS.escape(tab)}`))return false;
  if(chosen)state.contextTabChoice={conversationId:c.id,tab};panel.dataset.tab=tab;
  for(const button of panel.querySelectorAll('[role="tab"]')){const on=button.dataset.tab===tab;button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;}
  for(const section of panel.querySelectorAll('[role="tabpanel"]'))section.hidden=section.id!==`context-tabs-panel-${tab}`;
  if(tab==='group')bindGroupPanel();
  return true;
}
// The Grupo tab loads the group context only when it is open (groups-workspace-ui, panel mode).
function bindGroupPanel(){const node=$('#conversation-context [data-groups-workspace]');if(node&&!node.closest('[hidden]'))void groupsWorkspaceUI.bind(node).catch(()=>toast(t('Não foi possível abrir os grupos. Atualize a página e tente novamente.'),true));}
matchMedia('(min-width: 1280px)').addEventListener('change',event=>{if(state.view==='inbox')setContextOpen(event.matches);else state.contextCollapsed=!event.matches;});
// The conversation's header actions become a menu below 900 px (Assumir, Transferir, Encerrar…).
function setActionsMenu(open){const button=$('.pg-inbox__overflow'),menu=$('#conversation-actions');if(!button||!menu)return;button.setAttribute('aria-expanded',String(open));menu.toggleAttribute('data-open',open);if(open)menu.querySelector('button:not([disabled])')?.focus({preventScroll:true});}
document.addEventListener('click',event=>{const menu=$('#conversation-actions');if(menu?.hasAttribute('data-open')&&!event.target.closest?.('.pg-inbox__overflow')&&!event.target.closest?.('#conversation-actions'))setActionsMenu(false);});
// "Carregar mais" and the pages: the footer is not redrawn under the focus, so the focus moves to the
// first new row (or to the top of the new page) and the footer then catches up (range and buttons).
async function pageInbox(limit,offset,focusIndex){
  consolidatedInbox.setLimit(limit);await refreshInboxList({offset});
  const box=$('#conversation-items');if(!box||!$('[data-inbox-footer]')?.contains(document.activeElement))return;
  const rows=[...box.querySelectorAll('[role="option"]')];if(!focusIndex)box.scrollTop=0;
  (rows[focusIndex]||rows[rows.length-1])?.focus({preventScroll:!focusIndex});updateConsolidatedList();
}
async function setInboxLens(lens){if(!['all','mine','queue','agent'].includes(lens))return false;await changeInboxFilter('filter',lens);return true;}
async function becomeAvailable(){
  if(state.presenceSaving)return;state.presenceSaving=true;
  try{const result=await api('/api/auth/presence',{method:'PATCH',body:JSON.stringify({presence:'available'})});state.boot.session.presence=result.user.presence;state.account.user=result.user;setShellPresence(document,result.user.presence,state.boot.session.name);updateConsolidatedList();toast(t('Disponibilidade atualizada.'));}
  catch(error){toast(error.message,true);}finally{state.presenceSaving=false;}
}
/*@anchor:inbox-list-actions*/
registerActions({
  'inbox:apply-pending':()=>{inboxList.applyPending();},
  'inbox:load-more':()=>pageInbox(Math.min(INBOX_MAX_ROWS,(consolidatedInbox.data.items||[]).length+INBOX_PAGE),Number(consolidatedInbox.data.offset)||0,(consolidatedInbox.data.items||[]).length),
  // Past 200 loaded rows the list pages by 200 (the server limit), so no conversation is out of reach.
  'inbox:next-page':()=>pageInbox(INBOX_MAX_ROWS,(Number(consolidatedInbox.data.offset)||0)+INBOX_MAX_ROWS,0),
  'inbox:previous-page':()=>pageInbox(INBOX_MAX_ROWS,Math.max(0,(Number(consolidatedInbox.data.offset)||0)-INBOX_MAX_ROWS),0),
  'inbox:toggle-unread':async()=>{await changeInboxFilter('unread',!state.unread);},
  'inbox:toggle-pending':async()=>{await changeInboxFilter('status',state.status==='pending'?'active':'pending');},
  'inbox:channel':async({element})=>{const choice=inboxChoice(element?.dataset.inboxChannel);if(!choice||!consolidatedInbox.data.channels?.some(channel=>channel.tenantId===choice.tenantId&&channel.id===choice.id))return false;await changeInboxFilter('channel',JSON.stringify([choice.tenantId,choice.id]));return true;},
  'inbox:toggle-groups':async()=>{state.kindFromLink=false;await changeInboxFilter('kind',state.kind==='group'?'all':'group');history.replaceState(history.state,'',currentRouteHash());},
  'inbox:lens-queue':async()=>{await setInboxLens('queue');},
  'inbox:context-tab':({element})=>{if(element?.dataset.tab)selectContextTab(element.dataset.tab,{chosen:true});},
  // "Carregar anteriores" keeps its button while older messages remain (the focus stays on it); once
  // all are open the focus goes to the timeline itself (role=log, tabindex=0), never to <body>.
  'inbox:earlier':showInboxEarlier,
  'inbox:actions':()=>{setActionsMenu($('.pg-inbox__overflow')?.getAttribute('aria-expanded')!=='true');},
  'inbox:presence':({element})=>{shellUI.open('account',{trigger:element,focus:'input[name="shell-presence"]:checked'});},
  'inbox:available':()=>becomeAvailable()
});
/*@end:inbox-list-actions*/
// Keys of the list rows (active only while a row has the focus, WCAG 2.1.4): j/k ↓/↑ Home/End move
// the focus, Enter/o opens. Esc climbs one level: composer → conversation → list, never to <body>.
document.addEventListener('keydown',event=>{
  if(state.view!=='inbox')return;
  if(inboxList.keydown(event))return;
  if(event.key!=='Escape'||event.defaultPrevented||event.isComposing||document.querySelector('dialog[open]'))return;
  const target=event.target;
  if($('#conversation-actions')?.hasAttribute('data-open')){event.preventDefault();setActionsMenu(false);$('.pg-inbox__overflow')?.focus();return;}
  if(target?.closest?.('#conversation-context')&&!matchMedia('(min-width: 1280px)').matches){event.preventDefault();setContextOpen(false);return;}
  if(['message-text','internal-note-text'].includes(target?.id)){event.preventDefault();$('#messages')?.focus({preventScroll:true});return;}
  if(target?.closest?.('#chat-pane')){event.preventDefault();if(state.mobileChat&&matchMedia(SHELL_MOBILE_QUERY).matches){state.mobileChat=false;render();}inboxList.focusList();}
});
// Composer: the mode is a radio group (Responder ao cliente | Nota interna); "/" at the start opens the
// quick replies.
$('#app').addEventListener('change',event=>{if(event.target?.name==='composer-mode')setComposerMode(event.target.value);});
$('#app').addEventListener('input',event=>{
  if(event.target?.id!=='message-text'||event.target.value!=='/'||!canReplyTo(currentConversation()))return;
  event.target.value='';mediaUI.draft='';composerStatus();$('[data-reply-action="open"]:not([disabled])')?.click();
});
// §5.2.1: on a phone the composer follows visualViewport when the on-screen keyboard opens.
if(globalThis.visualViewport){const syncKeyboard=()=>{const inset=Math.max(0,Math.round(innerHeight-visualViewport.height-visualViewport.offsetTop));document.documentElement.style.setProperty('--pg-inbox-keyboard',`${inset}px`);};visualViewport.addEventListener('resize',syncKeyboard);visualViewport.addEventListener('scroll',syncKeyboard);}
// Single-key shortcuts of the screen (§2.6), dispatched by keyboard.js only outside editable fields
// and only while the person keeps them on (P2). Approval never has a key.
keyboard.registerScope('inbox',{
  '/':()=>{const field=$('#conversation-search');if(!field)return false;field.focus();field.select?.();return true;},
  '1':()=>setInboxLens('all'),'2':()=>setInboxLens('mine'),'3':()=>setInboxLens('queue'),'4':()=>setInboxLens('agent'),
  'u':()=>{void changeInboxFilter('unread',!state.unread);return true;},
  'j':()=>inboxList.focusList(),'k':()=>inboxList.focusList(),
  'r':()=>{if(!currentConversation())return false;setComposerMode('reply');return true;},
  'n':()=>{if(!currentConversation())return false;setComposerMode('note');return true;},
  'i':()=>{if(!currentConversation())return false;setContextOpen(state.contextCollapsed);return true;},
  'a':()=>{if(!canTakeOver(currentConversation()))return false;void act('takeover').catch(error=>toast(error.message,true));return true;},
  // ✦ of the composer and "Inserir" of the draft card (agent rail, P4); a hidden or disabled control does nothing.
  'c':()=>clickVisible('[data-action="rail:generate"], [data-action="run-agent"]'),
  'd':()=>clickVisible('[data-action="rail:insert-draft"]')
});
function clickVisible(selector){const node=[...document.querySelectorAll(selector)].find(item=>!item.disabled&&item.getAttribute('aria-disabled')!=='true'&&!item.closest('[hidden],[inert]')&&item.getClientRects().length);if(!node)return false;node.click();return true;}

function chooseInboxFile(file){
 const conversation=state.tenant?.conversations.find(item=>item.id===state.conversation);
 if(!file||!canReplyTo(conversation)||!supportsMedia(conversation)||state.busy||voiceRecorder.busy||mediaUI.sending)return;
 if(mediaUI.selected){toast(t('Remova o anexo atual antes de adicionar outro.'),true);return;}
 mediaUI.choose(file,$('#message-text')?.value||'');render();$('#message-text')?.focus();
}
$('#app').addEventListener('dragover',event=>{const form=event.target.closest('#message-form');if(form&&event.dataTransfer?.types.includes('Files')){event.preventDefault();form.classList.add('file-dragover');}});
$('#app').addEventListener('dragleave',event=>event.target.closest('#message-form')?.classList.remove('file-dragover'));
$('#app').addEventListener('drop',event=>{const form=event.target.closest('#message-form');if(!form||!event.dataTransfer?.files.length)return;event.preventDefault();form.classList.remove('file-dragover');if(event.dataTransfer.files.length!==1){toast(t('Escolha um arquivo por envio.'),true);return;}chooseInboxFile(event.dataTransfer.files[0]);});
$('#app').addEventListener('paste',event=>{if(!event.target.closest('#message-form')||!event.clipboardData?.files.length)return;event.preventDefault();if(event.clipboardData.files.length!==1){toast(t('Cole um arquivo por envio.'),true);return;}chooseInboxFile(event.clipboardData.files[0]);});
$('#app').addEventListener('keydown',event=>{if(['message-text','internal-note-text'].includes(event.target.id)&&event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();if(!state.busy&&!voiceRecorder.busy&&!mediaUI.sending)event.target.closest('form').requestSubmit();}});
window.addEventListener('pagehide',()=>{voiceRecorder.reset();mediaUI.reset();repliesUI.reset();});
