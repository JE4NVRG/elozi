import { h, t } from './i18n.js';
import './locales-live.js';

// Public setup instructions only. Never accepts credentials, fetches, grants, or infers account access.
// Sources: product contracts verified 08/10/2026; official MCP configuration docs linked below.
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
export const PRODUCT_AGENT_CONNECTIONS = freeze([
  { id: 'mepmail-send', name: 'MepMail Send', endpoint: 'https://api.mepmail.dev/mcp', auth: 'oauth', tokenEnv: null, documentation: 'https://docs.mepmail.dev/mcp',
    read: 'Consultar e-mails e status exige emails:read. O acesso pertence à equipe autorizada no MepMail.',
    action: 'Enviar ou agendar e-mails exige emails:send e autorização específica. Consultar não concede envio.',
    scope: 'Revise a equipe e os escopos na autorização OAuth. Este acesso não abre uma caixa Correio.' },
  { id: 'mepmail-correio', name: 'MepMail Correio', endpoint: 'https://api.mepmail.dev/mcp/correio', auth: 'bearer', tokenEnv: 'MEPMAIL_CORREIO_MCP_TOKEN', documentation: 'https://docs.mepmail.dev/mcp',
    read: 'Use a chave de agente da caixa autorizada para consultar mensagens e preparar rascunhos conforme suas permissões.',
    action: 'Enviar pela caixa exige permissão própria concedida no Correio. Uma chave de leitura ou rascunho não autoriza envio.',
    scope: 'A caixa e a chave são separadas do MepMail Send. Confira a caixa correta antes de consultar ou responder.' },
  { id: 'fullcommerce', name: 'FullCommerce360°', endpoint: 'https://fullcommerce360.com/api/v1/agent/mcp', auth: 'agent-key', tokenEnv: 'FULLCOMMERCE_AGENT_KEY', documentation: 'https://fullcommerce360.com',
    read: 'Consulte apenas as ferramentas de leitura presentes em tools/list e permitidas à conta e à delegação.',
    action: 'Uma ação exige ferramenta realmente disponível e concessão própria. A conexão não promete publicar em marketplaces, emitir documentos fiscais ou enviar mensagens.',
    scope: 'Confira a delegação no FullCommerce e informe client_id e account_id da operação. Não use os identificadores da Elozi por inferência.' },
  { id: 'urlpivot', name: 'URLPivot', endpoint: 'https://urlpivot.app/api/agent/mcp', auth: 'bearer', tokenEnv: 'URLPIVOT_WORKSPACE_MCP_TOKEN', documentation: 'https://urlpivot.app/llms.txt',
    read: 'Confira get_workspace_context e urlpivot://capabilities para consultar links e métricas do workspace autorizado.',
    action: 'Criar links ou alterar destinos exige os escopos de escrita e autorização para a campanha. O catálogo público não concede essas ações.',
    scope: 'Reutilize o workspace próprio do projeto e seus links existentes. Cada workspace mantém credencial e permissões separadas.' }
]);

export const PRODUCT_AGENT_CLIENTS = freeze({
  claude: { label: 'Claude Code', documentation: 'https://code.claude.com/docs/en/mcp' },
  codex: { label: 'Codex', documentation: 'https://developers.openai.com/codex/mcp' },
  hermes: { label: 'Hermes Agent', documentation: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/' }
});
const publicId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;

/** Credential-free template. FullCommerce context is explicit public IDs, never taken from Elozi. */
export function productAgentClientConfig(productId, client = 'codex', { clientId, accountId } = {}) {
  const product = PRODUCT_AGENT_CONNECTIONS.find(item => item.id === productId);
  if (!product || !Object.hasOwn(PRODUCT_AGENT_CLIENTS, client)) return null;
  const url = new URL(product.endpoint);
  let contextRequired = false;
  if (product.id === 'fullcommerce') {
    const workspace = publicId(clientId), account = publicId(accountId);
    if (workspace && account) { url.searchParams.set('client_id', workspace); url.searchParams.set('account_id', account); }
    else contextRequired = true;
  }
  const endpoint = url.href, name = product.id.replace(/-/g, '_'), oauth = product.auth === 'oauth', header = product.auth === 'agent-key' ? 'X-Agent-Key' : 'Authorization';
  const reference = '${' + product.tokenEnv + '}', headerValue = product.auth === 'bearer' ? 'Bearer ' + reference : reference;
  let code, file;
  if (client === 'claude') {
    file = '.mcp.json';
    code = JSON.stringify({ mcpServers: { [name]: { type: 'http', url: endpoint, ...(!oauth ? { headers: { [header]: headerValue } } : {}) } } }, null, 2);
  } else if (client === 'codex') {
    file = '~/.codex/config.toml';
    code = `[mcp_servers.${name}]\nurl = "${endpoint}"`;
    if (product.auth === 'bearer') code += `\nbearer_token_env_var = "${product.tokenEnv}"`;
    if (product.auth === 'agent-key') code += `\nenv_http_headers = { "X-Agent-Key" = "${product.tokenEnv}" }`;
  } else {
    file = '~/.hermes/config.yaml';
    code = `mcp_servers:\n  ${name}:\n    url: "${endpoint}"`;
    code += oauth ? '\n    auth: oauth' : `\n    headers:\n      ${header}: "${headerValue}"`;
  }
  return Object.freeze({ productId, client, name, endpoint, transport: 'Streamable HTTP', authentication: product.auth, tokenEnv: product.tokenEnv, file, code, contextRequired });
}

const link = (url, label) => h`<a class="pg-settings__link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
function clientMarkup(product, client, selected, context) {
  const template = productAgentClientConfig(product.id, client, context), clientInfo = PRODUCT_AGENT_CLIENTS[client];
  return h`<details class="pg-settings__details" ${selected ? 'open' : ''}><summary>${clientInfo.label}</summary><div class="pg-settings__stack"><p class="pg-settings__muted">${t('Mescle somente esta conexão na configuração existente do cliente; preserve as outras conexões e sessões.')}</p><p><code class="pg-settings__code">${template.file}</code></p><pre tabindex="0" aria-label="${t('Configuração pública de {product} para {client}', { product: product.name, client: clientInfo.label })}" style="white-space:pre-wrap;overflow-wrap:anywhere"><code>${template.code}</code></pre>${template.tokenEnv ? h`<p class="pg-settings__muted">${t('Referência da credencial no ambiente privado: {name}. Este exemplo não contém seu valor.', { name: template.tokenEnv })}</p>` : h`<p class="pg-settings__muted">${t('Conclua OAuth no cliente e revise a equipe e os escopos no MepMail. O exemplo não contém token nem inicia autorização.')}</p>`}${template.contextRequired ? h`<p class="pg-settings__note">${t('Antes de usar o FullCommerce, acrescente client_id e account_id ao endpoint com os identificadores públicos da sua delegação.')}</p>` : ''}${link(clientInfo.documentation, t('Formato oficial do cliente'))}</div></details>`;
}

/** Pure HtmlString for the guide. The owning guide controls visibility; no session/DTO is read here. */
export function renderProductAgentConnections({ client = 'codex', fullcommerce = {} } = {}) {
  const selected = Object.hasOwn(PRODUCT_AGENT_CLIENTS, client) ? client : 'codex';
  return h`<section id="product-agent-connections" class="pg-settings__section" aria-labelledby="product-agent-connections-title"><h3 id="product-agent-connections-title" class="pg-settings__h3">${t('Conectar operações dos seus produtos')}</h3><p class="pg-settings__text">${t('Seu cliente MCP pode reunir conexões separadas com Elozi, MepMail, FullCommerce e URLPivot. Cada produto mantém sua própria identidade, conta, permissões e limites.')}</p><p class="pg-settings__note">${t('A chave Elozi não abre os outros produtos. Configurar um endpoint não comprova autenticação, consulta ou ação autorizada.')}</p><ol class="pg-settings__ordered"><li>${t('Abra o produto, confira a conta ou workspace e reutilize o acesso próprio já autorizado.')}</li><li>${t('Escolha seu cliente abaixo e configure somente a conexão desejada. Credenciais ficam no ambiente privado do cliente.')}</li><li>${t('Descubra tools/list, confira o contexto permitido e faça uma consulta autorizada. Só depois solicite uma ação coberta pela permissão específica.')}</li></ol><ul class="pg-settings__cards">${PRODUCT_AGENT_CONNECTIONS.map(product => h`<li class="pg-settings__card"><h4 class="pg-settings__h3">${product.name}</h4><p class="pg-settings__muted">Streamable HTTP · ${product.auth === 'oauth' ? 'OAuth' : product.auth === 'agent-key' ? 'X-Agent-Key' : 'Authorization: Bearer'}</p><p class="pg-settings__text"><strong>${t('Endpoint')}</strong><br/><code class="pg-settings__code" style="overflow-wrap:anywhere">${product.endpoint}</code></p><p class="pg-settings__text"><strong>${t('Consulta')}</strong><br/>${t(product.read)}</p><p class="pg-settings__text"><strong>${t('Ações autorizadas')}</strong><br/>${t(product.action)}</p><p class="pg-settings__muted">${t(product.scope)}</p>${link(product.documentation, product.id === 'fullcommerce' ? t('Abrir o produto e conferir a delegação') : t('Documentação do produto'))}<div class="pg-settings__stack">${Object.keys(PRODUCT_AGENT_CLIENTS).map(id => clientMarkup(product, id, selected === id, product.id === 'fullcommerce' ? fullcommerce : {}))}</div></li>`)}</ul><p class="pg-settings__muted">${t('Esta seção oferece instruções e configuração pública. Não cria chaves, altera acessos, autentica clientes nem executa mensagens ou operações.')}</p></section>`;
}
