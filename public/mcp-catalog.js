// What a connected agent can do in the panel: capability → elozi_* MCP tools (FRONTEND-V2 §5.3.2
// Acesso, §5.3.3 step 2, §8.7). Owned by P6 (P5 reads it). Extracted in P1 (commit 1f) from the tool
// definitions of src/service-mcp.js, in their order; tests/mcp-catalog.test.js (P6) and
// tests/frontend-seams.test.js (P1) check every name and capability against that file, so a tool added
// on the server fails until it is listed here.
//
// Two lists:
// - MCP_CAPABILITY_TOOLS: the tools the server defines today (available). Must equal src/service-mcp.js.
// - MCP_PLANNED_TOOLS: tools the server announces before serving them, shown as "em breve" and never
//   offered as available. Each one names a capability of its own that the server will validate, never an
//   existing one: an existing grant would silently extend to the new tool without a new consent. Empty
//   today. A planned capability becomes selectable only when the server lists it
//   (GET /api/tenants/:id/service-principals → capabilities).
//
// The agent as attendant (src/service-mcp.js, "Seu Hermes como atendente" in docs/AGENT-CONNECTIONS.md):
// events.read and conversation.manage are capabilities of their own, but the server put elozi_send_reply
// under reply.send, so reply.send now means "send without review" in the selected groups AND in the private
// conversations assigned to the identity's MCP agent. Its label says both, so no screen presents it as a
// group-only grant.
//
// The elozi_* names are protocol contracts and stay as they are on every workspace (§9); the labels
// below are brand-neutral (no product or engine name), so they can be shown to resale clients.
import { labels, t as i18nText } from './i18n.js';
import './locales-agent-connect.js';

/** Tools every identity has, whatever its capabilities. */
export const MCP_ALWAYS_TOOLS = Object.freeze(['elozi_me', 'elozi_get_receipt']);

/** capability (src/service-principals.js SERVICE_CAPABILITIES) → tools it unlocks. */
export const MCP_CAPABILITY_TOOLS = Object.freeze({
  'conversation.read': Object.freeze(['elozi_read_conversation', 'elozi_read_attachment', 'elozi_list_conversations', 'elozi_search_conversations', 'elozi_read_conversation_history', 'elozi_list_groups', 'elozi_read_group_history']),
  'reply.draft': Object.freeze(['elozi_request_draft']),
  'reply.submit': Object.freeze(['elozi_submit_draft']),
  'reply.send': Object.freeze(['elozi_send_group_message', 'elozi_send_reply']),
  'message.schedule': Object.freeze(['elozi_schedule_group_message']),
  'handoff.request': Object.freeze(['elozi_request_human_support']),
  'company.read': Object.freeze(['elozi_read_company']),
  'company.propose': Object.freeze(['elozi_propose_flow', 'elozi_propose_agent']),
  'events.read': Object.freeze(['elozi_wait_for_events']),
  'conversation.manage': Object.freeze(['elozi_claim_conversation', 'elozi_transfer_to_human', 'elozi_hand_over_to_agent', 'elozi_set_tags', 'elozi_close_conversation']),
  // "Digitando…" only where the agent may answer; no message, quota or receipt (src/service-typing.js).
  'presence.typing': Object.freeze(['elozi_send_typing'])
});

/** Capabilities known to the catalog, in the order of the tool definitions. */
export const MCP_CAPABILITIES = Object.freeze(Object.keys(MCP_CAPABILITY_TOOLS));

/** Product-backend REST grants have no MCP tool and never appear in the attendant wizard. */
// contact.read has no tool of its own: it adds contactPhone to the conversation read of a product backend.
export const REST_ONLY_CAPABILITIES = Object.freeze(['contact.read','notification.send','notification.read','notification.recipient.manage']);

/**
 * Capabilities that publish without a person reviewing each message ("Ações diretas", §5.3.3): in the
 * selected groups and, for reply.send, also in the private conversations assigned to the MCP agent.
 */
export const MCP_DIRECT_ACTIONS = Object.freeze(['reply.send', 'message.schedule']);

/**
 * Tools announced but not served yet: {name, capability}, the capability being a new one the server will
 * check (never one of MCP_CAPABILITIES). None while the server announces none.
 */
export const MCP_PLANNED_TOOLS = Object.freeze([]);

/** Capabilities that exist only in the planned list (the server does not accept them yet). */
export const MCP_PLANNED_CAPABILITIES = Object.freeze([...new Set(MCP_PLANNED_TOOLS.map(tool => tool.capability))].filter(capability => !MCP_CAPABILITIES.includes(capability)));

/** The elozi_* tools that `capabilities` unlock (plus the ones every identity has), in server order. */
export function toolsForCapabilities(capabilities = []) {
  const chosen = new Set(capabilities);
  return [...MCP_ALWAYS_TOOLS, ...MCP_CAPABILITIES.filter(capability => chosen.has(capability)).flatMap(capability => MCP_CAPABILITY_TOOLS[capability])];
}

/** Planned tools (not served yet) that `capabilities` would unlock, in announcement order. */
export function plannedToolsForCapabilities(capabilities = []) {
  const chosen = new Set(capabilities);
  return MCP_PLANNED_TOOLS.filter(tool => chosen.has(tool.capability) && MCP_PLANNED_CAPABILITIES.includes(tool.capability) && isPlannedTool(tool.name)).map(tool => tool.name);
}

/** Capability that unlocks `tool` (null for the tools every identity has or unknown names). */
export function capabilityOfTool(tool) {
  return MCP_CAPABILITIES.find(capability => MCP_CAPABILITY_TOOLS[capability].includes(tool))
    || MCP_PLANNED_TOOLS.find(entry => entry.name === tool)?.capability || null;
}

/** True when `tool` is announced but not served yet. */
export function isPlannedTool(tool) {
  return MCP_PLANNED_TOOLS.some(entry => entry.name === tool) && !MCP_CAPABILITIES.some(capability => MCP_CAPABILITY_TOOLS[capability].includes(tool));
}

/**
 * Capabilities the server accepts, from the list returned by GET /api/tenants/:id/service-principals
 * ({capabilities}); without that list, the served catalog. Unknown names are dropped.
 */
export function acceptedCapabilities(serverCapabilities) {
  const known = new Set([...MCP_CAPABILITIES, ...MCP_PLANNED_CAPABILITIES]);
  return Array.isArray(serverCapabilities) && serverCapabilities.length
    ? [...new Set(serverCapabilities.filter(capability => typeof capability === 'string' && known.has(capability)))]
    : [...MCP_CAPABILITIES];
}

/** Brand-neutral label of each capability (PT key, EN in locales-agent-connect.js). */
export const MCP_CAPABILITY_LABELS = labels({
  'conversation.read': 'Ler atendimentos',
  'reply.draft': 'Pedir rascunho ao copiloto gerenciado',
  'reply.submit': 'Entregar rascunhos para revisão',
  'reply.send': 'Enviar sem revisão nos grupos autorizados e nas conversas atribuídas ao agente',
  'message.schedule': 'Agendar nos grupos autorizados',
  'handoff.request': 'Pedir apoio à equipe',
  'company.read': 'Ler a estrutura da empresa',
  'company.propose': 'Propor fluxos e agentes para aprovação',
  'events.read': 'Receber eventos do atendimento',
  'conversation.manage': 'Assumir, transferir, etiquetar e encerrar conversas',
  'presence.typing': 'Mostrar "digitando…" ao cliente nas conversas atribuídas ao agente',
  'contact.read': 'Ler o telefone do contato (WhatsApp)'
});

/** Brand-neutral description of each tool (a planned tool adds its own label here). */
export const MCP_TOOL_LABELS = labels({
  elozi_me: 'Confere a própria identidade, a empresa, os limites e a validade',
  elozi_get_receipt: 'Consulta o próprio recibo sem repetir a ação',
  elozi_read_conversation: 'Lê um atendimento autorizado',
  elozi_read_attachment: 'Lê um comprovante quando a política privada autoriza',
  elozi_list_conversations: 'Lista os atendimentos do escopo',
  elozi_search_conversations: 'Encontra conversas por contato ou assunto',
  elozi_read_conversation_history: 'Lê mensagens anteriores do atendimento',
  elozi_list_groups: 'Lista os grupos selecionados',
  elozi_read_group_history: 'Lê o histórico de um grupo selecionado',
  elozi_request_draft: 'Pede um rascunho ao copiloto gerenciado',
  elozi_submit_draft: 'Entrega um rascunho para a equipe revisar',
  elozi_send_group_message: 'Envia texto em um grupo autorizado',
  elozi_schedule_group_message: 'Agenda texto em um grupo autorizado',
  elozi_request_human_support: 'Pede apoio de uma pessoa da equipe',
  elozi_read_company: 'Lê canais, departamentos, agentes e fluxos da empresa',
  elozi_propose_flow: 'Propõe um fluxo em rascunho para aprovação',
  elozi_propose_agent: 'Propõe um novo agente para aprovação',
  elozi_send_reply: 'Responde ao cliente nas conversas atribuídas ao agente',
  elozi_wait_for_events: 'Espera novas mensagens e atribuições',
  elozi_claim_conversation: 'Assume uma conversa da fila',
  elozi_transfer_to_human: 'Passa a conversa para a equipe',
  elozi_hand_over_to_agent: 'Repassa a conversa a outro agente conectado',
  elozi_set_tags: 'Ajusta as etiquetas da conversa',
  elozi_close_conversation: 'Encerra a conversa já respondida',
  elozi_send_typing: 'Mostra "digitando…" ao cliente enquanto o agente prepara a resposta'
});

// The internal MCP server keeps the name it was created with (mcp-ui.js creates it with this one). Every
// screen shows that default as "Consultas internas", so the platform brand stays out of customer workspaces.
export const INTERNAL_MCP_NAME = 'Elozi interna';
export const mcpServerLabel = name => name === INTERNAL_MCP_NAME ? i18nText('Consultas internas') : name;
