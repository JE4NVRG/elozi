// Pure projection of already-authorized snapshots. No requests, clocks or writes.
import { DEFAULT_BRAND as DEFAULT_ACCENT } from './brand-theme.js';
import { channelValidatedForUse } from './channel-validation-view.js';
const states = new Set(['loaded', 'partial', 'loading', 'error', 'unavailable']);
const available = state => state === 'loaded' || state === 'partial';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function operationChannelState(channel) {
  if (channel?.enabled === false || channel?.state === 'disabled') return 'disabled';
  if (channel?.state === 'connected') return 'connected';
  if (channel?.state === 'configured') return 'configured';
  if (['disconnected', 'logged_out', 'wrong_number', 'failed'].includes(channel?.state)) return 'problem';
  if (['starting', 'qr', 'connecting', 'reconnecting'].includes(channel?.state)) return 'pending';
  return 'unknown';
}
function scopedRows(value, tenantId, workspaceId) {
  const seen = new Set();
  return value.filter(row => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || seen.has(row.id)
      || row.tenantId && row.tenantId !== tenantId || workspaceId && row.workspaceId && row.workspaceId !== workspaceId) return false;
    seen.add(row.id); return true;
  });
}
/** null/error/loading is unknown, []/loaded is empty, and partial counts only the
 * loaded subset. Service identities never prove a desktop client is connected.
 * runs prove recorded drafts, not a currently valid inference or delivery. */
export function createOperationReadinessModel({ tenant, workspaceId, session = {}, access = {}, supportMode = false,
  conversations, channels, contacts, assignees, agents, runs, servicePrincipals, metrics, loadState = {} } = {}) {
  const selected = typeof tenant?.id === 'string' && Boolean(tenant.id);
  const manager = selected && session.role === 'reseller' && session.kind !== 'service' && !supportMode && !session.supportGrantId;
  const permissions = Object.fromEntries(['manageCompany', 'manageChannels', 'manageTeam', 'manageAgents', 'manageServices'].map(key => [key, manager && access[key] === true]));
  permissions.inboxRead = selected && session.kind !== 'service' && access.inboxRead === true;
  permissions.contactsRead = selected && session.kind !== 'service' && access.contactsRead === true;
  permissions.metricsRead = permissions.inboxRead && access.metricsRead === true;
  const list = (key, value, allowed) => {
    const state = !allowed ? 'denied' : loadState[key] === undefined ? Array.isArray(value) ? 'loaded' : 'unavailable' : states.has(loadState[key]) ? loadState[key] : 'unavailable';
    const valid = available(state) && Array.isArray(value);
    return { state: available(state) && !valid ? 'unavailable' : state, available: valid, rows: valid ? scopedRows(value, tenant.id, workspaceId) : [] };
  };
  const lists = {
    conversations: list('conversations', conversations, permissions.inboxRead), channels: list('channels', channels, selected && session.kind !== 'service'),
    contacts: list('contacts', contacts, permissions.contactsRead), assignees: list('assignees', assignees, permissions.inboxRead),
    agents: list('agents', agents, selected && session.kind !== 'service' && (permissions.inboxRead || permissions.manageAgents)),
    runs: list('runs', runs, permissions.inboxRead), servicePrincipals: list('servicePrincipals', servicePrincipals, permissions.manageServices),
  };
  const active = lists.conversations.rows.filter(row => ['open', 'pending'].includes(row.status));
  const count = predicate => lists.conversations.available ? active.filter(predicate).length : null;
  const operation = { active: count(() => true), queue: count(row => !row.assignedUserId && row.owner !== 'agent'),
    mine: count(row => Boolean(session.userId) && row.assignedUserId === session.userId), unread: count(row => Number(row.unread) > 0),
    humans: count(row => Boolean(row.assignedUserId)), agents: count(row => !row.assignedUserId && row.owner === 'agent') };
  const connections = Object.fromEntries(['registered', 'connected', 'configured', 'disabled', 'problem', 'pending', 'unknown'].map(key => [key, lists.channels.available ? key === 'registered' ? lists.channels.rows.length : lists.channels.rows.filter(row => operationChannelState(row) === key).length : null]));
  // Channels that receive: a live connection, or a configured one (e-mail stays 'configured'; Meta
  // until its first webhook) with a loaded conversation that proves the reception.
  const conversationChannels = new Set(lists.conversations.rows.map(row => row.channelId));
  const receiving = lists.channels.available ? lists.channels.rows.filter(row => operationChannelState(row) === 'connected' || operationChannelState(row) === 'configured' && conversationChannels.has(row.id)).length : null;
  // Positive receipts describe only the authorized records in this snapshot. A summary without
  // messages or a partial page cannot establish that an entry or response never happened.
  const channelChecks = lists.channels.rows.map(channel => {
    const rows = lists.conversations.rows.filter(row => row.channelId === channel.id);
    const inbound = row => Array.isArray(row.messages) && row.messages.some(message => message?.kind === 'customer');
    const incomingRecorded = rows.some(inbound);
    const responseRecorded = rows.some(row => inbound(row) && row.messages.some(message => message?.kind === 'human' && ['sent', 'delivered', 'read'].includes(message.delivery)));
    const incomplete = !lists.conversations.available || lists.conversations.state === 'partial' || rows.some(row => !Array.isArray(row.messages));
    return { id: channel.id, name: channel.name, connection: operationChannelState(channel),
      incomingRecorded: incomingRecorded ? true : incomplete ? null : false,
      responseRecorded: responseRecorded ? true : incomplete ? null : false, deliveryValidated: null };
  });
  const exchangeRecorded = channelChecks.some(channel => ['connected', 'configured'].includes(channel.connection) && channel.responseRecorded === true);
  const visibleConversationIds = new Set(lists.conversations.rows.map(row => row.id));
  const visibleRuns = lists.runs.rows.filter(row => visibleConversationIds.has(row.conversationId));
  // Decisions the team owes the agents (tool approvals) and agent conversations nobody answered yet.
  const mineIds = new Set(active.filter(row => Boolean(session.userId) && row.assignedUserId === session.userId).map(row => row.id));
  const waiting = visibleRuns.filter(row => row.state === 'waiting_approval');
  operation.approvals = lists.runs.available && lists.conversations.available ? waiting.length : null;
  operation.myApprovals = lists.runs.available && lists.conversations.available ? waiting.filter(row => mineIds.has(row.conversationId)).length : null;
  operation.agentUnanswered = count(row => !row.assignedUserId && row.owner === 'agent' && Number(row.unread) > 0);
  const agentSignals = lists.agents.rows.map(agent => {
    const configured = agent.configured === true && agent.enabled !== false && agent.state !== 'disabled';
    const identities = lists.servicePrincipals.rows.filter(row => row.agentId === agent.id && row.state === 'active' && row.active !== false);
    const recorded = visibleRuns.filter(row => row.agentId === agent.id && row.state === 'draft' && row.agentVersion === (agent.version || 1));
    return { id: agent.id, name: agent.name, provider: agent.provider, configured, serviceVerified: configured && instant(agent.serviceCheckedAt),
      authorizedIdentity: identities.length ? 'recorded' : lists.servicePrincipals.state === 'loaded' ? 'absent' : 'unknown',
      authorizedRequestsObserved: !lists.servicePrincipals.available ? null : identities.some(row => integer(row.usage?.requests) && row.usage.requests > 0) ? true : lists.servicePrincipals.state === 'partial' ? null : false,
      internalDraftRecorded: !lists.runs.available ? null : agent.provider === 'hermes' && agent.mode === 'copilot' && recorded.some(row => row.provider === 'hermes' && row.providerCalled === true && row.externalDraft !== true),
      externalDraftRecorded: !lists.runs.available ? null : agent.provider === 'mcp' && agent.mode === 'copilot' && recorded.some(row => row.provider === 'mcp' && row.externalDraft === true),
      clientConnected: null, inferenceValidated: null };
  });
  const metricState = !permissions.metricsRead ? 'denied' : loadState.metrics === undefined ? metrics ? 'loaded' : 'unavailable' : states.has(loadState.metrics) ? loadState.metrics : 'unavailable';
  const period = metrics?.period;
  const metricValid = available(metricState) && integer(metrics?.totals?.transfers) && instant(period?.from) && instant(period?.to) && Date.parse(period.from) <= Date.parse(period.to)
    && (!metrics.tenantId || metrics.tenantId === tenant.id);
  const transfers = { state: available(metricState) && !metricValid ? 'unavailable' : metricState, count: metricValid ? metrics.totals.transfers : null, period: metricValid ? { from: period.from, to: period.to } : null };
  const setup = [];
  if (manager) setup.push({ id: 'company', title: 'Confira sua empresa', text: 'A empresa selecionada organiza canais, pessoas e atendimentos. Filiais ficam dentro da mesma conta.', status: 'Empresa selecionada', recorded: true, view: permissions.manageCompany ? 'tenants' : null, label: 'Ver empresas e filiais' });
  if (permissions.manageChannels) setup.push({ id: 'channel', title: 'Conecte um canal', text: 'Escolha a conexão, siga a configuração e confira o número ou perfil conectado.', status: !lists.channels.available ? 'Status não disponível' : connections.connected ? 'Canal conectado' : connections.configured ? 'Configurado · validar entrada' : lists.channels.state === 'partial' ? 'Leitura parcial' : 'Conexão pendente', recorded: connections.connected > 0, view: 'channels', label: 'Configurar canais' });
  if (permissions.manageTeam) setup.push({ id: 'team', title: 'Prepare quem vai atender', text: 'Confira pessoas, empresas, canais e departamentos permitidos. Convide a equipe quando precisar.', status: !lists.assignees.available ? 'Responsáveis não disponíveis' : lists.assignees.rows.length ? 'Responsável listado' : 'Confira os acessos da equipe', recorded: lists.assignees.available && lists.assignees.rows.length > 0, view: 'team', label: 'Organizar equipe' });
  if (permissions.manageAgents) {
    const configured = agentSignals.some(agent => agent.configured);
    setup.push({ id: 'agent', title: 'Prepare o apoio de um agente', text: 'Configure um copiloto quando precisar. Revise o rascunho antes de enviar; cadastrar uma identidade não conecta o cliente externo.', status: !lists.agents.available ? 'Agentes não disponíveis' : configured ? 'Configuração salva · teste o rascunho' : lists.agents.state === 'partial' ? 'Leitura parcial' : 'Configuração de agente pendente', recorded: false, optional: true, view: configured && permissions.inboxRead ? 'inbox' : 'agents', label: configured && permissions.inboxRead ? 'Testar rascunho no atendimento' : 'Revisar agentes' });
  }
  if (permissions.inboxRead) setup.push({ id: 'test', title: 'Faça um atendimento de teste', text: exchangeRecorded ? 'Há entrada e resposta enviada no mesmo atendimento. Confira o recebimento no destino antes de começar a operação.' : 'Use um destinatário autorizado. Confira a entrada, assuma e responda pela mesma origem; depois verifique o recebimento.', status: !lists.conversations.available ? 'Atendimentos não disponíveis' : exchangeRecorded ? 'Entrada e resposta registradas' : 'Teste de atendimento pendente', recorded: exchangeRecorded, view: 'inbox', label: 'Abrir atendimento' });
  let nextAction = null;
  const action = (reason, view, title, text, label, parameters = {}) => ({ reason, view, title, text, label, parameters });
  if (permissions.manageChannels && connections.problem > 0) nextAction = action('connection-problem', 'channels', 'Revise as conexões com problema', 'Abra o canal para conferir o estado e recuperar a conexão existente.', 'Revisar canais');
  else if (permissions.manageChannels && lists.channels.available && !connections.connected && connections.configured > 0) nextAction = action('validate-channel', 'channels', 'Valide a entrada do canal configurado', 'Configuração salva ainda não comprova recebimento. Use uma origem autorizada e confira o atendimento.', 'Abrir canais');
  else if (permissions.manageChannels && !connections.connected && connections.pending > 0) nextAction = action('finish-channel', 'channels', 'Conclua a conexão em andamento', 'Confira a configuração e o estado atual do canal antes de testar o atendimento.', 'Abrir canais');
  else if (permissions.manageChannels && !connections.connected && connections.disabled > 0) nextAction = action('disabled-channel', 'channels', 'Confira os canais desabilitados', 'A recepção está desabilitada nesses registros. Revise a configuração conforme a necessidade da empresa.', 'Revisar canais');
  else if (permissions.manageChannels && lists.channels.state === 'loaded' && !connections.connected) nextAction = action('connect-channel', 'channels', 'Conecte o primeiro canal', 'Cadastre a conexão e valide a entrada de uma mensagem. Depois, acompanhe tudo em Atendimento.', 'Abrir canais');
  else if (operation.queue > 0) nextAction = action('queue', 'inbox', operation.queue === 1 ? '{count} atendimento na fila' : '{count} atendimentos na fila', 'Abra uma conversa abaixo para conferir a origem e o responsável antes de assumir.', 'Ver a caixa de atendimento', { count: operation.queue });
  else if (operation.mine > 0) nextAction = action('mine', 'inbox', 'Continue seus atendimentos', 'Confira a origem e as conversas sob sua responsabilidade nesta empresa.', 'Abrir atendimento');
  else if (permissions.inboxRead && !lists.conversations.available) nextAction = action('load-inbox', 'inbox', 'Confira os dados do atendimento', 'A leitura desta atualização não está disponível. Abra a caixa para consultar o estado atual.', 'Abrir atendimento');
  else if (permissions.contactsRead && lists.contacts.state === 'loaded' && !lists.contacts.rows.some(row => !row.archivedAt && !row.mergedIntoId)) nextAction = action('contacts', 'contacts', 'Prepare sua agenda', access.contactsWrite === true ? 'Cadastre contatos ou importe sua agenda na tela Contatos. Os próximos atendimentos também alimentam o cadastro.' : 'Os cadastros das novas conversas aparecerão na agenda desta empresa.', 'Abrir contatos');
  else if (permissions.inboxRead) nextAction = action('inbox', 'inbox', 'Acompanhe a caixa de atendimento', lists.conversations.state === 'partial' ? 'O retrato é parcial. Consulte a caixa para conferir os atendimentos acessíveis.' : 'Confira a fila, os responsáveis e as conversas da sua operação.', 'Abrir atendimento');
  else if (permissions.contactsRead) nextAction = action('contacts', 'contacts', 'Organize os dados da operação', 'Use as áreas disponíveis para seu acesso nesta empresa.', 'Abrir contatos');
  else if (permissions.manageChannels) nextAction = action('channels', 'channels', 'Confira as conexões da empresa', 'Abra Canais para consultar o estado das conexões.', 'Ver canais');
  const people = lists.assignees.available ? lists.assignees.rows.length : null;
  return { scope: { tenantId: selected ? tenant.id : null }, manager, permissions, people, receiving,
    data: Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, { state: list.state, available: list.available }])),
    operation, connections, transfers, agentSignals, channelChecks, setup, exchangeRecorded, nextAction };
}

// The brand a workspace receives when it is provisioned (src/store.js provisionReseller, the platform's
// own identity). It is only compared, never shown: the first use of a reseller marks Marca as done once
// the name, the logo or the color differ from it. Telling it apart without this value needs the server
// to say so (for example boot.reseller.brandCustomized).
const PROVISIONED_BRAND = Object.freeze({ name: 'Elozi', accent: DEFAULT_ACCENT });
/** True when the workspace brand differs from the brand it was provisioned with (name, logo or color). */
export function brandCustomized(brand) {
  if (!brand || typeof brand !== 'object') return false;
  const accent = typeof brand.accent === 'string' ? brand.accent.trim().toLowerCase() : PROVISIONED_BRAND.accent;
  return Boolean(brand.logo) || typeof brand.name === 'string' && brand.name.trim() !== '' && brand.name.trim() !== PROVISIONED_BRAND.name || accent !== PROVISIONED_BRAND.accent;
}

/**
 * First use (#setup, FRONTEND-V2 §5.6) derived from the data of the readiness model. Each step is
 * {id, group, state:'done'|'todo'|'unknown'|'info', optional}; only prefs (dismissed, solo) come
 * from the person. kind: company (admin), reseller (admin of a reseller account) or attendant.
 * portfolio: client accounts of the reseller (null while unknown).
 */
export function deriveSetup(readiness, { accountKind = null, brand = null, prefs = {}, portfolio = null, validation } = {}) {
  if (!readiness?.scope?.tenantId) return { kind: null, steps: [], done: 0, total: 0, complete: false, dismissed: false };
  if (!readiness.manager) return { kind: 'attendant', steps: [], done: 0, total: 0, complete: false, dismissed: prefs.dismissed === true };
  const { data, connections } = readiness;
  const step = (id, state, extra = {}) => ({ id, group: 'company', state, optional: false, ...extra });
  const people = readiness.people;
  const testKnown = data.conversations.state === 'loaded' && data.channels.state === 'loaded'
    && readiness.channelChecks.every(channel => channel.responseRecorded !== null);
  const steps = [
    step('company', 'done'),
    step('channel', !data.channels.available ? 'unknown' : (readiness.receiving ?? connections.connected) > 0 ? 'done' : 'todo', { connected: readiness.receiving ?? connections.connected ?? 0 }),
    step('team', prefs.solo === true ? 'done' : !data.assignees.available ? 'unknown' : people > 1 ? 'done' : 'todo', { solo: prefs.solo === true, people }),
    step('agent', !data.agents.available ? 'unknown' : readiness.agentSignals.some(agent => agent.configured) ? 'done' : 'todo', { optional: true }),
    step('test', validation === undefined ? readiness.exchangeRecorded ? 'done' : testKnown ? 'todo' : 'unknown'
      : validation?.state !== 'loaded' ? 'unknown' : (validation.items || []).some(item => item.tenantId === readiness.scope.tenantId
        && readiness.channelChecks.some(channel => channel.id === item.channelId) && channelValidatedForUse(item)) ? 'done' : 'todo')
  ];
  if (accountKind === 'reseller') {
    const clients = Array.isArray(portfolio) ? portfolio.length : null;
    steps.push(step('brand', brandCustomized(brand) ? 'done' : 'todo', { group: 'reseller' }),
      step('domain', 'info', { group: 'reseller', optional: true }),
      step('client', clients === null ? 'unknown' : clients > 0 ? 'done' : 'todo', { group: 'reseller', clients }),
      step('plan', 'info', { group: 'reseller', optional: true }),
      step('help', 'info', { group: 'reseller', optional: true }));
  }
  const required = steps.filter(item => !item.optional);
  const done = required.filter(item => item.state === 'done').length;
  return { kind: accountKind === 'reseller' ? 'reseller' : 'company', steps, done, total: required.length, complete: done === required.length, dismissed: prefs.dismissed === true };
}

const ONBOARDING_KEYS = Object.freeze(['companyCreated', 'administratorActive', 'channelConnected', 'teamReady', 'contractConfigured']);
const WEEK = 7 * 86400000;
/**
 * Client portfolio of a reseller from GET /api/accounts (commercial-accounts DTO): the business
 * accounts whose parent is this workspace, each with its onboarding steps and the reasons it needs
 * the reseller: administrator not active, no channel 7 days after creation, channels registered but
 * none connected 7 days after creation. The DTO counts only state 'connected' (an e-mail channel
 * stays 'configured'), so one connected channel among several is not a reason: it cannot tell a
 * dropped number from a configured e-mail. partial: the page did not bring every account (total).
 * now is the caller's clock (this module never reads one).
 */
export function portfolioModel(result, workspaceId, { now = null } = {}) {
  const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
  const clients = accounts.filter(account => account && typeof account.id === 'string' && account.id !== workspaceId && account.parentWorkspaceId === workspaceId && account.accountKind === 'business').map(account => {
    const onboarding = account.onboarding && typeof account.onboarding === 'object' ? account.onboarding : {};
    const counts = account.counts && typeof account.counts === 'object' ? account.counts : {};
    const number = value => integer(value) ? value : null;
    const steps = ONBOARDING_KEYS.map(key => ({ key, done: onboarding[key] === true, known: typeof onboarding[key] === 'boolean' }));
    const created = instant(account.createdAt) ? Date.parse(account.createdAt) : null;
    const channels = number(counts.channels), connected = number(counts.connectedChannels);
    const reasons = [];
    if (onboarding.administratorActive === false) reasons.push('admin-inactive');
    const settled = created !== null && Number.isFinite(now) && now - created >= WEEK;
    if (channels === 0 && settled) reasons.push('no-channel');
    if (channels > 0 && connected === 0 && settled) reasons.push('no-connection');
    return { id: account.id, name: typeof account.name === 'string' && account.name ? account.name : null, steps, done: steps.filter(step => step.done).length, total: steps.length,
      channels, connected, agents: number(counts.activeAgents), users: number(counts.users), reasons };
  });
  const loaded = accounts.length, total = integer(result?.total) && result.total >= loaded ? result.total : loaded;
  return { clients, attention: clients.filter(client => client.reasons.length), loaded, total, partial: result?.hasMore === true || total > loaded };
}

