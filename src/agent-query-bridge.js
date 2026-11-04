import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { SERVICE_CAPABILITIES } from './service-principals.js';

const identifier = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' };
const alias = { ...identifier, maxLength: 40 }, requestId = { ...identifier, minLength: 8 };
const continuation = { type: 'string', minLength: 1, maxLength: 2400, pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$' };
const timestamp = { type: 'string', maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})$' };
const version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const eventTypes = ['conversation.created', 'conversation.message', 'conversation.updated', 'conversation.removed'];
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const ajv = new Ajv({ strict: true, allErrors: false });
const capabilities = new Set(SERVICE_CAPABILITIES);
const definitions = [
  { name: 'elozi_connections', title: 'Empresas conectadas', description: 'Confere as identidades de serviço já conectadas, empresas e capacidades atuais. O catálogo não concede permissão: cada ação exige a capacidade da identidade escolhida e continua sujeita ao escopo do servidor. Não revela endpoints ou credenciais.', inputSchema: schema({}) },
  { name: 'elozi_search_all', title: 'Encontrar atendimento nas empresas conectadas', description: 'Busca mensagens públicas registradas em até oito conexões autorizadas, com no máximo quatro consultas simultâneas. Agrupa cada resultado por conexão e empresa; falhas parciais ficam explícitas. requestId estável reconcilia a mesma busca sem consumir nova cota.',
    inputSchema: schema({ requestId, query: { type: 'string', minLength: 2, maxLength: 200, pattern: '\\S' }, connections: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: alias }, cursors: { type: 'array', minItems: 1, maxItems: 8, items: schema({ connectionId: alias, cursor: continuation }) }, status: { type: 'string', enum: ['all', 'open', 'pending', 'closed'] }, after: timestamp, before: timestamp, limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['requestId', 'query']) },
  { name: 'elozi_read_context', title: 'Ler contexto registrado de um atendimento', description: 'Lê mensagens públicas anteriores na conexão indicada. Usa janela padrão de sete dias, máximo de 31 dias e cursor de continuação vinculado à identidade. Não importa histórico do aparelho nem envia mensagens.',
    inputSchema: schema({ requestId, connectionId: alias, conversationId: identifier, after: timestamp, before: timestamp, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: continuation }, ['requestId', 'connectionId', 'conversationId']) },
  ...[
    ['elozi_submit_draft', 'Apresentar rascunho externo', 'reply.submit', 'Apresenta texto para revisão humana; não envia ao cliente.', { text: text(8000) }],
    ['elozi_claim_conversation', 'Assumir atendimento da fila', 'conversation.manage', 'Assume somente conversa privada da fila, sem pessoa ou outro agente responsável.', {}],
    ['elozi_send_reply', 'Responder no atendimento do agente', 'reply.send', 'Responde somente na conversa privada atribuída ao agente MCP. Pedido de pessoa, insatisfação ou mídia exigem transferência; o servidor limita respostas por hora.', { text: text(4000) }],
    ['elozi_transfer_to_human', 'Passar atendimento para a equipe', 'conversation.manage', 'Transfere atendimento do próprio agente à fila ou departamento ativo autorizado.', { reason: text(500), departmentId: identifier }, ['reason']],
    ['elozi_set_tags', 'Definir etiquetas do atendimento', 'conversation.manage', 'Substitui etiquetas do atendimento do próprio agente ou da fila sem responsável.', { tags: { type: 'array', maxItems: 20, uniqueItems: true, items: text(48) } }],
    ['elozi_close_conversation', 'Encerrar atendimento do agente', 'conversation.manage', 'Encerra atendimento do próprio agente; o servidor recusa cliente ainda sem resposta.', { reason: { type: 'string', maxLength: 240 } }, []],
    ['elozi_request_human_support', 'Pedir apoio humano', 'handoff.request', 'Registra pedido de apoio; não transfere nem envia mensagem.', { reason: text(500) }],
    ['elozi_send_group_message', 'Enviar texto ao grupo autorizado', 'reply.send', 'Envia texto somente em grupo já selecionado no canal e autorizado pela identidade.', { text: text(4000) }],
    ['elozi_schedule_group_message', 'Agendar texto no grupo autorizado', 'message.schedule', 'Agenda texto no grupo selecionado; identidade, validade e escopo são novamente verificados no disparo.', { text: text(4000), dueAt: timestamp }]
  ].map(([name, title, capability, description, extra, required = Object.keys(extra)]) => ({ name, title, capability, write: true,
    description: `${description} Requer ${capability} na conexão explícita, versão atual e requestId estável. Uma ação por chamada; resultado incerto exige elozi_get_receipt, sem reenvio automático.`,
    inputSchema: schema({ connectionId: alias, requestId, conversationId: identifier, version, ...extra }, ['connectionId', 'requestId', 'conversationId', 'version', ...required]) })),
  { name: 'elozi_get_receipt', title: 'Reconciliar recibo sem repetir ação', description: 'Consulta o recibo da requestId original somente na conexão indicada, com a identidade e escopo atuais. Não despacha, não reenvia nem consome cota. Em servidor antigo sem esta ferramenta, use a API REST ou a administração autorizada para reconciliar; não repita a ação.',
    inputSchema: schema({ connectionId: alias, requestId }) },
  { name: 'elozi_wait_for_events', title: 'Aguardar mudanças na conexão autorizada', capability: 'events.read', description: 'Requer events.read na conexão indicada. Aguarda até 25 segundos por ponteiros de atendimentos, sem texto, em uma empresa. Guarde o cursor; resync pede nova leitura. Não habilita grupos ou canais nem repete ações.',
    inputSchema: schema({ connectionId: alias, requestId, cursor: { type: 'string', minLength: 1, maxLength: 120 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000 }, types: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: eventTypes } } }, ['connectionId']) }
].map(definition => ({ ...definition, validate: ajv.compile(definition.inputSchema) }));
const safeId = (value, max = 120) => typeof value === 'string' && value.length >= 1 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const statusOf = error => {
  if (error?.name === 'UnauthorizedError') return 401;
  const value = error?.status ?? error?.code;
  return Number.isInteger(value) && value >= 400 && value < 600 ? value : 502;
};
const messages = {
  400: 'Informe somente os campos e limites permitidos para a solicitação.', 401: 'A credencial desta conexão perdeu validade.',
  403: 'A identidade não tem acesso a esta solicitação.', 404: 'O contexto ou recibo solicitado não foi encontrado nesta conexão.',
  409: 'A configuração, versão ou solicitação mudou. Leia o estado e reconcilie antes de agir.', 429: 'A conexão atingiu sua cota atual.',
  503: 'A conexão está indisponível.', 504: 'A conexão não respondeu dentro do prazo.'
};
const safeError = status => ({ status, message: messages[status] || 'A conexão não pôde concluir a solicitação.' });
const failure = status => Object.assign(new Error(safeError(status).message), { status });
function instant(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw failure(400);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19) || 0) > 59 || !Number.isFinite(Date.parse(value))) throw failure(400);
}

/** Configuration is private, immutable and never accepted through an MCP tool. */
export function validateAgentQueryConfig(config, { allowHttpLoopback = false } = {}) {
  if (!plain(config) || Reflect.ownKeys(config).some(key => key !== 'connections') || !Array.isArray(config.connections) || config.connections.length < 1 || config.connections.length > 8) throw failure(400);
  const aliases = new Set();
  return { connections: config.connections.map(connection => {
    if (!plain(connection) || Reflect.ownKeys(connection).some(key => !['id', 'name', 'endpoint', 'tokenEnv'].includes(key)) || !safeId(connection.id, 40) || aliases.has(connection.id)
      || typeof connection.name !== 'string' || connection.name.trim().length < 1 || connection.name.length > 80 || /[\x00-\x1f\x7f]/.test(connection.name)
      || typeof connection.endpoint !== 'string' || connection.endpoint.length > 2048 || typeof connection.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(connection.tokenEnv)) throw failure(400);
    let endpoint; try { endpoint = new URL(connection.endpoint); } catch { throw failure(400); }
    const loopback = allowHttpLoopback === true && endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if ((!loopback && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/agent/mcp' || connection.endpoint !== endpoint.origin + '/api/agent/mcp') throw failure(400);
    aliases.add(connection.id);
    return Object.freeze({ id: connection.id, name: connection.name.trim(), endpoint: connection.endpoint, tokenEnv: connection.tokenEnv });
  }) };
}
export async function loadAgentQueryConfig({ env = process.env } = {}) {
  const path = env.ELOZI_MCP_CONFIG_PATH;
  if (typeof path !== 'string' || !path || path.length > 4096 || !isAbsolute(path)) throw failure(400);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 16384) throw failure(400);
    return validateAgentQueryConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch { throw failure(400); }
}

async function defaultClientFactory(connection, { token, signal, timeoutMs }) {
  const client = new Client({ name: 'elozi-agent-query-bridge', version: '0.44.0' });
  const transport = new StreamableHTTPClientTransport(new URL(connection.endpoint), {
    requestInit: { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: (target, init = {}) => {
      if (String(target) !== connection.endpoint) throw failure(502);
      return fetch(target, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
    }
  });
  try { await client.connect(transport, { signal, timeout: timeoutMs }); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}

/** Explicitly routed operations, several separate server-enforced service identities. */
class AgentQueryBridge {
  #connections; #env; #clientFactory; #clients = new Map(); #timeoutMs; #closed = false;
  #active = 0; #waiting = []; #controllers = new Set(); #secrets; #actions = new Map();
  constructor(config, { env = process.env, clientFactory = defaultClientFactory, allowHttpLoopback = false, timeoutMs = 15000 } = {}) {
    this.#connections = validateAgentQueryConfig(config, { allowHttpLoopback }).connections;
    if (typeof clientFactory !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 15000) throw failure(400);
    this.#env = env; this.#clientFactory = clientFactory; this.#timeoutMs = timeoutMs;
    this.#secrets = this.#connections.flatMap(connection => [env[connection.tokenEnv], connection.endpoint]).filter(value => typeof value === 'string' && value.length > 0);
  }
  tools() {
    return definitions.map(({ name, title, description, inputSchema, write }) => ({ name, title, description, inputSchema, annotations: { readOnlyHint: !write, destructiveHint: Boolean(write), idempotentHint: true, openWorldHint: true } }));
  }
  #text(value, max) {
    let text = typeof value === 'string' ? value.toWellFormed().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') : '';
    for (const secret of this.#secrets) text = text.split(secret).join('[dado privado omitido]');
    return text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
  }
  #label(value, max) { return this.#text(value, max).replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi, '[link omitido]'); }
  #id(value, max = 120) { if (!safeId(value, max) || this.#secrets.some(secret => value.includes(secret))) throw failure(502); return value; }
  async #client(connection, signal) {
    if (this.#closed) throw failure(503);
    let entry = this.#clients.get(connection.id);
    if (!entry) {
      const token = this.#env[connection.tokenEnv];
      if (typeof token !== 'string' || !/^elozi_svc_[A-Za-z0-9_-]{43}$/.test(token)) throw failure(401);
      entry = { client: null, promise: null };
      entry.promise = Promise.resolve().then(() => this.#clientFactory(connection, { token, signal, timeoutMs: this.#timeoutMs })).then(async client => {
        if (!client || typeof client.callTool !== 'function' || typeof client.close !== 'function') throw failure(502);
        if (this.#closed || signal.aborted || this.#clients.get(connection.id) !== entry) { await this.#closeClient(client); throw failure(503); }
        entry.client = client;
        return client;
      });
      this.#clients.set(connection.id, entry);
      entry.promise.catch(() => { if (this.#clients.get(connection.id) === entry) this.#clients.delete(connection.id); });
    }
    return entry.promise;
  }
  async #closeClient(client) {
    let timer;
    try { await Promise.race([Promise.resolve().then(() => client.close()), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
    catch {} finally { clearTimeout(timer); }
  }
  async #discard(connection) {
    const entry = this.#clients.get(connection.id); this.#clients.delete(connection.id);
    if (entry?.client) await this.#closeClient(entry.client);
  }
  async #slot(action, timeoutMs = this.#timeoutMs) {
    if (this.#closed) throw failure(503);
    if (this.#active >= 4) await new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
    if (this.#closed) throw failure(503);
    this.#active++;
    const controller = new AbortController(); this.#controllers.add(controller);
    let timer;
    try {
      return await Promise.race([action(controller.signal), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure(504)); }, timeoutMs); })]);
    } finally {
      clearTimeout(timer); this.#controllers.delete(controller); this.#active--; this.#waiting.shift()?.resolve();
    }
  }
  async #call(client, name, args, signal, timeoutMs = this.#timeoutMs) {
    const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs });
    if (result?.isError) throw failure(statusOf(result.structuredContent?.error));
    if (!plain(result?.structuredContent)) throw failure(502);
    return result.structuredContent;
  }
  async #identity(client, signal) {
    const me = await this.#call(client, 'elozi_me', {}, signal), principal = me.principal;
    if (!plain(principal) || !Array.isArray(principal.capabilities) || principal.capabilities.length > 20) throw failure(502);
    return { tenantId: this.#id(principal.tenantId), principalName: this.#text(principal.name, 80), capabilities: [...new Set(principal.capabilities.filter(value => capabilities.has(value)))],
      ...(principal.id === undefined ? {} : { principalId: this.#id(principal.id) }), ...(principal.workspaceId === undefined ? {} : { workspaceId: this.#id(principal.workspaceId) }),
      ...(principal.agentId === undefined ? {} : { agentId: this.#id(principal.agentId) }) };
  }
  #remoteRequestId(operation, input, connection) {
    const page = input.cursor ? createHash('sha256').update(input.cursor).digest('hex') : 'initial';
    return 'bridge_' + createHash('sha256').update([operation, input.requestId, connection.id, page].join('\0')).digest('hex');
  }
  #origin(connection, identity) {
    if (!identity.principalId || !identity.workspaceId || !identity.agentId) throw failure(502);
    return { connectionId: connection.id, name: this.#text(connection.name, 80), tenantId: identity.tenantId, workspaceId: identity.workspaceId, principalId: identity.principalId, agentId: identity.agentId };
  }
  #groupId(value) {
    if (typeof value !== 'string' || !/^(?:\d+(?:-\d+)?@g\.us|-[1-9]\d{0,15})$/.test(value) || this.#secrets.some(secret => value.includes(secret))) throw failure(502);
    return value;
  }
  #outcome(value, identity, conversationId) {
    if (value === null || value === undefined) return null;
    if (!plain(value)) throw failure(502);
    const output = {};
    for (const key of ['id', 'conversationId', 'channelId', 'departmentId', 'agentId', 'serviceId', 'messageId', 'scheduledId']) {
      if (Object.hasOwn(value, key)) output[key] = value[key] === null ? null : this.#id(value[key], key === 'messageId' ? 160 : 120);
    }
    if (output.conversationId !== undefined && output.conversationId !== conversationId || output.serviceId !== undefined && output.serviceId !== identity.principalId || output.agentId !== undefined && output.agentId !== identity.agentId) throw failure(502);
    for (const key of ['version', 'conversationVersion']) {
      if (Object.hasOwn(value, key)) { if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw failure(502); output[key] = value[key]; }
    }
    for (const key of ['state', 'operation', 'owner', 'status']) {
      if (Object.hasOwn(value, key)) { if (typeof value[key] !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(value[key])) throw failure(502); output[key] = this.#id(value[key], 40); }
    }
    for (const key of ['dueAt', 'createdAt', 'updatedAt']) if (Object.hasOwn(value, key)) output[key] = this.#text(value[key], 40);
    for (const [key, max] of [['draft', 8000], ['reason', 500]]) if (Object.hasOwn(value, key)) output[key] = value[key] === null ? null : this.#text(value[key], max);
    if (Object.hasOwn(value, 'tags')) {
      if (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some(tag => typeof tag !== 'string')) throw failure(502);
      output.tags = value.tags.map(tag => this.#text(tag, 48));
    }
    if (Object.hasOwn(value, 'groupId')) output.groupId = this.#groupId(value.groupId);
    if (Object.hasOwn(value, 'humanApprovalRequired')) { if (typeof value.humanApprovalRequired !== 'boolean') throw failure(502); output.humanApprovalRequired = value.humanApprovalRequired; }
    for (const key of ['run', 'request']) if (Object.hasOwn(value, key)) output[key] = this.#outcome(value[key], identity, conversationId);
    return output;
  }
  #receipt(value, identity, input, capability) {
    if (!plain(value) || !plain(value.context) || !['reserved', 'dispatched', 'confirmed', 'failed', 'unknown', 'invalidated'].includes(value.state)
      || value.tenantId !== identity.tenantId || value.workspaceId !== identity.workspaceId || value.principalId !== identity.principalId || value.agentId !== identity.agentId
      || value.requestId !== input.requestId || !capabilities.has(value.capability) || capability && value.capability !== capability || typeof value.stale !== 'boolean') throw failure(502);
    const context = value.context, conversationId = this.#id(context.conversationId);
    if (context.tenantId !== identity.tenantId || context.workspaceId !== identity.workspaceId || context.agentId !== identity.agentId
      || input.conversationId !== undefined && conversationId !== input.conversationId || input.version !== undefined && context.conversationVersion !== input.version
      || !Number.isSafeInteger(context.conversationVersion) || context.conversationVersion < 1) throw failure(502);
    const output = { id: this.#id(value.id), principalId: identity.principalId, requestId: input.requestId, workspaceId: identity.workspaceId, tenantId: identity.tenantId, agentId: identity.agentId,
      capability: value.capability, context: { workspaceId: identity.workspaceId, tenantId: identity.tenantId, agentId: identity.agentId, conversationId, conversationVersion: context.conversationVersion,
        channelId: this.#id(context.channelId), departmentId: this.#id(context.departmentId) }, state: value.state, stale: value.stale, result: this.#outcome(value.result, identity, conversationId),
      reason: value.reason === null || value.reason === undefined ? null : this.#label(value.reason, 500), budgetKind: 'estimated' };
    for (const key of ['revision', 'keyRevision', 'units', 'reservedCostMicros', 'chargedCostMicros']) {
      if (!Number.isSafeInteger(value[key]) || value[key] < (['revision', 'keyRevision'].includes(key) ? 1 : 0)) throw failure(502);
      output[key] = value[key];
    }
    if (typeof value.adapterHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.adapterHash)) throw failure(502);
    output.adapterHash = value.adapterHash;
    for (const key of ['createdAt', 'updatedAt', 'expiresAt']) { try { instant(value[key]); } catch { throw failure(502); } if (value[key] === undefined) throw failure(502); output[key] = value[key]; }
    if (context.conversationKind !== undefined) {
      if (context.conversationKind !== 'group' || !['baileys', 'telegram-bot'].includes(context.channelTransport)) throw failure(502);
      Object.assign(output.context, { conversationKind: 'group', groupId: this.#groupId(context.groupId), channelTransport: context.channelTransport });
    }
    return output;
  }
  #recovery(record, state = 'unknown') {
    return { ...record.origin, operation: record.operation, requestId: record.requestId, conversationId: record.conversationId, version: record.version,
      receiptId: record.receiptId ?? null, state, reconciliationRequired: state !== 'invalidated', reconcileWith: 'elozi_get_receipt', automaticRetry: false };
  }
  #remember(key, record) {
    // Unknown, in-flight and invalidated outcomes cannot become replayable through eviction.
    if (this.#actions.size >= 256) {
      const removable = [...this.#actions].find(([, value]) => !['in_progress', 'invalidated'].includes(value.state) && !value.reconciliationRequired);
      if (!removable) throw failure(429);
      this.#actions.delete(removable[0]);
    }
    this.#actions.set(key, record);
  }
  #events(value, identity, connection, input) {
    if (!plain(value) || !Array.isArray(value.events) || value.events.length > 50 || typeof value.resync !== 'boolean' || typeof value.timedOut !== 'boolean'
      || typeof value.cursor !== 'string' || !/^[0-9a-f]{12}-[0-9a-z]{1,11}\.[A-Za-z0-9_-]{32}$/.test(value.cursor) || input.requestId !== undefined && value.requestId !== input.requestId) throw failure(502);
    const output = { ...this.#origin(connection, identity), ...(input.requestId ? { requestId: input.requestId } : {}), cursor: value.cursor, resync: value.resync, timedOut: value.timedOut,
      events: value.events.map(event => {
        if (!plain(event) || !eventTypes.includes(event.type)) throw failure(502);
        const item = { type: event.type, at: this.#text(event.at, 40), conversationId: this.#id(event.conversationId) };
        if (event.version !== null && event.version !== undefined) { if (!Number.isSafeInteger(event.version) || event.version < 1) throw failure(502); item.version = event.version; }
        if (event.left === true) return { ...item, left: true };
        for (const key of ['channelId', 'departmentId', 'messageId']) if (Object.hasOwn(event, key)) item[key] = event[key] === null ? null : this.#id(event[key], key === 'messageId' ? 160 : 120);
        for (const [key, allowed] of [['status', ['open', 'pending', 'closed']], ['owner', ['queue', 'human', 'agent']], ['kind', ['customer', 'human', 'agent']]]) {
          if (Object.hasOwn(event, key)) { if (event[key] !== null && !allowed.includes(event[key])) throw failure(502); item[key] = event[key]; }
        }
        if (Object.hasOwn(event, 'assignedToMe')) { if (typeof event.assignedToMe !== 'boolean') throw failure(502); item.assignedToMe = event.assignedToMe; }
        if (Object.hasOwn(event, 'changes')) { if (!Array.isArray(event.changes) || event.changes.length > 30) throw failure(502); item.changes = event.changes.map(change => this.#id(change, 48)); }
        return item;
      }) };
    if (this.#secrets.some(secret => value.cursor.includes(secret)) || Buffer.byteLength(JSON.stringify(output)) > 65536) throw failure(502);
    return output;
  }
  async #single(tool, input, connection) {
    let record, dispatched = false;
    const timeoutMs = this.#timeoutMs + (tool.name === 'elozi_wait_for_events' ? input.timeoutMs ?? 20000 : 0);
    try {
      return await this.#slot(async signal => {
        const client = await this.#client(connection, signal), identity = await this.#identity(client, signal), origin = this.#origin(connection, identity);
        if (tool.capability && !identity.capabilities.includes(tool.capability)) throw failure(403);
        const { connectionId, ...args } = input, key = `${connection.id}\0${input.requestId}`;
        if (tool.write) {
          // Fixed schema order makes JSON field ordering immaterial to a stable request.
          const fingerprint = createHash('sha256').update(JSON.stringify(Object.keys(tool.inputSchema.properties).filter(key => key !== 'connectionId').map(key => [key, input[key] ?? null]))).digest('hex');
          const prior = this.#actions.get(key);
          if (prior) {
            if (prior.origin.principalId !== identity.principalId || prior.origin.tenantId !== identity.tenantId) throw failure(409);
            if (prior.state === 'invalidated') throw Object.assign(failure(409), { recovery: this.#recovery(prior, 'invalidated'), code: 'ACTION_INVALIDATED' });
            if (prior.fingerprint !== fingerprint || prior.operation !== tool.name) throw failure(409);
            if (prior.state === 'in_progress' || prior.reconciliationRequired) throw Object.assign(failure(409), { recovery: this.#recovery(prior, prior.state), code: prior.state === 'in_progress' ? 'ACTION_IN_PROGRESS' : 'ACTION_RECONCILIATION_REQUIRED' });
          }
          record = { origin, operation: tool.name, requestId: input.requestId, conversationId: input.conversationId, version: input.version, fingerprint, state: 'in_progress', reconciliationRequired: false };
          this.#remember(key, record);
        }
        if (signal.aborted || this.#closed) throw failure(503);
        dispatched = Boolean(tool.write);
        const value = await this.#call(client, tool.name, args, signal, timeoutMs);
        if (signal.aborted || this.#closed) throw failure(504);
        if (tool.name === 'elozi_wait_for_events') return this.#events(value, identity, connection, input);
        if (tool.name === 'elozi_get_receipt' && value.tenantId !== identity.tenantId) throw failure(502);
        const receipt = this.#receipt(value.receipt, identity, input, tool.capability), reconciliationRequired = receipt.state !== 'invalidated' && (receipt.stale || ['unknown', 'reserved', 'dispatched'].includes(receipt.state));
        if (record) Object.assign(record, { state: receipt.state, receiptId: receipt.id, reconciliationRequired });
        if (tool.name === 'elozi_get_receipt') {
          const prior = this.#actions.get(key);
          if (prior && prior.origin.principalId === identity.principalId && prior.conversationId === receipt.context.conversationId && prior.version === receipt.context.conversationVersion) Object.assign(prior, { state: receipt.state, receiptId: receipt.id, reconciliationRequired });
          else if (!prior && receipt.state === 'invalidated') this.#remember(key, { origin, operation: 'elozi_get_receipt', requestId: input.requestId,
            conversationId: receipt.context.conversationId, version: receipt.context.conversationVersion, state: 'invalidated', receiptId: receipt.id, reconciliationRequired: false });
        }
        const output = { ...origin, operation: tool.name, requestId: input.requestId, conversationId: receipt.context.conversationId, version: input.version ?? receipt.context.conversationVersion, state: receipt.state, reconciliationRequired, receipt };
        for (const field of ['result', 'run', 'request']) if (Object.hasOwn(value, field)) output[field] = this.#outcome(value[field], identity, receipt.context.conversationId);
        if (Object.hasOwn(value, 'humanApprovalRequired')) { if (typeof value.humanApprovalRequired !== 'boolean') throw failure(502); output.humanApprovalRequired = value.humanApprovalRequired; }
        if (Buffer.byteLength(JSON.stringify(output)) > 65536) throw failure(502);
        return output;
      }, timeoutMs);
    } catch (error) {
      if (![400, 403, 404, 409, 422, 429].includes(statusOf(error))) await this.#discard(connection);
      const safe = failure(statusOf(error));
      if (record && dispatched) {
        Object.assign(record, { state: 'unknown', reconciliationRequired: true });
        Object.assign(safe, { code: 'ACTION_OUTCOME_UNKNOWN', recovery: this.#recovery(record) });
      } else if (error.recovery) Object.assign(safe, { code: error.code, recovery: error.recovery });
      else if (tool.name === 'elozi_get_receipt') Object.assign(safe, { code: 'RECEIPT_UNAVAILABLE', recovery: { connectionId: connection.id, requestId: input.requestId, reconciliationRequired: true, automaticRetry: false, reconcileWith: 'authorized-rest-or-admin' } });
      else if (record) this.#actions.delete(`${connection.id}\0${input.requestId}`);
      throw safe;
    }
  }
  #history(value, tenantId, base) {
    if (!plain(value) || value.tenantId !== tenantId || !Array.isArray(value.messages) || value.messages.length > 100 || !plain(value.coverage)) throw failure(502);
    const output = { ...base, tenantId, channelId: this.#id(value.channelId), conversationId: this.#id(value.conversationId), version: Number.isSafeInteger(value.version) && value.version > 0 ? value.version : null,
      messages: value.messages.map(message => {
        if (!plain(message) || !['customer', 'human', 'agent'].includes(message.kind) || !Array.isArray(message.attachments) || message.attachments.length > 10) throw failure(502);
        return { id: this.#id(message.id, 160), kind: message.kind, text: this.#text(message.text, 12000), senderName: this.#text(message.senderName, 100), createdAt: this.#text(message.createdAt, 40),
          attachments: message.attachments.map(item => ({ id: this.#id(item.id, 160), kind: ['image', 'audio', 'video', 'document', 'sticker'].includes(item.kind) ? item.kind : 'document', name: this.#label(item.name, 160), mime: typeof item.mime === 'string' && /^[A-Za-z0-9!#$&^_.+-]{1,40}\/[A-Za-z0-9!#$&^_.+-]{1,60}$/.test(item.mime) ? item.mime : '', size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null })) };
      }), coverage: this.#coverage(value.coverage, true), nextCursor: this.#cursor(value.nextCursor), receipt: this.#id(value.receipt) };
    while (Buffer.byteLength(JSON.stringify(output)) > 24576) {
      const textFields = output.messages.map(message => ({ object: message, key: 'text' }));
      const labelFields = output.messages.flatMap(message => [{ object: message, key: 'senderName' }, ...message.attachments.map(item => ({ object: item, key: 'name' }))]);
      // Media-only pages still need room for the local alias. Shorten labels, never IDs or pagination.
      const available = textFields.some(field => field.object[field.key].length) ? textFields : labelFields.some(field => field.object[field.key].length) ? labelFields : [{ object: output, key: 'name' }];
      const longest = available.reduce((best, field) => !best || Buffer.byteLength(field.object[field.key]) > Buffer.byteLength(best.object[best.key]) ? field : best, null);
      if (!longest?.object[longest.key]?.length) throw failure(502);
      output.coverage.truncated = true;
      const original = longest.object[longest.key]; let low = 0, high = original.length - 1;
      while (low < high) { const middle = Math.ceil((low + high) / 2); longest.object[longest.key] = original.slice(0, middle).replace(/[\uD800-\uDBFF]$/, ''); if (Buffer.byteLength(JSON.stringify(output)) <= 24576) low = middle; else high = middle - 1; }
      longest.object[longest.key] = original.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
    }
    return output;
  }
  #coverage(value, history = false) {
    if (!plain(value) || !Number.isSafeInteger(value.includedCount) || value.includedCount < 0 || value.includedCount > 100 || typeof value.hasMore !== 'boolean') throw failure(502);
    return { includedCount: value.includedCount, hasMore: value.hasMore, truncated: value.truncated === true, ...(history ? { from: this.#text(value.from, 40), to: this.#text(value.to, 40), availableCount: Number.isSafeInteger(value.availableCount) && value.availableCount >= 0 ? value.availableCount : null, historySource: 'elozi', attachmentsAnalyzed: false } : {}) };
  }
  #cursor(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || value.length > 2400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value) || this.#secrets.some(secret => value.includes(secret))) throw failure(502);
    return value;
  }
  #search(value, tenantId, limit) {
    if (!plain(value) || value.tenantId !== tenantId || !Array.isArray(value.conversations) || value.conversations.length > limit) throw failure(502);
    const output = { tenantId, conversations: value.conversations.map(item => {
      if (!plain(item) || !Array.isArray(item.snippets) || item.snippets.length > 3 || !['all', 'open', 'pending', 'closed'].includes(item.status)) throw failure(502);
      return { conversationId: this.#id(item.conversationId), contact: this.#text(item.contact, 120), channelId: this.#id(item.channelId), departmentId: item.departmentId === null ? null : this.#id(item.departmentId), status: item.status, version: Number.isSafeInteger(item.version) && item.version > 0 ? item.version : null, updatedAt: item.updatedAt === null ? null : this.#text(item.updatedAt, 40),
        snippets: item.snippets.map(snippet => {
          if (!plain(snippet) || !['customer', 'human', 'agent'].includes(snippet.kind)) throw failure(502);
          return { messageId: this.#id(snippet.messageId, 160), kind: snippet.kind, text: this.#text(snippet.text, 160), createdAt: snippet.createdAt === null ? null : this.#text(snippet.createdAt, 40) };
        }) };
    }), coverage: this.#coverage(value.coverage), nextCursor: this.#cursor(value.nextCursor), receipt: this.#id(value.receipt) };
    if (Buffer.byteLength(JSON.stringify(output)) > 65536) throw failure(502);
    return output;
  }
  async invoke(name, input = {}) {
    const tool = definitions.find(value => value.name === name);
    if (!tool || !plain(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string') || !tool.validate(input)) throw failure(400);
    if (this.#closed) throw failure(503);
    if (this.#secrets.some(secret => JSON.stringify(input).includes(secret))) throw failure(400);
    instant(input.dueAt);
    if (tool.write && ['text', 'reason', ...(input.tags ? ['tags'] : [])].some(key => (Array.isArray(input[key]) ? input[key] : [input[key]]).some(value => typeof value === 'string' && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)))) throw failure(400);
    if (tool.write || ['elozi_get_receipt', 'elozi_wait_for_events'].includes(name)) {
      const connection = this.#connections.find(value => value.id === input.connectionId); if (!connection) throw failure(400);
      return this.#single(tool, input, connection);
    }
    if (input.query !== undefined && (input.query.trim().length < 2 || /[\x00-\x1f\x7f]/.test(input.query))) throw failure(400);
    instant(input.after); instant(input.before);
    if (input.after && input.before && (Date.parse(input.after) > Date.parse(input.before) || name === 'elozi_read_context' && (Date.parse(input.before) - Date.parse(input.after) <= 0 || Date.parse(input.before) - Date.parse(input.after) > 31 * 86400000))) throw failure(400);
    let selected = this.#connections;
    if (input.connections) { if (input.connections.some(id => !selected.some(connection => connection.id === id))) throw failure(400); selected = selected.filter(connection => input.connections.includes(connection.id)); }
    const cursors = new Map();
    for (const item of input.cursors || []) { if (cursors.has(item.connectionId) || !selected.some(connection => connection.id === item.connectionId)) throw failure(400); cursors.set(item.connectionId, item.cursor); }
    if (name === 'elozi_read_context') {
      const connection = selected.find(value => value.id === input.connectionId); if (!connection) throw failure(400);
      try {
        return await this.#slot(async signal => {
          const client = await this.#client(connection, signal), identity = await this.#identity(client, signal);
          if (!identity.capabilities.includes('conversation.read')) throw failure(403);
          const { connectionId, ...args } = input;
          const value = await this.#call(client, 'elozi_read_conversation_history', { ...args, requestId: this.#remoteRequestId('history', input, connection) }, signal);
          const result = this.#history(value, identity.tenantId, { connectionId: connection.id, name: this.#text(connection.name, 80) });
          if (result.conversationId !== input.conversationId) throw failure(502);
          return result;
        });
      } catch (error) { await this.#discard(connection); throw failure(statusOf(error)); }
    }
    const results = await Promise.all(selected.map(connection => this.#slot(async signal => {
      const base = { connectionId: connection.id, name: this.#text(connection.name, 80) };
      try {
        const client = await this.#client(connection, signal), identity = await this.#identity(client, signal);
        if (name === 'elozi_connections') return { ...base, ...identity, state: 'available' };
        if (!identity.capabilities.includes('conversation.read')) throw failure(403);
        const { connections, cursors: ignoredCursors, ...args } = input, limit = input.limit ?? 5, cursor = cursors.get(connection.id);
        const value = await this.#call(client, 'elozi_search_conversations', { ...args, limit, ...(cursor ? { cursor } : {}), requestId: this.#remoteRequestId('search', { ...input, cursor }, connection) }, signal);
        return { ...base, ...this.#search(value, identity.tenantId, limit) };
      } catch (error) { await this.#discard(connection); return { ...base, state: 'unavailable', error: safeError(statusOf(error)) }; }
    }).catch(async error => { await this.#discard(connection); return { connectionId: connection.id, name: this.#text(connection.name, 80), state: 'unavailable', error: safeError(statusOf(error)) }; })));
    const output = { connections: results, partial: results.some(result => result.error) };
    if (Buffer.byteLength(JSON.stringify(output)) > 524288) throw failure(502);
    return output;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    for (const waiting of this.#waiting.splice(0)) waiting.reject(failure(503));
    const entries = [...this.#clients.values()]; this.#clients.clear();
    // A factory that ignores abort cannot keep shutdown open; its eventual client is closed above.
    await Promise.allSettled(entries.filter(entry => entry.client).map(entry => this.#closeClient(entry.client)));
  }
}
export const createAgentQueryBridge = (config, options) => new AgentQueryBridge(config, options);
export function createAgentQueryMcpServer(bridge) {
  if (!bridge || typeof bridge.invoke !== 'function' || typeof bridge.tools !== 'function' || typeof bridge.close !== 'function') throw failure(400);
  const server = new Server({ name: 'elozi-agent-query-bridge', version: '0.44.0' }, { capabilities: { tools: {} }, instructions: 'Use os aliases e capacidades atuais de elozi_connections. Cada conexão preserva sua própria identidade, workspace, empresa, canais, grupos selecionados, departamentos e cotas. O catálogo não concede acesso. Ações exigem connectionId explícito, versão atual e requestId estável; nunca há fan-out de escrita, criação de chaves, administração ou ampliação de permissões. Confirmação incerta exige elozi_get_receipt com a mesma conexão/requestId, sem reenviar a ação. As consultas anteriores continuam disponíveis; nenhum produto externo é representado por esta ponte.' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.tools() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try { const data = await bridge.invoke(request.params.name, request.params.arguments ?? {}); return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
    catch (error) {
      if (statusOf(error) === 400) throw new McpError(ErrorCode.InvalidParams, messages[400]);
      const result = { error: { ...safeError(statusOf(error)), ...(error.code && typeof error.code === 'string' ? { code: error.code } : {}) }, ...(error.recovery ? { recovery: error.recovery } : {}) };
      return { content: [{ type: 'text', text: error.recovery ? JSON.stringify(result) : result.error.message }], structuredContent: result, isError: true };
    }
  });
  return server;
}
