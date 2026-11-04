import { h, t, txt, getLocale } from './i18n.js';
import './locales-operations.js';
import './locales-operation-readiness.js';
import './locales-home.js';
import { button, badge, banner, emptyState, progress, avatar, companyMark, attributes, skeleton, toasts } from './ui.js';
import { glyph } from './icons.js';
import { motionOK } from './theme-prefs.js';
import { formatHash } from './router.js';
import { registerAction } from './actions.js';
import { createOperationReadinessModel, operationChannelState, deriveSetup, portfolioModel } from './operation-readiness.js';
import { appServices, channelHealth } from './channel-connect-flow.js';
import { readSetupPrefs, saveSetupPrefs, homeData, peekHomeData, forgetHomeData, onHomeData, portfolioKey, loadPortfolio } from './onboarding-ui.js';

// Visão geral (FRONTEND-V2 §5.4, §8.8). Owned by P7. createOverviewMarkup(props) is pure markup over
// the selected company's already-authorized DTOs (app.js views.overview passes them); access flags
// default to false, null lists mean unavailable and [] a loaded empty list.
//
// - By role: admin (KPIs Na fila · SLA em risco · Aguardando decisão · Canais com problema · Sem resposta
//   do agente, priority list, team now, first reply, agents today, channels, first-use checklist),
//   attendant ("Meu dia": Comigo · Fila · Aprovações nas minhas conversas · Menções, and "Continuar
//   de onde parou"), reseller (the same plus the client portfolio from GET /api/accounts) and
//   temporary support (read only).
// - Every KPI is a deep link to the filtered lens of the selected company (#inbox?lens=…&tenant=<id>,
//   #metrics/sla, #pending, #channels).
// - The count-up runs once per session, on the first paint with numbers, only when motionOK().
// - app.js has no mount hook for legacy views in this wave: the markup schedules mountOverview() in a
//   microtask (browser only), which runs the count-up and the lazy loads (portfolio, AI usage of the
//   day, SLA of the company) and patches their sections when they arrive. Tests pass portfolio, usage
//   and sla as props.
const stamp = value => { const time = Date.parse(value); return Number.isFinite(time) ? time : 0; };
const format = value => new Intl.NumberFormat(getLocale()).format(value);
// The KPIs count the selected company: the lens opens on it too (tenant=, applyInboxRouteQuery).
const lens = (query, tenantId = null) => {
  for (const value of [tenantId ? { ...query, tenant: tenantId } : null, query]) if (value) { try { return formatHash({ section: 'inbox', params: {}, query: value }); } catch { /* next */ } }
  return '#inbox';
};
const accountHash = id => { try { return formatHash({ section: 'accounts', params: { accountId: id }, query: {} }); } catch { return '#accounts'; } };
const usageKey = (workspaceId, tenantId) => `usage:${workspaceId}:${tenantId}`;
const slaKey = (workspaceId, tenantId) => `sla:${workspaceId}:${tenantId}`;
const RISK_WINDOW = 15 * 60000;
/**
 * "SLA em risco" from GET /api/tenants/:id/sla: active conversations whose first reply or resolution
 * timer already broke or ends within 15 minutes (the server's asOf clock). null when the answer is
 * not an SLA report; {enabled:false} when the company has no SLA.
 */
export function slaAtRisk(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.conversations)) return null;
  if (report.policy?.enabled !== true) return { enabled: false, count: null };
  const asOf = stamp(report.asOf);
  const risky = timer => Boolean(timer) && !timer.completedAt && (timer.state === 'breached' || timer.state === 'pending' && asOf > 0 && stamp(timer.dueAt) > 0 && stamp(timer.dueAt) - asOf <= RISK_WINDOW);
  return { enabled: true, count: report.conversations.filter(row => row && ['open', 'pending'].includes(row.status) && (risky(row.firstReply) || risky(row.resolution))).length };
}
function scopedRows(value, tenantId, workspaceId) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).filter(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.tenantId && item.tenantId !== tenantId || workspaceId && item.workspaceId && item.workspaceId !== workspaceId || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  });
}
const STATE_NAMES = () => ({ connected: t('Conectado'), configured: t('Configurado · validar entrada'), disconnected: t('Desconectado'), starting: t('Iniciando'), qr: t('Aguardando QR'), connecting: t('Conectando'), reconnecting: t('Reconectando'), logged_out: t('Sessão encerrada'), wrong_number: t('Conferir número'), failed: t('Falha de conexão'), sandbox: t('Demonstração') });
const REASONS = () => ({ 'admin-inactive': t('Administrador não ativou o acesso'), 'no-channel': t('Sem canal há 7 dias'), 'no-connection': t('Nenhum canal com conexão ativa') });
const ONBOARDING_LABELS = () => ({ companyCreated: t('Empresa inicial criada'), administratorActive: t('Administrador ativo'), channelConnected: t('Canal conectado'), teamReady: t('Equipe preparada'), contractConfigured: t('Contrato configurado') });
const SETUP_TITLES = () => ({ company: t('Empresa'), channel: t('Canal'), team: t('Equipe'), agent: t('Agente'), test: t('Atendimento de teste') });
const SETUP_ACTIONS = () => ({ company: [t('Revisar'), '#settings/companies'], channel: [t('Conectar'), '#channels/new/whatsapp_qr'], team: [t('Convidar'), '#settings/team'], agent: [t('Ligar'), '#agents'], test: [t('Começar'), '#setup'] });

function greeting(name, now) {
  const hour = new Date(now).getHours(), first = String(name || '').trim().split(/\s+/)[0] || '';
  if (!first) return hour >= 5 && hour < 12 ? t('Bom dia') : hour >= 12 && hour < 18 ? t('Boa tarde') : t('Boa noite');
  return hour >= 5 && hour < 12 ? t('Bom dia, {name}', { name: first }) : hour >= 12 && hour < 18 ? t('Boa tarde, {name}', { name: first }) : t('Boa noite, {name}', { name: first });
}
function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), rest = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** The model behind the markup (exported for tests): role, readiness, KPIs and the lists shown. */
export function overviewModel(props = {}) {
  const { tenant, workspaceId = null, session = {}, access = {}, supportMode = false } = props;
  const now = Number.isFinite(props.now) ? props.now : Date.now();
  const readiness = createOperationReadinessModel(props);
  const support = Boolean(supportMode || session.supportGrantId);
  const accountKind = props.accountKind !== undefined ? props.accountKind : appServices()?.state?.boot?.reseller?.accountKind ?? null;
  const role = !tenant?.id ? 'none' : support ? 'support' : readiness.manager ? accountKind === 'reseller' ? 'reseller' : 'admin' : 'attendant';
  const conversations = readiness.data.conversations.available ? scopedRows(props.conversations, tenant?.id, workspaceId).filter(item => ['open', 'pending'].includes(item.status)) : [];
  const channels = readiness.data.channels.available ? scopedRows(props.channels, tenant?.id, workspaceId) : [];
  const people = readiness.data.assignees.available ? scopedRows(props.assignees, tenant?.id, workspaceId) : [];
  const problem = channels.filter(channel => channelHealth(channel) === 'problem');
  const prefs = tenant?.id ? props.setupPrefs || readSetupPrefs(session.userId, tenant.id) : { dismissed: false, solo: false, completedAt: null };
  const portfolioEntry = role === 'reseller' ? props.portfolio !== undefined ? { state: props.portfolio ? 'loaded' : 'error', value: props.portfolio } : peekHomeData(portfolioKey(workspaceId, session.userId)) || { state: 'loading', value: null } : null;
  const portfolio = portfolioEntry?.value ? portfolioModel(portfolioEntry.value, workspaceId, { now }) : null;
  const setup = deriveSetup(readiness, { accountKind, brand: props.brand !== undefined ? props.brand : appServices()?.state?.boot?.reseller?.brand, prefs, portfolio: portfolio?.clients ?? null });
  const usageEntry = readiness.manager && readiness.data.agents.available && readiness.agentSignals.length ? props.usage !== undefined ? { state: props.usage ? 'loaded' : 'error', value: props.usage } : peekHomeData(usageKey(workspaceId, tenant?.id)) || { state: 'loading', value: null } : null;
  // The SLA report needs inbox.read and metrics.read of the company (same rule as the server).
  const slaEntry = ['admin', 'reseller', 'support'].includes(role) && readiness.permissions.metricsRead ? props.sla !== undefined ? { state: props.sla ? 'loaded' : 'error', value: props.sla } : peekHomeData(slaKey(workspaceId, tenant?.id)) || { state: 'loading', value: null } : null;
  return { now, role, support, accountKind, readiness, conversations, channels, people, problem, prefs, setup, portfolioEntry, portfolio, usageEntry, slaEntry, inbox: readiness.permissions.inboxRead, admin: readiness.manager, access, tenantId: tenant?.id || null };
}

function slaCard(m) {
  const base = { key: 'sla', section: 'sla', label: t('SLA em risco'), value: null, href: null, cta: t('Sem acesso') };
  const entry = m.slaEntry;
  if (!entry) return base;
  const risk = entry.value ? slaAtRisk(entry.value) : null;
  if (entry.state === 'loading' && !entry.value) return { ...base, href: '#metrics/sla', cta: t('Carregando…') };
  if (!risk) return { ...base, href: '#metrics/sla', cta: t('Indisponível agora') };
  if (!risk.enabled) return { ...base, href: m.admin ? '#automation' : '#metrics/sla', cta: m.admin ? t('Configurar SLA') : t('Ver SLA'), detail: t('SLA desligado') };
  return { ...base, value: risk.count, href: '#metrics/sla', cta: t('Ver SLA'), tone: risk.count > 0 ? 'danger' : null };
}
function kpiCards(m) {
  const op = m.readiness.operation, loaded = value => value === null || value === undefined ? null : value;
  const channelsKnown = m.readiness.data.channels.available;
  const inbox = m.inbox, company = m.tenantId;
  const items = m.role === 'attendant' ? [
    { key: 'mine', label: t('Comigo'), value: inbox ? loaded(op.mine) : null, href: inbox ? lens({ lens: 'mine' }, company) : null, cta: t('Abrir meus atendimentos') },
    { key: 'queue', label: t('Fila dos meus departamentos'), value: inbox ? loaded(op.queue) : null, href: inbox ? lens({ lens: 'queue' }, company) : null, cta: t('Abrir fila'), tone: op.queue > 0 ? 'warning' : null },
    { key: 'approvals', label: t('Aprovações nas minhas conversas'), value: inbox ? loaded(op.myApprovals) : null, href: inbox ? '#pending' : null, cta: t('Revisar'), tone: op.myApprovals > 0 ? 'agent' : null },
    { key: 'mentions', label: t('Menções na Equipe'), value: null, href: null, soon: true }
  ] : [
    { key: 'queue', label: t('Na fila'), value: inbox ? loaded(op.queue) : null, href: inbox ? lens({ lens: 'queue' }, company) : null, cta: t('Abrir fila'), tone: op.queue > 0 ? 'warning' : null },
    slaCard(m),
    { key: 'approvals', label: t('Aguardando decisão'), value: inbox ? loaded(op.approvals) : null, href: inbox ? '#pending' : null, cta: t('Revisar'), tone: op.approvals > 0 ? 'agent' : null },
    { key: 'channels', label: t('Canais com problema'), value: channelsKnown ? m.problem.length : null, href: '#channels', cta: m.problem.length ? t('Reconectar') : t('Ver canais'), tone: m.problem.length ? 'danger' : null, detail: m.problem[0]?.name || '' },
    { key: 'agent', label: t('Sem resposta (agente)'), value: inbox ? loaded(op.agentUnanswered) : null, href: inbox ? lens({ lens: 'agent', unread: '1' }, company) : null, cta: t('Assumir'), tone: op.agentUnanswered > 0 ? 'agent' : null }
  ];
  return items;
}
function kpi(item) {
  const shown = item.value === null ? '—' : format(item.value);
  const cta = item.soon ? t('Em breve') : item.value === null && !item.href ? t('Sem acesso') : item.cta;
  const inner = h`<span class="pg-home__kpi-label">${item.label}</span><strong class="pg-home__kpi-value" data-overview-count="${item.key}"${attributes({ 'data-count-to': item.value > 0 ? String(item.value) : null })}>${shown}</strong>${item.detail ? h`<span class="pg-home__kpi-detail">${item.detail}</span>` : ''}<span class="pg-home__kpi-cta">${cta}${item.href ? glyph('arrow') : ''}</span>`;
  return item.href
    ? h`<a class="pg-home__kpi" href="${item.href}" data-home-kpi="${item.key}"${attributes({ 'data-home-section': item.section || null })} data-tone="${item.tone || 'neutral'}" aria-label="${t('{label}: {value}. {action}', { label: item.label, value: shown, action: item.cta })}">${inner}</a>`
    : h`<div class="pg-home__kpi" data-home-kpi="${item.key}"${attributes({ 'data-home-section': item.section || null })} data-tone="neutral" data-state="${item.soon ? 'soon' : 'static'}">${inner}</div>`;
}

function rows(m, props) {
  const tenant = props.tenant, session = props.session || {};
  const channelName = id => m.channels.find(channel => channel.id === id)?.name || t('Canal de origem');
  const person = id => m.people.find(entry => entry.id === id)?.name;
  const responsible = item => item.assignedUserId ? item.assignedUserId === session.userId ? t('Com você') : item.assignedUserName || person(item.assignedUserId) || t('Responsável atribuído') : item.owner === 'agent' ? t('Agente atribuído') : t('Na fila');
  const tone = item => !item.assignedUserId && item.owner !== 'agent' ? 'warning' : item.owner === 'agent' && !item.assignedUserId ? 'agent' : Number(item.unread) > 0 ? 'accent' : 'neutral';
  const attendant = m.role === 'attendant';
  const priority = item => !item.assignedUserId && item.owner !== 'agent' ? 0 : session.userId && item.assignedUserId === session.userId && Number(item.unread) > 0 ? 1 : Number(item.unread) > 0 ? 2 : session.userId && item.assignedUserId === session.userId ? 3 : 4;
  const source = attendant ? m.conversations.filter(item => session.userId && item.assignedUserId === session.userId) : m.conversations;
  const selected = [...source].sort(attendant ? (a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || a.id.localeCompare(b.id) : (a, b) => priority(a) - priority(b) || stamp(b.updatedAt) - stamp(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, attendant ? 3 : 5);
  const title = attendant ? t('Continuar de onde parou') : t('Prioridade agora');
  const loadedConversations = m.readiness.data.conversations.available;
  let body;
  if (!m.inbox) body = emptyState({ icon: 'inbox', title: t('Atendimento fora do seu acesso'), body: t('As áreas permitidas continuam disponíveis nesta visão geral.'), level: 3 });
  // Erro de carga (§5.6 catalog): "Tentar de novo" is the app refresh (legacy act 'refresh').
  else if (!loadedConversations) body = emptyState({ icon: 'warning', title: t('Não conseguimos carregar agora.'), body: t('Abra o Atendimento para consultar os dados atuais.'), action: { label: t('Tentar de novo'), action: 'refresh' }, level: 3 });
  else if (!selected.length) body = emptyState({ icon: 'check', title: attendant ? t('Nada com você agora') : t('Nenhum atendimento ativo'), body: attendant ? t('Quando assumir uma conversa, ela aparece aqui para você continuar.') : t('Quando uma conversa entrar, ela aparece aqui por prioridade.'), action: { label: attendant ? t('Abrir a fila') : t('Abrir Atendimento'), attrs: { 'data-view': 'inbox' } }, level: 3 });
  else body = h`<ul class="pg-home__rows">${selected.map(item => h`<li><button type="button" class="pg-home__row" data-overview-conversation="${item.id}" data-overview-tenant="${tenant.id}" aria-label="${t('Abrir atendimento de {contact}, {channel}, {owner}', { contact: item.contact || t('Contato'), channel: channelName(item.channelId), owner: responsible(item) })}"><span class="pg-home__stripe" data-tone="${tone(item)}" aria-hidden="true"></span><span class="pg-home__row-main"><strong data-pii>${item.contact || t('Contato')}</strong><span class="pg-home__row-meta">${channelName(item.channelId)} · ${item.department || t('Sem departamento')}</span></span><span class="pg-home__row-side"><span class="pg-home__pill" data-tone="${tone(item)}">${responsible(item)}</span>${Number(item.unread) > 0 ? h`<small>${t('Não lida')}</small>` : ''}</span></button></li>`)}</ul>`;
  const more = m.inbox && loadedConversations && source.length > selected.length ? h`<p class="pg-home__hint">${t('Mostrando {shown} de {total} carregadas.', { shown: selected.length, total: source.length })}</p>` : '';
  return h`<section class="pg-home__panel pg-home__panel--wide" aria-labelledby="overview-queue-title"><header class="pg-home__panel-head"><h2 id="overview-queue-title" class="pg-home__panel-title">${title}</h2>${m.inbox ? h`<a class="ui-btn ui-btn--ghost ui-btn--sm" href="${lens(attendant ? { lens: 'mine' } : {}, m.tenantId)}"><span class="ui-btn__label">${t('Ver tudo')}</span></a>` : ''}</header>${body}${more}</section>`;
}

function teamPanel(m, props) {
  if (!m.inbox || m.role === 'support') return '';
  const session = props.session || {};
  if (!m.readiness.data.assignees.available) return h`<section class="pg-home__panel" aria-labelledby="home-team-title"><h2 id="home-team-title" class="pg-home__panel-title">${t('Equipe agora')}</h2><p class="pg-home__hint">${t('Responsáveis não disponíveis nesta atualização.')}</p></section>`;
  const people = [...m.people].sort((a, b) => Number(b.id === session.userId) - Number(a.id === session.userId) || Number(b.presence === 'available') - Number(a.presence === 'available') || String(a.name || '').localeCompare(String(b.name || ''), getLocale()));
  const available = people.filter(person => person.presence === 'available').length;
  const presence = { available: t('Disponível'), busy: t('Ocupado'), away: t('Ausente'), offline: t('Fora de atendimento') };
  const metrics = props.metrics, reply = m.readiness.permissions.metricsRead && Number.isFinite(metrics?.firstReply?.averageSeconds) && Number.isSafeInteger(metrics?.firstReply?.samples) && (!metrics.tenantId || metrics.tenantId === props.tenant?.id) ? metrics.firstReply : null;
  // The metrics follow the period chosen in Indicadores: the label says which one.
  const from = stamp(metrics?.period?.from), to = stamp(metrics?.period?.to), days = from && to >= from ? Math.max(1, Math.round((to - from) / 86400000)) : null;
  const replyLabel = days === null ? t('1ª resposta média') : days === 1 ? t('1ª resposta média (1 dia)') : t('1ª resposta média ({days} dias)', { days: format(days) });
  return h`<section class="pg-home__panel" aria-labelledby="home-team-title"><header class="pg-home__panel-head"><h2 id="home-team-title" class="pg-home__panel-title">${t('Equipe agora')}</h2><span class="pg-home__hint">${available === 1 ? t('1 disponível de {total}', { total: people.length }) : t('{available} disponíveis de {total}', { available, total: people.length })}</span></header>
    ${people.length ? h`<ul class="pg-home__people">${people.slice(0, 6).map(person => h`<li class="pg-home__person">${avatar({ kind: 'person', name: person.name || t('Atendente'), src: person.avatar, presence: ['available', 'busy', 'away', 'offline'].includes(person.presence) ? person.presence : null, size: 32 })}<span class="pg-home__person-name">${person.name || t('Atendente')}${person.id === session.userId ? h` <small>${t('Você')}</small>` : ''}</span><span class="pg-home__hint">${presence[person.presence] || t('Status não informado')}</span></li>`)}</ul>` : h`<p class="pg-home__hint">${t('Nenhum responsável listado.')}</p>`}
    ${reply ? h`<p class="pg-home__metric"><span>${replyLabel}</span><strong class="pg-home__metric-value">${reply.samples ? duration(reply.averageSeconds) : '—'}</strong><small>${reply.samples === 1 ? t('1 atendimento') : t('{count} atendimentos', { count: format(reply.samples) })}</small></p>` : ''}</section>`;
}

function agentsPanel(m) {
  const entry = m.usageEntry;
  if (!entry) return '';
  const value = entry.value, today = value?.today;
  let body;
  if (entry.state === 'loading' && !value) body = skeleton({ lines: 1, label: t('Carregando o uso de hoje…') });
  else if (!today || !Number.isSafeInteger(today.runs)) body = h`<p class="pg-home__hint">${t('Uso indisponível agora.')} ${button({ label: t('Tentar de novo'), variant: 'link', size: 'sm', action: 'home:retry', attrs: { 'data-id': 'usage' } })}</p>`;
  else {
    // limit: null is "no limit"; 0 blocks every run (src/agent-runtime.js setDailyLimit); blocked comes from the server.
    const limit = Number.isSafeInteger(value.limit) && value.limit >= 0 ? value.limit : null, used = Number.isSafeInteger(today.totalTokens) ? today.totalTokens : 0;
    const quota = limit ? Math.min(100, Math.round(used / limit * 100)) : null, blocked = limit === 0 || today.blocked === true;
    const shown = limit === null ? t('Sem limite') : limit === 0 ? t('IA bloqueada (limite 0)') : `${quota}%`;
    body = h`<dl class="pg-home__facts"><div><dt>${t('Execuções hoje')}</dt><dd>${format(today.runs)}</dd></div><div><dt>${t('Tokens hoje')}</dt><dd>${format(used)}</dd></div><div><dt>${t('Cota diária')}</dt><dd>${shown}</dd></div></dl>${quota !== null ? progress({ value: quota, max: 100, label: t('Cota diária de IA usada'), valueText: `${quota}%` }) : ''}${blocked ? h`<p class="pg-home__hint" data-home-quota="blocked">${limit === 0 ? t('Com o limite em 0, nenhuma execução de IA roda nesta empresa.') : t('Limite diário atingido: novas execuções de IA ficam bloqueadas até a virada do dia.')}</p>` : ''}`;
  }
  return h`<section class="pg-home__panel" data-home-section="agents" aria-labelledby="home-agents-title"><header class="pg-home__panel-head"><h2 id="home-agents-title" class="pg-home__panel-title">${t('Agentes hoje')}</h2><a class="ui-btn ui-btn--ghost ui-btn--sm" href="#agents/usage"><span class="ui-btn__label">${t('Ver uso')}</span></a></header>${body}</section>`;
}

function channelsPanel(m) {
  if (!['admin', 'reseller', 'support'].includes(m.role)) return '';
  if (!m.readiness.data.channels.available) return h`<section class="pg-home__panel" aria-labelledby="home-channels-title"><h2 id="home-channels-title" class="pg-home__panel-title">${t('Canais')}</h2><p class="pg-home__hint">${t('Conexões não disponíveis nesta atualização.')}</p></section>`;
  // Active: a live connection, or a configured channel (e-mail, Meta) that already received a conversation.
  const connected = m.readiness.receiving ?? m.channels.filter(channel => operationChannelState(channel) === 'connected').length, names = STATE_NAMES();
  const body = !m.channels.length ? emptyState({ icon: 'plug', title: t('Nenhum canal conectado ainda'), body: t('Conecte um canal para receber a primeira conversa.'), action: m.admin ? { label: t('Conectar um canal'), attrs: { 'data-view': 'channels' } } : null, level: 3 })
    : h`<ul class="pg-home__channels">${m.channels.slice(0, 5).map(channel => h`<li class="pg-home__channel" data-health="${channelHealth(channel)}"><span class="pg-home__channel-name">${channel.name || t('Canal')}</span>${badge(names[channel.state] || t('Status não informado'), { ok: 'success', problem: 'danger', pending: 'warning' }[channelHealth(channel)] || 'neutral')}</li>`)}</ul>`;
  return h`<section class="pg-home__panel" aria-labelledby="home-channels-title"><header class="pg-home__panel-head"><h2 id="home-channels-title" class="pg-home__panel-title">${t('Canais')}</h2><span class="pg-home__hint">${t('{connected} de {total} ativos', { connected, total: m.channels.length })}</span></header>${body}${m.channels.length ? button({ label: m.admin ? t('Gerenciar canais') : t('Ver canais'), variant: 'ghost', size: 'sm', attrs: { 'data-view': 'channels' } }) : ''}</section>`;
}

function setupBlock(m) {
  const setup = m.setup;
  if (!m.admin || !setup.steps.length) return '';
  // Dismissed: one discreet link keeps the guide within reach (#setup is not in the menu).
  if (setup.dismissed) return setup.complete ? '' : h`<p class="pg-home__hint" data-home-section="setup" data-state="dismissed"><a class="ui-btn ui-btn--link ui-btn--sm" href="#setup"><span class="ui-btn__label">${t('Abrir o guia de primeiro uso')}</span></a></p>`;
  if (setup.complete) {
    const completed = stamp(m.prefs.completedAt);
    if (completed && m.now - completed > 7 * 86400000) return '';
    return h`<a class="pg-home__strip" data-home-section="setup" data-state="complete" href="#setup">${glyph('check')}<span>${t('Preparação do atendimento manual concluída')}</span><span class="pg-home__hint">${t('{done} de {total} etapas', { done: setup.done, total: setup.total })}</span></a>`;
  }
  const firstUse = m.readiness.data.channels.available && (m.readiness.receiving ?? m.readiness.connections.connected) === 0;
  const company = setup.steps.filter(step => step.group === 'company'), titles = SETUP_TITLES(), actions = SETUP_ACTIONS();
  if (firstUse) return h`<section class="pg-home__first-use" data-home-section="setup" aria-labelledby="home-setup-title"><header class="pg-home__panel-head"><div><p class="pg-home__eyebrow">${t('Primeiro uso')}</p><h2 id="home-setup-title" class="pg-home__panel-title" tabindex="-1">${t('Prepare sua operação')}</h2></div>${progress({ value: setup.done, max: setup.total, label: t('Progresso do primeiro uso'), valueText: t('{done} de {total} etapas', { done: setup.done, total: setup.total }) })}</header>
      <ol class="pg-home__checklist">${company.map(step => h`<li class="pg-home__check" data-state="${step.state}"><span class="pg-home__check-mark" aria-hidden="true">${step.state === 'done' ? glyph('check') : ''}</span><span class="pg-home__check-name">${titles[step.id]}${step.optional ? h` <small>${t('opcional')}</small>` : ''}<span class="sr-only"> · ${step.state === 'done' ? t('Concluído') : step.state === 'unknown' ? t('Status não disponível') : t('A fazer')}</span></span>${step.state === 'done' ? '' : step.id === 'team' ? h`<span class="pg-home__check-actions"><a class="ui-btn ui-btn--secondary ui-btn--sm" href="${actions.team[1]}"><span class="ui-btn__label">${actions.team[0]}</span></a>${button({ label: t('vou atender sozinho'), variant: 'link', size: 'sm', action: 'home:solo', attrs: { 'data-id': 'on' } })}</span>` : h`<a class="ui-btn ui-btn--secondary ui-btn--sm" href="${actions[step.id][1]}"><span class="ui-btn__label">${actions[step.id][0]}</span></a>`}</li>`)}</ol>
      <footer class="pg-home__actions"><a class="ui-btn ui-btn--primary ui-btn--md" href="#setup"><span class="ui-btn__label">${t('Abrir o guia de primeiro uso')}</span></a>${button({ label: t('Dispensar'), variant: 'ghost', action: 'home:dismiss' })}</footer></section>`;
  return h`<a class="pg-home__strip" data-home-section="setup" href="#setup"><span>${t('Prepare sua operação')}</span>${progress({ value: setup.done, max: setup.total, label: t('Progresso do primeiro uso'), valueText: t('{done} de {total} etapas', { done: setup.done, total: setup.total }) })}<strong class="pg-home__strip-count">${setup.done}/${setup.total}</strong>${glyph('arrow')}</a>`;
}

function portfolioPanel(m) {
  if (m.role !== 'reseller') return '';
  const entry = m.portfolioEntry, model = m.portfolio, reasons = REASONS(), labels = ONBOARDING_LABELS();
  let body;
  if (!model && entry?.state !== 'error') body = skeleton({ lines: 3, label: t('Carregando a carteira…') });
  else if (!model) body = h`<p class="pg-home__hint">${t('Não conseguimos carregar a carteira agora.')}</p>${button({ label: t('Tentar de novo'), variant: 'secondary', size: 'sm', action: 'home:retry', attrs: { 'data-id': 'portfolio' } })}`;
  else if (!model.clients.length) body = emptyState({ icon: 'briefcase', title: t('Nenhum cliente ainda'), body: t('Crie a primeira conta e convide o administrador do cliente.'), action: { label: t('Criar conta de cliente'), attrs: { 'data-view': 'accounts' } }, level: 3 });
  else body = h`${model.partial ? h`<p class="pg-home__hint" data-home-portfolio="partial">${t('Leitura parcial: {loaded} de {total} contas carregadas. A lista completa fica em Clientes.', { loaded: format(model.loaded), total: format(model.total) })}</p>` : ''}${model.attention.length ? h`<div class="pg-home__attention"><h3 class="pg-home__subtitle">${t('Clientes que precisam de você')}</h3><ul class="pg-home__attention-list">${model.attention.slice(0, 5).map(client => h`<li><a href="${accountHash(client.id)}" class="pg-home__attention-link"><strong>${client.name || t('Conta sem nome')}</strong><span class="pg-home__hint">${client.reasons.map(reason => reasons[reason]).join(' · ')}</span></a></li>`)}</ul></div>` : h`<p class="pg-home__setup-line">${glyph('check')}<span>${model.partial ? t('Nenhum dos clientes carregados precisa de você agora.') : t('Nenhum cliente precisa de você agora.')}</span></p>`}
      <ul class="pg-home__clients">${model.clients.slice(0, 8).map(client => h`<li class="pg-home__client"><div class="pg-home__client-head"><a href="${accountHash(client.id)}"><strong>${client.name || t('Conta sem nome')}</strong></a><span class="pg-home__hint">${t('{done}/{total} etapas', { done: client.done, total: client.total })}</span></div>
        ${progress({ value: client.done, max: client.total, label: t('Preparação de {name}', { name: client.name || t('Conta sem nome') }), valueText: client.steps.filter(step => step.done).map(step => labels[step.key]).join(', ') || t('Nenhuma etapa confirmada') })}
        <p class="pg-home__hint">${client.channels === null ? t('Canais não informados') : t('{connected} de {total} canais conectados', { connected: client.connected ?? 0, total: client.channels })} · ${client.agents === null ? t('Agentes não informados') : client.agents === 1 ? t('1 agente ativo') : t('{count} agentes ativos', { count: client.agents })}</p></li>`)}</ul>${model.clients.length > 8 ? h`<p class="pg-home__hint">${t('Mostrando 8 de {total} clientes.', { total: model.clients.length })}</p>` : ''}`;
  return h`<section class="pg-home__panel pg-home__panel--wide" data-home-section="portfolio" aria-labelledby="home-portfolio-title"><header class="pg-home__panel-head"><h2 id="home-portfolio-title" class="pg-home__panel-title">${t('Carteira de clientes')}</h2><a class="ui-btn ui-btn--ghost ui-btn--sm" href="#accounts"><span class="ui-btn__label">${t('Ver clientes')}</span></a></header>${body}</section>`;
}

function trialBanner(props, m) {
  // The server describes the commercial clock; a browser clock never establishes a trial.
  const onboarding = m.admin && props.accountOnboarding && typeof props.accountOnboarding === 'object' && typeof props.accountOnboarding.documentRegistered === 'boolean' ? props.accountOnboarding : null;
  if (onboarding?.publicTrialEnabled !== true) return '';
  const lifecycle = onboarding.lifecycle, expiration = typeof lifecycle?.trialExpiresAt === 'string' ? new Date(lifecycle.trialExpiresAt) : null;
  const known = lifecycle?.state === 'trial' && expiration && Number.isFinite(expiration.getTime()) && stamp(lifecycle.serverTime) > 0 && typeof lifecycle.trialExpired === 'boolean' && Number.isSafeInteger(lifecycle.daysRemaining) && lifecycle.daysRemaining >= 0;
  const documentLine = onboarding.documentRegistered ? t('CPF/CNPJ registrado para esta conta') : known ? t('CPF/CNPJ não registrado para um novo teste') : '';
  if (!known) return lifecycle?.state === 'trial' ? banner({ tone: 'info', title: t('Período de teste'), body: t('O prazo do teste não está disponível nesta atualização. Consulte o responsável comercial para confirmar.') }) : documentLine ? h`<p class="pg-home__hint" data-home-trial="document">${documentLine}</p>` : '';
  const deadline = expiration.toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });
  const title = lifecycle.trialExpired ? t('Período de teste encerrado') : lifecycle.daysRemaining === 1 ? t('Último dia do período de teste') : txt`${format(lifecycle.daysRemaining)} dias restantes no período de teste`;
  return h`<div class="pg-home__trial" data-trial-status="${lifecycle.trialExpired ? 'expired' : 'active'}">${banner({ tone: lifecycle.trialExpired ? 'warning' : 'info', title, body: h`${lifecycle.trialExpired ? t('Prazo encerrado em') : t('Prazo até')} <time datetime="${lifecycle.trialExpiresAt}">${deadline}</time> · ${t('horário deste navegador')}${documentLine ? h` · ${documentLine}` : ''}` })}</div>`;
}

let scheduled = false, lastProps = null, counted = false;
const COUNTED_KEY = 'elozi:home:counted';

/** Markup of Visão geral for the selected company (pure; the browser also schedules mountOverview). */
export function createOverviewMarkup(props = {}) {
  const m = overviewModel(props);
  const markup = overviewMarkup(props, m);
  if (typeof globalThis.document?.querySelector === 'function' && typeof queueMicrotask === 'function' && !props.noMount) {
    lastProps = props;
    if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; mountOverview(); }); }
  }
  return markup;
}

function overviewMarkup(props, m) {
  const tenant = props.tenant, session = props.session || {};
  if (m.role === 'none') return String(h`<div class="pg-home" data-home-overview data-home-role="none"><header class="pg-home__header"><div><p class="pg-home__eyebrow">${t('Visão geral')}</p><h1 id="overview-title" class="pg-home__title">${t('Visão geral')}</h1></div></header>${emptyState({ icon: 'building', title: t('Selecione uma empresa para acompanhar a operação.'), body: t('Use o seletor de escopo no topo do menu.') })}</div>`);
  const attendant = m.role === 'attendant', partial = m.readiness.data.conversations.state === 'partial' && m.inbox;
  const scope = m.support ? t('Acesso de suporte') : t('Empresa selecionada');
  const primary = m.inbox ? h`<a class="ui-btn ui-btn--primary ui-btn--md" href="${lens(attendant ? { lens: 'mine' } : {}, m.tenantId)}"><span class="ui-btn__label">${t('Abrir atendimento')}</span></a>` : '';
  const state = m.readiness.data.conversations.state;
  return String(h`<div class="pg-home" data-home-overview data-home-role="${m.role}">
    <header class="pg-home__header"><div><p class="pg-home__eyebrow">${attendant ? t('Meu dia') : t('Visão geral')}</p><h1 id="overview-title" class="pg-home__title">${greeting(session.name, m.now)}</h1><p class="pg-home__scope">${companyMark(tenant)}<span>· ${scope}</span></p></div><div class="pg-home__actions">${primary}</div></header>
    ${trialBanner(props, m)}${setupBlock(m)}
    ${['loading', 'error'].includes(state) && m.inbox ? banner({ tone: state === 'error' ? 'warning' : 'info', title: state === 'error' ? t('Não conseguimos carregar agora.') : t('Carregando'), body: t('Abra o Atendimento para consultar os dados atuais.') }) : ''}
    <section class="pg-home__kpis" aria-label="${attendant ? t('Seu dia em números') : t('A operação agora')}">${kpiCards(m).map(kpi)}</section>
    ${partial ? h`<p class="pg-home__hint pg-home__note">${t('de {count} carregadas', { count: format(m.conversations.length) })}</p>` : ''}
    ${portfolioPanel(m)}
    <div class="pg-home__grid">${rows(m, props)}${teamPanel(m, props)}${agentsPanel(m)}${channelsPanel(m)}</div>
  </div>`);
}

/** Count-up of the KPI values: once per session, on the first paint with numbers, when motion is OK. */
export function countUp(root, { motion = motionOK(), raf = globalThis.requestAnimationFrame, clock = () => globalThis.performance?.now?.() ?? Date.now(), storage = globalThis.sessionStorage, ms = 600 } = {}) {
  const nodes = [...(root?.querySelectorAll?.('[data-count-to]') || [])].map(node => ({ node, to: Number(node.dataset.countTo) })).filter(item => Number.isSafeInteger(item.to) && item.to > 0);
  if (!nodes.length) return false;
  let done = counted;
  try { done ||= storage?.getItem(COUNTED_KEY) === '1'; } catch { /* private window: this page only */ }
  if (done) return false;
  counted = true;
  try { storage?.setItem(COUNTED_KEY, '1'); } catch { /* private window: this page only */ }
  if (!motion || typeof raf !== 'function') return false;
  const start = clock(), numbers = new Intl.NumberFormat(getLocale());
  const frame = time => {
    const progressValue = Math.min(1, Math.max(0, (time - start) / ms)), eased = 1 - Math.pow(1 - progressValue, 3);
    for (const { node, to } of nodes) if (node.isConnected !== false) node.textContent = numbers.format(progressValue >= 1 ? to : Math.round(to * eased));
    if (progressValue < 1) raf(frame);
  };
  for (const { node } of nodes) node.textContent = numbers.format(0);
  raf(frame);
  return true;
}
/** Tests: forget that the count-up already ran. */
export function resetCountUp() { counted = false; }

function patchSections(names) {
  const doc = globalThis.document, root = doc?.querySelector?.('.pg-home[data-home-overview]');
  if (!root || !lastProps) return;
  const template = doc.createElement('template');
  template.innerHTML = overviewMarkup(lastProps, overviewModel(lastProps));
  for (const name of names) {
    const fresh = template.content.querySelector(`[data-home-section="${name}"]`), current = root.querySelector(`[data-home-section="${name}"]`);
    if (fresh && current) current.replaceWith(fresh);
    else if (current) current.remove();
  }
}
onHomeData(key => patchSections(key.startsWith('portfolio:') ? ['portfolio', 'setup'] : key.startsWith('usage:') ? ['agents'] : key.startsWith('sla:') ? ['sla'] : []));

/** After the overview is in the page: count-up, completion memo of the first use and lazy loads. */
export function mountOverview(doc = globalThis.document) {
  const root = doc?.querySelector?.('.pg-home[data-home-overview]');
  if (!root || !lastProps) return false;
  countUp(root.querySelector('.pg-home__kpis'));
  const props = lastProps, m = overviewModel(props), session = props.session || {}, api = appServices()?.api;
  if (m.admin && m.setup.complete && !m.prefs.completedAt && props.tenant?.id) saveSetupPrefs(session.userId, props.tenant.id, { completedAt: new Date(m.now).toISOString() });
  if (typeof api !== 'function' || !props.workspaceId) return true;
  if (m.role === 'reseller' && props.portfolio === undefined) loadPortfolio(api, { workspaceId: props.workspaceId, userId: session.userId });
  if (m.slaEntry && props.sla === undefined) {
    const tenantId = props.tenant.id;
    homeData(slaKey(props.workspaceId, tenantId), () => api(`/api/tenants/${encodeURIComponent(tenantId)}/sla`, { headers: { 'X-Elozi-Workspace': props.workspaceId } }));
  }
  if (m.usageEntry && props.usage === undefined) {
    const tenantId = props.tenant.id;
    homeData(usageKey(props.workspaceId, tenantId), () => api(`/api/tenants/${encodeURIComponent(tenantId)}/agents/usage?days=1`, { headers: { 'X-Elozi-Workspace': props.workspaceId } }));
  }
  return true;
}

// "vou atender sozinho" and "Dispensar" of the first-use block: the preference is stored and the
// block is drawn again in place (the overview has no route change to re-render it).
function setupChoice(patchPrefs, { message = '', focus = '' } = {}) {
  const props = lastProps, m = props ? overviewModel(props) : null;
  if (!m?.admin || !props.tenant?.id) return false;
  saveSetupPrefs(props.session?.userId, props.tenant.id, patchPrefs);
  patchSections(['setup']);
  if (focus) globalThis.document?.querySelector?.(focus)?.focus?.({ preventScroll: true });
  if (message) toasts.show({ message, tone: 'success', action: patchPrefs.dismissed ? { label: t('Desfazer'), onSelect: () => setupChoice({ dismissed: false }, { focus: '#home-setup-title' }) } : undefined });
  return true;
}
registerAction('home:solo', ({ id }) => { setupChoice({ solo: id !== 'off' }, { message: id !== 'off' ? t('Combinado: você atende sozinho por enquanto.') : '', focus: '#home-setup-title' }); });
registerAction('home:dismiss', () => { setupChoice({ dismissed: true }, { message: t('Guia dispensado. Ele continua no link "Abrir o guia de primeiro uso" desta página.'), focus: '[data-home-section="setup"] a' }); });

registerAction('home:retry', ({ id }) => {
  const props = lastProps;
  if (!props?.workspaceId) return;
  forgetHomeData(id === 'usage' ? usageKey(props.workspaceId, props.tenant?.id) : id === 'sla' ? slaKey(props.workspaceId, props.tenant?.id) : portfolioKey(props.workspaceId, props.session?.userId));
  patchSections(id === 'usage' ? ['agents'] : id === 'sla' ? ['sla'] : ['portfolio']);
  mountOverview();
});
