import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';
// Copy added by P1 commit 1g (the way to Agentes › Ferramentas) lives in P1's catalog.
import './locales-shell.js';
// White label of the agent copy (P5): the engine name stays out of customer workspaces.
import './locales-agents-hub.js';
import { INTERNAL_MCP_NAME } from './mcp-catalog.js';

// Servers, tool grants and AI usage of the Agentes screen (P5). The run part (cards, approval
// decisions, the "Acionar copiloto" form and the run actions) moved to agent-rail-ui.js (P4) in
// commit 1f of P1, unchanged. Since commit 1g the panel lives in Agentes › Ferramentas
// (#agents/tools, view 'agent-tools' of nav-config.js) for the workspace admin; Integrações (platform
// owner only) still shows it for the owner, and "Gerenciar ferramentas" always leads to Agentes.
//
// P5: the Central de Agentes (agents-hub-ui.js) reads the usage report cached here (usageSnapshot,
// onUsage) and reaches the api/refresh/render/navigate/formModal of app.js through agentServices():
// app.js creates this module once, before the hub, so the hub needs no new dependency in app.js.
let services = null;
/** Name the internal server is created with (API payload, independent of the locale). */
const INTERNAL_DEFAULT_NAME = INTERNAL_MCP_NAME;
/** The app.js helpers given to the last createMcpUI (null before it runs). */
export const agentServices = () => services;

export function createMcpUI(ctx) {
  const { state, escape: e, icon, badge, api, tenantApi, formModal, refresh, render, toast, navigate } = ctx;
  const admin = () => state.boot?.session?.role === 'reseller';
  const scope = () => `${state.workspaceId}:${state.tenant?.id}`;
  const servers = () => state.mcpServers || [];
  const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString(getLocale()) : '';
  const json = value => e(JSON.stringify(value ?? null, null, 2));
  const action = (label, name, id = '', extra = '', primary = false) => `<button type="button" class="button ${primary ? 'primary' : ''}" data-action="${name}" data-id="${e(id)}" ${extra}>${label}</button>`;
  const catalog = () => servers().flatMap(server => (server.tools || []).map(tool => ({ server, tool })));
  let editor = null;
  let grantEditor = null;
  let limitEditor = null;
  let usage = null;
  const usageListeners = new Set();
  const number = value => Number(value || 0).toLocaleString(getLocale());

  function reset() { editor = null; grantEditor = null; limitEditor = null; usage = null; state.mcpServers = []; state.mcpLoaded = false; }

  function summary() {
    if (!admin()) return { text: i18nText('Aprovação humana'), tone: 'blue', detail: i18nText('O administrador concede ferramentas aos copilotos desta empresa.') };
    const enabled = servers().filter(server => server.enabled).length;
    const tools = servers().filter(server => server.enabled).reduce((count, server) => count + (server.tools || []).length, 0);
    return { text: tools ? i18nText('Ferramentas disponíveis') : enabled ? i18nText('Descoberta pendente') : i18nText('Configurar'), tone: tools ? 'blue' : 'neutral', detail: i18nTemplate`${enabled} ${enabled === 1 ? i18nText('servidor ativo') : i18nText('servidores ativos')} · ${tools} ${tools === 1 ? i18nText('ferramenta descoberta') : i18nText('ferramentas descobertas')}. Consultas internas automáticas por padrão; ferramentas externas com aprovação.` };
  }

  function toolMarkup(tool) {
    return i18nHtml`<details class="mcp-tool"><summary><span><strong>${e(tool.title || tool.name)}</strong><code>${e(tool.name)}</code></span>${icon('chevron')}</summary><p>${e(tool.description || i18nText('Sem descrição informada pelo servidor.'))}</p><div class="mcp-schema"><span>Argumentos da ferramenta</span><pre>${json(tool.inputSchema || {})}</pre></div></details>`;
  }

  // The internal server keeps the name it was created with (INTERNAL_DEFAULT_NAME, the API payload
  // below); that default is shown as "Consultas internas" in the list, the grants and the edit form, so
  // the platform brand stays out of customer workspaces while the stored name stays as it was.
  const serverName = server => server.kind === 'internal' && server.name === INTERNAL_DEFAULT_NAME ? i18nText('Consultas internas') : server.name;

  function serverMarkup(server) {
    const internal = server.kind === 'internal';
    const tools = server.tools || [];
    const status = !server.enabled ? i18nText('Desativado') : server.state === 'failed' ? i18nText('Verificação falhou') : tools.length ? i18nText('Catálogo descoberto') : i18nText('Descoberta pendente');
    return `<article class="mcp-server"><div class="mcp-server-heading"><span class="mcp-server-mark">${icon(internal ? 'building' : 'globe')}</span><div><h3>${e(serverName(server))}</h3><p>${internal ? i18nText('Consultas internas · somente leitura') : i18nText('Servidor externo · aprovação a cada execução')}</p></div>${badge(status, !server.enabled ? 'neutral' : server.state === 'failed' ? 'amber' : tools.length ? 'blue' : 'neutral')}</div><div class="mcp-server-meta">${internal ? i18nMarkup('<span>Contexto autorizado da empresa e da conversa.</span>') : `<code>${e(server.endpoint || '')}</code><span>${server.tokenConfigured ? i18nText('Token cadastrado') : i18nText('Sem token cadastrado')}</span>`}<span>${server.checkedAt ? i18nTemplate`Verificado em ${e(date(server.checkedAt))}` : i18nText('Servidor ainda não verificado.')}</span></div><div class="mcp-server-actions">${action(i18nText('Editar configuração'), 'mcp-edit-server', server.id)}${action(i18nText('Descobrir ferramentas'), 'mcp-discover', server.id, server.enabled ? '' : 'disabled')}${action(server.enabled ? i18nText('Desativar') : i18nText('Reativar'), 'mcp-toggle-server', server.id)}</div><div class="mcp-tool-list">${tools.length ? tools.map(toolMarkup).join('') : i18nMarkup('<p class="mcp-empty-copy">Descubra o catálogo para escolher quais ferramentas cada copiloto pode usar.</p>')}</div></article>`;
  }

  function panel() {
    if (!admin()) return '';
    const internal = servers().find(server => server.id === 'elozi-internal');
    return i18nHtml`<section id="mcp-settings" class="mcp-settings" aria-labelledby="mcp-settings-title"><div class="mcp-settings-heading"><div><span class="eyebrow">FERRAMENTAS DESTA EMPRESA</span><h2 id="mcp-settings-title">Contexto para o copiloto. Controle para a equipe.</h2><p>Ative um servidor, descubra seu catálogo e conceda ferramentas a cada agente. Consultas internas somente leitura rodam automaticamente; ferramentas externas esperam a aprovação do atendente.</p></div><div class="mcp-heading-actions">${!internal ? action(i18nText('Ativar consultas internas'), 'mcp-activate-internal') : ''}${action(i18nText('Adicionar servidor externo'), 'mcp-new-server')}</div></div>${servers().length ? `<div class="mcp-server-list">${servers().map(serverMarkup).join('')}</div>` : '<div class="mcp-empty"><span class="mcp-empty-mark">' + icon('code') + '</span><div><h3>' + e(i18nText('Comece pelas consultas internas.')) + '</h3>' + i18nMarkup('<p>O servidor interno consulta dados autorizados desta empresa. Depois da descoberta, escolha as ferramentas na configuração do agente.</p></div></div>')}<div class="mcp-settings-foot"><span>${icon('shield')} Concessões individuais por agente</span><button type="button" class="text-button" data-view="agents">Gerenciar agentes ${icon('arrow')}</button></div></section>`;
  }

  function openServer(server = null) {
    // The form shows the same label as the list; saving that label unchanged keeps the stored name.
    const shown = server ? serverName(server) : '';
    editor = { scope: scope(), id: server?.id || null, version: server?.version, kind: server?.kind || 'remote', label: server && shown !== server.name ? shown : null };
    const internal = editor.kind === 'internal';
    formModal(server ? i18nText('Configurar servidor MCP') : i18nText('Adicionar servidor MCP'), i18nTemplate`Ferramentas de ${state.tenant.name}. O acesso será concedido separadamente a cada copiloto.`, 'mcp-server', i18nHtml`<label>Nome do servidor<input name="name" maxlength="80" value="${e(shown)}" required/></label>${internal ? `<p class="mcp-form-note">${e(i18nText('Consultas internas · dados autorizados desta empresa, sem credencial externa.'))}</p>` : i18nHtml`<label>Endpoint MCP<input type="url" name="endpoint" value="${e(server?.endpoint || '')}" maxlength="500" placeholder="https://servico.exemplo/mcp" autocomplete="off" required/><small>Use um servidor em uma origem autorizada pela operação.</small></label><label>Token de acesso<input type="password" name="token" maxlength="4096" autocomplete="new-password" spellcheck="false"/><small>${server?.tokenConfigured ? i18nText('Deixe vazio para manter o token cadastrado.') : i18nText('O token será guardado cifrado e não aparece nas consultas.')}</small></label>`}<label class="checkbox-label"><input type="checkbox" name="enabled" ${server?.enabled !== false ? 'checked' : ''}/>Servidor ativo nesta empresa</label>`, i18nText('Salvar servidor'));
  }

  async function openGrants(agentId) {
    const initialScope = scope();
    const agent = state.tenant.agents.find(item => item.id === agentId);
    if (!agent || agent.provider !== 'hermes') throw new Error(i18nText('Escolha um copiloto gerenciado desta empresa.'));
    const [serverData, grantData] = await Promise.all([api(tenantApi('mcp/servers')), api(tenantApi(`agents/${encodeURIComponent(agentId)}/mcp-grants`))]);
    if (scope() !== initialScope || !admin()) return;
    state.mcpServers = serverData.servers || []; state.mcpLoaded = true;
    const entries = catalog();
    const valid = entry => entry.server.enabled && (grantData.grants || []).some(grant => grant.serverId === entry.server.id && grant.toolName === entry.tool.name && grant.toolHash === entry.tool.hash && grant.serverVersion === entry.server.version);
    const outdated = (grantData.grants || []).filter(grant => !entries.some(entry => valid(entry) && entry.server.id === grant.serverId && entry.tool.name === grant.toolName)).length;
    grantEditor = { scope: initialScope, agentId, version: grantData.version, entries };
    const policy = grantData.toolPolicy === 'approve_all' ? 'approve_all' : 'auto_readonly';
    const policyMarkup = i18nHtml`<fieldset class="mcp-grant-group mcp-policy"><legend>Execução das consultas internas</legend><label class="mcp-grant"><input type="radio" name="toolPolicy" value="auto_readonly" ${policy === 'auto_readonly' ? 'checked' : ''}/><span><strong>Consulta automática</strong><small>O copiloto consulta dados internos somente leitura sem pedir aprovação, até 3 vezes por rascunho. Ferramentas externas continuam com aprovação.</small></span></label><label class="mcp-grant"><input type="radio" name="toolPolicy" value="approve_all" ${policy === 'approve_all' ? 'checked' : ''}/><span><strong>Aprovar toda ferramenta</strong><small>O responsável pelo atendimento aprova cada consulta, inclusive as internas.</small></span></label></fieldset>`;
    const groups = servers().map(server => `<fieldset class="mcp-grant-group"><legend>${e(serverName(server))} ${badge(server.kind === 'internal' ? i18nText('Consulta interna') : i18nText('Servidor externo'), server.kind === 'internal' ? 'green' : 'neutral')}</legend>${!server.enabled ? i18nMarkup('<p class="mcp-form-note">Servidor desativado. Reative para conceder ferramentas.</p>') : ''}${entries.map((entry, index) => entry.server.id !== server.id ? '' : `<label class="mcp-grant"><input type="checkbox" name="mcpTool" value="${index}" ${valid(entry) ? 'checked' : ''} ${server.enabled ? '' : 'disabled'}/><span><strong>${e(entry.tool.title || entry.tool.name)}</strong><code>${e(entry.tool.name)}</code><small>${e(entry.tool.description || i18nText('Sem descrição informada.'))}</small></span></label>`).join('') || i18nMarkup('<p class="mcp-form-note">Descubra o catálogo deste servidor antes de conceder acesso.</p>')}</fieldset>`).join('');
    formModal(i18nText('Ferramentas autorizadas'), i18nTemplate`${agent.name} · ${state.tenant.name}. Escolha as ferramentas e como as consultas internas são executadas.`, 'mcp-grants', `${policyMarkup}${outdated ? i18nHtml`<p class="mcp-grants-changed" role="status">${outdated} ${outdated === 1 ? i18nText('concessão precisa') : i18nText('concessões precisam')} de revisão porque o servidor ou seu catálogo mudou. Selecione novamente as ferramentas atuais.</p>` : ''}${groups || `<p class="mcp-form-note">${e(i18nText('Ative um servidor e descubra suas ferramentas em Agentes › Ferramentas.'))}</p>`}`, i18nText('Salvar concessões'));
  }

  function usagePanel() {
    if (!admin() || state.supportGrantId) return '';
    const data = usage?.scope === scope() ? usage.data : null, limit = data?.limit ?? null, used = data?.today?.totalTokens ?? 0;
    let body;
    if (!data) body = `<p role="status">${e(usage?.scope === scope() && usage.error ? usage.error : i18nText('Carregando o consumo de IA…'))}</p>`;
    else {
      const ceiling = Math.max(limit ?? 0, 1);
      const meter = limit === null ? '' : `<meter min="0" max="${ceiling}" value="${Math.min(used, ceiling)}" low="${Math.floor(ceiling * 0.8)}" high="${ceiling}" optimum="0" aria-label="${e(i18nText('Uso diário de IA'))}"></meter>`;
      const agents = data.agents.slice(0, 5).map(agent => `<li><span>${e(agent.agentName || i18nText('Agente removido'))}</span> <strong>${e(number(agent.totalTokens))}</strong></li>`).join('');
      body = `<p><strong>${e(number(used))}</strong> ${e(i18nText('tokens hoje'))} · ${e(limit === null ? i18nText('sem limite diário') : i18nText('limite diário de {limit} tokens', { limit: number(limit) }))}</p>${meter}${data.today.blocked ? `<p class="mcp-grants-changed" role="status">${e(i18nText('Limite diário atingido. Novos rascunhos ficam bloqueados até o próximo dia.'))}</p>` : ''}<p>${e(i18nText('Últimos {days} dias: {tokens} tokens em {runs} execuções.', { days: data.days, tokens: number(data.totals.totalTokens), runs: number(data.totals.runs) }))}</p>${agents ? `<ul class="ai-usage-agents">${agents}</ul>` : ''}`;
    }
    return `<section id="ai-usage" class="mcp-panel ai-usage" aria-labelledby="ai-usage-title"><div class="mcp-symbol">${icon('activity')}</div><div><span class="eyebrow">${e(i18nText('USO DE IA'))}</span><h2 id="ai-usage-title">${e(i18nText('Consumo dos copilotos'))}</h2>${body}</div>${action(i18nText('Definir limite diário'), 'mcp-ai-limit', '', data ? '' : 'disabled')}</section>`;
  }

  /** Loads usage for the agents page and replaces only its section; repeated renders reuse a recent result. */
  async function loadUsage({ force = false } = {}) {
    if (!admin() || state.supportGrantId || !state.tenant) return;
    const expected = scope();
    if (!force && usage?.scope === expected && (usage.loading || Date.now() - usage.loadedAt < 60000)) return;
    const record = usage = { scope: expected, data: usage?.scope === expected ? usage.data : null, error: null, loading: true, loadedAt: 0 };
    try { record.data = await api(tenantApi('agents/usage?days=30')); }
    catch (error) { record.error = error.message; }
    finally { record.loading = false; record.loadedAt = Date.now(); }
    if (usage !== record || scope() !== expected) return;
    const section = document.querySelector('#ai-usage'); if (section) section.outerHTML = usagePanel();
    for (const listener of [...usageListeners]) { try { listener(); } catch { /* a screen that failed to repaint keeps its last markup */ } }
  }

  /** Usage of the open company for other screens: {data, error, loading, loadedAt}, or null when not loaded for it. */
  function usageSnapshot() {
    if (!admin() || state.supportGrantId || usage?.scope !== scope()) return null;
    return { data: usage.data, error: usage.error, loading: usage.loading, loadedAt: usage.loadedAt };
  }
  /** Called after each usage load of this company; returns the function that stops listening. */
  function onUsage(listener) { if (typeof listener !== 'function') return () => {}; usageListeners.add(listener); return () => usageListeners.delete(listener); }

  /** The agents page renders a placeholder; this fills it for administrators (and removes it otherwise), then loads usage. */
  function mountUsage() {
    const slot = document.querySelector('#ai-usage');
    if (slot) slot.outerHTML = usagePanel();
    return loadUsage().catch(() => {});
  }

  function openLimit() {
    const data = usage?.scope === scope() ? usage.data : null;
    if (!data) throw new Error(i18nText('Aguarde o consumo de IA carregar antes de definir o limite.'));
    limitEditor = { scope: scope(), version: data.limitVersion };
    formModal(i18nText('Limite diário de IA'), i18nText('Vale para todos os copilotos desta empresa. Ao atingir o limite, novos rascunhos ficam bloqueados até o próximo dia.'), 'mcp-ai-limit', `<label>${e(i18nText('Tokens por dia'))}<input type="number" name="limit" min="0" max="10000000000" step="1" inputmode="numeric" value="${data.limit ?? ''}"/><small>${e(i18nText('Deixe vazio para não limitar. Use 0 para pausar novos rascunhos nesta empresa.'))}</small></label>`, i18nText('Salvar limite'));
  }

  async function act(name, id) {
    if (!name.startsWith('mcp-')) return false;
    if (!admin()) throw new Error(i18nText('A configuração de ferramentas pertence ao administrador do workspace.'));
    if (name === 'mcp-ai-limit') { openLimit(); return true; }
    // Agentes › Ferramentas, which every workspace admin opens (Integrações is the platform owner's).
    if (name === 'mcp-settings') { navigate('agent-tools'); return true; }
    if (name === 'mcp-new-server') { openServer(); return true; }
    if (name === 'mcp-grants') { await openGrants(id); return true; }
    const expectedScope = scope();
    if (name === 'mcp-activate-internal') {
      await api(tenantApi('mcp/servers'), { method: 'POST', body: JSON.stringify({ name: INTERNAL_DEFAULT_NAME, kind: 'internal', enabled: true }) });
    } else {
      const server = servers().find(item => item.id === id);
      if (!server) throw new Error(i18nText('Atualize o catálogo para encontrar este servidor.'));
      if (name === 'mcp-edit-server') { openServer(server); return true; }
      if (name === 'mcp-discover') await api(tenantApi(`mcp/servers/${encodeURIComponent(id)}/discover`), { method: 'POST', body: JSON.stringify({ version: server.version }) });
      else if (name === 'mcp-toggle-server') await api(tenantApi(`mcp/servers/${encodeURIComponent(id)}`), { method: 'PATCH', body: JSON.stringify({ version: server.version, enabled: !server.enabled }) });
      else return false;
    }
    if (scope() === expectedScope) { await refresh(); render(); toast(name === 'mcp-discover' ? i18nText('Catálogo descoberto. Revise as concessões dos agentes.') : i18nText('Servidor MCP atualizado.')); }
    return true;
  }

  async function submit(form) {
    const type = form.dataset.dialogForm;
    if (!['mcp-server', 'mcp-grants', 'mcp-ai-limit'].includes(type)) return false;
    const values = new FormData(form), expectedScope = scope();
    if (!admin()) throw new Error(i18nText('A configuração de ferramentas pertence ao administrador do workspace.'));
    if (type === 'mcp-ai-limit') {
      const target = limitEditor, raw = String(values.get('limit') ?? '').trim();
      if (!target || target.scope !== expectedScope) throw new Error(i18nText('A empresa mudou. Abra o limite novamente.'));
      if (raw && !/^\d{1,11}$/.test(raw)) throw new Error(i18nText('Informe um número inteiro de tokens ou deixe vazio.'));
      await api(tenantApi('agents/usage/limit'), { method: 'PUT', body: JSON.stringify({ version: target.version, limit: raw ? Number(raw) : null }) });
      usage = null; limitEditor = null;
    } else if (type === 'mcp-server') {
      const target = editor;
      if (!target || target.scope !== expectedScope) throw new Error(i18nText('A empresa mudou. Abra a configuração novamente.'));
      const typed = String(values.get('name') || '').trim();
      const payload = { name: target.label !== null && typed === target.label ? INTERNAL_DEFAULT_NAME : typed, enabled: values.has('enabled'), ...(target.id ? { version: target.version } : { kind: target.kind }) };
      if (target.kind === 'remote') { payload.endpoint = String(values.get('endpoint') || '').trim(); if (values.get('token')) payload.token = String(values.get('token')); }
      await api(tenantApi(target.id ? `mcp/servers/${encodeURIComponent(target.id)}` : 'mcp/servers'), { method: target.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      form.reset();
    } else {
      const target = grantEditor;
      if (!target || target.scope !== expectedScope) throw new Error(i18nText('A empresa mudou. Abra as concessões novamente.'));
      const grants = values.getAll('mcpTool').map(index => target.entries[Number(index)]).filter(entry => entry?.server.enabled).map(({ server, tool }) => ({ serverId: server.id, toolName: tool.name, toolHash: tool.hash, serverVersion: server.version }));
      const toolPolicy = String(values.get('toolPolicy') || '');
      await api(tenantApi(`agents/${encodeURIComponent(target.agentId)}/mcp-grants`), { method: 'PUT', body: JSON.stringify({ version: target.version, grants, ...(['auto_readonly', 'approve_all'].includes(toolPolicy) ? { toolPolicy } : {}) }) });
    }
    if (scope() === expectedScope) { document.querySelector('#modal').close(); await refresh(); render(); toast(type === 'mcp-grants' ? i18nText('Ferramentas autorizadas atualizadas.') : type === 'mcp-ai-limit' ? i18nText('Limite diário de IA atualizado.') : i18nText('Servidor MCP salvo. Descubra o catálogo para conceder ferramentas.')); }
    return true;
  }

  const instance = { reset, summary, panel, act, submit, usagePanel, loadUsage, mountUsage, usageSnapshot, onUsage };
  services = { state, api, tenantApi, formModal, refresh, render, toast, navigate, mcp: instance };
  return instance;
}
