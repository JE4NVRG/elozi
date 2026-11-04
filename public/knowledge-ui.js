import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';
import './locales-knowledge-recovery.js';
// White label of the agent copy (P5): the engine name stays out of customer workspaces.
import './locales-agents-hub.js';

// The screen app.js created, read by the agent detail (agents-hub-ui.js, P5) to open the grant dialog.
let latestScreen = null;
export const knowledgeScreen = () => latestScreen;

export function createKnowledgeUI(ctx) {
  const { state, escape: e, icon, badge, pageHeading, api, tenantApi, formModal, toast } = ctx;
  const admin = () => state.boot?.session?.role === 'reseller';
  const scope = () => JSON.stringify([state.workspaceId, state.boot?.session?.resellerId, state.tenant?.id, state.boot?.session?.userId, state.boot?.session?.role, state.supportGrantId]);
  const sources = () => state.knowledgeSources || [];
  const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString(getLocale()) : '';
  const action = (label, name, id = '', primary = false, disabled = false, glyph = '') => `<button type="button" class="button ${primary ? 'primary' : ''}" data-action="${e(name)}" data-id="${e(id)}" ${disabled ? 'disabled' : ''}>${glyph ? icon(glyph) : ''}${e(label)}</button>`;
  const publication = source => source?.published?.version ? source.published : null;
  const names = i18nLabels({ all: 'Todas as fontes', draft: 'Rascunhos', published: 'Publicadas', archived: 'Arquivadas' });
  let loadedScope = null, loadRequest = 0, modalRequest = 0;
  let editor = null, grantsEditor = null, previewEditor = null;
  let search = '', filter = 'all', loading = null;
  let catalogScope = scope(), catalogStatus = 'idle';
  let runSyncRequest = 0, authorityChangeId = 0;
  const pendingAuthorityChanges = new Map();

  function metadata(source) {
    const { id, title, category, version, archived, status, draftChanged, contentChars, createdAt, updatedAt } = source;
    const published = publication(source);
    return { id, title, category, version, archived, status, draftChanged, contentChars: contentChars ?? String(source.content || '').length, createdAt, updatedAt, ...(published ? { published: { version: published.version, title: published.title, hash: published.hash, publishedAt: published.publishedAt } } : {}) };
  }

  function reset() {
    loadedScope = null; loadRequest++; modalRequest++;
    catalogScope = scope(); catalogStatus = 'idle';
    editor = null; grantsEditor = null; previewEditor = null; loading = null;
    runSyncRequest++; pendingAuthorityChanges.clear();
    search = ''; filter = 'all'; state.knowledgeSources = []; state.knowledgeLoaded = false;
  }

  function syncCatalogScope() {
    if (catalogScope !== scope() || !admin() || !state.tenant?.id) reset();
  }

  function load(options = {}) {
    syncCatalogScope();
    if (!admin() || !state.tenant?.id) return Promise.resolve(false);
    const expectedScope = scope();
    if (loadedScope !== expectedScope) { state.knowledgeSources = []; state.knowledgeLoaded = false; }
    if (loading?.scope === expectedScope) return loading.promise;
    if (!options.force && state.knowledgeLoaded && loadedScope === expectedScope && catalogStatus === 'ready') return Promise.resolve(true);
    const sequence = ++loadRequest;
    // Reserve before the transport, including synchronous reentrant callers.
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    const ticket = { scope: expectedScope, promise };
    loading = ticket; catalogStatus = 'loading'; repaintLibrary();
    const current = () => scope() === expectedScope && admin() && sequence === loadRequest && loading === ticket;
    (async () => {
      try {
        const data = await api(tenantApi('knowledge/sources?archived=true'));
        if (!current()) return false;
        if (!Array.isArray(data?.sources)) throw new Error('Invalid knowledge catalog');
        state.knowledgeSources = data.sources.map(metadata); state.knowledgeLoaded = true; loadedScope = expectedScope;
        catalogStatus = 'ready';
        return true;
      } catch (error) {
        if (!current()) return false;
        catalogStatus = [401, 403, 404].includes(error?.status) ? 'denied' : 'error';
        if (catalogStatus === 'denied') {
          state.knowledgeSources = []; state.knowledgeLoaded = false; loadedScope = null;
          modalRequest++; editor = null; grantsEditor = null; previewEditor = null;
        }
        throw error;
      } finally {
        if (current()) { loading = null; repaintLibrary(); }
      }
    })().then(resolve, reject);
    return promise;
  }

  function catalogMessage() {
    if (catalogStatus === 'denied') return i18nText('O acesso às fontes desta empresa não está disponível. Confira sua sessão e suas permissões.');
    if (catalogStatus === 'error') return state.knowledgeLoaded
      ? i18nText('Não foi possível atualizar as fontes. O último resultado confirmado desta empresa foi preservado e pode estar desatualizado.')
      : i18nText('Não foi possível carregar as fontes desta empresa. Tente novamente.');
    if (catalogStatus === 'idle') return i18nText('As fontes ainda não foram carregadas.');
    if (catalogStatus === 'loading') return state.knowledgeLoaded ? i18nText('Atualizando as fontes da empresa…') : i18nText('Carregando as fontes da empresa…');
    return '';
  }

  function catalogRecovery() {
    return `<p id="knowledge-catalog-status" role="status" aria-live="polite" aria-atomic="true">${e(catalogMessage())}</p><button type="button" id="knowledge-retry" class="button" data-action="knowledge-retry" aria-controls="knowledge-library-items" aria-describedby="knowledge-catalog-status" ${catalogStatus === 'loading' ? 'aria-disabled="true"' : ''} ${['error', 'denied', 'loading'].includes(catalogStatus) ? '' : 'hidden'}>${e(i18nText('Tentar carregar as fontes novamente'))}</button>`;
  }

  function status(source) {
    if (source.archived) return badge(i18nText('Arquivada'), 'neutral');
    if (publication(source) && source.draftChanged) return badge(i18nText('Rascunho alterado'), 'amber');
    return publication(source) ? badge(i18nText('Publicada'), 'green') : badge(i18nText('Rascunho'), 'neutral');
  }

  function visibleSources() {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    return sources().filter(source => (filter === 'archived' ? source.archived : !source.archived && (filter === 'all' || filter === 'draft' && (!publication(source) || source.draftChanged) || filter === 'published' && publication(source))) && `${source.title} ${source.category || ''}`.toLocaleLowerCase('pt-BR').includes(query));
  }

  function sourceCard(source) {
    const published = publication(source);
    return i18nHtml`<article class="knowledge-card ${source.archived ? 'knowledge-archived' : ''}"><div class="knowledge-card-top"><span class="knowledge-source-mark">${icon('document')}</span>${status(source)}</div><h2>${e(source.title)}</h2><p class="knowledge-category">${e(source.category || i18nText('Sem categoria'))}</p><dl class="knowledge-source-versions"><div><dt>Rascunho salvo</dt><dd>v${e(source.version)} <span>· ${Number(source.contentChars || 0).toLocaleString(getLocale())} caracteres</span></dd></div><div><dt>Publicação disponível</dt><dd>${published && !source.archived ? `v${e(published.version)}${source.draftChanged ? i18nText(' · aguardando revisão do rascunho') : ''}` : i18nText('Ainda não publicada')}</dd></div></dl>${published && !source.archived ? i18nHtml`<p class="knowledge-published-date">${icon('check')} Publicada em ${e(date(published.publishedAt))}</p>` : i18nMarkup('<p class="knowledge-published-date">Publique e autorize esta fonte em um agente.</p>')}<div class="knowledge-card-actions">${action(source.archived ? i18nText('Ver fonte arquivada') : i18nText('Editar fonte'), 'knowledge-edit', source.id, false, false, 'arrow')}${!source.archived && (!published || source.draftChanged) ? action(i18nText('Publicar rascunho'), 'knowledge-publish', source.id, false, false, 'check') : ''}</div></article>`;
  }

  function libraryItems() {
    if (!state.knowledgeLoaded) return '';
    const visible = visibleSources();
    if (visible.length) return `<div class="knowledge-grid">${visible.map(sourceCard).join('')}</div>`;
    if (sources().length) return i18nHtml`<div class="knowledge-empty"><span class="knowledge-empty-mark">${icon('search')}</span><h2>Nenhuma fonte neste filtro.</h2><p>Busque pelo título ou categoria, ou veja todas as fontes ativas.</p>${action(i18nText('Limpar filtros'), 'knowledge-clear-filters')}</div>`;
    return i18nHtml`<div class="knowledge-empty"><span class="knowledge-empty-mark">${icon('document')}</span><span class="eyebrow">COMECE COM O QUE SUA EQUIPE JÁ SABE</span><h2>Uma boa resposta começa com uma fonte confiável.</h2><p>Adicione políticas, respostas frequentes ou orientações do atendimento. Salve o rascunho, publique a versão revisada e escolha quais agentes podem consultá-la.</p>${action(i18nText('Criar primeira fonte'), 'knowledge-new', '', true, false, 'plus')}<div class="knowledge-empty-examples"><span>Políticas de atendimento</span><span>Produtos e serviços</span><span>Perguntas frequentes</span></div></div>`;
  }

  function totals() {
    if (!state.knowledgeLoaded) return '<div><strong>—</strong><span>' + e(i18nText('Contagem indisponível')) + '</span></div>';
    const active = sources().filter(source => !source.archived);
    return i18nHtml`<div><strong>${active.filter(source => publication(source)).length}</strong><span>publicadas</span></div><div><strong>${active.filter(source => !publication(source) || source.draftChanged).length}</strong><span>rascunhos</span></div><div><strong>${sources().filter(source => source.archived).length}</strong><span>arquivadas</span></div>`;
  }

  function resultCount() {
    return state.knowledgeLoaded ? `${visibleSources().length} ${visibleSources().length === 1 ? i18nText('fonte') : i18nText('fontes')}` : i18nText('Contagem indisponível');
  }

  function libraryFoot() {
    const owner=i18nText('Conteúdo privado de {company}',{company:state.tenant?.name||''});
    return state.knowledgeLoaded?`${owner} · ${i18nText('{count}/50 fontes',{count:sources().length})}`:owner;
  }
  function panel() {
    syncCatalogScope();
    if (!admin()) return '';
    return i18nHtml`<div id="knowledge-screen">${pageHeading(i18nText('CONTEXTO DOS COPILOTOS'), i18nText('Base de conhecimento'), i18nText('Conteúdo revisado da sua empresa, disponível somente aos agentes que você autorizar.'), `${action(i18nText('Testar busca'), 'knowledge-preview', '', false, false, 'search')}${action(i18nText('Nova fonte'), 'knowledge-new', '', true, sources().length >= 50, 'plus')}`)}<section class="knowledge-overview"><div class="knowledge-overview-copy"><span class="knowledge-overview-mark">${icon('shield')}</span><div><strong>Seu conteúdo. Sua revisão.</strong><p>Salvar mantém um rascunho. Publicar disponibiliza uma versão para autorização por agente.</p></div></div><div id="knowledge-totals" class="knowledge-totals">${totals()}</div></section><section class="knowledge-library" aria-label="Fontes da empresa"><div class="knowledge-toolbar"><label class="knowledge-search">${icon('search')}<input id="knowledge-search" type="search" maxlength="120" placeholder="Buscar por título ou categoria" aria-label="Buscar fontes por título ou categoria" value="${e(search)}"/></label><label class="knowledge-filter"><span>Status</span><select id="knowledge-filter">${Object.entries(names).map(([value, label]) => `<option value="${value}" ${filter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><span id="knowledge-result-count" class="knowledge-result-count">${e(resultCount())}</span></div><div class="knowledge-catalog-recovery">${catalogRecovery()}</div><div id="knowledge-library-items" aria-busy="${catalogStatus === 'loading'}">${libraryItems()}</div><footer class="knowledge-library-foot">${icon('building')} <span>${e(libraryFoot())}</span><button type="button" class="text-button" data-view="agents">Autorizar fontes nos agentes ${icon('arrow')}</button></footer></section></div>`;
  }

  function repaintLibrary() {
    syncCatalogScope();
    if (typeof document === 'undefined' || state.view !== 'knowledge' || !admin()) return;
    const items = document.querySelector('#knowledge-library-items');
    if (items) { items.innerHTML = libraryItems(); items.setAttribute?.('aria-busy', String(catalogStatus === 'loading')); }
    const message = document.querySelector('#knowledge-catalog-status');
    if (message && message.textContent !== catalogMessage()) message.textContent = catalogMessage();
    const retry = document.querySelector('#knowledge-retry');
    if (retry) {
      const hadRetryFocus = document.activeElement === retry;
      retry.hidden = !['error', 'denied', 'loading'].includes(catalogStatus);
      retry.setAttribute?.('aria-disabled', String(catalogStatus === 'loading'));
      if (retry.hidden && hadRetryFocus) document.querySelector('#knowledge-search')?.focus?.();
    }
    const totalsNode = document.querySelector('#knowledge-totals'); if (totalsNode) totalsNode.innerHTML = totals();

    const count = document.querySelector('#knowledge-result-count'); if (count && count.textContent !== resultCount()) count.textContent = resultCount();
    const newButton = document.querySelector('#knowledge-screen [data-action="knowledge-new"]'); if (newButton) newButton.disabled = sources().length >= 50;
    const foot = document.querySelector('.knowledge-library-foot>span'); if (foot) foot.textContent = libraryFoot();
  }

  function upsert(source) {
    const entry = metadata(source), index = sources().findIndex(item => item.id === source.id);
    if (index < 0) state.knowledgeSources = [entry, ...sources()]; else state.knowledgeSources = sources().map(item => item.id === entry.id ? entry : item);
    repaintLibrary();
  }

  function editorStatus(source) {
    const published = publication(source);
    return `${status(source || {})}<span>${source?.id ? i18nTemplate`Rascunho v${e(source.version)}` : i18nText('Nova fonte · ainda não salva')}</span>${published ? i18nHtml`<span>Publicação v${e(published.version)} · ${e(date(published.publishedAt))}</span>` : i18nMarkup('<span>Sem publicação disponível aos agentes</span>')}`;
  }

  function editorActions(source) {
    if (!source?.id) return i18nMarkup('<p>Salve o rascunho antes de publicar.</p>');
    if (source.archived) return i18nHtml`${action(i18nText('Reativar como rascunho'), 'knowledge-reactivate', source.id)}<p>Reativar preserva o texto. Uma nova publicação e autorização serão necessárias.</p>`;
    const published = publication(source);
    return `${!published || source.draftChanged ? action(i18nText('Publicar rascunho salvo'), 'knowledge-publish', source.id, true, false, 'check') : ''}${published ? action(i18nText('Retirar publicação'), 'knowledge-unpublish', source.id) : ''}${action(i18nText('Arquivar fonte'), 'knowledge-archive', source.id)}<p>${published ? i18nText('Cada agente mantém a versão autorizada. Uma nova publicação exige revisar as autorizações.') : i18nText('Publicar é uma ação separada de salvar. Depois, autorize esta versão nos agentes.')}</p>`;
  }

  function savedFields(source) { return { title: source?.title || '', category: source?.category || '', content: source?.content || '' }; }

  function sourceFields(form) {
    return { title: form.elements.title.value.trim(), category: form.elements.category.value.trim(), content: form.elements.content.value };
  }

  function sourceForm() { return document.querySelector('#modal form[data-dialog-form="knowledge-source"]'); }
  function editorDirty(form = sourceForm()) { return Boolean(form && editor && JSON.stringify(sourceFields(form)) !== JSON.stringify(editor.saved)); }

  async function openSource(id) {
    const expectedScope = scope(), sequence = ++modalRequest;
    const source = id ? await api(tenantApi(`knowledge/sources/${encodeURIComponent(id)}`)) : null;
    if (scope() !== expectedScope || !admin() || sequence !== modalRequest) return;
    editor = { scope: expectedScope, id: source?.id, version: source?.version, source, saved: savedFields(source), pending: false, current: null };
    grantsEditor = null; previewEditor = null;
    formModal(source ? i18nText('Editar fonte de conhecimento') : i18nText('Nova fonte de conhecimento'), i18nTemplate`${state.tenant.name} · revise o conteúdo antes de publicar.`, 'knowledge-source', i18nHtml`<div class="knowledge-editor"><div class="knowledge-editor-status">${editorStatus(source)}</div><div class="knowledge-editor-meta"><label>Título da fonte<input name="title" maxlength="120" value="${e(source?.title || '')}" placeholder="Ex.: Política de troca e devolução" required ${source?.archived ? 'readonly' : ''}/></label><label>Categoria<input name="category" maxlength="80" value="${e(source?.category || '')}" placeholder="Ex.: Atendimento" ${source?.archived ? 'readonly' : ''}/></label></div><div class="knowledge-editor-columns"><div class="knowledge-editor-content"><div class="knowledge-content-heading"><label for="knowledge-content">Conteúdo da fonte</label>${!source?.archived ? action('Importar TXT / MD', 'knowledge-import-file', '', false, false, 'paperclip') : ''}<input type="file" data-knowledge-file accept=".txt,.md,text/plain,text/markdown" hidden/></div><textarea id="knowledge-content" name="content" maxlength="20000" rows="15" required spellcheck="false" placeholder="Escreva ou cole o conteúdo aprovado da sua empresa. Texto simples e Markdown são aceitos." ${source?.archived ? 'readonly' : ''}>${e(source?.content || '')}</textarea><div class="knowledge-content-help"><span>Texto ou Markdown · até 20.000 caracteres</span><span data-knowledge-chars>${String(source?.content || '').length.toLocaleString(getLocale())} / 20.000</span></div></div><section class="knowledge-preview" aria-label="Prévia segura do conteúdo"><div class="knowledge-preview-heading">${icon('document')} <strong>Prévia do texto</strong>${badge(i18nText('Texto seguro'), 'neutral')}</div><pre data-knowledge-preview tabindex="0">${e(source?.content || i18nText('O conteúdo da fonte aparecerá aqui.'))}</pre><p>Markdown aparece como texto. Links, imagens e HTML não são executados.</p></section></div><div class="knowledge-editor-conflict" hidden role="status"></div>${publication(source) ? i18nHtml`<details class="knowledge-publication"><summary>Ver conteúdo publicado · v${e(source.published.version)} ${icon('chevron')}</summary><p>${e(source.published.title || source.title)} · ${e(date(source.published.publishedAt))}</p><pre tabindex="0">${e(source.published.content || '')}</pre></details>` : ''}<div class="knowledge-editor-actions">${editorActions(source)}</div><div class="knowledge-archive-confirmation" hidden><p>Arquivar retira a publicação e interrompe novas consultas a esta fonte. Seu conteúdo permanece guardado para reativação.</p>${action(i18nText('Confirmar arquivamento'), 'knowledge-confirm-archive', source?.id)}${action(i18nText('Continuar editando'), 'knowledge-cancel-archive')}</div></div>`, i18nText('Salvar rascunho'));
    const form = sourceForm();
    if (source?.archived) form.querySelector('[type="submit"]').hidden = true;
    form.querySelector('.modal-actions [data-close-modal]').textContent = i18nText('Fechar editor');
  }

  function updateEditor(source) {
    if (!editor || editor.id && editor.id !== source.id) return;
    editor.id = source.id; editor.version = source.version; editor.source = source;
    const form = sourceForm(); if (!form) return;
    form.querySelector('.knowledge-editor-status').innerHTML = editorStatus(source);
    form.querySelector('.knowledge-editor-actions').innerHTML = editorActions(source);
    form.querySelector('.knowledge-archive-confirmation').hidden = true;
    form.querySelector('.knowledge-editor-conflict').hidden = true;
    for (const input of form.querySelectorAll('input[name],textarea')) input.readOnly = Boolean(source.archived);
    form.querySelector('[type="submit"]').hidden = Boolean(source.archived);
    form.querySelector('[data-action="knowledge-import-file"]')?.toggleAttribute('disabled', Boolean(source.archived));
    const published = publication(source), old = form.querySelector('.knowledge-publication');
    if (old) old.remove();
    if (published) form.querySelector('.knowledge-editor-actions').insertAdjacentHTML('beforebegin', i18nHtml`<details class="knowledge-publication"><summary>Ver conteúdo publicado · v${e(published.version)} ${icon('chevron')}</summary><p>${e(published.title || source.title)} · ${e(date(published.publishedAt))}</p><pre tabindex="0">${e(published.content || '')}</pre></details>`);
  }

  function inlineError(form, error) {
    if (!form?.isConnected) return;
    const box = form.querySelector('.form-error'); if (box) box.textContent = translateError(error.message);
    if (error.status === 409 && editor?.scope === scope() && form === sourceForm()) {
      const conflict = form.querySelector('.knowledge-editor-conflict'); conflict.hidden = false;
      conflict.innerHTML = i18nHtml`<strong>Esta fonte mudou em outra sessão.</strong><p>Seu texto continua no editor. Compare a versão salva antes de tentar novamente.</p>${action(i18nText('Comparar versão atual'), 'knowledge-compare', editor.id)}`;
    }
  }

  function assertEditor(target) {
    if (!target || target.scope !== scope() || !admin()) throw new Error(i18nText('A empresa mudou. Abra a fonte novamente no workspace atual.'));
    if (target.pending) throw new Error(i18nText('Aguarde a confirmação da alteração desta fonte.'));
  }

  function lockSourceFields(form, pending, archived = false) {
    if (!form?.isConnected) return;
    for (const field of form.querySelectorAll('input[name],textarea')) field.readOnly = pending || archived;
  }

  function blockedRun(run) { return { ...run, knowledgeReferences: [], knowledgeUnavailable: true }; }

  function beginAuthorityChange({ sourceId, agentId }) {
    const changeId = ++authorityChangeId, expectedScope = scope();
    const affectedAgents = new Set((state.tenant.agents || []).filter(agent => agent.id === agentId || sourceId && (agent.knowledgeGrants || []).some(grant => grant.sourceId === sourceId)).map(agent => agent.id));
    const affected = run => affectedAgents.has(run.agentId) || sourceId && [...(run.knowledgeReferences || []), ...(run.knowledgeSnapshot || [])].some(reference => reference.sourceId === sourceId);
    pendingAuthorityChanges.set(changeId, { scope: expectedScope, affected }); runSyncRequest++;
    state.tenant.runs = (state.tenant.runs || []).map(run => affected(run) ? blockedRun(run) : run);
    ctx.renderRuns?.();
    return changeId;
  }

  function repaintAgentCounts() {
    if (typeof document === 'undefined') return;
    for (const button of document.querySelectorAll?.('[data-action="knowledge-grants"]') || []) {
      const agent = (state.tenant.agents || []).find(item => item.id === button.dataset.id), count = button.querySelector('.knowledge-agent-count');
      if (agent && count) count.textContent = String((agent.knowledgeGrants || []).length);
    }
  }

  async function syncTenantRuns(expectedScope) {
    if (scope() !== expectedScope || !admin()) return false;
    const request = ++runSyncRequest;
    try {
      const tenant = await api(tenantApi(''));
      if (scope() !== expectedScope || !admin() || request !== runSyncRequest) return false;
      if (!Array.isArray(tenant.runs) || tenant.id && tenant.id !== state.tenant.id) return false;
      const pending = [...pendingAuthorityChanges.values()].filter(change => change.scope === expectedScope);
      state.tenant.runs = tenant.runs.map(run => pending.some(change => change.affected(run)) ? blockedRun(run) : run);
      if (Array.isArray(tenant.agents)) state.tenant.agents = tenant.agents.map(agent => ({ ...(state.tenant.agents || []).find(item => item.id === agent.id), ...agent }));
      repaintAgentCounts(); ctx.renderRuns?.();
      return true;
    } catch { return false; }
  }

  async function mutate(name, id) {
    const expectedScope = scope(), target = editor?.id === id && sourceForm() ? editor : null;
    if (target) { assertEditor(target); if (editorDirty()) throw new Error(i18nText('Salve o rascunho antes de alterar a publicação ou o arquivamento. Seu texto permanece no editor.')); }
    const source = target?.source || sources().find(item => item.id === id);
    if (!source) throw new Error(i18nText('Atualize a biblioteca para encontrar esta fonte.'));
    const form = target ? sourceForm() : null;
    if (target) { target.pending = true; form.setAttribute('aria-busy', 'true'); lockSourceFields(form, true); }
    const changeId = beginAuthorityChange({ sourceId: id });
    try {
      const result = await api(tenantApi(`knowledge/sources/${encodeURIComponent(id)}/${name}`), { method: 'POST', body: JSON.stringify({ version: target?.version ?? source.version }) });
      pendingAuthorityChanges.delete(changeId);
      if (scope() !== expectedScope || !admin()) return;
      upsert(result);
      if (target && editor === target && form === sourceForm()) { target.saved = savedFields(result); updateEditor(result); }
      const synced = await syncTenantRuns(expectedScope);
      if (scope() !== expectedScope || !admin()) return;
      const messages = i18nLabels({ publish: 'Fonte publicada. Revise as fontes autorizadas de cada agente.', unpublish: 'Publicação retirada. O rascunho foi preservado.', archive: 'Fonte arquivada. O conteúdo permanece guardado.', reactivate: 'Fonte reativada como rascunho. Revise e publique novamente.' });
      toast(synced ? messages[name] : i18nTemplate`${messages[name]} Os rascunhos anteriores continuam bloqueados até atualizar o workspace.`, !synced);
    } catch (error) {
      pendingAuthorityChanges.delete(changeId);
      await syncTenantRuns(expectedScope);
      if (scope() === expectedScope) inlineError(form, error); throw error;
    } finally { pendingAuthorityChanges.delete(changeId); if (target) target.pending = false; if (form?.isConnected) { form.removeAttribute('aria-busy'); lockSourceFields(form, false, Boolean(target?.source?.archived)); } }
  }

  async function openGrants(agentId) {
    const expectedScope = scope(), sequence = ++modalRequest;
    const agent = state.tenant?.agents.find(item => item.id === agentId);
    if (!agent || agent.provider !== 'hermes') throw new Error(i18nText('Escolha um copiloto gerenciado desta empresa.'));
    const [sourceData, grantData] = await Promise.all([api(tenantApi('knowledge/sources?archived=true')), api(tenantApi(`agents/${encodeURIComponent(agentId)}/knowledge-grants`))]);
    if (scope() !== expectedScope || !admin() || sequence !== modalRequest) return;
    state.knowledgeSources = (sourceData.sources || []).map(metadata); state.knowledgeLoaded = true; loadedScope = expectedScope;
    const entries = sources().filter(source => !source.archived && publication(source));
    const valid = source => (grantData.grants || []).some(grant => grant.sourceId === source.id && grant.publicationVersion === source.published.version && grant.publicationHash === source.published.hash);
    const outdated = (grantData.grants || []).filter(grant => !entries.some(source => valid(source) && source.id === grant.sourceId)).length;
    editor = null; previewEditor = null; grantsEditor = { scope: expectedScope, agentId, version: grantData.version, entries };
    formModal(i18nText('Fontes autorizadas para o agente'), i18nTemplate`${agent.name} · ${state.tenant.name}. Cada seleção autoriza a publicação exibida abaixo.`, 'knowledge-grants', i18nHtml`<div class="knowledge-grants">${outdated ? i18nHtml`<p class="knowledge-grants-note" role="status">${outdated} ${outdated === 1 ? i18nText('autorização precisa') : i18nText('autorizações precisam')} de revisão porque a publicação mudou ou foi retirada. Selecione novamente as versões atuais.</p>` : ''}<p class="knowledge-form-note">Rascunhos e fontes arquivadas ficam fora das consultas. Uma nova publicação exige revisar esta seleção.</p>${entries.length ? i18nHtml`<fieldset><legend>Publicações disponíveis</legend>${entries.map((source, index) => i18nHtml`<label class="knowledge-grant"><input type="checkbox" name="knowledgeSource" value="${index}" ${valid(source) ? 'checked' : ''}/><span><strong>${e(source.published.title || source.title)}</strong><small>${e(source.category || i18nText('Sem categoria'))} · publicação v${e(source.published.version)}</small><code>SHA ${e(source.published.hash?.slice(0, 12))}</code>${source.draftChanged ? i18nMarkup('<small>Existe um rascunho alterado. A seleção usa o conteúdo já publicado.</small>') : ''}</span></label>`).join('')}</fieldset>` : i18nHtml`<div class="knowledge-grants-empty">${icon('document')}<h3>Publique a primeira fonte desta empresa.</h3><p>Depois, volte aqui para autorizar o conteúdo para ${e(agent.name)}.</p></div>`}</div>`, i18nText('Salvar fontes autorizadas'));
  }

  function openPreview() {
    const agents = (state.tenant?.agents || []).filter(agent => agent.provider === 'hermes');
    modalRequest++; editor = null; grantsEditor = null; previewEditor = { scope: scope(), request: 0 };
    formModal(i18nText('Testar busca nas fontes autorizadas'), i18nTemplate`${state.tenant.name} · confira os trechos disponíveis para um agente antes do atendimento.`, 'knowledge-preview', i18nHtml`<div class="knowledge-search-test"><label>Agente<select name="agentId" required>${agents.map(agent => `<option value="${e(agent.id)}">${e(agent.name)}</option>`).join('') || i18nMarkup('<option value="">Nenhum copiloto gerenciado nesta empresa</option>')}</select></label><label>O que você quer consultar?<textarea name="query" maxlength="500" rows="3" required placeholder="Ex.: qual é o prazo para solicitar uma troca?"></textarea><small>A busca consulta somente as publicações autorizadas ao agente selecionado.</small></label><div class="knowledge-search-results" aria-live="polite"><p>Digite uma pergunta ou termos presentes nas suas fontes.</p></div></div>`, i18nText('Buscar nas fontes'));
  }

  function referenceMarkup(reference) {
    return i18nHtml`<article class="knowledge-reference"><div><strong>${e(reference.title || i18nText('Fonte autorizada'))}</strong><span>Publicação v${e(reference.publicationVersion)}${reference.chunkId ? i18nTemplate` · trecho ${e(reference.chunkId)}` : ''}</span></div><p>${e(reference.excerpt || '')}</p><small>Fonte ${e(reference.sourceId)}${reference.publicationHash ? ` · SHA ${e(reference.publicationHash.slice(0, 12))}` : ''}</small></article>`;
  }

  function searchResult(result) {
    if (result.state === 'matched' && result.references?.length) return i18nHtml`<div class="knowledge-search-result-heading">${badge(i18nText('Correspondência encontrada'), 'green')}<span>${result.references.length} ${result.references.length === 1 ? i18nText('trecho recuperado') : i18nText('trechos recuperados')}</span></div>${result.references.map(referenceMarkup).join('')}<p class="knowledge-form-note">Esses trechos estão disponíveis como contexto. O teste de busca não gera nem envia uma resposta.</p>`;
    if (result.state === 'not_configured') return i18nHtml`<div class="knowledge-search-no-match">${icon('shield')}<strong>Este agente não tem publicações válidas autorizadas.</strong><p>Publique uma fonte e revise a seleção em Fontes autorizadas do agente.</p></div>`;
    return i18nHtml`<div class="knowledge-search-no-match">${icon('search')}<strong>Nenhum trecho corresponde a esta busca.</strong><p>Tente palavras presentes no conteúdo publicado ou revise as fontes autorizadas ao agente.</p></div>`;
  }

  function runReferences(run) {
    if (run.knowledgeUnavailable) return i18nMarkup('<p class="knowledge-run-no-match">As fontes desta execução não estão mais disponíveis. Prepare um novo rascunho.</p>');
    if (run.knowledgeState === 'no_match') return i18nMarkup('<p class="knowledge-run-no-match">Busca nas fontes autorizadas sem correspondência para esta execução.</p>');
    if (run.knowledgeState !== 'matched' || !run.knowledgeReferences?.length) return '';
    const references = run.knowledgeReferences;
    return i18nHtml`<details class="knowledge-run-references"><summary>${icon('document')} Fontes consultadas · ${references.length} ${references.length === 1 ? i18nText('trecho') : i18nText('trechos')} ${icon('chevron')}</summary>${references.map(referenceMarkup).join('')}<p>Trechos recuperados para o contexto desta execução. Revise o rascunho e as referências antes do envio.</p></details>`;
  }

  function handleInput(event) {
    const input = event.target;
    if (input.id === 'knowledge-search') { search = input.value; repaintLibrary(); return true; }
    const form = input.closest?.('form');
    if (form?.dataset.dialogForm === 'knowledge-source' && editor?.scope === scope()) {
      if (input.name === 'content') {
        form.querySelector('[data-knowledge-preview]').textContent = input.value || i18nText('O conteúdo da fonte aparecerá aqui.');
        form.querySelector('[data-knowledge-chars]').textContent = `${input.value.length.toLocaleString(getLocale())} / 20.000`;
      }
      form.querySelector('.form-error').textContent = '';
      return true;
    }
    if (form?.dataset.dialogForm === 'knowledge-preview') { previewEditor && previewEditor.request++; form.querySelector('.knowledge-search-results').innerHTML = i18nMarkup('<p>Envie a busca para consultar este conteúdo.</p>'); return true; }
    return false;
  }

  function handleChange(event) {
    const input = event.target;
    if (input.id === 'knowledge-filter') { filter = Object.hasOwn(names, input.value) ? input.value : 'all'; repaintLibrary(); return true; }
    if (input.matches?.('[data-knowledge-file]')) {
      const file = input.files?.[0], form = input.closest('form'), target = editor, expectedScope = scope(); input.value = '';
      if (!file) return true;
      (async () => {
        assertEditor(target);
        if (!/\.(txt|md)$/i.test(file.name) || file.size > 64 * 1024) throw new Error(i18nText('Escolha um arquivo TXT ou MD de até 64 KiB.'));
        const text = await file.text();
        if (text.length > 20000 || text.includes('\u0000')) throw new Error(i18nText('Use texto simples com até 20.000 caracteres.'));
        if (scope() !== expectedScope || editor !== target || form !== sourceForm() || !form.isConnected) return;
        form.elements.content.value = text; handleInput({ target: form.elements.content });
        toast(i18nText('Texto importado para o editor. Revise e salve o rascunho.'));
      })().catch(error => { if (scope() === expectedScope && editor === target) inlineError(form, error); });
      return true;
    }
    if (input.closest?.('form')?.dataset.dialogForm === 'knowledge-preview') return handleInput(event);
    return false;
  }

  async function act(name, id) {
    if (!name.startsWith('knowledge-')) return false;
    if (!admin()) throw new Error(i18nText('A base de conhecimento pertence ao administrador do workspace.'));
    if (name === 'knowledge-retry') { try { await load({ force: true }); } catch { /* Persistent local status owns read recovery. */ } return true; }
    if (name === 'knowledge-new') { if (sources().length >= 50) throw new Error(i18nText('Esta empresa já tem 50 fontes. Reutilize uma fonte existente.')); await openSource(); return true; }
    if (name === 'knowledge-edit') { await openSource(id); return true; }
    if (name === 'knowledge-grants') { await openGrants(id); return true; }
    if (name === 'knowledge-preview') { openPreview(); return true; }
    if (name === 'knowledge-clear-filters') { search = ''; filter = 'all'; document.querySelector('#knowledge-search').value = ''; document.querySelector('#knowledge-filter').value = 'all'; repaintLibrary(); return true; }
    if (name === 'knowledge-import-file') { assertEditor(editor); sourceForm()?.querySelector('[data-knowledge-file]').click(); return true; }
    if (name === 'knowledge-archive' || name === 'knowledge-cancel-archive') {
      assertEditor(editor); const confirmation = sourceForm()?.querySelector('.knowledge-archive-confirmation'); if (confirmation) { confirmation.hidden = name === 'knowledge-cancel-archive'; if (!confirmation.hidden) confirmation.querySelector('button')?.focus(); } return true;
    }
    if (name === 'knowledge-compare') {
      const target = editor, expectedScope = scope(); assertEditor(target);
      const current = await api(tenantApi(`knowledge/sources/${encodeURIComponent(target.id)}`));
      if (scope() !== expectedScope || editor !== target || !sourceForm()) return true;
      target.current = current; const conflict = sourceForm().querySelector('.knowledge-editor-conflict'); conflict.hidden = false;
      conflict.innerHTML = i18nHtml`<strong>Versão salva atualmente · v${e(current.version)}</strong><p>${e(current.title)} · ${e(current.category || i18nText('Sem categoria'))}${current.archived ? i18nText(' · fonte arquivada') : ''}</p><pre tabindex="0">${e(current.content || '')}</pre><p>Seu texto permanece no editor. Após comparar, você pode usar esta versão como base e salvar sua revisão.</p>${action(i18nText('Usar versão atual como base'), 'knowledge-rebase', target.id, false, Boolean(current.archived))}`;
      return true;
    }
    if (name === 'knowledge-rebase') {
      assertEditor(editor); if (!editor.current || editor.current.archived) throw new Error(i18nText('Compare a versão atual antes de continuar.'));
      editor.version = editor.current.version; editor.source = editor.current; editor.saved = savedFields(editor.current);
      const current = editor.current; updateEditor(current); sourceForm().querySelector('.form-error').textContent = '';
      toast(i18nText('Versão atual adotada como base. Seu texto foi preservado; revise e salve.')); return true;
    }
    const mutation = { 'knowledge-publish': 'publish', 'knowledge-unpublish': 'unpublish', 'knowledge-confirm-archive': 'archive', 'knowledge-reactivate': 'reactivate' }[name];
    if (mutation) { await mutate(mutation, id); return true; }
    return false;
  }

  async function submit(form) {
    const type = form.dataset.dialogForm;
    if (!['knowledge-source', 'knowledge-grants', 'knowledge-preview'].includes(type)) return false;
    if (!admin()) throw new Error(i18nText('A base de conhecimento pertence ao administrador do workspace.'));
    const expectedScope = scope();
    if (type === 'knowledge-source') {
      const target = editor; assertEditor(target);
      if (target.source?.archived) throw new Error(i18nText('Reative a fonte antes de editar o conteúdo.'));
      const fields = sourceFields(form);
      if (!fields.title || fields.title.length > 120 || fields.category.length > 80 || !fields.content.trim() || fields.content.length > 20000) throw new Error(i18nText('Informe título de até 120 caracteres, categoria de até 80 e conteúdo de até 20.000 caracteres.'));
      const payload = { ...(target.id ? { version: target.version } : {}), ...fields };
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 64 * 1024) throw new Error(i18nText('O conteúdo excede 64 KiB. Reduza o texto antes de salvar.'));
      target.pending = true; form.setAttribute('aria-busy', 'true'); lockSourceFields(form, true);
      try {
        const result = await api(tenantApi(`knowledge/sources${target.id ? `/${encodeURIComponent(target.id)}` : ''}`), { method: target.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
        if (scope() !== expectedScope || !admin()) return true;
        upsert(result);
        if (editor === target && form === sourceForm()) { target.saved = savedFields(result); updateEditor(result); }
        toast(i18nText('Rascunho salvo. Publique a revisão quando estiver pronta.'));
      } catch (error) { if (scope() === expectedScope) inlineError(form, error); throw error; }
      finally { target.pending = false; if (form.isConnected) { form.removeAttribute('aria-busy'); lockSourceFields(form, false, Boolean(target.source?.archived)); } }
    } else if (type === 'knowledge-grants') {
      const target = grantsEditor;
      if (!target || target.scope !== expectedScope) throw new Error(i18nText('A empresa mudou. Abra as fontes autorizadas novamente.'));
      const indexes = new FormData(form).getAll('knowledgeSource').map(Number);
      if (indexes.some(index => !Number.isInteger(index) || !target.entries[index])) throw new Error(i18nText('Confira as fontes selecionadas.'));
      const grants = indexes.map(index => { const source = target.entries[index]; return { sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash }; });
      const changeId = beginAuthorityChange({ agentId: target.agentId });
      try {
        const result = await api(tenantApi(`agents/${encodeURIComponent(target.agentId)}/knowledge-grants`), { method: 'PUT', body: JSON.stringify({ version: target.version, grants }) });
        pendingAuthorityChanges.delete(changeId);
        if (scope() !== expectedScope || !admin()) return true;
        const agent = state.tenant.agents.find(item => item.id === target.agentId);
        if (agent) { agent.version = result.version; agent.knowledgeGrants = result.grants || grants; }
        const synced = await syncTenantRuns(expectedScope);
        if (scope() !== expectedScope || !admin()) return true;
        repaintAgentCounts();
        if (grantsEditor === target && form.isConnected) { grantsEditor = null; document.querySelector('#modal').close(); }
        toast(synced ? i18nText('Fontes autorizadas salvas para este agente.') : i18nText('Fontes autorizadas salvas. Os rascunhos anteriores continuam bloqueados até atualizar o workspace.'), !synced);
      } catch (error) { pendingAuthorityChanges.delete(changeId); await syncTenantRuns(expectedScope); throw error; }
      finally { pendingAuthorityChanges.delete(changeId); }
    } else {
      const target = previewEditor, values = new FormData(form), agentId = String(values.get('agentId') || ''), query = String(values.get('query') || '').trim();
      if (!target || target.scope !== expectedScope) throw new Error(i18nText('A empresa mudou. Abra o teste de busca novamente.'));
      if (!agentId || !query || query.length > 500) throw new Error(i18nText('Escolha um agente e escreva uma busca de até 500 caracteres.'));
      const request = ++target.request, results = form.querySelector('.knowledge-search-results'); results.innerHTML = i18nMarkup('<p role="status">Consultando as publicações autorizadas…</p>');
      try {
        const result = await api(tenantApi('knowledge/search'), { method: 'POST', body: JSON.stringify({ agentId, query }) });
        if (scope() !== expectedScope || !admin() || previewEditor !== target || target.request !== request || !form.isConnected) return true;
        results.innerHTML = searchResult(result);
      } catch (error) { if (scope() === expectedScope && previewEditor === target && target.request === request && form.isConnected) results.innerHTML = i18nMarkup('<p>Não foi possível concluir a busca. Seu texto permanece no formulário.</p>'); throw error; }
    }
    return true;
  }

  if (typeof document !== 'undefined') document.querySelector('#modal')?.addEventListener('close', () => { modalRequest++; editor = null; grantsEditor = null; previewEditor = null; });
  return latestScreen = { panel, load, reset, act, submit, runReferences, handleInput, handleChange };
}
