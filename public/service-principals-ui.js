import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, getLocale, translateError } from './i18n.js';
import { MCP_CAPABILITY_LABELS as labels } from './mcp-catalog.js';
import './locales-management.js';
import './locales-agent-journey.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = micros => (Number(micros || 0) / 1000000).toLocaleString(getLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const date = value => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(getLocale()) : i18nT('Indisponível'); };
// The capabilities the editor shows as checkboxes for this adapter. contact.read is a REST grant with no tool of its
// own, but docs/SERVICE-API.md has the admin turn it on here for the product backend's MCP identity.
const adapterCapabilities = agent => ['conversation.read', ...(agent?.mode === 'copilot' ? agent.provider === 'mcp' ? ['reply.submit'] : agent.provider === 'hermes' ? ['reply.draft'] : [] : []), 'handoff.request', 'company.read', 'company.propose', 'reply.send', 'message.schedule', 'events.read', 'conversation.manage', ...(agent?.provider === 'mcp' && agent?.mode === 'copilot' ? ['presence.typing'] : []), ...(agent?.provider === 'mcp' ? ['contact.read'] : [])];
const needsConversationRead = ['reply.draft', 'reply.submit', 'handoff.request', 'reply.send', 'message.schedule', 'events.read', 'conversation.manage', 'presence.typing', 'contact.read'];
// Grants of the identity that the editor does not draw for this adapter (notification.*, a capability the panel does
// not know yet, contact.read on a non-MCP adapter). They go back unchanged in every PATCH: never removed by omission.
const hiddenCapabilities = (capabilities, agent) => (Array.isArray(capabilities) ? capabilities : []).filter(value => typeof value === 'string' && !adapterCapabilities(agent).includes(value));
const objectives = Object.freeze({
  consult: { label: 'Consultar', help: 'Localizar contatos, assuntos e histórico nos canais autorizados.' },
  draft: { label: 'Preparar respostas', help: 'Preparar rascunhos para a equipe revisar e enviar.' },
  team: { label: 'Ajudar a equipe', help: 'Consultar atendimentos e solicitar encaminhamento à equipe.' },
  management: { label: 'Ajudar na gestão', help: 'Consultar a estrutura da empresa. Propostas de mudanças são opcionais.' }
});
const defaultCapabilities = (agent, objective = 'consult') => objective === 'management' ? ['company.read'] : ['conversation.read', ...(objective === 'draft' ? adapterCapabilities(agent).filter(value => ['reply.draft','reply.submit'].includes(value)) : objective === 'team' ? ['handoff.request'] : [])];
const inferObjective = capabilities => capabilities.includes('company.read') && !capabilities.includes('conversation.read') ? 'management' : capabilities.includes('handoff.request') ? 'team' : capabilities.some(value => ['reply.draft','reply.submit'].includes(value)) ? 'draft' : 'consult';
const httpsOrigin = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && ['/', ''].includes(url.pathname) ? url.origin : ''; } catch { return ''; } };

// The screen app.js created (one per page), read by the Central de Agentes (agents-hub-ui.js, P5):
// identities of connected agents in the list and in the detail's Acesso tab, without a new app.js dependency.
let latestScreen = null;
export const servicePrincipalsScreen = () => latestScreen;

export function createServicePrincipalsUI({ getContext, request, openModal, getModal = () => document.querySelector('#modal'), toast = () => {}, onUpdate = () => {}, onError = message => toast(message, true) } = {}) {
  let loadedKey = '', loadingKey = '', errorKey = '', generation = 0, loading = false, busy = false, items = [], editor = null, confirmation = null, secret = null, error = '', preparingExternal = false, preparationKey = '';
  const context = () => getContext() || {};
  const key = () => { const c = context(); return JSON.stringify([c.workspaceId || '', c.tenantId || '', c.userId || '', c.authorityKey || '', Boolean(c.isAdmin)]); };
  const base = c => `/api/tenants/${encodeURIComponent(c.tenantId)}/service-principals`;
  const current = expected => context().isAdmin && key() === expected;
  const options = c => ({ headers: { 'X-Elozi-Workspace': c.workspaceId } });
  const button = (action, label, id = '', danger = false) => i18nHtml`<button type="button" class="${danger ? 'text-button danger' : 'button'}" data-service-principal-action="${action}" data-id="${escape(id)}" style="min-height:44px;min-width:44px">${label}</button>`;
  const checked = (name, value, label, selected) => i18nHtml`<label class="checkbox-label"><input type="checkbox" name="${name}" value="${escape(value)}" ${selected ? 'checked' : ''}/> ${escape(label)}</label>`;
  const capabilityFields = (agent, selection = defaultCapabilities(agent)) => {
    const available = adapterCapabilities(agent);
    const groups = [
      { title: i18nT('Consulta de contexto'), help: i18nT('Leia atendimentos ou dados da empresa dentro do escopo autorizado.'), ids: ['conversation.read','company.read','contact.read'] },
      { title: i18nT('Rascunhos e propostas'), help: i18nT('Prepare texto para revisão humana, proponha melhorias ou peça apoio à equipe.'), ids: ['reply.draft','reply.submit','handoff.request','company.propose'] },
      { title: i18nT('Eventos e gestão do atendimento'), help: i18nT('Receba avisos e assuma, transfira, etiquete ou encerre atendimentos privados no escopo autorizado. Essas ações não se aplicam a grupos.'), ids: ['events.read','conversation.manage'] },
      { title: i18nT('Envio e agendamento'), help: i18nT('Envie nos grupos habilitados; agentes via MCP também podem responder em atendimentos privados atribuídos a eles. Agendamento é exclusivo dos grupos.'), ids: ['reply.send','message.schedule','presence.typing'] }
    ];
    return groups.map(group => i18nHtml`<section class="service-capability-group"><h4>${group.title}</h4><p>${group.help}</p>${group.ids.filter(id => available.includes(id)).map(id => checked('capabilities', id, labels[id], selection.includes(id))).join('')}</section>`).join('');
  };
  const preservedMarkup = () => editor?.preserved?.length ? i18nHtml`<p class="muted" data-service-preserved-capabilities>${i18nT('Mantidas sem alteração ao salvar (não editáveis nesta tela):')} ${escape(editor.preserved.map(id => labels[id] || id).join(' · '))}</p>` : '';
  const capabilityContent = (agent, selection) => capabilityLegend() + capabilityFields(agent, selection) + preservedMarkup();
  const withPreserved = selected => [...new Set([...selected, ...(editor?.preserved || [])])];
  const adapterHint = agent => agent?.provider === 'mcp' ? i18nT('Agente próprio: seu cliente MCP produz o texto e a plataforma recebe o rascunho autorizado.') : i18nT('Assistente interno: a plataforma chama o copiloto gerenciado para preparar o rascunho.');
  const objectiveFields = selection => i18nHtml`<label>1. Objetivo<select name="objective" style="min-height:44px">${Object.entries(objectives).map(([id, value]) => i18nHtml`<option value="${id}" ${selection === id ? 'selected' : ''}>${i18nT(value.label)}</option>`).join('')}</select><small data-service-objective-hint>${i18nT(objectives[selection].help)}</small></label>`;
  const capabilityLegend = () => i18nMarkup('<legend>Capacidades explícitas</legend><p class="muted">Enviar permite publicar texto sem revisão de cada mensagem nos grupos selecionados e, para agentes via MCP, nas conversas privadas atribuídas ao agente. Agendar publica somente nos grupos selecionados. Habilite essas ações apenas para agentes de confiança.</p>');
  function reviewMarkup(values) {
    const c = context(), agent = (c.agents || []).find(value => value.id === values.agentId);
    const scopeNames = (ids, choices) => ids === null ? i18nT('Todos nesta empresa') : ids.length ? ids.map(id => choices.find(value => value.id === id)?.name || id).join(' · ') : i18nT('Nenhum selecionado');
    return i18nHtml`<dl class="service-review-summary"><div><dt>Objetivo</dt><dd>${i18nT(objectives[editor?.objective || 'consult'].label)}</dd></div><div><dt>Adaptador</dt><dd>${escape(agent?.name || values.agentId)}</dd></div><div><dt>Capacidades</dt><dd>${escape(values.capabilities.map(id => labels[id] || id).join(' · ') || i18nT('Nenhuma capacidade autorizada'))}</dd></div><div><dt>Canais</dt><dd>${escape(scopeNames(values.channelIds, c.channels || []))}</dd></div><div><dt>Departamentos</dt><dd>${escape(scopeNames(values.departmentIds, [{ id: 'unassigned', name: i18nT('Sem departamento') }, ...(c.departments || [])]))}</dd></div><div><dt>Limites</dt><dd>${escape(values.dailyRequests)} ${i18nT('chamadas por dia')} · ${escape(values.maxConcurrent)} ${i18nT('execuções simultâneas')} · ${escape(values.ttlHours)} ${i18nT('horas de validade')}</dd></div><div><dt>Orçamento estimado</dt><dd>${values.dailyBudgetMicros > 0 ? i18nTxt`${money(values.dailyBudgetMicros)} por dia · ${money(values.estimatedRequestMicros)} por rascunho` : i18nT('Limite financeiro estimado não ativo')}</dd></div><div><dt>Serviço ativo</dt><dd>${values.active ? i18nT('Sim') : i18nT('Não')}</dd></div></dl>`;
  }
  function updateReview(form) {
    const summary = form.querySelector('[data-service-review-summary]');
    if (!summary) return;
    const fd = new FormData(form), pick = name => fd.has(name + '-all') ? null : fd.getAll(name);
    summary.innerHTML = reviewMarkup({ agentId: fd.get('agentId'), capabilities: withPreserved(fd.getAll('capabilities')), channelIds: pick('channelIds'), departmentIds: pick('departmentIds'), dailyRequests: fd.get('dailyRequests'), maxConcurrent: fd.get('maxConcurrent'), ttlHours: fd.get('ttlHours'), dailyBudgetMicros: Math.round(Number(fd.get('dailyBudgetUSD')) * 1000000), estimatedRequestMicros: Math.round(Number(fd.get('estimatedRequestUSD')) * 1000000), active: fd.has('active') });
  }
  function invalidateReview(form) { const checkbox = form.querySelector('input[name="reviewAccess"]'); if (checkbox) checkbox.checked = false; }
  function updateObjectiveStatus(form, agent) {
    const hint = form.querySelector('[data-service-objective-hint]'); if (hint) hint.textContent = i18nT(objectives[editor.objective].help);
    const status = form.querySelector('[data-service-objective-status]');
    if (status) status.textContent = objectiveStatus(agent);
  }
  function objectiveStatus(agent) {
    return editor.objective === 'draft' && !adapterCapabilities(agent).some(value => ['reply.draft','reply.submit'].includes(value)) ? i18nT('Este adaptador não prepara rascunhos. Escolha um copiloto gerenciado ou um agente MCP configurado.') : editor.removedCapabilities ? i18nT('Capacidades indisponíveis no novo adaptador foram removidas. As permissões compatíveis foram preservadas; revise o acesso.') : editor.customCapabilities ? i18nT('Permissões personalizadas preservadas. Confira as capacidades abaixo ou aplique as sugestões explicitamente.') : i18nT('Permissões mínimas sugeridas para este objetivo. Envio direto exige sua escolha explícita.');
  }
  function externalConnectMarkup() {
    return (context().agents || []).some(agent => agent.provider === 'mcp' && agent.configured === true)
      ? button('start-external', i18nT('Conectar meu agente via MCP'))
      : i18nHtml`<a class="button" href="#agents/connect/identity">${i18nT('Conectar meu agente via MCP')}</a>`;
  }
  function journeyMarkup() {
    return i18nHtml`<section class="service-journey" aria-labelledby="service-journey-title"><header><p class="service-journey-kicker">COMECE PELO TIPO DE AJUDA</p><h2 id="service-journey-title">Como seu agente vai ajudar?</h2><p>Escolha um objetivo e revise o acesso antes de criar a identidade.</p></header><div class="service-objective-choices">${Object.entries(objectives).map(([id, value]) => i18nHtml`<button type="button" class="service-objective-choice" data-service-principal-action="choose-objective" data-id="${id}"><strong>${i18nT(value.label)}</strong><span>${i18nT(value.help)}</span><span class="service-objective-next">Configurar acesso →</span></button>`).join('')}</div><details class="service-adapter-options"><summary>Onde o agente executa?</summary><div class="service-journey-choices"><article class="service-journey-choice"><span class="service-journey-kind">Dentro da plataforma</span><h3>Assistente interno</h3><p>Use o copiloto gerenciado desta empresa para preparar respostas na caixa de atendimento. A equipe revisa e envia os rascunhos.</p><button type="button" class="button" data-view="agents">Configurar assistente interno</button></article><article class="service-journey-choice"><span class="service-journey-kind">No seu ambiente</span><h3>Meu agente via MCP</h3><p>Conecte Claude Code, Codex ou outro cliente MCP que você já usa. Ele pode consultar os canais autorizados e entregar texto para revisão no painel.</p>${externalConnectMarkup()}</article></div></details><div class="service-journey-boundary"><strong>Uma identidade, uma empresa, vários canais autorizados.</strong><p>WhatsApp, Telegram, webchat e outros canais compartilham o histórico registrado no painel conforme o acesso concedido. Nos grupos, a seleção e as permissões do canal também precisam autorizar o acesso.</p><p>${i18nT('Você configura o cliente MCP no seu ambiente. Criar a identidade e a chave não instala nem conecta o cliente.')}</p><p>${i18nT('Fotos, vídeos, áudios e documentos chegam ao agente como metadados autorizados; visão e transcrição não estão disponíveis pelo MCP.')}</p><p>Para ajudar em outras plataformas, conecte as ferramentas do sistema de destino e autorize as ações naquele sistema. A conexão com o painel não concede esse acesso automaticamente.</p><div class="service-journey-links"><button type="button" class="text-button" data-view="channels">Conferir canais e grupos</button><button type="button" class="text-button" data-view="agent-tools">Ferramentas de outras plataformas</button><button type="button" class="text-button" data-view="guide">Guia e APIs</button></div></div>${preparingExternal && preparationKey === key() ? i18nHtml`<section class="service-journey-preparation" role="status"><h3>Prepare a conexão do seu agente</h3><ol><li>${i18nT('Abra o assistente de conexão para cadastrar seu agente MCP.')}</li><li>${i18nT('Escolha o objetivo e revise o acesso antes de criar a identidade e a chave.')}</li><li>${i18nT('Depois, configure o cliente MCP no seu ambiente e valide uma consulta autorizada.')}</li></ol><p>Este passo orienta a configuração. Nenhuma identidade ou chave foi criada.</p><a class="button" href="#agents/connect/identity">${i18nT('Conectar meu agente via MCP')}</a></section>` : ''}</section>`;
  }
  function connectionMarkup(item) {
    const origin = httpsOrigin(context().publicOrigin), endpoint = origin ? origin + '/api/agent/mcp' : '';
    const queryStep = item.capabilities?.includes('conversation.read')
      ? i18nT('Para validar a consulta, use elozi_search_conversations ou elozi_read_conversation_history na empresa autorizada e confira o recibo e o escopo retornados. A pesquisa usa o histórico registrado no painel.')
      : i18nT('Valide uma ferramenta de consulta do catálogo permitido e confira o recibo e o escopo retornados.');
    return i18nHtml`<div class="dialog-detail service-connection-guide"><h3>Conectar seu agente pelo MCP</h3><p>Claude Code, Codex, OpenClaw ou outro agente existente pode usar o próprio cliente MCP para acessar o painel. O agente continua executando no ambiente que você já utiliza.</p><div class="service-endpoint"><p><strong>Servidor MCP do painel</strong></p><p class="muted">Use a origem desta implantação e valide a primeira chamada no cliente do seu agente.</p>${endpoint ? i18nHtml`<label>Endpoint MCP<input readonly value="${escape(endpoint)}" autocomplete="off" spellcheck="false" style="min-height:44px;width:100%"/></label>` : i18nMarkup('<p class="form-error" role="status">A origem HTTPS desta implantação ainda não foi confirmada. Configure o endereço antes de conectar o cliente MCP.</p>')}</div><ol class="service-connection-steps"><li>Cadastre o endpoint no cliente MCP do seu agente e use <code>Authorization: Bearer SUA_CHAVE</code> na configuração privada.</li><li>${i18nT('Use a mesma chave desta identidade no MCP e na API REST. No cliente MCP, descubra tools/list e confirme sua identidade com elozi_me. O GET /api/service/v1/me confere somente o acesso REST.')}</li><li>${item.capabilities?.includes('reply.submit') ? i18nMarkup('Com a capacidade de entregar texto, use <code>elozi_submit_draft</code> para preparar um rascunho externo para revisão humana.') : item.capabilities?.includes('reply.draft') ? i18nT('Com a capacidade de pedir rascunho, a plataforma chama o copiloto gerenciado desta empresa.') : i18nT('Esta identidade consulta atendimentos e solicita apoio apenas conforme suas capacidades.')} ${i18nT('Rascunhos são revisados pelo atendente. Com permissão explícita, agentes via MCP podem responder nas conversas privadas atribuídas a eles e enviar nos grupos selecionados. Agendamento vale somente para grupos selecionados.')}</li><li>${queryStep}</li><li>Fotos, vídeos, áudios e documentos aparecem no MCP como metadados de anexos. Esta consulta não baixa nem interpreta o conteúdo das mídias.</li></ol><p>Um assistente principal pode consultar todos os canais e departamentos permitidos nesta empresa. Para reunir várias empresas em um único cliente, use o conector central com uma identidade própria para cada empresa; confira a configuração em Guia e APIs.</p><div class="service-guide-access"><p><strong>${escape(item.name)}</strong></p><p>${escape((item.capabilities || []).map(value => labels[value] || value).join(' · '))}</p><p class="muted">O acesso respeita os canais, departamentos, validade e cotas desta identidade. Revogar ou trocar a chave encerra o acesso anterior em REST e MCP; os recibos permanecem.</p></div><details class="service-platform-help"><summary>Agentes em outras plataformas</summary><p>O mesmo agente pode ajudar em qualquer sistema para o qual tenha ferramentas compatíveis e autorização própria. Escolha os sistemas, os dados e as ações permitidos em cada conexão.</p><p>Para consultar várias empresas, cada conexão precisa de uma identidade da empresa correspondente. Uma chave de uma empresa não abre as demais.</p></details><details><summary>MCP do painel e ferramentas externas</summary><p>Este servidor permite que o seu agente consulte o painel. Em Agentes › Ferramentas, o caminho é o inverso: ferramentas de outros sistemas são concedidas ao copiloto gerenciado, com aprovação do responsável em cada execução.</p></details></div>`;
  }
  function clearSecret() { secret = null; const input = getModal()?.querySelector?.('[data-service-secret]'); if (input) { input.value = ''; input.removeAttribute?.('value'); } }
  getModal()?.addEventListener?.('close', () => { clearSecret(); editor = null; confirmation = null; });
  getModal()?.addEventListener?.('input', event => handleChange(event));
  function reset() { generation++; loading = false; loadedKey = ''; loadingKey = ''; errorKey = ''; items = []; editor = null; confirmation = null; error = ''; preparingExternal = false; preparationKey = ''; clearSecret(); }
  async function load({ force = false } = {}) {
    const c = context(), expected = key();
    if (!c.isAdmin || !c.tenantId) { reset(); return; }
    if (!force && expected === loadedKey) return;
    if (loadedKey && loadedKey !== expected) { editor = null; confirmation = null; clearSecret(); }
    const ticket = ++generation; loading = true; loadingKey = expected; error = ''; errorKey = '';
    try {
      const result = await request(base(c), options(c));
      if (!current(expected) || ticket !== generation) return;
      if (!Array.isArray(result.principals)) throw new Error('Não foi possível confirmar a lista de serviços.');
      items = result.principals; loadedKey = expected;
    } catch (failure) { if (current(expected) && ticket === generation) { error = failure.message || 'Não foi possível consultar os serviços.'; errorKey = expected; loadedKey = ''; } }
    finally { if (ticket === generation) { loading = false; loadingKey = ''; } }
  }
  function markup() {
    const c = context(); if (!c.isAdmin) return '';
    const visible = loadedKey === key() ? items : [];
    return i18nHtml`<section class="service-principals" aria-label="Identidades de serviço" aria-busy="${loading}">${journeyMarkup()}<div class="service-panel-heading"><h2>Acessos da empresa</h2><div class="service-panel-actions">${button('refresh', i18nT('Atualizar'))}${button('create', i18nT('Conectar serviço'))}</div></div><details class="service-review-note"><summary>Como funciona o acesso</summary><div class="service-review-content"><strong>Você mantém o controle do atendimento.</strong><p>Serviços consultam atendimentos, entregam rascunhos e pedem apoio à equipe. Você pode autorizar também envio nos grupos habilitados e, para agentes via MCP, nas conversas privadas atribuídas ao agente. Agendamento vale somente para grupos; essas permissões começam desmarcadas. Eles não são usuários administradores.</p></div></details>${error ? i18nHtml`<p class="form-error service-feedback" role="alert">${escape(translateError(error))}</p>` : ''}${loading ? i18nMarkup('<p class="service-feedback" role="status">Consultando serviços…</p>') : ''}${visible.length ? i18nHtml`<div class="service-list-heading"><span>${visible.length} ${visible.length === 1 ? i18nT('identidade cadastrada') : i18nT('identidades cadastradas')}</span></div><ul class="service-principal-list">${visible.map(item => principalMarkup(item, c)).join('')}</ul>` : !loading && !error ? i18nMarkup('<div class="service-empty"><h3>Conecte seu primeiro agente</h3><p>Conecte o primeiro serviço usando um adaptador configurado nesta empresa.</p><p>Escolha o agente, autorize os canais e defina os limites. Ao concluir, você recebe a chave para configurar seu cliente.</p></div>') : ''}<div class="service-quota-note"><strong>Como os limites funcionam</strong><p>As cotas viram à meia-noite UTC. O orçamento usa a estimativa por rascunho configurada por você; não mede a cobrança real do provedor nem limita o consumo do seu agente externo.</p></div></section>`;
  }
  function principalMarkup(item, c) {
    const agent = (c.agents || []).find(value => value.id === item.agentId);
    const state = ['active', 'paused', 'revoked', 'expired'].includes(item.state) ? item.state : 'unknown';
    const stateLabel = { active: i18nT('Acesso ativo'), paused: i18nT('Pausado'), revoked: i18nT('Revogado'), expired: i18nT('Expirado'), unknown: i18nT('Indisponível') }[state];
    const provider = { mcp: 'MCP', hermes: i18nT('Copiloto'), claude: 'Claude', codex: 'Codex', webhook: 'API' }[agent?.provider] || i18nT('Agente');
    const names = (ids, choices) => (ids || []).map(id => choices.find(value => value.id === id)?.name || id).map(escape).join(' · ');
    const channelCount = item.channelIds?.length || 0, departmentCount = item.departmentIds?.length || 0;
    const channelNames = item.channelIds === null ? i18nT('Todos os canais') : `${channelCount} ${channelCount === 1 ? i18nT('canal') : i18nT('canais')} · ${names(item.channelIds, c.channels || []) || i18nT('Nenhum canal autorizado')}`;
    const departmentNames = item.departmentIds === null ? i18nT('Todos os departamentos') : `${departmentCount} ${departmentCount === 1 ? i18nT('departamento') : i18nT('departamentos')} · ${names(item.departmentIds, [{ id: 'unassigned', name: i18nT('Sem departamento') }, ...(c.departments || [])]) || i18nT('Nenhum departamento autorizado')}`;
    return i18nHtml`<li><article class="service-principal-card" aria-label="${escape(item.name)}"><div class="service-card-heading"><div class="service-identity"><span class="service-adapter-mark" aria-hidden="true">${provider}</span><div><h3>${escape(item.name)}</h3><p>${escape(agent?.name || item.agentId)}</p></div></div><span class="service-state service-state-${state}">${stateLabel}</span></div><div class="service-card-details"><section class="service-permissions"><h4>Permissões e escopo</h4><ul class="service-capability-list">${(item.capabilities || []).map(value => i18nHtml`<li>${escape(labels[value] || value)}</li>`).join('') || i18nMarkup('<li>Nenhuma capacidade autorizada</li>')}</ul><dl class="service-scope"><div><dt>Canais</dt><dd>${channelNames}</dd></div><div><dt>Departamentos</dt><dd>${departmentNames}</dd></div></dl></section><section class="service-limits"><h4>Consumo e limites</h4><strong class="service-usage">${item.usage?.requests || 0}/${item.dailyRequests} ${item.dailyRequests === 1 ? i18nT('chamada') : i18nT('chamadas')} <span>por dia (UTC)</span></strong><p>${item.maxConcurrent} ${item.maxConcurrent === 1 ? i18nT('execução simultânea') : i18nT('execuções simultâneas')}</p><div class="service-budget"><span>Orçamento diário</span><p>${item.budgetEnabled ? i18nTxt`${money(item.usage?.budgetMicros)} / ${money(item.dailyBudgetMicros)} estimados` : i18nT('Limite financeiro estimado não ativo')}</p></div></section><section class="service-validity"><h4>Validade do acesso</h4><p class="service-expiry">${escape(date(item.expiresAt))}</p><p>Configuração ${item.revision} · chave ${item.keyRevision}</p>${state === 'revoked' ? i18nMarkup('<span class="service-preserved">Recibos preservados</span>') : ''}</section></div>${lastCallMarkup(item)}${webhookMarkup(item)}<div class="service-card-actions"><div class="service-guide-actions">${button('connection-guide', i18nT('Como conectar'), item.id)}${button('receipts', i18nT('Recibos'), item.id)}</div>${item.state !== 'revoked' ? i18nHtml`<div class="service-management-actions" aria-label="Gerenciar acesso">${button('edit', i18nT('Editar'), item.id)}${item.state !== 'expired' ? button('confirm-rotate', i18nT('Trocar chave'), item.id) : ''}${button('confirm-revoke', i18nT('Revogar'), item.id, true)}</div>` : i18nMarkup('<p>Acesso encerrado. O histórico continua disponível.</p>')}</div></article></li>`;
  }
  /** Signed webhook of this identity (configured through the API; the secret is never shown here). */
  function webhookMarkup(item) {
    const hook = item.webhook;
    if (!hook?.configured) return item.capabilities?.includes('events.read') ? i18nHtml`<p class="muted" data-service-webhook>${i18nT('Webhook não configurado. Ele é cadastrado pela API, com o segredo do produto.')}</p>` : '';
    const origin = (() => { try { return new URL(hook.url).origin; } catch { return ''; } })();
    const status = hook.lastStatus ? i18nT('Último retorno {status}', { status: hook.lastStatus }) : i18nT('Nenhuma entrega ainda');
    const toggle = item.state === 'active' || hook.enabled ? button('webhook-toggle', hook.enabled ? i18nT('Desligar webhook') : i18nT('Ligar webhook'), item.id, hook.enabled) : '';
    return i18nHtml`<section class="service-webhook" data-service-webhook><h4>${i18nT('Webhook assinado')}</h4><p><span class="service-state service-state-${hook.enabled ? 'active' : 'paused'}">${hook.enabled ? i18nT('Ligado') : i18nT('Desligado')}</span> ${escape(origin)}</p><p class="muted">${escape(status)} · ${i18nT('{count} falhas seguidas', { count: hook.failures || 0 })} · ${i18nT('{count} pendentes', { count: hook.pending || 0 })} · ${i18nT('Segredo {fingerprint}', { fingerprint: hook.secretFingerprint || '' })}</p>${toggle}</section>`;
  }
  function lastCallMarkup(item) {
    const known = Object.hasOwn(item, 'lastSeenAt'), when = typeof item.lastSeenAt === 'string' && Number.isFinite(Date.parse(item.lastSeenAt)) ? date(item.lastSeenAt) : '';
    const label = when ? i18nT('Última chamada autenticada: {when}', { when }) : known && item.lastSeenAt === null ? i18nT('Nenhuma chamada registrada nesta identidade.') : i18nT('Última chamada indisponível nesta atualização.');
    return i18nHtml`<p class="muted" data-service-last-call>${escape(label)}<br/>${i18nT('Uma chamada autenticada não comprova uma consulta validada.')}</p>`;
  }
  function edit(item, preferredAgentId = '', preferredObjective = 'consult') {
    const c = context(), expected = key(); if (!c.isAdmin || !c.tenantId) throw new Error('A gestão dos serviços pertence ao administrador da empresa.');
    clearSecret(); confirmation = null;
    const agents = (c.agents || []).filter(agent => agent.configured === true);
    if (!agents.length) throw new Error('Configure primeiro um adaptador de agente nesta empresa.');
    const requestedAgentId = item?.agentId || preferredAgentId;
    if (requestedAgentId && !agents.some(agent => agent.id === requestedAgentId)) throw new Error('O agente escolhido não está mais habilitado nesta empresa. Atualize a configuração antes de criar ou editar o acesso.');
    editor = { key: expected, token: String(++generation), id: item?.id || null, revision: item?.revision || null, objective: item ? inferObjective(item.capabilities || []) : preferredObjective, customCapabilities: Boolean(item) };
    const scope = (name, caption, values, selection) => i18nHtml`<fieldset class="service-scope-field"><legend>${caption}</legend><p>${name === 'channelIds' ? i18nT('Todos inclui canais atuais e futuros desta empresa. Para restringir o acesso, selecione canais específicos.') : i18nT('Todos inclui departamentos atuais e futuros. Uma seleção específica restringe o acesso aos departamentos marcados.')}</p>${checked(name + '-all', 'all', i18nT('Todos nesta empresa'), selection === null)}${values.map(value => checked(name, value.id, value.name, selection?.includes(value.id))).join('')}</fieldset>`;
    const selectedAgent = agents.find(value => value.id === requestedAgentId) || agents[0];
    const capabilities = item?.capabilities || defaultCapabilities(selectedAgent, editor.objective);
    editor.preserved = item ? hiddenCapabilities(item.capabilities, selectedAgent) : [];
    const initialReview = { agentId: selectedAgent.id, capabilities, channelIds: item ? item.channelIds : [], departmentIds: item ? item.departmentIds : [], dailyRequests: item?.dailyRequests || 100, maxConcurrent: item?.maxConcurrent || 1, ttlHours: item ? Math.max(1, Math.min(2160, Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 3600000))) : 168, dailyBudgetMicros: item?.dailyBudgetMicros || 0, estimatedRequestMicros: item?.estimatedRequestMicros || 0, active: item ? item.active : true };
    const number = (name, label, value, min, max, step = 1) => i18nHtml`<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" required style="min-height:44px"/></label>`;
    openModal(item ? i18nT('Editar serviço') : i18nT('Conectar serviço'), i18nT('A chave permite somente as ações escolhidas nesta empresa.'), i18nHtml`<form data-service-principal-form="editor" data-service-principal-token="${editor.token}"><div class="service-editor-context"><strong>Você está autorizando acesso à empresa atual.</strong><p>Uma identidade pertence a uma empresa. Para consultar várias empresas, crie uma identidade por empresa e configure cada conexão no seu cliente.</p><p>Consulta usa o histórico registrado. Não importa mensagens do aparelho nem conecta canais por conta própria.</p></div>${objectiveFields(editor.objective)}<h3 class="service-editor-step">2. Adaptador</h3><label>Nome do serviço<input name="name" value="${escape(item?.name || '')}" maxlength="80" required style="min-height:44px" autocomplete="off"/></label><label>Agente habilitado<select name="agentId" required style="min-height:44px">${agents.map(agent => i18nHtml`<option value="${escape(agent.id)}" ${selectedAgent.id === agent.id ? 'selected' : ''}>${escape(agent.name)}</option>`).join('')}</select><small>Permissões personalizadas compatíveis são preservadas ao trocar o adaptador. Revise o acesso antes de salvar.</small><small data-service-adapter-hint>${adapterHint(selectedAgent)}</small></label><h3 class="service-editor-step">3. Capacidades e escopo</h3><p class="service-objective-status" data-service-objective-status role="status">${objectiveStatus(selectedAgent)}</p><button type="button" class="text-button" data-service-principal-action="apply-objective" style="min-height:44px">Usar permissões sugeridas</button><fieldset data-service-capabilities>${capabilityContent(selectedAgent, capabilities)}</fieldset><p class="muted">Selecione canais e departamentos. Sem seleção, o serviço não acessa atendimentos.</p>${scope('channelIds', i18nT('Canais autorizados'), c.channels || [], item ? item.channelIds : [])}${scope('departmentIds', i18nT('Departamentos autorizados'), [{ id: 'unassigned', name: i18nT('Sem departamento') }, ...(c.departments || []).filter(value => value.active !== false)], item ? item.departmentIds : [])}<h3 class="service-editor-step">4. Limites e validade</h3><div class="form-row">${number('dailyRequests', i18nT('Chamadas por dia'), item?.dailyRequests || 100, 1, 10000)}${number('maxConcurrent', i18nT('Execuções simultâneas'), item?.maxConcurrent || 1, 1, 20)}</div><div class="form-row">${number('dailyBudgetUSD', i18nT('Limite estimado por dia (USD)'), (item?.dailyBudgetMicros || 0) / 1000000, 0, 100, 0.000001)}${number('estimatedRequestUSD', i18nT('Estimativa por rascunho (USD)'), (item?.estimatedRequestMicros || 0) / 1000000, 0, 100, 0.000001)}</div><p class="muted">Use zero nos dois valores enquanto não tiver uma estimativa. Os valores são estimados em dólar, sem consulta à fatura do provedor. O limite financeiro só protege após configurar a estimativa; a cota de chamadas e simultaneidade sempre protegem.</p>${number('ttlHours', item ? i18nT('Renovar validade a partir de agora (horas)') : i18nT('Validade da chave (horas)'), item ? Math.max(1, Math.min(2160, Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 3600000))) : 168, 1, 2160)}${checked('active', 'yes', i18nT('Serviço ativo'), item ? item.active : true)}<p class="muted">A chave aparece uma vez após criar ou trocar. Alterar acesso invalida execuções que ainda aguardam despacho; resultados conhecidos permanecem no histórico.</p><section class="service-editor-review" aria-labelledby="service-review-title"><h3 id="service-review-title" class="service-editor-step">5. Revise o acesso</h3><div data-service-review-summary>${reviewMarkup(initialReview)}</div><label class="checkbox-label service-review-confirm"><input type="checkbox" name="reviewAccess" value="yes" required/> Revisei capacidades, canais, departamentos e limites desta empresa.</label></section><p class="form-error" role="alert"></p><div class="modal-actions"><button type="button" class="button" data-close-modal style="min-height:44px">Cancelar</button><button type="submit" class="button primary" style="min-height:44px">${item ? i18nT('Salvar serviço') : i18nT('Criar identidade e chave')}</button></div></form>`);
  }
  function showSecret(result, expected, expectedId) {
    if (!current(expected)) { result.token = ''; return; }
    if (!result.principal?.id || expectedId && result.principal.id !== expectedId || typeof result.token !== 'string' || !/^elozi_svc_[A-Za-z0-9_-]{43}$/.test(result.token)) { result.token = ''; throw new Error('A resposta não confirmou a nova chave. Atualize a lista antes de tentar novamente.'); }
    clearSecret(); secret = { key: expected, token: result.token }; result.token = '';
    openModal(i18nT('Chave criada'), i18nT('Cadastre esta chave no serviço que você está conectando.'), i18nHtml`<div class="dialog-detail"><label>Chave de uso exclusivo<input readonly data-service-secret value="${escape(secret.token)}" autocomplete="off" spellcheck="false" aria-label="Chave do serviço" style="min-height:44px;width:100%"/></label><p class="muted">Esta chave não poderá ser mostrada novamente. Depois de fechar, será necessário trocar a chave se você perdê-la.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">GET /api/service/v1/me\nAuthorization: Bearer SUA_CHAVE</pre>${connectionMarkup(result.principal)}<p class="form-error" role="alert"></p><div class="modal-actions">${button('copy-key', i18nT('Copiar chave'))}<button type="button" class="button primary" data-close-modal style="min-height:44px">Concluir</button></div></div>`);
  }
  async function action(name, id) {
    if (!['refresh', 'create', 'choose-objective', 'apply-objective', 'start-external', 'edit', 'connection-guide', 'confirm-rotate', 'confirm-revoke', 'rotate', 'revoke', 'copy-key', 'receipts', 'webhook-toggle'].includes(name)) return false;
    const c = context(), expected = key();
    if (!c.isAdmin) { onError(i18nT('A gestão dos serviços pertence ao administrador desta empresa.')); return true; }
    if (busy) return true;
    try {
      if (name === 'refresh') { await load({ force: true }); if (current(expected)) { onUpdate(); toast(error || i18nT('Serviços atualizados.'), Boolean(error)); } return true; }
      if (name === 'start-external') {
        const adapter = (c.agents || []).find(agent => agent.provider === 'mcp' && agent.configured === true);
        if (adapter) { preparingExternal = false; edit(undefined, adapter.id); } else { preparingExternal = true; preparationKey = expected; onUpdate(); }
        return true;
      }
      if (name === 'choose-objective') {
        if (!Object.hasOwn(objectives, id)) throw new Error('Escolha um objetivo disponível.');
        if (!(c.agents || []).some(agent => agent.configured === true)) { preparingExternal = true; preparationKey = expected; onUpdate(); return true; }
        preparingExternal = false; edit(undefined, '', id); return true;
      }
      if (name === 'apply-objective') {
        const form = getModal()?.querySelector?.('[data-service-principal-form="editor"]');
        if (!form || !editor || editor.key !== expected || editor.token !== form.dataset.servicePrincipalToken) throw new Error('Abra o editor na empresa e sessão atuais.');
        const agent = (c.agents || []).find(value => value.id === form.querySelector('[name="agentId"]')?.value && value.configured === true);
        if (!agent) throw new Error('Escolha um agente habilitado e apenas as capacidades disponíveis para ele.');
        editor.customCapabilities = false;
        editor.removedCapabilities = false;
        const fieldset = form.querySelector('[data-service-capabilities]'); if (fieldset) fieldset.innerHTML = capabilityContent(agent, defaultCapabilities(agent, editor.objective));
        invalidateReview(form); updateObjectiveStatus(form, agent); updateReview(form); return true;
      }
      if (name === 'create') { edit(undefined, id); return true; }
      if (name === 'webhook-toggle') {
        const item = items.find(value => value.id === id);
        if (!item?.webhook?.configured || loadedKey !== expected) throw new Error('O webhook desta identidade não está configurado.');
        const enabled = !item.webhook.enabled;
        busy = true;
        try { await request(base(c) + '/' + encodeURIComponent(id) + '/webhook', { ...options(c), method: 'PUT', body: JSON.stringify({ enabled, revision: item.webhook.revision }) }); }
        finally { busy = false; }
        await load({ force: true });
        if (current(expected)) { onUpdate(); toast(enabled ? i18nT('Webhook ligado. As próximas mudanças serão enviadas ao destino.') : i18nT('Webhook desligado. Entregas pendentes foram canceladas.')); }
        return true;
      }
      if (name === 'copy-key') {
        if (!secret || secret.key !== expected || !getModal()?.querySelector?.('[data-service-secret]')) throw new Error('A chave já deixou de estar disponível nesta tela.');
        if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Selecione a chave exibida e copie manualmente.');
        await navigator.clipboard.writeText(secret.token); if (current(expected)) toast(i18nT('Chave copiada. Cadastre somente no serviço autorizado.')); return true;
      }
      const item = loadedKey === expected && items.find(principal => principal.id === id);
      if (!item) throw new Error('Atualize os serviços antes de abrir esta ação.');
      if (name === 'edit') { edit(item); return true; }
      if (name === 'connection-guide') {
        clearSecret(); editor = null; confirmation = null;
        openModal(i18nT('Conectar agente próprio'), item.name, connectionMarkup(item) + i18nMarkup('<div class="modal-actions"><button type="button" class="button primary" data-close-modal style="min-height:44px">Entendido</button></div>')); return true;
      }
      if (name.startsWith('confirm-')) {
        clearSecret(); confirmation = { key: expected, id, revision: item.revision, action: name.slice(8) };
        openModal(name === 'confirm-rotate' ? i18nT('Trocar chave') : i18nT('Revogar serviço'), item.name, i18nHtml`<div class="dialog-detail"><p>${name === 'confirm-rotate' ? i18nT('A chave anterior deixará de funcionar imediatamente. A nova será exibida uma vez.') : i18nT('O serviço perderá acesso. O histórico e os recibos serão preservados.')}</p><p class="form-error" role="alert"></p><div class="modal-actions"><button type="button" class="button" data-close-modal style="min-height:44px">Cancelar</button>${button(confirmation.action, name === 'confirm-rotate' ? i18nT('Trocar chave agora') : i18nT('Revogar agora'), id, true)}</div></div>`); return true;
      }
      busy = true;
      if (name === 'receipts') {
        const result = await request(base(c) + '/' + encodeURIComponent(id) + '/receipts', options(c)); if (!current(expected)) return true;
        openModal(i18nT('Recibos do serviço'), item.name, i18nHtml`<div class="dialog-detail service-receipts"><p class="muted">Recibos conhecidos são preservados. Resultado incerto não deve ser repetido automaticamente.</p><ul class="service-receipt-list">${(result.receipts || []).map(receipt => i18nHtml`<li><div class="service-receipt-heading"><strong>${escape(labels[receipt.capability] || receipt.capability)}</strong><span>${escape({ confirmed: i18nT('Confirmado'), reserved: i18nT('Reservado'), pending: i18nT('Pendente'), failed: i18nT('Falhou'), unknown: i18nT('Resultado incerto'), rejected: i18nT('Recusado') }[receipt.state] || receipt.state)}${receipt.stale ? i18nT(' · acesso anterior') : ''}</span></div><dl><div><dt>Solicitação</dt><dd>${escape(receipt.requestId)}</dd></div><div><dt>Registrada</dt><dd>${escape(date(receipt.createdAt))}</dd></div></dl></li>`).join('') || i18nMarkup('<li class="service-receipt-empty">Nenhuma solicitação registrada.</li>')}</ul></div>`); return true;
      }
      if (!confirmation || confirmation.key !== expected || confirmation.id !== id || confirmation.action !== name) throw new Error('Abra a confirmação desta ação novamente.');
      const result = await request(base(c) + '/' + encodeURIComponent(id) + '/' + name, { ...options(c), method: 'POST', body: JSON.stringify({ revision: confirmation.revision }) });
      if (!current(expected)) { if (result.token) result.token = ''; return true; }
      confirmation = null;
      if (name === 'rotate') showSecret(result, expected, id); else { if (result.principal?.id !== id || result.principal?.state !== 'revoked') throw new Error('A resposta não confirmou a revogação. Atualize a lista antes de tentar novamente.'); getModal()?.close(); toast(i18nT('Serviço revogado.')); }
      await load({ force: true });
      if (current(expected)) onUpdate();
    } catch (failure) { if (current(expected)) { const target = getModal()?.querySelector?.('.form-error'); if (target) target.textContent = translateError(failure.message); onError(translateError(failure.message)); } }
    finally { busy = false; }
    return true;
  }
  async function submit(form) {
    if (form?.dataset?.servicePrincipalForm !== 'editor') return false;
    if (busy) return true;
    const expected = key(), c = context(), feedback = form.querySelector('.form-error'); if (feedback) feedback.textContent = '';
    if (!editor || editor.key !== expected || editor.token !== form.dataset.servicePrincipalToken || !current(expected)) { if (feedback) feedback.textContent = i18nT('Abra o editor na empresa e sessão atuais.'); return true; }
    const fd = new FormData(form), pick = name => fd.has(name + '-all') ? null : fd.getAll(name);
    const selected = fd.getAll('capabilities');
    const payload = { name: String(fd.get('name') || '').trim(), agentId: fd.get('agentId'), capabilities: withPreserved(selected), channelIds: pick('channelIds'), departmentIds: pick('departmentIds'),
      dailyRequests: Number(fd.get('dailyRequests')), dailyBudgetMicros: Math.round(Number(fd.get('dailyBudgetUSD')) * 1000000), estimatedRequestMicros: Math.round(Number(fd.get('estimatedRequestUSD')) * 1000000), maxConcurrent: Number(fd.get('maxConcurrent')), ttlHours: Number(fd.get('ttlHours')), active: fd.has('active') };
    const agent = (c.agents || []).find(value => value.id === payload.agentId && value.configured === true);
    // Only what this screen offers is checked here; preserved grants go back as they are and the server validates them.
    if (!agent || selected.some(value => !adapterCapabilities(agent).includes(value))) { if (feedback) feedback.textContent = i18nT('Escolha um agente habilitado e apenas as capacidades disponíveis para ele.'); return true; }
    if (payload.capabilities.includes('company.propose') && !payload.capabilities.includes('company.read')) { if (feedback) feedback.textContent = i18nT('Autorize Ler a empresa para propor agentes e fluxos.'); return true; }
    if (!payload.capabilities.length || payload.capabilities.some(value => needsConversationRead.includes(value)) && !payload.capabilities.includes('conversation.read')) { if (feedback) feedback.textContent = i18nT('Mantenha leitura de atendimentos para autorizar rascunhos, encaminhamento, envio, agendamento, eventos ou gestão.'); return true; }
    if (payload.dailyBudgetMicros > 0 && payload.estimatedRequestMicros <= 0) { if (feedback) feedback.textContent = i18nT('Defina a estimativa por rascunho antes de ativar o orçamento.'); return true; }
    if (!fd.has('reviewAccess')) { if (feedback) feedback.textContent = i18nT('Revise e confirme o acesso antes de salvar.'); return true; }
    busy = true; const submitting = form.querySelector('[type="submit"]'); if (submitting) submitting.disabled = true;
    const original = editor;
    try {
      if (original.id) payload.revision = original.revision;
      const result = await request(base(c) + (original.id ? '/' + encodeURIComponent(original.id) : ''), { ...options(c), method: original.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      if (!current(expected) || editor !== original) { if (result.token) result.token = ''; return true; }
      if (original.id && (result.principal?.id !== original.id || !Number.isSafeInteger(result.principal?.revision) || result.principal.revision <= original.revision)) throw new Error('A resposta não confirmou a alteração. Atualize a lista antes de tentar novamente.');
      editor = null;
      if (original.id) { getModal()?.close(); toast(i18nT('Acesso do serviço atualizado.')); } else showSecret(result, expected);
      await load({ force: true });
      if (current(expected)) onUpdate();
    } catch (failure) {
      if (current(expected)) {
        if (feedback) feedback.textContent = failure.status ? translateError(failure.message) : i18nT('Não foi possível confirmar a criação ou alteração. Atualize a lista e confira o serviço antes de tentar novamente; a chave não será reexibida.');
        if (!failure.status) editor = null;
      }
    } finally { busy = false; if (submitting) submitting.disabled = false; }
    return true;
  }
  function handleChange(event) {
    const target = event?.target;
    const agentChange = target?.matches?.('[data-service-principal-form="editor"] select[name="agentId"]');
    const objectiveChange = target?.matches?.('[data-service-principal-form="editor"] select[name="objective"]');
    const scopeChange = ['channelIds','channelIds-all','departmentIds','departmentIds-all'].includes(target?.name) && target?.matches?.('[data-service-principal-form="editor"] input[type="checkbox"]');
    const capabilityChange = target?.name === 'capabilities' && target?.matches?.('[data-service-principal-form="editor"] input[type="checkbox"]');
    const editorChange = target?.matches?.('[data-service-principal-form="editor"] input, [data-service-principal-form="editor"] select');
    if (!agentChange && !objectiveChange && !scopeChange && !capabilityChange && !editorChange) return false;
    const form = target.closest('form'), expected = key();
    if (!form || !editor || editor.key !== expected || editor.token !== form.dataset.servicePrincipalToken || !current(expected)) return true;
    if (target.name !== 'reviewAccess') invalidateReview(form);
    if (capabilityChange) editor.customCapabilities = true;
    if (objectiveChange) {
      if (!Object.hasOwn(objectives, target.value)) return true;
      editor.objective = target.value;
    }
    if (scopeChange) {
      if (target.checked) {
        const all = target.name.endsWith('-all'), name = all ? target.name.slice(0,-4) : target.name;
        if (all) for (const checkbox of form.querySelectorAll?.('input[name="' + name + '"]') || []) checkbox.checked = false;
        else { const checkbox = form.querySelector('input[name="' + name + '-all"]'); if (checkbox) checkbox.checked = false; }
      }
    }
    if (agentChange || objectiveChange) {
      const agentId = agentChange ? target.value : form.querySelector('[name="agentId"]')?.value;
      const agent = (context().agents || []).find(value => value.id === agentId && value.configured === true), fieldset = form.querySelector('[data-service-capabilities]');
      if (agent && fieldset) {
        const previous = [...(form.querySelectorAll?.('input[name="capabilities"]:checked') || [])].map(input => input.value), available = adapterCapabilities(agent);
        const kept = previous.filter(value => available.includes(value));
        // A preserved grant this adapter draws becomes a checked box again; the others stay preserved.
        const shown = (editor.preserved || []).filter(value => available.includes(value));
        editor.preserved = (editor.preserved || []).filter(value => !available.includes(value));
        const selection = [...new Set([...(editor.customCapabilities ? kept : defaultCapabilities(agent, editor.objective)), ...shown])];
        if (editor.customCapabilities && kept.length < previous.length) editor.removedCapabilities = true;
        fieldset.innerHTML = capabilityContent(agent, selection);
      }
      const hint = form.querySelector('[data-service-adapter-hint]'); if (hint && agent) hint.textContent = adapterHint(agent);
      updateObjectiveStatus(form, agent);
    } else if (capabilityChange) {
      const agent = (context().agents || []).find(value => value.id === form.querySelector('[name="agentId"]')?.value);
      updateObjectiveStatus(form, agent);
    }
    updateReview(form);
    return true;
  }
  async function handleAction(node) { return action(node?.dataset?.servicePrincipalAction, node?.dataset?.id); }
  return latestScreen = { load, refresh: load, markup, render: markup, action, handleAction, handleChange, submit, reset,
    get summary() {
      const authorized = current(loadedKey), number = value => Number.isFinite(value) && value >= 0 ? value : 0, scopeIds = value => value === null ? null : (Array.isArray(value) ? value : []).filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id));
      return { loaded: authorized && !loading, loading: Boolean(current(loadingKey) && loading), error: current(errorKey) && error ? i18nT('Não foi possível consultar os serviços.') : '', items: authorized ? items.map(item => ({
        id: String(item.id || ''), name: String(item.name || ''), agentId: String(item.agentId || ''), state: ['active','paused','revoked','expired'].includes(item.state) ? item.state : 'unknown', active: item.active === true,
        capabilities: (Array.isArray(item.capabilities) ? item.capabilities : []).filter(value => Object.hasOwn(labels, value)), channelIds: scopeIds(item.channelIds), departmentIds: scopeIds(item.departmentIds),
        dailyRequests: number(item.dailyRequests), dailyBudgetMicros: number(item.dailyBudgetMicros), budgetEnabled: item.budgetEnabled === true, maxConcurrent: number(item.maxConcurrent), expiresAt: String(item.expiresAt || ''), revision: number(item.revision), keyRevision: number(item.keyRevision), usage: { requests: number(item.usage?.requests), budgetMicros: number(item.usage?.budgetMicros) },
        // Last authenticated call (principal-last-seen): the hub's Último uso; null = no call recorded or unknown.
        lastSeenAt: typeof item.lastSeenAt === 'string' && Number.isFinite(Date.parse(item.lastSeenAt)) ? item.lastSeenAt : null
      })) : [] };
    }
  };
}
