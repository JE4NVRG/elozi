import { h, t, getLocale } from './i18n.js';
import './locales-shell.js';
import './locales-operations.js';
import './locales-channel-journey.js';
import './locales-home.js';
import './locales-telegram-account.js';
import { button, iconButton, badge, banner, emptyState, companyMark, attributes, codeBlock, toasts } from './ui.js';
import { glyph, channelMark, brandForKind } from './icons.js';
import { motionOK } from './theme-prefs.js';
import { formatHash, parseHash } from './router.js';
import { channelJourney, CHANNEL_JOURNEY_IDS, DURABLE_CHANNEL_KINDS, channelNextAction, createChannelValidation } from './channel-journey.js';
import { normalizeChannelValidationPage } from './channel-validation-view.js';
import { appServices, channelTransport, channelHealth, channelLabel, connectionView, initialStep, stepperStates, CONNECTABLE_KINDS, CONNECT_STEPS, hasGroups, telegramTokenError, createPoller, createRoundTripTest, expectedSuffix } from './channel-connect-flow.js';

// Canais (FRONTEND-V2 §5.5, §8.8). Owned by P7. Contract (§8.2): createChannelsUI(deps) →
// {view(route), mount(main, route), act, submit, reset}; act/submit answer 'channels:*' and the
// data-form="channels:…" forms through the registry of actions.js.
//
// - #channels: the list (name, company, number or bot, health, last loaded conversation, contextual
//   action), a banner when a channel is down and the catalog of the next connection.
// - #channels/new/<kind> and #channels/<id>[/connect]: the connection drawer (560 px; a sheet below
//   900 px) with the stepper Nome → Conectar → Testar → Grupos. Steps live inside the drawer; the
//   connection poll and the round-trip test run only while it is open and the tab is visible.
// - #channels/<id>/groups: the groups of the channel (WhatsApp selection, Telegram privacy and the
//   startgroup link, loaded group conversations). The reviewed pickers stay the legacy dialogs of
//   app.js (data-action channel-groups / telegram-groups) until P10 moves them out of app.js.
//
// deps: state, channels() (channels of the open company) and the legacy helpers of app.js; api,
// refresh and toast come from deps when given, else from appServices() (channel-connect-flow.js).
const KIND_NAMES = () => ({ whatsapp_qr: t('WhatsApp'), whatsapp_cloud: t('WhatsApp · API'), telegram: t('Telegram · Bot'), telegram_user:t('Telegram pessoal'), webchat: t('Webchat'), email: t('E-mail'), instagram: t('Instagram'), messenger: t('Messenger') });
const KIND_GLYPHS = { whatsapp_qr: 'chat', whatsapp_cloud: 'chat', telegram: 'send', telegram_user:'send', webchat: 'globe', email: 'mail', instagram: 'chat', messenger: 'chat' };
// Channels of a known brand show its mark (icons.js); the platform's own channels (webchat, e-mail) keep a glyph.
// A webchat shows the logo of its site once the server found it (channel.siteIcon, site-icon.js): a PNG, JPEG or WebP data URL.
const SITE_ICON = /^data:image[/](png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const siteIconOf = channel => channel?.kind === 'webchat' && typeof channel.siteIcon?.src === 'string' && SITE_ICON.test(channel.siteIcon.src) ? channel.siteIcon.src : null;
const kindTile = (kind, channel = null) => siteIconOf(channel) ? h`<span class="pg-channels__kind pg-channels__kind--site" aria-hidden="true"><img class="pg-channels__site-icon" src="${siteIconOf(channel)}" alt="" width="24" height="24" decoding="async"/></span>` : brandForKind(kind) ? h`<span class="pg-channels__kind" data-brand="${brandForKind(kind)}" aria-hidden="true">${channelMark(brandForKind(kind), { tile: true })}</span>` : h`<span class="pg-channels__kind" aria-hidden="true">${glyph(KIND_GLYPHS[kind] || 'link')}</span>`;
const kindMark = kind => brandForKind(kind) ? channelMark(brandForKind(kind)) : glyph(KIND_GLYPHS[kind] || 'link');
const JOURNEY_KIND = { whatsapp: 'whatsapp_qr', telegram: 'telegram', telegram_user:'telegram_user', webchat: 'webchat', instagram: 'instagram', messenger: 'messenger', email: 'email' };
const STATE_NAMES = () => ({ disconnected: t('Desconectado'), starting: t('Iniciando'), qr: t('Aguardando QR'), connecting: t('Conectando'), reconnecting: t('Reconectando'), connected: t('Conectado'), logged_out: t('Sessão encerrada'), wrong_number: t('Número diferente'), failed: t('Falha de conexão'), configured: t('Configurado · validar recebimento') });
const HEALTH_TONES = { ok: 'success', pending: 'warning', problem: 'danger', setup: 'neutral', unknown: 'neutral' };
const STEP_LABELS = () => ({ name: t('Nome'), connect: t('Conectar'), test: t('Testar'), groups: t('Grupos') });
const stamp = value => { const time = Date.parse(value); return Number.isFinite(time) ? time : 0; };
const channelsHash = (params = {}) => { try { return formatHash({ section: 'channels', params, query: {} }); } catch { return '#channels'; } };
// Value of a named control (a radio group gives the checked value); no FormData, so tests can use plain objects.
const field = (form, name) => String(form?.elements?.namedItem?.(name)?.value ?? form?.querySelector?.(`[name="${name}"]`)?.value ?? '');
// Text-like controls of the drawer forms (typed values survive each patch of the drawer body).
const TYPED = '[data-form] input[name]:not([type="radio"]):not([type="checkbox"])';
const denied = error => error?.status === 401 || error?.status === 403;
const inboxHash = (tenantId, conversationId) => { try { return formatHash({ section: 'inbox', params: { tenantId, conversationId }, query: {} }); } catch { return '#inbox'; } };

/** "há 3 min" in the panel language; empty for an unknown instant. */
export function relativeTime(value, now = Date.now()) {
  const time = stamp(value);
  if (!time) return '';
  const seconds = Math.round((time - now) / 1000), format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, 'minute');
}

/** Latest public message of the loaded conversations; legacy rows without lastMessageAt keep updatedAt. */
export function lastConversationByChannel(conversations) {
  const last = new Map();
  for (const item of Array.isArray(conversations) ? conversations : []) {
    if (!item?.channelId) continue;
    const time = stamp(Object.hasOwn(item, 'lastMessageAt') ? item.lastMessageAt : item.updatedAt);
    if (time > (last.get(item.channelId) || 0)) last.set(item.channelId, time);
  }
  return last;
}

// Old WhatsApp channels have a generated "Número de teste" label. Its suffix is already public;
// the saved state tells whether it is connected now. Names never decide the purpose of a number.
const connectionDisplayLabel = channel => {
  const suffix = channel?.kind === 'whatsapp_qr' && /^Número de teste · final (\d{4})$/.exec(channel.label || '')?.[1];
  return suffix ? t(channel.state === 'connected' ? 'Número conectado · final {suffix}' : 'Número cadastrado · final {suffix}', { suffix }) : channelLabel(channel);
};

export function createChannelsUI(deps = {}) {
  const { state, channels = () => state?.tenant?.channels || [] } = deps;
  // returnFocus: {channelId} or {kind} of the control that opened the drawer; opener: kind of the last 'Novo canal'.
  let flow = null, flowAuthority = null, poller = null, probe = null, validation = null, returnFocus = null, autoAdvance = null, opener = 'whatsapp_qr', sessionBound = false, pendingTelegramAccount = null;
  let pageMounted = false, pageEpoch = 0, batchToken = 0, proofScope = null, proofSession = null, batchAsked = false, validationVisibilityBound = false;
  const proofs = new Map();
  const doc = () => globalThis.document;
  const services = () => ({ ...(appServices() || {}), ...Object.fromEntries(['api', 'refresh', 'toast'].filter(key => typeof deps[key] === 'function').map(key => [key, deps[key]])) });
  const session = () => state?.boot?.session || {};
  const admin = () => session().role === 'reseller' && !state?.supportGrantId && !session().supportGrantId && session().kind !== 'service';
  const canReadInbox = () => { const s = session(); return s.kind !== 'service' && (s.role === 'reseller' || s.permissions == null || Array.isArray(s.permissions) && s.permissions.includes('inbox.read')); };
  const tenant = () => state?.tenant || null;
  const list = () => (Array.isArray(channels()) ? channels() : []).filter(channel => channel && typeof channel.id === 'string');
  const find = id => list().find(channel => channel.id === id) || null;
  const scope = () => JSON.stringify([state?.workspaceId || null, tenant()?.id || null, state?.supportGrantId || session().supportGrantId || null, session().userId || null, session().role || null, session().kind || null]);
  const durable = channel => deps.durableOnboarding === true && DURABLE_CHANNEL_KINDS.includes(channel?.kind);
  const proof = channel => proofScope === scope() && proofSession === session() && admin() ? proofs.get(channel?.id) || null : null;
  const liveVisible = () => doc()?.visibilityState !== 'hidden' && !doc()?.querySelector?.('dialog[open]');
  const kindName = kind => KIND_NAMES()[kind] || t('Canal');
  const notify = (message, tone = 'info') => { const toast = services().toast; if (typeof toast === 'function') toast(message, tone === 'error'); else toasts.show({ message, tone }); };
  const tenantPath = suffix => `/api/tenants/${encodeURIComponent(tenant()?.id || '')}/${suffix}`;
  const agendaBusy = new Set();

  function request(path, options = {}) {
    const api = services().api;
    if (typeof api !== 'function') return Promise.reject(Object.assign(new Error(t('O painel ainda está carregando. Tente de novo em instantes.')), { status: 0 }));
    return api(path, options);
  }

  // ---- flow lifecycle -------------------------------------------------------------------------
  function stopLive() { poller?.stop(); poller = null; probe?.stop(); probe = null; validation?.stop(); validation = null; if (autoAdvance) globalThis.clearTimeout(autoAdvance); autoAdvance = null; }
  function closeFlow() { stopLive(); flow = null; flowAuthority = null; }
  const listRoute = route => route?.section === 'channels' && !route.params?.kind && !route.params?.channelId;
  function queueTelegramAccount(channel) {
    pendingTelegramAccount = { channelId: channel.id, scope: scope() };
    bindSession();
    go('#channels');
  }
  function openPendingTelegramAccount(route) {
    const pending = pendingTelegramAccount;
    pendingTelegramAccount = null;
    if (!pending || !listRoute(route) || pending.scope !== scope() || !admin()) return;
    const channel = find(pending.channelId);
    if (channel?.kind === 'telegram_user' && channel.transport === 'telegram-user') void deps.openTelegramAccount?.(channel);
  }
  function syncFlow(route) {
    if (pendingTelegramAccount && (!listRoute(route) || pendingTelegramAccount.scope !== scope() || !admin())) pendingTelegramAccount = null;
    const params = route?.section === 'channels' ? route.params || {} : {};
    // A new channel keeps one drawer while the person switches the kind (the hash follows by replaceState).
    const target = params.kind ? 'new' : params.channelId && params.tab !== 'groups' ? params.channelId : null;
    if(params.channelId&&find(params.channelId)?.kind==='telegram_user'){if(flow)closeFlow();return null;}
    if (!target || !tenant()) { if (flow) { returnFocus = focusTarget(); closeFlow(); } return null; }
    const key = JSON.stringify([scope(), target]);
    if (flow?.key === key) {
      flowAuthority = session();
      if (flow.routeTab !== params.tab) {
        flow.routeTab = params.tab;
        if (params.tab && ['connect', 'test'].includes(params.tab)) { stopLive(); flow.step = params.tab; }
      }
      return flow;
    }
    stopLive();
    const channel = params.channelId ? find(params.channelId) : null;
    flowAuthority = session();
    flow = { key, scope: scope(), channelId: params.channelId || null, kind: params.kind ? CONNECTABLE_KINDS.includes(params.kind) ? params.kind : 'whatsapp_qr' : channel?.kind || null,
      // #channels/<id>/connect opens on Conectar (no test starts by itself); #channels/<id> on the step the channel needs.
      step: initialStep(channel, params.tab), routeTab: params.tab, status: null, statusStale: false, error: '', busy: false, autostart: false, focused: false, reveal: false, confirmClose: false,
      draft: { name: '', expectedNumber: '' }, test: { state: 'idle', result: null, error: null }, validation: { dto: proof(channel), error: null, busy: false, paused: false }, announced: '' };
    return flow;
  }
  const flowChannel = () => flow?.channelId ? find(flow.channelId) : null;
  const focusTarget = () => flow ? flow.channelId ? { channelId: flow.channelId } : { kind: opener } : null;
  const isOpen = () => Boolean(flow && flow.scope === scope() && doc()?.querySelector?.('[data-channel-flow]')?.dataset.channelFlow === flow.key);

  // ---- markup ---------------------------------------------------------------------------------
  function healthBadge(channel) {
    const label = channelTransport(channel) ? STATE_NAMES()[channel.state] || t('Desconectado') : channel.state === 'sandbox' ? t('Demonstração') : t('Integração pendente');
    return badge(label, HEALTH_TONES[channelHealth(channel)]);
  }
  function contextual(channel) {
    const open = (label, variant) => button({ label, variant, size: 'sm', action: 'channels:open', attrs: { 'data-id': channel.id } });
    let conversations = '';
    if (canReadInbox() && tenant()?.id) try {
      const href = formatHash({ section: 'inbox', params: {}, workspaceId: state.workspaceId, query: { tenant: tenant().id, channel: channel.id } });
      conversations = h`<a class="ui-btn ui-btn--secondary ui-btn--md pg-channels__conversations" href="${href}" data-channel-conversations="${channel.id}" aria-label="${t('Abrir conversas de {channel} em {company}', { channel: channel.name || t('Conexão sem nome'), company: tenant().name || t('Empresa') })}">${glyph('chat')}<span class="ui-btn__label">${t('Abrir conversas')}</span></a>`;
    } catch { /* Invalid scope must not fall back to an unfiltered inbox. */ }
    if (!admin()) return h`${conversations}${open(t('Ver conexão'), 'ghost')}`;
    const health = channelHealth(channel), transport = channelTransport(channel);
    if (!transport) return conversations;
    const next = channelNextAction(channel, proof(channel));
    const primary = health === 'problem' ? open(t('Reconectar'), 'primary') : health === 'setup' ? open(transport === 'connector' ? t('Configurar') : t('Conectar'), 'primary') : open(t('Ver conexão'), 'secondary');
    const resume = health === 'ok' && durable(channel) ? button({ label: next.label, variant: next.complete ? 'ghost' : 'primary', size: 'sm', action: 'channels:resume', attrs: { 'data-id': channel.id } }) : '';
    const groups = hasGroups(channel) && health === 'ok' ? button({ label: t('Grupos'), variant: 'ghost', size: 'sm', icon: 'users', action: 'channels:groups', attrs: { 'data-id': channel.id } }) : '';
    // The phone's address book (whatsapp-agenda.js): saved names for the conversations and the CRM import.
    const agenda = channel.kind === 'whatsapp_qr' && transport === 'qr' && health === 'ok' ? button({ label: agendaBusy.has(channel.id) ? t('Sincronizando…') : t('Agenda'), variant: 'ghost', size: 'sm', icon: 'download', action: 'channels:agenda', attrs: { 'data-id': channel.id, title: t('Sincronizar os nomes salvos na agenda do celular'), 'aria-busy': agendaBusy.has(channel.id) ? 'true' : null } }) : '';
    const customize=channel.kind==='webchat'?button({label:t('Personalizar chat'),variant:'ghost',size:'sm',icon:'gear',action:'personalize-widget',attrs:{'data-id':channel.id}}):'';
    const botProfile = channel.kind === 'telegram' && transport === 'bot' && health === 'ok' ? button({ label: t('Personalizar bot'), variant: 'ghost', size: 'sm', icon: 'palette', action: 'telegram-profile', attrs: { 'data-id': channel.id } }) : '';
    return h`${conversations}${resume}${primary}${customize}${botProfile}${groups}${agenda}`;
  }
  function card(channel, last) {
    const time = last.get(channel.id);
    const lastLine = time ? t('Última conversa {when}', { when: relativeTime(new Date(time).toISOString()) }) : t('Sem conversas carregadas');
    const label = connectionDisplayLabel(channel), username = typeof channel.botUsername === 'string' ? channel.botUsername.replace(/^@+/, '') : '', next = channelNextAction(channel, proof(channel));
    const showUsername = username && !label.toLocaleLowerCase().includes(`@${username.toLocaleLowerCase()}`);
    return h`<li class="pg-channels__card" data-channel-card="${channel.id}" data-health="${channelHealth(channel)}">
      ${kindTile(channel.kind, channel)}
      <div class="pg-channels__identity"><h3 class="pg-channels__name">${channel.name || t('Conexão sem nome')}</h3>
        <p class="pg-channels__meta">${kindName(channel.kind)}${label ? h` · <span>${label}</span>` : ''}${showUsername ? h` · @${username}` : ''}</p>
        <p class="pg-channels__meta">${companyMark(tenant())} · <span class="pg-channels__last">${lastLine}</span></p><p class="pg-channels__next" data-channel-next="${channel.id}"><strong>${next.complete ? t('Validação concluída') : t('Próxima ação')}</strong> · ${next.detail}</p></div>
      <div class="pg-channels__status">${healthBadge(channel)}</div>
      <div class="pg-channels__actions">${contextual(channel)}</div>${agentSettings(channel)}</li>`;
  }
  /**
   * Connected agents on this channel, administrators only: the default agent of a WhatsApp QR channel, the reply policy
   * (support default or product assistant with hourly/minute limits and an optional notice) and team/QA conversations.
   */
  function agentSettings(channel) {
    if (!admin() || !['whatsapp_qr', 'telegram', 'webchat', 'instagram', 'messenger', 'email'].includes(channel.kind)) return '';
    const agents = (tenant()?.agents || []).filter(agent => agent.provider === 'mcp' && agent.mode === 'copilot' && agent.configured === true);
    const qr = channel.kind === 'whatsapp_qr' && channelTransport(channel) === 'qr', policy = channel.replyPolicy?.profile === 'assistant' ? channel.replyPolicy : null;
    const direct = (tenant()?.conversations || []).filter(item => item.channelId === channel.id && item.conversationKind !== 'group').sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const shown = [...direct.filter(item => item.replyExempt === true), ...direct.filter(item => item.replyExempt !== true).slice(0, 20)];
    const defaultName = agents.find(agent => agent.id === channel.defaultAgentId)?.name;
    const summary = [qr ? (defaultName ? t('Agente padrão: {name}', { name: defaultName }) : t('Sem agente padrão')) : '', policy ? t('Assistente de produto') : t('Atendimento')].filter(Boolean).join(' · ');
    return h`<details class="pg-channels__agent-settings" data-agent-settings="${channel.id}" ${openAgentSettings.has(channel.id) ? 'open' : ''}><summary>${t('Agente e respostas')} <span class="pg-channels__meta">${summary}</span></summary>
      ${qr ? h`<form class="pg-channels__default-agent" data-channel-default-agent-form="${channel.id}"><label class="pg-channels__field">${t('Agente padrão do canal')}<select data-channel-default-agent="${channel.id}" style="min-height:44px"><option value="">${t('Nenhum: conversas novas vão para a fila')}</option>${agents.map(agent => h`<option value="${agent.id}" ${channel.defaultAgentId === agent.id ? 'selected' : ''}>${agent.name}</option>`)}</select><small>${t('Conversa nova nasce com o agente; reaberta volta ao agente que a encerrou. Ligue só quando o agente estiver respondendo.')}</small></label></form>` : ''}
      <form class="pg-channels__reply-policy" data-channel-reply-policy="${channel.id}"><label class="pg-channels__field">${t('Perfil de respostas do agente')}<select name="profile" style="min-height:44px"><option value="attendance" ${policy ? '' : 'selected'}>${t('Atendimento: 6 respostas por hora por conversa')}</option><option value="assistant" ${policy ? 'selected' : ''}>${t('Assistente de produto')}</option></select></label>
        <div class="form-row"><label class="pg-channels__field">${t('Respostas por hora, por conversa')}<input name="perHour" type="number" min="6" max="1000" value="${policy?.perHour ?? 120}" style="min-height:44px"/></label><label class="pg-channels__field">${t('Respostas por minuto (rajada)')}<input name="perMinute" type="number" min="1" max="60" value="${policy?.perMinute ?? 12}" style="min-height:44px"/></label></div>
        <label class="pg-channels__field">${t('Aviso ao usuário quando o limite for atingido (opcional)')}<textarea name="notice" maxlength="280" rows="2">${policy?.notice || ''}</textarea><small>${t('Enviado uma vez por janela, só no perfil assistente.')}</small></label>
        <button type="submit" class="button" style="min-height:44px">${t('Salvar política')}</button></form>
      <fieldset class="pg-channels__team"><legend>${t('Conversas de equipe/QA')}</legend><p class="pg-channels__meta">${t('O agente responde sem limite por hora nestas conversas; fica só a trava anti-loop de 60 por minuto.')}</p>${shown.length ? shown.map(item => h`<label class="checkbox-label"><input type="checkbox" data-reply-exempt="${item.id}" ${item.replyExempt === true ? 'checked' : ''}/> ${item.contact || t('Contato')}</label>`) : h`<p class="pg-channels__meta">${t('Nenhuma conversa neste canal ainda.')}</p>`}</fieldset></details>`;
  }
  async function saveAgentSetting(path, body, success, control) {
    if (!admin() || !tenant()) return;
    if (control) control.disabled = true;
    try { await request(tenantPath(path), { method: 'POST', body: JSON.stringify(body) }); notify(success); await services().refresh?.(); }
    catch (error) { notify(error?.message || t('Não foi possível salvar.'), 'error'); await services().refresh?.(); }
    finally { if (control) control.disabled = false; }
  }
  // Saving refreshes the screen: keep the open panels open so several team/QA conversations can be marked in a row.
  const openAgentSettings = new Set();
  let agentSettingsBound = false;
  function bindAgentSettings() {
    if (agentSettingsBound || !doc()?.addEventListener) return;
    agentSettingsBound = true;
    doc().addEventListener('toggle', event => {
      const details = event.target;
      if (!details?.matches?.('[data-agent-settings]')) return;
      if (details.open) openAgentSettings.add(details.dataset.agentSettings); else openAgentSettings.delete(details.dataset.agentSettings);
    }, true);
    doc().addEventListener('change', event => {
      const control = event.target;
      if (control?.matches?.('[data-channel-default-agent]')) void saveAgentSetting(`channels/${encodeURIComponent(control.dataset.channelDefaultAgent)}/default-agent`, { agentId: control.value || null }, control.value ? t('Agente padrão ligado neste canal.') : t('Agente padrão desligado; conversas novas vão para a fila.'), control);
      else if (control?.matches?.('[data-reply-exempt]')) void saveAgentSetting(`conversations/${encodeURIComponent(control.dataset.replyExempt)}/reply-exemption`, { exempt: control.checked === true }, control.checked ? t('Conversa marcada como equipe/QA.') : t('Conversa voltou ao limite do canal.'), control);
    });
    doc().addEventListener('submit', event => {
      const form = event.target;
      if (form?.matches?.('[data-channel-default-agent-form]')) { event.preventDefault(); return; }
      if (!form?.matches?.('[data-channel-reply-policy]')) return;
      event.preventDefault();
      const data = new FormData(form), profile = data.get('profile');
      const body = profile === 'assistant' ? { profile, perHour: Number(data.get('perHour')), perMinute: Number(data.get('perMinute')), notice: String(data.get('notice') || '') } : { profile: 'attendance' };
      void saveAgentSetting(`channels/${encodeURIComponent(form.dataset.channelReplyPolicy)}/reply-policy`, body, t('Política de respostas salva.'), form.querySelector('button[type="submit"]'));
    });
  }
  function catalog() {
    const rows = list();
    return h`<section class="pg-channels__catalog" aria-labelledby="channels-catalog-title"><h2 id="channels-catalog-title" class="pg-channels__section-title">${t('Escolha a próxima conexão')}</h2>
      <ul class="pg-channels__catalog-grid">${CHANNEL_JOURNEY_IDS.map(id => {
        const journey = channelJourney(id, rows), kind = JOURNEY_KIND[id];
        const tone = { green: 'success', amber: 'warning', blue: 'info' }[journey.tone] || 'neutral';
        const candidates = journey.instances.map(instance => find(instance.id)).filter(Boolean);
        const existing = candidates.find(channel => !channelNextAction(channel, proof(channel)).complete) || candidates[0];
        const resume = existing ? button({ label: t(channelNextAction(existing, proof(existing)).complete ? 'Ver validação' : 'Continuar configuração'), variant: 'secondary', size: 'sm', icon: 'arrow', action: 'channels:resume', attrs: { 'data-id': existing.id, 'aria-label': t('Continuar {name}', { name: existing.name || journey.name }) } }) : '';
        const add = button({ label: t(existing ? 'Adicionar outro' : 'Conectar'), variant: existing ? 'ghost' : 'secondary', size: 'sm', icon: 'plus', action: 'channels:new', attrs: { 'data-id': kind, 'aria-label': t(existing ? 'Adicionar outro canal {name}' : 'Conectar {name}', { name: journey.name }) } });
        return h`<li class="pg-channels__offer">${kindTile(kind)}<div class="pg-channels__identity"><h3 class="pg-channels__name">${journey.name}</h3><p class="pg-channels__meta">${journey.description}</p>${existing ? h`<p class="pg-channels__hint">${existing.name || t('Conexão sem nome')} · ${channelNextAction(existing, proof(existing)).detail}</p>` : ''}</div>
          <div class="pg-channels__actions">${badge(journey.text, tone)}${admin() ? h`${resume}${add}` : ''}</div></li>`;
      })}</ul><p class="pg-channels__hint">${t('A API oficial do WhatsApp continua adiada. Configurar um canal não confirma a entrega de mensagens.')}</p></section>`;
  }
  function header() {
    return h`<header class="pg-channels__header"><div><h1 class="pg-channels__title">${t('Canais')}</h1><p class="pg-channels__lead">${tenant() ? t('As conexões de {company}. Cada conversa mantém a origem.', { company: tenant().name || t('Empresa') }) : t('Escolha uma empresa para ver as conexões.')}</p></div>
      ${admin() && tenant() && !tenant().demo ? button({ label: t('Adicionar canal'), variant: 'primary', icon: 'plus', action: 'channels:new', attrs: { 'data-id': 'whatsapp_qr' } }) : ''}</header>`;
  }
  function problemBanner(rows) {
    const down = rows.filter(channel => channelHealth(channel) === 'problem');
    if (!down.length) return '';
    const first = down[0];
    return banner({ tone: 'danger', title: down.length === 1 ? t('1 canal precisa de atenção') : t('{count} canais precisam de atenção', { count: down.length }),
      body: t('{name}: {state}.', { name: first.name || kindName(first.kind), state: STATE_NAMES()[first.state] || t('Desconectado') }),
      action: admin() ? { label: t('Reconectar'), action: 'channels:open', attrs: { 'data-id': first.id } } : null });
  }
  function listPage() {
    const rows = list(), last = lastConversationByChannel(tenant()?.conversations);
    if (!tenant()) return emptyState({ icon: 'building', title: t('Nenhuma empresa selecionada'), body: t('Escolha a empresa no seletor de escopo para ver os canais.') });
    const body = !rows.length ? emptyState({ icon: 'plug', title: t('Nenhum canal conectado ainda'), body: admin() ? t('Conecte o WhatsApp, o Telegram ou o chat do site para receber a primeira conversa.') : t('A administração da empresa conecta os canais.'), action: admin() ? { label: t('Conectar um canal'), action: 'channels:new', attrs: { 'data-id': 'whatsapp_qr' } } : null })
      : h`<section aria-labelledby="channels-list-title"><h2 id="channels-list-title" class="pg-channels__section-title">${t('Conexões de {company}', { company: tenant().name || t('Empresa') })} <span class="pg-channels__count">${rows.length}</span></h2><ul class="pg-channels__list">${rows.map(channel => card(channel, last))}</ul></section>`;
    // The demo company (tenant.demo) keeps its fictitious sandbox lines; the server refuses every real connection.
    if (tenant().demo) return h`${banner({ tone: 'info', title: t('Demonstração'), body: t('Empresa de demonstração não conecta canais. Use uma empresa real.') })}${body}`;
    return h`${problemBanner(rows)}${body}${catalog()}`;
  }

  function stepper(channel) {
    const labels = STEP_LABELS();
    const states = stepperStates(flow.step, { channel, connected: Boolean(channel) && connectionView(channel, flow.status).done, tested: durable(channel) ? flow.validation.dto?.state === 'validated' : flow.test.state === 'received', error: Boolean(flow.error) });
    if (durable(channel) && flow.validation.dto?.state !== 'validated') { const test = states.find(item => item.id === 'test'); if (test?.state === 'done') test.state = 'next'; }
    return h`<ol class="pg-channels__stepper" aria-label="${t('Etapas da conexão')}">${states.map((item, index) => h`<li class="pg-channels__step" data-state="${item.state}"><button type="button" class="pg-channels__step-button"${attributes({ 'data-action': 'channels:step', 'data-id': item.id, 'aria-current': item.state === 'current' || item.state === 'error' ? 'step' : null, disabled: item.disabled && !['current', 'error'].includes(item.state) })}><span class="pg-channels__step-mark" aria-hidden="true">${item.state === 'done' ? glyph('check') : String(index + 1)}</span><span>${labels[item.id]}</span><span class="sr-only">${item.state === 'done' ? t('concluída') : item.state === 'current' ? t('etapa atual') : item.state === 'error' ? t('com erro') : ''}</span></button></li>`)}</ol>`;
  }
  function nameStep() {
    const kind = flow.kind || 'whatsapp_qr', names = KIND_NAMES();
    return h`<form class="pg-channels__form" data-form="channels:create" novalidate>
      <fieldset class="pg-channels__kinds"><legend class="pg-channels__label">${t('Tipo de canal')}</legend>${CONNECTABLE_KINDS.map(value => h`<label class="pg-channels__kind-option"><input type="radio" name="kind" value="${value}"${attributes({ checked: value === kind })}/><span class="pg-channels__kind-label">${kindMark(value)}<span>${names[value]}</span>${value === 'webchat' ? h`<small class="pg-channels__hint">${t('pronto agora')}</small>` : ''}</span></label>`)}</fieldset>
      <label class="pg-channels__field"><span class="pg-channels__label">${t('Nome da conexão')}</span><input name="name" maxlength="48" required autocomplete="off" placeholder="${t('Ex.: Vendas')}" value="${flow.draft.name}"/></label>
      ${kind === 'whatsapp_qr' ? h`<label class="pg-channels__field"><span class="pg-channels__label">${t('Número com DDD')}</span><input name="expectedNumber" inputmode="tel" maxlength="20" required autocomplete="off" placeholder="11 9XXXX XXXX" aria-describedby="channels-number-hint channels-access-hint" value="${flow.draft.expectedNumber}"/><small id="channels-number-hint" class="pg-channels__hint">${t('O QR só é aceito quando lido por este número.')}</small><small id="channels-access-hint" class="pg-channels__hint">${t('As mensagens deste número entram nesta empresa. Em Equipe, confira as permissões; administradores da conta têm acesso a todas as empresas.')}</small></label>${qrRiskNotice()}` : ''}
      ${flow.error ? h`<p class="pg-channels__error" role="alert">${flow.error}</p>` : ''}
      <div class="pg-channels__footer">${button({ label: t('Cancelar'), variant: 'ghost', action: 'channels:close' })}${button({ label: t('Criar e conectar'), variant: 'primary', type: 'submit', busy: flow.busy })}</div></form>`;
  }
  // Non-dismissable risk notice shown before any WhatsApp QR is generated or displayed (name and connect steps).
  function qrRiskNotice() {
    return h`<div class="pg-channels__state pg-channels__risk" data-tone="warning" data-whatsapp-qr-risk role="note"><strong class="pg-channels__state-title">${t('Conexão não oficial: risco de bloqueio do número')}</strong><p>${t('O WhatsApp por QR Code usa uma sessão não oficial do WhatsApp Web (Baileys), não a API oficial da Meta/WhatsApp Business. Os termos do WhatsApp restringem clientes não oficiais e automatizados, e a Meta pode limitar, suspender ou banir o número conectado, a critério dela.')}</p><p>${t('Use seu próprio número dentro das regras do WhatsApp, sem envio em massa nem spam, e prefira um número dedicado. A Elozi não garante a disponibilidade desta conexão e não consegue recuperar um número banido.')} <a href="${getLocale() === 'en' ? '/en/terms#whatsapp-qr' : '/termos#whatsapp-qr'}" target="_blank" rel="noopener">${t('Ver Termos de uso')}</a></p></div>`;
  }
  function qrPanel(view) {
    if (view.state === 'qr' && view.qr) return h`<div class="pg-channels__qr"><img class="pg-channels__qr-image" data-flow-qr src="${view.qr}" alt="${t('Código QR de pareamento do WhatsApp')}" width="232" height="232"/></div>`;
    if (view.state === 'starting' || view.state === 'qr') return h`<div class="pg-channels__qr" data-loading="true"><span class="pg-channels__qr-skeleton" aria-hidden="true"></span></div>`;
    if (view.done) return h`<div class="pg-channels__done" aria-hidden="true"><svg class="pg-channels__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg></div>`;
    return '';
  }
  function connectStep(channel) {
    const view = connectionView(channel, flow.status), transport = channelTransport(channel), canAct = admin();
    if (transport === 'qr' && view.state === 'connected') view.body = connectionDisplayLabel({ ...channel, ...(flow.status || {}) }) || view.body;
    if (flow.statusStale && view.state === 'qr') view.body = t('O código exibido pode estar desatualizado. Aguarde a próxima verificação.');
    const notice = h`<div class="pg-channels__state" data-tone="${view.tone}" data-state="${view.state}"><strong class="pg-channels__state-title">${view.state === 'reconnecting' ? h`<span class="pg-channels__pulse" aria-hidden="true"></span>` : ''}${view.title}</strong><p>${view.body}</p></div>`;
    let detail = '', actions = '';
    if (transport === 'qr') {
      detail = h`${view.done ? '' : qrRiskNotice()}<div class="pg-channels__pair">${qrPanel(view)}${view.done ? '' : h`<ol class="pg-channels__howto"><li>${t('Abra o WhatsApp › Aparelhos conectados')}</li><li>${t('Toque em Conectar aparelho')}</li><li>${t('Aponte para este código')}</li></ol>`}</div>`;
      if (canAct && view.action) actions = button({ label: view.action.label, variant: 'primary', icon: 'refresh', action: 'channels:start', busy: flow.busy });
    } else if (transport === 'bot') {
      if (view.done) detail = qrPanel(view);
      else detail = h`<ol class="pg-channels__howto"><li>${t('Abra o @BotFather no Telegram')} <a class="ui-btn ui-btn--link ui-btn--sm" href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer"><span class="ui-btn__label">t.me/BotFather</span></a></li><li>${t('Envie o comando abaixo e escolha um nome e um usuário terminado em bot')}${codeBlock({ code: '/newbot', label: t('Comando do BotFather') })}</li><li>${t('Copie o token e cole aqui')}</li></ol>
        ${canAct ? h`<form class="pg-channels__form" data-form="channels:token" novalidate><label class="pg-channels__field"><span class="pg-channels__label">${t('Token do BotFather')}</span><span class="pg-channels__secret"><input name="token" type="${flow.reveal ? 'text' : 'password'}" maxlength="100" autocomplete="new-password" spellcheck="false" required aria-describedby="channels-token-hint"/>${button({ label: flow.reveal ? t('Ocultar') : t('Mostrar'), variant: 'ghost', size: 'sm', action: 'channels:reveal', attrs: { 'aria-pressed': flow.reveal ? 'true' : 'false' } })}</span><small id="channels-token-hint" class="pg-channels__hint">${t('Guardado cifrado. Nunca aparece de novo no painel.')}</small></label>
          <div class="pg-channels__footer">${button({ label: view.action?.label || t('Conectar bot'), variant: 'primary', type: 'submit', busy: flow.busy })}</div></form>` : ''}`;
    } else if (transport === 'connector') {
      const journey = channelJourney(channel.kind, [channel]);
      detail = journey ? h`<ol class="pg-channels__howto">${journey.steps.slice(1).map(step => h`<li><strong>${step.label}</strong> ${step.detail}</li>`)}</ol>` : '';
      if (canAct) actions = button({ label: view.action.label, variant: view.done ? 'secondary' : 'primary', icon: 'gear', action: 'configure-channel', attrs: { 'data-id': channel.id } });
    }
    const next = view.done ? button({ label: t('Testar agora'), variant: 'primary', icon: 'arrow', action: 'channels:step', attrs: { 'data-id': 'test' } }) : '';
    const botProfile = canAct && transport === 'bot' && view.done ? button({ label: t('Personalizar bot'), variant: 'secondary', icon: 'palette', action: 'telegram-profile', attrs: { 'data-id': channel.id } }) : '';
    return h`${notice}${flow.statusStale ? h`<p class="pg-channels__hint" data-flow-stale role="status">${t('Não foi possível atualizar esta conexão; verificando novamente.')}</p>` : ''}${detail}${flow.error ? h`<p class="pg-channels__error" role="alert">${flow.error}</p>` : ''}${canAct ? '' : h`<p class="pg-channels__hint">${t('Somente a administração da empresa conecta canais.')}</p>`}<div class="pg-channels__footer">${actions}${next}${botProfile}</div>`;
  }
  function testInstructions(channel) {
    const transport = channelTransport(channel), suffix = expectedSuffix(channel) || /(\d{4})\D*$/.exec(typeof channel.label === 'string' ? channel.label : '')?.[1] || '';
    if (transport === 'qr') return suffix ? t('Envie "oi" de outro celular para o número com final {suffix}.', { suffix }) : t('Envie "oi" de outro celular para este número.');
    if (transport === 'bot') return channel.botUsername ? t('Envie /start para @{bot} no Telegram.', { bot: channel.botUsername }) : t('Envie /start para o bot no Telegram.');
    if (channel.kind === 'webchat') return t('Abra o chat no site autorizado e envie "oi".');
    if (channel.kind === 'email') return t('Envie um e-mail para o endereço configurado.');
    return t('Envie uma mensagem para a conta conectada.');
  }
  function durableTestStep(channel) {
    if (!admin()) return h`<p class="pg-channels__hint">${t('A validação do canal é feita pela administração da empresa.')}</p>`;
    const { dto, error, busy, paused } = flow.validation, state = dto?.state || 'loading';
    const titles = { loading: 'Consultando a validação salva…', not_started: 'Teste de ida e volta pendente', waiting_incoming: 'Aguardando uma nova mensagem', waiting_reply: 'Mensagem recebida · falta responder', waiting_confirmation: 'Resposta registrada · confirme o destino', validated: 'Canal validado', stale: 'A configuração mudou · valide novamente' };
    const detail = state === 'validated' ? t('Entrada, resposta e destino confirmados.') : state === 'waiting_reply' ? t('Abra a conversa no Atendimento e envie uma resposta autorizada. Depois, volte a este teste.')
      : state === 'waiting_confirmation' ? t('Confira no aparelho ou site de destino se a resposta chegou. O registro de envio não confirma o recebimento.')
        : state === 'stale' ? t('O teste anterior não comprova a configuração atual. Reconecte ou revise o canal e comece novamente.')
          : state === 'loading' ? t('A prova fica salva no servidor e pode ser retomada neste canal.') : testInstructions(channel);
    const inbox = dto?.conversationId && canReadInbox() ? h`<a class="ui-btn ui-btn--primary ui-btn--md" href="${inboxHash(dto.tenantId, dto.conversationId)}"><span class="ui-btn__label">${t('Abrir no Atendimento')}</span></a>` : '';
    const confirmable = state === 'waiting_confirmation' && dto.startedAt && dto.conversationId && dto.incomingRecorded && dto.replyRecorded && dto.channelAvailable && !error;
    const start = dto && ['not_started', 'stale'].includes(state) && dto.channelAvailable && !error ? button({ label: t(state === 'stale' ? 'Começar novo teste' : 'Começar teste'), variant: 'primary', action: 'channels:test', busy }) : '';
    const groups = hasGroups(channel) ? button({ label: t('Escolher grupos'), variant: 'secondary', action: 'channels:step', attrs: { 'data-id': 'groups' } }) : '';
    const visitor = channel.kind === 'webchat' && deps.visitorTestUI ? h`<a class="ui-btn ui-btn--secondary ui-btn--md" target="_blank" rel="noopener" href="${formatHash({section:'channels',params:{channelId:channel.id,tab:'visitor'},query:{},workspaceId:deps.state?.workspaceId||null})}"><span class="ui-btn__label">${t('Abrir chat visitante de teste')}</span></a>` : '';
    return h`<div class="pg-channels__state" data-tone="${error ? 'danger' : state === 'validated' ? 'success' : state === 'stale' ? 'warning' : 'info'}" data-state="${state}" aria-busy="${busy ? 'true' : 'false'}"><strong class="pg-channels__state-title">${t(titles[state])}</strong><p>${detail}</p>
      ${dto ? h`<ol class="pg-channels__validation"><li data-complete="${dto.incomingRecorded}">${glyph(dto.incomingRecorded ? 'check' : 'chat')}${t('1. Nova mensagem recebida')}</li><li data-complete="${dto.replyRecorded}">${glyph(dto.replyRecorded ? 'check' : 'send')}${t('2. Resposta registrada no Atendimento')}</li><li data-complete="${dto.recipientConfirmed}">${glyph(dto.recipientConfirmed ? 'check' : 'shield')}${t('3. Recebimento confirmado no destino')}</li></ol>` : ''}
      ${error ? h`<p class="pg-channels__hint" role="alert">${t(denied(error) ? 'Seu acesso mudou ou expirou. Atualize a página.' : 'Não foi possível consultar a validação. Confira o estado salvo antes de continuar.')}</p>` : ''}${paused ? h`<p class="pg-channels__hint">${t('A consulta automática pausou. A prova continua salva; atualize para retomar.')}</p>` : ''}</div>
      ${confirmable ? h`<form class="pg-channels__form" data-form="channels:validation-confirm"><label class="pg-channels__confirmation"><input type="checkbox" name="recipientConfirmed" required/><span>${t('Conferi no destino que a resposta chegou à pessoa ou ao site corretos.')}</span></label><div class="pg-channels__footer">${button({ label: t('Confirmar validação'), variant: 'primary', type: 'submit', busy })}</div></form>` : ''}
      <p class="pg-channels__hint">${t('Começar o teste não envia mensagens. Use uma conversa de teste autorizada.')}</p>
      ${state === 'waiting_incoming' ? h`<p class="pg-channels__hint">${t('Depois de começar, aguarde um segundo antes de enviar a nova mensagem.')}</p>` : ''}
      <div class="pg-channels__footer">${start}${visitor}${inbox}${dto || error || paused ? button({ label: t('Atualizar validação'), variant: 'secondary', action: 'channels:test-refresh', disabled: busy }) : ''}${groups}</div>`;
  }
  function testStep(channel) {
    const test = flow.test;
    if (!connectionView(channel, flow.status).done) return h`<div class="pg-channels__state" data-tone="info"><strong class="pg-channels__state-title">${t('Conecte o canal primeiro')}</strong><p>${t('O teste começa quando a conexão estiver pronta.')}</p></div><div class="pg-channels__footer">${button({ label: t('Voltar para Conectar'), variant: 'secondary', action: 'channels:step', attrs: { 'data-id': 'connect' } })}</div>`;
    if (durable(channel)) return durableTestStep(channel);
    if (!canReadInbox()) return h`<p class="pg-channels__hint">${t('O teste lê o Atendimento, que não está no seu acesso.')}</p>`;
    const groupsNext = hasGroups(channel) ? button({ label: t('Escolher grupos'), variant: 'secondary', action: 'channels:step', attrs: { 'data-id': 'groups' } }) : '';
    if (test.state === 'received') {
      const at = stamp(test.result.at) ? new Date(stamp(test.result.at)).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : '';
      return h`<div class="pg-channels__state" data-tone="success" data-state="received"><strong class="pg-channels__state-title">${at ? t('Recebida às {time}', { time: at }) : t('Mensagem recebida')}</strong>${test.result.text ? h`<blockquote class="pg-channels__quote">${test.result.text}</blockquote>` : ''}<p>${t('A ida funcionou. Responda pelo Atendimento para conferir a volta.')}</p></div>
        <div class="pg-channels__footer"><a class="ui-btn ui-btn--primary ui-btn--md" href="${inboxHash(test.result.tenantId, test.result.conversationId)}"><span class="ui-btn__label">${t('Abrir no Atendimento')}</span></a>${groupsNext}</div>`;
    }
    const waiting = test.state === 'waiting';
    return h`<div class="pg-channels__state" data-tone="${test.state === 'error' ? 'danger' : 'info'}" data-state="${waiting ? 'waiting' : test.state}"><strong class="pg-channels__state-title">${waiting ? h`<span class="pg-channels__pulse" aria-hidden="true"></span>${t('Aguardando a primeira mensagem…')}` : test.state === 'error' ? t('O teste parou') : t('Teste de ida e volta')}</strong><p>${testInstructions(channel)}</p>${test.error && test.state === 'waiting' ? h`<p class="pg-channels__hint">${t('Sem resposta do servidor agora. Tentando de novo.')}</p>` : ''}${test.state === 'error' ? h`<p class="pg-channels__hint">${t('Seu acesso mudou ou expirou. Atualize a página.')}</p>` : ''}</div>
      <div class="pg-channels__footer">${waiting ? button({ label: t('Parar teste'), variant: 'ghost', action: 'channels:test-stop' }) : button({ label: t('Começar teste'), variant: 'primary', action: 'channels:test' })}${groupsNext}</div>`;
  }
  function groupsSection(channel, { compact = false } = {}) {
    const transport = channelTransport(channel), connected = channel.state === 'connected', canAct = admin();
    if (transport === 'qr') {
      const count = Number.isSafeInteger(channel.enabledGroups) ? channel.enabledGroups : 0;
      return h`<div class="pg-channels__state" data-tone="info"><strong class="pg-channels__state-title">${count === 1 ? t('1 grupo no atendimento') : t('{count} grupos no atendimento', { count })}</strong><p>${t('Escolha os grupos que entram na caixa. Desmarcar interrompe novas entradas; o histórico já recebido fica.')}</p></div>
        <div class="pg-channels__footer">${canAct ? button({ label: t('Escolher grupos'), variant: compact ? 'secondary' : 'primary', icon: 'users', action: 'channel-groups', disabled: !connected, attrs: { 'data-id': channel.id } }) : ''}</div>${canAct && !connected ? h`<p class="pg-channels__hint">${t('Conecte o número para listar os grupos.')}</p>` : ''}`;
    }
    if (transport === 'bot') {
      const bot = typeof channel.botUsername === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(channel.botUsername) ? channel.botUsername : '', all = channel.groupSelectionMode !== 'selected';
      const selected = Number.isSafeInteger(channel.selectedGroups) ? channel.selectedGroups : 0;
      return h`<div class="pg-channels__state" data-tone="info"><strong class="pg-channels__state-title">${all ? t('Todos os grupos do bot entram no atendimento') : selected === 1 ? t('1 grupo selecionado') : t('{count} grupos selecionados', { count: selected })}</strong>
        <p>${channel.groupReadMode === 'all' ? t('O bot lê todas as mensagens dos grupos.') : t('Com a privacidade ativa, o bot só recebe o que for dirigido a ele. Para atender o grupo inteiro, use /setprivacy no @BotFather e adicione o bot de novo.')}</p></div>
        <div class="pg-channels__footer">${bot ? h`<a class="ui-btn ui-btn--secondary ui-btn--md" href="${`https://t.me/${bot}?startgroup=true`}" target="_blank" rel="noopener noreferrer"><span class="ui-btn__label">${t('Adicionar o bot a um grupo')}</span></a>` : ''}${canAct ? button({ label: t('Escolher grupos'), variant: 'primary', icon: 'users', action: 'telegram-groups', disabled: !connected, attrs: { 'data-id': channel.id } }) : ''}${canAct && connected ? button({ label: t('Personalizar bot'), variant: 'ghost', icon: 'palette', action: 'telegram-profile', attrs: { 'data-id': channel.id } }) : ''}</div>${canAct && !connected ? h`<p class="pg-channels__hint">${t('Conecte o bot para listar os grupos.')}</p>` : ''}`;
    }
    return emptyState({ icon: 'users', title: t('Este canal não tem grupos'), body: t('Grupos existem no WhatsApp e no Telegram.'), level: 3 });
  }
  function discardPrompt() {
    return h`<div class="pg-channels__state" data-tone="warning" data-state="discard" role="group" aria-labelledby="channel-discard-title"><strong id="channel-discard-title" class="pg-channels__state-title">${t('Descartar alterações?')}</strong><p>${t('O que você digitou nesta conexão ainda não foi salvo.')}</p>
      <div class="pg-channels__footer">${button({ label: t('Continuar editando'), variant: 'secondary', action: 'channels:keep' })}${button({ label: t('Descartar'), variant: 'danger', action: 'channels:discard' })}</div></div>`;
  }
  function missing() {
    return emptyState({ icon: 'plug', title: t('Este canal não está nesta empresa'), body: t('Ele pode ter sido removido ou pertencer a outra empresa.'), action: { label: t('Voltar para Canais'), action: 'channels:close' }, level: 3 });
  }
  function drawer() {
    const channel = flowChannel(), creating = !flow.channelId;
    const title = creating ? t('Novo canal') : channel ? h`${kindName(channel.kind)} · ${channel.name || t('Conexão sem nome')}` : t('Canal não encontrado');
    const body = creating ? nameStep() : !channel ? missing() : flow.step === 'test' ? testStep(channel) : flow.step === 'groups' ? groupsSection(channel) : connectStep(channel);
    const enter = flow.focused ? null : 'true';
    return h`<div class="pg-channels__scrim" data-action="channels:close" aria-hidden="true"${attributes({ 'data-enter': enter })}></div><aside class="pg-channels__drawer" role="dialog" aria-modal="true" aria-labelledby="channel-flow-title" data-channel-flow="${flow.key}"${attributes({ 'data-enter': enter })}>
      <header class="pg-channels__drawer-head"><div class="pg-channels__identity"><p class="pg-channels__meta">${companyMark(tenant())}</p><h2 id="channel-flow-title" class="pg-channels__drawer-title" tabindex="-1">${title}</h2></div>${iconButton({ label: t('Fechar'), icon: 'close', action: 'channels:close', kbd: 'Esc' })}</header>
      <p class="sr-only" role="status" data-flow-live></p>
      <div class="pg-channels__drawer-body" data-flow-body>${flow.confirmClose ? discardPrompt() : ''}${!creating && !channel ? '' : stepper(channel)}<section class="pg-channels__panel" aria-labelledby="channel-step-title"><h3 id="channel-step-title" class="sr-only">${STEP_LABELS()[flow.step]}</h3>${body}</section></div></aside>`;
  }
  function groupsPage(channel) {
    const conversations = (tenant()?.conversations || []).filter(item => item?.channelId === channel.id && item.conversationKind === 'group').sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt)).slice(0, 20);
    return h`<header class="pg-channels__header"><div><a class="ui-btn ui-btn--link ui-btn--sm" href="#channels"><span class="ui-btn__label">${t('‹ Canais')}</span></a><h1 class="pg-channels__title">${t('Grupos · {name}', { name: channel.name || kindName(channel.kind) })}</h1><p class="pg-channels__lead">${kindName(channel.kind)} · ${healthBadge(channel)}</p></div></header>
      <section class="pg-channels__groups" aria-labelledby="channel-groups-title"><h2 id="channel-groups-title" class="pg-channels__section-title">${t('Grupos no atendimento')}</h2>${groupsSection(channel)}</section>
      ${hasGroups(channel) ? h`<section class="pg-channels__groups" aria-labelledby="channel-group-list-title"><h2 id="channel-group-list-title" class="pg-channels__section-title">${t('Conversas de grupo carregadas')}</h2>${conversations.length ? h`<ul class="pg-channels__group-list">${conversations.map(item => h`<li><span class="pg-channels__name">${item.contact || t('Grupo')}</span><span class="pg-channels__meta">${relativeTime(item.updatedAt)}</span><a class="ui-btn ui-btn--ghost ui-btn--sm" href="${inboxHash(tenant().id, item.id)}"><span class="ui-btn__label">${t('Abrir no Atendimento')}</span></a></li>`)}</ul><p class="pg-channels__hint">${t('Para trazer mensagens anteriores de um grupo, abra a conversa no Atendimento e use a busca de histórico.')}</p>` : h`<p class="pg-channels__hint">${t('As conversas dos grupos escolhidos aparecem aqui e no Atendimento.')}</p>`}</section>` : ''}`;
  }

  /** The page for #channels[/<channelId>[/connect|groups]] · #channels/new/<kind>. */
  function view(route) {
    const params = route?.section === 'channels' ? route.params || {} : {};
    if (params.tab === 'visitor' && deps.visitorTestUI) {
      pageMounted = false; closeFlow();
      return deps.visitorTestUI.view(route);
    }
    deps.visitorTestUI?.reset();
    if (flow && flow.scope !== scope()) closeFlow();
    if (proofScope !== scope() || proofSession !== session() || !admin()) {
      if (flow && proofSession !== session()) { validation?.stop(); validation = null; flow.validation = { dto: null, error: null, busy: false, paused: false }; }
      proofs.clear(); proofScope = scope(); proofSession = session(); batchAsked = false; batchToken++;
    }
    if (params.channelId && params.tab === 'groups'&&find(params.channelId)?.kind!=='telegram_user') {
      syncFlow(null);
      const channel = find(params.channelId);
      return String(h`<div class="pg-channels">${channel ? groupsPage(channel) : h`${header()}${missing()}`}</div>`);
    }
    const current = syncFlow(route);
    if (current && !current.channelId && !admin()) closeFlow();
    return String(h`<div class="pg-channels"${attributes({ 'data-flow-open': flow ? 'true' : null })}>${header()}${listPage()}${flow ? drawer() : ''}</div>`);
  }

  // ---- live parts -------------------------------------------------------------------------------
  function announce(message) { const live = doc()?.querySelector?.('[data-flow-live]'); if (live && message && flow && flow.announced !== message) { flow.announced = message; live.textContent = message; } }
  function patch({ focusStep = false } = {}) {
    if (!isOpen()) return;
    const root = doc().querySelector('[data-flow-body]');
    if (!root) return;
    const active = doc().activeElement, keep = root.contains(active) ? { action: active.dataset?.action || null, id: active.dataset?.id ?? null, name: active.name || null } : null;
    const template = doc().createElement('template');
    template.innerHTML = String(drawer());
    const fresh = template.content.querySelector('[data-flow-body]');
    if (!fresh) return;
    const qr = root.querySelector('[data-flow-qr]'), nextQr = fresh.querySelector('[data-flow-qr]');
    if (qr && nextQr && !flow.statusStale && !root.querySelector('[data-flow-stale]') && root.querySelector('.pg-channels__state')?.dataset.state === fresh.querySelector('.pg-channels__state')?.dataset.state && !flow.error && root.querySelector('.pg-channels__error') === null) {
      if (qr.getAttribute('src') !== nextQr.getAttribute('src')) {
        qr.setAttribute('src', nextQr.getAttribute('src'));
        if (motionOK() && typeof qr.animate === 'function') qr.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      }
      return;
    }
    // What the person typed (the token included) moves to the fresh controls of the same form, so
    // an error, the busy state or a status change never empties a field. Nothing is stored.
    const formOf = node => node.closest?.('[data-form]')?.dataset.form || '';
    const typed = new Map([...root.querySelectorAll(TYPED)].map(node => [`${formOf(node)}|${node.name}`, node.value]));
    root.replaceChildren(...fresh.childNodes);
    for (const node of root.querySelectorAll(TYPED)) { const value = typed.get(`${formOf(node)}|${node.name}`); if (value) node.value = value; }
    const target = keep && [...root.querySelectorAll(keep.name ? `[name="${keep.name}"]` : '[data-action]')].find(node => keep.name || node.dataset.action === keep.action && (node.dataset.id ?? null) === keep.id);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else if (focusStep || keep) doc().getElementById('channel-flow-title')?.focus({ preventScroll: true });
  }
  function onStatus(status) {
    if (!flow) return false;
    const channel = flowChannel(), before = flow.lastConnectionView || connectionView(channel, flow.status);
    const wasStale = flow.statusStale;
    flow.statusStale = false;
    flow.status = status && typeof status === 'object' ? status : null;
    const after = connectionView(channel, flow.status);
    flow.lastConnectionView = after;
    if (wasStale || after.state !== before.state || after.qr !== before.qr || after.title !== before.title || after.body !== before.body || after.poll !== before.poll) patch();
    if (after.state !== before.state || after.title !== before.title) announce(after.title);
    if (after.done && !before.done && flow.step === 'connect') {
      const key = flow.key;
      autoAdvance = globalThis.setTimeout(() => { autoAdvance = null; if (flow?.key === key && flow.step === 'connect' && isOpen()) { flow.step = 'test'; patch({ focusStep: true }); startProbe(); } }, motionOK() ? 1400 : 600);
      void services().refresh?.();
    }
    return after.poll;
  }
  function startPoller({ immediate = true } = {}) {
    const channel = flowChannel();
    if (!channel || !admin() || !['qr', 'bot'].includes(channelTransport(channel))) return;
    poller?.stop();
    const currentFlow = flow, authority = session(), currentScope = scope();
    let observer;
    const current = () => poller === observer && flow === currentFlow && scope() === currentScope && session() === authority && admin() && flow.step === 'connect' && isOpen();
    observer = createPoller({ interval: 2000, active: current, tick: async ({ isCurrent }) => {
      let status;
      try { status = await request(tenantPath(`channels/${encodeURIComponent(channel.id)}/connection`)); }
      catch (error) {
        // Expired session or access removed: stop asking (the session dialog takes over; reauth-ok resumes).
        if (!current()) return false;
        if (!isCurrent()) return true;
        if (denied(error)) { flow.error = t('Seu acesso mudou ou expirou. Atualize a página.'); patch(); return false; }
        if (doc()?.visibilityState !== 'hidden' && !flow.statusStale) {
          flow.statusStale = true; patch();
          announce(t('Não foi possível atualizar esta conexão; verificando novamente.'));
        }
        return true;
      }
      // Ignore answers after close/reopen, revocation or hiding; resume with a fresh GET.
      if (!current()) return false;
      if (!isCurrent()) return true;
      return doc()?.visibilityState === 'hidden' ? true : onStatus(status);
    } });
    poller = observer;
    observer.start({ immediate });
  }
  function startProbe() {
    const channel = flowChannel();
    if (channel && durable(channel)) { openValidation(); return; }
    if (!channel || !canReadInbox() || !connectionView(channel, flow.status).done) return;
    probe?.stop();
    const key = flow.key;
    probe = createRoundTripTest({ request: path => request(path), tenantId: tenant().id, channelId: channel.id, active: () => flow?.key === key && flow.step === 'test' && isOpen(),
      onChange: value => { if (flow?.key !== key) return; flow.test = { state: value.state, result: value.result, error: value.error }; patch(); announce(value.state === 'received' ? t('Mensagem recebida') : value.state === 'waiting' ? t('Aguardando a primeira mensagem…') : ''); } }).start();
  }
  function openValidation() {
    const channel = flowChannel();
    if (!channel || !durable(channel) || !admin() || !isOpen() || !liveVisible()) return;
    if (validation) { if (flow.validation.busy && !validation.busy) void validation.refresh(); return; }
    const currentFlow = flow, key = flow.key, currentScope = scope(), currentSession = session();
    const active = () => flow === currentFlow && flow.key === key && scope() === currentScope && session() === currentSession && admin() && flow.step === 'test' && isOpen() && !doc()?.querySelector?.('dialog[open]');
    validation = createChannelValidation({ request, tenantId: tenant().id, channelId: channel.id, active,
      onChange: value => { if (!active()) return; flow.validation = value; if (value.dto) { proofs.set(channel.id, value.dto); proofScope = currentScope; proofSession = currentSession; } else if (value.error) proofs.delete(channel.id); patchList(); patch(); } });
    void validation.open();
  }

  function patchList() {
    if (!pageMounted || !liveVisible()) return;
    const root = doc()?.querySelector?.('.pg-channels__list'), catalogRoot = doc()?.querySelector?.('.pg-channels__catalog');
    if (!root && !catalogRoot || !doc()?.createElement) return;
    const active = doc().activeElement, focus = active?.dataset?.action ? { action: active.dataset.action, id: active.dataset.id } : null;
    const template = doc().createElement('template'); template.innerHTML = String(listPage());
    const nextList = template.content.querySelector('.pg-channels__list'), nextCatalog = template.content.querySelector('.pg-channels__catalog');
    if (root && nextList) root.replaceChildren(...nextList.childNodes);
    if (catalogRoot && nextCatalog) catalogRoot.replaceChildren(...nextCatalog.childNodes);
    if (focus && (root?.contains(active) || catalogRoot?.contains(active) || !active?.isConnected)) [...(doc().querySelectorAll?.('[data-action]') || [])].find(node => node.dataset.action === focus.action && node.dataset.id === focus.id)?.focus?.({ preventScroll: true });
  }
  async function loadValidations() {
    if (deps.durableOnboarding !== true || !admin() || !tenant() || batchAsked || !liveVisible()) return;
    const currentScope = scope(), currentSession = session(), epoch = pageEpoch, token = ++batchToken, tenantId = tenant().id;
    const ids = new Set(list().map(channel => channel.id));
    const previous = new Map([...ids].map(id => [id, proofs.get(id)]));
    if (!ids.size) return;
    batchAsked = true;
    const current = () => pageMounted && epoch === pageEpoch && token === batchToken && currentScope === scope() && currentSession === session() && admin() && liveVisible();
    try {
      const page = await request(tenantPath('channels/onboarding'));
      if (!current()) return;
      const projected = new Map(normalizeChannelValidationPage(page, { tenantId, channelIds: [...ids] }).map(value => [value.channelId, value]));
      proofScope = currentScope; proofSession = currentSession;
      for (const [id, value] of projected) if (proofs.get(id) === previous.get(id) && (!proofs.has(id) || proofs.get(id).version <= value.version)) proofs.set(id, value);
      patchList();
    } catch { if (current()) { for (const id of ids) if (proofs.get(id) === previous.get(id)) proofs.delete(id); patchList(); } }
  }
  async function startConnection() {
    const channel = flowChannel();
    if (!channel || !admin() || channelTransport(channel) !== 'qr' || flow.busy || connectionView(channel, flow.status).poll) return;
    const key = flow.key;
    flow.busy = true; flow.error = ''; patch();
    try { const status = await request(tenantPath(`channels/${encodeURIComponent(channel.id)}/connect`), { method: 'POST', body: '{}' }); if (flow?.key === key) { onStatus(status); startPoller({ immediate: false }); } }
    catch (error) { if (flow?.key === key) flow.error = error?.message || t('Não foi possível iniciar a conexão. Tente novamente.'); }
    finally { if (flow?.key === key) { flow.busy = false; patch(); } }
  }

  function keyboard(event) {
    if (event.key === 'Escape') { if (doc()?.querySelector?.('dialog[open]')) return; event.preventDefault(); event.stopPropagation(); void act(flow?.confirmClose ? 'channels:keep' : 'channels:close'); return; }
    if (event.key !== 'Tab') return;
    const panel = event.currentTarget;
    const focusable = [...panel.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(node => node.getClientRects?.().length !== 0);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (doc().activeElement === first || !panel.contains(doc().activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc().activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function kindChanged(event) {
    const input = event.target;
    if (input?.name !== 'kind' || !flow || flow.channelId || !CONNECTABLE_KINDS.includes(input.value)) return;
    flow.kind = input.value; flow.error = '';
    try { globalThis.history?.replaceState(globalThis.history.state, '', channelsHash({ kind: flow.kind })); } catch { /* the drawer keeps its own state */ }
    patch();
    doc().querySelector(`[data-form="channels:create"] [name="kind"][value="${flow.kind}"]`)?.focus({ preventScroll: true });
  }
  // Name and number of a new channel are not secret: they live in the drawer state, so a full render
  // of the page keeps them too. The token never does (only the DOM field holds it).
  function typedInput(event) {
    const input = event.target;
    if (!flow || flow.channelId || !['name', 'expectedNumber'].includes(input?.name) || !input.closest?.('[data-form="channels:create"]')) return;
    flow.draft = { ...flow.draft, [input.name]: String(input.value ?? '').slice(0, input.name === 'name' ? 48 : 20) };
  }
  const dirty = () => Boolean(flow && (!flow.channelId && (flow.draft.name.trim() || flow.draft.expectedNumber.trim())
    || [...(doc()?.querySelectorAll?.(`[data-flow-body] ${TYPED}`) || [])].some(node => String(node.value || '').trim())));
  // Expired session (session-guard.js): stop asking while its dialog is open; resume the connection after it.
  function bindSession() {
    if (sessionBound || typeof globalThis.addEventListener !== 'function') return;
    sessionBound = true;
    globalThis.addEventListener('elozi:reauth', () => { pendingTelegramAccount = null; stopLive(); proofs.clear(); batchAsked = false; batchToken++; });
    globalThis.addEventListener('hashchange', event => {
      const hash = typeof event?.newURL === 'string' ? new URL(event.newURL).hash : globalThis.location?.hash;
      const route = parseHash(hash);
      if (route?.section !== 'channels') { pageMounted = false; pageEpoch++; batchToken++; batchAsked = false; stopLive(); }
      // A deep-link handler may queue the list redirect during this same hashchange dispatch.
      if (pendingTelegramAccount && !listRoute(route) && !(route?.section === 'channels' && route.params?.channelId === pendingTelegramAccount.channelId)) pendingTelegramAccount = null;
    });
    globalThis.addEventListener('elozi:reauth-ok', () => {
      if (!flow || !isOpen()) return;
      flow.error = ''; patch();
      if (flow.step === 'connect' && !poller?.running) startPoller();
      if (flow.step === 'test') openValidation();
    });
  }
  /** After each render of the view: focus and keyboard of the drawer, then the live parts it needs. */
  // Webchats without the logo of their current site ask the server once per page (administrators only); one tenant
  // refresh afterwards shows the logos that were found.
  const siteIconAsked = new Set();
  async function refreshSiteIcons() {
    if (!admin() || !tenant()) return;
    const pending = list().filter(channel => {
      const origin = channel.kind === 'webchat' ? (channel.webchat?.origins || []).find(value => typeof value === 'string' && value.startsWith('https://')) : null;
      const key = JSON.stringify([scope(), channel.id, origin]);
      if (!origin || channel.siteIcon?.origin === origin || siteIconAsked.has(key)) return false;
      siteIconAsked.add(key); return true;
    });
    if (!pending.length) return;
    const answers = await Promise.all(pending.map(channel => request(tenantPath(`channels/${encodeURIComponent(channel.id)}/site-icon`), { method: 'POST', body: '{}' }).catch(() => null)));
    if (answers.some(answer => answer?.siteIcon?.src) && typeof services().refresh === 'function') await services().refresh();
  }

  function mount(main,route) {
    if (route?.section === 'channels' && route.params?.tab === 'visitor' && deps.visitorTestUI) return deps.visitorTestUI.mount(main,route);
    pageMounted = true;
    if (!validationVisibilityBound && doc()?.addEventListener) {
      validationVisibilityBound = true;
      doc().addEventListener('visibilitychange', () => { if (!pageMounted) return; if (doc()?.visibilityState === 'hidden') { batchToken++; batchAsked = false; } else void loadValidations(); });
    }
    bindSession(); bindAgentSettings();
    const personal=route?.params?.channelId?find(route.params.channelId):null;
    if(personal?.kind==='telegram_user'&&admin()){queueTelegramAccount(personal);return;}
    const root = main || doc(), panel = root?.querySelector?.('[data-channel-flow]');
    if (root?.querySelector?.('[data-channel-card]')) { void refreshSiteIcons().catch(() => {}); void loadValidations(); }
    if (!panel || !flow) {
      stopLive();
      if (returnFocus) {
        const target = returnFocus; returnFocus = null;
        const nodes = [...(root?.querySelectorAll?.(target.channelId ? '[data-channel-card] [data-action="channels:open"]' : '[data-action="channels:new"]') || [])];
        (nodes.find(node => node.dataset.id === (target.channelId || target.kind)) || (target.channelId ? null : nodes[0]))?.focus({ preventScroll: true });
      }
      // The shell has committed screenRoutes and synchronized old modals before this list mount.
      openPendingTelegramAccount(route);
      return;
    }
    panel.addEventListener('keydown', keyboard);
    panel.addEventListener('change', kindChanged);
    panel.addEventListener('input', typedInput);
    bindSession();
    const focus = doc()?.activeElement;
    if (!flow.focused || !focus || focus === doc().body) { flow.focused = true; panel.querySelector('#channel-flow-title')?.focus({ preventScroll: true }); }
    const channel = flowChannel();
    if (!channel) return;
    if (flow.step === 'connect' && !poller?.running) {
      if (flow.autostart && channelTransport(channel) === 'qr') { flow.autostart = false; void startConnection(); }
      else startPoller();
    }
    if (flow.step === 'test' && !probe?.running && flow.test.state !== 'received') startProbe();
  }

  // ---- actions and forms ------------------------------------------------------------------------
  const go = target => { if (globalThis.location) globalThis.location.hash = target; };
  async function act(name, id = null) {
    if (name.startsWith('channels:visitor-')) return deps.visitorTestUI?.act(name,id) ?? true;
    switch (name) {
      case 'channels:new': if (admin()) { opener = CONNECTABLE_KINDS.includes(id) ? id : 'whatsapp_qr'; go(channelsHash({ kind: opener })); } return true;
      case 'channels:resume': { const channel = find(id); if (!channel || !admin()) return true; if (channel.kind === 'telegram_user') { await deps.openTelegramAccount?.(channel); return true; } go(channelsHash({ channelId: id, tab: channelNextAction(channel, proof(channel)).step })); return true; }
      case 'channels:open': if(id&&find(id)?.kind==='telegram_user'){await deps.openTelegramAccount?.(find(id));return true;}if (id && find(id)) go(channelsHash({ channelId: id, tab: 'connect' })); return true;
      case 'channels:groups': if(id&&find(id)?.kind==='telegram_user'){await deps.openTelegramAccount?.(find(id));return true;}if (id && find(id)) go(channelsHash({ channelId: id, tab: 'groups' })); return true;
      case 'channels:agenda': {
        if (!id || !find(id) || !admin() || agendaBusy.has(id)) return true;
        agendaBusy.add(id); void services().refresh?.();
        notify(t('Sincronizando a agenda do WhatsApp…'));
        try {
          const result = await request(tenantPath(`channels/${encodeURIComponent(id)}/address-book-sync`), { method: 'POST', body: '{}' });
          const contacts = Number(result?.contacts) || 0, renamed = Number(result?.renamed) || 0;
          notify(renamed ? t('Agenda sincronizada: {contacts} contatos salvos; {renamed} conversas agora usam o nome da agenda.', { contacts, renamed }) : t('Agenda sincronizada: {contacts} contatos salvos. Para trazê-los ao CRM, use Contatos › Importar contatos.', { contacts }));
        } catch (error) { notify(error?.message || t('Não foi possível sincronizar a agenda.'), 'error'); }
        finally { agendaBusy.delete(id); void services().refresh?.(); }
        return true;
      }
      case 'channels:close':
        // A changed form asks first (§4.3 "Descartar alterações?"): Esc, the scrim, Cancelar and Fechar.
        if (flow && !flow.confirmClose && isOpen() && dirty()) {
          flow.confirmClose = true; patch();
          doc().querySelector('[data-action="channels:keep"]')?.focus({ preventScroll: true });
          announce(t('Descartar alterações?'));
          return true;
        }
        returnFocus = focusTarget(); closeFlow(); go('#channels'); return true;
      case 'channels:discard': returnFocus = focusTarget(); closeFlow(); go('#channels'); return true;
      case 'channels:keep':
        if (flow?.confirmClose) { flow.confirmClose = false; patch(); doc()?.querySelector?.(`[data-flow-body] ${TYPED}`)?.focus({ preventScroll: true }); }
        return true;
      case 'channels:step': {
        const channel = flowChannel();
        const canonical = deps.durableOnboarding === true;
        if (!flow || !channel || flow.scope !== scope() || flowAuthority !== session() || canonical && !admin()
          || !CONNECT_STEPS.includes(id) || id === 'name' || id === 'groups' && !hasGroups(channel)) return true;
        if (canonical) { flow.routeTab = id; go(channelsHash({ channelId: channel.id, tab: id })); }
        if (id === flow.step) return true;
        flow.step = id; flow.error = '';
        if (id !== 'connect') { poller?.stop(); poller = null; }
        if (id !== 'test') { probe?.stop(); probe = null; validation?.stop(); validation = null; }
        patch({ focusStep: true });
        if (id === 'connect') startPoller();
        if (id === 'test' && flow.test.state !== 'received') startProbe();
        return true;
      }
      case 'channels:start': await startConnection(); return true;
      case 'channels:test': if (flow) { if (durable(flowChannel())) { openValidation(); await validation?.start(); } else { flow.test = { state: 'idle', result: null, error: null }; startProbe(); } } return true;
      case 'channels:test-refresh': if (flow && durable(flowChannel()) && admin()) { openValidation(); await validation?.refresh(); } return true;
      case 'channels:test-stop': probe?.stop(); probe = null; if (flow) { flow.test = { ...flow.test, state: 'idle', error: null }; patch(); } return true;
      case 'channels:reveal': {
        if (!flow) return true;
        flow.reveal = !flow.reveal;
        const input = doc()?.querySelector?.('[data-form="channels:token"] [name="token"]'), control = doc()?.querySelector?.('[data-action="channels:reveal"]');
        if (input) input.type = flow.reveal ? 'text' : 'password';
        if (control) { control.setAttribute('aria-pressed', flow.reveal ? 'true' : 'false'); const label = control.querySelector('.ui-btn__label'); if (label) label.textContent = flow.reveal ? t('Ocultar') : t('Mostrar'); }
        return true;
      }
      default: return false;
    }
  }
  async function create(form) {
    if (!flow || flow.channelId || flow.busy || !admin() || !tenant()) return;
    const kind = CONNECTABLE_KINDS.includes(field(form, 'kind')) ? field(form, 'kind') : flow.kind;
    const label = field(form, 'name').trim(), number = field(form, 'expectedNumber').trim();
    flow.kind = kind; flow.draft = { name: field(form, 'name').slice(0, 48), expectedNumber: field(form, 'expectedNumber').slice(0, 20) };
    if (!label) { flow.error = t('Dê um nome para a conexão.'); patch(); return; }
    if (kind === 'whatsapp_qr' && number.replace(/\D/g, '').length < 10) { flow.error = t('Informe o número com DDD.'); patch(); return; }
    const creation = flow, creationScope = flow.scope;
    const current = () => flow === creation && scope() === creationScope && admin();
    flow.busy = true; flow.error = ''; patch();
    try {
      const created = await request(tenantPath('channels'), { method: 'POST', body: JSON.stringify({ name: label, kind, real: true, ...(kind === 'whatsapp_qr' ? { expectedNumber: number } : {}) }) });
      if (!created || typeof created.id !== 'string' || !created.id) throw new Error(t('O servidor não confirmou o novo canal.'));
      if (!current()) return;
      // A confirmed creation stays confirmed when the optional panel refresh fails. Returning to the
      // creation form here would invite another POST for a channel the server has already saved.
      if (typeof services().refresh === 'function') {
        try { await services().refresh(); } catch { /* retain the channel confirmed by the POST */ }
      }
      if (!current()) return;
      // Only this drawer's current company may receive the confirmed channel after an awaited request.
      if (Array.isArray(state?.tenant?.channels) && !find(created.id)) state.tenant.channels.push(created);
      closeFlow();
      if(kind==='telegram_user'){queueTelegramAccount(created);notify(t('Canal criado. Agora conecte.'),'success');return;}
      const opened = syncFlow({ section: 'channels', params: { channelId: created.id, tab: 'connect' } });
      if (opened) opened.autostart = kind === 'whatsapp_qr';
      go(channelsHash({ channelId: created.id, tab: 'connect' }));
      notify(t('Canal criado. Agora conecte.'), 'success');
    } catch (error) { if (current()) { flow.busy = false; flow.error = error?.message || t('Não foi possível criar o canal.'); patch(); } }
  }
  async function token(form) {
    const channel = flowChannel();
    if (!flow || !channel || flow.busy || !admin() || channelTransport(channel) !== 'bot') return;
    const value = field(form, 'token').trim();
    if (!value) { flow.error = t('Cole o token do @BotFather.'); patch(); return; }
    const key = flow.key;
    flow.busy = true; flow.error = ''; patch();
    try {
      const status = await request(tenantPath(`channels/${encodeURIComponent(channel.id)}/connect`), { method: 'POST', body: JSON.stringify({ token: value }) });
      if (flow?.key !== key) return;
      flow.busy = false; flow.reveal = false;
      // Accepted: the token leaves the field too ("nunca aparece de novo no painel").
      const input = doc()?.querySelector?.('[data-form="channels:token"] [name="token"]'); if (input) input.value = '';
      if (onStatus(status)) startPoller({ immediate: false });
      patch();
    } catch (error) { if (flow?.key === key) { flow.busy = false; flow.error = telegramTokenError(error); patch(); } }
  }
  async function submit(form) {
    const name = form?.dataset?.form;
    if (name === 'channels:create') { await create(form); return true; }
    if (name === 'channels:token') { await token(form); return true; }
    if (name === 'channels:validation-confirm') { if (flow && durable(flowChannel()) && admin()) { const checked = form?.elements?.namedItem?.('recipientConfirmed')?.checked === true; await validation?.confirm(checked); } return true; }
    return false;
  }
  /** Workspace or company changed: forget the drawer and stop every request it made. */
  function reset() { deps.visitorTestUI?.reset(); pageMounted = false; pageEpoch++; batchToken++; batchAsked = false; proofs.clear(); proofScope = null; proofSession = null; closeFlow(); returnFocus = null; pendingTelegramAccount = null; }
  return { view, mount, act, submit, reset, get flow() { return flow ? { ...flow } : null; } };
}
