import { h, raw, t } from './i18n.js';
// The Ferramentas tab keeps P1's copy (commit 1g) in P1's catalog; everything else is in P5's own.
import './locales-shell.js';
import './locales-agents-hub.js';
import { button, badge, avatar, emptyState, toasts, attributes, progress, banner } from './ui.js';
import { formatHash, parseHash } from './router.js';
import { agentServices } from './mcp-ui.js';
import { servicePrincipalsScreen } from './service-principals-ui.js';
import { knowledgeScreen } from './knowledge-ui.js';
import { createAgentDetail, agentKind, kindLabel, healthOf, policyOf, policyLabel, autopilotOf, relativeTime, activityRuns, activityTable } from './agent-detail-ui.js';
import { createAgentUsage, formatNumber, formatCompact, quotaText } from './agent-usage-ui.js';

// Central de Agentes (FRONTEND-V2 §5.3.1, §5.3.2, §8.6). Owned by P5. app.js draws it through
// views.agents → view(route) inside the hub tabs of nav-config.js and calls mount(main, route) after
// each render; 'agents:*' actions and data-form="agents:…" forms reach act/submit through the
// registry of actions.js. Contract (§8.2): createAgentsHub(deps) → {view(route), act, submit, reset, mount}.
//
// Routes: #agents (list) · #agents/activity · #agents/usage · #agents/tools (MCP panel, commit 1g of
// P1, view 'agent-tools') · #agents/<agentId>[/<tab>] (agent-detail-ui.js). #agents/knowledge is the
// knowledge base of knowledge-ui.js and #knowledge its alias (nav-config.js). Until nav-config lists
// the Atividade and Uso tabs, the hub adds them to the strip (an observer of #app started when the hub
// is created) so their deep links stay in place on every tab of the hub.
//
// The list (§5.3.1): Agente · Tipo · Saúde · Política · Hoje · Último uso, the quota of the day,
// proposals of connected agents (admin) and the support assistant of the platform owner. The engine
// name appears only for the platform owner ("Copiloto gerenciado" / "Agente conectado (MCP)" for
// everyone else); providers that do not run yet are "em breve", never offered as working.
//
// deps (app.js): state, escape, pageHeading, renderAgentAdminProposals, renderSupportAssistant and
// mcpPanel (mcpUI.panel). The api, refresh, render and navigate of app.js arrive through mcp-ui.js
// (agentServices) unless injected (tests): request, refresh, render, navigate, principals, usageSource.

const INITIATORS = Object.freeze(['service', 'support', 'autopilot']);

export function createAgentsHub(deps = {}) {
  const { state = {}, pageHeading = (eyebrow, title, description) => `<h1>${title}</h1><p>${description}</p>`, renderAgentAdminProposals = () => '', renderSupportAssistant = () => '', mcpPanel = () => '' } = deps;
  const escape = typeof deps.escape === 'function' ? deps.escape : value => String(value ?? '');
  const services = () => agentServices() || {};
  const request = (path, options) => { const api = deps.request || services().api; if (typeof api !== 'function') throw new Error(t('O painel ainda está carregando. Tente novamente em instantes.')); return api(path, options); };
  const tenantPath = tail => `/api/tenants/${encodeURIComponent(state.tenant?.id || '')}${tail ? '/' + tail : ''}`;
  const render = () => (deps.render || services().render)?.();
  const refresh = () => (deps.refresh || services().refresh)?.();
  const navigate = view => (deps.navigate || services().navigate)?.(view);
  const principals = () => typeof deps.principals === 'function' ? deps.principals() : servicePrincipalsScreen();

  /** Who is looking: administrators edit; the platform owner also sees the engine; features of the server. */
  function context() {
    const session = state.boot?.session || {};
    return Object.freeze({
      admin: session.role === 'reseller' && !state.supportGrantId,
      owner: session.platformOwner === true && !state.supportGrantId,
      features: new Set(Array.isArray(state.boot?.features) ? state.boot.features.filter(item => typeof item === 'string') : []),
      scope: JSON.stringify([state.workspaceId || null, state.tenant?.id || null, session.userId || null, state.supportGrantId || null])
    });
  }

  // Usage comes from the report mcp-ui.js caches per company (the request app.js already makes on
  // this page); only administrators may read it (the route is admin-only).
  const usageSource = deps.usageSource || {
    snapshot() {
      const mcp = services().mcp;
      if (!context().admin || !state.tenant || typeof mcp?.usageSnapshot !== 'function') return null;
      return mcp.usageSnapshot() || { data: null, error: null, loading: true };
    },
    load(options) { return context().admin ? services().mcp?.loadUsage?.(options) : undefined; },
    canEdit() { return context().admin; }
  };
  const usage = createAgentUsage({ source: usageSource });
  let current = null, runsFeed = null, unsubscribe = null;
  const detail = createAgentDetail({ state, context, request, tenantPath, render, refresh, navigate, usage, principals,
    runsFeed: () => runsStatus(context()), loadRuns: () => loadRuns(context()),
    grants: { tools: id => services().mcp?.act?.('mcp-grants', id), knowledge: id => knowledgeScreen()?.act?.('knowledge-grants', id) } });

  const agentHash = (agentId, agentTab) => { try { return formatHash({ section: 'agents', params: { agentId, ...(agentTab ? { agentTab } : {}) } }); } catch { return null; } };

  // ---- list ---------------------------------------------------------------------------------

  function heading(ctx) {
    const actions = ctx.admin ? h`<div class="pg-agents__actions"><a class="ui-btn ui-btn--secondary ui-btn--md" href="#agents/connect"><span class="ui-btn__label">${t('Conectar meu agente')}</span></a>${button({ label: t('Novo copiloto'), action: 'agents:new', variant: 'secondary', icon: 'plus' })}</div>` : '';
    return h`<header class="pg-agents__head"><div><h1 class="pg-agents__h1">${t('Agentes')}</h1><p class="pg-agents__scope">${state.tenant?.name || t('Empresa atual')}</p><p class="pg-agents__muted">${t('Seu agente externo ou um copiloto gerenciado: abra o perfil para conferir responsabilidades e acesso.')}</p></div>${actions}</header>${createDialog(ctx)}`;
  }

  function connectedSummary(agent) {
    const summary = principals()?.summary;
    if (!summary?.loaded) return null;
    return summary.items.filter(item => item.agentId === agent.id);
  }

  function policyCell(agent) {
    const kind = agentKind(agent);
    if (kind === 'managed') return policyLabel(policyOf(agent));
    if (kind !== 'connected') return t('Integração ainda indisponível');
    const items = connectedSummary(agent);
    if (!items) return t('Permissões não carregadas');
    const capabilities = new Set(items.filter(item => item.state === 'active').flatMap(item => item.capabilities));
    if (!capabilities.size) return t('Sem identidade ativa');
    if (capabilities.has('reply.send') && capabilities.has('message.schedule')) return t('Respostas atribuídas, envio e agenda em grupos');
    if (capabilities.has('reply.send')) return t('Respostas atribuídas e envio em grupos');
    if (capabilities.has('message.schedule')) return t('Agendamento em grupos');
    if (capabilities.has('reply.submit') || capabilities.has('reply.draft')) return t('Rascunho para revisão');
    return t('Somente leitura');
  }

  function todayCell(agent) {
    const kind = agentKind(agent);
    if (kind === 'managed') { const today = usage.agentToday(agent.id); return today ? t('{runs} execuções · {tokens} tokens', { runs: formatNumber(today.runs), tokens: formatCompact(today.total) }) : t('Uso não informado'); }
    if (kind === 'connected') {
      const items = connectedSummary(agent);
      if (!items || items.some(item => !Number.isFinite(item.usage?.requests) || item.usage.requests < 0)) return t('Uso não informado');
      return t('{count} chamadas', { count: formatNumber(items.reduce((sum, item) => sum + item.usage.requests, 0)) });
    }
    return t('Integração ainda indisponível');
  }

  /**
   * Último uso from what was loaded: the newest run (tenant.runs keeps only the latest ones, plus the
   * agent-runs feed when it is loaded) or, for connected agents, the identities' lastSeenAt. "nunca"
   * only when the server says so (principal-last-seen with no call); otherwise "—" with the reason.
   */
  function lastUse(agent, ctx) {
    const feed = feedItems(ctx) || [];
    const last = activityRuns([...(Array.isArray(state.tenant?.runs) ? state.tenant.runs : []), ...feed], agent.id)[0];
    const items = agentKind(agent) === 'connected' ? connectedSummary(agent) : null;
    const when = [last?.startedAt || last?.createdAt, ...(items || []).map(item => item.lastSeenAt)].filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    if (when) return relativeTime(when);
    if (items && ctx.features.has('principal-last-seen')) return t('nunca');
    return h`<span title="${t('Nenhum uso entre as execuções carregadas')}">${t('Sem uso nos dados carregados')}</span>`;
  }

  function table(ctx) {
    const agents = Array.isArray(state.tenant?.agents) ? state.tenant.agents : [];
    if (!agents.length) return empty(ctx);
    const rows = agents.map(agent => {
      const health = healthOf(agent), autopilot = autopilotOf(agent), href = agentHash(agent.id), kind = agentKind(agent);
      const name = agent.name || t('Agente sem nome');
      const role = kind === 'connected' ? t('Modelo, instruções e memória no seu cliente externo.') : kind === 'managed' ? (autopilot?.enabled ? t('Piloto automático · {count} canal(is) autorizado(s)', { count: autopilot.channelIds.length }) : t('Sob demanda · revisão humana antes do envio.')) : t('Integração ainda indisponível');
      const cell = (label, content, className = '') => h`<td role="cell" class="${className}"><span class="pg-agents__cell-label" aria-hidden="true">${t(label)}</span><span class="pg-agents__cell-value">${content}</span></td>`;
      return h`<tr role="row"><th scope="row" role="rowheader"><div class="pg-agents__agent">${avatar({ kind: 'agent', name, size: 32 })}<div>${href ? h`<a class="pg-agents__link pg-agents__agent-name" href="${href}">${name}</a>` : h`<span class="pg-agents__agent-name">${name}</span>`}<p class="pg-agents__muted pg-agents__responsibility">${role}</p></div></div></th>${cell('Tipo', kind === 'connected' ? t('Agente pessoal · externo (MCP)') : kindLabel(agent, ctx))}${cell('Saúde', health ? h`<span title="${health.reason}">${badge(health.label, health.tone)}</span>` : t('Saúde não informada'))}${cell('Ferramentas / permissões', policyCell(agent))}${ctx.admin ? cell('Hoje', todayCell(agent), 'pg-agents__num') : ''}${cell('Último uso', lastUse(agent, ctx), 'pg-agents__muted')}</tr>`;
    });
    return h`<section class="pg-agents__card pg-agents__card--flush" data-agents-slot="agents-table"><div class="pg-agents__register-head"><h2 class="pg-agents__h2">${t('Agentes desta empresa')}</h2><p class="pg-agents__muted">${t('Permissões indicam acesso, não autonomia. O cliente externo decide quando executar dentro dos limites autorizados.')}</p></div><div class="pg-agents__table-wrap"><table role="table" class="pg-agents__table pg-agents__table--agents"><caption class="sr-only">${t('Agentes desta empresa')}</caption><thead role="rowgroup"><tr role="row"><th scope="col">${t('Agente')}</th><th scope="col">${t('Tipo')}</th><th scope="col">${t('Saúde')}</th><th scope="col">${t('Ferramentas / permissões')}</th>${ctx.admin ? h`<th scope="col">${t('Hoje')}</th>` : ''}<th scope="col">${t('Último uso')}</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div></section>`;
  }

  function empty(ctx) {
    if (!ctx.admin) return h`<div data-agents-slot="agents-table">${emptyState({ icon: 'spark', title: t('Nenhum agente nesta empresa'), body: t('A administração do workspace adiciona copilotos e agentes conectados.') })}</div>`;
    return h`<div class="pg-agents__paths" data-agents-slot="agents-table"><section class="pg-agents__card pg-agents__path"><h2 class="pg-agents__h2">${t('Usar o assistente gerenciado')}</h2><p class="pg-agents__muted">${t('Pronto em 1 minuto: escreva as instruções, autorize as fontes e a equipe revisa cada rascunho.')}</p>${button({ label: t('Criar copiloto'), action: 'agents:new', variant: 'secondary', icon: 'plus' })}</section><section class="pg-agents__card pg-agents__path"><h2 class="pg-agents__h2">${t('Conectar meu agente')}</h2><p class="pg-agents__muted">${ctx.owner ? t('Hermes, Claude Code, Codex ou outro cliente MCP que você já usa, com chave e limites próprios.') : t('Claude Code, Codex ou outro cliente MCP que você já usa, com chave e limites próprios.')}</p><a class="ui-btn ui-btn--secondary ui-btn--md" href="#agents/connect"><span class="ui-btn__label">${t('Conectar')}</span></a></section></div>`;
  }

  function createDialog(ctx) {
    if (!ctx.admin) return '';
    const company = state.tenant?.name || '';
    const soon = [['claude', 'Claude'], ['codex', 'Codex'], ['webhook', 'API / webhook']];
    return h`<dialog class="pg-agents__dialog" id="agents-new-dialog" aria-labelledby="agents-new-title"><form class="pg-agents__form" data-form="agents:create"><h2 class="pg-agents__h2" id="agents-new-title">${t('Novo copiloto')}</h2><p class="pg-agents__muted">${t('O copiloto prepara rascunhos com as fontes e ferramentas que você autorizar. A equipe revisa antes de enviar.')}</p><label class="pg-agents__field"><span class="pg-agents__label">${t('Nome do copiloto')}</span><input class="pg-agents__control" name="name" maxlength="48" required${attributes({ value: t('Assistente {company}', { company }).slice(0, 48) })}/></label><label class="pg-agents__field"><span class="pg-agents__label">${t('Função do copiloto')}</span><input class="pg-agents__control" name="description" maxlength="200" required placeholder="${t('Ex.: vendas e dúvidas de pedido')}"/></label><fieldset class="pg-agents__fieldset"><legend class="pg-agents__label">${t('Tipo')}</legend><label class="pg-agents__check"><input type="radio" name="provider" value="hermes" checked/><span><strong>${t('Copiloto gerenciado')}</strong> <span class="pg-agents__muted">${t('pronto em 1 minuto')}</span></span></label>${soon.map(([value, label]) => h`<label class="pg-agents__check" data-state="soon"><input type="radio" name="provider"${attributes({ value, disabled: true })}/><span>${label} ${badge(t('Em breve'), 'neutral')}</span></label>`)}<p class="pg-agents__muted">${t('Já usa um agente próprio?')} <a class="pg-agents__link" href="#agents/connect">${t('Conecte pelo assistente de conexão')}</a></p></fieldset><div class="pg-agents__actions pg-agents__actions--end">${button({ label: t('Cancelar'), action: 'agents:close-dialog', variant: 'ghost' })}${button({ label: t('Criar copiloto'), type: 'submit', variant: 'primary' })}</div></form></dialog>`;
  }

  function quotaSlot(ctx) {
    if (!ctx.admin) return '';
    const data = usage.model();
    const level = data?.today.blocked ? 'blocked' : data?.pct >= 80 ? 'near' : 'ok';
    return h`<section class="pg-agents__usage-summary" data-agents-slot="quota" data-state="${level}"><div class="pg-agents__section-head"><h2 class="pg-agents__h3">${t('Uso e cota de hoje')}</h2><div class="pg-agents__actions"><a class="pg-agents__link" href="#agents/usage">${t('Ver uso')}</a>${data && data.limitVersion !== null ? button({ label: t('Ajustar cota'), action: 'agents:usage-limit', size: 'sm', variant: 'ghost' }) : ''}</div></div>${data ? h`<p class="pg-agents__quota-text">${quotaText(data)} · ${t('{runs} execuções hoje', { runs: formatNumber(data.today.runs) })}</p>${data.limit !== null ? progress({ value: Math.min(data.today.total, Math.max(data.limit, 1)), max: Math.max(data.limit, 1), label: t('Cota diária de IA'), valueText: quotaText(data) }) : ''}${level === 'near' ? badge(t('Cota de IA perto do limite'), 'warning') : ''}` : usage.pendingNote()}${level === 'blocked' ? banner({ tone: 'danger', title: t('Limite diário atingido.'), body: t('Novos rascunhos ficam bloqueados até o próximo dia.') }) : ''}</section>`;
  }

  function list(ctx) {
    const proposals = ctx.admin ? String(renderAgentAdminProposals(state) || '') : '';
    const support = state.boot?.session?.platformOwner === true && !state.supportGrantId ? String(renderSupportAssistant(state, escape) || '') : '';
    return h`<div class="pg-agents pg-agents--list">${heading(ctx)}${table(ctx)}${!ctx.admin ? h`<p class="pg-agents__muted">${t('Somente a administração do workspace altera os agentes.')}</p>` : ''}${quotaSlot(ctx)}${raw(proposals)}${raw(support)}</div>`;
  }

  // ---- hub tabs Atividade and Uso -----------------------------------------------------------

  /**
   * The agent-runs feed (P9) for this scope: {items, error, note}. items null = the runs of
   * tenant.runs (the latest ones only), with a note that says which source the table shows.
   */
  function runsStatus(ctx) {
    const supported = ctx.features.has('agent-runs') && ctx.admin, feed = supported && runsFeed?.scope === ctx.scope ? runsFeed : null;
    if (feed?.items) return { items: feed.items, error: feed.error, note: t('Últimas execuções desta empresa.') };
    if (feed?.error) return { items: null, error: feed.error, note: t('Execuções carregadas nesta empresa.') };
    if (supported) return { items: null, error: null, note: t('Carregando o histórico de execuções…') };
    return { items: null, error: null, note: ctx.features.has('agent-runs') ? t('Execuções carregadas nesta empresa.') : t('Execuções carregadas nesta empresa; o histórico completo chega em breve.') };
  }
  const feedItems = ctx => runsStatus(ctx).items;

  function activityTab(ctx) {
    const status = runsStatus(ctx), runs = status.items || activityRuns(state.tenant?.runs);
    return h`<div class="pg-agents pg-agents--activity">${heading(ctx)}<section class="pg-agents__card" data-agents-slot="activity"><div class="pg-agents__section-head"><h2 class="pg-agents__h2">${t('Atividade')}</h2><span class="pg-agents__muted">${status.note}</span></div>${status.error ? h`<p class="pg-agents__error">${status.error}</p>` : ''}${activityTable(runs, { admin: ctx.admin, tenant: state.tenant, showAgent: true })}</section></div>`;
  }

  function usageTab(ctx) {
    if (!ctx.admin) return h`<div class="pg-agents pg-agents--usage">${heading(ctx)}<section class="pg-agents__card"><p class="pg-agents__muted">${t('O consumo de tokens é visível para a administração do workspace.')}</p></section></div>`;
    return h`<div class="pg-agents pg-agents--usage">${heading(ctx)}${usage.view()}</div>`;
  }

  /** GET …/agents/runs (P9, feature 'agent-runs') mapped to the run fields activityTable reads. */
  async function loadRuns(ctx) {
    if (!ctx.features.has('agent-runs') || !ctx.admin || runsFeed?.scope === ctx.scope && (runsFeed.loading || Date.now() - runsFeed.loadedAt < 30000)) return;
    const record = runsFeed = { scope: ctx.scope, items: runsFeed?.scope === ctx.scope ? runsFeed.items : null, error: null, loading: true, loadedAt: 0 };
    try {
      const data = await request(tenantPath('agents/runs?limit=50'));
      // runHistoryItem of src/agent-runtime.js: the initiator kind 'autopilot' stays itself (never a person).
      record.items = (Array.isArray(data?.items) ? data.items : []).filter(item => item && typeof item === 'object').map(item => ({ id: item.id, agentId: item.agentId, agentName: item.agentName, conversationId: item.conversationId, state: item.state,
        stale: item.stale === true, outcome: typeof item.outcome === 'string' ? item.outcome : null, reason: typeof item.reason === 'string' ? item.reason : null, toolSteps: item.toolSteps,
        initiatorKind: INITIATORS.includes(item.initiator?.kind) ? item.initiator.kind : 'user', actorName: item.initiator?.name || '', startedAt: item.createdAt, completedAt: item.completedAt || null,
        latencyMs: Number.isFinite(item.latencyMs) && item.latencyMs >= 0 ? item.latencyMs : null,
        usage: item.tokens ? { total_tokens: (Number(item.tokens.input) || 0) + (Number(item.tokens.output) || 0) } : undefined }));
    } catch (error) { record.error = error?.message || t('Não foi possível carregar a atividade.'); }
    finally { record.loading = false; record.loadedAt = Date.now(); }
    if (runsFeed !== record) return;
    const params = current?.params || {};
    if (params.agentId) detail.repaintRuns(params.agentId);
    else if (params.tab === 'activity') replaceSlot('activity', activityTab(context()));
    else if (!params.tab) replaceSlot('agents-table', table(context()));
  }

  // ---- Ferramentas (commit 1g of P1, unchanged) -----------------------------------------------

  /**
   * Ferramentas (#agents/tools): page heading and the MCP panel of the company (mcp-ui.js markup).
   * nav-config.js opens this route only for the workspace admin and the panel checks the role again;
   * anyone else who reaches this markup reads who owns the setup, never an empty page.
   */
  function tools() {
    const panel = String(mcpPanel() || '');
    const head = pageHeading(t('FERRAMENTAS DOS AGENTES'), t('Ferramentas para os copilotos desta empresa.'), t('Servidores MCP, catálogo e concessões valem só para esta empresa. Só a administração do workspace altera esta configuração.'));
    return String(h`${raw(head)}${panel ? raw(panel) : h`<section class="panel empty">${t('A configuração de ferramentas pertence ao administrador do workspace.')}</section>`}`);
  }

  // ---- screen contract ------------------------------------------------------------------------

  /** The page for #agents[/<tab>|/<agentId>[/<tab>]]. */
  function view(route) {
    current = route || null;
    const params = route?.params || {}, ctx = context();
    if (params.agentId) return detail.view(route);
    if (params.tab === 'tools') return tools();
    if (params.tab === 'activity') return String(activityTab(ctx));
    if (params.tab === 'usage') return String(usageTab(ctx));
    return String(list(ctx));
  }

  function replaceSlot(slot, markup) {
    const doc = globalThis.document, target = doc?.querySelector?.(`[data-agents-slot="${slot}"]`);
    if (!target) return;
    const template = doc.createElement('template');
    template.innerHTML = String(markup);
    const fresh = template.content.querySelector(`[data-agents-slot="${slot}"]`);
    if (fresh) target.replaceWith(fresh);
  }

  /** Usage or identities arrived: only the parts that show them are redrawn (focus and scroll stay). */
  function repaint() {
    const ctx = context(), params = current?.params || {};
    if (params.agentId) {
      const tab = params.agentTab || 'overview';
      if (tab === 'usage') replaceSlot('agent-usage', usage.agentPanel(params.agentId));
      if (tab === 'overview') replaceSlot('overview-usage', detail.overviewUsage(params.agentId));
      return;
    }
    if (params.tab === 'usage') { replaceSlot('usage', usage.view()); return; }
    if (!params.tab) { replaceSlot('quota', quotaSlot(ctx)); replaceSlot('agents-table', table(ctx)); }
  }

  /**
   * Hub strip: until nav-config.js lists Atividade and Uso, add them (before "Agentes conectados")
   * and mark the open one, so #agents/activity and #agents/usage keep their place in the tabs.
   */
  function syncHubTabs(route) {
    const doc = globalThis.document, strip = doc?.querySelector?.('.ui-hub[data-hub="agents"] > .ui-tabs');
    if (!strip) return;
    const panel = strip.parentElement?.querySelector?.(':scope > .ui-tabpanel');
    for (const [id, label] of [['activity', t('Atividade')], ['usage', t('Uso')]]) {
      if (strip.querySelector(`[data-tab="${id}"]`)) continue;
      const tab = doc.createElement('a');
      Object.assign(tab, { className: 'ui-tabs__tab', id: `hub-agents-tab-${id}`, href: `#agents/${id}`, textContent: label });
      tab.setAttribute('role', 'tab'); tab.setAttribute('data-tab', id); tab.setAttribute('aria-selected', 'false'); tab.setAttribute('tabindex', '-1');
      if (panel?.id) tab.setAttribute('aria-controls', panel.id);
      strip.insertBefore(tab, strip.querySelector('[data-tab="connect"]'));
    }
    const open = route?.section === 'agents' && !route?.params?.agentId ? route?.params?.tab : null;
    if (!['activity', 'usage'].includes(open)) return;
    for (const tab of strip.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.tab === open;
      tab.setAttribute('aria-selected', String(selected)); tab.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    if (panel) panel.setAttribute('aria-labelledby', `hub-agents-tab-${open}`);
  }

  // Every render of the panel replaces the children of #app: one observer (childList only, no
  // subtree) keeps the Atividade and Uso tabs on every tab of the agents hub, including the ones this
  // module does not draw (Conhecimento, Agentes conectados). It starts with the hub (app.js creates it
  // at load), so entering straight by #agents/knowledge, #knowledge or #agents/connect shows them too.
  let observer = null;
  function watchHubTabs() {
    const doc = globalThis.document, app = doc?.getElementById?.('app');
    if (observer || !app || typeof globalThis.MutationObserver !== 'function') return;
    observer = new globalThis.MutationObserver(() => syncHubTabs(parseHash(globalThis.location?.hash || '')));
    observer.observe(app, { childList: true });
  }

  /** After each render of an agents view: hub tabs, the detail's listeners and the data the page waits for. */
  function mount(main, route) {
    current = route || null;
    watchHubTabs();
    syncHubTabs(route);
    const ctx = context(), params = route?.params || {};
    if (params.agentId) detail.mount(main, route);
    if (!ctx.admin || params.tab === 'tools') return;
    const mcp = services().mcp;
    if (mcp && typeof mcp.onUsage === 'function' && unsubscribe?.mcp !== mcp) { unsubscribe?.(); unsubscribe = Object.assign(mcp.onUsage(repaint), { mcp }); }
    Promise.resolve(usageSource.load?.()).catch(() => {});
    const needsPrincipals = !params.agentId && !params.tab && (state.tenant?.agents || []).some(agent => agentKind(agent) === 'connected');
    const screen = principals();
    if (needsPrincipals && screen && !screen.summary?.loaded && !screen.summary?.loading) Promise.resolve(screen.load?.()).then(repaint).catch(() => {});
    // Runs history (agent-runs): the hub's Atividade, the list's Último uso and the detail's runs.
    if (params.agentId ? ['overview', 'activity'].includes(params.agentTab || 'overview') : !params.tab || params.tab === 'activity') void loadRuns(ctx);
  }

  async function create(form) {
    const ctx = context();
    if (!ctx.admin) throw new Error(t('Somente a administração do workspace adiciona agentes.'));
    const data = new FormData(form), name = String(data.get('name') || '').trim(), description = String(data.get('description') || '').trim();
    if (!name || name.length > 48) throw new Error(t('Use um nome de agente com 1 a 48 caracteres.'));
    // The server takes 1 to 200 characters (src/store.js text()): an empty role never reaches it.
    if (!description || description.length > 200) throw new Error(t('Descreva a função do copiloto com 1 a 200 caracteres.'));
    if (String(data.get('provider') || 'hermes') !== 'hermes') throw new Error(t('Este provedor ainda não executa nesta versão.'));
    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton?.getAttribute('aria-busy') === 'true') return;
    submitButton?.setAttribute('aria-busy', 'true');
    try {
      const agent = await request(tenantPath('agents'), { method: 'POST', body: JSON.stringify({ name, description, provider: 'hermes', mode: 'copilot' }) });
      form.closest('dialog')?.close?.();
      await refresh();
      toasts.show({ message: t('Copiloto criado. Escreva as instruções e configure o serviço para começar.'), tone: 'success' });
      const target = agent?.id ? agentHash(agent.id, 'instructions') : null;
      if (target) globalThis.location.hash = target; else render();
    } finally { submitButton?.removeAttribute('aria-busy'); }
  }

  /** 'agents:*' actions; true when handled. Errors reach the caller (app.js turns them into toasts). */
  async function act(name, id, element, event) {
    if (typeof name !== 'string' || !name.startsWith('agents:')) return false;
    switch (name) {
      case 'agents:new': {
        if (!context().admin) throw new Error(t('Somente a administração do workspace adiciona agentes.'));
        const dialog = globalThis.document?.getElementById?.('agents-new-dialog');
        if (dialog && !dialog.open) { dialog.showModal(); dialog.querySelector('input[name="name"]')?.focus(); }
        return true;
      }
      case 'agents:close-dialog': element?.closest?.('dialog')?.close?.(); return true;
      case 'agents:usage-limit': {
        if (!context().admin) throw new Error(t('Somente a administração do workspace ajusta a cota.'));
        const mcp = services().mcp;
        if (typeof mcp?.act !== 'function') throw new Error(t('O painel ainda está carregando. Tente novamente em instantes.'));
        await mcp.act('mcp-ai-limit');
        return true;
      }
      default: return detail.act(name, id, element, event);
    }
  }

  /** data-form="agents:…" forms; true for every one of them (errors become toasts, nothing is posted). */
  async function submit(form, event) {
    const name = form?.dataset?.form;
    if (typeof name !== 'string' || !name.startsWith('agents:')) return false;
    if (name === 'agents:create') {
      try { await create(form); } catch (error) { toasts.show({ message: error?.message || t('Não foi possível concluir a solicitação. Tente novamente.'), tone: 'error' }); }
      return true;
    }
    return (await detail.submit(form, event)) || false;
  }

  function reset() { current = null; runsFeed = null; detail.reset(); }

  watchHubTabs();
  return { view, act, submit, reset, mount };
}
