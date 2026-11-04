import {t as i18nText, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';
import './locales-support-central.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const states = i18nLabels({ pending: 'Na fila', running: 'Preparando', sending: 'Envio em andamento', draft: 'Para revisão', completed: 'Resposta registrada', handoff: 'Precisa da equipe', skipped: 'Preparação cancelada', failed: 'Preparação interrompida', unknown: 'Envio sem confirmação' });
const reasons = i18nLabels({ visitor_requested_human: 'O visitante pediu uma pessoa.', agent_requested_human: 'O assistente pediu uma pessoa.', human_in_charge: 'A equipe assumiu o atendimento.', media_needs_human: 'A mídia precisa da equipe.', knowledge_unavailable: 'Sem conhecimento publicado suficiente.', draft_needs_human: 'O rascunho precisa de revisão humana.', invalid_draft: 'O rascunho não pôde ser usado.', sender_unavailable: 'O envio está indisponível.', configuration_changed: 'A configuração mudou.', scope_changed: 'O escopo autorizado mudou.', interrupted: 'A preparação foi interrompida.', context_changed: 'O atendimento mudou.' });
const modeOf = config => !config?.enabled ? 'off' : config.autoReply ? 'automatic' : 'draft';
const handoffOf = config => config?.handoffMode === 'continue' ? 'continue' : 'pause';
const productSourceOf = (channel, catalog) => channel.productNames?.length ? 'custom' : channel.productIds?.length ? 'registry' : catalog?.productInputMode === 'custom' ? 'custom' : 'registry';
// The legacy platform-owner DTO may omit role; explicit operator/delegated sessions never qualify.
const adminOf = state => Boolean(state?.boot?.session && (state.boot.session.role === 'reseller'
  || state.boot.session.role === undefined && state.boot.session.platformOwner === true)
  && !state.supportGrantId && !state.boot.session.supportGrantId && state.boot.session.kind !== 'service');
const modeLabel = mode => mode === 'automatic' ? i18nText('Respostas automáticas') : mode === 'draft' ? i18nText('Rascunhos para revisão') : i18nText('Assistente desligado');
const knowledgeCount = agent => Number.isSafeInteger(agent?.knowledgeCount) && agent.knowledgeCount >= 0 && agent.knowledgeCount <= 16 ? agent.knowledgeCount : 0;
const contextOf = state => JSON.stringify([state?.workspaceId || null, state?.tenant?.id || null, state?.boot?.session?.userId || null, state?.boot?.session?.role || null, state?.boot?.session?.platformOwner === true, state?.supportGrantId || state?.boot?.session?.supportGrantId || null, state?.boot?.canonicalPublicOrigin || state?.boot?.publicOrigin || null, state?.view || null]);
let renderedContext = null;
const bindings = new WeakMap();
const sameList = (left, right) => Array.isArray(left) && Array.isArray(right) && left.every(item => typeof item === 'string') && right.every(item => typeof item === 'string') && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export function supportIntegrationMarkup(integration, expected = {}) {
  let origin;
  try { const url = new URL(integration.source); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/widget.js' || url.search || url.hash) return ''; origin = url.origin; } catch { return ''; }
  if (![integration.tenantId, integration.channelId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id))) return '';
  if (expected.tenantId !== integration.tenantId || expected.channelId !== integration.channelId || expected.publicOrigin !== origin) return '';
  return `<script type="module" src="${origin}/widget.js" data-tenant-id="${integration.tenantId}" data-channel-id="${integration.channelId}"></script>`;
}
export function renderSupportAssistant(state) {
  if (!adminOf(state)) return '';
  const scope = contextOf(state); renderedContext = { state, scope };
  return i18nHtml`<section class="support-central panel" data-support-assistant-root data-support-tenant="${escape(state.tenant?.id || '')}" data-support-context="${escape(scope)}" data-support-origin="${escape(state.boot.canonicalPublicOrigin || state.boot.publicOrigin || '')}" aria-label="${escape(i18nText(state.boot.session.platformOwner === true ? 'Central de suporte dos nossos produtos' : 'Central de suporte dos seus produtos'))}">
    <div class="support-central-heading"><div><span class="eyebrow">NOSSA OPERAÇÃO</span><h2>${state.boot.session.platformOwner === true ? i18nText('Suporte dos nossos produtos') : i18nText('Suporte dos seus produtos')}</h2><p>Confira a recepção, escolha como o assistente atua e acompanhe os registros desta empresa.</p></div><button class="button" type="button" data-support-reload>Atualizar catálogo</button></div>
    <ol class="support-central-steps"><li><strong>1. Recepção no painel</strong><span>Autorize o site em Canais e instale o chat no produto.</span></li><li><strong>2. Assistente e fontes</strong><span>Escolha o agente, os produtos e as publicações autorizadas.</span></li><li><strong>3. Validar atendimento</strong><span>Confira a ida e a volta no produto e a continuidade pela equipe.</span></li></ol>
    <p class="support-central-note">Recepção habilitada não comprova que o chat foi instalado no produto. Atividade registrada não comprova a integração nem a entrega ao visitante.</p>
    <p class="support-central-note">Use um Hermes já configurado nesta empresa. Em Agentes, abra o agente e escolha Configurar serviço para conectar seu endpoint, modelo e credencial existentes. Este formulário não cria um Hermes nem altera seu perfil ou memória.</p>
    <p class="support-central-note">Em Canais, habilite a recepção, autorize as origens HTTPS exatas do seu SaaS e defina o destinatário das notificações de suporte. Nomes de produtos não autorizam outras empresas, agentes ou fontes.</p>
    <p class="support-central-notice" data-support-central-notice role="status" hidden></p><button class="button" type="button" data-support-discard-drafts hidden>Descartar alterações e atualizar catálogo</button>
    <div data-support-central-content aria-live="polite"><p class="muted">Carregando as conexões de suporte…</p></div>
  </section>`;
}
function recentActivity(config) {
  const jobs = Array.isArray(config.jobs) ? config.jobs : [];
  return i18nHtml`<details class="support-central-activity"><summary>${i18nText('Atividade registrada')} · ${jobs.length}</summary><p>São registros do assistente nesta conexão. Eles não comprovam instalação no site nem entrega ao visitante.</p><ul class="support-central-jobs">${jobs.slice(0, 10).map(job => {
    const instant = Date.parse(job.updatedAt), date = Number.isFinite(instant) ? new Date(instant).toLocaleString(getLocale()) : i18nText('Horário indisponível');
    return `<li><div><strong>${escape(states[job.state] || i18nText('Estado indisponível'))}</strong>${job.reason ? `<p>${escape(reasons[job.reason] || i18nText('Motivo não detalhado.'))}</p>` : ''}</div><time${Number.isFinite(instant) ? ` datetime="${escape(new Date(instant).toISOString())}"` : ''}>${escape(date)}</time></li>`;
  }).join('') || i18nMarkup('<li>Nenhuma atividade do assistente registrada. Isso não informa se o chat está instalado no produto.</li>')}</ul></details>`;
}
export function supportCatalogMarkup(catalog, expected = {}) {
  if (!catalog.channels?.length) return i18nMarkup('<div class="support-central-empty"><h3>Comece pela recepção do webchat</h3><p>Cadastre o canal e autorize os sites dos produtos em Canais. Depois instale o código no produto e configure o assistente aqui.</p><a class="button" href="#channels">Abrir Canais</a></div>');
  return `<div class="support-central-grid">${catalog.channels.map(channel => {
    const config = channel.assistant || {}, mode = modeOf(config), agent = catalog.agents?.find(item => item.id === config.agentId);
    const savedProducts = channel.productNames?.length ? channel.productNames : (channel.productIds || []).map(id => catalog.products?.find(product => product.id === id)?.name || id);
    const productSource = productSourceOf(channel, catalog), handoffMode = handoffOf(config);
    const ready = channel.configured === true && channel.origins?.length > 0, canDisable = Boolean(config.agentId && savedProducts.length);
    const snippet = ready ? supportIntegrationMarkup(channel.integration || {}, { ...expected, channelId: channel.id }) : '';
    const next = !ready ? i18nText('Ative a recepção e autorize a origem em Canais.') : mode === 'off' ? i18nText('Instale ou confira o chat no produto. Para usar o assistente, escolha o agente, as fontes e um modo de atendimento.') : mode === 'draft' ? i18nText('Confira o chat no produto. No Atendimento, a equipe revisa o rascunho antes de enviar.') : i18nText('Confira a resposta no produto e a transferência para uma pessoa. A equipe pode assumir no Atendimento.');
    return i18nHtml`<article class="support-central-connection" data-support-card="${escape(channel.id)}"><div class="support-central-title"><h3>${escape(channel.name)}</h3><span class="badge">${modeLabel(mode)}</span></div>
      <div class="support-central-state"><span class="badge">${ready ? i18nText('Recepção habilitada no painel') : i18nText('Recepção a configurar')}</span><span>${mode === 'off' ? i18nText('O assistente não prepara nem envia respostas.') : mode === 'draft' ? i18nText('O assistente prepara; a equipe revisa e envia.') : i18nText('O assistente responde no webchat quando há conhecimento autorizado.')}</span></div>
      <dl class="support-central-context"><dt>Origem autorizada</dt><dd>${channel.origins?.length ? channel.origins.map(origin => `<code>${escape(origin)}</code>`).join('') : i18nText('Nenhum site autorizado')}</dd><dt>Agente salvo</dt><dd>${agent ? escape(agent.name) : config.agentId ? i18nText('Agente anterior indisponível') : i18nText('Nenhum agente escolhido')}</dd><dt>Produtos salvos</dt><dd>${savedProducts.length ? savedProducts.map(escape).join(' · ') : i18nText('Nenhum produto escolhido')}</dd><dt>Fontes do agente</dt><dd>${agent ? i18nText('{count} concessão(ões) cadastrada(s)', { count: knowledgeCount(agent) }) : i18nText('Escolha um agente para conferir as fontes.')}${agent ? i18nHtml`<a href="#agents/${encodeURIComponent(agent.id)}/knowledge">Revisar publicações autorizadas</a>` : ''}</dd></dl>
      <div class="support-central-next"><strong>Próxima ação</strong><p>${next}</p><a class="button" href="${ready ? '#inbox' : '#channels'}">${ready ? i18nText('Abrir Atendimento') : i18nText('Abrir Canais')}</a></div>
      <details class="support-central-settings"><summary>Configurar como o assistente atende</summary><form data-support-channel="${escape(channel.id)}" data-version="${Number.isSafeInteger(config.version) ? config.version : 0}">
        <label>Agente de suporte<select name="agentId" ${mode !== 'off' ? 'required' : ''}><option value="">${productSource === 'custom' ? i18nText('Escolher Hermes desta empresa') : i18nText('Escolher agente gerenciado')}</option>${config.agentId && !agent ? i18nHtml`<option value="${escape(config.agentId)}" selected>Agente anterior indisponível · desative ou escolha outro</option>` : ''}${(catalog.agents || []).map(item => i18nHtml`<option value="${escape(item.id)}" ${item.id === config.agentId ? 'selected' : ''}>${escape(item.name)} · ${knowledgeCount(item)} fonte(s)</option>`).join('')}</select></label>
        ${agent ? i18nHtml`<a href="#agents/${encodeURIComponent(agent.id)}">Revisar conexão do meu Hermes</a>` : ''}
        <fieldset><legend>Produtos atendidos</legend><div style="display:grid;gap:16px;width:100%;min-width:0"><label>Identificação dos produtos<select name="productSource"><option value="custom" ${productSource === 'custom' ? 'selected' : ''}>Meu SaaS / nomes de produtos</option><option value="registry" ${productSource === 'registry' ? 'selected' : ''}>Catálogo de produtos existente</option></select></label><div data-support-products-custom ${productSource !== 'custom' ? 'hidden' : ''}><label>Nomes dos produtos<textarea name="productNames" rows="3" maxlength="647" placeholder="${escape(i18nText('Ex.: Meu SaaS\nPortal do cliente'))}">${escape((channel.productNames || []).join('\n'))}</textarea></label><p class="support-central-note">Um nome por linha: de 1 a 8 produtos, até 80 caracteres cada, sem repetição nem marcação HTML.</p></div><div data-support-products-registry ${productSource !== 'registry' ? 'hidden' : ''}>${(catalog.products || []).map(product => `<label class="checkbox-label"><input type="checkbox" name="productIds" value="${escape(product.id)}" ${channel.productIds?.includes(product.id) ? 'checked' : ''}>${escape(product.name)}</label>`).join('')}</div></div></fieldset>
        <label>Como atender<select name="mode"><option value="off" ${mode === 'off' ? 'selected' : ''}>Desligado</option><option value="draft" ${mode === 'draft' ? 'selected' : ''}>Preparar para revisão humana</option><option value="automatic" ${mode === 'automatic' ? 'selected' : ''}>Responder automaticamente no webchat</option></select></label>
        <label>Ao abrir um ticket de suporte<select name="handoffMode"><option value="pause" ${handoffMode === 'pause' ? 'selected' : ''}>Pausar para atendimento humano</option><option value="continue" ${handoffMode === 'continue' ? 'selected' : ''}>Continuar com o ticket de suporte</option></select></label>
        <p class="support-central-note">Ao desligar, o agente e os produtos já salvos são mantidos. A recepção do chat continua sendo controlada em Canais.</p>
        <p class="support-central-note">O assistente se identifica como virtual. As notificações usam o destinatário configurado em Canais; registrar um chamado não comprova entrega do e-mail. Continuar não ignora falta de fontes, mídia ou permissões. Se uma pessoa assumir, as respostas automáticas param nos dois modos.</p>
        <p class="support-central-note">Continuar vale para chamados abertos pelo assistente. Se o visitante pedir uma pessoa, o assistente pausa nos dois modos.</p>
        <p data-support-error role="alert" tabindex="-1" hidden></p><p data-support-status role="status" hidden></p><button class="button primary" type="submit" ${!ready || mode === 'off' && !canDisable ? 'disabled' : ''}>Salvar suporte</button><button class="button" type="button" data-support-catalog-retry hidden>Atualizar catálogo</button>
      </form></details>
      ${snippet ? i18nHtml`<details><summary>Instalar o chat no produto</summary><p>Use este código no site autorizado. Ele abre a conversa nesta conexão, sem expor uma chave de agente. Depois confira o atendimento no produto; este painel não detecta a instalação.</p><textarea readonly aria-label="Código do chat de suporte" rows="4">${escape(snippet)}</textarea></details>` : ''}
      ${recentActivity(config)}
    </article>`;
  }).join('')}</div>`;
}
export function bindSupportAssistant({ root, tenantId, api, toast, refresh, admin, platformAdmin, supportGrantId }) {
  const panel = root?.querySelector('[data-support-assistant-root]'), content = panel?.querySelector('[data-support-central-content]');
  if (!(admin === true || platformAdmin === true) || supportGrantId || !panel || !content || !tenantId || panel.dataset.supportTenant && panel.dataset.supportTenant !== tenantId) return;
  const token = {}, expectedContext = panel.dataset.supportContext, expectedOrigin = panel.dataset.supportOrigin, authority = expectedContext && renderedContext?.scope === expectedContext ? renderedContext.state : null;
  bindings.set(panel, token);
  const current = () => bindings.get(panel) === token && panel.isConnected && root.contains(panel) && root.querySelector('[data-support-assistant-root]') === panel && panel.querySelector('[data-support-central-content]') === content && (!panel.dataset.supportTenant || panel.dataset.supportTenant === tenantId) && panel.dataset.supportContext === expectedContext && panel.dataset.supportOrigin === expectedOrigin && (!authority || adminOf(authority) && contextOf(authority) === expectedContext);
  const currentForm = form => current() && form.isConnected !== false && (!content.contains || content.contains(form));
  const base = `/api/tenants/${encodeURIComponent(tenantId)}`, reload = panel.querySelector('[data-support-reload]'), notice = panel.querySelector('[data-support-central-notice]'), discard = panel.querySelector('[data-support-discard-drafts]');
  let sequence = 0, loading = false, writing = false, catalogStale = false, catalog = null;
  const formModeUpdates = new WeakMap();
  function updateControls() {
    if (!current()) return;
    if (reload) { reload.disabled = loading || writing; if (reload.disabled) reload.setAttribute?.('aria-busy', 'true'); else reload.removeAttribute?.('aria-busy'); }
    if (discard) discard.disabled = loading || writing;
    for (const form of content.querySelectorAll('form[data-support-channel]')) formModeUpdates.get(form)?.();
  }
  const notify = message => { if (notice && current()) { notice.textContent = message; notice.hidden = !message; } };
  const draftOf = form => {
    const saved = catalog?.channels?.find(channel => channel.id === form.dataset.supportChannel);
    return { channelId: form.dataset.supportChannel, version: Number(form.dataset.version), agentId: form.elements.agentId.value, mode: form.elements.mode.value,
      productIds: Array.from(form.querySelectorAll('input[name="productIds"]:checked')).map(item => item.value),
      productSource: form.elements.productSource?.value || productSourceOf(saved || {}, catalog),
      productNames: form.elements.productNames?.value ?? (saved?.productNames || []).join('\n'),
      handoffMode: form.elements.handoffMode?.value || handoffOf(saved?.assistant) };
  };
  function pendingDrafts() {
    return Array.from(content.querySelectorAll('form[data-support-channel]')).filter(form => currentForm(form)).map(form => draftOf(form)).filter(draft => {
      const saved = catalog?.channels?.find(channel => channel.id === draft.channelId);
      return saved && (draft.agentId !== (saved.assistant?.agentId || '') || draft.mode !== modeOf(saved.assistant) || !sameList(draft.productIds, saved.productIds || [])
        || draft.productSource !== productSourceOf(saved, catalog) || draft.productNames !== (saved.productNames || []).join('\n') || draft.handoffMode !== handoffOf(saved.assistant));
    });
  }
  function restoreDraft(form, draft) {
    const agent = form.elements.agentId;
    if (draft.agentId && agent.options && !Array.from(agent.options).some(option => option.value === draft.agentId)) { const option = document.createElement('option'); option.value = draft.agentId; option.textContent = i18nText('Agente escolhido indisponível'); agent.append(option); }
    agent.value = draft.agentId; form.elements.mode.value = draft.mode;
    if (form.elements.productSource) form.elements.productSource.value = draft.productSource;
    if (form.elements.productNames) form.elements.productNames.value = draft.productNames;
    if (form.elements.handoffMode) form.elements.handoffMode.value = draft.handoffMode;
    for (const checkbox of form.querySelectorAll('input[name="productIds"]')) checkbox.checked = draft.productIds.includes(checkbox.value);
  }
  const showFailure = failure => {
    if (!current()) return;
    notify(i18nText('Não foi possível atualizar o catálogo. Tente novamente; isso só consulta a configuração.'));
    if (catalog) return;
    content.replaceChildren();
    const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = translateError(failure?.message) || i18nText('Não foi possível carregar o suporte.'); content.append(message);
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = i18nText('Tentar novamente'); retry.addEventListener('click', () => loadCatalog()); content.append(retry);
  };
  async function loadCatalog(afterSave = false) {
    if (!current() || loading || writing && !afterSave) return;
    loading = true; const request = ++sequence;
    updateControls();
    try {
      const result = await api(base + '/support-assistant/catalog');
      if (!current() || request !== sequence) return;
      // Read the live fields at completion: edits made while GET was pending also survive.
      const drafts = pendingDrafts();
      if (drafts.some(draft => result?.channels?.find(channel => channel.id === draft.channelId)?.assistant?.version !== draft.version)) {
        catalogStale = true;
        notify(i18nText('O catálogo mudou enquanto você editava. Suas escolhas foram preservadas. Descarte as alterações para carregar a configuração atual.'));
        if (discard) discard.hidden = false;
        return;
      }
      catalogStale = false; catalog = result; notify(''); content.innerHTML = supportCatalogMarkup(catalog, { tenantId, publicOrigin: panel.dataset.supportOrigin });
      if (discard) discard.hidden = true;
      for (const form of content.querySelectorAll('form[data-support-channel]')) { const draft = drafts.find(item => item.channelId === form.dataset.supportChannel); if (draft) restoreDraft(form, draft); bindForm(form); }
    } catch (failure) { if (request === sequence) showFailure(failure); }
    finally { loading = false; updateControls(); }
  }
  function bindForm(form) {
    const channel = catalog.channels?.find(item => item.id === form.dataset.supportChannel);
    if (!channel) return;
    const error = form.querySelector('[data-support-error]'), status = form.querySelector('[data-support-status]'), submit = form.querySelector('button[type="submit"]'), retry = form.querySelector('[data-support-catalog-retry]');
    let confirmed = null;
    const fail = message => { if (currentForm(form) && error) { error.textContent = message; error.hidden = false; error.focus(); } };
    const updateMode = () => {
      if (!currentForm(form)) return;
      const off = form.elements.mode.value === 'off', source = form.elements.productSource?.value || productSourceOf(channel, catalog);
      form.elements.agentId.required = !off;
      if (form.elements.productNames) { form.elements.productNames.required = !off && source === 'custom'; form.elements.productNames.disabled = off || source !== 'custom'; }
      for (const kind of ['custom', 'registry']) { const group = form.querySelector(`[data-support-products-${kind}]`); if (group) group.hidden = source !== kind; }
      submit.disabled = loading || writing || catalogStale || Boolean(form.dataset.busy || form.dataset.catalogPending) || !channel.configured || !channel.origins?.length || off && !(channel.assistant?.agentId && (channel.productIds?.length || channel.productNames?.length));
    };
    formModeUpdates.set(form, updateMode);
    const savedNotice = message => { if (status && currentForm(form)) { status.textContent = message; status.hidden = false; } };
    retry?.addEventListener('click', () => loadCatalog());
    form.addEventListener('change', updateMode);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!currentForm(form) || loading || writing || form.dataset.busy || form.dataset.catalogPending) return;
      if (catalogStale) { fail(i18nText('O catálogo mudou enquanto você editava. Suas escolhas foram preservadas. Descarte as alterações para carregar a configuração atual.')); return; }
      const mode = form.elements.mode.value, off = mode === 'off';
      const draft = draftOf(form), source = off ? productSourceOf(channel, catalog) : draft.productSource;
      const input = { version: Number(form.dataset.version), agentId: off ? channel.assistant?.agentId : draft.agentId, enabled: !off, autoReply: mode === 'automatic',
        ...(source === 'custom' ? { productNames: off ? [...(channel.productNames || [])] : draft.productNames.split(/\r?\n/).map(name => name.trim()).filter(Boolean) }
          : { productIds: off ? [...(channel.productIds || [])] : draft.productIds }),
        ...(form.elements.handoffMode ? { handoffMode: draft.handoffMode } : {}) };
      if (!['off', 'draft', 'automatic'].includes(mode)) { fail(i18nText('Escolha como o assistente deve atender.')); return; }
      if (!['custom', 'registry'].includes(source) || !['pause', 'continue'].includes(draft.handoffMode)) { fail(i18nText('Escolha uma identificação de produtos e um modo de ticket válidos.')); return; }
      if (!input.agentId || !(input.productNames || input.productIds).length) { fail(off ? i18nText('O assistente já está desligado e não tem configuração salva. Escolha um agente, um produto e um modo de atendimento para configurar.') : i18nText('Escolha o agente e pelo menos um produto.')); return; }
      if (input.productNames && (input.productNames.length > 8 || input.productNames.some(name => name.length > 80 || !name.isWellFormed() || !/[\p{L}\p{N}]/u.test(name) || /[\p{Cc}\p{Cf}<>]/u.test(name))
        || new Set(input.productNames.map(name => name.normalize('NFKC').toLocaleLowerCase('pt-BR'))).size !== input.productNames.length)) { fail(i18nText('Informe de 1 a 8 nomes de produtos, sem repetição, com até 80 caracteres cada e sem marcação ou caracteres de controle.')); return; }
      const fingerprint = value => JSON.stringify([value.agentId, value.enabled, value.autoReply, value.handoffMode || 'pause', source, [...(value.productNames || value.productIds)].sort()]);
      if (confirmed === fingerprint(input)) return;
      error.hidden = true; if (status) status.hidden = true; form.dataset.busy = '1'; writing = true; updateControls(); submit.textContent = i18nText('Salvando…');
      try {
        const saved = await api(`${base}/channels/${encodeURIComponent(form.dataset.supportChannel)}/support-assistant`, { method: 'PATCH', body: JSON.stringify(input) });
        if (!currentForm(form)) return;
        const products = input.productNames || input.productIds.map(id => catalog.products?.find(product => product.id === id)?.name);
        if (saved?.channelId !== form.dataset.supportChannel || saved.version !== input.version + 1 || saved.agentId !== input.agentId || saved.enabled !== input.enabled || saved.autoReply !== input.autoReply
          || input.handoffMode && saved.handoffMode !== input.handoffMode || !sameList(saved.products, products) || !sameList(saved.origins, channel.origins)) { form.dataset.catalogPending = '1'; if (retry) retry.hidden = false; throw Error(i18nText('Não foi possível confirmar a configuração. Atualize a tela antes de tentar novamente.')); }
        confirmed = fingerprint(input); form.dataset.version = String(saved.version); channel.assistant = saved; channel.productIds = [...(input.productIds || [])]; channel.productNames = [...(input.productNames || [])];
        savedNotice(i18nText('Configuração salva.')); toast(i18nText('Suporte configurado.'));
        // A whole-app render would erase edits in the other support cards. Reconcile only
        // this catalog when there are live drafts; its GET keeps those fields by revision.
        try { if (pendingDrafts().length) await loadCatalog(true); else await refresh(); }
        catch { if (currentForm(form)) { form.dataset.catalogPending = '1'; if (retry) retry.hidden = false; savedNotice(i18nText('Configuração salva. A atualização da tela falhou. Atualize o catálogo para conferir; isso não repete o salvamento.')); } }
      } catch (failure) {
        if (currentForm(form) && failure?.status === 409) {
          notify(i18nText('O catálogo mudou enquanto você editava. Suas escolhas foram preservadas. Descarte as alterações para carregar a configuração atual.'));
          if (discard) discard.hidden = false;
        }
        fail(translateError(failure?.message) || i18nText('Não foi possível salvar. Atualize e tente novamente.'));
      }
      finally { writing = false; if (currentForm(form)) { delete form.dataset.busy; submit.textContent = form.dataset.catalogPending && confirmed ? i18nText('Configuração salva') : i18nText('Salvar suporte'); } updateControls(); }
    });
    updateMode();
  }
  reload?.addEventListener('click', () => loadCatalog());
  discard?.addEventListener('click', () => {
    if (!current() || loading || writing) return;
    for (const form of content.querySelectorAll('form[data-support-channel]')) {
      const saved = catalog?.channels?.find(channel => channel.id === form.dataset.supportChannel);
      if (saved && currentForm(form)) restoreDraft(form, { agentId: saved.assistant?.agentId || '', mode: modeOf(saved.assistant), productIds: saved.productIds || [],
        productSource: productSourceOf(saved, catalog), productNames: (saved.productNames || []).join('\n'), handoffMode: handoffOf(saved.assistant) });
    }
    return loadCatalog();
  });
  void loadCatalog();
  return { reloadCatalog: loadCatalog };
}
