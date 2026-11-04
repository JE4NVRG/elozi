import './locales-telegram-account.js';
import { h, raw, t, getLocale } from './i18n.js';
import './locales-shell.js';
import './locales-operations.js';
import './locales-home.js';
import './locales-guided-setup.js';
import { button, badge, banner, emptyState, progress, companyMark, attributes, kbd, brandReportLines, toasts } from './ui.js';
import { glyph } from './icons.js';
import { deriveBrandTokens } from './brand-theme.js';
import { sessionPermission } from './nav-config.js';
import { formatHash } from './router.js';
import { createOperationReadinessModel, deriveSetup, portfolioModel } from './operation-readiness.js';
import { appServices } from './channel-connect-flow.js';
import { normalizeChannelValidationPage, channelValidatedForUse } from './channel-validation-view.js';

// First use (#setup, FRONTEND-V2 §5.6, §8.8). Owned by P7. Screen contract (§8.2):
// createOnboarding(deps) → {view(route), mount, act, submit, reset}; act/submit answer 'setup:*' and
// the data-form="setup:…" forms through the registry of actions.js.
//
// - Company admin: Empresa · Canal · Equipe · Agente (optional) · Atendimento manual, derived from the data
//   (operation-readiness.js deriveSetup); reseller admins also get Marca (light and dark preview with
//   the contrast report) · Domínio · Primeiro cliente · Plano · Ajudar seu cliente.
// - Invited attendant: the 6 essential shortcuts, the initial availability and an optional
//   "Permitir alertas do navegador" (never an automatic notification prompt).
// Dismissal and attendance choices are local preferences per person and company; they grant no access.
//
// Also exports the small client cache of Visão geral (client portfolio and AI usage of the day) and
// the setup preferences, shared with overview-ui.js.
//
// deps: pageHeading (legacy helper), state/api/refresh/toast (else appServices()).

// ---- setup preferences (local, per person and company) -------------------------------------------
const prefsKey = userId => `elozi:setup:${String(userId || 'anonymous')}`;
const attendanceModes = new Set(['solo','team','agent','hybrid']);
function readAll(userId, storage) { try { const value = JSON.parse(storage?.getItem(prefsKey(userId)) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
/** {dismissed, solo, completedAt} of one person in one company; private windows give {}. */
export function readSetupPrefs(userId, tenantId, storage = globalThis.localStorage) {
  const entry = readAll(userId, storage)[tenantId];
  return entry && typeof entry === 'object' ? { dismissed: entry.dismissed === true, solo: entry.solo === true, completedAt: typeof entry.completedAt === 'string' ? entry.completedAt : null,
    ...(attendanceModes.has(entry.attendanceMode) ? {attendanceMode:entry.attendanceMode} : {}) } : { dismissed: false, solo: false, completedAt: null };
}
/** Merges a change into the preferences of one person in one company. */
export function saveSetupPrefs(userId, tenantId, patch, storage = globalThis.localStorage) {
  if (!tenantId) return readSetupPrefs(userId, tenantId, storage);
  const all = readAll(userId, storage), next = { ...readSetupPrefs(userId, tenantId, storage), ...patch };
  if (!attendanceModes.has(next.attendanceMode)) delete next.attendanceMode;
  all[tenantId] = { dismissed: next.dismissed === true, solo: next.solo === true, ...(next.completedAt ? { completedAt: next.completedAt } : {}),
    ...(attendanceModes.has(next.attendanceMode) ? {attendanceMode:next.attendanceMode} : {}) };
  try { storage?.setItem(prefsKey(userId), JSON.stringify(all)); } catch { /* the preference only lasts this page */ }
  return next;
}

// ---- client cache of Visão geral and #setup (portfolio, AI usage) ---------------------------------
const TTL = 5 * 60 * 1000;
const cache = new Map();
const listeners = new Set();
/** Entry {state:'loading'|'loaded'|'error', value, error} of a key, loading it once per 5 minutes. */
export function homeData(key, fetcher, { now = Date.now() } = {}) {
  const current = cache.get(key);
  if (current && (current.state === 'loading' || now - current.at < TTL)) return current;
  const entry = { state: 'loading', value: current?.value ?? null, error: null, at: now };
  cache.set(key, entry);
  Promise.resolve().then(fetcher).then(value => { entry.state = 'loaded'; entry.value = value; }, error => { entry.state = 'error'; entry.error = error; })
    .finally(() => { if (cache.get(key) === entry) for (const listener of [...listeners]) listener(key, entry); });
  return entry;
}
/** The cached entry of a key without loading it. */
export const peekHomeData = key => cache.get(key) || null;
/** Forgets one key (retry) or everything (workspace change, tests). */
export function forgetHomeData(key) { if (key === undefined) cache.clear(); else cache.delete(key); }
/** Calls listener(key, entry) whenever a load finishes; returns the function that removes it. */
export function onHomeData(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export const portfolioKey = (workspaceId, userId) => `portfolio:${workspaceId}:${userId}`;
/** Loads the client accounts of the workspace (GET /api/accounts, same DTO as Clientes). */
export function loadPortfolio(api, { workspaceId, userId }) {
  return homeData(portfolioKey(workspaceId, userId), async () => {
    const result = await api(`/api/accounts?${new URLSearchParams({ view: 'account', q: '', kind: 'all', state: 'all', offset: '0', limit: '100' })}`, { headers: { 'X-Elozi-Workspace': workspaceId } });
    if (!Array.isArray(result?.accounts)) throw new Error(t('O servidor não confirmou as contas.'));
    return result;
  });
}

// ---- data of the app, as Visão geral receives it ----------------------------------------------
/** Input of createOperationReadinessModel from the app state (same rules as views.overview in app.js). */
export function readinessInput(state) {
  const session = state?.boot?.session || {}, can = sessionPermission(session), admin = session.role === 'reseller' && !state?.supportGrantId;
  const tenant = state?.tenant || null;
  return { tenant, workspaceId: state?.workspaceId || null, session, supportMode: Boolean(state?.supportGrantId),
    conversations: tenant?.conversations, channels: tenant?.channels, agents: tenant?.agents, runs: tenant?.runs,
    contacts: state?.overviewLoaded?.contacts ? state.contacts : null, assignees: state?.overviewLoaded?.assignees ? state.assignees : null,
    loadState: { conversations: Array.isArray(tenant?.conversations) ? 'partial' : 'unavailable', channels: Array.isArray(tenant?.channels) ? 'loaded' : 'unavailable',
      contacts: state?.overviewLoaded?.contacts ? 'loaded' : 'unavailable', assignees: state?.overviewLoaded?.assignees ? 'loaded' : 'unavailable',
      agents: Array.isArray(tenant?.agents) ? 'loaded' : 'unavailable', runs: Array.isArray(tenant?.runs) ? 'partial' : 'unavailable' },
    access: { inboxRead: can('inbox.read'), contactsRead: can('contacts.read'), contactsWrite: can('contacts.write'), metricsRead: can('metrics.read'),
      manageChannels: admin, manageTeam: admin, manageAgents: admin, manageServices: admin, manageCompany: admin } };
}

const STEP_COPY = () => ({
  company: { title: t('Empresa'), text: t('A empresa organiza canais, pessoas e atendimentos.') },
  channel: { title: t('Canal'), text: t('Conecte o WhatsApp, o Telegram ou o chat do site.') },
  team: { title: t('Equipe'), text: t('Convide quem vai atender, ou atenda sozinho.') },
  agent: { title: t('Agente'), text: t('O agente é opcional. Quando usar um rascunho, revise antes de enviar.') },
  test: { title: t('Atendimento manual'), text: t('Confira a entrada e responda pela mesma origem. Você pode começar sem agente.') },
  brand: { title: t('Marca'), text: t('Logo, nome e cor que seus clientes veem.') },
  domain: { title: t('Domínio'), text: t('Seu endereço com HTTPS, verificado ao vivo.') },
  client: { title: t('Primeiro cliente'), text: t('Crie a conta do cliente e convide o administrador dele.') },
  plan: { title: t('Plano'), text: t('Preços e limites do cliente. Opcional.') },
  help: { title: t('Ajudar seu cliente'), text: t('O vínculo comercial não dá acesso ao atendimento do cliente.') }
});
const STATE_LABEL = () => ({ done: t('Concluído'), todo: t('A fazer'), unknown: t('Status não disponível'), info: t('Opcional') });
const STATE_GLYPH = { done: 'check', todo: 'arrow', unknown: 'info', info: 'info' };
const CHANNEL_OPTIONS = () => [['whatsapp_qr', t('WhatsApp'), t('QR com o número da empresa.')], ['telegram', t('Telegram · Bot'), t('Um bot do @BotFather.')], ['telegram_user',t('Telegram pessoal'),t('Escolha as conversas da sua conta para atendimento humano.')], ['webchat', t('Webchat'), t('Pronto agora: um código no seu site.')], ['email', t('E-mail'), t('Endereço de atendimento por relay.')], ['instagram', t('Instagram'), t('Conta profissional pelo app Meta.')], ['messenger', t('Messenger'), t('Página do Facebook pelo app Meta.')]];
const SHORTCUTS = () => [['mod+k', t('Buscar ou executar')], ['?', t('Ver todos os atalhos')], [['g', 'i'], t('Ir para o Atendimento')], [['j', 'k'], t('Mover na lista sem abrir')], ['enter', t('Abrir a conversa')], ['r', t('Responder')]];
const PRESENCE = () => [['available', t('Disponível')], ['busy', t('Ocupado')], ['away', t('Ausente')], ['offline', t('Fora de atendimento')]];
const link = (label, href, variant = 'secondary') => h`<a class="ui-btn ui-btn--${variant} ui-btn--md" href="${href}"><span class="ui-btn__label">${label}</span></a>`;
const channelsHash = params => { try { return formatHash({ section: 'channels', params, query: {} }); } catch { return '#channels'; } };
const CONNECTION_LABEL = () => ({ connected: t('Conectado'), configured: t('Configurado · conferir entrada'), disabled: t('Desabilitado'), problem: t('Conexão com problema'), pending: t('Conexão em andamento'), unknown: t('Status não disponível') });

export function createOnboarding(deps = {}) {
  let selected = null, alerts = '', validation = null, validationSequence = 0, validationController = null;
  const services = () => ({ ...(appServices() || {}), ...Object.fromEntries(['state', 'api', 'refresh', 'toast'].filter(key => deps[key] && (key === 'state' || typeof deps[key] === 'function')).map(key => [key, deps[key]])) });
  const appState = () => services().state || null;
  const notify = (message, error = false) => { const toast = services().toast; if (typeof toast === 'function') toast(message, error); else toasts.show({ message, tone: error ? 'error' : 'success' }); };
  const validationScope = state => {const session=state?.boot?.session || {};return JSON.stringify([state?.workspaceId,state?.tenant?.id,state?.supportGrantId,state?.boot?.csrfToken,
    session.userId,session.role,session.kind,session.resellerId,session.supportGrantId,session.permissions,session.scopeRules,
    (state?.tenant?.channels || []).map(channel=>[channel.id,channel.kind,channel.state,channel.webchat?.version,channel.webchat?.widgetVersion])]);};
  async function loadValidation() {
    const m=model(), api=services().api;
    if (!deps.durableOnboarding || !m?.readiness.manager || typeof api!=='function') return;
    validationController?.abort(); const controller=new AbortController(), sequence=++validationSequence, key=validationScope(m.state);
    validationController=controller; validation={key,state:'loading',items:[]}; rerender();
    const timeout=globalThis.setTimeout(()=>controller.abort(),20_000);
    try {
      const result=await api(`/api/tenants/${encodeURIComponent(m.tenant.id)}/channels/onboarding`,{signal:controller.signal,headers:{'X-Elozi-Workspace':m.state.workspaceId}});
      if(sequence!==validationSequence || key!==validationScope(appState())) return;
      if (controller.signal.aborted) { validation={key,state:'error',items:[]}; return; }
      const items=normalizeChannelValidationPage(result,{tenantId:m.tenant.id,channelIds:m.tenant.channels.map(channel=>channel.id)});
      validation={key,state:'loaded',items};
    } catch(error) { if(sequence!==validationSequence || key!==validationScope(appState()))return; validation={key,state:'error',items:[]}; }
    finally {globalThis.clearTimeout(timeout);if(sequence===validationSequence) {validationController=null;rerender();} }
  }

  function model() {
    const state = appState();
    if (!state?.boot) return null;
    const input = readinessInput(state), readiness = createOperationReadinessModel(input);
    const session = input.session, tenantId = state.tenant?.id || null, accountKind = state.boot.reseller?.accountKind || null;
    const prefs = readSetupPrefs(session.userId, tenantId);
    let portfolio = null, portfolioState = 'idle';
    if (readiness.manager && accountKind === 'reseller') {
      const entry = peekHomeData(portfolioKey(state.workspaceId, session.userId));
      portfolioState = entry?.state || 'idle';
      if (entry?.value) portfolio = portfolioModel(entry.value, state.workspaceId, { now: Date.now() }).clients;
    }
    const currentValidation=validation?.key===validationScope(state)?validation:null;
    const setup = deriveSetup(readiness, { accountKind, brand: state.boot.reseller?.brand, prefs, portfolio,
      ...(deps.durableOnboarding ? {validation:currentValidation} : {}) });
    return { state, input, readiness, setup, prefs, accountKind, portfolioState, session, tenant: state.tenant || null, validation:currentValidation };
  }

  function stepRow(step, copy, current) {
    return h`<li class="pg-home__setup-item" data-state="${step.state}"><button type="button" class="pg-home__setup-step"${attributes({ 'data-action': 'setup:select', 'data-id': step.id, 'aria-current': current ? 'step' : null })}><span class="pg-home__setup-mark" aria-hidden="true">${glyph(STATE_GLYPH[step.state])}</span><span class="pg-home__setup-name">${copy.title}${step.optional ? h` <small>${t('opcional')}</small>` : ''}</span><span class="sr-only">${STATE_LABEL()[step.state]}</span></button></li>`;
  }
  function channelChecks(m) {
    if (!m.readiness.data.channels.available) return h`<p class="pg-home__hint">${t('Os canais não estão disponíveis nesta leitura.')}</p>`;
    const checks = m.readiness.channelChecks;
    if (!checks.length) return '';
    const incomingLabel = value => value === true ? t('Entrada registrada') : value === false ? t('Entrada não observada nesta leitura') : t('Entrada: conferir no Atendimento');
    const responseLabel = value => value === true ? t('Resposta registrada') : value === false ? t('Resposta não observada nesta leitura') : t('Resposta: conferir no Atendimento');
    if(deps.durableOnboarding) return h`<h3 class="pg-home__subtitle">${t('Conferência por canal')}</h3><ul class="pg-home__choices" aria-label="${t('Conferência por canal')}">${checks.map(channel=>{
      const proof=m.validation?.state==='loaded'?m.validation.items.find(item=>item.channelId===channel.id):null;
      return h`<li class="pg-home__choice" data-setup-channel="${channel.id}"><div><strong>${channel.name || t('Canal')}</strong><ul class="pg-home__report"><li>${CONNECTION_LABEL()[channel.connection]}</li><li>${proof ? incomingLabel(proof.incomingRecorded) : t('Validação não carregada')}</li><li>${proof ? responseLabel(proof.replyRecorded) : t('Confira o teste salvo deste canal.')}</li><li>${channelValidatedForUse(proof)?t('Recebimento no destino confirmado'):proof?.state==='stale'?t('A configuração mudou. Faça um novo teste.'):t('Confirmação no destino pendente')}</li></ul></div>${link(t('Continuar teste'),channelsHash({channelId:channel.id,tab:'test'}))}</li>`;
    })}</ul><p class="pg-home__hint" role="status">${m.validation?.state==='error'?t('Não foi possível carregar os testes salvos. Tente novamente.'):t('O teste fica salvo para continuar em outra sessão.')}</p><div class="pg-home__actions">${button({label:t('Atualizar testes salvos'),variant:'secondary',action:'setup:validation-refresh'})}</div>`;
    return h`<h3 class="pg-home__subtitle">${t('Conferência por canal')}</h3><ul class="pg-home__choices" aria-label="${t('Conferência por canal')}">${checks.map(channel => h`<li class="pg-home__choice" data-setup-channel="${channel.id}"><div><strong>${channel.name || t('Canal')}</strong><ul class="pg-home__report"><li>${CONNECTION_LABEL()[channel.connection]}</li><li>${incomingLabel(channel.incomingRecorded)}</li><li>${responseLabel(channel.responseRecorded)}</li></ul></div></li>`)}</ul>
      <p class="pg-home__hint">${m.readiness.data.conversations.state === 'partial' ? t('Leitura parcial: a conferência mostra apenas os registros disponíveis para seu acesso.') : ''}</p><p class="pg-home__hint">${t('O registro de envio não confirma o recebimento no destino. Confira a resposta no aparelho ou serviço autorizado de cada canal.')}</p>`;
  }
  function panel(step, m) {
    const copy = STEP_COPY()[step.id], stateLabel = step.state === 'done' && step.id === 'test' ? t('Entrada e resposta registradas') : step.state === 'done' && step.id === 'agent' ? t('Configuração salva') : STATE_LABEL()[step.state];
    const status = h`<p class="pg-home__setup-status" data-state="${step.state}">${glyph(STATE_GLYPH[step.state])}<span>${stateLabel}</span></p>`;
    const heading = h`<h2 id="setup-panel-title" class="pg-home__setup-title" tabindex="-1">${copy.title}</h2>${status}<p class="pg-home__lead">${copy.text}</p>`;
    const tenant = m.tenant, channels = m.readiness.channelChecks;
    switch (step.id) {
      case 'company': return h`${heading}<p class="pg-home__setup-line">${companyMark(tenant)}</p><p class="pg-home__hint">${t('Nome, segmento e estrutura ficam em Configurações › Empresas e filiais.')}</p><p class="pg-home__hint">${t('O idioma do painel fica no menu da sua conta.')}</p><div class="pg-home__actions">${link(t('Revisar empresa'), '#settings/companies')}</div>`;
      case 'channel': {
        const connected = channels.filter(channel => channel.connection === 'connected');
        return h`${heading}${channels.length ? h`<ul class="pg-home__report">${channels.map(channel => h`<li><strong>${channel.name || t('Canal')}</strong> · ${CONNECTION_LABEL()[channel.connection]}</li>`)}</ul>` : ''}
          <ul class="pg-home__choices">${CHANNEL_OPTIONS().map(([kind, name, detail]) => {
            const existing=m.tenant.channels.find(channel=>channel.kind===kind), proof=m.validation?.items.find(item=>item.channelId===existing?.id);
            const resume=existing?channelsHash({channelId:existing.id,...(deps.durableOnboarding&&['connected','configured'].includes(existing.state)&&!channelValidatedForUse(proof)?{tab:'test'}:{})}):channelsHash({kind});
            return h`<li class="pg-home__choice"><div><strong>${name}</strong><p class="pg-home__hint">${detail}</p></div>${link(existing?t('Continuar configuração'):kind === 'webchat' ? t('Instalar') : t('Conectar'),resume,kind === 'webchat' && !connected.length ? 'primary' : 'secondary')}${existing?link(t('Adicionar outro'),channelsHash({kind}),'ghost'):''}</li>`;
          })}</ul>`;
      }
      case 'team': {
        const people = m.readiness.people;
        const attendance=[['solo',t('Eu vou atender'),t('Comece no Atendimento e convide outras pessoas quando precisar.')],['team',t('Minha equipe'),t('Organize as pessoas, os canais e os departamentos permitidos.')],['agent',t('Meu Hermes'),t('Conecte seu Hermes por MCP e escolha o que ele pode fazer.')],['hybrid',t('Equipe + Hermes'),t('Prepare a equipe e conecte seu agente para colaborar no atendimento.')]];
        const selectedMode=m.prefs.attendanceMode || (m.prefs.solo?'solo':null);
        const choice=selectedMode==='agent'||selectedMode==='hybrid'?link(t('Conectar meu Hermes'),'#agents/connect','primary'):selectedMode==='team'?link(t('Organizar minha equipe'),'#settings/team','primary'):selectedMode==='solo'?link(t('Abrir Atendimento'),'#inbox','primary'):'';
        return h`${heading}<h3 class="pg-home__subtitle">${t('Quem vai atender?')}</h3><ul class="pg-home__choices">${attendance.map(([id,label,detail])=>h`<li class="pg-home__choice"><div><strong>${label}</strong><p class="pg-home__hint">${detail}</p></div>${button({label:selectedMode===id?t('Selecionado'):t('Escolher'),variant:selectedMode===id?'primary':'secondary',action:'setup:attendance',attrs:{'data-id':id,'aria-pressed':selectedMode===id}})}</li>`)}</ul>${choice? h`<div class="pg-home__actions">${choice}${selectedMode==='hybrid'?link(t('Organizar minha equipe'),'#settings/team'):''}</div>`:''}
          ${people !== null ? h`<p class="pg-home__setup-line">${glyph('users')}<span>${people === 1 ? t('1 pessoa pode atender nesta empresa') : t('{count} pessoas podem atender nesta empresa', { count: people })}</span></p>` : ''}
          ${step.solo ? h`<p class="pg-home__setup-line">${glyph('check')}<span>${t('Você vai atender sozinho por enquanto.')}</span></p><div class="pg-home__actions">${link(t('Convidar pessoas'), '#settings/team', 'primary')}${button({ label: t('Desfazer'), variant: 'ghost', action: 'setup:solo', attrs: { 'data-id': 'off' } })}</div>`
            : h`<div class="pg-home__actions">${link(t('Convidar pessoas'), '#settings/team', 'primary')}${button({ label: t('Vou atender sozinho'), variant: 'ghost', action: 'setup:solo', attrs: { 'data-id': 'on' } })}</div>`}`;
      }
      case 'agent': {
        const ready = m.readiness.agentSignals.filter(agent => agent.configured);
        return h`${heading}${ready.length ? h`<p class="pg-home__setup-line">${glyph('check')}<span>${t('{name}: configuração salva', { name: ready[0].name || t('Agente') })}</span></p>` : ''}
          <ul class="pg-home__choices"><li class="pg-home__choice"><div><strong>${t('Usar o assistente gerenciado')}</strong><p class="pg-home__hint">${t('Comece com um modelo de instruções do seu segmento.')}</p></div>${link(t('Configurar'), '#agents', ready.length ? 'secondary' : 'primary')}</li>
          <li class="pg-home__choice"><div><strong>${t('Conectar meu agente')}</strong><p class="pg-home__hint">${t('Seu agente externo, com chave própria e aprovação humana.')}</p></div>${link(t('Conectar'), '#agents/connect')}</li></ul>`;
      }
      case 'test': {
        const target = channels.find(channel => ['connected', 'configured'].includes(channel.connection) && channel.responseRecorded !== true) || channels.find(channel => ['connected', 'configured'].includes(channel.connection));
        return h`${heading}<ol class="pg-home__howto"><li>${t('Use um destinatário autorizado para enviar uma mensagem ao canal escolhido.')}</li><li>${t('Abra a conversa, confira a origem, assuma e responda manualmente.')}</li><li>${t('Confira o recebimento da resposta no destino. Repita a conferência em cada canal que vai usar.')}</li></ol>${channelChecks(m)}
          <div class="pg-home__actions">${step.state === 'done' ? link(t('Abrir Atendimento'), '#inbox', 'primary') : target ? link(t('Começar'), channelsHash({ channelId: target.id,...(deps.durableOnboarding?{tab:'test'}:{}) }), 'primary') : link(t('Conectar um canal'), '#channels', 'primary')}</div>`;
      }
      case 'brand': {
        const brand = m.state.boot.reseller?.brand || {}, tokens = deriveBrandTokens(brand.accent);
        // The workspace brand is already applied to the page (--b-*-l / --b-*-d of applyBrandTokens).
        const sample = theme => h`<div class="pg-home__brand-sample" data-theme-sample="${theme}"><span class="pg-home__brand-name">${brand.name || t('Sua marca')}</span><span class="pg-home__brand-button">${t('Responder')}</span><span class="pg-home__brand-link">${t('Ver conversa')}</span><small class="pg-home__brand-caption">${theme === 'light' ? t('Claro') : t('Escuro')}</small></div>`;
        return h`${heading}<div class="pg-home__brand-preview">${sample('light')}${sample('dark')}</div>
          <ul class="pg-home__report">${brandReportLines(tokens.report).map(line => h`<li>${line}</li>`)}</ul><div class="pg-home__actions">${link(t('Editar marca'), '#settings/brand', 'primary')}</div>`;
      }
      case 'domain': return h`${heading}<p class="pg-home__hint">${t('Crie o registro TXT ou CNAME indicado e acompanhe a verificação. O HTTPS é emitido quando o domínio responde.')}</p><div class="pg-home__actions">${button({ label: t('Domínio e HTTPS'), variant: 'primary', icon: 'globe', action: 'workspace-domain' })}</div>`;
      case 'client': {
        const count = step.clients;
        return h`${heading}${count ? h`<p class="pg-home__setup-line">${glyph('check')}<span>${count === 1 ? t('1 conta de cliente criada') : t('{count} contas de cliente criadas', { count })}</span></p>` : m.portfolioState === 'error' ? h`<p class="pg-home__hint">${t('Não conseguimos consultar suas contas agora.')}</p>` : ''}<div class="pg-home__actions">${link(count ? t('Ver clientes') : t('Criar conta de cliente'), '#accounts', count ? 'secondary' : 'primary')}</div>`;
      }
      case 'plan': return h`${heading}<div class="pg-home__actions">${link(t('Ver planos'), '#accounts')}</div>`;
      // The panel has no request flow: the client's admin grants the support in their own account.
      case 'help': return h`${heading}<p class="pg-home__hint">${t('Para ajudar dentro da operação do cliente, peça ao administrador dele que conceda um suporte com prazo à sua pessoa de suporte, em Configurações › Suporte da conta dele: acesso temporário, com empresas e ações definidas.')}</p><p class="pg-home__hint">${t('Os acessos concedidos a você aparecem em Suporte, nesta conta.')}</p><div class="pg-home__actions">${link(t('Ver acessos de suporte recebidos'), '#settings/support')}</div>`;
      default: return heading;
    }
  }
  function adminPage(m) {
    const steps = m.setup.steps, copy = STEP_COPY();
    const current = steps.find(step => step.id === selected) || steps.find(step => !step.optional && ['todo', 'unknown'].includes(step.state)) || (m.setup.complete ? steps.find(step => step.id === 'test') : steps.find(step => step.state === 'todo')) || steps[0];
    selected = current.id;
    const group = (name, title) => { const items = steps.filter(step => step.group === name); return items.length ? h`<li class="pg-home__setup-group"><p class="pg-home__eyebrow">${title}</p><ol class="pg-home__setup-list">${items.map(step => stepRow(step, copy[step.id], step.id === current.id))}</ol></li>` : ''; };
    const done = m.setup.complete;
    return h`<header class="pg-home__header"><div><p class="pg-home__eyebrow">${t('Primeiro uso')}</p><h1 class="pg-home__title">${done ? t('Preparação do atendimento manual concluída') : t('Prepare sua operação')}</h1><p class="pg-home__lead">${t('O progresso acompanha os registros disponíveis. Confirme o recebimento no destino; o agente é opcional.')}</p></div>
        <div class="pg-home__setup-progress">${progress({ value: m.setup.done, max: m.setup.total, label: t('Progresso do primeiro uso'), valueText: t('{done} de {total} etapas', { done: m.setup.done, total: m.setup.total }) })}<span class="pg-home__hint">${t('{done} de {total} etapas', { done: m.setup.done, total: m.setup.total })}</span></div></header>
      ${m.prefs.dismissed ? banner({ tone: 'info', title: t('Guia dispensado'), body: t('Na Visão geral ele fica só como um link.'), action: { label: t('Mostrar de novo'), action: 'setup:restore' } }) : ''}
      <div class="pg-home__setup" data-setup-root><nav class="pg-home__setup-nav" aria-label="${t('Etapas do primeiro uso')}"><ol class="pg-home__setup-groups">${group('company', t('Sua empresa'))}${group('reseller', t('Sua revenda'))}</ol>${m.prefs.dismissed ? '' : button({ label: t('Dispensar guia'), variant: 'ghost', size: 'sm', action: 'setup:dismiss' })}</nav>
        <section class="pg-home__setup-panel" aria-labelledby="setup-panel-title">${panel(current, m)}</section></div>`;
  }
  function alertsControl() {
    const notification = typeof globalThis.Notification === 'function' ? globalThis.Notification.permission : 'unsupported';
    return notification === 'unsupported' ? h`<p class="pg-home__hint">${t('Este navegador não oferece alertas.')}</p>` : notification === 'granted' ? h`<p class="pg-home__setup-line">${glyph('check')}<span>${t('Alertas permitidos neste navegador. Som e prévia ficam no menu da conta.')}</span></p>` : notification === 'denied' ? h`<p class="pg-home__hint">${t('Os alertas estão bloqueados nas configurações do navegador.')}</p>` : button({ label: t('Permitir alertas do navegador'), variant: 'secondary', icon: 'bell', action: 'setup:alerts' });
  }
  // After the browser prompt only the alerts block changes: the same role="status" node receives the
  // result (so it is announced) and the focus stays in the block.
  function updateAlerts() {
    const doc = globalThis.document, box = doc?.querySelector?.('[data-setup-alerts]');
    if (!box) return;
    const focused = box.contains(doc.activeElement), template = doc.createElement('template');
    template.innerHTML = String(alertsControl());
    box.replaceChildren(...template.content.childNodes);
    const status = doc.querySelector('[data-setup-alerts-status]');
    if (status) status.textContent = alerts;
    if (focused) (box.querySelector('button') || doc.getElementById('setup-alerts-title'))?.focus({ preventScroll: true });
  }
  function attendantPage(m) {
    const presence = PRESENCE().some(([value]) => value === m.session.presence) ? m.session.presence : 'available';
    return h`<header class="pg-home__header"><div><p class="pg-home__eyebrow">${t('Primeiro uso')}</p><h1 class="pg-home__title">${t('Boas-vindas ao atendimento')}</h1><p class="pg-home__lead">${t('Três coisas para começar bem. Nada aqui é obrigatório.')}</p></div></header>
      <div class="pg-home__grid">
        <section class="pg-home__panel" aria-labelledby="setup-shortcuts-title"><h2 id="setup-shortcuts-title" class="pg-home__panel-title">${t('Seus 6 atalhos essenciais')}</h2><dl class="pg-home__shortcuts">${SHORTCUTS().map(([keys, label]) => h`<div><dt>${Array.isArray(keys) ? keys.map((key, index) => h`${index ? ' ' : ''}${kbd(key)}`) : kbd(keys)}</dt><dd>${label}</dd></div>`)}</dl><p class="pg-home__hint">${t('Os atalhos de uma tecla podem ser desligados no menu da conta.')}</p></section>
        <section class="pg-home__panel" aria-labelledby="setup-presence-title"><h2 id="setup-presence-title" class="pg-home__panel-title">${t('Sua disponibilidade')}</h2>
          <form class="pg-home__form" data-form="setup:presence"><fieldset class="pg-home__radios"><legend class="sr-only">${t('Disponibilidade inicial')}</legend>${PRESENCE().map(([value, label]) => h`<label class="pg-home__radio"><input type="radio" name="presence" value="${value}"${attributes({ checked: value === presence })}/><span>${label}</span></label>`)}</fieldset><p class="pg-home__hint">${t('Fora de "Disponível" você não recebe distribuição automática.')}</p><div class="pg-home__actions">${button({ label: t('Salvar disponibilidade'), variant: 'primary', type: 'submit' })}</div></form></section>
        <section class="pg-home__panel" aria-labelledby="setup-alerts-title"><h2 id="setup-alerts-title" class="pg-home__panel-title" tabindex="-1">${t('Alertas')}</h2><p class="pg-home__hint">${t('Opcional. O navegador só pergunta quando você pedir.')}</p>
          <div data-setup-alerts>${alertsControl()}</div>
          <p class="pg-home__hint" role="status" data-setup-alerts-status>${alerts}</p></section>
      </div><div class="pg-home__actions">${link(t('Ir para o Atendimento'), '#inbox', 'primary')}</div>`;
  }
  /** The page for #setup. */
  function view() {
    const m = model();
    const heading = typeof deps.pageHeading === 'function' ? raw(deps.pageHeading(t('PRIMEIRO USO'), t('Primeiro uso'), t('Empresa, canal, equipe, agente e um atendimento de teste, na ordem que a sua conta pede.'))) : h`<h1>${t('Primeiro uso')}</h1>`;
    if (!m) return String(h`${heading}${emptyState({ icon: 'check', title: t('O guia de primeiro uso ainda não está disponível nesta versão.'), body: t('Os passos para preparar a operação ficam na Visão geral.'), action: { label: t('Abrir a Visão geral'), attrs: { 'data-view': 'overview' } } })}`);
    if (!m.tenant) return String(h`<div class="pg-home pg-home--setup"><header class="pg-home__header"><div><p class="pg-home__eyebrow">${t('Primeiro uso')}</p><h1 class="pg-home__title">${t('Escolha uma empresa')}</h1></div></header>${emptyState({ icon: 'building', title: t('Nenhuma empresa selecionada'), body: t('O primeiro uso acompanha os dados de uma empresa.'), action: { label: t('Abrir a Visão geral'), attrs: { 'data-view': 'overview' } } })}</div>`);
    if (m.readiness.manager && m.accountKind === 'reseller' && typeof services().api === 'function') loadPortfolio(services().api, { workspaceId: m.state.workspaceId, userId: m.session.userId });
    return String(h`<div class="pg-home pg-home--setup">${m.readiness.manager ? adminPage(m) : attendantPage(m)}</div>`);
  }
  function rerender({ focus = null } = {}) {
    const root = globalThis.document?.querySelector?.('.pg-home--setup');
    if (!root) return;
    const template = globalThis.document.createElement('template');
    template.innerHTML = view();
    const fresh = template.content.firstElementChild;
    if (!fresh) return;
    root.replaceWith(fresh);
    if (focus) globalThis.document.querySelector(focus)?.focus({ preventScroll: true });
  }
  let unsubscribe = null;
  /** Re-renders the page when the client portfolio arrives. */
  function mount() {
    unsubscribe?.();
    unsubscribe = onHomeData(key => { if (key.startsWith('portfolio:') && globalThis.document?.querySelector?.('.pg-home--setup')) rerender(); });
    void loadValidation();
  }
  async function act(name, id = null) {
    const m = model();
    switch (name) {
      case 'setup:select': if (m?.setup.steps.some(step => step.id === id)) { selected = id; rerender({ focus: '#setup-panel-title' }); } return true;
      case 'setup:solo': if (m?.readiness.manager && m.tenant) { saveSetupPrefs(m.session.userId, m.tenant.id, { solo: id !== 'off',attendanceMode:id!=='off'?'solo':'team' }); selected = 'team'; rerender({ focus: '#setup-panel-title' }); } return true;
      case 'setup:attendance': if(m?.readiness.manager && m.tenant && attendanceModes.has(id)) {saveSetupPrefs(m.session.userId,m.tenant.id,{attendanceMode:id,solo:id==='solo'});selected='team';rerender({focus:'#setup-panel-title'});} return true;
      case 'setup:validation-refresh': await loadValidation(); return true;
      case 'setup:dismiss': if (m?.tenant) { saveSetupPrefs(m.session.userId, m.tenant.id, { dismissed: true }); notify(t('Guia dispensado. Ele continua no link "Abrir o guia de primeiro uso" da Visão geral.')); if (globalThis.location) globalThis.location.hash = '#overview'; } return true;
      case 'setup:restore': if (m?.tenant) { saveSetupPrefs(m.session.userId, m.tenant.id, { dismissed: false }); rerender({ focus: '#setup-panel-title' }); } return true;
      case 'setup:alerts': {
        if (typeof globalThis.Notification?.requestPermission !== 'function') return true;
        try { const result = await globalThis.Notification.requestPermission(); alerts = result === 'granted' ? t('Alertas permitidos. Escolha som e prévia no menu da conta.') : t('Os alertas continuam desligados.'); }
        catch { alerts = t('O navegador não confirmou a permissão.'); }
        updateAlerts();
        return true;
      }
      default: return false;
    }
  }
  async function submit(form) {
    if (form?.dataset?.form !== 'setup:presence') return false;
    const presence = String(form.elements?.namedItem?.('presence')?.value ?? form.querySelector?.('[name="presence"]:checked')?.value ?? '');
    if (!PRESENCE().some(([value]) => value === presence)) return true;
    const api = services().api;
    if (typeof api !== 'function') { notify(t('O painel ainda está carregando. Tente de novo em instantes.'), true); return true; }
    try { await api('/api/auth/presence', { method: 'PATCH', body: JSON.stringify({ presence }) }); notify(t('Disponibilidade salva.')); await services().refresh?.(); }
    catch (error) { notify(error?.message || t('Não foi possível salvar a disponibilidade.'), true); }
    return true;
  }
  /** Workspace or company changed. */
  function reset() { selected = null; alerts = ''; unsubscribe?.(); unsubscribe = null; validationSequence++;validationController?.abort();validationController=null;validation=null; }
  return { view, mount, act, submit, reset };
}
