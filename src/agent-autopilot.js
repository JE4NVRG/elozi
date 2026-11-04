import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fail } from './store.js';
import { isTelegramAccountChannel, telegramAccountAiAllowed, TELEGRAM_ACCOUNT_HUMAN_ONLY_REASON } from './telegram-account-policy.js';
import { AI_QUOTA_REASON, PROMPT_NOTES } from './agent-runtime.js';
import { requestsHumanSupport } from './support-assistant.js';

/**
 * "Agente como atendente": autonomous replies of a company's internal Hermes copilot in conversations explicitly
 * assigned to it (owner === 'agent' && agentId === agent.id), only on channels the administrator opted in through
 * agent.autopilot. Jobs live in the tenant JSON (agentAutopilotJobs), like supportAssistantJobs, with a lease and the
 * states pending → running → sending → sent | handoff | failed | unknown | cancelled.
 *
 * Invariants:
 * - Authorization is explicit: without an `authorize` callback that answers `true` synchronously nothing is queued.
 * - Every guardrail that blocks an answer hands the conversation to people (queue or configured department, agent
 *   cleared, internal note). Cancellation without handoff happens only when someone else already owns the outcome:
 *   a human took over, the conversation was reassigned/closed or a newer customer message superseded the job. When the
 *   configuration, the authorization or the channel changed, the conversation stays with the copilot and the team gets
 *   an internal note that the message was not answered.
 * - Transient conditions (the conversation changed during preparation, an administrative invalidation, the runtime
 *   busy with another run, a failed read of the store) defer the job with a bounded budget, then hand it over.
 * - Async work (provider, transport) never runs inside Store.mutate; each step revalidates synchronously.
 * - A job reaches `sending` at most once. A send whose outcome is unknown is recorded as `unknown`, never retried, and
 *   always reaches people: handoff, or an internal note when someone else already owns the conversation.
 * - The preparation timeout ends when the draft is ready: the send has its own timeout and its own abort signal.
 * - The job stores ids, hashes and states only: never message text, drafts or contact data. Receipts form a ring per
 *   company (maxJobsPerTenant): at the cap the oldest finished receipts outside the protection window (hourly limits
 *   and message age) give way; live or recent receipts are never removed, and only then a new message goes to people.
 * - A handoff to a department with circular distribution reaches the next available person (operations.routeIncoming),
 *   as an incoming message or a transfer by a connected agent would.
 */

const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const pointerId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const jobsOf = tenant => Array.isArray(tenant?.agentAutopilotJobs) ? tenant.agentAutopilotJobs : [];
const referenceKey = reference => JSON.stringify([reference?.sourceId, reference?.publicationHash, reference?.chunkId]);
const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().slice(0, 4000);
/** Executions that failed on their own merit; deferrals (transient conditions) have their own budget. */
const failures = job => (job.attempts || 0) - (job.deferrals || 0);

export const AUTOPILOT_STATES = Object.freeze(['pending', 'running', 'sending', 'sent', 'handoff', 'failed', 'unknown', 'cancelled']);
const LIVE = new Set(['pending', 'running', 'sending']);
const SEND_ATTEMPTED = new Set(['sending', 'sent', 'unknown']);
const REFUSED = new Set([400, 401, 403, 404, 409, 422, 503]);
/** Runtime states that still hold a draft or a slot: cancelled when the job ends without sending. */
const HOLDING = new Set(['running', 'draft', 'waiting_approval', 'tool_running']);
const ROUTE_CHANGES = new Set(['owner', 'agentId', 'assignedUserId', 'status', 'channelId', 'departmentId']);
/** Cancellations that leave the conversation with the copilot and the customer's message unanswered: the team is told. */
const UNATTENDED = new Set(['configuration_changed', 'authorization_changed', 'channel_unavailable']);
/** Deferrals retried at once: the change already happened and a new execution reads the current state. */
const IMMEDIATE = new Set(['context_changed', 'invalidated']);
/** Preparations (claims) allowed per conversation and hour for each reply of maxRepliesPerHour: bursts of customer
 * messages abort and restart preparations without ever sending, so they have their own bound. */
const PREPARATIONS_PER_REPLY = 3;
const HOUR = 3600000;
export const AUTOPILOT_DEFAULTS = Object.freeze({ maxRepliesPerHour: 6, requireKnowledge: true });
export const AUTOPILOT_HANDOFF_TOKEN = 'ENCAMINHAR_HUMANO';
/** Explanations written in the internal note and in the assignment event when the autopilot hands a conversation over or stops. */
export const AUTOPILOT_HANDOFF_REASONS = Object.freeze({
  customer_requested_human: 'O cliente pediu atendimento humano.',
  customer_frustrated: 'O cliente demonstrou insatisfação; uma pessoa deve continuar.',
  media_needs_human: 'O cliente enviou mídia ou anexo, que o piloto automático não analisa.',
  knowledge_unavailable: 'Nenhuma fonte publicada e autorizada responde a esta pergunta.',
  rate_limited: 'O limite de respostas automáticas por hora desta conversa foi atingido.',
  burst_limited: 'Muitas mensagens seguidas nesta conversa reiniciaram a resposta automática; uma pessoa deve continuar.',
  quiet_hours: 'A mensagem chegou no horário silencioso do piloto automático.',
  stale_message: 'A mensagem ficou antiga demais para uma resposta automática.',
  agent_requested_human: 'O agente indicou que a pergunta precisa de uma pessoa.',
  draft_needs_human: 'A resposta preparada não ficou fundamentada nas fontes autorizadas.',
  invalid_draft: 'A resposta preparada não passou na validação de segurança.',
  agent_needs_approval: 'O agente pediu uma ferramenta que exige aprovação humana.',
  agent_failed: 'O agente não produziu uma resposta válida a tempo.',
  agent_busy: 'O agente continuou ocupado com outra preparação nesta conversa ou empresa.',
  ai_unavailable: 'O serviço de IA está indisponível ou o limite diário de IA foi atingido.',
  context_changed: 'O atendimento mudou repetidamente durante a preparação da resposta.',
  invalidated: 'O acesso ou a configuração do agente mudou repetidamente durante a preparação.',
  store_unavailable: 'O estado do atendimento não pôde ser confirmado durante a preparação.',
  send_refused: 'O canal recusou o envio automático; nenhuma mensagem saiu.',
  send_unconfirmed: 'O envio automático ficou sem confirmação. Confira o canal antes de responder para não duplicar.',
  interrupted: 'A preparação foi interrompida pela reinicialização do serviço.',
  claim_failed: 'O piloto automático não conseguiu iniciar a preparação desta resposta.',
  job_limit: 'O limite de recibos recentes do piloto automático desta empresa foi atingido; nenhum recibo em uso foi descartado.',
  configuration_changed: 'A configuração do piloto automático mudou antes do envio.',
  authorization_changed: 'O acesso do piloto automático mudou antes do envio.',
  channel_unavailable: 'O canal ficou indisponível para o piloto automático.'
});
const INSTRUCTION = `Esta mensagem será enviada automaticamente ao cliente pelo piloto automático da empresa, sem edição de uma pessoa. `
  + `Responda de forma curta e cordial usando somente fatos confirmados pelas fontes autorizadas e pelo histórico. `
  + `Não invente preços, prazos, estoque, políticas, links, telefones, e-mails, chaves PIX, permissões ou ações que você não pode executar. `
  + `Se as fontes não respondem à pergunta, ou se o cliente precisa de uma pessoa, responda somente ${AUTOPILOT_HANDOFF_TOKEN}.`;

// ---------------------------------------------------------------------------------------------------------------
// Configuration

function normalizeQuietHours(value) {
  if (value === undefined || value === null) return null;
  if (!plain(value) || Reflect.ownKeys(value).some(key => !['timezone', 'start', 'end'].includes(key))) fail(400, 'Informe fuso horário, início e fim do horário silencioso.');
  if (typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > 80) fail(400, 'Informe um fuso horário IANA válido.');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(0); } catch { fail(400, 'Informe um fuso horário IANA válido.'); }
  for (const key of ['start', 'end']) if (typeof value[key] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value[key])) fail(400, 'Informe o horário silencioso no formato HH:mm.');
  if (value.start === value.end) fail(400, 'O horário silencioso precisa de início e fim diferentes.');
  return { timezone: value.timezone, start: value.start, end: value.end };
}

/**
 * agent.autopilot = { enabled, channelIds (explicit opt-in), maxRepliesPerHour = 6 (per conversation, 1–30),
 * requireKnowledge = true, quietHours? { timezone, start: 'HH:mm', end: 'HH:mm' } (may cross midnight),
 * handoffDepartmentId? }. With `tenant`, channels and department must exist (department active).
 */
export function normalizeAutopilotConfig(input, { tenant } = {}) {
  if (!plain(input)) fail(400, 'Informe a configuração do piloto automático.');
  const fields = ['enabled', 'channelIds', 'maxRepliesPerHour', 'requireKnowledge', 'quietHours', 'handoffDepartmentId'];
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !fields.includes(key))) fail(400, 'Informe somente os campos do piloto automático.');
  if (typeof input.enabled !== 'boolean') fail(400, 'Informe se o piloto automático está ativo.');
  const channelIds = input.channelIds ?? [];
  if (!Array.isArray(channelIds) || channelIds.length > 50 || channelIds.some(id => !identity(id))) fail(400, 'Escolha até 50 canais válidos para o piloto automático.');
  const channels = [...new Set(channelIds)].sort();
  if (input.enabled && !channels.length) fail(400, 'Escolha ao menos um canal com autorização explícita para o piloto automático.');
  const maxRepliesPerHour = input.maxRepliesPerHour ?? AUTOPILOT_DEFAULTS.maxRepliesPerHour;
  if (!Number.isSafeInteger(maxRepliesPerHour) || maxRepliesPerHour < 1 || maxRepliesPerHour > 30) fail(400, 'Use de 1 a 30 respostas automáticas por hora em cada conversa.');
  const requireKnowledge = input.requireKnowledge ?? AUTOPILOT_DEFAULTS.requireKnowledge;
  if (typeof requireKnowledge !== 'boolean') fail(400, 'Informe se o conhecimento publicado é obrigatório.');
  const quietHours = normalizeQuietHours(input.quietHours);
  const handoffDepartmentId = input.handoffDepartmentId === undefined || input.handoffDepartmentId === null || input.handoffDepartmentId === '' ? null : input.handoffDepartmentId;
  if (handoffDepartmentId !== null && !identity(handoffDepartmentId)) fail(400, 'Escolha um departamento válido para a transferência.');
  if (tenant) {
    if (channels.some(id => !(tenant.channels || []).some(channel => channel.id === id))) fail(400, 'Escolha canais desta empresa para o piloto automático.');
    if (input.enabled && channels.some(id => isTelegramAccountChannel(tenant.channels?.find(channel => channel.id === id)))) fail(403, TELEGRAM_ACCOUNT_HUMAN_ONLY_REASON);
    if (handoffDepartmentId && !(tenant.departments || []).some(department => department.id === handoffDepartmentId && department.active !== false)) fail(400, 'Escolha um departamento ativo desta empresa para a transferência.');
  }
  return { enabled: input.enabled, channelIds: channels, maxRepliesPerHour, requireKnowledge, quietHours, handoffDepartmentId };
}
const autopilotOf = agent => { if (!agent?.autopilot) return null; try { const config = normalizeAutopilotConfig(agent.autopilot); return config.enabled ? config : null; } catch { return null; } };
const runnable = agent => agent?.provider === 'hermes' && agent.mode === 'copilot' && agent.configured === true;
// Any admin edit of the agent or of its autopilot settings invalidates queued and running work.
const agentHash = agent => sha({ provider: agent.provider, mode: agent.mode, configured: agent.configured, version: agent.version ?? 1, description: agent.description ?? '',
  tools: agent.tools ?? [], instructions: agent.instructions ?? '', toolPolicy: agent.toolPolicy ?? null, autopilot: autopilotOf(agent) });

/**
 * Whether the autopilot answers this conversation now: the structural rules of intake (assigned to a configured Hermes
 * copilot with the autopilot on for this channel, no person involved, not a group, channel enabled and outside the
 * platform's central support). The commercial check of the workspace stays with the caller.
 */
export function autopilotCovers(tenant, conversation) {
  if (!telegramAccountAiAllowed(tenant, conversation)) return false;
  if (!conversation || conversation.status === 'closed' || conversation.owner !== 'agent' || !conversation.agentId || conversation.assignedUserId
    || conversation.participants?.length || conversation.conversationKind === 'group') return false;
  const agent = (tenant?.agents || []).find(item => item.id === conversation.agentId), config = autopilotOf(agent);
  if (!runnable(agent) || !config || !config.channelIds.includes(conversation.channelId)) return false;
  const channel = (tenant.channels || []).find(item => item.id === conversation.channelId);
  // Channels of the platform's own central support are answered by SupportAssistant, never twice.
  return Boolean(channel) && channel.enabled !== false && !channel.centralSupportScope;
}

const clocks = new Map();
/** True when `instant` falls inside the quiet window, evaluated in the configured IANA time zone. */
export function inQuietHours(quietHours, instant = Date.now()) {
  if (!quietHours) return false;
  let format = clocks.get(quietHours.timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: quietHours.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (clocks.size > 64) clocks.clear();
    clocks.set(quietHours.timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const minute = (parts.hour % 24) * 60 + parts.minute, start = Number(quietHours.start.slice(0, 2)) * 60 + Number(quietHours.start.slice(3)), end = Number(quietHours.end.slice(0, 2)) * 60 + Number(quietHours.end.slice(3));
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// ---------------------------------------------------------------------------------------------------------------
// Customer signals (PT/EN/ES)

const HUMAN_REQUEST = [
  // PT, beyond the support assistant's patterns.
  /\b(?:falar|conversar)\s+com\s+(?:(?:o|a|um|uma|algum|alguma)\s+)?(?:alguem|gerente|supervisor|supervisora|responsavel|gente\s+de\s+verdade)\b/,
  /\bnao\s+quero\s+(?:falar\s+com\s+)?(?:(?:o|um)\s+)?(?:robo|bot|maquina|assistente\s+virtual)\b/,
  /\b(?:pessoa|atendente|ser\s+humano)\s+de\s+verdade\b/,
  // EN.
  /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:(?:a|an|the|your)\s+)?(?:someone|somebody|manager|supervisor|representative|rep)\b/,
  /\breal\s+(?:person|human)\b/, /\bhuman\s+(?:agent|being|operator)\b/,
  // ES.
  /\b(?:hablar|conversar|comunicarme|contactar)\s+con\s+(?:(?:un|una|el|la|algun|alguna)\s+)?(?:persona|humano|humana|agente|asesor|asesora|operador|operadora|representante|alguien|ejecutivo|ejecutiva|encargado|encargada|supervisor)\b/,
  /\b(?:atencion|soporte|agente|asesor)\s+(?:humano|humana|personal|real)\b/,
  /\b(?:pasame|paseme|comuniqueme|comunicame|transfiereme|transfierame|transfiere|comunicar)\s+(?:con|a)\s+(?:(?:un|una|el|la)\s+)?(?:persona|humano|humana|agente|asesor|asesora|operador|operadora|alguien|representante)\b/,
  /\bpersona\s+real\b/, /\bno\s+quiero\s+(?:hablar\s+con\s+)?(?:(?:un|el)\s+)?(?:bot|robot|maquina)\b/
];
const FRUSTRATION = [
  /\b(?:absurdo|absurda|ridiculo|ridicula|pessimo|pessima|horrivel|palhacada|vergonha|lamentavel|inaceitavel|descaso|lixo|inutil|procon|porra|caralho)\b/,
  /\breclame\s*aqui\b/, /\b(?:vou|vamos)\s+(?:te\s+|lhe\s+)?processar\b/, /\b(?:advogado|advogada|justica)\b/, /\bque\s+merda\b/, /\bsaco\s+cheio\b/,
  /\bnao\s+(?:resolve|resolveu|resolvem|ajuda|ajudou|ajudam|funciona\s+nada)\b/, /\bninguem\s+(?:resolve|responde|ajuda)\b/, /\bcansad[oa]\s+de\b/, /\brobo\s+burro\b/,
  /\b(?:ridiculous|terrible|awful|horrible|useless|worst|unacceptable|scam|fraud|pathetic|disgusting|lawyer|wtf|fuck|fucking|shit)\b/,
  /\bsue\s+(?:you|your)\b/, /\bthis\s+is\s+a\s+joke\b/, /\bnot\s+helpful\b/, /\bdoesn['’]?t\s+help\b/, /\b(?:fed\s+up|sick\s+of)\b/,
  /\b(?:pesimo|pesima|inaceptable|estafa|fraude|abogado|denuncia|mierda|joder|basura|verguenza)\b/,
  /\bno\s+(?:me\s+)?(?:sirve|sirven|ayuda|ayudan|ayudo|resuelve|resuelven|resolvio)\b/, /\bestoy\s+(?:harto|harta|cansado|cansada)\b/
];
/** Explicit request for a person, in Portuguese, English or Spanish. */
export function customerWantsHuman(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (requestsHumanSupport(value)) return true;
  const text = normalized(value);
  return HUMAN_REQUEST.some(pattern => pattern.test(text));
}
/** Frustration or escalation keywords, in Portuguese, English or Spanish. */
export function customerFrustrated(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const text = normalized(value);
  return FRUSTRATION.some(pattern => pattern.test(text));
}

// ---------------------------------------------------------------------------------------------------------------
// Draft safety: contact points (links, bare domains, e-mails, phones/documents, PIX keys) must come from trusted text

const LINKS = /(?:\bhttps?:\/\/|\bwww\.)[^\s<>"'()[\]{}]+/giu;
const EMAILS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// A bare host such as golpe.com.br/pix or loja.example: the final label is captured to tell domains from abbreviations.
const DOMAINS = /(?<![\p{L}\p{N}@_%+-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+([a-z]{2,24})(?![\p{L}\p{N}-])([/?#][^\s<>"'()[\]{}]*)?/giu;
const UUIDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
// Long opaque codes (wallet addresses, tokens, payment codes) mixing letters and digits.
const OPAQUE = /(?<![\p{L}\p{N}])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{20,}(?![\p{L}\p{N}])/giu;
// Phone numbers, documents (CPF/CNPJ) and payment lines: digit runs with common separators.
const DIGITS = /\+?\(?\d(?:[\d().-]|\s(?=[\d(+]))+/g;
// Generic top-level domains people type without a scheme; every two-letter label (country codes) also counts.
const TLDS = new Set(['com', 'net', 'org', 'info', 'biz', 'app', 'dev', 'xyz', 'online', 'site', 'store', 'shop', 'link', 'click', 'top', 'club', 'live', 'pro',
  'vip', 'lat', 'email', 'page', 'website', 'tech', 'digital', 'fun', 'icu', 'cam', 'space', 'work', 'life', 'world', 'today', 'news', 'blog', 'bet', 'win',
  'bid', 'loan', 'money', 'pay', 'cash', 'finance', 'bank', 'support', 'help', 'services', 'center', 'agency', 'company', 'host', 'cloud', 'art', 'ink',
  'wtf', 'zip', 'mov', 'gov', 'edu', 'mobi', 'name', 'asia', 'promo', 'sale', 'deals', 'market', 'delivery', 'express', 'one', 'plus', 'run', 'chat']);
const WORD = /[\p{L}\p{N}_-]/u;
const trimToken = token => token.replace(/[.,;:!?)\]]+$/u, '');
/** `token` occurs in `text` as a whole host/address: never as the tail of another host or the head of a longer one. */
function present(text, token) {
  if (!token) return true;
  for (let index = text.indexOf(token); index >= 0; index = text.indexOf(token, index + 1)) {
    const before = text[index - 1] ?? '', after = text[index + token.length] ?? '', next = text[index + token.length + 1] ?? '';
    if (before && WORD.test(before)) continue;
    if (after && (WORD.test(after) || after === '.' && next && WORD.test(next))) continue;
    return true;
  }
  return false;
}
const canonicalDigits = value => { const digits = value.replace(/\D/g, '').replace(/^0+/, ''); return /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits; };
const digitTokens = text => (text.match(DIGITS) || []).map(canonicalDigits).filter(digits => digits.length >= 8);
/** First contact point of the draft that the trusted text does not contain, or null. */
export function untrustedContact(draft, trusted) {
  const text = String(trusted || '').toLowerCase(), lower = String(draft || '').toLowerCase();
  for (const pattern of [LINKS, EMAILS, UUIDS, OPAQUE]) for (const token of lower.match(pattern) || []) if (!present(text, trimToken(token))) return trimToken(token);
  for (const match of lower.matchAll(DOMAINS)) {
    const tld = match[1].toLowerCase();
    if (!match[2] && tld.length !== 2 && !TLDS.has(tld)) continue;
    const token = trimToken(match[0]);
    if (!present(text, token)) return token;
  }
  const allowed = digitTokens(text);
  for (const digits of digitTokens(lower)) if (!allowed.some(value => value === digits || value.endsWith(digits))) return digits;
  return null;
}

const knowledgeQuery = conversation => (conversation.messages || []).filter(message => message?.kind === 'customer' && typeof message.text === 'string').slice(-3)
  .map(message => Array.from(message.text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').toWellFormed()).slice(0, 300).join('').trim()).join(' ').trim().slice(0, 1300).replace(/[\uD800-\uDBFF]$/, '');
function validDraft(draft) {
  return typeof draft === 'string' && draft.length > 0 && draft.length <= 4000 && Buffer.byteLength(draft) <= 16000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(draft)
    && !Object.values(PROMPT_NOTES).some(note => draft.includes(note));
}
const summary = job => ({ id: job.id, conversationId: job.conversationId, messageId: job.messageId, channelId: job.channelId, agentId: job.agentId,
  state: job.state, reason: job.reason || null, attempts: job.attempts || 0, deferrals: job.deferrals || 0, runId: job.runId || null, sentMessageId: job.sentMessageId || null,
  handoffApplied: job.handoffApplied === true, noticeApplied: job.noticeApplied === true, createdAt: job.createdAt, updatedAt: job.updatedAt });
const deny = (action, reason) => ({ ok: false, action, reason });

export class AgentAutopilot {
  /**
   * @param store Store (or { sync }): tenant()/mutate()/getConversation() and db for the workspace lookup.
   * @param options.runtime AgentRuntime: start(actor, tenantId, conversationId, input, { authorize, responseLanguage, knowledge }) and cancel().
   * @param options.knowledge KnowledgeBase: snapshot(), search(), current().
   * @param options.send async (input) => { confirmed: true, messageId? } | { confirmed: false, state: 'failed' }. It must call
   *   input.reauthorize() synchronously inside its final transaction before the provider (and again at dispatch time when
   *   an outbox delays it), and stop when input.signal aborts. Throw a 400/401/403/404/409/422/503 error only when nothing
   *   was dispatched; any other outcome is recorded as unknown and never retried.
   * @param options.operations { applyAssignment } (Operations) or options.handoff (fn inside a mutation) moves the
   *   conversation to the queue/department, clears agentId and writes the internal note.
   * @param options.authorize Synchronous ({ phase, tenantId, workspaceId, agentId, conversationId, channelId, departmentId, jobId })
   *   => true for plan/suspension/commercial checks at intake, claim, run and send. Default: deny.
   */
  constructor(store, { runtime, knowledge, send, operations = null, handoff = null, authorize = () => false, now = Date.now, logger = null,
    timeoutMs = 60000, sendTimeoutMs = 30000, leaseGraceMs = 5000, concurrency = 2, maxAttempts = 2, maxDeferrals = 3, maxClaimFailures = 5,
    retryDelayMs = 1000, maxJobsPerTenant = 1000, maxMessageAgeMs = 10 * 60000, autoDrain = true, resolveWorkspace = null, ownLines = null } = {}) {
    const bounded = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
    if (!runtime?.start || !runtime?.cancel || !knowledge?.search || !knowledge?.current || typeof send !== 'function'
      || handoff !== null && typeof handoff !== 'function' || handoff === null && typeof operations?.applyAssignment !== 'function'
      || typeof authorize !== 'function' || typeof now !== 'function' || logger !== null && typeof logger !== 'object'
      || !bounded(timeoutMs, 1, 300000) || !bounded(sendTimeoutMs, 1, 300000) || !bounded(leaseGraceMs, 0, 600000) || !bounded(concurrency, 1, 20)
      || !bounded(maxAttempts, 1, 5) || !bounded(maxDeferrals, 0, 10) || !bounded(maxClaimFailures, 1, 20) || !bounded(retryDelayMs, 0, 60000)
      || !bounded(maxJobsPerTenant, 10, 100000) || !bounded(maxMessageAgeMs, 1000, 7 * 86400000)
      || typeof autoDrain !== 'boolean' || resolveWorkspace !== null && typeof resolveWorkspace !== 'function'
      || ownLines !== null && (typeof ownLines?.agentOnOtherSide !== 'function' || typeof ownLines?.blocksAgent !== 'function')) throw new TypeError('Configuração do piloto automático inválida.');
    // Own lines (own-lines.js): the autopilot never answers when the other side of a pair of our lines is with an agent.
    this.ownLines = ownLines;
    this.store = store.sync ?? store; this.runtime = runtime; this.knowledge = knowledge; this.sendReply = send; this.authorize = authorize;
    this.now = now; this.logger = logger; this.timeoutMs = timeoutMs; this.sendTimeoutMs = sendTimeoutMs; this.leaseGraceMs = leaseGraceMs;
    this.concurrency = concurrency; this.maxAttempts = maxAttempts; this.maxDeferrals = maxDeferrals; this.maxClaimFailures = maxClaimFailures;
    this.retryDelayMs = retryDelayMs; this.maxJobsPerTenant = maxJobsPerTenant; this.maxMessageAgeMs = maxMessageAgeMs; this.autoDrain = autoDrain;
    // Receipts younger than this stay: the hourly limits count them and their message may still be received again.
    this.receiptFloorMs = Math.max(HOUR, maxMessageAgeMs) + 10 * 60000;
    this.operations = handoff ? null : operations; this.routes = null;
    this.handoff = handoff || (({ conversation, actor, department, explanation, note, reason, jobId }) => {
      operations.applyAssignment(conversation, actor, { owner: 'queue', ...(department ? { department } : {}), reason: `Piloto automático: ${explanation}`, origin: 'agent-autopilot' });
      conversation.messages ||= [];
      conversation.messages.push({ id: randomUUID(), kind: 'internal', text: note, authorName: actor.name, createdAt: conversation.updatedAt || this.date(), autopilotJobId: jobId, autopilotReason: reason });
    });
    if (resolveWorkspace) this.resolveWorkspace = resolveWorkspace;
    else {
      const statement = this.store.db?.prepare?.('SELECT reseller_id FROM tenants WHERE id=?');
      if (!statement) throw new TypeError('Configuração do piloto automático inválida.');
      this.resolveWorkspace = tenantId => statement.get(tenantId)?.reseller_id || null;
    }
    this.proofs = new WeakSet(); this.active = new Map(); this.tasks = new Set(); this.tenants = new Set();
    this.incoming = new Map(); this.claimFailures = new Map(); this.detachers = new Set();
    this.closed = false; this.kickScheduled = false; this.flushScheduled = false; this.wakeTimer = null; this.wakeAt = Infinity;
  }
  date() { return new Date(this.now()).toISOString(); }
  _log(level, message, error) { try { this.logger?.[level]?.(error?.status ? `${message} (${error.status})` : message); } catch { /* Logging never changes a job. */ } }
  _workspace(tenantId) { try { return identity(tenantId) ? this.resolveWorkspace(tenantId) : null; } catch { return null; } }
  /** In-memory retry delay (claim failures, intake retries, busy runtime): retryDelayMs doubling up to one minute. */
  _backoff(count) { return Math.min(60000, this.retryDelayMs * 2 ** Math.max(0, count - 1)); }
  /**
   * Internal identity: never a person, never a service principal. runId binds it to one runtime execution. The name is
   * neutral (author of notes and replies, initiator of runs): white label workspaces never see the engine's brand.
   */
  _actor(tenantId, workspaceId, runId = null) {
    const actor = Object.freeze({ kind: 'service', role: 'operator', resellerId: workspaceId, tenantIds: Object.freeze([tenantId]), name: 'Piloto automático',
      supportAssistantId: runId, autopilot: true });
    this.proofs.add(actor);
    return actor;
  }
  ownsActor(actor) { return this.proofs.has(actor); }

  // -------------------------------------------------------------------------------------------------------------
  // Eligibility and guardrails (synchronous, over one tenant snapshot)

  _eligible(tenant, conversationId, messageId, tenantId = null) {
    const conversation = (tenant.conversations || []).find(item => item.id === conversationId);
    if (!autopilotCovers(tenant, conversation)) return null;
    if (tenantId && this.ownLines?.agentOnOtherSide(tenantId, conversation, { state: tenant })) return null;
    const agent = (tenant.agents || []).find(item => item.id === conversation.agentId), config = autopilotOf(agent);
    const channel = (tenant.channels || []).find(item => item.id === conversation.channelId);
    const messages = conversation.messages || [], index = messages.findIndex(item => item.id === messageId);
    if (index < 0 || messages[index].kind !== 'customer' || messages.slice(index + 1).some(item => ['customer', 'human', 'agent'].includes(item?.kind))) return null;
    return { conversation, agent, config, channel, message: messages[index] };
  }
  /** Latest unanswered customer message while it is recent and live (WhatsApp backlog delivered late never qualifies). */
  _latestQuestion(conversation) {
    const last = (conversation?.messages || []).filter(message => ['customer', 'human', 'agent'].includes(message?.kind)).at(-1);
    if (last?.kind !== 'customer' || last.deliveredLate === true || !(this.now() - Date.parse(last.createdAt) <= this.maxMessageAgeMs)) return null;
    return last;
  }
  /** `ownMessageId`: the reply this job's transport already recorded, which is not an answer by someone else. */
  _route(tenant, job, ownMessageId = null) {
    const conversation = (tenant.conversations || []).find(item => item.id === job.conversationId);
    if (!conversation) return deny('cancel', 'conversation_removed');
    if (conversation.status === 'closed') return deny('cancel', 'closed');
    if (conversation.owner === 'human' || conversation.assignedUserId || conversation.participants?.length) return deny('cancel', 'human_took_over');
    if (conversation.owner !== 'agent' || conversation.agentId !== job.agentId || conversation.channelId !== job.channelId
      || (conversation.departmentId || null) !== job.departmentId || conversation.conversationKind === 'group') return deny('cancel', 'reassigned');
    const agent = (tenant.agents || []).find(item => item.id === job.agentId), config = autopilotOf(agent);
    if (!runnable(agent) || !config || !config.channelIds.includes(conversation.channelId) || agentHash(agent) !== job.agentConfigHash) return deny('cancel', 'configuration_changed');
    const channel = (tenant.channels || []).find(item => item.id === conversation.channelId);
    if (!channel || isTelegramAccountChannel(channel) || channel.enabled === false || channel.centralSupportScope) return deny('cancel', 'channel_unavailable');
    const messages = conversation.messages || [], index = messages.findIndex(item => item.id === job.messageId);
    if (index < 0 || messages[index].kind !== 'customer') return deny('cancel', 'conversation_removed');
    const later = messages.slice(index + 1).filter(item => ownMessageId === null || item?.id !== ownMessageId);
    if (later.some(item => item?.kind === 'customer')) return deny('cancel', 'superseded');
    if (later.some(item => ['human', 'agent'].includes(item?.kind))) return deny('cancel', 'already_answered');
    if (this.ownLines?.agentOnOtherSide(job.tenantId, conversation, { state: tenant })) return deny('cancel', 'own_line_pair');
    return { ok: true, conversation, agent, config, channel, message: messages[index] };
  }
  _authorized(tenant, job, route, phase) {
    try {
      const allowed = this.authorize({ phase, tenantId: job.tenantId, workspaceId: this._workspace(job.tenantId), agentId: job.agentId, conversationId: job.conversationId,
        channelId: route.conversation.channelId, departmentId: route.conversation.departmentId || null, jobId: job.id });
      if (allowed?.then) { Promise.resolve(allowed).catch(() => {}); return false; }
      return allowed === true;
    } catch { return false; }
  }
  /** phase: claim (pending job), run (running job, exact version) or send (sending job, exact version). */
  _evaluate(tenant, job, phase, executionId) {
    if (this.closed) return deny('retry', 'interrupted');
    const current = jobsOf(tenant).find(item => item.id === job.id);
    if (!current) return deny('cancel', 'execution_replaced');
    if (phase === 'claim' ? current.state !== 'pending' : current.state !== (phase === 'send' ? 'sending' : 'running') || current.executionId !== executionId) return deny('cancel', 'execution_replaced');
    const route = this._route(tenant, current);
    if (!route.ok) return route;
    if (phase !== 'claim' && route.conversation.version !== current.runVersion) return deny('defer', 'context_changed');
    if (!this._authorized(tenant, current, route, phase)) return deny('cancel', 'authorization_changed');
    return route;
  }
  _recentSends(tenant, job) {
    const since = this.now() - HOUR;
    return jobsOf(tenant).filter(item => item.id !== job.id && item.conversationId === job.conversationId && SEND_ATTEMPTED.has(item.state) && Number(item.sendStartedAt) >= since).length;
  }
  /** Other jobs of this conversation whose preparation started within the hour, sent or not (aborted, superseded). */
  _recentPreparations(tenant, job) {
    const since = this.now() - HOUR;
    return jobsOf(tenant).filter(item => item.id !== job.id && item.conversationId === job.conversationId && Number(item.preparedAt) >= since).length;
  }
  _guardrails(tenant, job, route) {
    const { message, config, agent, conversation } = route, age = this.now() - Date.parse(message.createdAt);
    // WhatsApp backlog delivered late never runs automations (whatsapp.js backlogAutomationMs): people answer it.
    if (message.deliveredLate === true || !Number.isFinite(age) || age > this.maxMessageAgeMs) return deny('handoff', 'stale_message');
    if (message.attachments?.length || typeof message.text !== 'string' || !message.text.trim()) return deny('handoff', 'media_needs_human');
    if (customerWantsHuman(message.text)) return deny('handoff', 'customer_requested_human');
    if (customerFrustrated(message.text)) return deny('handoff', 'customer_frustrated');
    if (inQuietHours(config.quietHours, this.now())) return deny('handoff', 'quiet_hours');
    if (this._recentSends(tenant, job) >= config.maxRepliesPerHour) return deny('handoff', 'rate_limited');
    if (this._recentPreparations(tenant, job) >= config.maxRepliesPerHour * PREPARATIONS_PER_REPLY) return deny('handoff', 'burst_limited');
    const query = knowledgeQuery(conversation);
    let references = { state: 'no_match', references: [] };
    try { references = this.knowledge.search(tenant, agent, query, {}, conversation); } catch { references = { state: 'unavailable', references: [] }; }
    if (config.requireKnowledge && (references.state !== 'matched' || !references.references?.length)) return deny('handoff', 'knowledge_unavailable');
    return { ok: true, query, grounding: (references.references || []).map(referenceKey) };
  }
  /** Draft review over the persisted run: grounding, size, control characters, contact points and handoff token. */
  _review(tenant, job) {
    const run = (tenant.runs || []).find(item => item.id === job.runId), agent = (tenant.agents || []).find(item => item.id === job.agentId), config = autopilotOf(agent);
    if (!run || run.state !== 'draft' || typeof run.draft !== 'string' || run.agentId !== job.agentId || run.conversationId !== job.conversationId || !config) return { ok: false, reason: 'agent_failed' };
    if (!this.knowledge.current(tenant, run)) return { ok: false, reason: 'draft_needs_human' };
    if (config.requireKnowledge) {
      const grounded = new Set(job.grounding || []);
      if (run.knowledgeState !== 'matched' || !run.knowledgeReferences?.some(reference => grounded.has(referenceKey(reference)))) return { ok: false, reason: 'draft_needs_human' };
    }
    const draft = run.draft.trim();
    if (draft.toUpperCase().includes(AUTOPILOT_HANDOFF_TOKEN)) return { ok: false, reason: 'agent_requested_human' };
    if (!validDraft(draft)) return { ok: false, reason: 'invalid_draft' };
    // Links, bare domains, e-mails, phones, documents and PIX keys reach the customer only when an authorized source or
    // the administrator's instructions contain them. Text the customer wrote is never trusted: it may be a scam to confirm.
    const trusted = [...(run.knowledgeReferences || []).map(reference => reference?.excerpt || ''), agent.instructions || ''].join('\n');
    if (untrustedContact(draft, trusted) !== null) return { ok: false, reason: 'invalid_draft' };
    return { ok: true, draft, run };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Intake

  /** Bus subscriber. Never mutates synchronously: intake runs after the publisher's call stack. */
  onEvent(event) {
    if (this.closed || !event || !identity(event.tenantId) || !pointerId(event.conversationId)) return;
    const key = `${event.tenantId}\u0000${event.conversationId}`;
    if (event.type === 'conversation.message') {
      if (event.kind !== 'customer' || event.owner !== 'agent' || !event.agentId || !pointerId(event.messageId)) return;
      this._abortConversation(event.tenantId, event.conversationId, 'superseded', event.messageId);
      this.incoming.set(key, { tenantId: event.tenantId, conversationId: event.conversationId, messageId: event.messageId });
      return this._flushSoon();
    }
    const changes = event.changes || [];
    if (event.type === 'conversation.removed' || event.type === 'conversation.updated' && changes.some(change => ROUTE_CHANGES.has(change) || change === 'messages')) {
      this._abortConversation(event.tenantId, event.conversationId, 'context_changed');
      this.tenants.add(event.tenantId);
    }
    // Assigned to an agent after the customer wrote (flow, routing or a person), or history rewritten without message
    // events (merge, removal): the latest recent question is eligible. An explicit message entry keeps precedence.
    if (event.type === 'conversation.updated' && event.owner === 'agent' && event.agentId && changes.some(change => change === 'owner' || change === 'agentId' || change === 'messages')) {
      if (!this.incoming.get(key)?.messageId) this.incoming.set(key, { tenantId: event.tenantId, conversationId: event.conversationId, messageId: null });
      this._flushSoon();
    }
  }
  /** Subscribes to a bus from events.js; returns the unsubscribe function (close() also unsubscribes). */
  attach(bus) {
    const off = bus.subscribe({ types: ['conversation.message', 'conversation.updated', 'conversation.removed'] }, event => this.onEvent(event));
    const detach = () => { this.detachers.delete(detach); off(); };
    this.detachers.add(detach);
    return detach;
  }
  _flushSoon() {
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    // Never unref'd: an unref'd immediate lets an idle loop block in poll, delaying intake until the next I/O or timer.
    setImmediate(() => { this.flushScheduled = false; this.flush(); });
  }
  /** Single timer that re-runs intake retries and the queue after a backoff. */
  _wakeIn(delay) {
    if (this.closed) return;
    const at = performance.now() + delay;
    if (this.wakeTimer && this.wakeAt <= at) return;
    clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.wakeAt = Infinity; this.flush(); this._kick(); }, Math.max(0, Math.ceil(delay)));
    this.wakeTimer.unref?.();
  }
  /**
   * Commits jobs for the coalesced customer messages (latest per conversation). A failed intake (store busy) stays
   * queued with backoff until it succeeds or a newer message of the same conversation replaces it.
   */
  flush() {
    if (this.closed) return [];
    // Timers run on the loop's cached clock and can fire a fraction of a millisecond before performance.now() reaches
    // retryAt; a small tolerance treats those retries as due instead of skipping them.
    const clock = performance.now() + 2, entries = [], results = [];
    for (const [key, entry] of this.incoming) if (!(entry.retryAt > clock)) entries.push([key, entry]);
    for (const [key] of entries) this.incoming.delete(key);
    for (const [key, entry] of entries) {
      try { results.push(entry.messageId ? this.receive(entry.tenantId, entry.conversationId, entry.messageId) : this.receiveLatest(entry.tenantId, entry.conversationId)); }
      catch (error) {
        results.push(null);
        if (this.closed || this.incoming.has(key)) continue;
        const tries = (entry.tries || 0) + 1, delay = this._backoff(tries);
        this.incoming.set(key, { ...entry, tries, retryAt: performance.now() + delay });
        this._log('warn', 'Mensagem preservada; o piloto automático tentará registrar a tarefa novamente.', error);
        this._wakeIn(delay);
      }
    }
    // A wake that fired before these retries were due (early timer, queue backoff, another retry) re-arms for the next
    // one; otherwise a preserved message would wait for an unrelated event.
    if (!this.closed) {
      const now = performance.now();
      let next = Infinity;
      for (const entry of this.incoming.values()) if (entry.retryAt > now) next = Math.min(next, entry.retryAt);
      if (next < Infinity) this._wakeIn(next - now);
    }
    return results;
  }
  /** Narrow no-op preflight for external MCP copilots, retaining all durable headers and the selected history. */
  _intakeTenant(actor, tenantId, conversationId) {
    const read = typeof this.store.readonlyConversationTenant === 'function' ? this.store.readonlyConversationTenant : this.store.conversationTenant;
    if (typeof conversationId === 'string' && conversationId.length > 0 && typeof read === 'function') {
      let scoped;
      try { scoped = read.call(this.store, actor, tenantId, conversationId); }
      catch (error) {
        // A removed conversation can still have a durable receipt. Preserve the legacy ledger lookup below.
        if (error?.status !== 404) throw error;
      }
      const conversation = scoped?.conversations.find(item => item.id === conversationId);
      const agent = conversation && (scoped.agents || []).find(item => item.id === conversation.agentId);
      // MCP copilots are structurally ineligible (runnable requires Hermes). The full private header retains receipts.
      // Actual autopilots continue with the full tenant for own-lines, global capacity and all current intake checks.
      if (agent?.provider === 'mcp' && agent.mode === 'copilot') return scoped;
    }
    return this.store.tenant(actor, tenantId);
  }
  /**
   * Intake of the latest unanswered customer message, only while it is recent: assigning an old conversation to the
   * agent waits for the customer's next message instead of bouncing it back to the queue as stale.
   */
  receiveLatest(tenantId, conversationId) {
    if (this.closed || !identity(tenantId) || !pointerId(conversationId)) return null;
    const workspaceId = this._workspace(tenantId);
    if (!workspaceId) return null;
    let tenant;
    try { tenant = this._intakeTenant(this._actor(tenantId, workspaceId), tenantId, conversationId); } catch { return null; }
    const last = this._latestQuestion((tenant.conversations || []).find(item => item.id === conversationId));
    return last ? this.receive(tenantId, conversationId, last.id) : null;
  }
  /** Durable intake of one customer message. Returns the job summary, or null when the conversation is not eligible. */
  receive(tenantId, conversationId, messageId) {
    if (this.closed || !identity(tenantId) || !pointerId(conversationId) || !pointerId(messageId)) return null;
    const workspaceId = this._workspace(tenantId);
    if (!workspaceId) return null;
    const actor = this._actor(tenantId, workspaceId);
    let tenant;
    try { tenant = this._intakeTenant(actor, tenantId, conversationId); } catch { return null; }
    const jobId = `autopilot_${sha([tenantId, conversationId, messageId]).slice(0, 48)}`, existing = jobsOf(tenant).find(item => item.id === jobId);
    if (existing) return summary(existing);
    const incoming = (tenant.conversations || []).find(item => item.id === conversationId);
    if (incoming && autopilotCovers(tenant, incoming) && this.ownLines?.blocksAgent(tenantId, incoming, { action: 'autopilot', state: tenant })) return null;
    const eligible = this._eligible(tenant, conversationId, messageId, tenantId);
    if (!eligible || !this._authorized(tenant, { id: jobId, tenantId, agentId: eligible.agent.id, conversationId }, eligible, 'intake')) return null;
    const result = this._mutate(actor, tenantId, 'Piloto automático: mensagem registrada na fila', state => {
      const jobs = state.agentAutopilotJobs ??= [], found = jobs.find(item => item.id === jobId);
      if (found) return summary(found);
      const current = this._eligible(state, conversationId, messageId, tenantId);
      if (!current) return null;
      if (jobs.length >= this.maxJobsPerTenant && !this._retire(jobs, jobs.length - this.maxJobsPerTenant + 1)) {
        // Every receipt is live or still protected: the message goes to people and no receipt in use is removed.
        return { limited: true, handoffApplied: this._applyHandoff(state, actor, { id: jobId, conversationId, agentId: current.agent.id, messageId }, 'job_limit') };
      }
      const date = this.date();
      for (const other of jobs) if (other.conversationId === conversationId && other.state === 'pending') { other.state = 'cancelled'; other.reason = 'superseded'; other.updatedAt = date; delete other.notBefore; }
      const job = { id: jobId, idempotencyKey: jobId, runId: null, tenantId, conversationId, messageId, channelId: current.conversation.channelId,
        departmentId: current.conversation.departmentId || null, agentId: current.agent.id, agentConfigHash: agentHash(current.agent),
        receivedVersion: current.conversation.version, state: 'pending', reason: null, attempts: 0, createdAt: date, updatedAt: date };
      jobs.push(job);
      return summary(job);
    });
    if (result?.limited) {
      this._log('error', 'Limite de recibos recentes do piloto automático atingido; a conversa foi encaminhada para a equipe e os recibos em uso foram preservados.');
      return null;
    }
    if (result) { this.tenants.add(tenantId); this._kick(); }
    return result;
  }
  /**
   * Catch-up of one company: tracks live jobs and creates jobs for recent unanswered customer messages that never became
   * one (event lost in a crash or a failed intake). Reads the company once; only eligible candidates are re-read.
   */
  _sweep(tenantId, workspaceId) {
    const tenant = this.store.tenant(this._actor(tenantId, workspaceId), tenantId), jobs = jobsOf(tenant);
    if (jobs.some(job => LIVE.has(job.state))) this.tenants.add(tenantId);
    if (!(tenant.agents || []).some(agent => runnable(agent) && autopilotOf(agent))) return 0;
    const known = new Set(jobs.map(job => `${job.conversationId}\u0000${job.messageId}`)), candidates = [];
    for (const conversation of tenant.conversations || []) {
      if (conversation?.owner !== 'agent' || conversation.status === 'closed') continue;
      const last = this._latestQuestion(conversation);
      if (!last || known.has(`${conversation.id}\u0000${last.id}`) || !this._eligible(tenant, conversation.id, last.id, tenantId)) continue;
      candidates.push([conversation.id, last.id]);
    }
    let created = 0;
    for (const [conversationId, messageId] of candidates) if (this.receive(tenantId, conversationId, messageId)) created++;
    return created;
  }
  /** Startup catch-up: tenants with live jobs, and recent customer messages that never became a job. */
  recover() {
    if (this.closed || !this.store.db?.prepare) return 0;
    let created = 0;
    for (const row of this.store.db.prepare(`SELECT id,reseller_id FROM tenants WHERE data LIKE '%"agentAutopilotJobs":[{%' OR data LIKE '%"autopilot":{%'`).all()) {
      try { created += this._sweep(row.id, row.reseller_id); }
      catch (error) { this._log('warn', 'Recuperação do piloto automático adiada nesta empresa.', error); }
    }
    this._kick();
    return created;
  }

  /**
   * Ring of receipts (inside the intake mutation): removes the `count` oldest finished receipts outside the protection
   * window. A live receipt (pending, running, sending) or one created, changed or sent within receiptFloorMs is never
   * removed: the hourly limits count them, and a message that recent may still reach intake (assignment, catch-up) and
   * must find its receipt. Returns false, removing nothing, when fewer than `count` qualify.
   */
  _retire(jobs, count) {
    const floor = this.now() - this.receiptFloorMs, indexes = [];
    for (let index = 0; index < jobs.length && indexes.length < count; index++) {
      const job = jobs[index];
      if (!LIVE.has(job?.state) && Date.parse(job?.updatedAt) < floor && Date.parse(job?.createdAt) < floor && !(Number(job?.sendStartedAt) >= floor)) indexes.push(index);
    }
    if (indexes.length < count) return false;
    for (const index of indexes.reverse()) jobs.splice(index, 1);
    return true;
  }
  /**
   * store.mutate, then the circular distribution of the conversations this transaction handed to people. Routing runs
   * after COMMIT, in its own transaction; a rolled back mutation routes nothing.
   */
  _mutate(actor, tenantId, label, fn) {
    const previous = this.routes, routes = this.routes = [];
    let result;
    try { result = this.store.mutate(actor, tenantId, label, fn); }
    finally { this.routes = previous; }
    for (const conversationId of new Set(routes)) {
      try { this.operations?.routeIncoming?.(tenantId, conversationId); }
      catch (error) { this._log('warn', 'Distribuição da conversa transferida pelo piloto automático adiada; ela segue na fila.', error); }
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Settlement (inside one mutation)

  /**
   * Terminal state of a job. `unknown` always reaches people (handoff or note). A handoff that is no longer possible
   * (someone else owns the conversation) is skipped. `fallback` is the retry after the handoff itself failed: the team
   * then gets an internal note instead of the assignment change.
   */
  _conclude(state, actor, job, finalState, reason, { handoff = false, notice = null, messageId = null, fallback = false } = {}) {
    const date = this.date();
    job.state = finalState; job.reason = reason || null; job.updatedAt = date;
    delete job.leaseUntil; delete job.notBefore; delete job.grounding;
    if (finalState === 'sent') { job.sentAt = date; if (pointerId(messageId)) job.sentMessageId = messageId; }
    const explain = finalState === 'unknown' ? 'send_unconfirmed' : reason, wantsHandoff = handoff || finalState === 'unknown';
    if (wantsHandoff) job.handoffApplied = fallback ? false : this._applyHandoff(state, actor, job, explain);
    const wantsNotice = notice ?? (finalState === 'unknown' || finalState === 'cancelled' && UNATTENDED.has(reason) || wantsHandoff && fallback);
    if (wantsNotice && !job.handoffApplied) job.noticeApplied = this._notice(state, actor, job, explain, finalState);
    return summary(job);
  }
  _settleDenied(state, actor, job, verdict, fallback = false) {
    const { action, reason } = verdict;
    if (action === 'retry' || action === 'defer') {
      if (job.state === 'pending') return summary(job); // Nothing was claimed; the next drain evaluates it again.
      if (job.state === 'running') {
        const deferred = action === 'defer' && (job.deferrals || 0) < this.maxDeferrals;
        if (deferred || action === 'retry' && failures(job) < this.maxAttempts) {
          if (deferred) {
            job.deferrals = (job.deferrals || 0) + 1;
            const delay = IMMEDIATE.has(reason) ? 0 : this._backoff(job.deferrals);
            if (delay) job.notBefore = this.now() + delay; else delete job.notBefore;
          }
          job.state = 'pending'; job.reason = reason; delete job.executionId; delete job.leaseUntil; job.updatedAt = this.date();
          return summary(job);
        }
      }
    }
    if (action === 'cancel') return this._conclude(state, actor, job, job.state === 'sending' ? 'unknown' : 'cancelled', reason, { fallback });
    return this._conclude(state, actor, job, job.state === 'sending' ? 'unknown' : 'handoff', reason, { handoff: true, fallback });
  }
  /** One mutation; when the handoff itself failed, a second one leaves an internal note instead. */
  _attempt(tenantId, actor, label, apply) {
    try { return { ok: true, value: this._mutate(actor, tenantId, label, state => apply(state, false)) }; }
    catch (error) {
      if (!error?.handoffFailed) { this._log('error', `${label}: registro adiado.`, error); return { ok: false, error }; }
      this._log('error', 'A transferência do piloto automático falhou; a equipe recebe uma nota interna.', error);
    }
    try { return { ok: true, value: this._mutate(actor, tenantId, label, state => apply(state, true)) }; }
    catch (error) { this._log('error', `${label}: registro adiado.`, error); return { ok: false, error }; }
  }
  _finish(tenantId, actor, job, outcome) {
    const result = this._attempt(tenantId, actor, 'Piloto automático: execução finalizada', (state, fallback) => {
      const current = jobsOf(state).find(item => item.id === job.id);
      if (!current || current.executionId !== job.executionId || !['running', 'sending'].includes(current.state)) return current ? summary(current) : null;
      if (outcome.verdict) return this._settleDenied(state, actor, current, outcome.verdict, fallback);
      return this._conclude(state, actor, current, outcome.state, outcome.reason, { handoff: outcome.handoff === true, messageId: outcome.messageId, fallback });
    });
    return result.ok ? result.value : null;
  }
  _applyHandoff(state, actor, job, reason) {
    const conversation = (state.conversations || []).find(item => item.id === job.conversationId);
    if (!conversation || conversation.status === 'closed' || conversation.owner !== 'agent' || conversation.agentId !== job.agentId || conversation.assignedUserId) return false;
    const agent = (state.agents || []).find(item => item.id === job.agentId);
    let departmentId = null;
    try { departmentId = normalizeAutopilotConfig(agent?.autopilot).handoffDepartmentId; } catch { /* An invalid configuration falls back to the queue. */ }
    const department = departmentId ? (state.departments || []).find(item => item.id === departmentId && item.active !== false) : undefined;
    const explanation = AUTOPILOT_HANDOFF_REASONS[reason] || 'Uma pessoa precisa continuar este atendimento.';
    try {
      this.handoff({ tenant: state, conversation, actor, department, reason, explanation, jobId: job.id, messageId: job.messageId,
        note: `Piloto automático pausado nesta conversa. Motivo: ${explanation}` });
      if (conversation.owner === 'agent' || conversation.agentId) throw new TypeError('A transferência do piloto automático precisa retirar o agente da conversa.');
    } catch (cause) {
      throw Object.assign(new Error('A transferência do piloto automático falhou.', { cause }), { handoffFailed: true });
    }
    this.routes?.push(conversation.id);
    return true;
  }
  /** Internal note without changing the assignment (someone else owns the conversation, or the handoff failed). */
  _notice(state, actor, job, reason, finalState) {
    const conversation = (state.conversations || []).find(item => item.id === job.conversationId);
    if (!conversation) return false;
    conversation.messages ||= [];
    if (conversation.messages.some(message => message?.kind === 'internal' && message.autopilotJobId === job.id && message.autopilotReason === reason)) return true;
    const explanation = AUTOPILOT_HANDOFF_REASONS[reason] || 'Uma pessoa precisa conferir este atendimento.', date = this.date();
    const text = finalState === 'unknown' ? `Piloto automático: ${explanation}` : `Piloto automático não respondeu a última mensagem do cliente. Motivo: ${explanation}`;
    conversation.messages.push({ id: randomUUID(), kind: 'internal', text, authorName: actor.name, createdAt: date, autopilotJobId: job.id, autopilotReason: reason });
    // The version step makes a reply prepared before the note conflict, so the person reads it before answering.
    conversation.version = (conversation.version || 1) + 1; conversation.updatedAt = date;
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Worker

  _kick() {
    if (!this.autoDrain || this.closed || this.kickScheduled) return;
    this.kickScheduled = true;
    setImmediate(() => { this.kickScheduled = false; this.drain().catch(error => this._log('error', 'Fila do piloto automático indisponível.', error)); });
  }
  _recover(tenantId, actor) {
    const expired = job => ['running', 'sending'].includes(job.state) && !(Number(job.leaseUntil) > this.now()) && !this.active.has(job.id);
    const ids = jobsOf(this.store.tenant(actor, tenantId)).filter(expired).map(job => job.id);
    for (const jobId of ids) this._attempt(tenantId, actor, 'Piloto automático: execução interrompida reconciliada', (state, fallback) => {
      const job = jobsOf(state).find(item => item.id === jobId);
      if (!job || !expired(job)) return null;
      delete job.executionId;
      // Never retried: a send that started may have reached the customer.
      if (job.state === 'sending') return this._conclude(state, actor, job, 'unknown', 'send_unconfirmed', { fallback });
      if (failures(job) < this.maxAttempts) { job.state = 'pending'; job.reason = 'lease_recovered'; delete job.leaseUntil; job.updatedAt = this.date(); return summary(job); }
      return this._conclude(state, actor, job, 'failed', 'interrupted', { handoff: true, fallback });
    });
  }
  async drain() {
    if (this.closed) return [];
    const selected = [], busy = new Set([...this.active.values()].map(task => `${task.tenantId}\u0000${task.conversationId}`)), clock = performance.now(), now = this.now();
    let wait = Infinity;
    for (const tenantId of [...this.tenants]) {
      if (this.active.size + selected.length >= this.concurrency) break;
      try {
        const workspaceId = this._workspace(tenantId);
        if (!workspaceId) { this.tenants.delete(tenantId); continue; }
        const actor = this._actor(tenantId, workspaceId);
        this._recover(tenantId, actor);
        const jobs = jobsOf(this.store.tenant(actor, tenantId));
        if (!jobs.some(job => LIVE.has(job.state))) { this.tenants.delete(tenantId); continue; }
        const latest = new Map();
        for (const job of jobs) if (job.state === 'pending') latest.set(job.conversationId, job);
        for (const job of latest.values()) {
          const key = `${tenantId}\u0000${job.conversationId}`;
          if (this.active.size + selected.length >= this.concurrency) break;
          if (busy.has(key) || this.active.has(job.id)) continue;
          const deferred = Number(job.notBefore) > now ? job.notBefore - now : 0, backoff = (this.claimFailures.get(job.id)?.until ?? 0) - clock;
          if (deferred > 0 || backoff > 0) { wait = Math.min(wait, Math.max(deferred, backoff)); continue; }
          busy.add(key); selected.push({ tenantId, jobId: job.id });
        }
      } catch (error) { this._log('warn', 'Fila do piloto automático indisponível nesta empresa.', error); }
    }
    if (wait < Infinity && this.autoDrain) this._wakeIn(wait);
    return Promise.all(selected.map(({ tenantId, jobId }) => {
      const task = this._process(tenantId, jobId).catch(error => { this._log('error', 'Tarefa do piloto automático encerrada sem resultado.', error); return null; });
      this.tasks.add(task); task.finally(() => this.tasks.delete(task));
      return task;
    }));
  }
  /** Current verdict over a fresh read. A read failure is transient (deferred); a lost access is a cancellation. */
  _current(tenantId, actor, job, phase) {
    let tenant;
    try { tenant = this.store.tenant(actor, tenantId); }
    catch (error) {
      this._log('warn', 'Estado do atendimento indisponível para o piloto automático.', error);
      return [403, 404].includes(error?.status) ? deny('cancel', 'authorization_changed') : deny('defer', 'store_unavailable');
    }
    try { return this._evaluate(tenant, job, phase, job.executionId); } catch { return deny('defer', 'store_unavailable'); }
  }
  /** Runtime refusals: quota/unavailable hand over; another run of this conversation or the concurrency cap defer. */
  _runtimeFailure(error) {
    if (error?.status === 503 || error?.status === 429 && error.message === AI_QUOTA_REASON) return { state: 'handoff', handoff: true, reason: 'ai_unavailable' };
    if (error?.status === 409 || error?.status === 429) return { verdict: deny('defer', 'agent_busy') };
    return { state: 'handoff', handoff: true, reason: 'agent_failed' };
  }
  /** A claim that keeps failing backs off; after maxClaimFailures the job is closed and the team is told. */
  _claimFailed(tenantId, actor, jobId, error) {
    const entry = this.claimFailures.get(jobId) || { failures: 0, until: 0 };
    entry.failures += 1;
    if (entry.failures >= this.maxClaimFailures) {
      const settled = this._attempt(tenantId, actor, 'Piloto automático: tarefa encerrada após falhas repetidas', (state, fallback) => {
        const job = jobsOf(state).find(item => item.id === jobId);
        return job?.state === 'pending' ? this._conclude(state, actor, job, 'failed', 'claim_failed', { handoff: true, fallback }) : null;
      });
      if (settled.ok) { this.claimFailures.delete(jobId); this._log('error', 'Tarefa do piloto automático encerrada após falhas repetidas; a equipe foi avisada.', error); return; }
    }
    const delay = this._backoff(entry.failures);
    entry.until = performance.now() + delay;
    this.claimFailures.set(jobId, entry);
    this._log('warn', 'Tarefa do piloto automático não pôde ser iniciada; nova tentativa em instantes.', error);
    if (this.autoDrain) this._wakeIn(delay);
  }
  async _process(tenantId, jobId) {
    if (this.active.has(jobId) || this.closed) return null;
    const workspaceId = this._workspace(tenantId);
    if (!workspaceId) return null;
    const actor = this._actor(tenantId, workspaceId), controller = new AbortController(), signal = controller.signal;
    const task = { tenantId, jobId, conversationId: null, messageId: null, agentId: null, channelId: null, executionId: null, reason: null, controller };
    this.active.set(jobId, task);
    let job = null, runActor = null, runState = null, attemptedSend = false, timer = null, onAbort;
    const interrupted = new Promise((_, reject) => { onAbort = () => reject(Object.assign(new Error('autopilot_interrupted'), { interrupted: true })); signal.addEventListener('abort', onAbort, { once: true }); });
    interrupted.catch(() => {});
    try {
      const claimed = this._attempt(tenantId, actor, 'Piloto automático: preparação iniciada', (state, fallback) => {
        const current = jobsOf(state).find(item => item.id === jobId);
        if (!current || current.state !== 'pending' || Number(current.notBefore) > this.now()) return { skip: current ? summary(current) : null };
        let verdict = this._evaluate(state, current, 'claim');
        if (verdict.ok) verdict = { ...verdict, ...this._guardrails(state, current, verdict) };
        if (!verdict.ok) return { skip: this._settleDenied(state, actor, current, verdict, fallback) };
        const date = this.date();
        for (const other of jobsOf(state)) if (other !== current && other.conversationId === current.conversationId && other.state === 'pending') { other.state = 'cancelled'; other.reason = 'superseded'; other.updatedAt = date; delete other.notBefore; }
        current.attempts = (current.attempts || 0) + 1; current.state = 'running'; current.reason = null; current.executionId = randomUUID(); delete current.notBefore;
        current.preparedAt ??= this.now();
        current.runId = current.attempts === 1 ? current.id : `${current.id}_r${current.attempts}`; current.runVersion = verdict.conversation.version;
        current.grounding = verdict.grounding; current.leaseUntil = this.now() + this.timeoutMs + this.leaseGraceMs; current.updatedAt = date;
        return { job: structuredClone(current), query: verdict.query };
      });
      if (!claimed.ok) { this._claimFailed(tenantId, actor, jobId, claimed.error); return null; }
      this.claimFailures.delete(jobId);
      const claim = claimed.value;
      if (!claim.job) return claim.skip;
      job = claim.job; Object.assign(task, { conversationId: job.conversationId, messageId: job.messageId, agentId: job.agentId, channelId: job.channelId, executionId: job.executionId });
      if (task.reason) controller.abort();
      runActor = this._actor(tenantId, workspaceId, job.runId);
      timer = setTimeout(() => { task.reason ||= 'timeout'; controller.abort(); }, this.timeoutMs);
      timer.unref?.();
      const check = () => {
        if (signal.aborted) fail(409, 'A preparação automática foi interrompida.');
        if (!this._current(tenantId, actor, job, 'run').ok) fail(409, 'O atendimento saiu do piloto automático.');
        return true;
      };
      let run;
      try {
        run = await Promise.race([this.runtime.start(runActor, tenantId, job.conversationId, { runId: job.runId, idempotencyKey: job.runId, agentId: job.agentId,
          version: job.runVersion, instruction: INSTRUCTION }, { authorize: check, responseLanguage: 'match_customer', promptMode: 'autopilot', knowledge: { query: claim.query } }), interrupted]);
      } catch (error) {
        if (error?.interrupted) throw error;
        const verdict = this._current(tenantId, actor, job, 'run');
        return this._finish(tenantId, actor, job, verdict.ok ? this._runtimeFailure(error) : { verdict });
      }
      // The preparation budget ends with the draft: from here the send has its own timeout and its own abort signal,
      // so a slow but valid send is never cut by the preparation timer. Admin invalidation and takeovers abort the send.
      clearTimeout(timer); timer = null; runState = run?.state ?? null;
      if (signal.aborted) throw Object.assign(new Error('autopilot_interrupted'), { interrupted: true });
      const sending = new AbortController();
      task.controller = sending;
      const verdict = this._current(tenantId, actor, job, 'run');
      if (!verdict.ok) return this._finish(tenantId, actor, job, { verdict });
      if (run?.state === 'waiting_approval') {
        try { this.runtime.cancel(runActor, tenantId, job.runId); runState = null; } catch { /* The run is invalidated by the next reconciliation. */ }
        return this._finish(tenantId, actor, job, { state: 'handoff', handoff: true, reason: 'agent_needs_approval' });
      }
      if (run?.state === 'invalidated') return this._finish(tenantId, actor, job, { verdict: deny('defer', 'context_changed') });
      if (run?.state !== 'draft') return this._finish(tenantId, actor, job, { state: 'handoff', handoff: true, reason: 'agent_failed' });
      const review = this._review(this.store.tenant(actor, tenantId), job);
      if (!review.ok) return this._finish(tenantId, actor, job, { state: 'handoff', handoff: true, reason: review.reason });
      const marked = this.store.mutate(actor, tenantId, 'Piloto automático: resposta liberada para envio', state => {
        const current = jobsOf(state).find(item => item.id === job.id);
        const latest = this._evaluate(state, job, 'run', job.executionId);
        if (!latest.ok) return { verdict: latest };
        const again = this._review(state, current);
        if (!again.ok || again.draft !== review.draft) return { verdict: deny('handoff', again.reason || 'invalid_draft') };
        // Concurrent jobs of the same conversation cannot exceed the hourly limit between claim and send.
        if (this._recentSends(state, current) >= latest.config.maxRepliesPerHour) return { verdict: deny('handoff', 'rate_limited') };
        current.state = 'sending'; current.sendStartedAt = this.now(); current.draftHash = sha(review.draft);
        current.leaseUntil = this.now() + this.sendTimeoutMs + this.leaseGraceMs; current.updatedAt = this.date();
        return { ok: true };
      });
      if (!marked.ok) return this._finish(tenantId, actor, job, { verdict: marked.verdict });
      job.state = 'sending';
      const input = { actor: runActor, tenantId, conversationId: job.conversationId, channelId: job.channelId, version: job.runVersion, text: review.draft,
        idempotencyKey: job.idempotencyKey, replyToMessageId: job.messageId, agentId: job.agentId, jobId: job.id, runId: job.runId, signal: sending.signal };
      const fresh = () => { if (this.authorizeSend(input) !== true) fail(403, 'O envio automático perdeu a autorização.'); return true; };
      input.authorize = fresh; input.reauthorize = fresh;
      try { fresh(); } catch {
        // Nothing was dispatched: a lost route cancels; anything else (refusal, unreadable state) goes to people.
        const latest = this._current(tenantId, actor, job, 'send');
        return this._finish(tenantId, actor, job, latest.ok || latest.action !== 'cancel' ? { state: 'failed', handoff: true, reason: 'send_refused' } : { state: 'cancelled', reason: latest.reason });
      }
      attemptedSend = true;
      let receipt, failure, sendTimer;
      try {
        receipt = await Promise.race([Promise.resolve().then(() => this.sendReply(input)),
          new Promise((_, reject) => { sendTimer = setTimeout(() => { sending.abort(); reject(Object.assign(new Error('autopilot_send_timeout'), { timeout: true })); }, this.sendTimeoutMs); sendTimer.unref?.(); })]);
      } catch (error) { failure = error; } finally { clearTimeout(sendTimer); }
      if (!failure && receipt?.confirmed === true) return this._finish(tenantId, actor, job, { state: 'sent', messageId: receipt.messageId });
      if (failure && !failure.timeout && REFUSED.has(failure.status) || !failure && receipt?.confirmed === false && receipt.state === 'failed') {
        // The sender guarantees nothing was dispatched: a refusal is final for this job, never a resend.
        let route = null;
        try { route = this._route(this.store.tenant(actor, tenantId), job); } catch { /* The handoff below re-checks the route in its transaction. */ }
        return this._finish(tenantId, actor, job, route && !route.ok ? { state: 'cancelled', reason: route.reason } : { state: 'failed', handoff: true, reason: 'send_refused' });
      }
      return this._finish(tenantId, actor, job, { state: 'unknown', handoff: true, reason: 'send_unconfirmed' });
    } catch (error) {
      if (!job) { this._log('warn', 'Tarefa do piloto automático não pôde ser iniciada.', error); return null; }
      if (attemptedSend) return this._finish(tenantId, actor, job, { state: 'unknown', handoff: true, reason: 'send_unconfirmed' });
      const verdict = this._current(tenantId, actor, job, 'run');
      if (!verdict.ok) return this._finish(tenantId, actor, job, { verdict });
      // An administrative invalidation without a visible change re-runs over the current grants and settings.
      if (task.reason === 'invalidated') return this._finish(tenantId, actor, job, { verdict: deny('defer', 'invalidated') });
      if (task.reason === 'context_changed' || task.reason === 'superseded') return this._finish(tenantId, actor, job, { verdict: deny('defer', 'context_changed') });
      return this._finish(tenantId, actor, job, { state: 'handoff', handoff: true, reason: 'agent_failed' });
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      // A preparation that ends without a send never leaves a usable draft behind (blocked links, handoffs, refusals).
      if (job && !attemptedSend && (signal.aborted || HOLDING.has(runState))) { try { this.runtime.cancel(runActor || actor, tenantId, job.runId); } catch { /* A run may not have been accepted. */ } }
      if (this.active.get(jobId) === task) this.active.delete(jobId);
      this._kick();
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Authority used by the runtime, the send gateway and administrative changes

  /** AgentRuntime validateInitiator for run ids starting with `autopilot_`. */
  runCurrent(run) {
    try {
      if (typeof run?.id !== 'string' || !run.id.startsWith('autopilot_') || run.actorUserId || run.serviceId || run.supportGrantId) return false;
      const workspaceId = this._workspace(run.tenantId);
      if (!workspaceId) return false;
      const tenant = this.store.tenant(this._actor(run.tenantId, workspaceId), run.tenantId), job = jobsOf(tenant).find(item => item.runId === run.id);
      if (!job || !['running', 'sending'].includes(job.state) || job.agentId !== run.agentId || job.conversationId !== run.conversationId || job.runVersion !== run.conversationVersion) return false;
      return this._evaluate(tenant, job, job.state === 'sending' ? 'send' : 'run', job.executionId).ok;
    } catch { return false; }
  }
  /** The reply a transport recorded for this job (kind agent, autopilotJobId), null before it, or `duplicate`. */
  _ownReply(tenant, job) {
    const conversation = (tenant.conversations || []).find(item => item.id === job.conversationId);
    const own = (conversation?.messages || []).filter(message => message?.kind === 'agent' && message.autopilotJobId === job.id);
    return own.length === 1 ? own[0] : own.length ? { duplicate: true } : null;
  }
  /**
   * Verdict of a job in `sending`. Before its reply is recorded: the exact version, nothing answered in between and the
   * reviewed draft. After the transport recorded it (the dispatch checks of e-mail and Meta run then), the version moved
   * with that one message: the route, the configuration and the authorization must still hold, nothing else.
   */
  _sendVerdict(tenant, job) {
    const own = this._ownReply(tenant, job);
    if (!own) return this._evaluate(tenant, job, 'send', job.executionId);
    if (own.duplicate || this.closed) return deny('cancel', 'execution_replaced');
    const route = this._route(tenant, job, own.id);
    if (!route.ok) return route;
    if (!this._authorized(tenant, job, route, 'send')) return deny('cancel', 'authorization_changed');
    return { ...route, recorded: own };
  }
  /** The job of a live execution of this process in `sending`, for the autopilot identity `actor`, or null. */
  _sending(tenant, actor) {
    const job = jobsOf(tenant).find(item => item.runId === actor.supportAssistantId), task = job && this.active.get(job.id);
    return job && job.state === 'sending' && task && task.executionId === job.executionId ? job : null;
  }
  /**
   * Synchronous authority for the send gateway (call it inside the transaction that records/dispatches the message).
   * Only the live execution of this process, in state `sending`, with the exact draft, version and idempotency key.
   */
  authorizeSend(input) {
    if (!this.proofs.has(input?.actor) || input.actor.supportAssistantId !== input.runId || !input.actor.tenantIds?.includes(input.tenantId)) fail(403, 'Envio não pertence ao piloto automático autorizado.');
    if (this.closed || input.signal?.aborted) fail(409, 'O envio automático foi interrompido.');
    const tenant = this.store.tenant(input.actor, input.tenantId), job = jobsOf(tenant).find(item => item.id === input.jobId), task = this.active.get(input.jobId);
    if (!job || job.state !== 'sending' || !task || task.executionId !== job.executionId || job.idempotencyKey !== input.idempotencyKey || job.runId !== input.runId
      || job.conversationId !== input.conversationId || job.channelId !== input.channelId || job.messageId !== input.replyToMessageId || job.agentId !== input.agentId
      || job.runVersion !== input.version) fail(403, 'Envio não pertence ao piloto automático autorizado.');
    const verdict = this._sendVerdict(tenant, job);
    if (!verdict.ok) fail(409, 'O atendimento saiu do piloto automático.');
    if (verdict.recorded) {
      if (sha(input.text) !== job.draftHash) fail(409, 'A resposta perdeu a autorização do piloto automático.');
      return true;
    }
    const review = this._review(tenant, job);
    if (!review.ok || review.draft !== input.text || sha(input.text) !== job.draftHash) fail(409, 'A resposta perdeu a autorização do piloto automático.');
    return true;
  }
  /**
   * Operations.canReply hook for the autopilot identity: true only for the live execution of this process in `sending`,
   * in this conversation, while the route and the authorization hold. Exact version and draft stay with authorizeSend.
   */
  authorizeReply(actor, tenantId, conversation) {
    try {
      if (!this.proofs.has(actor) || this.closed || !identity(actor.supportAssistantId) || !actor.tenantIds?.includes(tenantId)) return false;
      const tenant = this.store.tenant(actor, tenantId), job = this._sending(tenant, actor);
      return Boolean(job && job.conversationId === conversation?.id && this._sendVerdict(tenant, job).ok);
    } catch { return false; }
  }
  /**
   * Aborts in-flight work after an authorization or configuration change (agent edit, knowledge grants, access).
   * A preparation is re-run over the current state; a send not yet dispatched is refused and handed over.
   */
  invalidate({ tenantId, agentId, conversationId, channelId } = {}, reason = 'invalidated') {
    let count = 0;
    for (const task of this.active.values()) if ((!tenantId || task.tenantId === tenantId) && (!agentId || task.agentId === agentId) && (!conversationId || task.conversationId === conversationId)
      && (!channelId || task.channelId === channelId)) {
      task.reason ||= reason; task.controller.abort(); count++;
    }
    if (tenantId) this.tenants.add(tenantId);
    return count;
  }
  _abortConversation(tenantId, conversationId, reason, exceptMessageId = null) {
    for (const task of this.active.values()) if (task.tenantId === tenantId && task.conversationId === conversationId && (!exceptMessageId || task.messageId !== exceptMessageId)) {
      task.reason ||= reason; task.controller.abort();
    }
  }
  /** Job receipts of one company (no text). The caller enforces the administrative or inbox permission. */
  list(actor, tenantId, { conversationId, agentId, limit = 40 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail(400, 'Use um limite de 1 a 200 registros.');
    return jobsOf(this.store.tenant(actor, tenantId)).filter(job => (!conversationId || job.conversationId === conversationId) && (!agentId || job.agentId === agentId)).slice(-limit).reverse().map(summary);
  }
  /** Server lifecycle: startup recovery plus a periodic drain (lease recovery, deferred jobs, missed kicks). */
  start({ intervalMs = 5000 } = {}) {
    if (this.closed || this.interval) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 600000) throw new TypeError('Intervalo do piloto automático inválido.');
    this.recover();
    this.interval = setInterval(() => { this.flush(); this.drain().catch(error => this._log('error', 'Fila do piloto automático indisponível.', error)); }, intervalMs);
    this.interval.unref?.();
  }
  /** Stops intake, timers and bus subscriptions, interrupts running work and waits for it. Call before store.close(). */
  close() {
    this.closed = true; this.incoming.clear(); this.claimFailures.clear();
    clearInterval(this.interval); this.interval = null; clearTimeout(this.wakeTimer); this.wakeTimer = null;
    for (const detach of [...this.detachers]) { try { detach(); } catch { /* A closed bus has no subscribers left. */ } }
    for (const task of this.active.values()) { task.reason ||= 'shutdown'; task.controller.abort(); }
    return Promise.allSettled([...this.tasks]);
  }
}
