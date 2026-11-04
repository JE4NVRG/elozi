import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuideMarkup } from '../public/guide-ui.js';
import { getLocale, setLocale } from '../public/i18n.js';
import { createAgentQueryBridge } from '../src/agent-query-bridge.js';

const admin = { role: 'reseller', platformOwner: false, kind: 'human' };
const operator = { role: 'operator', permissions: ['inbox.read'], kind: 'human' };
const routes = html => [...new Set([...html.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]))].sort();
const render = options => createGuideMarkup({ session: admin, accountKind: 'reseller', ...options });
const adminRoutes = ['accounts', 'brand', 'platform', 'service-agents', 'team', 'tenants'];
// P8 (§8.9): literal capabilities, paths and tools keep their exact text inside the design-system code tag.
const code = value => `<code class="pg-settings__code">${value}</code>`;

test('o principal tem acesso didático ao painel global e aos destinos de sua administração', () => {
  const html = render({ session: { ...admin, platformOwner: true }, accountKind: 'platform' });
  assert.deepEqual(routes(html), ['accounts', 'brand', 'channels', 'groups', 'inbox', 'platform', 'service-agents', 'team', 'tenants']);
  assert.ok(html.includes('Administrador principal'));
});

test('a revenda vê sua carteira e configuração, sem promover o próprio perfil para principal', () => {
  const html = render();
  assert.deepEqual(routes(html), ['accounts', 'brand', 'channels', 'groups', 'inbox', 'service-agents', 'team', 'tenants']);
  assert.ok(html.includes('Administrador da revenda'));
});

test('empresa cliente com perfil reseller organiza suas unidades, sem CTA de carteira ou revendas', () => {
  const html = render({ accountKind: 'business' });
  assert.deepEqual(routes(html), ['brand', 'channels', 'groups', 'inbox', 'service-agents', 'team', 'tenants']);
  assert.ok(html.includes('Administrador da empresa'));
  assert.ok(!html.includes('Ver contas comerciais'));
});

test('tipo comercial desconhecido não oferece a criação ou administração de carteira', () => {
  for (const accountKind of [undefined, null, '', 'unknown', '<script>alert(1)</script>']) {
    const html = render({ accountKind });
    assert.ok(!routes(html).includes('accounts'));
    assert.ok(!html.includes('<script>'));
  }
});

test('atendente comum só recebe destinos operacionais permitidos', () => {
  const html = render({ session: operator });
  assert.deepEqual(routes(html), ['channels', 'groups', 'inbox']);
  for (const route of adminRoutes) assert.ok(!routes(html).includes(route), route);
  assert.ok(html.includes('Atendente'));
});

test('permissão explícita sem inbox.read remove o CTA de atendimento sem retirar a explicação', () => {
  const html = render({ session: { ...operator, permissions: ['contacts.read'] } });
  assert.deepEqual(routes(html), ['channels']);
  assert.ok(html.includes('Ajuda e APIs'));
  assert.ok(html.includes('/conversations/{conversationId}'));
});

test('permissões humanas legadas seguem o contrato do painel; valor malformado não abre atendimento', () => {
  assert.deepEqual(routes(render({ session: { ...operator, permissions: null } })), ['channels', 'groups', 'inbox']);
  assert.deepEqual(routes(render({ session: { ...operator, permissions: undefined } })), ['channels', 'groups', 'inbox']);
  for (const permissions of ['', 'inbox.read', {}, true]) assert.deepEqual(routes(render({ session: { ...operator, permissions } })), ['channels']);
});

test('suporte pelo contexto externo remove todos os destinos administrativos mesmo para o principal', () => {
  const html = render({ session: { ...admin, platformOwner: true }, accountKind: 'platform', supportGrantId: 'grant-test' });
  assert.deepEqual(routes(html), ['channels', 'groups', 'inbox']);
  assert.ok(html.includes('Acesso de suporte com prazo'));
  assert.ok(html.includes('Você está no contexto de suporte'));
});

test('concessão presente na própria sessão também impede CTAs administrativos', () => {
  const html = render({ session: { ...admin, platformOwner: true, supportGrantId: 'grant-test' } });
  assert.deepEqual(routes(html), ['channels', 'groups', 'inbox']);
  assert.ok(html.includes('Acesso de suporte com prazo'));
});

test('sem unidade selecionada o guia permanece disponível e não leva a páginas operacionais vazias', () => {
  const html = render({ session: { ...admin, platformOwner: true }, accountKind: 'platform', hasTenant: false });
  assert.deepEqual(routes(html), ['accounts', 'platform', 'team', 'tenants']);
  assert.ok(html.includes('Selecione ou prepare uma empresa'));
  assert.ok(html.includes('API para serviços'));
  assert.deepEqual(routes(render({ session: operator, hasTenant: false })), []);
});

test('nenhuma identidade humana conhecida deixa o conteúdo educativo sem botões de operação', () => {
  for (const session of [undefined, null, {}, { role: 'owner' }, { role: 'reseller', kind: 'service', platformOwner: true }]) {
    const html = createGuideMarkup({ session, accountKind: 'platform' });
    assert.deepEqual(routes(html), []);
    assert.ok(html.includes('Quem administra o quê'));
  }
});

test('o conteúdo não acessa nome, credenciais, mensagens ou DTOs privados nem exibe identificadores de suporte', () => {
  const session = { ...admin, platformOwner: true };
  for (const key of ['name', 'csrfToken', 'token', 'password', 'email', 'scopeRules', 'tenantIds', 'messages']) Object.defineProperty(session, key, { get() { throw new Error(`Campo privado lido: ${key}`); } });
  const html = render({ session, supportGrantId: 'SECRET_GRANT_MUST_NOT_APPEAR' });
  assert.ok(!html.includes('SECRET_GRANT_MUST_NOT_APPEAR'));
  assert.ok(!html.includes('Campo privado'));
});

test('o exemplo de autenticação é placeholder escapado e não cria um elemento HTML de chave', () => {
  const html = render();
  assert.ok(html.includes('Authorization: Bearer &lt;CHAVE_PRIVADA&gt;'));
  assert.ok(!html.includes('<CHAVE_PRIVADA>'));
  const calls = [];
  render({ escape(value) { calls.push(value); return String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'); } });
  assert.ok(calls.includes('Authorization: Bearer <CHAVE_PRIVADA>'));
});

test('sumário local aponta para seções únicas e focáveis, sem link externo ou downloads inexistentes', () => {
  const html = render();
  // #help/<tópico> is a panel route (router.js, P8): it opens Ajuda at the focusable section guide-<tópico>.
  const targets = [...html.matchAll(/href="#help\/([^"]+)" data-help-topic="([^"]+)"/g)].map(match => { assert.equal(match[1], match[2]); return match[1]; });
  assert.equal(targets.length, 5);
  assert.equal(new Set(targets).size, 5);
  for (const target of targets) {
    assert.equal([...html.matchAll(new RegExp(`id="guide-${target}"`, 'g'))].length, 1);
    assert.ok(html.includes(`id="guide-${target}" class="pg-settings__section pg-settings__guide-section" tabindex="-1"`));
  }
  assert.ok(!html.includes('href="http'));
  assert.ok(!html.includes(' download'));
});

test('controles são navegação ou disclosure nativo, sem cadastro de segredo, grant ou chamada automática', () => {
  const html = render();
  assert.equal([...html.matchAll(/<button\b/g)].length, [...html.matchAll(/<button type="button"/g)].length);
  assert.equal([...html.matchAll(/<details\b/g)].length, [...html.matchAll(/<summary\b/g)].length);
  assert.ok(html.includes('aria-label="Sumário do guia"'));
  for (const forbidden of ['<form', '<input', '<script', '<iframe', 'data-action=', 'data-dialog-form=', 'onclick=']) assert.ok(!html.includes(forbidden), forbidden);
});

test('ícones opcionais são decorativos e sem renderer não aparece elemento gráfico fictício', () => {
  const noIcons = render();
  assert.ok(!noIcons.includes('pg-settings__glyph'));
  const html = render({ icon: () => '<svg class="icon"></svg>' });
  const icons = [...html.matchAll(/<span class="pg-settings__glyph" aria-hidden="true"><svg class="icon"><\/svg><\/span>/g)];
  assert.ok(icons.length > 10);
});

test('o guia mantém as capacidades e rotas do contrato de serviço implementado', () => {
  const source = readFileSync(new URL('../src/service-principals.js', import.meta.url), 'utf8');
  const capabilities = source.match(/SERVICE_CAPABILITIES = \[([^\]]+)\]/)?.[1].match(/'([^']+)'/g).map(value => value.slice(1, -1));
  assert.deepEqual(capabilities, ['conversation.read', 'reply.draft', 'reply.submit', 'handoff.request', 'company.read', 'company.propose', 'reply.send', 'message.schedule', 'events.read', 'conversation.manage', 'presence.typing', 'contact.read', 'notification.send','notification.read','notification.recipient.manage']);
  const html = render();
  for (const capability of capabilities) assert.ok(html.includes(code(capability)), capability);
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  for (const path of ['me', 'drafts', 'handoff-requests']) assert.ok(server.includes(`/api/service/v1/${path}`));
  assert.ok(html.includes('/receipts/{receiptId}'));
  assert.ok(html.includes('responder nas conversas atribuídas a ele, transferir para a equipe e encerrar as próprias'));
  assert.ok(html.includes('Pedir apoio não transfere o atendimento; transferir exige conversation.manage'));
  assert.ok(html.includes('/api/agent/mcp'));assert.ok(html.includes('Traga seu agente por MCP'));assert.ok(html.includes('aprovação humana'));
});

test('guia publica as seis rotas reais de atendente privado com método e operação corretos', () => {
  const html = render(), server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const rows = [...html.matchAll(/<li class="pg-settings__api-row">([\s\S]*?)<\/li>/g)].map(match => match[1]);
  const operations = [['events/wait', 'waitForEvents'], ['replies', 'sendReply'], ['conversation-claims', 'claimConversation'], ['human-transfers', 'transferToHuman'], ['conversation-tags', 'setTags'], ['conversation-closures', 'closeConversation']];
  for (const [path, operation] of operations) {
    const row = rows.find(value => value.includes(code('/' + path)));
    assert.ok(row, path); assert.ok(row.includes('data-method="POST"'), path);
    const route = server.split('\n').find(line => line.includes(`/api/service/v1/${path}'`));
    assert.ok(route, path); assert.match(route, /req\.method\s*===\s*'POST'/);
    assert.ok(route.includes(`serviceApi.${operation}(`), operation);
  }
});

test('roteiro independente do cliente lê a versão após assumir e reconcilia recibos antes de repetir', () => {
  const html = render(), start = html.indexOf('Atendimento privado com qualquer cliente');
  assert.ok(start > 0);
  const flow = html.slice(start, html.indexOf('</details>', start));
  let previous = -1;
  for (const title of ['Descubra o acesso da identidade', 'Consulte o contexto antes de agir', 'Assuma somente conversa livre', 'Leia a versão após assumir', 'Responda com envio autorizado', 'Confira o recibo antes de repetir', 'Transfira para atendimento humano']) {
    const current = flow.indexOf(title); assert.ok(current > previous, title); previous = current;
  }
  for (const field of ['requestId', 'conversationId', 'conversation.version', 'owner', 'agentId', 'text', 'receipt.id', 'reason', 'departmentId']) assert.ok(flow.includes(field), field);
  for (const restriction of ['sem responsável ou participantes', 'versão anterior pode ser recusada com 409', 'mesmo requestId e corpo', 'não reenvie automaticamente', 'o agente deixa de responder']) assert.ok(flow.includes(restriction), restriction);
  assert.ok(flow.includes('Hermes, Claude ou Codex')); assert.ok(flow.includes('clientes externos'));
  assert.ok(flow.includes('agente MCP configurado em modo copiloto')); assert.ok(flow.includes('diferente do adaptador interno Hermes'));
});

test('guia separa consulta e rascunho de envio e exige empresa explícita sem liberar Telegram pessoal', () => {
  const html = render();
  for (const phrase of ['Consulta, rascunho e envio são ações diferentes', 'Nenhum desses rascunhos envia mensagem', 'reply.send é uma concessão separada', 'handoff.request pede apoio', 'human-transfers aplica a transferência com conversation.manage', 'Consultar várias empresas não autoriza agir nelas', 'conexão e do atendimento explicitamente escolhidos', 'conta pessoal do Telegram continua fora do acesso de IA']) assert.ok(html.includes(phrase), phrase);
});

test('orientação dos produtos próprios fica no principal e exige seus próprios contratos e concessões', () => {
  for (const options of [{}, { session: operator }, { session: { ...admin, platformOwner: true }, supportGrantId: 'private-support' }]) {
    const html = render(options);
    for (const name of ['MepMail', 'FullCommerce', 'URLPivot']) assert.ok(!html.includes(name), name);
    assert.ok(!html.includes('id="product-agent-connections"'));
  }
  const html = render({ session: { ...admin, platformOwner: true }, accountKind: 'platform' });
  for (const name of ['MepMail', 'FullCommerce', 'URLPivot']) assert.ok(html.includes(name), name);
  const products = html.indexOf('id="product-agent-connections"');
  assert.ok(products > html.indexOf('id="guide-agents"'));
  assert.ok(products < html.indexOf('id="guide-questions"'));
  assert.ok(html.includes('seus próprios contratos, workspaces e concessões'));
  assert.ok(html.includes('não concede acesso integral nem autoriza operações nesses produtos'));
});

test('guia da ponte acompanha o catálogo real sem rede ou credencial e exige empresa explícita nas ações', () => {
  let clientCalls = 0;
  const bridge = createAgentQueryBridge({ connections: [{ id: 'guide-company', name: 'Empresa de exemplo', endpoint: 'https://guide-company.invalid/api/agent/mcp', tokenEnv: 'GUIDE_NOT_CONFIGURED' }] }, { env: {}, clientFactory() { clientCalls++; throw new Error('O guia não abre conexão'); } });
  const tools = bridge.tools(), html = render({ session: { ...admin, platformOwner: true }, accountKind: 'platform' });
  assert.equal(tools.length, 14); assert.equal(clientCalls, 0);
  for (const tool of tools) {
    assert.ok(html.includes(code(tool.name)), tool.name);
    if (!['elozi_connections', 'elozi_search_all'].includes(tool.name)) assert.ok(tool.inputSchema.required.includes('connectionId'), tool.name);
    if (tool.annotations.destructiveHint) for (const field of ['requestId', 'conversationId', 'version']) assert.ok(tool.inputSchema.required.includes(field), `${tool.name}: ${field}`);
  }
  const receipt = tools.find(tool => tool.name === 'elozi_get_receipt');
  assert.deepEqual(receipt.inputSchema.required, ['connectionId', 'requestId']);
  assert.ok(!Object.hasOwn(receipt.inputSchema.properties, 'receiptId'));
  for (const phrase of ['connectionId explícito', 'consulta elozi_me antes do despacho', 'o catálogo não concede capacidades', 'requestId original', 'sem nova cota ou despacho', 'Não repita a ação para recuperar confirmação']) assert.ok(html.includes(phrase), phrase);
  for (const options of [{}, { session: operator }, { session: { ...admin, platformOwner: true }, supportGrantId: 'private-support' }]) assert.ok(!render(options).includes('Atuar pela ponte na empresa escolhida'));
});

test('roteiro de atendente aparece em inglês com rotas e campos do contrato preservados', () => {
  const previous = getLocale();
  try {
    setLocale('en', { persist: false, notify: false });
    const html = render();
    const visible = html.replace(/&#(?:39|x27);|&apos;/g, "'");
    for (const phrase of ['Private support with any client', 'Discover the identity\'s access', 'Read the version after claiming', 'Check the receipt before retrying', 'Transfer to human support', 'Neither draft sends a message', 'explicitly chosen connection and conversation']) assert.ok(visible.includes(phrase), phrase);
    for (const path of ['/conversation-claims', '/replies', '/human-transfers']) assert.ok(html.includes(code(path)), path);
    for (const field of ['requestId', 'conversationId', 'conversation.version', 'receipt.id']) assert.ok(html.includes(field), field);
    assert.ok(!html.includes('Atendimento privado com qualquer cliente'));
    assert.ok(!html.includes('Leia a versão após assumir'));
    const principal = render({ session: { ...admin, platformOwner: true }, accountKind: 'platform' });
    for (const phrase of ['Act through the bridge in the chosen company', 'Each action, receipt lookup or event wait requires an explicit connectionId', 'without consuming quota or dispatching again', 'Do not repeat the action to recover confirmation']) assert.ok(principal.includes(phrase), phrase);
    assert.ok(principal.includes(code('elozi_get_receipt')));
  } finally { setLocale(previous, { persist: false, notify: false }); }
});

test('guia de grupos explica seleção, foto privada, histórico recebido e resumo limitado sem prometer importação antiga', () => {
  const html=render();
  for(const phrase of ['atendimento ainda vazio','acesso privado da conexão','não uma confirmação de todos os membros','sem garantir a recuperação de conversas antigas','últimos 7 dias','até 31 dias','Hermes configurado em modo copiloto','até 100 mensagens e 24 KiB','aviso quando o texto for reduzido','Não analisa anexos nem publica no grupo'])assert.ok(html.includes(phrase),phrase);
  for(const permission of ['inbox.read','inbox.reply'])assert.ok(html.includes(code(permission)),permission);
  assert.ok(!html.includes('100%'));assert.ok(!html.includes('histórico completo'));
});

test('guia MCP de grupos acompanha os quatro tools e rotas reais e mantém concessões explícitas separadas',()=>{
  const html=render(),mcp=readFileSync(new URL('../src/service-mcp.js',import.meta.url),'utf8'),server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const tools=[['elozi_list_groups','groups','conversation.read'],['elozi_read_group_history','group-history','conversation.read'],['elozi_send_group_message','group-messages','reply.send'],['elozi_schedule_group_message','group-schedules','message.schedule']];
  for(const [tool,path,capability] of tools){
    assert.ok(html.includes(code(tool)),tool);assert.ok(html.includes(code('/'+path)),path);
    const definition=mcp.match(new RegExp(`name:\\s*'${tool}'[^\\n]+capability:\\s*'([^']+)'`));assert.equal(definition?.[1],capability,tool);
    const route=server.split('\n').find(line=>line.includes(`/api/service/v1/${path}'`));assert.ok(route,path);assert.match(route,/req\.method\s*===\s*'POST'/);
  }
  for(const phrase of ['chaves anteriores não recebem essas permissões automaticamente','canais e departamentos permitidos','mantêm a autoria do agente','não promovem a identidade a administrador nem assumem o atendimento','não reenvie automaticamente','permissão de agendamento não concede envio imediato'])assert.ok(html.includes(phrase),phrase);
});

test('guia diferencia importação humana limitada de histórico recebido e não inventa capacidade de gestão',()=>{
  const html=render();for(const phrase of ['Buscar histórico antigo','administrador humano','fora do contexto de suporte','não está disponível para Telegram ou identidades de serviço','50, 100 ou 200 mensagens','referência real','receba uma nova mensagem','mídias antigas podem faltar','Não garante todas as mensagens','não reabre nem atribui atendimento','não aciona automações','consulte o mesmo pedido sem repetir','Fechar a janela apenas interrompe'])assert.ok(html.includes(phrase),phrase);
  assert.ok(!html.includes(code('channels.manage')));assert.ok(!html.includes('channels.manage'));assert.ok(!html.includes('100%'));assert.ok(html.includes('sem garantir a recuperação de conversas antigas'));
});

test('CTA grupos usa a mesma leitura humana da navegação, sem ganhar permissão de resumo ou envio',()=>{
  const allowed=render({session:operator});assert.ok(routes(allowed).includes('groups'));assert.ok(allowed.includes('inbox.reply'));
  for(const options of [{session:{...operator,permissions:['inbox.reply']}},{session:{kind:'service',role:'reseller'}},{session:operator,hasTenant:false}])assert.ok(!routes(render(options)).includes('groups'));
  const support=render({session:operator,supportGrantId:'private-grant'});assert.ok(routes(support).includes('groups'));assert.ok(!routes(support).includes('service-agents'));assert.ok(!support.includes('private-grant'));
});
