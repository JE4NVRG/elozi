import { h, raw, t as i18nText, getLocale } from './i18n.js';
import './locales-operations.js';
import './locales-agent-rail.js';
import './locales-telegram-account.js';
import { button, avatar, attributes } from './ui.js';
import { glyph } from './icons.js';
import { keyboard } from './keyboard.js';
import { dispatchAction } from './actions.js';
import { mcpServerLabel } from './mcp-catalog.js';

// Agent rail of the conversation (FRONTEND-V2 §5.2.3, §8.5). Owned by P4.
//
// Contract (§8.2): createAgentRail(ctx) → {render, timelineItems, contextTab, listGlyph, act, submit, reset, …}.
// - render(conversation): the rail above the composer, in priority order: daily quota banner, autopilot
//   status, blocking approval card, draft card (current or stale), then the line of the latest run
//   (preparing with its real phase, tool running, failure, busy). SafeHTML; '' when there is nothing.
// - timelineItems(conversation): inline receipts [{id, at, kind, markup}] sorted by time: automatic
//   lookups (only when the server marked autoApproved), human approvals and rejections with name and time.
// - contextTab(conversation): the Agente tab of the context panel (identity, current run, sources,
//   guidance for the agent and "Gerar rascunho").
// - listGlyph(item): static ✦ of a list row (agentState from /api/inbox when present, else loaded runs).
// - act(name, id, element): the 'rail:*' actions (registry) and the legacy mcp-approve, mcp-reject and
//   mcp-regenerate (app.js, valid until P10). submit(form): data-form="rail:generate" of the Agente tab.
// - openRun(conversation, agent): app.js run-agent (the ✦ of the composer) generates without guidance.
// - status, autopilotState, generateState, composerButton and insertedRun serve the hosts of P3 (tab that
//   opens on a pending approval, owner=agent banner, ✦ button of the composer, sourceRunId of the send).
// Honesty rules: "Consulta automática" only when the server says autoApproved; approval has no keyboard
// shortcut (rail:approve/rail:reject only from the focused card button) and ends at expiresAt; a decision is
// confirmed only by the run the server answers; a 429 never retries by itself; the engine name only for the
// platform owner; tokens and time only for administrators.
// Screen readers: the host redraws the rail on every poll, so the rail markup carries no live roles. Real
// transitions are said once by two regions outside the host ([data-rail-announcer]); after an action the
// focus goes to what the action produced (receipt, line, new run), never to <body>.

export const activeRunStates = new Set(['queued', 'running', 'waiting_approval', 'tool_running']);
/** Classifications of a run while the agent still holds the conversation. */
export const ACTIVE_KINDS = new Set(['running', 'lookup', 'tool', 'approval']);
export const MAX_AUTO_LOOKUPS = 3;
export const BUSY_RETRY_MS = 10_000;
export const APPROVAL_WINDOW_MS = 600_000;
const EXPIRY_TICK_MS = 30_000;
const BUSY_REASON = 'O serviço de IA está ocupado agora. Tente novamente em instantes.';
const QUOTA_REASON = 'O limite diário de IA desta empresa foi atingido.';
const AUTO_LOOKUP_FAILURES = new Set(['A consulta automática não foi concluída. Prepare um novo rascunho.', 'A consulta automática foi interrompida. Prepare um novo rascunho.']);
// Server reasons shown as they are (each one has an EN entry in locales-agent-rail.js).
const KNOWN_REASONS = new Set([
  'Execução interrompida ou tempo limite atingido.', 'Não foi possível obter o rascunho do serviço do agente.',
  'A preparação da resposta foi interrompida; o resultado da ferramenta foi preservado.', 'Execução interrompida pela reinicialização do serviço.',
  'A aprovação perdeu validade antes da consulta.', 'A conversa ou configuração mudou durante a execução.', 'O acesso ao atendimento mudou. Solicite um novo rascunho.',
  'Cancelado pelo atendente.', 'Ferramenta recusada pelo atendente.', ...AUTO_LOOKUP_FAILURES
]);
// Reasons that name the AI provider or engine: only the platform owner reads them as they are.
const PROVIDER_REASON = /CommandCode|Hermes|provedor/i;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stateOf = run => run?.state || run?.status;
const time = value => { const parsed = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };
const domId = value => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const staleFlag = run => run?.stale === true || isObject(run?.stale);
const draftState = run => ['draft', 'completed', 'succeeded'].includes(stateOf(run));
const steps = run => (Array.isArray(run?.toolSteps) ? run.toolSteps : []).filter(isObject);
const automaticSteps = run => steps(run).filter(step => step.autoApproved === true);
const toolTitle = proposal => String(proposal?.title || proposal?.toolName || '').trim() || i18nText('ferramenta');
const toolPath = proposal => {
  const server = mcpServerLabel(String(proposal?.serverName || proposal?.serverId || '').trim());
  return server ? `${server} › ${toolTitle(proposal)}` : toolTitle(proposal);
};
const personName = value => String(isObject(value) ? value.name || value.id || '' : value || '').trim();
const json = value => { try { return JSON.stringify(value ?? null, null, 2); } catch { return 'null'; } };
const expiredNote = () => i18nText('Esta proposta expirou. Nada foi executado.');

/**
 * Whether the server accepted this decision, read from the run it answers (or reloaded): an approval writes the
 * receipt of this proposal; an expired or outdated proposal comes back invalidated, at most with the receipt of an
 * earlier automatic lookup. A rejection leaves the run rejected.
 */
export function decisionConfirmed(run, decision, proposalId) {
  if (!isObject(run)) return false;
  if (decision === 'reject') return stateOf(run) === 'rejected';
  const receipt = run.toolReceipt;
  if (!receipt?.approvedAt || receipt.autoApproved === true) return false;
  return receipt.proposalId ? receipt.proposalId === proposalId : stateOf(run) !== 'invalidated';
}

/** Elapsed time of a running run: "4 s", "1 min 5 s" (updated every second by tickRail). */
export function elapsedText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
}

/** Duration of a lookup or a run: "0,4 s" / "0.4 s", "12 s", "1 min 5 s"; '' when unknown. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = ms / 1000;
  if (seconds < 60) {
    const digits = seconds < 10 ? 1 : 0;
    return `${new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60);
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Hour of an event in the person's language ("14:03"); '' when the date is invalid. */
export function clockTime(value) {
  const parsed = time(value);
  return parsed === null ? '' : new Date(parsed).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}

/** Remaining time of an approval, as people read it. */
export function expiryText(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return i18nText('expirada');
  if (ms < 60_000) return i18nText('expira em menos de 1 min');
  return i18nText('expira em {minutes} min', { minutes: Math.ceil(ms / 60_000) });
}

const countdownText = ms => i18nText('Disponível em {seconds} s', { seconds: Math.max(1, Math.ceil(ms / 1000)) });

/**
 * How the rail presents a run (§5.2.3), never inferred from the agent policy: approval · running ·
 * lookup (automatic lookup running) · tool (human-approved tool running) · draft · stale ·
 * draft_unavailable · busy · lookup_failed · tool_unknown (external tools only) · failed · invalidated ·
 * cancelled · rejected · unknown.
 */
export function classifyRun(run, conversation) {
  const status = stateOf(run), proposal = run?.toolProposal, receipt = run?.toolReceipt;
  if (status === 'waiting_approval') return proposal && proposal.autoApproved !== true ? 'approval' : 'running';
  if (status === 'queued' || status === 'running') return 'running';
  if (status === 'tool_running') return receipt?.autoApproved === true ? 'lookup' : 'tool';
  if (draftState(run)) {
    if (typeof run.draft !== 'string' || !run.draft.trim()) return 'draft_unavailable';
    const moved = Number.isSafeInteger(run.conversationVersion) && Number.isSafeInteger(conversation?.version) && run.conversationVersion !== conversation.version;
    return staleFlag(run) || moved ? 'stale' : 'draft';
  }
  // An unconfirmed action only exists outside: an internal read-only lookup has nothing to reconcile.
  if (status === 'tool_unknown') return proposal?.readOnly === true ? 'lookup_failed' : 'tool_unknown';
  if (status === 'failed') {
    if (run.reason === BUSY_REASON || [run.code, run.errorCode, run.reasonCode].includes('service_busy')) return 'busy';
    if (receipt?.autoApproved === true && receipt.state !== 'completed' || AUTO_LOOKUP_FAILURES.has(run.reason)) return 'lookup_failed';
    return 'failed';
  }
  if (['invalidated', 'cancelled', 'rejected'].includes(status)) return status;
  return 'unknown';
}

/** An invalidated draft followed by a public reply is history, never a pending composer problem. */
export function isHistoricalInvalidation(run, conversation) {
  if (stateOf(run) !== 'invalidated' || !conversation?.id || run.conversationId !== conversation.id) return false;
  if (!Number.isSafeInteger(run.conversationVersion) || !Number.isSafeInteger(conversation.version) || run.conversationVersion >= conversation.version) return false;
  const receipt = run.toolReceipt;
  if (receipt?.autoApproved !== true && ['in_flight', 'unknown'].includes(receipt?.state)) return false;
  const ended = time(run.updatedAt);
  return ended !== null && (conversation.messages || []).some(message => ['human', 'agent'].includes(message.kind) && time(message.createdAt) !== null && time(message.createdAt) > ended);
}

/** Duration of one lookup when the server tells it (durationMs, start and end, or the latest receipt); else null. */
export function stepDuration(run, step) {
  if (Number.isFinite(step?.durationMs) && step.durationMs >= 0) return step.durationMs;
  const start = time(step?.startedAt ?? step?.dispatchedAt), end = time(step?.completedAt);
  if (start !== null && end !== null && end >= start) return end - start;
  const receipt = run?.toolReceipt;
  if (receipt?.proposalId && receipt.proposalId === step?.proposalId) {
    const from = time(receipt.dispatchedAt), to = time(receipt.completedAt);
    if (from !== null && to !== null && to >= from) return to - from;
  }
  return null;
}

const autoLabel = (tool, ms) => ms === null ? i18nText('Consulta automática · {tool}', { tool }) : i18nText('Consulta automática · {tool} · {duration}', { tool, duration: formatDuration(ms) });

/**
 * Receipts of one run: automatic lookups (autoApproved from the server only), the human approval and the
 * rejection, each with the tool, the person and the time; the latest lookup keeps its result.
 */
export function runReceipts(run) {
  const items = [], receipt = run?.toolReceipt, proposal = run?.toolProposal;
  const latest = step => Boolean(receipt?.proposalId) && receipt.proposalId === step.proposalId && receipt.state === 'completed';
  const result = () => Object.hasOwn(receipt, 'result') ? { result: receipt.result, summarized: receipt.summarized === true } : {};
  steps(run).forEach((step, index) => {
    if (step.autoApproved !== true) return;
    const tool = String(step.title || step.toolName || '').trim() || i18nText('consulta interna');
    items.push({ id: `${run.id}:auto:${index}`, runId: run.id, at: step.completedAt || null, kind: 'auto', label: autoLabel(tool, stepDuration(run, step)), error: step.isError === true, ...(latest(step) ? result() : {}) });
  });
  // A completed automatic receipt without its step (older runs) still counts, from the server flag only.
  if (receipt?.autoApproved === true && receipt.state === 'completed' && !steps(run).some(step => step.autoApproved === true && step.proposalId && step.proposalId === receipt.proposalId)) {
    const from = time(receipt.dispatchedAt), to = time(receipt.completedAt);
    items.push({ id: `${run.id}:auto:receipt`, runId: run.id, at: receipt.completedAt || receipt.approvedAt || null, kind: 'auto', label: autoLabel(toolTitle(proposal), from !== null && to !== null && to >= from ? to - from : null), ...result() });
  }
  if (receipt?.approvedAt && receipt.autoApproved !== true) {
    const name = personName(receipt.approvedBy), at = clockTime(receipt.approvedAt), tool = toolPath(proposal);
    items.push({ id: `${run.id}:approved`, runId: run.id, at: receipt.approvedAt, kind: 'approved', name, time: at,
      label: name ? i18nText('{name} aprovou {tool} · {time}', { name, tool, time: at }) : i18nText('Aprovada: {tool} · {time}', { tool, time: at }),
      ...(receipt.state === 'completed' ? result() : {}) });
  }
  if (receipt?.state === 'rejected' || stateOf(run) === 'rejected' && receipt?.rejectedAt) {
    const name = personName(receipt.rejectedBy), at = clockTime(receipt.rejectedAt || run.updatedAt), tool = toolTitle(proposal);
    items.push({ id: `${run.id}:rejected`, runId: run.id, at: receipt.rejectedAt || run.updatedAt || null, kind: 'rejected', name, time: at,
      label: name ? i18nText('Recusada por {name} · {tool} · {time}', { name, tool, time: at }) : i18nText('Recusada · {tool} · {time}', { tool, time: at }) });
  }
  return items;
}

/** One receipt (.ui-receipt): a narrow line with the agent rule; "ver" opens the result when there is one. */
export function receiptMarkup(item) {
  const mark = item.kind === 'approved' ? glyph('check', 'ui-receipt__check') : item.kind === 'rejected' ? glyph('close', 'ui-receipt__cross') : h`<span class="ui-receipt__spark">✦</span>`;
  const error = item.error ? h`<span class="ui-receipt__error">${i18nText('retornou erro')}</span>` : '';
  const line = h`<span class="ui-receipt__mark" aria-hidden="true">${mark}</span><span class="ui-receipt__label">${item.label}</span>${error}`;
  const state = attributes({ 'data-kind': item.kind, 'data-rail-receipt': item.id, 'data-enter': item.enter ? '' : null, tabindex: item.focus ? '-1' : null, 'data-rail-focus': item.focus ? `receipt:${item.runId}` : null });
  if (!Object.hasOwn(item, 'result')) return h`<p class="ui-receipt"${state}>${line}</p>`;
  const note = item.summarized ? h`<small class="ui-receipt__note">${i18nText('Resumo da consulta. O conteúdo completo foi entregue somente ao copiloto.')}</small>` : '';
  return h`<details class="ui-receipt"${state}><summary class="ui-receipt__summary">${line}<span class="ui-receipt__more">${i18nText('ver')}</span></summary><pre class="ui-receipt__result" tabindex="0">${json(item.result)}</pre>${note}</details>`;
}

/**
 * Clocks of a rendered rail: elapsed seconds, approval expiry (every 30 s; the bar is CSS and stays static
 * with reduced motion) and the 10 s busy wait. Returns how many live clocks remain.
 */
export function tickRail(root, at = Date.now()) {
  if (!root?.querySelectorAll) return 0;
  let live = 0;
  for (const node of root.querySelectorAll('[data-rail-since]')) {
    const since = time(node.dataset?.railSince);
    if (since === null) continue;
    live++; const text = elapsedText(at - since); if (node.textContent !== text) node.textContent = text;
  }
  for (const node of root.querySelectorAll('[data-rail-expires]')) {
    const expires = time(node.dataset?.railExpires), last = Number(node.dataset?.railTick || 0);
    if (expires === null || node.dataset.railExpired === 'true') continue;
    if (expires <= at) { expireApproval(node); continue; }
    live++;
    if (last && at - last < EXPIRY_TICK_MS) continue;
    node.dataset.railTick = String(at); node.textContent = expiryText(expires - at);
  }
  for (const node of root.querySelectorAll('[data-rail-wait-until]')) {
    const until = Number(node.dataset?.railWaitUntil);
    if (!Number.isFinite(until)) continue;
    if (at < until) { live++; continue; }
    node.disabled = false; node.removeAttribute?.('data-rail-wait-until'); if (node.dataset) delete node.dataset.railWaitUntil;
  }
  for (const node of root.querySelectorAll('[data-rail-countdown]')) {
    const until = Number(node.dataset?.railCountdown);
    if (!Number.isFinite(until)) continue;
    if (at >= until) { node.textContent = ''; node.hidden = true; continue; }
    live++; const text = countdownText(until - at); if (node.textContent !== text) node.textContent = text;
  }
  return live;
}

// The moment a proposal expires (between two polls), the card stops offering the decision: the server
// already treats it as gone and would answer an approval with an invalidated run.
function expireApproval(node) {
  node.dataset.railExpired = 'true'; node.textContent = expiryText(0);
  const card = node.closest?.('[data-rail-approval]');
  for (const control of card?.querySelectorAll?.('[data-action="rail:approve"], [data-action="rail:reject"]') || []) control.disabled = true;
  const note = card?.querySelector?.('.ui-approval__note');
  if (note) note.textContent = expiredNote();
}

const GLYPHS = {
  running: ['agent', 'Agente preparando um rascunho'], waiting_approval: ['warning', 'Aprovação do agente pendente'],
  draft: ['agent', 'Rascunho do agente pronto'], stale: ['stale', 'Rascunho do agente desatualizado']
};
const STEP_STATES = { done: 'concluído', current: 'em andamento', waiting: 'aguardando', warning: 'atenção', error: 'não concluído' };
const STEP_MARKS = { done: '✓', error: '✕', warning: '!', current: '•', waiting: '•' };

export function createAgentRail(ctx = {}) {
  const { api, tenantApi = path => path, refresh, render: renderApp, toast = () => {}, canReplyTo = () => false, renderRuns = () => {},
    knowledgeReferences = () => '', memoryReferences = () => '' } = ctx;
  const state = ctx.state || {};
  const now = () => typeof ctx.now === 'function' ? ctx.now() : Date.now();
  const doc = () => ctx.document ?? globalThis.document;
  const scope = () => `${state.workspaceId}:${state.tenant?.id}`;
  const session = () => state.boot?.session || {};
  const isAdmin = () => session().role === 'reseller';
  const canTuneQuota = () => isAdmin() && !state.supportGrantId;
  const platformOwner = () => session().platformOwner === true;
  const currentConversation = () => (state.tenant?.conversations || []).find(item => item.id === state.conversation);
  const aiPolicy = conversation => {
    const channel = (state.tenant?.channels || []).find(item => item.id === conversation?.channelId), capabilities = channel?.capabilities || conversation?.capabilities;
    const allowed = capabilities?.aiAllowed !== false && channel?.transport !== 'telegram-user' && conversation?.transport !== 'telegram-user';
    return { allowed, reason: allowed ? null : i18nText(capabilities?.aiReason || 'Conversas da conta Telegram pessoal estão disponíveis para atendimento humano. Uso por IA exige consentimento específico dos participantes.') };
  };
  const runsOf = conversationId => (state.tenant?.runs || []).filter(run => run?.conversationId === conversationId);
  const findRun = runId => (state.tenant?.runs || []).find(run => run?.id === runId);
  const agentOf = agentId => (state.tenant?.agents || []).find(agent => agent?.id === agentId);
  const hasActive = conversationId => runsOf(conversationId).some(run => activeRunStates.has(stateOf(run)));
  const conversationKey = conversation => `${scope()}:${conversation?.id}`;
  const day = () => { const date = new Date(now()); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; };

  let pendingFocus = null, focusQueued = false, clock = null, announcedView = null;
  const decisions = new Set(), regenerating = new Set(), cancelling = new Set(), requesting = new Set(), confirmations = new Set(), expandedDrafts = new Set();
  const seen = new Map(), busy = new Map(), quota = new Map(), inserted = new Map(), instructions = new Map();
  // Last sentence said per conversation slot, and runs whose next change the person caused here (the toast and the focus say it).
  const spoken = new Map(), quietOnce = new Set();
  /** Focus wanted after an action: the first of these keys present in the next render of the rail. */
  const wantFocus = (...keys) => { pendingFocus = { keys: keys.flat().filter(Boolean), conversationId: state.conversation, tries: 0 }; return pendingFocus; };
  const proposalExpired = run => { const expires = time(run?.toolProposal?.expiresAt); return expires !== null && expires <= now(); };

  const lastMessageId = conversation => { const id = (conversation?.messages || []).at(-1)?.id; return typeof id === 'string' && id ? id : null; };
  // Version and last message of the current view let the server accept a request that lags only by newer customer messages.
  const requestRun = (conversation, agentId, instruction = '') => api(tenantApi(`conversations/${encodeURIComponent(conversation.id)}/run`), { method: 'POST', body: JSON.stringify({ version: conversation.version, agentId, ...(lastMessageId(conversation) ? { lastMessageId: lastMessageId(conversation) } : {}), ...(instruction ? { instruction } : {}) }) });

  /** Agent name defined by the company; the engine fallback ("Hermes") stays hidden from everyone but the platform owner. */
  function agentName(run) {
    const agent = agentOf(run?.agentId), name = String(agent?.name || run?.agentName || '').trim();
    if (!name || !agent?.name && name === 'Hermes' && !platformOwner()) return i18nText('Assistente');
    return name;
  }
  const kindLabel = agent => agent?.provider === 'mcp' ? i18nText('Agente conectado (MCP)') : i18nText('Copiloto gerenciado');
  const policyLabel = agent => agent?.toolPolicy === undefined || agent?.toolPolicy === 'auto_readonly' ? i18nText('consultas internas automáticas') : i18nText('aprovação em cada uso de ferramenta');
  const motorLabel = provider => platformOwner() && provider !== 'mcp' ? i18nText('Motor: {engine}', { engine: 'Hermes' }) : '';

  function paint() { try { renderRuns(); } catch { /* the host may be gone */ } }
  const sameView = (expectedScope, conversationId) => scope() === expectedScope && state.conversation === conversationId;

  async function syncRuns(conversationId, expectedScope, origin) {
    if (ctx.loadRuns) return ctx.loadRuns(conversationId, expectedScope, origin);
    const result = await api(tenantApi(`conversations/${encodeURIComponent(conversationId)}/runs`));
    if (!sameView(expectedScope, conversationId)) return false;
    state.tenant.runs = [...(state.tenant.runs || []).filter(run => run.conversationId !== conversationId), ...(result.runs || [])];
    renderRuns();
    return true;
  }
  // After a new run: the scoped loader when the host has one, else the legacy full refresh.
  async function reloadAfterRun(conversationId, expectedScope) {
    if (ctx.loadRuns) return ctx.loadRuns(conversationId, expectedScope);
    if (typeof refresh === 'function') { await refresh(); renderApp?.(); return true; }
    return syncRuns(conversationId, expectedScope);
  }

  // ---------------------------------------------------------------------------------------------
  // Quota, busy and the generate button

  // The daily limit of the company (tenant.aiDailyTokenLimit, aiLimitVersion): a quota refusal holds until
  // midnight or until an administrator changes the limit, whichever comes first.
  const limitOf = () => [state.tenant?.aiDailyTokenLimit ?? null, state.tenant?.aiLimitVersion ?? null];
  function quotaActive() {
    const entry = quota.get(scope());
    return Boolean(entry && entry.day === day() && JSON.stringify(entry.limit) === JSON.stringify(limitOf()));
  }
  const isQuotaError = error => error?.status === 429 && (error.code === 'ai_quota_exceeded' || [QUOTA_REASON, i18nText(QUOTA_REASON)].includes(error.message));
  function remember429(error, conversation, agentId, instruction) {
    if (isQuotaError(error)) quota.set(scope(), { day: day(), agentId, limit: limitOf() });
    else busy.set(conversationKey(conversation), { at: now(), agentId, instruction });
  }
  function busyWait(conversation) {
    const entry = busy.get(conversationKey(conversation));
    return entry ? Math.max(0, entry.at + BUSY_RETRY_MS - now()) : 0;
  }
  const eligibleAgents = () => (state.tenant?.agents || []).filter(agent => agent?.provider === 'hermes' && agent.mode === 'copilot' && agent.configured === true);
  // The agent chosen in "Agente do atendimento" of the context panel (#assigned-agent, P3), as run-agent did.
  const pickedAgent = () => { const value = doc()?.querySelector?.('#assigned-agent')?.value; return typeof value === 'string' && value ? value : undefined; };
  function defaultAgent(conversation, preferredId) {
    const agents = eligibleAgents();
    if (conversation?.owner === 'agent') return agents.find(agent => agent.id === conversation.agentId) || null;
    return agents.find(agent => agent.id === preferredId) || agents.find(agent => agent.id === conversation?.agentId) || agents[0] || null;
  }

  /** Whether "Gerar rascunho" may run now, and the reason shown in its tooltip when it may not. */
  function generateState(conversation = currentConversation(), agentId = pickedAgent()) {
    const refuse = reason => ({ enabled: false, reason, agent: null });
    if (!conversation) return refuse(i18nText('Abra um atendimento para preparar um rascunho.'));
    const policy = aiPolicy(conversation); if (!policy.allowed) return refuse(policy.reason);
    if (!canReplyTo(conversation)) return refuse(i18nText('O responsável coordena o agente deste atendimento.'));
    if (conversation.status === 'closed') return refuse(i18nText('O atendimento está encerrado.'));
    const agent = defaultAgent(conversation, agentId);
    if (!agent) return refuse(conversation.owner === 'agent' ? i18nText('Este atendimento está com outro agente.') : i18nText('Nenhum agente configurado para preparar rascunhos nesta empresa.'));
    if (quotaActive()) return refuse(i18nText('Cota diária de IA atingida. Renova às 00:00.'));
    if (hasActive(conversation.id) || requesting.has(conversationKey(conversation))) return refuse(i18nText('O agente já está trabalhando neste atendimento.'));
    const wait = busyWait(conversation);
    if (wait > 0) return refuse(i18nText('O assistente está atendendo outras execuções agora. Tente de novo em {seconds} s.', { seconds: Math.ceil(wait / 1000) }));
    return { enabled: true, reason: null, agent };
  }

  /** The ✦ button of the composer (P3): generates without guidance; disabled with the reason in its tooltip. */
  function composerButton(conversation = currentConversation()) {
    const status = generateState(conversation);
    return button({ label: i18nText('Rascunho'), icon: 'spark', action: 'rail:generate', variant: 'ghost', size: 'sm', kbd: keyboard.singleKeyEnabled?.() ? 'c' : undefined,
      disabledReason: status.enabled ? null : status.reason, className: 'pg-rail__generate', attrs: { 'data-id': conversation?.id ?? null, ...(status.enabled ? { title: i18nText('Gerar rascunho com o agente') } : {}) } });
  }

  /**
   * Asks the agent for a draft. A 429 shows the quota banner or the busy line and never retries by itself.
   * focus: the keys a rail control that started the request falls back to (the new run's card comes first).
   */
  async function generate(conversation, { instruction = '', agentId = pickedAgent(), focus = null } = {}) {
    const status = generateState(conversation, agentId);
    if (!status.enabled) throw new Error(status.reason);
    if (instruction.length > 1000) throw new Error(i18nText('Use até 1.000 caracteres na orientação.'));
    const expectedScope = scope(), conversationId = conversation.id, key = conversationKey(conversation);
    requesting.add(key); paint();
    let created;
    try {
      created = await requestRun(conversation, status.agent.id, instruction);
    } catch (error) {
      requesting.delete(key);
      if (error?.status === 429) remember429(error, conversation, status.agent.id, instruction);
      if (sameView(expectedScope, conversationId)) {
        const pending = focus && error?.status === 429 ? wantFocus(`busy:${conversationId}`, 'quota', focus) : null;
        paint();
        if (pending) settleFocus(pending);
      }
      if (error?.status !== 429) throw error;
      return false;
    }
    requesting.delete(key); busy.delete(key); quota.delete(scope());
    if (!sameView(expectedScope, conversationId)) return false;
    // The reload repaints the rail with the new run (scoped loader, or the legacy full refresh).
    const pending = focus ? wantFocus(isObject(created) && created.id ? `run:${created.id}` : null, focus) : null;
    await reloadAfterRun(conversationId, expectedScope);
    if (pending) settleFocus(pending);
    if (sameView(expectedScope, conversationId)) toast(i18nText('Copiloto acionado. A resposta aparecerá como rascunho.'));
    return true;
  }

  async function retry(conversationId, element) {
    const conversation = currentConversation();
    if (!conversation || conversationId && conversation.id !== conversationId) throw new Error(i18nText('O contexto mudou. Acione o agente novamente no atendimento atual.'));
    if (!aiPolicy(conversation).allowed) throw new Error(aiPolicy(conversation).reason);
    const entry = busy.get(conversationKey(conversation)), run = findRun(element?.dataset?.run);
    const at = entry?.at ?? (run?.conversationId === conversation.id ? time(run.updatedAt) : null);
    if (at !== null && at + BUSY_RETRY_MS > now()) throw new Error(i18nText('Aguarde {seconds} s para tentar de novo.', { seconds: Math.ceil((at + BUSY_RETRY_MS - now()) / 1000) }));
    busy.delete(conversationKey(conversation));
    const back = [`rail:retry|${conversation.id}`, `busy:${conversation.id}`, run ? `run:${run.id}` : null];
    try { return await generate(conversation, { instruction: entry?.instruction || '', agentId: entry?.agentId || run?.agentId, focus: back }); }
    catch (error) { if (currentConversation()?.id === conversation.id) { const pending = wantFocus(back); paint(); settleFocus(pending); } throw error; }
  }

  // ---------------------------------------------------------------------------------------------
  // Decisions, cancel, discard and regenerate

  async function decide(runId, decision) {
    const run = findRun(runId), conversation = currentConversation();
    if (decision === 'approve' && !aiPolicy(conversation).allowed) throw new Error(aiPolicy(conversation).reason);
    if (!run || run.state !== 'waiting_approval' || run.toolProposal?.autoApproved === true || run.conversationId !== conversation?.id || run.conversationVersion !== conversation.version || !canReplyTo(conversation) || !run.toolProposal?.id) throw new Error(i18nText('Esta proposta não corresponde ao atendimento atual. Atualize a conversa.'));
    // An expired proposal is gone for the server too: nothing is sent.
    if (proposalExpired(run)) throw new Error(expiredNote());
    if (decisions.has(runId)) throw new Error(i18nText('Aguarde a confirmação desta decisão.'));
    const expectedScope = scope(), conversationId = conversation.id, origin = ctx.captureRuns?.(), proposalId = run.toolProposal.id;
    decisions.add(runId); paint();
    try {
      const answer = await api(tenantApi(`runs/${encodeURIComponent(runId)}/tool/${decision}`), { method: 'POST', body: JSON.stringify({ version: run.version, proposalId }) });
      if (!sameView(expectedScope, conversationId)) return;
      // The server answers with the run: a proposal that expired or lost its context comes back invalidated (202), never approved.
      let confirmed = isObject(answer) && typeof stateOf(answer) === 'string' ? decisionConfirmed(answer, decision, proposalId) : null;
      quietOnce.add(runId);
      const pending = wantFocus(confirmed === false ? null : `receipt:${runId}`, `run:${runId}`);
      if (await syncRuns(conversationId, expectedScope, origin) === false) return;
      settleFocus(pending);
      if (confirmed === null) confirmed = decisionConfirmed(findRun(runId), decision, proposalId);
      if (!confirmed) { toast(i18nText('A proposta perdeu a validade antes da sua decisão. Nada foi executado.'), true); return; }
      toast(decision === 'approve' ? i18nText('Execução autorizada. O resultado será usado no rascunho.') : i18nText('Ferramenta recusada.'));
    } catch (error) {
      // A refused decision: the card comes back with its buttons enabled (or as the line of what changed) and keeps the focus.
      if (sameView(expectedScope, conversationId)) { decisions.delete(runId); wantFocus(`rail:${decision}|${runId}`, `run:${runId}`); await syncRuns(conversationId, expectedScope, origin).catch(() => {}); }
      throw error;
    } finally { decisions.delete(runId); if (sameView(expectedScope, conversationId)) paint(); }
  }

  // Approval has no keyboard shortcut (§2.6, §5.2.3): only the focused button of the card decides.
  function requireCardButton(element, runId) {
    if (!element?.closest?.('[data-rail-approval]') || element.dataset?.id !== runId) throw new Error(i18nText('Use os botões do cartão de aprovação para decidir.'));
  }

  async function cancelRun(runId, mode) {
    const run = findRun(runId), conversation = currentConversation();
    if (!run || run.conversationId !== conversation?.id || !canReplyTo(conversation)) throw new Error(i18nText('Esta execução não corresponde ao atendimento atual. Atualize a conversa.'));
    if (mode === 'discard' ? !draftState(run) : !activeRunStates.has(stateOf(run))) throw new Error(i18nText('Esta execução já terminou. Atualize a conversa.'));
    if (cancelling.has(runId)) return;
    const expectedScope = scope(), conversationId = conversation.id, origin = ctx.captureRuns?.();
    cancelling.add(runId); paint();
    try { await api(tenantApi(`runs/${encodeURIComponent(runId)}/cancel`), { method: 'POST', body: '{}' }); }
    catch (error) {
      cancelling.delete(runId);
      if (sameView(expectedScope, conversationId)) { const pending = wantFocus(`${mode === 'discard' ? 'rail:discard' : 'rail:cancel'}|${runId}`, `run:${runId}`); paint(); settleFocus(pending); }
      throw error;
    }
    cancelling.delete(runId); confirmations.delete(runId);
    if (!sameView(expectedScope, conversationId)) return;
    // The reload repaints the rail with the line of the cancelled run, which takes the focus of the gone control.
    quietOnce.add(runId);
    const pending = wantFocus(`run:${runId}`);
    if (await syncRuns(conversationId, expectedScope, origin) === false) return;
    settleFocus(pending);
    toast(mode === 'discard' ? i18nText('Rascunho descartado. Nada foi enviado ao cliente.') : i18nText('Preparação cancelada.'));
  }

  async function regenerate(runId) {
    const run = findRun(runId), conversation = currentConversation();
    if (!run || run.conversationId !== conversation?.id || !canReplyTo(conversation)) throw new Error(i18nText('Este rascunho não corresponde ao contexto atual. Prepare uma nova resposta.'));
    if (!aiPolicy(conversation).allowed) throw new Error(aiPolicy(conversation).reason);
    if (regenerating.size || hasActive(conversation.id)) throw new Error(i18nText('Já existe uma execução ativa neste atendimento. Aguarde ou cancele.'));
    const agent = agentOf(run.agentId);
    if (agent?.provider !== 'hermes' || agent.configured !== true) throw new Error(i18nText('Configure o runtime do agente selecionado antes de preparar a resposta.'));
    const expectedScope = scope(), conversationId = conversation.id, back = [`rail:regenerate|${runId}`, `run:${runId}`];
    let started = false, failed = false;
    regenerating.add(runId);
    try { started = await generate(conversation, { agentId: agent.id, focus: back }); return started; }
    catch (error) { failed = true; throw error; }
    finally {
      regenerating.delete(runId);
      // A refused request gives the focus back to the same control, enabled again by this repaint.
      if (!started && sameView(expectedScope, conversationId)) { const pending = failed ? wantFocus(back) : null; paint(); if (pending) settleFocus(pending); }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Insert into the composer through composerBridge (§5.2.3): only an empty composer is filled directly

  function usableDraft(run, conversation) {
    if (!run || !conversation || run.conversationId !== conversation.id || !draftState(run) || typeof run.draft !== 'string' || !run.draft.trim()) return false;
    if (run.knowledgeUnavailable || run.memoryUnavailable) return false;
    return (run.conversationVersion === conversation.version || staleFlag(run)) && canReplyTo(conversation);
  }
  const latestDraft = conversation => runsOf(conversation?.id).filter(run => draftState(run)).at(-1) || null;

  async function insertDraft(runId, mode) {
    const bridge = ctx.composerBridge, conversation = currentConversation();
    if (state.sendIntent) throw new Error(i18nText('Confira o envio pendente ou descarte o rascunho antes de trocar ou editar.'));
    let run = runId ? findRun(runId) : latestDraft(conversation);
    if (!runId && !run) throw new Error(i18nText('Nenhum rascunho pronto neste atendimento.'));
    if (!usableDraft(run, conversation)) throw new Error(i18nText('Este rascunho não corresponde ao contexto atual. Prepare uma nova resposta.'));
    if (!bridge) throw new Error(i18nText('O compositor não está disponível agora. Nada foi alterado.'));
    if (bridge.mode === 'note') throw new Error(i18nText('Volte para Responder para inserir o rascunho.'));
    // The composer of P3 asks "Substituir | Acrescentar | Cancelar" itself (insertDraft); the inline
    // question of the rail covers a bridge without it. Either way an empty composer is filled directly.
    const asks = typeof bridge.insertDraft === 'function', typed = String(bridge.getText() ?? '');
    if (!asks && !mode && typed.trim()) { confirmations.add(run.id); wantFocus(`confirm:${run.id}`); paint(); return; }
    const expectedScope = scope(), conversationId = conversation.id;
    if (ctx.loadRuns) {
      // The draft is read again from the scoped runs: a revoked source or a newer route never reaches the composer.
      const fresh = await ctx.loadRuns(conversationId, expectedScope);
      if (fresh === false || !sameView(expectedScope, conversationId)) return;
      run = findRun(run.id);
      if (!usableDraft(run, currentConversation())) throw new Error(i18nText('Este rascunho não corresponde ao contexto atual. Prepare uma nova resposta.'));
      if (String(bridge.getText() ?? '') !== typed) throw new Error(i18nText('O atendimento ou seu texto mudou. Revise antes de usar o rascunho.'));
    }
    if (asks && !mode) {
      const outcome = await bridge.insertDraft(run.draft, { sourceRunId: run.id });
      if (outcome === 'cancelled' || !sameView(expectedScope, conversationId)) return;
      if (!outcome) throw new Error(i18nText('O compositor não está disponível agora. Nada foi alterado.'));
    } else {
      if (!bridge.setText(run.draft, { mode: mode === 'append' ? 'append' : 'replace', sourceRunId: run.id })) throw new Error(i18nText('O compositor não está disponível agora. Nada foi alterado.'));
      bridge.flash?.(); bridge.focus?.();
    }
    confirmations.delete(run.id); inserted.set(`${scope()}:${conversationId}`, run.id);
    paint();
    toast(i18nText('Rascunho inserido. Revise antes de enviar.'));
  }

  // ---------------------------------------------------------------------------------------------
  // Quota call to the administrator (attendant) and approval focus (Shift+A is bound by P2, it never decides)

  async function notifyAdmin(element) {
    // A support session has no Equipe (nav-config: team-chat outside support only).
    if (state.supportGrantId) throw new Error(i18nText('Peça ao administrador da empresa para ajustar a cota.'));
    const company = state.tenant?.name || '';
    const text = i18nText('A cota diária de IA da {company} foi atingida e os rascunhos do agente estão pausados. Você pode ajustar a cota em Agentes?', { company });
    // shell:team toggles the drawer: an Equipe already open stays open and only takes the focus.
    const drawer = doc()?.querySelector?.('dialog[data-live-drawer="team"]');
    if (drawer?.open) drawer.querySelector?.('[data-team-chat-draft]:not([disabled])')?.focus?.();
    else await dispatchAction('shell:team', element || null);
    // The Equipe drawer (P2) fills its field when it answers this event (preventDefault); the person reviews and sends.
    const EventType = globalThis.CustomEvent;
    const event = typeof EventType === 'function' ? new EventType('elozi:team-prefill', { cancelable: true, detail: { text } }) : null;
    if (event && typeof globalThis.window?.dispatchEvent === 'function' && !globalThis.window.dispatchEvent(event)) return;
    try { await globalThis.navigator.clipboard.writeText(text); toast(i18nText('Mensagem sugerida copiada. Cole e envie na Equipe.')); }
    catch { toast(i18nText('Escreva ao administrador na Equipe: {text}', { text })); }
  }

  function focusApproval() {
    const node = doc()?.querySelector?.('[data-rail-approval] .ui-approval__title');
    if (!node) return false;
    node.focus?.();
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Focus and clocks around re-renders of the host (app.js replaces the host on every poll)

  const focusKey = node => node?.dataset?.railFocus || (node?.dataset?.action ? `${node.dataset.action}|${node.dataset.id || ''}` : node?.name ? `name|${node.name}` : null);
  const RAIL_FOCUSABLE = '[data-rail-root] [data-rail-focus], [data-rail-root] [data-action], [data-rail-tab] [data-action], [data-rail-tab] [name]';
  const focusLost = (document, node) => !node || node === document.body || node === document.documentElement || node.isConnected === false;
  function scheduleDomWork(clocks) {
    const document = doc();
    if (!document?.querySelectorAll || typeof queueMicrotask !== 'function') return;
    if (pendingFocus && (pendingFocus.conversationId !== state.conversation || ++pendingFocus.tries > 3)) pendingFocus = null;
    const active = document.activeElement, key = active?.closest?.('[data-rail-root],[data-rail-tab]') ? focusKey(active) : null;
    const selection = Number.isInteger(active?.selectionStart) ? [active.selectionStart, active.selectionEnd] : null;
    if (!focusQueued && (key || pendingFocus)) {
      focusQueued = true;
      queueMicrotask(() => {
        focusQueued = false;
        const wanted = pendingFocus?.keys || (key ? [key] : []), current = document.activeElement, lost = focusLost(document, current);
        // Restores the focus a re-render took; a pending focus moves only while the person is still in the rail.
        if (!wanted.length || !lost && !current.closest?.('[data-rail-root],[data-rail-tab]')) { if (!lost) pendingFocus = null; return; }
        if (!pendingFocus && !lost) return;
        // The first wanted key that came back and can take the focus (a disabled button cannot).
        const nodes = [...document.querySelectorAll(RAIL_FOCUSABLE)];
        const target = wanted.map(name => nodes.find(node => focusKey(node) === name && node.disabled !== true)).find(Boolean);
        if (!target) return;
        pendingFocus = null; target.focus?.({ preventScroll: true });
        // The guidance being typed keeps its caret.
        if (selection && focusKey(target) === key && typeof target.setSelectionRange === 'function') try { target.setSelectionRange(...selection); } catch { /* not a text field */ }
      });
    }
    if (clocks && !clock) {
      const timers = ctx.timers || globalThis;
      queueMicrotask(() => {
        if (clock || typeof timers.setInterval !== 'function') return;
        clock = timers.setInterval(() => { if (!tickRail(document, now())) { timers.clearInterval(clock); clock = null; } }, 1000);
      });
    }
  }

  /**
   * After the reload of an action: when none of the wanted keys came back (the render already had its turn),
   * the composer keeps the person in the conversation instead of <body>.
   */
  function settleFocus(pending) {
    if (!pending || typeof queueMicrotask !== 'function') return;
    queueMicrotask(() => {
      if (pendingFocus !== pending) return;
      pendingFocus = null;
      const document = doc();
      if (document && focusLost(document, document.activeElement)) ctx.composerBridge?.focus?.();
    });
  }

  // Two regions outside the host, created once: polite (role=status) and assertive (role=alert, tool_unknown only).
  function announcer(assertive) {
    const document = doc();
    if (typeof document?.createElement !== 'function' || typeof document.body?.appendChild !== 'function') return null;
    const name = assertive ? 'assertive' : 'polite';
    let region = document.querySelector?.(`[data-rail-announcer="${name}"]`) || null;
    if (!region) {
      region = document.createElement('div');
      region.className = 'sr-only';
      region.setAttribute('data-rail-announcer', name);
      region.setAttribute('role', assertive ? 'alert' : 'status');
      region.setAttribute('aria-atomic', 'true');
      document.body.appendChild(region);
    }
    return region;
  }
  function announce(messages, assertive = false) {
    const region = announcer(assertive), text = messages.filter(Boolean).join(' ');
    if (!region || !text) return false;
    const timers = ctx.timers || globalThis;
    // Emptied first, written a moment later: the same sentence said again still counts as new.
    region.textContent = '';
    if (typeof timers.setTimeout === 'function') timers.setTimeout(() => { region.textContent = text; }, 100); else region.textContent = text;
    return true;
  }

  /**
   * Says each real change of the rail once: never on the first render of a conversation, never on a poll that
   * repaints the same state, never the start of a run (its toast says it) nor the change an action of this
   * person caused (its toast and focus say it). entries: [{id, message, assertive, quietWhenNew}].
   */
  function announceChanges(conversation, entries) {
    const view = conversationKey(conversation), opening = announcedView !== view;
    announcedView = view;
    if (opening) { announcer(false); announcer(true); }
    const polite = [], urgent = [];
    for (const entry of entries) {
      const slot = `${view}|${entry.id}`, previous = spoken.get(slot);
      if (entry.message) spoken.set(slot, entry.message); else spoken.delete(slot);
      if (opening || !entry.message || previous === entry.message || previous === undefined && entry.quietWhenNew) continue;
      if (quietOnce.delete(entry.id)) continue;
      (entry.assertive ? urgent : polite).push(entry.message);
    }
    if (polite.length) announce(polite);
    if (urgent.length) announce(urgent, true);
  }

  // ---------------------------------------------------------------------------------------------
  // Markup

  const agentAvatar = (run, size = 24) => avatar({ kind: 'agent', name: agentName(run), size });

  // Each block of the rail takes the focus after the action that produced it (run:<id>; the local busy line busy:<conversation>).
  function lineSection({ run, kind, className = 'pg-rail__line', body, actions = '', extra = '', focus = run?.id ? `run:${run.id}` : null }) {
    return h`<section class="${className}" data-rail-run="${run?.id ?? ''}" data-state="${kind}"${attributes({ tabindex: focus ? '-1' : null, 'data-rail-focus': focus })}>${body}${actions ? h`<div class="pg-rail__actions">${actions}</div>` : ''}${extra}</section>`;
  }

  function reasonText(run) {
    const reason = typeof run?.reason === 'string' ? run.reason.trim() : '';
    if (!reason) return '';
    if (PROVIDER_REASON.test(reason) && !platformOwner()) return i18nText('O serviço de IA precisa de atenção do administrador.');
    if (KNOWN_REASONS.has(reason) || getLocale() !== 'en') return i18nText(reason);
    return i18nText('A preparação não terminou.');
  }

  /** The sentence of a finished run that is not a draft: the same in the rail, in the Agente tab and in announcements. */
  function outcomeText(run, kind) {
    if (kind === 'busy') return i18nText('O assistente está atendendo outras execuções agora.');
    return {
      lookup_failed: i18nText('A consulta não terminou. Nada foi alterado.'),
      tool_unknown: i18nText('Não confirmamos se a ação externa executou. Confira no sistema de destino antes de repetir.'),
      rejected: i18nText('A ferramenta foi recusada. O agente não usou essa consulta.'),
      draft_unavailable: i18nText('Este rascunho não está mais disponível para você. Prepare um novo rascunho.'),
      invalidated: reasonText(run) || i18nText('O contexto mudou. Prepare um novo rascunho.'),
      cancelled: reasonText(run) || i18nText('Preparação cancelada.')
    }[kind] || reasonText(run) || i18nText('A preparação não terminou.');
  }

  /** What a screen reader hears when a shown run changes (headline of the work, the decision asked, the outcome). */
  function changeText(run, kind) {
    if (kind === 'running' || kind === 'lookup') return i18nText('{agent} está preparando…', { agent: agentName(run) });
    if (kind === 'tool') return i18nText('Executando {tool}…', { tool: toolPath(run.toolProposal) });
    if (kind === 'approval') return `${i18nText('Aprovação necessária')}: ${i18nText('{agent} quer usar', { agent: agentName(run) })} ${toolTitle(run.toolProposal)}.`;
    if (kind === 'draft') return i18nText('Rascunho do agente pronto');
    if (kind === 'stale') return i18nText('Rascunho do agente desatualizado');
    return outcomeText(run, kind);
  }

  /** "Aprovada por Jean · 10:04" / "Recusada por Ana · 10:05": the card collapses into this receipt after the decision. */
  function decisionReceipt(run, before) {
    const item = runReceipts(run).find(entry => entry.kind === 'approved' || entry.kind === 'rejected');
    if (!item) return '';
    const label = item.kind === 'approved'
      ? item.name ? i18nText('Aprovada por {name} · {time}', { name: item.name, time: item.time }) : i18nText('Aprovada · {time}', { time: item.time })
      : item.name ? i18nText('Recusada por {name} · {time}', { name: item.name, time: item.time }) : i18nText('Recusada · {time}', { time: item.time });
    const { result: _result, summarized: _summarized, ...line } = item;
    return receiptMarkup({ ...line, label, enter: before === 'approval', focus: true });
  }

  function runningCard(run, conversation, kind, before) {
    const since = run.startedAt || run.createdAt || run.updatedAt, sinceTime = time(since), done = automaticSteps(run);
    let headline, phase;
    if (kind === 'tool') {
      headline = i18nText('Executando {tool}…', { tool: toolPath(run.toolProposal) });
      phase = i18nText('O resultado entra no rascunho. Nada é enviado ao cliente sem você.');
    } else {
      headline = i18nText('{agent} está preparando…', { agent: agentName(run) });
      phase = stateOf(run) === 'queued' ? i18nText('Na fila de preparação')
        : kind === 'lookup' ? i18nText('Consultando {tool} ({count}/{max})', { tool: toolTitle(run.toolProposal), count: Math.min(done.length + 1, MAX_AUTO_LOOKUPS), max: MAX_AUTO_LOOKUPS })
          : done.length ? i18nText('Escrevendo o rascunho com o resultado das consultas') : i18nText('Lendo a conversa');
    }
    const clockMarkup = sinceTime === null ? '' : h`<span class="pg-rail__clock" data-rail-since="${since}" aria-hidden="true">${elapsedText(now() - sinceTime)}</span>`;
    const lookups = done.length ? h`<ul class="pg-rail__lookups" aria-label="${i18nText('Consultas automáticas feitas nesta execução')}">${runReceipts(run).filter(item => item.kind === 'auto').map(item => h`<li>${receiptMarkup(item)}</li>`)}</ul>` : '';
    const cancel = kind !== 'tool' && canReplyTo(conversation)
      ? button({ label: i18nText('Cancelar'), action: 'rail:cancel', variant: 'ghost', size: 'sm', disabled: cancelling.has(run.id), attrs: { 'data-id': run.id } }) : '';
    const body = h`${decisionReceipt(run, before)}<p class="pg-rail__headline">${agentAvatar(run)}<span class="pg-rail__dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="pg-rail__title">${headline}</span>${clockMarkup}</p><p class="pg-rail__phase">${phase}</p>${lookups}`;
    return lineSection({ run, kind, className: 'pg-rail__status', body, actions: cancel });
  }

  function argumentPreview(value) {
    if (!isObject(value)) return '';
    const show = item => typeof item === 'string' ? `"${item.length > 60 ? `${item.slice(0, 57)}…` : item}"` : ['number', 'boolean'].includes(typeof item) || item === null ? String(item) : '…';
    const entries = Object.entries(value), preview = entries.slice(0, 3).map(([key, item]) => `${key} = ${show(item)}`).join(' · ');
    return entries.length > 3 ? `${preview} · …` : preview;
  }

  function approvalCard(run, conversation) {
    const proposal = run.toolProposal || {}, internal = proposal.readOnly === true, deciding = decisions.has(run.id);
    const titleId = `rail-approval-${domId(run.id)}`, expires = time(proposal.expiresAt), remaining = expires === null ? null : expires - now();
    // Past expiresAt the proposal is gone: no decision is offered (tickRail does the same between two polls).
    const expired = remaining !== null && remaining <= 0;
    const current = run.conversationVersion === conversation.version && canReplyTo(conversation), disabled = !current || deciding || expired;
    const before = seen.get(run.id); seen.set(run.id, 'approval');
    const ratio = remaining === null ? null : Math.max(0, Math.min(1, remaining / APPROVAL_WINDOW_MS));
    const expiry = remaining === null ? '' : h`<span class="ui-approval__expiry"><span${attributes({ 'data-rail-expires': expired ? null : proposal.expiresAt, 'data-rail-tick': expired ? null : String(now()), 'data-rail-expired': expired ? 'true' : null })} aria-hidden="true">${expiryText(remaining)}</span><span class="sr-only">${i18nText('Expira às {time}', { time: clockTime(proposal.expiresAt) })}</span></span>`;
    const bar = ratio === null ? '' : h`<span class="ui-approval__bar" aria-hidden="true"${attributes({ style: `--rail-ratio:${ratio.toFixed(3)};--rail-remaining:${Math.max(0, Math.round(remaining / 1000))}s` })}><span class="ui-approval__fill"></span></span>`;
    const server = mcpServerLabel(String(proposal.serverName || proposal.serverId || '').trim()), serverMarkup = server ? h`<span>${server}</span> · ` : '';
    // An internal tool under approve_all is read-only by contract: badge INTERNO, without the data-change question.
    const where = internal
      ? h`${serverMarkup}<span class="ui-badge ui-badge--info">${i18nText('Interno')}</span> · <span>${i18nText('consulta somente leitura desta empresa')}</span>`
      : h`${serverMarkup}<span class="ui-badge ui-badge--warning">${i18nText('Externo')}</span> · <span>${i18nText('Pode alterar dados? O servidor externo não declara.')}</span>`;
    const preview = argumentPreview(proposal.arguments);
    const note = !aiPolicy(conversation).allowed ? aiPolicy(conversation).reason : deciding ? i18nText('Confirmando sua decisão…')
      : expired ? expiredNote()
        : current ? i18nText('A execução gera contexto para o rascunho. A resposta continua com revisão e envio humano.')
          : i18nText('O contexto mudou ou o atendimento está com outra pessoa. Esta proposta não pode ser aprovada por você.');
    const head = h`<header class="ui-approval__head"><h3 class="ui-approval__title" id="${titleId}" tabindex="-1">${i18nText('Aprovação necessária')}</h3>${expiry}</header>${bar}`;
    const ask = h`<p class="ui-approval__ask">${i18nText('{agent} quer usar', { agent: agentName(run) })} <strong>${toolTitle(proposal)}</strong></p><p class="ui-approval__where">${where}</p>`;
    const args = h`${preview ? h`<p class="ui-approval__args">${preview}</p>` : ''}<details class="ui-approval__details"><summary>${i18nText('Ver argumentos')}</summary><pre class="ui-approval__json" tabindex="0">${json(proposal.arguments)}</pre></details>`;
    const actions = h`<div class="ui-approval__actions">${button({ label: i18nText('Recusar'), action: 'rail:reject', variant: 'secondary', size: 'sm', disabled, attrs: { 'data-id': run.id } })}${button({ label: i18nText('Aprovar e executar'), action: 'rail:approve', variant: 'primary', size: 'sm', disabled: disabled || !aiPolicy(conversation).allowed, attrs: { 'data-id': run.id } })}</div>`;
    return h`<section class="ui-approval" data-rail-approval data-rail-run="${run.id}" data-state="${internal ? 'internal' : 'external'}" tabindex="-1" data-rail-focus="run:${run.id}"${attributes({ 'aria-labelledby': titleId, 'aria-busy': deciding ? 'true' : null, 'data-enter': before !== 'approval' ? '' : null })}>${head}${ask}${args}${actions}<p class="ui-approval__note">${note}</p></section>`;
  }

  /** Newer customer messages after the draft started: count and time of the latest one, when known. */
  function newerMessages(run, conversation) {
    const start = time(run.startedAt), messages = Array.isArray(conversation?.messages) ? conversation.messages : null;
    if (messages && start !== null) {
      const newer = messages.filter(message => message?.kind === 'customer' && (time(message.createdAt) ?? -Infinity) > start);
      if (newer.length) return { count: newer.length, at: newer.at(-1).createdAt };
    }
    if (isObject(run.stale) && Number.isSafeInteger(run.stale.newMessages) && run.stale.newMessages > 0) return { count: run.stale.newMessages, at: run.stale.since || null };
    return null;
  }
  function contactFirstName(conversation) {
    const first = String(conversation?.contact || '').trim().split(/\s+/)[0] || '';
    return /\p{L}/u.test(first) ? first : i18nText('O cliente');
  }
  function staleText(run, conversation) {
    const newer = newerMessages(run, conversation);
    if (!newer) return i18nText('O cliente enviou mensagens depois deste rascunho. Revise o texto antes de usar ou gere um novo.');
    const name = contactFirstName(conversation), at = clockTime(newer.at);
    if (newer.count === 1) return at ? i18nText('{name} enviou 1 mensagem depois deste rascunho ({time})', { name, time: at }) : i18nText('{name} enviou 1 mensagem depois deste rascunho', { name });
    return at ? i18nText('{name} enviou {count} mensagens depois deste rascunho ({time})', { name, count: newer.count, time: at }) : i18nText('{name} enviou {count} mensagens depois deste rascunho', { name, count: newer.count });
  }

  /** Tokens and time of a run: administrators only (§5.2.3). */
  function adminMeta(run) {
    if (!isAdmin()) return '';
    const usage = run.usage, tokens = Number.isSafeInteger(usage?.total_tokens) ? usage.total_tokens
      : Number.isSafeInteger(run.tokens?.input) || Number.isSafeInteger(run.tokens?.output) ? (run.tokens.input || 0) + (run.tokens.output || 0) : null;
    const resting = ['draft', 'failed', 'invalidated', 'cancelled', 'rejected', 'tool_unknown', 'completed', 'succeeded'].includes(stateOf(run));
    const start = time(run.startedAt), end = time(run.completedAt);
    const ms = !resting ? null : Number.isFinite(run.latencyMs) && run.latencyMs >= 0 ? run.latencyMs : start !== null && end !== null && end >= start ? end - start : null;
    return [tokens === null ? '' : i18nText('{tokens} tokens', { tokens: new Intl.NumberFormat(getLocale()).format(tokens) }), ms === null ? '' : formatDuration(ms)].filter(Boolean).join(' · ');
  }

  function sources(run) {
    const knowledge = String(knowledgeReferences(run) ?? ''), memory = String(memoryReferences(run) ?? '');
    return knowledge || memory ? h`<div class="ui-draft__sources">${raw(knowledge)}${raw(memory)}</div>` : '';
  }

  function draftCard(run, conversation, kind) {
    const stale = kind === 'stale', usable = usableDraft(run, conversation), before = seen.get(run.id); seen.set(run.id, kind);
    const reveal = Boolean(before && ACTIVE_KINDS.has(before)), expanded = expandedDrafts.has(run.id), confirming = confirmations.has(run.id) && usable;
    const bodyId = `rail-draft-${domId(run.id)}`, headId = `rail-draft-head-${domId(run.id)}`, confirmId = `rail-confirm-${domId(run.id)}`;
    const working = regenerating.has(run.id) || hasActive(conversation.id) || requesting.has(conversationKey(conversation));
    const canGenerate = aiPolicy(conversation).allowed && canReplyTo(conversation) && !working && !quotaActive();
    const meta = [adminMeta(run), motorLabel(run.provider)].filter(Boolean).join(' · ');
    const badgeMarkup = stale ? h`<span class="ui-badge ui-badge--warning">${i18nText('Rascunho anterior às novas mensagens')}</span>` : h`<span class="ui-badge ui-badge--agent">${i18nText('Rascunho pronto')}</span>`;
    const insert = button({ label: stale ? i18nText('Usar mesmo assim') : i18nText('Inserir'), action: 'rail:insert-draft', variant: stale ? 'secondary' : 'primary', size: 'sm',
      kbd: !stale && keyboard.singleKeyEnabled?.() ? 'd' : undefined, disabled: !usable || confirming, attrs: { 'data-id': run.id } });
    const againLabel = stale ? i18nText('Gerar novamente com o novo contexto') : i18nText('Gerar novamente');
    const again = button({ label: againLabel, action: 'rail:regenerate', variant: stale ? 'primary' : 'secondary', size: 'sm', icon: 'refresh', disabled: !canGenerate, attrs: { 'data-id': run.id } });
    const discard = canReplyTo(conversation) ? button({ label: i18nText('Descartar'), action: 'rail:discard', variant: 'ghost', size: 'sm', disabled: cancelling.has(run.id), attrs: { 'data-id': run.id } }) : '';
    const confirm = confirming ? h`<div class="ui-draft__confirm" role="group" aria-labelledby="${confirmId}" data-rail-confirm="${run.id}"><p id="${confirmId}">${i18nText('O compositor já tem texto. O que fazer com o rascunho?')}</p><div class="pg-rail__actions">${button({ label: i18nText('Substituir'), action: 'rail:insert-replace', variant: 'primary', size: 'sm', attrs: { 'data-id': run.id, 'data-rail-focus': `confirm:${run.id}` } })}${button({ label: i18nText('Acrescentar'), action: 'rail:insert-append', variant: 'secondary', size: 'sm', attrs: { 'data-id': run.id } })}${button({ label: i18nText('Cancelar'), action: 'rail:insert-cancel', variant: 'ghost', size: 'sm', attrs: { 'data-id': run.id } })}</div></div>` : '';
    const actions = confirm || h`<div class="pg-rail__actions">${stale ? h`${again}${insert}` : h`${insert}${again}`}${discard}</div>`;
    const note = !usable ? i18nText('O contexto mudou. Prepare um novo rascunho ou assuma a conversa.')
      : stale ? i18nText('O texto antigo continua aqui. Revise antes de usar ou gere de novo com o novo contexto.')
        : i18nText('Nada foi enviado ao cliente. Revise antes de enviar.');
    const peek = h`<button type="button" class="ui-draft__peek" data-action="rail:expand-draft" data-id="${run.id}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${bodyId}"><span aria-hidden="true">✦</span> ${stale ? i18nText('Rascunho anterior às novas mensagens · ver') : i18nText('Rascunho pronto · ver')}</button>`;
    const head = h`<header class="ui-draft__head" id="${headId}">${agentAvatar(run)}<strong class="ui-draft__agent">${agentName(run)}</strong>${badgeMarkup}${meta ? h`<span class="ui-draft__meta">${meta}</span>` : ''}</header>`;
    const text = h`<div class="ui-draft__reveal"><p class="ui-draft__text">${run.draft}</p></div>${stale ? h`<p class="ui-draft__stale">${staleText(run, conversation)}</p>` : ''}`;
    return h`<section class="ui-draft" data-rail-run="${run.id}" data-state="${stale ? 'stale' : 'current'}" data-expanded="${expanded ? 'true' : 'false'}" tabindex="-1" data-rail-focus="run:${run.id}"${attributes({ 'aria-labelledby': headId, 'data-reveal': reveal ? '' : null })}>${peek}<div class="ui-draft__body" id="${bodyId}">${head}${text}${sources(run)}${actions}<p class="ui-draft__note">${note}</p></div></section>`;
  }

  function busyCard({ run = null, at, conversation }) {
    const until = at + BUSY_RETRY_MS, left = until - now(), allowed = aiPolicy(conversation).allowed && canReplyTo(conversation), waiting = left > 0 && allowed;
    const retryButton = button({ label: i18nText('Tentar de novo'), action: 'rail:retry', variant: 'secondary', size: 'sm', disabled: left > 0 || !allowed,
      attrs: { 'data-id': conversation.id, 'data-run': run?.id ?? null, 'data-rail-wait-until': waiting ? String(until) : null } });
    const countdown = waiting ? h`<small class="pg-rail__countdown" data-rail-countdown="${String(until)}" aria-hidden="true">${countdownText(left)}</small>` : '';
    const body = h`<p class="pg-rail__text">${glyph('clock', 'pg-rail__icon')}<span>${i18nText('O assistente está atendendo outras execuções agora.')}</span></p>`;
    return lineSection({ run: run || { id: '' }, kind: 'busy', body, actions: h`${retryButton}${countdown}`, extra: h`<small class="pg-rail__hint">${i18nText('Não tentamos de novo sozinhos.')}</small>`, focus: run?.id ? `run:${run.id}` : `busy:${conversation.id}` });
  }

  function lineCard(run, conversation, kind, before) {
    if (kind === 'busy') return busyCard({ run, at: time(run.updatedAt) ?? now(), conversation });
    const text = outcomeText(run, kind);
    const allowed = aiPolicy(conversation).allowed && canReplyTo(conversation) && !hasActive(conversation.id) && !quotaActive() && !requesting.has(conversationKey(conversation));
    const again = kind === 'tool_unknown' ? '' : button({ label: i18nText('Gerar novamente'), action: 'rail:regenerate', variant: 'secondary', size: 'sm', icon: 'refresh', disabled: !allowed || regenerating.has(run.id), attrs: { 'data-id': run.id } });
    const body = h`${kind === 'rejected' ? decisionReceipt(run, before) : ''}<p class="pg-rail__text">${glyph(kind === 'tool_unknown' ? 'warning' : 'info', 'pg-rail__icon')}<span>${text}</span></p>`;
    return lineSection({ run, kind, body, actions: again, extra: stateOf(run) === 'invalidated' ? '' : sources(run) });
  }

  /** The rail block of one run, by its classification. */
  function runCard(run, conversation) {
    const kind = classifyRun(run, conversation), before = seen.get(run.id);
    if (kind === 'approval') return approvalCard(run, conversation);
    if (kind === 'draft' || kind === 'stale') return draftCard(run, conversation, kind);
    seen.set(run.id, kind);
    return ACTIVE_KINDS.has(kind) ? runningCard(run, conversation, kind, before) : lineCard(run, conversation, kind, before);
  }

  const quotaTitle = () => { const company = state.tenant?.name || ''; return company ? i18nText('Cota diária de IA da {company} atingida.', { company }) : i18nText('Cota diária de IA atingida.'); };
  function quotaBanner() {
    if (!quotaActive()) return '';
    // The limit belongs to the company: the administrator adjusts it in Agentes › Uso (agents:usage-limit of P5); the
    // attendant asks for it in Equipe (the person writes and sends); a support session has no Equipe, so it says who adjusts.
    const action = canTuneQuota()
      ? h`<a class="ui-btn ui-btn--secondary ui-btn--sm" href="#agents/usage"><span class="ui-btn__label">${i18nText('Ajustar cota')}</span></a>`
      : state.supportGrantId ? h`<small class="pg-rail__hint">${i18nText('Peça ao administrador da empresa para ajustar a cota.')}</small>`
        : button({ label: i18nText('Avisar administrador'), action: 'rail:notify-admin', variant: 'secondary', size: 'sm' });
    return h`<div class="ui-banner ui-banner--warning pg-rail__quota" data-rail-quota tabindex="-1" data-rail-focus="quota"><span class="ui-banner__icon" aria-hidden="true">${glyph('warning')}</span><div class="ui-banner__text"><strong class="ui-banner__title">${quotaTitle()}</strong> <span class="ui-banner__body">${i18nText('Renova às 00:00.')}</span></div>${action}</div>`;
  }

  /** Autopilot of the agent that owns the conversation (agent.autopilot, detected by field). */
  function autopilotState(conversation) {
    if (conversation?.owner !== 'agent') return { owned: false, known: false, active: false, agent: null, config: null };
    const agent = agentOf(conversation.agentId) || null, config = agent?.autopilot;
    if (!isObject(config)) return { owned: true, known: false, active: false, agent, config: null };
    const channels = Array.isArray(config.channelIds) ? config.channelIds : [];
    return { owned: true, known: true, active: aiPolicy(conversation).allowed && config.enabled === true && channels.includes(conversation.channelId), agent, config };
  }

  // Automatic replies in progress for this conversation (agentAutopilotJobs, when the DTO carries them).
  function autopilotWorking(conversation) {
    const jobs = Array.isArray(state.tenant?.agentAutopilotJobs) ? state.tenant.agentAutopilotJobs : [];
    if (!jobs.some(job => job?.conversationId === conversation.id && ['pending', 'running', 'sending'].includes(job.state))) return '';
    return h`<p class="pg-rail__phase"><span class="pg-rail__dots" aria-hidden="true"><i></i><i></i><i></i></span>${i18nText('Preparando a resposta automática…')}</p>`;
  }

  /**
   * Autopilot status of the agent that owns the conversation (Agente tab). The header banner of P3 already
   * says "Piloto automático ativo"/"Sem resposta automática" with [Assumir]; the rail adds the live line.
   */
  function autopilotCard(conversation, { compact = false } = {}) {
    const status = autopilotState(conversation);
    if (!status.known) return '';
    if (compact) {
      const working = status.active ? autopilotWorking(conversation) : '';
      return working ? h`<section class="pg-rail__autopilot" data-state="active">${working}</section>` : '';
    }
    const name = String(status.agent?.name || '').trim() || i18nText('Assistente');
    if (!status.active) return h`<section class="pg-rail__autopilot" data-state="off"><p class="pg-rail__text">${glyph('info', 'pg-rail__icon')}<span>${i18nText('Este atendimento está com o agente {agent}, que não responde automaticamente neste canal.', { agent: name })}</span></p></section>`;
    const config = status.config, max = Number.isSafeInteger(config.maxRepliesPerHour) ? config.maxRepliesPerHour : 6;
    const quiet = isObject(config.quietHours) && config.quietHours.start && config.quietHours.end
      ? h`<small class="pg-rail__hint">${i18nText('Horário silencioso: {start}–{end}. Mensagens nesse horário vão para a fila.', { start: config.quietHours.start, end: config.quietHours.end })}</small>` : '';
    const rules = config.requireKnowledge === false
      ? i18nText('{agent} responde sozinho neste canal. Pedido de pessoa, mídia ou frustração transferem para a fila com nota.', { agent: name })
      : i18nText('{agent} responde sozinho neste canal, só com base publicada. Pedido de pessoa, mídia, frustração ou falta de base transferem para a fila com nota.', { agent: name });
    return h`<section class="pg-rail__autopilot" data-state="active"><p class="pg-rail__headline"><span class="ui-badge ui-badge--agent">${i18nText('✦ Piloto automático ativo')}</span><small>${i18nText('até {count} respostas por hora nesta conversa', { count: max })}</small></p><p class="pg-rail__text">${rules}</p>${quiet}${autopilotWorking(conversation)}</section>`;
  }

  /** Rail of the conversation: quota > autopilot > approval > draft > status (§5.2.3). */
  function render(conversation) {
    if (!conversation) return raw('');
    const runs = runsOf(conversation.id), autopilot = autopilotCard(conversation, { compact: true }), parts = [quotaBanner(), autopilot], shown = [];
    const show = run => { shown.push(run); parts.push(runCard(run, conversation)); };
    for (const run of runs) if (classifyRun(run, conversation) === 'approval') show(run);
    const draft = latestDraft(conversation), latest = runs.at(-1);
    if (draft) show(draft);
    if (latest && latest !== draft && classifyRun(latest, conversation) !== 'approval' && !isHistoricalInvalidation(latest, conversation)) {
      const kind = classifyRun(latest, conversation);
      if (ACTIVE_KINDS.has(kind) || !draft || runs.indexOf(latest) > runs.indexOf(draft)) show(latest);
    }
    const localBusy = busy.get(conversationKey(conversation)), busyShown = Boolean(localBusy && !hasActive(conversation.id) && now() - localBusy.at < BUSY_RETRY_MS * 30);
    if (busyShown) parts.push(busyCard({ at: localBusy.at, conversation }));
    announceChanges(conversation, [
      { id: '#quota', message: quotaActive() ? `${quotaTitle()} ${i18nText('Renova às 00:00.')}` : '' },
      { id: '#autopilot', message: String(autopilot) ? i18nText('Preparando a resposta automática…') : '' },
      ...shown.map(run => { const kind = classifyRun(run, conversation); return { id: run.id, message: changeText(run, kind), assertive: kind === 'tool_unknown', quietWhenNew: kind === 'running' }; }),
      { id: '#busy', message: busyShown ? i18nText('O assistente está atendendo outras execuções agora.') : '' }
    ]);
    const content = parts.filter(part => String(part));
    if (!content.length) { if (pendingFocus) scheduleDomWork(false); return raw(''); }
    scheduleDomWork(content.some(part => /data-rail-(?:since|expires|wait-until)=/.test(String(part))));
    return h`<div class="pg-rail" data-rail-root data-conversation-id="${conversation.id}">${content}</div>`;
  }

  /** Inline receipts for the timeline ({id, at, kind, markup}); the host (P3) interleaves them by time. */
  function timelineItems(conversation) {
    if (!conversation) return [];
    return runsOf(conversation.id).flatMap(run => runReceipts(run)).filter(item => time(item.at) !== null)
      .sort((left, right) => time(left.at) - time(right.at)).map(item => ({ id: item.id, at: item.at, kind: item.kind, markup: receiptMarkup(item) }));
  }

  /** Summary for the hosts: open the Agente tab on a pending approval, list glyph, header banner. */
  function status(conversation) {
    // An approval past expiresAt is gone for the server (agentState null): it neither opens the Agente tab nor marks the row.
    const kinds = runsOf(conversation?.id).map(run => { const kind = classifyRun(run, conversation); return kind === 'approval' && proposalExpired(run) ? 'expired' : kind; });
    const draft = latestDraft(conversation), draftKind = draft ? classifyRun(draft, conversation) : null;
    const approval = kinds.includes('approval'), active = kinds.some(kind => ACTIVE_KINDS.has(kind));
    const agentState = approval ? 'waiting_approval' : active ? 'running' : draftKind === 'draft' ? 'draft' : draftKind === 'stale' ? 'stale' : null;
    return { approval, active, draft: draftKind === 'draft', stale: draftKind === 'stale', agentState, quota: quotaActive() };
  }

  /**
   * Static ✦ of a list row: agentState from /api/inbox ("inbox-agent-state") whenever the row carries the field,
   * null included (nothing pending for the server, e.g. an expired approval); else the runs already loaded.
   */
  function listGlyph(item) {
    if (!item) return raw('');
    let agentState = typeof item.agentState === 'string' ? item.agentState : null;
    if (item.agentState === undefined && state.tenant?.id && (item.tenantId ?? state.tenant.id) === state.tenant.id) {
      const conversationId = item.conversationId ?? item.id;
      agentState = status((state.tenant.conversations || []).find(entry => entry.id === conversationId) || { id: conversationId, version: item.version }).agentState;
    }
    const entry = GLYPHS[agentState];
    if (!entry) return raw('');
    const label = i18nText(entry[1]);
    return h`<span class="ui-agent-glyph" data-agent-state="${agentState}" data-tone="${entry[0]}" title="${label}"><span aria-hidden="true">✦</span><span class="sr-only">${label}</span></span>`;
  }

  // ---------------------------------------------------------------------------------------------
  // Agente tab of the context panel

  function stepItems(run, conversation) {
    if (!run) return [];
    const kind = classifyRun(run, conversation), status = stateOf(run), receipt = run.toolReceipt, items = [];
    const read = run.providerCalled === true || steps(run).length > 0 || !['queued', 'running'].includes(status);
    items.push({ state: read ? 'done' : 'current', text: i18nText('Leu a conversa') });
    for (const step of steps(run)) {
      const tool = String(step.title || step.toolName || '').trim() || i18nText('ferramenta'), approver = receipt?.proposalId === step.proposalId ? personName(receipt?.approvedBy) : '';
      const how = step.autoApproved === true ? i18nText('consulta automática') : approver ? i18nText('aprovada por {name}', { name: approver }) : i18nText('aprovada por uma pessoa');
      items.push({ state: step.isError === true ? 'error' : 'done', text: step.isError === true ? i18nText('{tool} · {how} · retornou erro', { tool, how }) : i18nText('{tool} · {how}', { tool, how }) });
    }
    if (kind === 'lookup') items.push({ state: 'current', text: i18nText('Consultando {tool} ({count}/{max})', { tool: toolTitle(run.toolProposal), count: Math.min(automaticSteps(run).length + 1, MAX_AUTO_LOOKUPS), max: MAX_AUTO_LOOKUPS }) });
    if (kind === 'tool') items.push({ state: 'current', text: i18nText('Executando {tool}…', { tool: toolPath(run.toolProposal) }) });
    if (kind === 'approval') items.push(proposalExpired(run) ? { state: 'warning', text: expiredNote() } : { state: 'waiting', text: i18nText('{tool} · aguardando aprovação', { tool: toolPath(run.toolProposal) }) });
    if (kind === 'running' && read) items.push({ state: 'current', text: i18nText('Escrevendo o rascunho') });
    if (kind === 'draft') items.push({ state: 'done', text: i18nText('Rascunho pronto') });
    if (kind === 'stale') items.push({ state: 'warning', text: i18nText('Rascunho anterior às novas mensagens') });
    // The same sentence as the rail: an interrupted internal lookup is "A consulta não terminou", never the external warning.
    if (!ACTIVE_KINDS.has(kind) && kind !== 'draft' && kind !== 'stale') items.push({ state: kind === 'tool_unknown' ? 'warning' : 'error', text: outcomeText(run, kind) });
    return items;
  }

  function healthBadge(agent) {
    const level = agent?.health?.level;
    if (!['ok', 'degraded', 'down'].includes(level)) return '';
    const [tone, text] = { ok: ['success', i18nText('Saudável')], degraded: ['warning', i18nText('Instável')], down: ['danger', i18nText('Fora do ar')] }[level];
    return h`<span class="ui-badge ui-badge--${tone}">${text}</span>`;
  }

  function contextTab(conversation) {
    if (!conversation) return raw('');
    const key = conversationKey(conversation), latest = runsOf(conversation.id).at(-1) || null;
    const generation = generateState(conversation);
    const agent = (latest && agentOf(latest.agentId)) || generation.agent || defaultAgent(conversation) || agentOf(conversation.agentId) || null;
    const subject = agent ? { agentId: agent.id } : latest;
    const details = [agent ? kindLabel(agent) : '', agent ? policyLabel(agent) : '', motorLabel(agent?.provider ?? latest?.provider)].filter(Boolean).join(' · ');
    const identity = subject ? h`<header class="pg-rail-tab__agent">${avatar({ kind: 'agent', name: agentName(subject), size: 40 })}<div class="pg-rail-tab__who"><strong>${agentName(subject)}</strong>${details ? h`<small>${details}</small>` : ''}</div>${healthBadge(agent)}</header>` : '';
    const historical = isHistoricalInvalidation(latest, conversation);
    const ended = historical ? new Date(time(latest.updatedAt)).toLocaleString(getLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const historyNote = historical ? h`<small class="pg-rail-tab__hint">${i18nText('Execução encerrada em {time}. Histórico preservado.', { time: ended })}</small>` : '';
    const list = stepItems(latest, conversation), runId = `rail-run-${domId(conversation.id)}`;
    const run = list.length ? h`<section class="pg-rail-tab__run" aria-labelledby="${runId}"><h3 id="${runId}">${i18nText(historical ? 'Última execução' : 'Execução atual')}</h3>${historyNote}<ol class="pg-rail-tab__steps">${list.map(item => h`<li data-state="${item.state}"><span class="pg-rail-tab__mark" aria-hidden="true">${STEP_MARKS[item.state]}</span><span>${item.text}</span><span class="sr-only">${i18nText(STEP_STATES[item.state])}</span></li>`)}</ol></section>` : '';
    const generateButton = button({ label: i18nText('Gerar rascunho'), icon: 'spark', type: 'submit', variant: 'primary', size: 'md', kbd: keyboard.singleKeyEnabled?.() ? 'c' : undefined, disabled: !generation.enabled });
    const hintId = `rail-hint-${domId(conversation.id)}`;
    const form = h`<form class="pg-rail-tab__form" data-form="rail:generate" data-conversation-id="${conversation.id}"><label class="pg-rail-tab__field">${i18nText('Orientação para o agente (opcional)')}<textarea name="instruction" rows="3" maxlength="1000" data-rail-instruction${attributes({disabled:!aiPolicy(conversation).allowed})} aria-describedby="${hintId}" placeholder="${i18nText('Ex.: tom formal, cite o prazo')}">${instructions.get(key) || ''}</textarea></label>${generateButton}<small class="pg-rail-tab__hint" id="${hintId}">${generation.enabled ? i18nText('O agente prepara. Você revisa e envia.') : generation.reason}</small></form>`;
    scheduleDomWork(false);
    return h`<section class="pg-rail-tab" data-rail-tab data-conversation-id="${conversation.id}">${identity}${autopilotCard(conversation)}${run}${latest && stateOf(latest) !== 'invalidated' ? sources(latest) : ''}${form}</section>`;
  }

  // The guidance typed in the Agente tab survives re-renders of its host (memory only, never storage).
  const listen = doc();
  if (typeof listen?.addEventListener === 'function' && !ctx.noListeners) {
    listen.addEventListener('input', event => {
      const target = event.target, conversation = currentConversation();
      if (conversation && aiPolicy(conversation).allowed && target?.matches?.('[data-rail-instruction]')) instructions.set(conversationKey(conversation), String(target.value || '').slice(0, 1000));
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Generate from the composer (app.js run-agent) and from the Agente tab (rail:generate)

  /**
   * The ✦ button of the composer (app.js run-agent until P3 uses rail:generate) generates without guidance:
   * guidance has one place, the Agente tab (§5.2.3). The "Acionar copiloto" dialog is gone. app.js does not
   * await this call, so errors are shown here.
   */
  function openRun(conversation, agent) {
    return generate(conversation, { agentId: agent?.id }).catch(error => { toast(error.message, true); return false; });
  }

  /** data-form="rail:generate" (Agente tab): the registry does not catch, so errors are shown here. */
  async function submit(form) {
    if (form?.dataset?.form !== 'rail:generate') return false;
    try {
      const values = new FormData(form), conversation = currentConversation();
      if (!conversation || form.dataset.conversationId && form.dataset.conversationId !== conversation.id) throw new Error(i18nText('O contexto mudou. Acione o agente novamente no atendimento atual.'));
      if (await generate(conversation, { instruction: String(values.get('instruction') || '').trim(), agentId: values.get('agentId') || undefined })) { instructions.delete(conversationKey(conversation)); form.reset?.(); }
    } catch (error) { toast(error.message, true); }
    return true;
  }

  // ---------------------------------------------------------------------------------------------

  async function act(name, id, element) {
    switch (name) {
      case 'mcp-approve': case 'mcp-reject': await decide(id, name === 'mcp-approve' ? 'approve' : 'reject'); return true;
      case 'mcp-regenerate': case 'rail:regenerate': await regenerate(id); return true;
      case 'rail:approve': case 'rail:reject': requireCardButton(element, id); await decide(id, name === 'rail:approve' ? 'approve' : 'reject'); return true;
      case 'rail:generate': {
        const conversation = currentConversation();
        if (!conversation || id && id !== conversation.id) throw new Error(i18nText('O contexto mudou. Acione o agente novamente no atendimento atual.'));
        await generate(conversation); return true;
      }
      case 'rail:retry': await retry(id, element); return true;
      case 'rail:cancel': await cancelRun(id, 'cancel'); return true;
      case 'rail:discard': await cancelRun(id, 'discard'); return true;
      case 'rail:insert-draft': await insertDraft(id || null); return true;
      case 'rail:insert-replace': await insertDraft(id, 'replace'); return true;
      case 'rail:insert-append': await insertDraft(id, 'append'); return true;
      case 'rail:insert-cancel': confirmations.delete(id); wantFocus(`rail:insert-draft|${id}`); paint(); return true;
      case 'rail:expand-draft': if (expandedDrafts.has(id)) expandedDrafts.delete(id); else expandedDrafts.add(id); wantFocus(`rail:expand-draft|${id}`); paint(); return true;
      case 'rail:notify-admin': await notifyAdmin(element); return true;
      case 'rail:focus-approval': return focusApproval();
      default: return false;
    }
  }

  /** Workspace or company changed: forgets forms, decisions, confirmations and per-conversation waits. */
  function reset() {
    pendingFocus = null; announcedView = null;
    for (const collection of [decisions, regenerating, cancelling, requesting, confirmations, expandedDrafts, seen, busy, inserted, instructions, spoken, quietOnce]) collection.clear();
  }

  return {
    render, timelineItems, contextTab, listGlyph, act, submit, reset, runCard, openRun,
    status, autopilotState, generateState, composerButton,
    /** Run whose draft was last inserted in this conversation (sourceRunId of the send, feature "source-run-id"). */
    insertedRun: conversationId => inserted.get(`${scope()}:${conversationId}`) ?? null,
    tick: (root = doc(), at = now()) => tickRail(root, at)
  };
}
