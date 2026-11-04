import { h, t, labels, getLocale } from './i18n.js';
import './locales-shell.js';
import './locales-agent-detail-recovery.js';
import { AGENT_INSTRUCTION_TEMPLATES } from './locales-agents-hub.js';
import { button, badge, avatar, tabs, tabPanel, segmented, emptyState, banner, toasts, attributes } from './ui.js';
import { formatHash, parseHash } from './router.js';
import { conversationHash } from './nav-config.js';
import { toolsForCapabilities, mcpServerLabel } from './mcp-catalog.js';
import { formatNumber, formatCompact } from './agent-usage-ui.js';

// Agent detail (#agents/<agentId>[/<tab>], FRONTEND-V2 §5.3.2, §8.6). Owned by P5. Drawn inside the
// agents hub (agents-hub-ui.js routes every #agents/<id>… here); eight tabs with deep links:
// Visão geral · Instruções · Ferramentas · Conhecimento · Memória · Acesso · Uso · Atividade.
//
// - Instruções: editor of agent.instructions with templates (Vendas, Suporte, Cobrança, Vazio),
//   section shortcuts, counter (limit 4.000, src/agent-runtime.js AGENT_INSTRUCTION_LIMIT), CAS by
//   agent.version (PATCH agents/:id {version, instructions}); a 409 keeps the text and offers
//   "Ver diferença" (side-by-side line diff), "Manter a minha" and "Descartar a minha". Leaving with
//   unsaved text asks first (links, menu, reload); the draft also survives re-renders in memory.
//   "Testar" exists only with the server feature 'agent-preview' (POST …/preview never records).
// - Ferramentas: toolPolicy segmented ('auto_readonly' | 'approve_all') saved with the same CAS;
//   the 5 internal read-only lookups with "Automática"/"Com aprovação"; tools of external servers
//   are always "Sempre requer aprovação" (a remote server cannot declare itself read-only).
// - Acesso: connected (MCP) agents list their service identities and the elozi_* tools those
//   capabilities unlock (mcp-catalog.js, P6); managed copilots say who triggers them and hold the
//   "Piloto automático" (agent.autopilot, src/agent-autopilot.js), saved through the same PATCH when
//   the server announces it (feature 'agent-autopilot' or the field on the agent), read-only "em breve" otherwise.
// The engine name ("Hermes") is shown only to the platform owner; everything an administrator may
// not do is hidden or disabled with the reason, never left to fail on the server.

const INSTRUCTIONS_LIMIT = 4000;
const PROFILE_FILE_BYTES = 16 * 1024;
const profileControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/** Local text import only: no native Hermes files, executable markup or network access. */
export async function readAgentInstructionFile(file) {
  if (!file || typeof file.name !== 'string' || !/\.(md|txt)$/i.test(file.name) || file.name.length > 240 || /[\x00-\x1f\x7f]/.test(file.name)
    || !['', 'text/plain', 'text/markdown', 'text/x-markdown'].includes((file.type || '').toLowerCase().split(';')[0].trim()) || typeof file.arrayBuffer !== 'function') throw new Error(t('Escolha um arquivo TXT ou MD de texto UTF-8.'));
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > PROFILE_FILE_BYTES) throw new Error(t('Use um arquivo de até 16 KiB. Para conteúdo maior, abra a Base de conhecimento.'));
  const buffer = await file.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== file.size || buffer.byteLength > PROFILE_FILE_BYTES) throw new Error(t('Não foi possível ler este arquivo de texto com segurança.'));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\r\n?/g, '\n'); }
  catch { throw new Error(t('O arquivo precisa ser texto UTF-8, sem conteúdo binário.')); }
  if (!text.trim() || profileControls.test(text)) throw new Error(t('O arquivo precisa ser texto UTF-8, sem conteúdo binário.'));
  if (text.length > INSTRUCTIONS_LIMIT) throw new Error(t('As instruções excedem 4.000 caracteres. Abra a Base de conhecimento para conteúdo maior; nada foi cortado.'));
  return text;
}

/** Whitelist the visible profile fields; never serialize the agent or tenant object. */
export function agentProfileMarkdown(agent, instructions) {
  const name = typeof agent?.name === 'string' ? agent.name : '', description = typeof agent?.description === 'string' ? agent.description : '';
  if (typeof instructions !== 'string' || instructions.length > INSTRUCTIONS_LIMIT || name.length > 48 || description.length > 200
    || [name, description, instructions].some(value => profileControls.test(value)) || /[\r\n\t]/.test(name + description)) throw new Error(t('Confira o nome, a descrição e as instruções antes de exportar.'));
  return `# ${t('Perfil do agente')}\n\n## ${t('Nome')}\n${name}\n\n## ${t('Descrição')}\n${description}\n\n## ${t('Instruções')}\n${instructions}\n`;
}
// A projection describes permissions, never listener liveness or delivery.
const RESPONSE_POLICY_MAX_AGE = 30_000;
const principalStamp = item => JSON.stringify([item?.id, item?.agentId, item?.state, item?.active, item?.revision, item?.keyRevision, item?.expiresAt, [...(item?.capabilities || [])].sort()]);
function verifiedResponsePolicy(agent, principal, record, now = Date.now()) {
  if (!record || now - record.at > RESPONSE_POLICY_MAX_AGE || now < record.at || record.agentStamp !== JSON.stringify([agent.id, agent.version, agent.provider, agent.mode, agent.configured])
    || agent.provider !== 'mcp' || agent.mode !== 'copilot' || agent.configured !== true
    || principal.state !== 'active' || principal.active === false || !(Date.parse(principal.expiresAt) > now)) return null;
  const source = record.principals?.find(item => item.id === principal.id);
  const policy = record.responsePolicies?.[principal.id], caps = new Set(principal.capabilities || []);
  if (!source || principalStamp(source) !== principalStamp(principal) || source.agentId !== agent.id || policy?.version !== 2 || policy.adapterMode !== agent.mode) return null;
  const privateSend = caps.has('reply.send'), drafts = caps.has('reply.submit'), groups = policy.groups;
  if (!groups || typeof groups.blockedByConversationPolicy !== 'boolean'
    || groups.sendCapable !== (privateSend && !groups.blockedByConversationPolicy)
    || groups.scheduleCapable !== (caps.has('message.schedule') && !groups.blockedByConversationPolicy)
    || policy.privateReplies?.capable !== privateSend || policy.privateReplies.requiresAgentAssignment !== true || policy.privateReplies.requiresPerMessageApproval !== false
    || policy.drafts?.submitCapable !== drafts || policy.drafts.draftCapable !== false || policy.drafts.requiresHumanSend !== true) return null;
  const mode = privateSend ? 'autonomous' : drafts ? 'copilot' : groups.sendCapable || groups.scheduleCapable ? 'direct-actions' : 'read-only';
  const human = mode === 'copilot';
  return policy.effectiveMode === mode && policy.humanApprovalRequired === human
    && policy.requiresConversationAuthorization === human && policy.requiresHumanConversationAuthorization === human
    && policy.requiresServerConversationAuthorization === true ? policy : null;
}
function responsePolicyMarkup(policy) {
  if (!policy) return h`<p class="pg-agents__muted" data-response-mode="unverified">${t('Autonomia não verificada: projeção atual v2 indisponível ou incompatível.')}</p>`;
  const label = { autonomous: t('Autônomo · sem aprovação por mensagem'), copilot: t('Copiloto · rascunho com envio humano'), 'read-only': t('Somente leitura'), 'direct-actions': t('Ações diretas · sem resposta privada') }[policy.effectiveMode];
  return h`<div data-response-mode="${policy.effectiveMode}"><p><strong>${label}</strong></p><p class="pg-agents__muted">${t('Adaptador MCP: copilot (compatibilidade). O modo efetivo não altera o modo salvo.')}</p>${policy.privateReplies.capable ? h`<p>${t('Pode responder sem revisão por mensagem nas conversas atribuídas e autorizadas. Cada ação ainda depende da autorização do servidor.')}</p>` : ''}${policy.drafts.submitCapable ? h`<p>${t('Rascunhos: envio humano. Entregar um rascunho não envia a mensagem.')}</p>` : ''}<p class="pg-agents__muted" data-response-groups="${policy.groups.blockedByConversationPolicy ? 'blocked' : 'conditional'}">${policy.groups.blockedByConversationPolicy ? t('Grupos bloqueados pela política da conversa, mesmo com capacidade de envio ou agendamento.') : t('Grupos: envio e agendamento dependem das capacidades, da seleção e da autorização atual do servidor.')}</p><p class="pg-agents__muted">${t('Permissão não comprova listener ativo nem mensagem entregue. Assumir a conversa interrompe o agente; os limites de resposta continuam valendo.')}</p></div>`;
}
const MAX_AUTOMATIC_LOOKUPS = 3;
const INTERNAL_SERVER = 'elozi-internal';
/** The 5 internal read-only lookups (src/mcp.js), in the order of the spec. */
export const INTERNAL_TOOLS = Object.freeze(['elozi_knowledge_search', 'elozi_contact_profile', 'elozi_conversation_history', 'elozi_channel_status', 'elozi_attendance_status']);
const INTERNAL_LABELS = labels({ elozi_knowledge_search: 'Busca na base de conhecimento', elozi_contact_profile: 'Ficha do contato', elozi_conversation_history: 'Mensagens anteriores da conversa', elozi_channel_status: 'Situação do canal', elozi_attendance_status: 'Situação do atendimento' });
export const DETAIL_TABS = Object.freeze(['overview', 'instructions', 'tools', 'knowledge', 'memory', 'access', 'usage', 'activity']);
const TAB_LABELS = labels({ overview: 'Visão geral', instructions: 'Instruções', tools: 'Ferramentas', knowledge: 'Conhecimento', memory: 'Memória', access: 'Acesso', usage: 'Uso', activity: 'Atividade' });
const TEMPLATE_LABELS = labels({ sales: 'Vendas', support: 'Suporte', billing: 'Cobrança' });
const SECTION_LABELS = labels({ role: 'Papel', tone: 'Tom', rules: 'Regras do negócio', never: 'Nunca faça', examples: 'Exemplos' });
const CHANNEL_KINDS = labels({ whatsapp_qr: 'WhatsApp · QR Code', whatsapp_cloud: 'WhatsApp · Cloud API', telegram: 'Telegram', instagram: 'Instagram', messenger: 'Messenger', webchat: 'Webchat', email: 'E-mail' });
const selectorValue = value => String(value ?? '').replace(/["\\]/g, '\\$&');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const dateOf = value => { const time = Date.parse(value); return Number.isFinite(time) ? time : null; };

// ------------------------------------------------------------------------------------------------
// Agent model (shared with the hub list)

/** managed = copilot run by the platform (provider hermes); connected = own agent over MCP; planned = adapters that do not run yet. */
export const agentKind = agent => agent?.provider === 'hermes' ? 'managed' : agent?.provider === 'mcp' ? 'connected' : 'planned';
const PLANNED_NAMES = { claude: 'Claude', codex: 'Codex', webhook: 'API / webhook' };

/** "Copiloto gerenciado" / "Agente conectado (MCP)" / "<Provedor> · em breve"; the engine only for the platform owner. */
export function kindLabel(agent, { owner = false } = {}) {
  const kind = agentKind(agent);
  if (kind === 'managed') return owner ? t('Copiloto gerenciado · Hermes') : t('Copiloto gerenciado');
  if (kind === 'connected') return t('Agente conectado (MCP)');
  return t('{provider} · em breve', { provider: PLANNED_NAMES[agent?.provider] || t('Integração') });
}

/** Health from agent.health {level, reason, since} when the server sends it; otherwise only facts the DTO states. */
export function healthOf(agent) {
  const health = plain(agent?.health) ? agent.health : null;
  if (health && ['ok', 'degraded', 'down'].includes(health.level)) {
    const tone = { ok: 'success', degraded: 'warning', down: 'danger' }[health.level];
    const label = { ok: t('Saudável'), degraded: t('Atenção'), down: t('Fora do ar') }[health.level];
    return { tone, label, reason: typeof health.reason === 'string' ? health.reason : '', since: health.since || null };
  }
  const kind = agentKind(agent);
  if (kind === 'managed' && agent.configured !== true) return { tone: 'warning', label: t('Configuração pendente'), reason: t('O serviço do copiloto ainda não foi configurado.'), since: null };
  if (kind === 'planned') return { tone: 'neutral', label: t('Em breve'), reason: t('Este provedor ainda não executa nesta versão.'), since: null };
  return null;
}

/** Tool policy of a managed copilot (absent = the default auto_readonly, as src/agent-runtime.js toolPolicyOf). */
export const policyOf = agent => agent?.toolPolicy === undefined || agent?.toolPolicy === null || agent?.toolPolicy === 'auto_readonly' ? 'auto_readonly' : 'approve_all';
export const policyLabel = policy => policy === 'auto_readonly' ? t('Consultas automáticas') : t('Aprovar cada uso');

/** Autopilot configuration in the DTO, normalized for display (never sent back as is). */
export function autopilotOf(agent) {
  const value = plain(agent?.autopilot) ? agent.autopilot : null;
  if (!value) return null;
  const quiet = plain(value.quietHours) && TIME.test(value.quietHours.start) && TIME.test(value.quietHours.end) && typeof value.quietHours.timezone === 'string' ? { timezone: value.quietHours.timezone, start: value.quietHours.start, end: value.quietHours.end } : null;
  return { enabled: value.enabled === true, channelIds: Array.isArray(value.channelIds) ? value.channelIds.filter(id => typeof id === 'string') : [], maxRepliesPerHour: Number.isSafeInteger(value.maxRepliesPerHour) ? value.maxRepliesPerHour : 6, requireKnowledge: value.requireKnowledge !== false, quietHours: quiet, handoffDepartmentId: typeof value.handoffDepartmentId === 'string' ? value.handoffDepartmentId : null };
}

/** "há 3 min" (relative) for a date, or '' without one. */
export function relativeTime(value, now = Date.now()) {
  const time = dateOf(value);
  if (time === null) return '';
  const seconds = Math.round((time - now) / 1000), format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(seconds, 'second');
}
const absoluteTime = value => { const time = dateOf(value); return time === null ? '' : new Date(time).toLocaleString(getLocale()); };

// ------------------------------------------------------------------------------------------------
// Line diff (409 of the instructions)

/**
 * Side-by-side line diff of two texts (LCS). Rows: {type:'same'|'del'|'add'|'change', left, right};
 * a removed line followed by an added one becomes one 'change' row.
 */
export function lineDiff(before, after) {
  const a = String(before ?? '').split('\n'), b = String(after ?? '').split('\n'), n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ type: 'same', left: a[i++], right: b[j++] }); continue; }
    // Removed lines first on ties, so a replaced block pairs as 'change' rows below.
    if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ type: 'del', left: a[i++], right: null });
    else ops.push({ type: 'add', left: null, right: b[j++] });
  }
  const rows = [];
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (op.type === 'del') {
      let end = index; while (end < ops.length && ops[end].type === 'del') end++;
      let adds = end; while (adds < ops.length && ops[adds].type === 'add') adds++;
      const removed = ops.slice(index, end), added = ops.slice(end, adds);
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        const left = removed[k]?.left ?? null, right = added[k]?.right ?? null;
        rows.push({ type: left !== null && right !== null ? 'change' : left !== null ? 'del' : 'add', left, right });
      }
      index = adds - 1;
    } else rows.push(op);
  }
  return rows;
}

function diffTable(rows, { theirsVersion }) {
  const cell = (value, side, type) => value === null ? h`<td class="pg-agents__diff-cell" data-side="${side}"></td>` : h`<td class="pg-agents__diff-cell" data-side="${side}">${type === 'same' ? '' : h`<span class="sr-only">${side === 'left' ? t('Só na versão salva:') : t('Só na sua versão:')} </span>`}${value || ' '}</td>`;
  return h`<div class="pg-agents__table-wrap"><table class="pg-agents__diff"><caption class="sr-only">${t('Diferença linha a linha entre a versão salva e a sua')}</caption><thead><tr><th scope="col">${theirsVersion ? t('Versão salva (v{version})', { version: theirsVersion }) : t('Versão salva')}</th><th scope="col">${t('Sua versão')}</th></tr></thead><tbody>${rows.map(row => h`<tr data-diff="${row.type}">${cell(row.left, 'left', row.type)}${cell(row.right, 'right', row.type)}</tr>`)}</tbody></table></div>`;
}

// ------------------------------------------------------------------------------------------------
// Activity (tenant.runs; shared with the hub tab Atividade)

const RUN_STATES = labels({ queued: 'Na fila', running: 'Preparando', tool_running: 'Consultando', waiting_approval: 'Aguardando aprovação', draft: 'Rascunho pronto', failed: 'Falhou', cancelled: 'Cancelado', rejected: 'Recusado', invalidated: 'Invalidado', tool_unknown: 'Sem confirmação', completed: 'Concluído', expired: 'Expirado' });
const RUN_TONES = { queued: 'agent', running: 'agent', tool_running: 'agent', waiting_approval: 'warning', draft: 'success', failed: 'danger', cancelled: 'neutral', rejected: 'neutral', invalidated: 'neutral', tool_unknown: 'danger', completed: 'success', expired: 'neutral' };
/** Outcome of a run (runOutcome of src/agent-runtime.js, agent-runs feed): adoption comes from sourceRunId. */
const OUTCOMES = labels({ used: 'Usado', edited: 'Editado', stale: 'Desatualizado', discarded: 'Descartado', rejected: 'Recusado', failed: 'Falhou' });
const RESTING = new Set(['draft', 'failed', 'invalidated', 'cancelled', 'rejected', 'tool_unknown']);
const runTime = run => dateOf(run.startedAt) ?? dateOf(run.createdAt) ?? dateOf(run.updatedAt) ?? 0;
/** Runs of the company (or of one agent), newest first. */
export const activityRuns = (runs, agentId = null) => (Array.isArray(runs) ? runs : []).filter(run => run && (!agentId || run.agentId === agentId)).sort((left, right) => runTime(right) - runTime(left));
/** Autopilot runs: initiator 'autopilot' in the feed, id 'autopilot_*' in tenant.runs (src/agent-runtime.js runInitiator). */
const autopilotRun = run => run.initiatorKind === 'autopilot' || run.autopilot === true || typeof run.id === 'string' && run.id.startsWith('autopilot_');
/** Milliseconds from start to rest: the feed's latencyMs, or the same rule over tenant.runs; null while running or unknown. */
export function latencyOf(run) {
  if (!RESTING.has(run.state)) return null;
  if (Number.isFinite(run.latencyMs) && run.latencyMs >= 0) return run.latencyMs;
  const start = dateOf(run.startedAt), end = dateOf(run.completedAt);
  return start !== null && end !== null && end >= start ? end - start : null;
}
const seconds = ms => (ms / 1000).toLocaleString(getLocale(), { maximumFractionDigits: 1 });

function trigger(run) {
  if (autopilotRun(run)) return t('Piloto automático');
  if (run.initiatorKind === 'service') return t('Serviço · {name}', { name: run.actorName || t('agente conectado') });
  if (run.supportAssistantId || run.initiatorKind === 'support') return t('Assistente de suporte');
  return run.actorName ? t('Pessoa · {name}', { name: run.actorName }) : t('Pessoa');
}

function timeline(run) {
  const items = [];
  const add = (when, text, tone = 'neutral') => items.push({ when, text, tone });
  add(run.startedAt || run.createdAt, t('Pedido aceito · {who}', { who: trigger(run) }));
  for (const step of Array.isArray(run.toolSteps) ? run.toolSteps : []) add(step.completedAt, step.autoApproved === true ? t('Consulta automática · {tool}', { tool: step.title || step.toolName || '' }) : t('Ferramenta aprovada por pessoa · {tool}', { tool: step.title || step.toolName || '' }), step.isError ? 'danger' : 'agent');
  if (run.state === 'waiting_approval' && run.toolProposal) add(run.updatedAt, t('Proposta aguardando decisão · {tool}', { tool: run.toolProposal.title || run.toolProposal.toolName || '' }), 'warning');
  if (run.state === 'draft') add(run.updatedAt, t('Rascunho pronto para revisão'), 'success');
  if (run.stale === true) add(run.staleSince, t('Novas mensagens do cliente depois do rascunho'), 'warning');
  if (['failed', 'cancelled', 'invalidated', 'tool_unknown'].includes(run.state)) add(run.cancelledAt || run.updatedAt, run.reason || RUN_STATES[run.state], RUN_TONES[run.state]);
  return h`<ol class="pg-agents__timeline">${items.map(item => h`<li data-tone="${item.tone}"><span class="pg-agents__num pg-agents__muted">${absoluteTime(item.when) || '—'}</span> ${item.text}</li>`)}</ol>`;
}

/**
 * Table of agent runs: Quando · (Agente) · Conversa (deep link) · Gatilho · Estado · Consultas n/3 ·
 * Tokens (administrators) · Latência · Desfecho. Each row opens its chronology. Latency comes from the
 * feed (latencyMs) or start → rest of the run; the outcome only from the agent-runs feed. Without a
 * value the cell is "—" with the reason, never a guess.
 */
export function activityTable(runs, { admin = false, tenant = null, showAgent = false, limit = 50, now = Date.now() } = {}) {
  const list = runs.slice(0, limit);
  if (!list.length) return emptyState({ icon: 'activity', title: t('Nenhuma execução carregada'), body: t('As execuções aparecem aqui quando alguém aciona um agente nas conversas desta empresa.'), level: 3 });
  const conversations = new Map((tenant?.conversations || []).map(conversation => [conversation.id, conversation]));
  const head = h`<thead><tr><th scope="col">${t('Quando')}</th>${showAgent ? h`<th scope="col">${t('Agente')}</th>` : ''}<th scope="col">${t('Conversa')}</th><th scope="col">${t('Gatilho')}</th><th scope="col">${t('Estado')}</th><th scope="col">${t('Consultas')}</th>${admin ? h`<th scope="col">${t('Tokens')}</th>` : ''}<th scope="col">${t('Latência')}</th><th scope="col">${t('Desfecho')}</th><th scope="col"><span class="sr-only">${t('Cronologia')}</span></th></tr></thead>`;
  const columns = 8 + (showAgent ? 1 : 0) + (admin ? 1 : 0);
  const body = list.map(run => {
    const conversation = conversations.get(run.conversationId), lookups = (Array.isArray(run.toolSteps) ? run.toolSteps : []).filter(step => step.autoApproved === true).length;
    const link = tenant?.id && ID.test(String(run.conversationId || '')) ? conversationHash({ tenantId: tenant.id, conversationId: run.conversationId }) : null;
    const name = conversation?.contact || conversation?.name || t('Conversa');
    const state = Object.hasOwn(RUN_TONES, run.state) ? RUN_STATES[run.state] : String(run.state || '—');
    const tokens = Number.isSafeInteger(run.usage?.total_tokens) ? formatNumber(run.usage.total_tokens) : '—';
    const id = `agents-run-${String(run.id || '').replace(/[^A-Za-z0-9_-]/g, '')}`, latency = latencyOf(run);
    const latencyCell = latency !== null ? h`<td class="pg-agents__num">${t('{seconds} s', { seconds: seconds(latency) })}</td>` : h`<td title="${RESTING.has(run.state) ? t('Latência não informada') : t('Em andamento')}">—</td>`;
    const outcomeCell = Object.hasOwn(OUTCOMES, run.outcome) ? h`<td>${OUTCOMES[run.outcome]}</td>` : h`<td title="${Object.hasOwn(run, 'outcome') ? t('Sem desfecho registrado') : t('Medição de adoção em breve')}">—</td>`;
    return h`<tbody class="pg-agents__run"><tr><td><span class="pg-agents__num" title="${absoluteTime(runTime(run) ? new Date(runTime(run)).toISOString() : '')}">${relativeTime(runTime(run) ? new Date(runTime(run)).toISOString() : '', now) || '—'}</span></td>${showAgent ? h`<td>${run.agentName || t('Agente')}</td>` : ''}<td>${link ? h`<a class="pg-agents__link" href="${link}">${name}</a>` : name}</td><td>${trigger(run)}</td><td>${badge(state, RUN_TONES[run.state] || 'neutral')}${run.stale === true ? h` ${badge(t('Desatualizado'), 'warning')}` : ''}</td><td class="pg-agents__num">${lookups}/${MAX_AUTOMATIC_LOOKUPS}</td>${admin ? h`<td class="pg-agents__num">${tokens}</td>` : ''}${latencyCell}${outcomeCell}<td>${button({ label: t('Cronologia'), action: 'agents:toggle-run', size: 'sm', variant: 'ghost', attrs: { 'aria-expanded': 'false', 'aria-controls': id } })}</td></tr><tr id="${id}" class="pg-agents__run-detail" hidden><td colspan="${columns}">${timeline(run)}</td></tr></tbody>`;
  });
  return h`<div class="pg-agents__table-wrap"><table class="pg-agents__table pg-agents__table--activity">${head}${body}</table></div>`;
}

// ------------------------------------------------------------------------------------------------
// Screen

const AUTOPILOT_FIELDS = ['enabled', 'channelIds', 'maxRepliesPerHour', 'requireKnowledge', 'quietHours', 'handoffDepartmentId'];
const timeZones = () => {
  const own = (() => { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();
  return [...new Set([own, 'America/Sao_Paulo', 'America/Manaus', 'America/Fortaleza', 'America/Noronha', 'America/Rio_Branco', 'America/New_York', 'Europe/Lisbon', 'UTC'].filter(Boolean))];
};

/**
 * createAgentDetail(deps) → {view(route), act, submit, reset, mount, dirty}. deps: state; context()
 * (the hub's {admin, owner, features, scope}); request(path, options) and tenantPath(tail) (api of
 * app.js through mcp-ui); render() and refresh(); usage (agent-usage-ui); principals() (the
 * service-principals-ui screen: {summary, load}); grants {tools(agentId), knowledge(agentId)}
 * (the legacy grant dialogs of mcp-ui and knowledge-ui); navigate(view); runsFeed() → {items, error,
 * note} and loadRuns() (the hub's agent-runs feed; without them, tenant.runs).
 */
export function createAgentDetail(deps = {}) {
  const { state = {}, usage = null } = deps;
  const context = () => (typeof deps.context === 'function' ? deps.context() : null) || { admin: false, owner: false, features: new Set(), scope: '' };
  const request = (...args) => { if (typeof deps.request !== 'function') throw new Error(t('O painel ainda está carregando. Tente novamente em instantes.')); return deps.request(...args); };
  const tenantPath = tail => typeof deps.tenantPath === 'function' ? deps.tenantPath(tail) : `/api/tenants/${encodeURIComponent(state.tenant?.id || '')}${tail ? '/' + tail : ''}`;
  const rerender = () => { if (typeof deps.render === 'function') deps.render(); };
  const agents = () => Array.isArray(state.tenant?.agents) ? state.tenant.agents : [];
  const findAgent = id => agents().find(agent => agent.id === id) || null;
  // Editors keep unsaved text per company and agent (never in storage): re-renders, tab changes and
  // the back button do not lose it; leaving through the panel asks first.
  const editors = new Map(), autopilotDrafts = new Map(), previews = new Map(), searches = new Map(), responseProjections = new Map();
  // focus: caret of the instructions kept across a render; focusTarget: the control an action re-renders
  // (a full render of app.js replaces <main>; focus never falls back to <body>, §2.6).
  let route = null, focus = null, focusTarget = null, guardInstalled = false, profileGeneration = 0;
  const editorKey = agentId => `${context().scope}:${agentId}`;
  const resultContext = () => { const ctx = context(), session = state.boot?.session || {}; return JSON.stringify([ctx.scope, ctx.admin, state.workspaceId, state.tenant?.id, session.userId, session.role, state.supportGrantId || session.supportGrantId || null]); };
  const resultView = (agentId, tab) => ({ context: resultContext(), agentId, tab });
  const matchesResultRoute = (current, expected) => current?.section === 'agents' && current.params?.agentId === expected.agentId && (current.params.agentTab || 'overview') === expected.tab;
  function activeResultView(expected) {
    if (expected.context !== resultContext() || !matchesResultRoute(route, expected)) return false;
    // The detail's last route can remain after the hub or another screen replaces it.
    return typeof globalThis.location?.hash !== 'string' || matchesResultRoute(parseHash(globalThis.location.hash), expected);
  }
  const rerenderFocusing = selector => { focusTarget = selector; rerender(); };
  const areaSelector = agentId => `[data-agents-instructions="${selectorValue(agentId)}"]`;
  /** {items, error, note} of the hub's agent-runs feed; items null = tenant.runs. */
  const feed = () => (typeof deps.runsFeed === 'function' ? deps.runsFeed() : null) || { items: null, error: null, note: t('Execuções carregadas nesta empresa; o histórico completo chega em breve.') };
  const runsOf = agentId => activityRuns(feed().items || state.tenant?.runs, agentId);

  function editorOf(agent) {
    const key = editorKey(agent.id), saved = typeof agent.instructions === 'string' ? agent.instructions : '', version = Number.isSafeInteger(agent.version) ? agent.version : 1;
    let editor = editors.get(key);
    if (!editor) editors.set(key, editor = { agentId: agent.id, base: saved, baseVersion: version, draft: saved, conflict: null, showDiff: false, saving: false, leave: null, previous: null });
    else if (editor.draft === editor.base && !editor.conflict && !editor.saving && (editor.base !== saved || editor.baseVersion !== version)) Object.assign(editor, { base: saved, draft: saved, baseVersion: version });
    return editor;
  }
  const dirtyEditor = editor => Boolean(editor) && editor.draft !== editor.base;
  /** The editor with unsaved text on screen, if any (leave guard). */
  function dirty() {
    if (!route?.params?.agentId) return null;
    const tab = route.params.agentTab || 'overview';
    if (!['instructions', 'access'].includes(tab)) return null;
    const editor = (tab === 'access' ? autopilotDrafts : editors).get(editorKey(route.params.agentId));
    // Only while the editor is on screen: after the back button the route here is stale.
    const form = globalThis.document?.querySelector?.(`form[data-form="agents:${tab === 'access' ? 'autopilot' : 'instructions'}"][data-id="${selectorValue(route.params.agentId)}"]`);
    return (tab === 'access' ? Boolean(editor) : dirtyEditor(editor)) && form?.isConnected !== false && form ? editor : null;
  }

  // ---- header and tabs ------------------------------------------------------------------------

  function header(agent, ctx) {
    const health = healthOf(agent), autopilot = autopilotOf(agent);
    return h`<div class="pg-agents__detail-head"><a class="pg-agents__back" href="#agents">${t('‹ Agentes')}</a><div class="pg-agents__identity">${avatar({ kind: 'agent', name: agent.name, size: 40 })}<div><h1 class="pg-agents__h1">${agent.name || t('Agente sem nome')}</h1><p class="pg-agents__muted">${kindLabel(agent, ctx)}${agent.description ? h` · ${agent.description}` : ''}</p></div><div class="pg-agents__chips">${health ? badge(health.label, health.tone) : ''}${autopilot?.enabled ? badge(t('Piloto automático'), 'agent') : ''}</div></div></div>`;
  }

  function view(current) {
    route = current;
    const ctx = context(), agent = findAgent(current?.params?.agentId);
    if (!agent) return String(h`<div class="pg-agents pg-agents--detail"><h1 class="pg-agents__h1">${t('Agente não encontrado')}</h1><p class="pg-agents__muted">${t('Ele pode ter sido removido ou pertencer a outra empresa.')}</p><a class="pg-agents__link" href="#agents">${t('Voltar para Agentes')}</a></div>`);
    const tab = DETAIL_TABS.includes(current.params.agentTab) ? current.params.agentTab : 'overview';
    captureFocus();
    const items = DETAIL_TABS.map(id => ({ id, label: TAB_LABELS[id], href: formatHash({ section: 'agents', params: { agentId: agent.id, agentTab: id } }) }));
    const content = { overview, instructions, tools, knowledge, memory, access, usage: usageTab, activity }[tab](agent, ctx);
    return String(h`<div class="pg-agents pg-agents--detail" data-agent="${agent.id}">${header(agent, ctx)}${tabs({ id: 'agent-detail', label: t('Seções do agente'), active: tab, items })}${tabPanel({ tabsId: 'agent-detail', id: tab, active: true, focusable: false, content })}</div>`);
  }

  // ---- Visão geral ----------------------------------------------------------------------------

  /** Card "Últimos 7 dias" (administrators): the totals, or the usage report's loading, error or "em breve". */
  function overviewUsage(agent, ctx) {
    if (!ctx.admin) return '';
    const recent = usage?.agentRecent?.(agent.id, 7);
    const body = recent ? h`<dl class="pg-agents__kv"><dt>${t('Execuções')}</dt><dd class="pg-agents__num">${formatNumber(recent.runs)}</dd><dt>${t('Tokens')}</dt><dd class="pg-agents__num">${formatCompact(recent.total)}</dd></dl>` : typeof usage?.pendingNote === 'function' ? usage.pendingNote() : h`<p class="pg-agents__muted">${t('Medição disponível em breve.')}</p>`;
    return h`<section class="pg-agents__card" data-agents-slot="overview-usage"><h2 class="pg-agents__h2">${t('Últimos 7 dias')}</h2>${body}<a class="pg-agents__link" href="${formatHash({ section: 'agents', params: { agentId: agent.id, agentTab: 'usage' } })}">${t('Ver uso')}</a></section>`;
  }

  function recentRuns(agent, ctx) {
    return h`<section class="pg-agents__card" data-agents-slot="agent-runs"><div class="pg-agents__section-head"><h2 class="pg-agents__h2">${t('Últimas execuções')}</h2><a class="pg-agents__link" href="${formatHash({ section: 'agents', params: { agentId: agent.id, agentTab: 'activity' } })}">${t('Ver atividade')}</a></div>${activityTable(runsOf(agent.id), { admin: ctx.admin, tenant: state.tenant, limit: 5 })}</section>`;
  }

  function overview(agent, ctx) {
    const health = healthOf(agent), kind = agentKind(agent);
    const service = kind === 'managed' && ctx.admin ? h`<div class="pg-agents__actions">${button({ label: agent.configured ? t('Ajustar serviço') : t('Configurar serviço'), action: 'configure-agent', size: 'sm', attrs: { 'data-id': agent.id } })}${agent.configured ? button({ label: t('Verificar serviço'), action: 'test-agent', size: 'sm', variant: 'ghost', attrs: { 'data-id': agent.id } }) : ''}</div>` : '';
    const healthCard = h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Saúde')}</h2>${health ? h`<p>${badge(health.label, health.tone)} ${health.reason}</p>${health.since ? h`<p class="pg-agents__muted">${t('Desde {when}', { when: absoluteTime(health.since) })}</p>` : ''}` : h`<p class="pg-agents__muted" title="${t('Medição de saúde em breve')}">—</p>`}${agent.serviceCheckedAt ? h`<p class="pg-agents__muted">${t('Serviço verificado {when}', { when: relativeTime(agent.serviceCheckedAt) })}</p>` : ''}${service}</section>`;
    const autopilot = autopilotOf(agent);
    const autopilotCard = kind === 'managed' ? h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Piloto automático')}</h2><p>${autopilot?.enabled ? t('Ativo em {count} canal(is).', { count: autopilot.channelIds.length }) : t('Desligado: o copiloto só prepara rascunhos para a equipe revisar.')}</p><a class="pg-agents__link" href="${formatHash({ section: 'agents', params: { agentId: agent.id, agentTab: 'access' } })}">${t('Configurar piloto automático')}</a></section>` : '';
    return h`<div class="pg-agents__grid">${healthCard}${overviewUsage(agent, ctx)}${autopilotCard}</div>${recentRuns(agent, ctx)}`;
  }

  // ---- Instruções -----------------------------------------------------------------------------

  function counter(length, limit = INSTRUCTIONS_LIMIT) {
    return t('{count} / {limit} caracteres', { count: formatNumber(length), limit: formatNumber(limit) });
  }
  function statusText(editor) {
    if (editor.saving) return t('Salvando…');
    if (editor.conflict) return t('Conflito: alguém salvou antes de você');
    return dirtyEditor(editor) ? t('Alterações não salvas') : t('Salvo · v{version}', { version: editor.baseVersion });
  }

  function conflictBox(editor) {
    if (!editor.conflict) return '';
    const actions = h`<div class="pg-agents__actions">${button({ label: editor.showDiff ? t('Ocultar diferença') : t('Ver diferença'), action: 'agents:instructions-diff', size: 'sm', attrs: { 'data-id': editor.agentId, 'aria-expanded': editor.showDiff ? 'true' : 'false' } })}${button({ label: t('Manter a minha'), action: 'agents:instructions-keep', size: 'sm', variant: 'primary', attrs: { 'data-id': editor.agentId } })}${button({ label: t('Descartar a minha'), action: 'agents:instructions-take', size: 'sm', variant: 'danger', attrs: { 'data-id': editor.agentId } })}</div>`;
    return h`<div class="pg-agents__conflict" role="alert">${banner({ tone: 'warning', title: t('Alguém salvou antes de você.'), body: t('Seu texto continua no editor. Compare, mantenha a sua versão ou adote a versão salva.') })}${actions}${editor.showDiff ? diffTable(lineDiff(editor.conflict.text, editor.draft), { theirsVersion: editor.conflict.version }) : ''}</div>`;
  }

  function leaveBox(editor) {
    if (!editor.leave) return '';
    return h`<div class="pg-agents__leave" role="alertdialog" aria-labelledby="agents-leave-title" tabindex="-1" data-agents-leave><p id="agents-leave-title"><strong>${t('Descartar alterações?')}</strong> ${editor.tab === 'access' ? t('O piloto automático tem alterações que ainda não foram salvas.') : t('As instruções têm alterações que ainda não foram salvas.')}</p><div class="pg-agents__actions">${button({ label: t('Continuar editando'), action: 'agents:leave-cancel', size: 'sm', attrs: { 'data-id': editor.agentId } })}${button({ label: t('Descartar e sair'), action: 'agents:leave-discard', size: 'sm', variant: 'danger', attrs: { 'data-id': editor.agentId } })}</div></div>`;
  }

  function testPanel(agent, ctx, editor) {
    if (!ctx.features.has('agent-preview')) return h`<section class="pg-agents__card" data-state="soon"><h2 class="pg-agents__h2">${t('Testar com uma conversa')}</h2><p class="pg-agents__muted">${t('Teste sem gravar: em breve. Até lá, acione o copiloto em uma conversa real; nada é enviado sem revisão.')}</p></section>`;
    const conversations = (state.tenant?.conversations || []).filter(conversation => conversation?.id).slice(0, 50), cached = previews.get(editorKey(agent.id)), result = cached?.context === resultContext() ? cached : null;
    return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Testar com uma conversa')}</h2><form class="pg-agents__form" data-form="agents:preview" data-id="${agent.id}"><label class="pg-agents__field"><span class="pg-agents__label">${t('Conversa')}</span><select class="pg-agents__control" name="conversationId" required>${conversations.map(conversation => h`<option value="${conversation.id}"${attributes({ selected: conversation.id === editor.previewConversationId })}>${conversation.contact || conversation.name || conversation.id}</option>`)}</select></label>${button({ label: t('Gerar rascunho de teste'), type: 'submit', variant: 'secondary', icon: 'spark', busy: result?.loading === true, disabled: !conversations.length || editor.draft.length > INSTRUCTIONS_LIMIT || editor.fileReviewRequired })}<p class="pg-agents__muted">${editor.fileReviewRequired?t('Revise e salve as instruções importadas antes de testar o agente.'):t('Usa o texto do editor, não grava nada na conversa e consome a cota do dia.')}</p></form><div data-agents-slot="preview" aria-live="polite">${previewResult(result)}</div></section>`;
  }

  function previewResult(result) {
    if (!result || result.loading) return result?.loading ? h`<p class="pg-agents__muted" role="status">${t('Preparando o rascunho de teste…')}</p>` : '';
    if (result.error) return h`<p class="pg-agents__error">${result.error}</p>`;
    const data = result.data || {};
    const steps = Array.isArray(data.toolSteps) ? data.toolSteps : [], references = Array.isArray(data.references) ? data.references : [];
    // wouldPropose: tools the agent asked for; the preview never runs them (src/agent-runtime.js preview).
    const proposals = (Array.isArray(data.wouldPropose) ? data.wouldPropose : []).filter(plain);
    // tokens null = the provider did not report usage: said so, never a zero.
    const tokens = plain(data.tokens) && (Number.isFinite(Number(data.tokens.input)) || Number.isFinite(Number(data.tokens.output))) ? (Number(data.tokens.input) || 0) + (Number(data.tokens.output) || 0) : null;
    const latency = Number.isFinite(Number(data.latencyMs)) && data.latencyMs !== null ? seconds(Number(data.latencyMs)) : '—';
    const proposed = proposals.length ? h`<ul class="pg-agents__list">${proposals.map(item => h`<li>${t('Pediria a ferramenta {tool}', { tool: [mcpServerLabel(item.serverName), item.title || item.toolName].filter(Boolean).join(' › ') || t('sem nome') })}${item.external === true ? h` ${badge(t('Sempre requer aprovação'), 'warning')}` : ''}</li>`)}</ul><p class="pg-agents__muted">${t('Na prévia nenhuma ferramenta é executada: o rascunho foi escrito sem consultá-las.')}</p>` : '';
    return h`<div class="pg-agents__preview">${steps.length ? h`<p class="pg-agents__muted">${t('Consultou {count} ferramenta(s)', { count: steps.length })}</p>` : ''}${references.length ? h`<p class="pg-agents__muted">${t('Consultou o conhecimento ({count})', { count: references.length })}</p>` : ''}${proposed}<blockquote class="pg-agents__draft">${typeof data.draft === 'string' && data.draft ? data.draft : t('O agente não produziu um rascunho.')}</blockquote><p class="pg-agents__muted pg-agents__num">${tokens === null ? t('tokens não informados pelo provedor · {seconds} s · não gravado', { seconds: latency }) : t('{tokens} tokens · {seconds} s · não gravado', { tokens: formatNumber(tokens), seconds: latency })}</p></div>`;
  }

  function instructions(agent, ctx) {
    const kind = agentKind(agent);
    if (kind === 'connected') return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Instruções')}</h2><p>${t('As instruções deste agente ficam no seu próprio cliente (por exemplo, no prompt de sistema). A plataforma entrega o contexto autorizado e recebe os rascunhos para revisão.')}</p></section>`;
    if (kind === 'planned') return h`<section class="pg-agents__card" data-state="soon"><h2 class="pg-agents__h2">${t('Instruções')}</h2><p class="pg-agents__muted">${t('Este provedor ainda não executa nesta versão. As instruções ficam disponíveis quando ele for ativado.')}</p></section>`;
    if (!ctx.admin) return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Instruções')}</h2>${agent.instructions ? h`<pre class="pg-agents__pre" tabindex="0">${agent.instructions}</pre>` : h`<p class="pg-agents__muted">${t('Sem instruções próprias: o copiloto usa as regras padrão da plataforma.')}</p>`}<p class="pg-agents__muted">${t('Somente a administração do workspace altera as instruções.')}</p></section>`;
    const editor = editorOf(agent), id = `agent-instructions-${agent.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
    const files = h`<div class="pg-agents__toolbar" role="group" aria-label="${t('Arquivos de instruções')}">${button({ label: t('Importar TXT / MD'), action: 'agents:instructions-import', size: 'sm', variant: 'secondary', disabled: dirtyEditor(editor) || editor.saving, attrs: { 'data-id': agent.id, 'data-agents-import': '' } })}${button({ label: t('Exportar perfil Markdown'), action: 'agents:instructions-export', size: 'sm', variant: 'ghost', disabled: editor.saving, attrs: { 'data-id': agent.id } })}${button({ label: t('Copiar perfil Markdown'), action: 'agents:instructions-copy', size: 'sm', variant: 'ghost', disabled: editor.saving, attrs: { 'data-id': agent.id } })}<input type="file" accept=".txt,.md,text/plain,text/markdown" data-agents-profile-file="${agent.id}" aria-label="${t('Arquivo de instruções TXT ou MD')}" hidden/></div><p class="pg-agents__muted">${t('Importar só preenche o editor. Revise e salve explicitamente. Exportar inclui o texto visível, mesmo antes de salvar.')}</p><p class="pg-agents__muted">${t('Para arquivos com mais de 4.000 caracteres, use conteúdo publicado e autorizado na')} <a class="pg-agents__link" href="#agents/knowledge">${t('Base de conhecimento')}</a>.</p>`;
    const templates = h`<div class="pg-agents__toolbar" role="group" aria-label="${t('Modelos de instruções')}"><span class="pg-agents__muted">${t('Modelo:')}</span>${Object.keys(TEMPLATE_LABELS).map(key => button({ label: TEMPLATE_LABELS[key], action: 'agents:instructions-template', size: 'sm', attrs: { 'data-id': agent.id, 'data-value': key } }))}${button({ label: t('Vazio'), action: 'agents:instructions-template', size: 'sm', variant: 'ghost', attrs: { 'data-id': agent.id, 'data-value': 'empty' } })}${button({ label: t('Desfazer modelo'), action: 'agents:instructions-undo', size: 'sm', variant: 'ghost', attrs: { 'data-id': agent.id, 'data-agents-undo': '', hidden: editor.previous === null } })}</div>`;
    const sections = h`<div class="pg-agents__toolbar" role="group" aria-label="${t('Inserir seção')}"><span class="pg-agents__muted">${t('Inserir seção:')}</span>${Object.keys(SECTION_LABELS).map(key => button({ label: SECTION_LABELS[key], action: 'agents:instructions-section', size: 'sm', variant: 'ghost', attrs: { 'data-id': agent.id, 'data-value': key } }))}</div>`;
    const near = editor.draft.length >= INSTRUCTIONS_LIMIT * 0.8;
    const form = h`<form class="pg-agents__card pg-agents__editor" data-form="agents:instructions" data-id="${agent.id}" data-state="${editor.conflict ? 'conflict' : dirtyEditor(editor) ? 'dirty' : 'saved'}"${attributes({ 'aria-busy': editor.saving ? 'true' : null })}>${conflictBox(editor)}${files}${templates}${sections}<label class="pg-agents__label" for="${id}">${t('Instruções do agente')}</label><textarea class="pg-agents__control pg-agents__textarea" id="${id}" name="instructions" rows="16" maxlength="${INSTRUCTIONS_LIMIT}" spellcheck="true" data-agents-instructions="${agent.id}" aria-describedby="${id}-count ${id}-help">${editor.draft}</textarea><p class="pg-agents__muted" id="${id}-help">${t('Entram em todo rascunho deste copiloto, junto com as regras de segurança da plataforma. Salvar invalida os rascunhos em andamento.')}</p><div class="pg-agents__editor-foot"><span class="pg-agents__num" id="${id}-count" data-agents-counter data-state="${near ? 'near' : 'ok'}">${counter(editor.draft.length)}</span><span data-agents-status role="status">${statusText(editor)}</span></div>${leaveBox(editor)}<div class="pg-agents__actions pg-agents__actions--end">${button({ label: t('Descartar'), action: 'agents:instructions-discard', variant: 'ghost', disabled: !dirtyEditor(editor) || editor.saving, attrs: { 'data-id': agent.id, 'data-agents-discard': '' } })}${button({ label: t('Salvar instruções'), type: 'submit', variant: 'primary', busy: editor.saving })}</div></form>`;
    const runtime = h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Perfil e memória')}</h2><p>${ctx.owner?t('O Hermes gerenciado recebe o perfil e o contexto autorizado a cada resposta, sem sessão ou memória nativa persistente.'):t('O copiloto gerenciado recebe o perfil e o contexto autorizado a cada resposta, sem sessão ou memória nativa persistente.')}</p><p>${ctx.owner?t('A memória da Elozi contém fatos revisados por pessoas. Ela não é a memória nativa do Hermes e não aprende automaticamente com as conversas.'):t('A memória da plataforma contém fatos revisados por pessoas. Ela não é a memória nativa do seu agente e não aprende automaticamente com as conversas.')}</p><p>${ctx.owner?t('Para manter arquivos de personalidade e memória no seu próprio Hermes, conecte esse cliente pelo MCP com o acesso que você autorizar.'):t('Para manter arquivos de personalidade e memória no seu agente próprio, conecte esse cliente pelo MCP com o acesso que você autorizar.')}</p><a class="pg-agents__link" href="#agents/connect">${ctx.owner?t('Conectar Hermes próprio'):t('Conectar meu agente')}</a></section>`;
    return h`<div class="pg-agents__split">${form}<div class="pg-agents__stack">${runtime}${testPanel(agent, ctx, editor)}</div></div>`;
  }

  // ---- Ferramentas ----------------------------------------------------------------------------

  function tools(agent, ctx) {
    const kind = agentKind(agent);
    if (kind !== 'managed') return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Ferramentas')}</h2><p>${kind === 'connected' ? t('Agentes conectados usam as ferramentas da plataforma liberadas pelas capacidades da identidade. Veja a lista em Acesso.') : t('Este provedor ainda não executa nesta versão.')}</p>${kind === 'connected' ? h`<a class="pg-agents__link" href="${formatHash({ section: 'agents', params: { agentId: agent.id, agentTab: 'access' } })}">${t('Abrir Acesso')}</a>` : ''}</section>`;
    // No mcpGrants = no tool granted: the runtime reads agent.mcpGrants || [] (src/mcp.js, src/agent-runtime.js).
    const policy = policyOf(agent), grants = (Array.isArray(agent.mcpGrants) ? agent.mcpGrants : []).filter(plain);
    const internal = new Set(grants.filter(grant => grant.serverId === INTERNAL_SERVER).map(grant => grant.toolName));
    const servers = new Map((state.mcpServers || []).map(server => [server.id, server]));
    const external = grants.filter(grant => grant.serverId !== INTERNAL_SERVER && servers.get(grant.serverId)?.kind !== 'internal');
    const policyForm = h`<form class="pg-agents__card pg-agents__policy" data-form="agents:tool-policy" data-id="${agent.id}"><div class="pg-agents__section-head"><div><h2 class="pg-agents__h2">${t('Como o agente usa ferramentas')}</h2><p class="pg-agents__muted">${t('Consultas internas só leem dados desta empresa. Ferramentas de servidores externos sempre pedem aprovação.')}</p></div></div>${segmented({ name: 'toolPolicy', value: policy, label: t('Política de ferramentas'), disabled: !ctx.admin, items: [{ value: 'auto_readonly', label: t('Consultas automáticas (somente leitura, até 3 por rascunho)') }, { value: 'approve_all', label: t('Aprovar cada uso') }] })}${ctx.admin ? h`<div class="pg-agents__actions pg-agents__actions--end">${button({ label: t('Salvar política'), type: 'submit', variant: 'primary', size: 'sm', disabled: true, attrs: { 'data-agents-policy-save': '' } })}</div>` : h`<p class="pg-agents__muted">${t('Somente a administração do workspace altera a política.')}</p>`}</form>`;
    const internalRows = INTERNAL_TOOLS.map(tool => {
      const state = !internal.has(tool) ? badge(t('Não concedida'), 'neutral') : policy === 'auto_readonly' ? badge(t('Automática · até 3 por rascunho'), 'agent') : badge(t('Com aprovação'), 'neutral');
      return h`<li class="pg-agents__tool"><div><code class="pg-agents__code">${tool}</code><p class="pg-agents__muted">${INTERNAL_LABELS[tool]} · ${t('somente leitura')}</p></div>${state}</li>`;
    });
    const externalRows = external.map(grant => h`<li class="pg-agents__tool"><div><code class="pg-agents__code">${grant.toolName || ''}</code><p class="pg-agents__muted">${servers.get(grant.serverId)?.name || t('Servidor externo')} · ${t('servidor MCP externo')}</p></div>${badge(t('Sempre requer aprovação'), 'warning')}</li>`);
    const manage = ctx.admin ? h`<div class="pg-agents__actions">${button({ label: t('Escolher ferramentas'), action: 'agents:tool-grants', size: 'sm', attrs: { 'data-id': agent.id } })}<a class="pg-agents__link" href="#agents/tools">${t('Servidores e catálogo')}</a></div>` : '';
    return h`<div class="pg-agents__stack">${policyForm}<section class="pg-agents__card"><div class="pg-agents__section-head"><h2 class="pg-agents__h2">${t('Consultas internas')}</h2>${manage}</div><ul class="pg-agents__tools">${internalRows}</ul></section><section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Ferramentas externas')}</h2>${externalRows.length ? h`<ul class="pg-agents__tools">${externalRows}</ul>` : h`<p class="pg-agents__muted">${t('Nenhuma ferramenta externa concedida a este agente.')}</p>`}<p class="pg-agents__muted">${t('Um servidor remoto não pode se declarar somente leitura: cada uso espera a aprovação de quem atende.')}</p></section></div>`;
  }

  // ---- Conhecimento ---------------------------------------------------------------------------

  function knowledge(agent, ctx) {
    const kind = agentKind(agent);
    if (kind !== 'managed') return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Conhecimento')}</h2><p>${kind === 'connected' ? t('Agentes conectados consultam a plataforma pelas ferramentas liberadas na identidade, dentro dos canais autorizados.') : t('Este provedor ainda não executa nesta versão.')}</p></section>`;
    if (!ctx.admin) return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Conhecimento')}</h2><p class="pg-agents__muted">${t('As fontes autorizadas para este agente são geridas pela administração do workspace.')}</p></section>`;
    const grants = Array.isArray(agent.knowledgeGrants) ? agent.knowledgeGrants : [], sources = new Map((state.knowledgeSources || []).map(source => [source.id, source]));
    const rows = grants.map(grant => {
      const source = sources.get(grant.sourceId), published = source?.published, current = Boolean(published && !source.archived && published.version === grant.publicationVersion && (!published.hash || published.hash === grant.publicationHash));
      return h`<li class="pg-agents__tool"><div><strong>${source?.published?.title || source?.title || t('Fonte removida')}</strong><p class="pg-agents__muted">${t('Publicação v{version}', { version: grant.publicationVersion ?? '—' })}${source?.category ? h` · ${source.category}` : ''}</p></div>${current ? badge(t('Autorizada'), 'success') : badge(t('Precisa de revisão'), 'warning')}</li>`;
    });
    const loading = !state.knowledgeLoaded && grants.length ? h`<p class="pg-agents__muted" role="status">${t('Carregando as fontes da empresa…')}</p>` : '';
    const search = searches.get(editorKey(agent.id));
    return h`<div class="pg-agents__split"><section class="pg-agents__card"><div class="pg-agents__section-head"><h2 class="pg-agents__h2">${t('Fontes autorizadas')}</h2><div class="pg-agents__actions">${button({ label: t('Escolher fontes'), action: 'agents:knowledge-grants', size: 'sm', attrs: { 'data-id': agent.id } })}<a class="pg-agents__link" href="#agents/knowledge">${t('Abrir a base')}</a></div></div>${loading}${rows.length ? h`<ul class="pg-agents__tools">${rows}</ul>` : h`<p class="pg-agents__muted">${t('Nenhuma fonte autorizada. Publique uma fonte na base e autorize aqui.')}</p>`}</section>
      <section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Pergunte algo e veja os trechos que o agente receberia')}</h2><form class="pg-agents__form" data-form="agents:knowledge-search" data-id="${agent.id}"><label class="pg-agents__field"><span class="pg-agents__label">${t('Pergunta')}</span><textarea class="pg-agents__control" name="query" rows="3" maxlength="500" required placeholder="${t('Ex.: qual é o prazo para trocar um produto?')}">${search?.query || ''}</textarea></label>${button({ label: t('Buscar nas fontes autorizadas'), type: 'submit', icon: 'search', busy: search?.loading === true })}</form><div data-agents-slot="knowledge-search" aria-live="polite">${searchResult(search)}</div></section></div>`;
  }

  function searchResult(search) {
    if (!search || search.loading) return search?.loading ? h`<p class="pg-agents__muted" role="status">${t('Consultando as publicações autorizadas…')}</p>` : '';
    if (search.error) return h`<p class="pg-agents__error">${search.error}</p>`;
    const result = search.result || {};
    if (result.state === 'matched' && Array.isArray(result.references) && result.references.length) return h`<ul class="pg-agents__references">${result.references.map(reference => h`<li><strong>${reference.title || t('Fonte autorizada')}</strong> <span class="pg-agents__muted">${t('Publicação v{version}', { version: reference.publicationVersion ?? '—' })}</span><p>${reference.excerpt || ''}</p></li>`)}</ul><p class="pg-agents__muted">${t('Estes trechos entram como contexto. A busca não gera nem envia resposta.')}</p>`;
    if (result.state === 'not_configured') return h`<p class="pg-agents__muted">${t('Este agente não tem publicações válidas autorizadas.')}</p>`;
    return h`<p class="pg-agents__muted">${t('Nenhum trecho corresponde a esta busca.')}</p>`;
  }

  // ---- Memória --------------------------------------------------------------------------------

  function memory(agent) {
    if (agentKind(agent) !== 'managed') return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Memória')}</h2><p class="pg-agents__muted">${t('A memória revisada vale para os copilotos gerenciados.')}</p></section>`;
    return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Memória')}</h2><p>${t('O copiloto lembra fatos revisados por pessoas sobre o contato ou a conversa. Cada fato é criado, revisado e arquivado dentro do atendimento.')}</p><ul class="pg-agents__list"><li>${t('Até 12 fatos ou 4 KiB por execução.')}</li><li>${t('Até 20 fatos por contato e 200 por empresa.')}</li><li>${t('Cada fato tem validade de até 365 dias.')}</li></ul><a class="pg-agents__link" href="#inbox">${t('Abrir Atendimento')}</a></section>`;
  }

  // ---- Acesso ---------------------------------------------------------------------------------

  function access(agent, ctx) {
    const kind = agentKind(agent);
    if (kind === 'connected') return connectedAccess(agent, ctx);
    if (kind === 'planned') return h`<section class="pg-agents__card" data-state="soon"><h2 class="pg-agents__h2">${t('Acesso')}</h2><p class="pg-agents__muted">${t('Este provedor ainda não executa nesta versão.')}</p></section>`;
    return h`<div class="pg-agents__stack"><section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Quem pode acionar')}</h2><p>${t('Quem é responsável pela conversa, ou a gestão, aciona o copiloto no Atendimento. O rascunho passa por uma pessoa antes do envio, exceto no piloto automático.')}</p></section>${autopilotSection(agent, ctx)}</div>`;
  }

  function connectedAccess(agent, ctx) {
    if (!ctx.admin) return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Acesso')}</h2><p class="pg-agents__muted">${t('As identidades de serviço são geridas pela administração do workspace.')}</p></section>`;
    const summary = typeof deps.principals === 'function' ? deps.principals()?.summary : null;
    let body;
    if (!summary || summary.loading || !summary.loaded && !summary.error) body = h`<p class="pg-agents__muted" role="status">${t('Carregando as identidades de serviço…')}</p>`;
    else if (summary.error) body = h`<p class="pg-agents__error">${summary.error}</p>`;
    else {
      const items = summary.items.filter(item => item.agentId === agent.id);
      const cachedProjection = responseProjections.get(editorKey(agent.id));
      const projection = cachedProjection?.context === resultContext() ? cachedProjection : null;
      const policies = new Map(items.map(item => [item.id, verifiedResponsePolicy(agent, item, projection)]));
      const active = items.filter(item => item.state === 'active'), unlocked = toolsForCapabilities([...new Set(active.flatMap(item => item.capabilities))]).filter(tool =>
        tool !== 'elozi_send_group_message' && tool !== 'elozi_schedule_group_message' || active.some(item => tool === 'elozi_send_group_message' ? policies.get(item.id)?.groups.sendCapable : policies.get(item.id)?.groups.scheduleCapable));
      body = items.length ? h`<ul class="pg-agents__principals">${items.map(item => h`<li class="pg-agents__principal"><div class="pg-agents__section-head"><strong>${item.name}</strong>${badge({ active: t('Ativo'), paused: t('Pausado'), revoked: t('Revogado'), expired: t('Expirado') }[item.state] || t('Indisponível'), item.state === 'active' ? 'success' : item.state === 'paused' ? 'warning' : 'neutral')}</div><p class="pg-agents__muted pg-agents__num">${t('{used}/{limit} chamadas hoje · {concurrent} simultâneas · válida até {until}', { used: formatNumber(item.usage.requests), limit: formatNumber(item.dailyRequests), concurrent: formatNumber(item.maxConcurrent), until: absoluteTime(item.expiresAt) || '—' })}</p><p class="pg-agents__muted">${item.channelIds === null ? t('Todos os canais desta empresa') : t('{count} canal(is) autorizado(s)', { count: item.channelIds.length })}</p>${responsePolicyMarkup(policies.get(item.id))}</li>`)}</ul><h3 class="pg-agents__h3">${t('O que este agente pode fazer na plataforma')}</h3>${active.length ? h`<ul class="pg-agents__codes">${unlocked.map(tool => h`<li><code class="pg-agents__code">${tool}</code></li>`)}</ul>` : h`<p class="pg-agents__muted">${t('Nenhuma identidade ativa: o agente não consegue chamar a plataforma agora.')}</p>`}` : h`<p>${t('Nenhuma identidade de serviço para este agente. Crie uma para entregar a chave ao seu cliente MCP.')}</p>`;
    }
    return h`<section class="pg-agents__card" data-agents-slot="access"><div class="pg-agents__section-head"><h2 class="pg-agents__h2">${t('Identidades de serviço')}</h2><a class="pg-agents__link" href="#agents/connect">${t('Gerenciar acessos')}</a></div>${body}</section>`;
  }

  // ---- Piloto automático ----------------------------------------------------------------------

  /**
   * 'yes' only on a server signal: the feature 'agent-autopilot' or an agent that already carries the
   * field; otherwise read-only "em breve" before anyone fills the form (no guess from a 400).
   */
  function autopilotSupport(agent, ctx) {
    return ctx.features.has('agent-autopilot') || plain(agent.autopilot) ? 'yes' : 'no';
  }

  function autopilotSection(agent, ctx) {
    const support = autopilotSupport(agent, ctx), saved = autopilotOf(agent), draft = support === 'yes' ? autopilotDrafts.get(editorKey(agent.id)) : null, value = draft || saved || { enabled: false, channelIds: [], maxRepliesPerHour: 6, requireKnowledge: true, quietHours: null, handoffDepartmentId: null };
    const editable = ctx.admin && support === 'yes' && agent.configured === true;
    const channels = (state.tenant?.channels || []).filter(channel => channel?.id), departments = (state.tenant?.departments || []).filter(department => department?.id && department.active !== false);
    const qr = channels.some(channel => channel.kind === 'whatsapp_qr');
    // Draft controls are not saved state, including before the first Save attempt.
    const unsaved = h`<p class="pg-agents__muted" role="status" data-agents-autopilot-status${attributes({ hidden: !draft || !editable, 'data-agents-unsaved': draft && editable ? '' : null })}>${t('Alterações não salvas: o servidor ainda tem a configuração anterior. Confira e salve de novo.')}</p><p class="pg-agents__muted">${saved?.enabled ? t('Estado salvo: piloto automático ativo.') : t('Estado salvo: piloto automático desligado.')}</p>${draft ? leaveBox(draft) : ''}`;
    const reason = support === 'no' ? banner({ tone: 'info', title: t('Piloto automático: em breve.'), body: t('Este servidor ainda não aceita a configuração. Os valores abaixo são somente leitura.') }) : !ctx.admin ? h`<p class="pg-agents__muted">${t('Somente a administração do workspace altera o piloto automático.')}</p>` : agent.configured !== true ? h`<p class="pg-agents__muted">${t('Configure o serviço do copiloto antes de ativar o piloto automático.')}</p>` : '';
    const zones = timeZones(), zone = value.quietTimezone ?? value.quietHours?.timezone ?? zones[0];
    const channelRows = channels.length ? channels.map(channel => h`<label class="pg-agents__check"><input type="checkbox" name="channelIds"${attributes({ value: channel.id, checked: value.channelIds.includes(channel.id) })}/><span>${channel.name || channel.id} <span class="pg-agents__muted">${CHANNEL_KINDS[channel.kind] || t('Canal')}</span>${channel.kind === 'whatsapp_qr' ? h` ${badge(t('Protocolo não oficial'), 'warning')}` : ''}</span></label>`) : h`<p class="pg-agents__muted">${t('Nenhum canal nesta empresa.')}</p>`;
    return h`<form class="pg-agents__card pg-agents__autopilot" id="agent-autopilot" data-form="agents:autopilot" data-id="${agent.id}" data-state="${support}"><div class="pg-agents__section-head"><div><h2 class="pg-agents__h2">${t('Piloto automático')}</h2><p class="pg-agents__muted">${t('Responde sozinho nas conversas atribuídas a este agente, somente nos canais marcados.')}</p></div><label class="pg-agents__switch"><input type="checkbox" role="switch" name="enabled"${attributes({ checked: value.enabled, disabled: !editable })}/><span class="pg-agents__switch-track" aria-hidden="true"></span><span>${t('Ativar piloto automático')}</span></label></div>${reason}${unsaved}
      <fieldset class="pg-agents__fieldset"${attributes({ disabled: !editable })}><legend class="pg-agents__label">${t('Canais com autorização explícita')}</legend>${channelRows}</fieldset>
      ${qr ? banner({ tone: 'warning', title: t('WhatsApp por QR usa um protocolo não oficial.'), body: t('Respostas automáticas em volume aumentam o risco de bloqueio do número. Prefira Telegram e o chat do site até a API oficial.') }) : ''}
      <fieldset class="pg-agents__fieldset pg-agents__form-grid"${attributes({ disabled: !editable })}><legend class="sr-only">${t('Limites e transferência')}</legend><label class="pg-agents__field"><span class="pg-agents__label">${t('Respostas por hora em cada conversa')}</span><input class="pg-agents__control" type="number" name="maxRepliesPerHour" min="1" max="30" step="1" inputmode="numeric" required${attributes({ value: String(value.maxRepliesPerHour) })}/></label><label class="pg-agents__field"><span class="pg-agents__label">${t('Transferir para')}</span><select class="pg-agents__control" name="handoffDepartmentId"><option value="">${t('Fila geral da empresa')}</option>${departments.map(department => h`<option${attributes({ value: department.id, selected: value.handoffDepartmentId === department.id })}>${department.name || department.id}</option>`)}</select></label>
      <label class="pg-agents__check pg-agents__span"><input type="checkbox" name="requireKnowledge"${attributes({ checked: value.requireKnowledge })}/><span>${t('Só responder quando a base de conhecimento confirmar a resposta')}</span></label>
      <label class="pg-agents__check pg-agents__span"><input type="checkbox" name="quiet"${attributes({ checked: Boolean(value.quietHours) })}/><span>${t('Horário silencioso: transferir para a equipe em vez de responder')}</span></label><label class="pg-agents__field"><span class="pg-agents__label">${t('Início')}</span><input class="pg-agents__control" type="time" name="quietStart"${attributes({ value: value.quietStart ?? value.quietHours?.start ?? '22:00' })}/></label><label class="pg-agents__field"><span class="pg-agents__label">${t('Fim')}</span><input class="pg-agents__control" type="time" name="quietEnd"${attributes({ value: value.quietEnd ?? value.quietHours?.end ?? '07:00' })}/></label><label class="pg-agents__field pg-agents__span"><span class="pg-agents__label">${t('Fuso horário')}</span><select class="pg-agents__control" name="quietTimezone">${zones.map(item => h`<option${attributes({ value: item, selected: item === zone })}>${item}</option>`)}</select></label></fieldset>
      <p class="pg-agents__muted">${t('Sempre transfere com nota interna quando o cliente pede uma pessoa, demonstra irritação, envia mídia ou quando a resposta não tem base. Uma pessoa que assume a conversa interrompe o agente na hora.')}</p>
      ${editable ? h`<div class="pg-agents__actions pg-agents__actions--end">${button({ label: t('Descartar'), action: 'agents:autopilot-discard', variant: 'ghost', disabled: !draft || draft.saving, attrs: { 'data-id': agent.id, 'data-agents-autopilot-discard': '' } })}${button({ label: t('Salvar piloto automático'), type: 'submit', variant: 'primary', busy: draft?.saving === true })}</div>` : ''}</form>`;
  }

  // Capture raw controls before validation: invalid/empty numbers and inactive quiet-hour inputs
  // are still the person's draft, not permission to silently restore saved defaults.
  function captureAutopilot(form) {
    const agent = findAgent(form?.dataset?.id), ctx = context();
    if (!agent || !ctx.admin || agentKind(agent) !== 'managed' || !agent.configured || autopilotSupport(agent, ctx) !== 'yes') return null;
    const data = new FormData(form), key = editorKey(agent.id), previous = autopilotDrafts.get(key);
    const draft = previous || { agentId: agent.id, tab: 'access', leave: null, saving: false };
    const quietStart = String(data.get('quietStart') ?? ''), quietEnd = String(data.get('quietEnd') ?? ''), quietTimezone = String(data.get('quietTimezone') ?? '');
    Object.assign(draft, { enabled: data.get('enabled') !== null, channelIds: data.getAll('channelIds').map(String),
      maxRepliesPerHour: String(data.get('maxRepliesPerHour') ?? ''), requireKnowledge: data.get('requireKnowledge') !== null,
      quietStart, quietEnd, quietTimezone, quietHours: data.get('quiet') !== null ? { start: quietStart, end: quietEnd, timezone: quietTimezone } : null,
      handoffDepartmentId: String(data.get('handoffDepartmentId') ?? '') || null, revision: (draft.revision || 0) + 1 });
    autopilotDrafts.set(key, draft);
    const status = form.querySelector?.('[data-agents-autopilot-status]');
    if (status) { status.hidden = false; status.setAttribute('data-agents-unsaved', ''); }
    const discard = form.querySelector?.('[data-agents-autopilot-discard]'); if (discard) discard.disabled = draft.saving;
    return draft;
  }

  /** Reads and checks the autopilot form with the rules of src/agent-autopilot.js normalizeAutopilotConfig. */
  function readAutopilot(form, agent) {
    const data = new FormData(form), channels = new Set((state.tenant?.channels || []).map(channel => channel.id));
    const channelIds = [...new Set(data.getAll('channelIds').map(String))].filter(id => channels.has(id)).sort();
    const enabled = data.get('enabled') !== null, max = Number(data.get('maxRepliesPerHour'));
    if (enabled && !channelIds.length) throw new Error(t('Escolha ao menos um canal com autorização explícita para o piloto automático.'));
    if (!Number.isSafeInteger(max) || max < 1 || max > 30) throw new Error(t('Use de 1 a 30 respostas automáticas por hora em cada conversa.'));
    let quietHours = null;
    if (data.get('quiet') !== null) {
      const start = String(data.get('quietStart') || ''), end = String(data.get('quietEnd') || ''), timezone = String(data.get('quietTimezone') || '');
      if (!TIME.test(start) || !TIME.test(end)) throw new Error(t('Informe o horário silencioso no formato HH:mm.'));
      if (start === end) throw new Error(t('O horário silencioso precisa de início e fim diferentes.'));
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); } catch { throw new Error(t('Informe um fuso horário IANA válido.')); }
      quietHours = { timezone, start, end };
    }
    const department = String(data.get('handoffDepartmentId') || '');
    const handoffDepartmentId = department && (state.tenant?.departments || []).some(item => item.id === department && item.active !== false) ? department : null;
    const config = { enabled, channelIds, maxRepliesPerHour: max, requireKnowledge: data.get('requireKnowledge') !== null, quietHours, handoffDepartmentId };
    return config;
  }

  // ---- Uso and Atividade ----------------------------------------------------------------------

  function usageTab(agent, ctx) {
    if (!ctx.admin) return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Uso')}</h2><p class="pg-agents__muted">${t('O consumo de tokens é visível para a administração do workspace.')}</p></section>`;
    if (agentKind(agent) === 'connected') return h`<section class="pg-agents__card"><h2 class="pg-agents__h2">${t('Uso')}</h2><p class="pg-agents__muted">${t('O modelo deste agente roda no seu ambiente: a plataforma não mede os tokens dele. As chamadas do dia aparecem em Acesso.')}</p></section>`;
    return usage ? usage.agentPanel(agent.id) : h`<section class="pg-agents__card"><p class="pg-agents__muted">${t('Medição disponível em breve.')}</p></section>`;
  }

  function activity(agent, ctx) {
    const status = feed();
    return h`<section class="pg-agents__card" data-agents-slot="agent-activity"><div class="pg-agents__section-head"><h2 class="pg-agents__h2">${t('Atividade')}</h2><span class="pg-agents__muted">${status.note}</span></div>${status.error ? h`<p class="pg-agents__error">${status.error}</p>` : ''}${activityTable(runsOf(agent.id), { admin: ctx.admin, tenant: state.tenant })}</section>`;
  }

  /** The agent-runs feed arrived: the runs of the open tab are redrawn in place (focus and scroll stay). */
  function repaintRuns(agentId) {
    const agent = findAgent(agentId), tab = route?.params?.agentId === agentId ? route.params.agentTab || 'overview' : null;
    if (!agent || !tab) return;
    if (tab === 'activity') repaint('agent-activity', () => activity(agent, context()));
    if (tab === 'overview') repaint('agent-runs', () => recentRuns(agent, context()));
  }

  // ---- behaviour --------------------------------------------------------------------------------

  function captureFocus() {
    const active = globalThis.document?.activeElement;
    focus = active?.matches?.('[data-agents-instructions]') ? { agentId: active.dataset.agentsInstructions, start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop } : null;
  }

  function repaintEditor(editor) {
    const doc = globalThis.document, form = doc?.querySelector?.(`form[data-form="agents:instructions"][data-id="${selectorValue(editor.agentId)}"]`);
    if (!form) return;
    form.dataset.state = editor.conflict ? 'conflict' : dirtyEditor(editor) ? 'dirty' : 'saved';
    const count = form.querySelector('[data-agents-counter]'); if (count) { count.textContent = counter(editor.draft.length); count.dataset.state = editor.draft.length >= INSTRUCTIONS_LIMIT * 0.8 ? 'near' : 'ok'; }
    const status = form.querySelector('[data-agents-status]'); if (status) status.textContent = statusText(editor);
    const discard = form.querySelector('[data-agents-discard]'); if (discard) discard.disabled = !dirtyEditor(editor) || editor.saving;
    const undo = form.querySelector('[data-agents-undo]'); if (undo) undo.hidden = editor.previous === null;
    const importButton = form.querySelector('[data-agents-import]'); if (importButton) importButton.disabled = dirtyEditor(editor) || editor.saving || Boolean(editor.fileImport);
    const previewButton = doc?.querySelector?.(`form[data-form="agents:preview"][data-id="${selectorValue(editor.agentId)}"] [type="submit"]`);
    if (previewButton && editor.fileReviewRequired) previewButton.disabled = true;
  }

  function profileView(agentId) {
    const agent = findAgent(agentId), expected = resultView(agentId, 'instructions'), doc = globalThis.document;
    const form = doc?.querySelector?.(`form[data-form="agents:instructions"][data-id="${selectorValue(agentId)}"]`);
    if (!agent || agentKind(agent) !== 'managed' || !context().admin || !activeResultView(expected) || !form || form.isConnected === false || doc?.querySelector?.('#modal')?.open) throw new Error(t('Abra as instruções deste agente com acesso de administração.'));
    return { agent, expected, form, editor: editorOf(agent), doc };
  }

  async function importInstructions(input) {
    const files = Array.from(input.files || []), file = files[0]; input.value = '';
    if (!file) return;
    const { agent, expected, form, editor, doc } = profileView(input.dataset.agentsProfileFile);
    if (input.isConnected === false || input.closest?.('form') !== form || files.length !== 1) throw new Error(t('Escolha um único arquivo de instruções.'));
    const area = form.querySelector('[data-agents-instructions]');
    if (dirtyEditor(editor) || editor.conflict || editor.saving || editor.fileImport || !area || area.value !== editor.draft) throw new Error(t('Salve ou descarte as alterações do editor antes de importar.'));
    const token = { generation: profileGeneration, version: agent.version, baseVersion: editor.baseVersion, draft: editor.draft, session: state.boot?.session, modal: doc.querySelector?.('#modal') };
    const current = () => token.generation === profileGeneration && activeResultView(expected) && context().admin && findAgent(agent.id) === agent && agent.version === token.version
      && editor.baseVersion === token.baseVersion && editor.draft === token.draft && !dirtyEditor(editor) && !editor.conflict && !editor.saving && editor.fileImport === token
      && state.boot?.session === token.session && input.isConnected !== false && form.isConnected !== false && input.closest?.('form') === form
      && form.querySelector('[data-agents-instructions]') === area && area.isConnected !== false && area.value === token.draft
      && doc.querySelector?.(`form[data-form="agents:instructions"][data-id="${selectorValue(agent.id)}"]`) === form && doc.querySelector?.('#modal') === token.modal && !token.modal?.open;
    editor.fileImport = token; repaintEditor(editor);
    try {
      const text = await readAgentInstructionFile(file);
      if (!current()) return;
      editor.fileReviewRequired = true;
      setDraft(editor, text, { selectionStart: 0 });
      toasts.show({ message: t('Arquivo importado para revisão. Salve as instruções para aplicar ao agente.'), tone: 'info' });
    } catch (error) { if (current()) fail(error); }
    finally { if (editor.fileImport === token) { editor.fileImport = null; if (activeResultView(expected)) repaintEditor(editor); } }
  }

  function exportProfile(agentId) {
    const { agent, editor, form, doc } = profileView(agentId);
    if (editor.saving) throw new Error(t('Aguarde o salvamento antes de exportar.'));
    const text = form.querySelector('[data-agents-instructions]')?.value ?? editor.draft;
    const markdown = agentProfileMarkdown(agent, text), urls = doc.defaultView?.URL || globalThis.URL;
    if (typeof urls?.createObjectURL !== 'function' || typeof urls?.revokeObjectURL !== 'function') throw new Error(t('Este navegador não conseguiu preparar o arquivo.'));
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), url = urls.createObjectURL(blob), link = doc.createElement('a');
    try {
      link.href = url; link.download = `perfil-${(agent.name || 'agente').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48) || 'agente'}.md`;
      doc.body.append(link); link.click();
    } finally { link.remove(); urls.revokeObjectURL(url); }
  }

  async function copyProfile(agentId) {
    const { agent, expected, editor, form, doc } = profileView(agentId);
    if (editor.saving) throw new Error(t('Aguarde o salvamento antes de copiar.'));
    const area = form.querySelector('[data-agents-instructions]'), text = area?.value ?? editor.draft;
    const markdown = agentProfileMarkdown(agent, text);
    const token = { generation: profileGeneration, version: agent.version, baseVersion: editor.baseVersion, draft: editor.draft,
      name: agent.name, description: agent.description, session: state.boot?.session, modal: doc.querySelector?.('#modal') };
    const current = () => {
      try {
        const fresh = profileView(agentId);
        return token.generation === profileGeneration && fresh.expected.context === expected.context && fresh.agent === agent && fresh.editor === editor && fresh.form === form && fresh.doc === doc
          && agent.version === token.version && agent.name === token.name && agent.description === token.description && editor.baseVersion === token.baseVersion && editor.draft === token.draft && !editor.saving
          && state.boot?.session === token.session && form.querySelector('[data-agents-instructions]') === area && area?.isConnected !== false && (area?.value ?? editor.draft) === text
          && doc.querySelector?.('#modal') === token.modal;
      } catch { return false; }
    };
    const clipboard = (doc.defaultView?.navigator || globalThis.navigator)?.clipboard;
    const unavailable = () => new Error(t('Não foi possível copiar neste navegador. Selecione e copie o texto do editor ou use Exportar perfil Markdown.'));
    if (typeof clipboard?.writeText !== 'function') throw unavailable();
    if (!current()) return;
    try { await clipboard.writeText(markdown); }
    catch { if (current()) throw unavailable(); return; }
    if (current()) toasts.show({ message: t('Perfil Markdown copiado. Cole no editor de arquivos do seu agente.'), tone: 'success' });
  }

  /** Callers check the limit first (the text is never cut here without a word). */
  function setDraft(editor, text, { selectionStart = null } = {}) {
    editor.draft = String(text ?? '');
    const area = globalThis.document?.querySelector?.(areaSelector(editor.agentId));
    if (area) { area.value = editor.draft; if (selectionStart !== null) { area.focus(); area.setSelectionRange(selectionStart, selectionStart); } }
    repaintEditor(editor);
  }

  /** Called after each render of the detail: listeners on <main>, focus restored, data the tabs wait for. */
  function mount(main, current) {
    route = current;
    if (!main?.addEventListener) return;
    main.addEventListener('input', event => {
      const autonomy = event.target?.closest?.('form[data-form="agents:autopilot"]');
      if (autonomy) { captureAutopilot(autonomy); return; }
      const area = event.target?.closest?.('[data-agents-instructions]');
      if (!area) return;
      const agent = findAgent(area.dataset.agentsInstructions); if (!agent) return;
      const editor = editorOf(agent); editor.fileImport = null; editor.draft = area.value; repaintEditor(editor);
    });
    main.addEventListener('change', event => {
      const input = event.target;
      const autonomy = input?.closest?.('form[data-form="agents:autopilot"]');
      if (autonomy) { captureAutopilot(autonomy); return; }
      if (input?.name === 'conversationId' && input.closest?.('form')?.dataset.form === 'agents:preview') { const agent = findAgent(input.closest('form').dataset.id); if (agent) editorOf(agent).previewConversationId = input.value; }
      if (input?.dataset?.agentsProfileFile) { void importInstructions(input).catch(fail); return; }
      if (input?.name === 'toolPolicy') {
        const form = input.closest('form'), agent = findAgent(form?.dataset.id), save = form?.querySelector('[data-agents-policy-save]');
        if (agent && save) save.disabled = input.value === policyOf(agent);
      }
    });
    if (focus && current?.params?.agentId === focus.agentId) {
      const area = main.querySelector?.(`[data-agents-instructions="${selectorValue(focus.agentId)}"]`);
      if (area) { area.focus({ preventScroll: true }); try { area.setSelectionRange(focus.start, focus.end); } catch { /* selection not supported */ } area.scrollTop = focus.scroll || 0; }
    }
    focus = null;
    const leave = main.querySelector?.('[data-agents-leave]'), target = !leave && focusTarget ? main.querySelector?.(focusTarget) : null;
    if (leave) leave.focus?.();
    else if (target) { target.focus?.(); if (target.matches?.('[data-agents-instructions]')) target.setSelectionRange?.(target.value.length, target.value.length); }
    focusTarget = null;
    installGuard();
    const ctx = context(), agent = findAgent(current?.params?.agentId), tab = current?.params?.agentTab || 'overview';
    if (agent && ctx.admin && agentKind(agent) === 'connected' && tab === 'access') {
      const principals = typeof deps.principals === 'function' ? deps.principals() : null;
      const expected = resultView(agent.id, 'access');
      const key = editorKey(agent.id), previous = responseProjections.get(key), now = Date.now();
      const agentStamp = JSON.stringify([agent.id, agent.version, agent.provider, agent.mode, agent.configured]);
      if (!previous || previous.context !== expected.context || previous.agentStamp !== agentStamp || now - previous.at > RESPONSE_POLICY_MAX_AGE) {
        if (previous?.timer) clearTimeout(previous.timer);
        const record = { at: now, context: expected.context, agentStamp };
        responseProjections.set(key, record);
        Promise.resolve(request(tenantPath('service-principals'))).then(result => {
          if (responseProjections.get(key) !== record || record.context !== resultContext()) return;
          if (!Array.isArray(result?.principals) || !plain(result?.responsePolicies)) return;
          record.at = Date.now();
          record.principals = Array.isArray(result?.principals) ? result.principals : [];
          record.responsePolicies = plain(result?.responsePolicies) ? result.responsePolicies : {};
          record.timer = setTimeout(() => {
            if (responseProjections.get(key) === record) repaint('access', () => connectedAccess(agent, context()), expected);
          }, RESPONSE_POLICY_MAX_AGE + 1);
          record.timer.unref?.();
          repaint('access', () => connectedAccess(agent, context()), expected);
        }).catch(() => { /* Missing projection stays unverified; no grant or liveness fallback. */ });
      }
      if (principals && !principals.summary?.loaded && !principals.summary?.loading) Promise.resolve(principals.load?.()).then(() => repaint('access', () => connectedAccess(agent, context()), expected)).catch(() => {});
    }
  }

  /** Replaces the markup of one slot (data-agents-slot) without re-rendering the page. */
  function repaint(slot, markupOf, expected = null) {
    if (expected && !activeResultView(expected)) return;
    const prefix = expected ? `.pg-agents--detail[data-agent="${selectorValue(expected.agentId)}"] #agent-detail-panel-${expected.tab}:not([hidden]) ` : '';
    const target = globalThis.document?.querySelector?.(`${prefix}[data-agents-slot="${slot}"]`);
    if (!target) return;
    const template = globalThis.document.createElement('template');
    template.innerHTML = String(markupOf());
    const fresh = template.content.querySelector(`[data-agents-slot="${slot}"]`);
    if (fresh) target.replaceWith(fresh); else target.innerHTML = template.innerHTML;
  }

  // Leave guard: links and menu entries that leave the instructions with unsaved text stop at the
  // inline question; reloading or closing asks the browser's own question.
  function installGuard() {
    if (guardInstalled || !globalThis.document?.addEventListener) return;
    guardInstalled = true;
    globalThis.document.addEventListener('click', event => {
      const editor = dirty();
      if (!editor || editor.leave) return;
      const control = event.target?.closest?.('a[href^="#"], [data-view]');
      if (!control || control.closest?.('form[data-form="agents:instructions"], form[data-form="agents:autopilot"]')) return;
      const href = control.getAttribute?.('href');
      const own = formatHash({ section: 'agents', params: { agentId: editor.agentId, agentTab: editor.tab || 'instructions' } });
      if (href && (href === own || href === '#')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      editor.leave = href ? { href } : { view: control.dataset.view };
      rerender();
    }, true);
    globalThis.window?.addEventListener?.('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  }

  async function fetchAgent(agentId) {
    const tenant = await request(tenantPath(''));
    const latest = (Array.isArray(tenant?.agents) ? tenant.agents : []).find(agent => agent.id === agentId) || null;
    const local = findAgent(agentId);
    if (latest && local) Object.assign(local, { instructions: latest.instructions, version: latest.version, toolPolicy: latest.toolPolicy, ...(Object.hasOwn(latest, 'autopilot') ? { autopilot: latest.autopilot } : {}) });
    return latest;
  }

  const fail = error => toasts.show({ message: error?.message || t('Não foi possível concluir a solicitação. Tente novamente.'), tone: 'error' });

  async function saveInstructions(form) {
    const agent = findAgent(form.dataset.id), ctx = context();
    if (!agent || agentKind(agent) !== 'managed' || !ctx.admin) throw new Error(t('Somente a administração do workspace altera as instruções.'));
    const editor = editorOf(agent);
    if (editor.saving) return;
    const text = String(form.querySelector('[data-agents-instructions]')?.value ?? editor.draft);
    if (text.length > INSTRUCTIONS_LIMIT) throw new Error(t('Use instruções com até {limit} caracteres.', { limit: formatNumber(INSTRUCTIONS_LIMIT) }));
    editor.draft = text; editor.saving = true; editor.leave = null; repaintEditor(editor);
    try {
      const result = await request(tenantPath(`agents/${encodeURIComponent(agent.id)}`), { method: 'PATCH', body: JSON.stringify({ version: editor.baseVersion, instructions: text }) });
      const saved = typeof result?.instructions === 'string' ? result.instructions : text.replace(/\r\n?/g, '\n').trim();
      if (saved) agent.instructions = saved; else delete agent.instructions;
      if (Number.isSafeInteger(result?.version)) agent.version = result.version;
      Object.assign(editor, { base: saved, draft: saved, baseVersion: agent.version ?? editor.baseVersion + 1, conflict: null, showDiff: false, previous: null, fileReviewRequired: false });
      toasts.show({ message: t('Instruções salvas (v{version}). Rascunhos em andamento recomeçam com a nova versão.', { version: editor.baseVersion }), tone: 'success' });
    } catch (error) {
      if (error?.status !== 409) throw error;
      const latest = await fetchAgent(agent.id).catch(() => null);
      editor.conflict = { text: typeof latest?.instructions === 'string' ? latest.instructions : '', version: Number.isSafeInteger(latest?.version) ? latest.version : null };
      editor.showDiff = false;
    } finally {
      editor.saving = false;
      rerenderFocusing(editor.conflict ? `[data-action="agents:instructions-diff"][data-id="${selectorValue(agent.id)}"]` : `form[data-form="agents:instructions"][data-id="${selectorValue(agent.id)}"] [type="submit"]`);
    }
  }

  /**
   * agent.version is one CAS for instructions, policy and autopilot: after another field saved over
   * `before`, an instructions editor still on `before` (same text on the server) follows the new version,
   * so the person's next save is not a conflict with herself.
   */
  function followVersion(agent, before) {
    const editor = editors.get(editorKey(agent.id));
    if (editor && !editor.conflict && !editor.saving && editor.baseVersion === before && Number.isSafeInteger(agent.version)) editor.baseVersion = agent.version;
  }

  function go(target) {
    if (target?.href) globalThis.location.hash = target.href;
    else if (target?.view && typeof deps.navigate === 'function') deps.navigate(target.view);
  }

  async function savePolicy(form) {
    const agent = findAgent(form.dataset.id);
    if (!agent || agentKind(agent) !== 'managed' || !context().admin) throw new Error(t('Somente a administração do workspace altera a política.'));
    const value = String(new FormData(form).get('toolPolicy') || '');
    if (!['auto_readonly', 'approve_all'].includes(value)) throw new Error(t('Escolha uma política de ferramentas válida.'));
    if (value === policyOf(agent)) return;
    const control = form.querySelector('[data-agents-policy-save]'); if (control) control.setAttribute('aria-busy', 'true');
    const before = Number.isSafeInteger(agent.version) ? agent.version : 1;
    try {
      const result = await request(tenantPath(`agents/${encodeURIComponent(agent.id)}`), { method: 'PATCH', body: JSON.stringify({ version: before, toolPolicy: value }) });
      agent.toolPolicy = value; if (Number.isSafeInteger(result?.version)) { agent.version = result.version; followVersion(agent, before); }
      toasts.show({ message: value === 'auto_readonly' ? t('Consultas internas automáticas ativadas para este agente.') : t('Cada ferramenta agora espera a aprovação de quem atende.'), tone: 'success' });
    } catch (error) {
      if (error?.status === 409) { await fetchAgent(agent.id).catch(() => null); throw new Error(t('O agente mudou em outra sessão. Confira a política atual e salve de novo.')); }
      throw error;
    } finally { rerenderFocusing(`form[data-form="agents:tool-policy"][data-id="${selectorValue(agent.id)}"] input[name="toolPolicy"]:checked`); }
  }

  async function saveAutopilot(form) {
    const agent = findAgent(form.dataset.id), ctx = context();
    if (!agent || agentKind(agent) !== 'managed' || !ctx.admin) throw new Error(t('Somente a administração do workspace altera o piloto automático.'));
    if (autopilotSupport(agent, ctx) === 'no') throw new Error(t('Piloto automático: em breve neste servidor.'));
    if (!agent.configured || autopilotDrafts.get(editorKey(agent.id))?.saving) return;
    const draft = captureAutopilot(form), key = editorKey(agent.id), revision = draft.revision;
    const config = readAutopilot(form, agent), before = Number.isSafeInteger(agent.version) ? agent.version : 1;
    draft.saving = true;
    form.setAttribute('aria-busy', 'true');
    try {
      const result = await request(tenantPath(`agents/${encodeURIComponent(agent.id)}`), { method: 'PATCH', body: JSON.stringify({ version: before, autopilot: config }) });
      agent.autopilot = plain(result?.autopilot) ? result.autopilot : config;
      if (Number.isSafeInteger(result?.version)) { agent.version = result.version; followVersion(agent, before); }
      if (autopilotDrafts.get(key) === draft && draft.revision === revision) autopilotDrafts.delete(key);
      toasts.show({ message: config.enabled ? t('Piloto automático ativado nos canais marcados.') : t('Piloto automático desligado. O copiloto volta a só preparar rascunhos.'), tone: 'success' });
    } catch (error) {
      if (error?.status === 409) {
        // Keep the person's draft; saved state is shown separately, never silently adopted.
        await fetchAgent(agent.id).catch(() => null);
        throw new Error(t('O agente mudou em outra sessão. Suas alterações foram mantidas; confira a configuração salva e tente novamente.'));
      }
      throw error;
    } finally { draft.saving = false; form.removeAttribute?.('aria-busy'); rerenderFocusing(`form[data-form="agents:autopilot"][data-id="${selectorValue(agent.id)}"] [type="submit"]`); }
  }

  async function runPreview(form) {
    const agent = findAgent(form.dataset.id), ctx = context();
    if (!agent || !ctx.features.has('agent-preview') || !ctx.admin) throw new Error(t('Teste sem gravar: em breve.'));
    const editor = editorOf(agent);
    if (editor.fileReviewRequired) throw new Error(t('Revise e salve as instruções importadas antes de testar o agente.'));
    const conversationId = String(new FormData(form).get('conversationId') || ''), conversation = (state.tenant?.conversations || []).find(item => item.id === conversationId);
    if (!conversation) throw new Error(t('Escolha uma conversa desta empresa.'));
    const key = editorKey(agent.id), expected = resultView(agent.id, 'instructions');
    if (!activeResultView(expected) || form.isConnected === false) return;
    if (previews.get(key)?.loading && previews.get(key)?.context === expected.context) return;
    editor.previewConversationId = conversationId;
    const record = { loading: true, context: expected.context };
    function busy(target) {
      if (!target) return;
      const control = target.querySelector?.('[type="submit"]');
      target.setAttribute?.('aria-busy', record.loading ? 'true' : 'false');
      if (control) { control.disabled = record.loading || editor.fileReviewRequired || editor.draft.length > INSTRUCTIONS_LIMIT; control.setAttribute?.('aria-busy', record.loading ? 'true' : 'false'); }
    }
    busy(form);
    previews.set(key, record); repaint('preview', () => h`<div data-agents-slot="preview" aria-live="polite">${previewResult(record)}</div>`, expected);
    try { record.data = await request(tenantPath(`agents/${encodeURIComponent(agent.id)}/preview`), { method: 'POST', body: JSON.stringify({ conversationId, conversationVersion: conversation.version, instructions: editor.draft }) }); }
    catch (error) { record.error = error?.message || t('Não foi possível gerar o rascunho de teste.'); }
    finally {
      record.loading = false;
      if (previews.get(key) === record && activeResultView(expected)) {
        repaint('preview', () => h`<div data-agents-slot="preview" aria-live="polite">${previewResult(record)}</div>`, expected);
        busy(form);
        busy(globalThis.document?.querySelector?.(`form[data-form="agents:preview"][data-id="${selectorValue(agent.id)}"]`));
      }
    }
  }

  async function searchKnowledge(form) {
    const agent = findAgent(form.dataset.id);
    if (!agent || !context().admin) throw new Error(t('A base de conhecimento pertence ao administrador do workspace.'));
    const query = String(new FormData(form).get('query') || '').trim();
    if (!query || query.length > 500) throw new Error(t('Escreva uma pergunta de até 500 caracteres.'));
    const key = editorKey(agent.id), record = { query, loading: true }, expected = resultView(agent.id, 'knowledge');
    searches.set(key, record); repaint('knowledge-search', () => h`<div data-agents-slot="knowledge-search" aria-live="polite">${searchResult(record)}</div>`, expected);
    try { record.result = await request(tenantPath('knowledge/search'), { method: 'POST', body: JSON.stringify({ agentId: agent.id, query }) }); }
    catch (error) { record.error = error?.message || t('Não foi possível concluir a busca.'); }
    finally { record.loading = false; if (searches.get(key) === record) repaint('knowledge-search', () => h`<div data-agents-slot="knowledge-search" aria-live="polite">${searchResult(record)}</div>`, expected); }
  }

  /** 'agents:*' actions of the detail; true when handled. */
  async function act(name, id, element) {
    const agent = findAgent(id);
    switch (name) {
      case 'agents:instructions-import': {
        const { editor, form } = profileView(id);
        if (dirtyEditor(editor) || editor.conflict || editor.saving || editor.fileImport) throw new Error(t('Salve ou descarte as alterações do editor antes de importar.'));
        form.querySelector('[data-agents-profile-file]')?.click(); return true;
      }
      case 'agents:instructions-export': exportProfile(id); return true;
      case 'agents:instructions-copy': await copyProfile(id); return true;
      case 'agents:instructions-template': case 'agents:instructions-section': {
        if (!agent || !context().admin) return true;
        const editor = editorOf(agent), value = element?.dataset?.value || '';
        if (name === 'agents:instructions-section') {
          const area = globalThis.document?.querySelector?.(areaSelector(agent.id)), text = editor.draft, at = area ? area.selectionEnd : text.length;
          const before = text.slice(0, at), insert = `${before && !before.endsWith('\n\n') ? before.endsWith('\n') ? '\n' : '\n\n' : ''}## ${SECTION_LABELS[value] || value}\n`;
          // Nothing the person wrote is cut to make room: near the limit the section is not inserted.
          if (text.length + insert.length > INSTRUCTIONS_LIMIT) throw new Error(t('Não há espaço para a seção: as instruções chegaram perto do limite de {limit} caracteres.', { limit: formatNumber(INSTRUCTIONS_LIMIT) }));
          setDraft(editor, before + insert + text.slice(at), { selectionStart: (before + insert).length });
          return true;
        }
        const previous = editor.draft, next = value === 'empty' ? '' : AGENT_INSTRUCTION_TEMPLATES[value] ? t(AGENT_INSTRUCTION_TEMPLATES[value], { company: state.tenant?.name || '' }) : previous;
        if (next.length > INSTRUCTIONS_LIMIT) throw new Error(t('Use instruções com até {limit} caracteres.', { limit: formatNumber(INSTRUCTIONS_LIMIT) }));
        // The replaced text stays recoverable ("Desfazer modelo") until the next save or discard.
        if (previous && previous !== next) editor.previous = previous;
        setDraft(editor, next, { selectionStart: 0 });
        if (previous && previous !== next) toasts.show({ message: t('Modelo aplicado. Revise e salve para valer.'), tone: 'info', action: { label: t('Desfazer'), onSelect: () => undoTemplate(editor) } });
        return true;
      }
      case 'agents:instructions-undo': { if (agent && context().admin) undoTemplate(editorOf(agent)); return true; }
      case 'agents:instructions-discard': {
        if (!agent) return true;
        const editor = editorOf(agent); editor.conflict = null; editor.leave = null; editor.previous = null; editor.fileReviewRequired = false; setDraft(editor, editor.base); rerenderFocusing(areaSelector(agent.id)); return true;
      }
      case 'agents:instructions-diff': { if (agent) { const editor = editorOf(agent); editor.showDiff = !editor.showDiff; rerenderFocusing(`[data-action="agents:instructions-diff"][data-id="${selectorValue(agent.id)}"]`); } return true; }
      case 'agents:instructions-keep': {
        if (!agent) return true;
        const editor = editorOf(agent);
        if (editor.conflict?.version) editor.baseVersion = editor.conflict.version;
        editor.conflict = null; editor.showDiff = false; rerenderFocusing(areaSelector(agent.id));
        toasts.show({ message: t('Sua versão foi mantida no editor. Salve para substituir a versão atual.'), tone: 'info' });
        return true;
      }
      case 'agents:instructions-take': {
        if (!agent) return true;
        const editor = editorOf(agent), theirs = editor.conflict?.text ?? editor.base;
        Object.assign(editor, { base: theirs, baseVersion: editor.conflict?.version ?? editor.baseVersion, conflict: null, showDiff: false, previous: null, fileReviewRequired: false }); setDraft(editor, theirs); rerenderFocusing(areaSelector(agent.id));
        return true;
      }
      case 'agents:autopilot-discard': {
        if (autopilotDrafts.get(editorKey(id))?.saving) return true;
        autopilotDrafts.delete(editorKey(id)); rerenderFocusing('form[data-form="agents:autopilot"] [name="enabled"]'); return true;
      }
      case 'agents:leave-cancel': {
        if (agent) { const editor = route?.params?.agentTab === 'access' ? autopilotDrafts.get(editorKey(id)) : editorOf(agent); if (editor) editor.leave = null; rerenderFocusing(route?.params?.agentTab === 'access' ? 'form[data-form="agents:autopilot"] [name="enabled"]' : areaSelector(agent.id)); } return true;
      }
      case 'agents:leave-discard': {
        if (!agent) return true;
        const autonomy = route?.params?.agentTab === 'access' && autopilotDrafts.get(editorKey(id));
        if (autonomy) { if (autonomy.saving) return true; const target = autonomy.leave; autopilotDrafts.delete(editorKey(id)); go(target); if (!target?.href) rerender(); return true; }
        const editor = editorOf(agent), target = editor.leave;
        Object.assign(editor, { draft: editor.base, conflict: null, leave: null, showDiff: false, previous: null, fileReviewRequired: false });
        go(target); if (!target?.href) rerender();
        return true;
      }
      case 'agents:toggle-run': {
        const target = element?.getAttribute?.('aria-controls'), row = target && globalThis.document?.getElementById?.(target);
        if (row) { row.hidden = !row.hidden; element.setAttribute('aria-expanded', String(!row.hidden)); }
        return true;
      }
      case 'agents:tool-grants': if (typeof deps.grants?.tools === 'function') await deps.grants.tools(id); return true;
      case 'agents:knowledge-grants': if (typeof deps.grants?.knowledge === 'function') await deps.grants.knowledge(id); return true;
      default: return false;
    }
  }

  /** data-form="agents:…" forms of the detail; true when handled. Errors become toasts (never posted). */
  async function submit(form) {
    const name = form?.dataset?.form;
    const handlers = { 'agents:instructions': saveInstructions, 'agents:tool-policy': savePolicy, 'agents:autopilot': saveAutopilot, 'agents:preview': runPreview, 'agents:knowledge-search': searchKnowledge };
    if (!handlers[name]) return false;
    try { await handlers[name](form); } catch (error) { fail(error); }
    return true;
  }

  /** "Desfazer modelo": the text replaced by the last template comes back (the editor's value is set by code, so Ctrl+Z cannot). */
  function undoTemplate(editor) {
    if (editor.previous === null) return;
    const previous = editor.previous;
    editor.previous = null;
    setDraft(editor, previous, { selectionStart: previous.length });
  }

  /** Company or workspace changed: transient state goes; unsaved instructions stay keyed by company. */
  function reset() { for (const record of responseProjections.values()) if (record.timer) clearTimeout(record.timer); responseProjections.clear(); profileGeneration++; route = null; focus = null; focusTarget = null; previews.clear(); searches.clear(); for (const draft of autopilotDrafts.values()) draft.leave = null; for (const editor of editors.values()) { editor.conflict = null; editor.leave = null; editor.saving = false; editor.fileImport = null; } }

  return { view, act, submit, reset, mount, dirty: () => Boolean(dirty()), repaintRuns,
    /** The "Últimos 7 dias" card of the overview (the hub redraws it when the usage report arrives). */
    overviewUsage: agentId => { const agent = findAgent(agentId); return agent ? overviewUsage(agent, context()) : ''; } };
}

