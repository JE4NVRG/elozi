import Ajv from 'ajv';
import { ServiceReplyRateLimitError } from './service-reply-limits.js';
import { OwnLinePairError } from './own-lines.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const identifier = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' };
const requestId = { type: 'string', minLength: 8, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' };
const version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const timestamp = { type:'string', maxLength:40, pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})$' };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const reason = { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' };
const eventTypes = ['conversation.created', 'conversation.message', 'conversation.updated', 'conversation.removed'];
const flowGraph = schema({
  nodes: { type: 'array', minItems: 2, maxItems: 100, items: schema({ id: { ...identifier, maxLength: 64 }, type: { type: 'string', enum: ['start', 'condition', 'tag', 'department', 'handoff', 'end'] },
    config: schema({ field: { type: 'string', enum: ['text', 'department', 'owner', 'tag', 'channelKind'] }, operator: { type: 'string', enum: ['contains', 'equals', 'exists'] }, value: { type: 'string', maxLength: 500 }, tag: { type: 'string', maxLength: 48 }, operation: { type: 'string', enum: ['add', 'remove'] }, department: { type: 'string', maxLength: 80 }, owner: { type: 'string', enum: ['human', 'queue'] } }, []) }, ['id', 'type']) },
  edges: { type: 'array', maxItems: 200, items: schema({ from: { ...identifier, maxLength: 64 }, to: { ...identifier, maxLength: 64 }, when: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false'] }] } }, ['from', 'to']) },
  departmentReferenceFormat: { type: 'string', enum: ['id-v1'] }
}, ['nodes', 'edges']);
const ajv = new Ajv({ strict: true, allErrors: false });
const definitions = [
  { name: 'elozi_me', title: 'Minha identidade na Elozi', description: 'Confere a identidade de serviço, empresa, capacidades, validade e cotas atuais. Não fornece identidade humana ou acesso administrativo.',
    inputSchema: schema({}), readOnly: true, invoke: (api, actor) => api.me(actor) },
  { name: 'elozi_get_receipt', title: 'Consultar recibo da própria operação', requiredMethod: 'readReceipt', description: 'Consulta somente o recibo desta identidade pela requestId original, inclusive após resposta perdida. Revalida acesso, escopo e configuração atuais, sem consumir nova cota nem executar a operação. Estado unknown exige reconciliação; não reenvie automaticamente.',
    inputSchema: schema({ requestId }), readOnly: true, invoke: (api, actor, input) => api.readReceipt(actor, input.requestId) },
  { name: 'elozi_read_conversation', title: 'Ler atendimento autorizado', capability: 'conversation.read', description: 'Lê o atendimento no escopo atual de empresa, canal e departamento. Retorna mensagens públicas e metadados de anexos; não inclui notas privadas ou URLs de mídia.',
    inputSchema: schema({ requestId, conversationId: identifier }), readOnly: true, invoke: (api, actor, input) => api.read(actor, input.conversationId, input.requestId) },
  { name: 'elozi_read_attachment', title: 'Ler anexo autorizado da mensagem do cliente', capability: 'conversation.read', requiredMethod: 'readAttachment', description: 'Lê um único JPEG, PNG, WebP, PDF ou áudio OGG/MP3/M4A de até 10 MiB de uma mensagem pública do cliente, somente com política privada exata de empresa/identidade/canal e atendimento atribuído ao agente MCP. Exige IDs e versão atuais. Retorna bytes somente em structuredContent, sem URL nem persistir conteúdo no recibo; releitura com a mesma requestId revalida tudo sem consumir outra cota. Consulte attachmentRead em elozi_me.',
    inputSchema: schema({ requestId, conversationId: identifier, version, messageId: identifier, attachmentId: identifier }), readOnly: true, invoke: (api, actor, input) => api.readAttachment(actor, input) },
  { name: 'elozi_list_conversations', title: 'Descobrir atendimentos autorizados', capability: 'conversation.read', requiredMethod: 'inbox', description: 'Lista páginas de até 50 atendimentos no escopo atual da identidade, com snapshot e cursor autenticado. Retorna metadados para descobrir IDs sem expor histórico, notas ou credenciais. Conclua todas as páginas antes de retomar o cursor de eventos.',
    inputSchema: schema({ requestId, status: { type: 'string', enum: ['open', 'pending', 'closed', 'all'], default: 'all' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, cursor: { type: 'string', maxLength: 2400 } }, ['requestId']),
    readOnly: true, invoke: (api, actor, input) => api.inbox(actor, input) },
  { name: 'elozi_search_conversations', title: 'Encontrar conversa por contato ou assunto', capability: 'conversation.read', requiredMethod: 'searchConversations', description: 'Pesquisa nomes, identidades vinculadas e textos públicos registrados nos canais autorizados desta empresa. Retorna até50 atendimentos e trechos curtos, com cursor de continuação. Exclui notas privadas e grupos não selecionados; não consulta o aparelho nem outra empresa.',
    inputSchema: schema({ requestId, query: { type: 'string', minLength: 2, maxLength: 200, pattern: '\\S' }, status: { type: 'string', enum: ['all', 'open', 'pending', 'closed'] }, channelId: identifier, after: timestamp, before: timestamp, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 4000 } }, ['requestId', 'query']),
    readOnly: true, invoke: (api, actor, input) => api.searchConversations(actor, input) },
  { name: 'elozi_read_conversation_history', title: 'Consultar mensagens anteriores do atendimento', capability: 'conversation.read', requiredMethod: 'readConversationHistory', description: 'Lê mensagens públicas registradas de WhatsApp, Telegram, webchat ou outro canal autorizado. Páginas cronológicas de até100 mensagens, janela padrão7dias/máximo31dias; o cursor busca páginas anteriores. Contexto limitado, sem notas privadas ou URLs/bytes de anexos. Não importa mensagens do aparelho.',
    inputSchema: schema({ requestId, conversationId: identifier, after: timestamp, before: timestamp, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 4000 } }, ['requestId', 'conversationId']),
    readOnly: true, invoke: (api, actor, input) => api.readConversationHistory(actor, input) },
  { name:'elozi_list_groups',title:'Listar grupos selecionados',capability:'conversation.read',requiredMethod:'listGroups',description:'Descobre apenas grupos autorizados na seleção atual do canal e escopo da identidade, com paginação de até50 grupos. Não habilita grupos.',
    inputSchema:schema({requestId,channelId:identifier,limit:{type:'integer',minimum:1,maximum:50},cursor:{type:'string',maxLength:2400}},['requestId']),readOnly:true,invoke:(api,actor,input)=>api.listGroups(actor,input) },
  { name:'elozi_read_group_history',title:'Ler histórico temporal do grupo',capability:'conversation.read',requiredMethod:'readGroupHistory',description:'Retorna até100 mensagens públicas com autor, datas e metadados de anexos; janela padrão7dias/máximo31dias e cursor vinculado ao escopo. Não lê notas nem analisa anexos.',
    inputSchema:schema({requestId,conversationId:identifier,after:timestamp,before:timestamp,limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',maxLength:4000}},['requestId','conversationId']),readOnly:true,invoke:(api,actor,input)=>api.readGroupHistory(actor,input) },
  { name: 'elozi_request_draft', title: 'Pedir rascunho ao Hermes', capability: 'reply.draft', description: 'Solicita ao Hermes configurado um rascunho para revisão humana, com a versão atual do atendimento. Não envia mensagem ao cliente. A chave requestId permite reconciliar repetição sem nova execução.',
    inputSchema: schema({ requestId, conversationId: identifier, version, instruction: { type: 'string', maxLength: 1000 } }, ['requestId', 'conversationId', 'version']),
    invoke: (api, actor, input) => api.draft(actor, input) },
  { name: 'elozi_submit_draft', title: 'Apresentar rascunho externo', capability: 'reply.submit', description: 'Apresenta uma resposta preparada pelo agente externo configurado para revisão humana. Não envia mensagem ao cliente. Usa versão atual e chave idempotente requestId.',
    inputSchema: schema({ requestId, conversationId: identifier, version, text: { type: 'string', minLength: 1, maxLength: 8000, pattern: '\\S' } }),
    invoke: (api, actor, input) => api.submitDraft(actor, input) },
  { name:'elozi_send_group_message',title:'Enviar texto ao grupo autorizado',capability:'reply.send',requiredMethod:'sendGroup',description:'Envia texto somente no grupo selecionado com permissão reply.send explícita, versão atual e requestId estável. Um resultado incerto nunca é reenviado automaticamente; consulte o recibo.',
    inputSchema:schema({requestId,conversationId:identifier,version,text:{type:'string',minLength:1,maxLength:4000,pattern:'\\S'}}),openWorld:true,invoke:(api,actor,input)=>api.sendGroup(actor,input) },
  { name: 'elozi_send_reply', title: 'Responder no atendimento atribuído ao agente', capability: 'reply.send', requiredMethod: 'sendReply', description: 'Envia texto ao cliente somente em conversa privada atribuída ao seu agente conectado via MCP, na versão atual e com requestId estável. Pedido de pessoa, insatisfação ou mídia fora da política privada na última mensagem do cliente recusam o envio (409): transfira com elozi_transfer_to_human. O padrão é 6 respostas por hora por conversa; ajustes privados autorizados aparecem em replyRateLimits de elozi_me. Resultado incerto nunca é reenviado; consulte o recibo. Arquivo (PDF, JPEG, PNG ou WebP até 10 MiB) só pela rota REST /api/service/v1/replies.',
    inputSchema: schema({ requestId, conversationId: identifier, version, text: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' } }), openWorld: true, invoke: (api, actor, input) => api.sendReply(actor, input) },
  { name:'elozi_schedule_group_message',title:'Agendar texto no grupo autorizado',capability:'message.schedule',requiredMethod:'scheduleGroup',description:'Agenda texto com permissão message.schedule explícita e revalida identidade, TTL, grupo e escopo no disparo. Não cria uma pessoa atendente nem concede envio imediato.',
    inputSchema:schema({requestId,conversationId:identifier,version,text:{type:'string',minLength:1,maxLength:4000,pattern:'\\S'},dueAt:timestamp}),openWorld:true,invoke:(api,actor,input)=>api.scheduleGroup(actor,input) },
  { name: 'elozi_request_human_support', title: 'Pedir apoio humano', capability: 'handoff.request', description: 'Registra um pedido pendente de apoio humano no atendimento autorizado. Não assume o atendimento, não envia mensagens e não decide pela equipe.',
    inputSchema: schema({ requestId, conversationId: identifier, version, reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } }),
    invoke: (api, actor, input) => api.handoff(actor, input) },
  { name: 'elozi_read_company', title: 'Ler estrutura autorizada da empresa', capability: 'company.read', requiredMethod: 'readCompany', description: 'Lê metadados da empresa, canais e departamentos permitidos, agentes e fluxos. Não inclui clientes, mensagens, notas, memória ou credenciais.',
    inputSchema: schema({ requestId }), readOnly: true, invoke: (api, actor, input) => api.readCompany(actor, input.requestId) },
  { name: 'elozi_propose_flow', title: 'Propor novo fluxo em rascunho', capability: 'company.propose', requiredMethod: 'proposeAdmin', description: 'Registra uma proposta de novo fluxo para aprovação humana do administrador. A aprovação cria somente um rascunho; não publica fluxo, não ativa roteamento e não altera canais existentes.',
    inputSchema: schema({ requestId, name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' }, description: { type: 'string', maxLength: 500 }, graph: flowGraph }, ['requestId', 'name']),
    invoke: (api, actor, input) => api.proposeAdmin(actor, { ...input, type: 'flow' }) },
  { name: 'elozi_propose_agent', title: 'Propor novo agente conectado', capability: 'company.propose', requiredMethod: 'proposeAdmin', description: 'Registra uma proposta de agente externo via MCP para aprovação humana do administrador. A aprovação cria um copiloto aguardando conexão; não concede identidade, chave, envio ou administração.',
    inputSchema: schema({ requestId, name: { type: 'string', minLength: 1, maxLength: 48, pattern: '\\S' }, description: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } }),
    invoke: (api, actor, input) => api.proposeAdmin(actor, { ...input, type: 'agent' }) },
  { name: 'elozi_wait_for_events', title: 'Aguardar mudanças nos atendimentos', capability: 'events.read', requiredMethod: 'waitForEvents', description: 'Aguarda até 25 s por avisos de conversa criada, mensagem, atualização ou remoção no escopo da identidade, sem texto das mensagens. Guarde o cursor devolvido para a próxima espera; resync: true pede nova leitura com elozi_list_conversations. Uma espera por vez, sem consumir a cota diária; esperas que voltam vazias em menos de 5 s contam num limite de 120 por hora, então use o timeoutMs padrão de 20000.',
    inputSchema: schema({ requestId, cursor: { type: 'string', minLength: 1, maxLength: 120 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000 }, types: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: eventTypes } } }, []),
    readOnly: true, invoke: (api, actor, input, extra) => api.waitForEvents(actor, input, extra) },
  { name: 'elozi_claim_conversation', title: 'Assumir atendimento da fila', capability: 'conversation.manage', requiredMethod: 'claimConversation', description: 'Atribui ao seu agente um atendimento privado da fila, sem pessoa responsável, no escopo da identidade e na versão atual. Não assume grupos nem conversas de pessoas ou de outro agente.',
    inputSchema: schema({ requestId, conversationId: identifier, version }), invoke: (api, actor, input) => api.claimConversation(actor, input) },
  { name: 'elozi_transfer_to_human', title: 'Passar o atendimento para a equipe', capability: 'conversation.manage', requiredMethod: 'transferToHuman', description: 'Transfere um atendimento atribuído ao seu agente para a fila ou para um departamento ativo do seu escopo, com nota interna do motivo. O agente deixa de responder a conversa.',
    inputSchema: schema({ requestId, conversationId: identifier, version, reason, departmentId: identifier }, ['requestId', 'conversationId', 'version', 'reason']), invoke: (api, actor, input) => api.transferToHuman(actor, input) },
  { name: 'elozi_hand_over_to_agent', title: 'Repassar o atendimento a outro agente conectado', capability: 'conversation.manage', requiredMethod: 'handOverConversation', description: 'Repassa um atendimento atribuído ao seu agente diretamente para outro agente via MCP em modo copiloto da mesma empresa, sem passar pela fila humana. O outro agente passa a responder com a própria identidade; você deixa de responder.',
    inputSchema: schema({ requestId, conversationId: identifier, version, agentId: identifier, reason: { type: 'string', minLength: 1, maxLength: 240, pattern: '\\S' } }, ['requestId', 'conversationId', 'version', 'agentId']), invoke: (api, actor, input) => api.handOverConversation(actor, input) },
  { name: 'elozi_set_tags', title: 'Definir etiquetas do atendimento', capability: 'conversation.manage', requiredMethod: 'setTags', description: 'Substitui as etiquetas (até 20, com até 48 caracteres) de um atendimento atribuído ao seu agente ou da fila sem responsável, na versão atual.',
    inputSchema: schema({ requestId, conversationId: identifier, version, tags: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 48, pattern: '\\S' } } }), invoke: (api, actor, input) => api.setTags(actor, input) },
  { name: 'elozi_close_conversation', title: 'Encerrar atendimento do agente', capability: 'conversation.manage', requiredMethod: 'closeConversation', description: 'Encerra um atendimento atribuído ao seu agente. Recusa (409) quando a última mensagem pública é do cliente e ainda não foi respondida.',
    inputSchema: schema({ requestId, conversationId: identifier, version, reason: { type: 'string', maxLength: 240 } }, ['requestId', 'conversationId', 'version']), invoke: (api, actor, input) => api.closeConversation(actor, input) },
  { name: 'elozi_send_typing', title: 'Mostrar digitando ao cliente', capability: 'presence.typing', requiredMethod: 'sendTyping', description: 'Mostra ao cliente o aviso "digitando…" (state composing) ou o retira (paused) na conversa privada atribuída ao seu agente conectado, com a mesma autorização de elozi_send_reply. Não cria mensagem, não consome a cota diária nem gera recibo, e nunca impede a resposta seguinte. WhatsApp envia a presença composing/paused; Telegram mostra digitando por cerca de 5 s (paused não tem efeito); outros canais devolvem supported:false. No máximo um composing a cada 4 s por conversa: chamada mais rápida devolve sent:false com reason throttled e retryAfterMs. Repita composing a cada 4 a 10 s enquanto prepara a resposta; a mesma requestId em até 60 s devolve o mesmo resultado sem novo aviso.',
    inputSchema: schema({ requestId, conversationId: identifier, state: { type: 'string', enum: ['composing', 'paused'] } }), openWorld: true, invoke: (api, actor, input) => api.sendTyping(actor, input) }
].map(definition => ({ ...definition, validate: ajv.compile(definition.inputSchema) }));
// Tools whose result is checked after the call against the identity's inventory scope (no single conversation, or a
// conversation that may have left the scope through the action itself, e.g. a transfer).
const INVENTORY_CHECK = new Set(['elozi_list_conversations', 'elozi_list_groups', 'elozi_search_conversations', 'elozi_wait_for_events',
  'elozi_claim_conversation', 'elozi_transfer_to_human', 'elozi_set_tags', 'elozi_close_conversation']);

export const businessError = error => {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  const message = status >= 500 ? 'O serviço não pôde concluir a solicitação. Reconcile pela mesma requestId antes de tentar novamente.' : error.message;
  // MCP has no response headers per tool call: a 429 carries the REST Retry-After value in the body instead.
  const retryAfter = status === 429 && Number.isSafeInteger(error?.retryAfter) && error.retryAfter > 0 ? Math.min(error.retryAfter, 3600) : null;
  const text = retryAfter ? `${message} Tente novamente em ${retryAfter} s.` : message;
  // An adapter's generic 429/code/flags never establish pre-admission rejection.
  const rejected = error instanceof ServiceReplyRateLimitError && status === 429 ? { code: 'SERVICE_REPLY_RATE_LIMIT', admissionRejected: true, limit: { ...error.rateLimit }, noticeSent: error.noticeSent === true }
    : error instanceof OwnLinePairError ? { code: error.code } : {};
  return { content: [{ type: 'text', text }], structuredContent: { error: { status, message, ...rejected, ...(retryAfter ? { retryAfter } : {}) } }, isError: true };
};
const publicDefinition = ({ name, title, description, inputSchema, readOnly, openWorld }) => ({ name, title, description, inputSchema,
  annotations: { readOnlyHint: Boolean(readOnly), destructiveHint: false, idempotentHint: true, openWorldHint: Boolean(openWorld) } });
const available = (api, actor) => {
  const capabilities = api.me(actor).principal.capabilities;
  return definitions.filter(tool => (!tool.capability || capabilities.includes(tool.capability)) && (!tool.requiredMethod || typeof api[tool.requiredMethod] === 'function') && (tool.name !== 'elozi_read_attachment' || api.me(actor).attachmentRead?.enabled === true) && (tool.name !== 'elozi_submit_draft' || typeof api.submitDraft === 'function'));
};

function rpcError(res, status, code, message, id = null) {
  if (res.headersSent || res.destroyed) return;
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="elozi-service"');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort); };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > limit) return fail(Object.assign(new Error('Solicitação acima do limite permitido.'), { status: 413 }));
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const onError = () => fail(Object.assign(new Error('Solicitação interrompida.'), { status: 400 }));
    const onAbort = () => onError();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}

/** One authenticated SDK server/transport per POST. No session registry, GET SSE, human cookies or admin fallback. */
export function createServiceMcpHandler(serviceApi, { path = '/api/agent/mcp', maxBodyBytes = 65536, allowedOrigins = [], authorizeRequest } = {}) {
  if (!serviceApi?.principals?.authenticate || typeof serviceApi.me !== 'function') throw new TypeError('Informe a API de serviços autorizada.');
  if (typeof path !== 'string' || !path.startsWith('/') || /[?#]/.test(path)) throw new TypeError('Informe um caminho MCP absoluto sem parâmetros.');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1048576) throw new TypeError('Limite MCP inválido.');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => typeof origin !== 'string' || new URL(origin).origin !== origin || !/^https?:/.test(origin))) throw new TypeError('Informe origens canônicas explícitas para MCP.');
  if (authorizeRequest !== undefined && typeof authorizeRequest !== 'function') throw new TypeError('Informe uma função de autorização do domínio MCP.');
  const origins = new Set(allowedOrigins);
  return async function handleServiceMcp(req, res) {
    if ((req.url || '').split('?')[0] !== path) return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    let server;
    try {
      // A fresh proof is built for every HTTP request and every tool callback. A cookie can never supply this authority.
      const authenticate = () => {
        const actor = serviceApi.principals.authenticate(req.headers.authorization), allowed = authorizeRequest?.(actor, req);
        if (allowed?.then) throw new TypeError('A autorização do domínio MCP precisa ser síncrona.');
        if (allowed === false) throw Object.assign(new Error('O serviço não está autorizado neste painel.'), { status: 403 });
        return actor;
      };
      authenticate();
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); rpcError(res, 405, -32000, 'Este MCP aceita somente POST, sem streams ou sessões.'); return true; }
      if (req.url.includes('?')) { rpcError(res, 400, -32600, 'Informe o caminho MCP sem parâmetros na URL.'); return true; }
      if (req.headers.origin && !origins.has(req.headers.origin)) { rpcError(res, 403, -32000, 'Origem não autorizada para este MCP.'); return true; }
      if (req.headers['mcp-session-id'] || req.headers['last-event-id']) { rpcError(res, 400, -32600, 'Este MCP não mantém sessões ou eventos retomáveis.'); return true; }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { rpcError(res, 415, -32000, 'Use JSON sem compressão neste MCP.'); return true; }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) { rpcError(res, 415, -32000, 'Use Content-Type application/json.'); return true; }
      if (req.headers['content-length'] && Number(req.headers['content-length']) > maxBodyBytes) { req.resume(); rpcError(res, 413, -32000, 'Solicitação acima do limite permitido.'); return true; }
      let body;
      try { body = JSON.parse(await readBody(req, maxBodyBytes)); }
      catch (error) { rpcError(res, error.status || 400, error.status === 413 ? -32000 : ErrorCode.ParseError, error.status ? error.message : 'JSON inválido.'); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) {
        rpcError(res, 400, ErrorCode.InvalidRequest, 'Informe uma única solicitação JSON-RPC válida.'); return true;
      }
      if (body.method === 'tools/call' && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params) || Object.keys(body.params).some(key => !['name', 'arguments', '_meta'].includes(key)))) {
        rpcError(res, 400, ErrorCode.InvalidParams, 'Informe somente os parâmetros permitidos da ferramenta.', body.id ?? null); return true;
      }
      server = new Server({ name: 'elozi-service-mcp', version: '0.1.0' }, { capabilities: { tools: {} },
        instructions: 'A identidade de serviço determina empresa, canais, grupos selecionados e departamentos. Use requestId estável e a versão atual do atendimento. Rascunhos, apoio e propostas aguardam revisão humana. Envio e agendamento em grupos só existem com capacidades explícitas reply.send/message.schedule; resposta privada só em conversa atribuída ao seu agente conectado; resultado incerto não permite repetição automática. Como atendente: aguarde eventos, leia a conversa, responda ou transfira para a equipe. Nenhuma ferramenta administra usuários ou habilita grupos.' });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: available(serviceApi, authenticate()).map(publicDefinition) }));
      // A long wait ends with the client: the connection closing aborts it.
      const disconnect = new AbortController();
      res.once('close', () => disconnect.abort());
      server.setRequestHandler(CallToolRequestSchema, async request => {
        const tool = definitions.find(item => item.name === request.params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Ferramenta não implementada neste MCP.');
        const input = request.params.arguments ?? {};
        if (!tool.validate(input)) throw new McpError(ErrorCode.InvalidParams, 'Argumentos inválidos: use somente os campos e limites informados pela ferramenta.');
        let result;
        try {
          const actor = authenticate();
          if (!available(serviceApi, actor).some(item => item.name === tool.name)) return businessError(Object.assign(new Error('A identidade de serviço não tem esta capacidade.'), { status: 403 }));
          result = await tool.invoke(serviceApi, actor, input, { signal: disconnect.signal });
          // Authority can change during an asynchronous provider call; never return a result to a revoked bearer.
          authenticate();
          // A receipt has the original operation's capability and context, not a
          // single catalog capability. Reconcile with the original actor proof
          // after awaiting; fresh authentication alone cannot authorize old data.
          if (tool.name === 'elozi_get_receipt') result = { ...result, receipt: serviceApi.principals.getReceiptByRequestId(actor, input.requestId) };
          if (tool.name === 'elozi_read_attachment') serviceApi.revalidateAttachmentRead(actor,input,result);
          if (tool.capability) {
            const action=['reply.send','message.schedule'].includes(tool.capability);
            const context = tool.capability.startsWith('company.') ? { workspaceId: actor.workspaceId, tenantId: actor.tenantId, agentId: actor.agentId }
              : INVENTORY_CHECK.has(tool.name) ? serviceApi.inventoryContext(actor)
              : action ? {...result.receipt.context,conversationVersion:undefined}
              : tool.name==='elozi_read_group_history'?serviceApi.groupContext(actor,input.conversationId,result.version)
              : serviceApi.context(actor, input.conversationId, input.version ?? result.version ?? result.conversation?.version);
            serviceApi.principals.revalidate(actor, tool.capability, context);
            if (tool.name === 'elozi_list_conversations') serviceApi.revalidateInventoryPage(actor, result.conversations);
            if (tool.name === 'elozi_search_conversations') serviceApi.revalidateInventoryPage(actor, result.conversations);
            if (tool.name === 'elozi_list_groups') serviceApi.revalidateInventoryPage(actor, result.groups, { groups: true });
            if(action&&context.conversationKind==='group'||tool.name==='elozi_read_group_history')serviceApi.assertGroup(actor,context);
            if(tool.name==='elozi_read_conversation_history'&&context.conversationKind==='group')serviceApi.assertGroup(actor,context);
          }
          const summary=tool.name==='elozi_read_attachment'?{status:result.status,conversationId:result.conversationId,messageId:result.messageId,attachment:{id:result.attachment.id,mime:result.attachment.mime,size:result.attachment.size,sha256:result.attachment.sha256,encoding:result.attachment.encoding}}:result;
          return { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: result };
        } catch (error) { if(tool.name==='elozi_read_attachment'&&result?.attachment)result.attachment.data='';return businessError(error); }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const result = businessError(error).structuredContent.error;
      rpcError(res, result.status, result.status === 401 || result.status === 403 ? -32000 : ErrorCode.InternalError, result.message);
    } finally { if (server) await server.close().catch(() => {}); }
    return true;
  };
}
