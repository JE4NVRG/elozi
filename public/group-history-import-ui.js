import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\p{Cc}]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const limits = [50,100,200];
const running = new Set(['pending','requesting','importing']);
const terminal = new Set(['completed','unavailable','failed','cancelled']);
const stateLabels = i18nLabels({idle:'Pronto para buscar',need_anchor:'Uma mensagem do WhatsApp é necessária',pending:'Pedido na fila',requesting:'Solicitando ao WhatsApp',importing:'Importando mensagens',completed:'Busca concluída',unavailable:'Histórico indisponível',failed:'Busca não concluída',cancelled:'Pedido cancelado'});
const invalid = () => { throw Object.assign(new Error('invalid-history-import-response'), {code:'invalid-history-import-response'}); };

function statusDTO(input, item) {
  if (!object(input) || input.tenantId !== item.tenantId || input.conversationId !== item.conversationId || input.channelId !== item.channelId || !integer(input.version) || input.version < 1 || input.version < (item.status?.version || 1) || !object(input.anchor) || typeof input.anchor.available !== 'boolean' || !Object.hasOwn(stateLabels,input.state)) invalid();
  let job = null;
  if (input.job !== null) {
    const value = input.job, counters = value?.counters;
    if (!object(value) || !text(value.id,120) || !uuid(value.commandId) || !limits.includes(value.requestedLimit) || !(running.has(value.state) || terminal.has(value.state)) || input.state !== value.state || !iso(value.createdAt) || !iso(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || !object(counters) || ['imported','duplicates','excluded','requested'].some(key => !integer(counters[key]) || counters[key] > value.requestedLimit) || counters.imported + counters.duplicates + counters.excluded > counters.requested) invalid();
    if (item.intent && (value.commandId !== item.intent.commandId || value.requestedLimit !== item.intent.limit)) invalid();
    const prior = item.status?.job;
    if (prior?.commandId === value.commandId && (value.id !== prior.id || value.requestedLimit !== prior.requestedLimit || Date.parse(value.updatedAt) < Date.parse(prior.updatedAt) || terminal.has(prior.state) && value.state !== prior.state || ['imported','duplicates','excluded','requested'].some(key => counters[key] < prior.counters[key]))) invalid();
    job = {id:value.id,commandId:value.commandId,requestedLimit:value.requestedLimit,state:value.state,counters:{imported:counters.imported,duplicates:counters.duplicates,excluded:counters.excluded,requested:counters.requested},createdAt:value.createdAt,updatedAt:value.updatedAt};
  } else if (!['idle','need_anchor'].includes(input.state)) invalid();
  if (input.state === 'need_anchor' && (input.anchor.available || job) || input.state === 'idle' && !input.anchor.available) invalid();
  return {tenantId:input.tenantId,conversationId:input.conversationId,channelId:input.channelId,version:input.version,anchor:{available:input.anchor.available},state:input.state,job};
}

/** Acompanhamento humano de uma busca limitada; fechar a janela não cancela o job remoto. */
export function createGroupHistoryImportUI({api,openModal,getModal = () => globalThis.document?.querySelector('#modal'),getContext,toast = () => {},onFinished = () => {},escape: e = escapeHTML,setTimer = globalThis.setTimeout,clearTimer = globalThis.clearTimeout,pollMs = 2000,maxPolls = 30,newCommandId = () => globalThis.crypto.randomUUID()} = {}) {
  let current = null, sequence = 0, controller = null, timer = null;
  const observed = new WeakSet(), intents = new Map(), notified = new Set();
  const readContext = () => {
    const value = getContext?.();
    if (!object(value)) return null;
    return {active:value.active,workspaceId:value.workspaceId,tenantId:value.tenantId,userId:value.userId,authorityKey:value.authorityKey,canManageChannels:value.canManageChannels,canReadInbox:value.canReadInbox,supportGrantId:value.supportGrantId || null,kind:value.kind,csrfToken:value.csrfToken || '',boot:value.boot,session:value.session};
  };
  const allowed = c => Boolean(c?.active === true && text(c.workspaceId,120) && text(c.tenantId,120) && text(c.userId,120) && text(c.authorityKey,4096) && c.canManageChannels === true && c.canReadInbox === true && c.kind === 'human' && !c.supportGrantId && object(c.boot) && object(c.session) && typeof c.csrfToken === 'string');
  const key = c => JSON.stringify([c.active,c.workspaceId,c.tenantId,c.userId,c.authorityKey,c.canManageChannels,c.canReadInbox,c.supportGrantId,c.kind,c.csrfToken]);
  const panel = () => getModal()?.querySelector?.('[data-group-history-import-panel]');
  const owns = item => Boolean(item && getModal()?.open !== false && panel()?.dataset?.groupHistoryImportToken === item.token);
  const fresh = item => { const c = readContext(); return Boolean(item && current === item && allowed(c) && key(c) === item.key && c.boot === item.boot && c.session === item.session); };
  function clearPoll() { if (timer !== null) clearTimer(timer); timer = null; }
  function release({close = false} = {}) {
    const previous = current, owned = owns(previous);
    sequence++; clearPoll(); controller?.abort(); controller = null; current = null;
    if (previous && panel()?.dataset?.groupHistoryImportToken === previous.token) panel().innerHTML = '';
    if (close && owned) getModal()?.close?.();
  }
  function shown(item) {
    if (!fresh(item)) { if (current === item) release({close:true}); return false; }
    if (!owns(item)) { if (current === item) release(); return false; }
    return true;
  }
  function observeDialog(modal) {
    if (!modal?.addEventListener || observed.has(modal)) return;
    observed.add(modal);
    modal.addEventListener('close', () => {
      // Um close anterior pode chegar depois que o mesmo diálogo já foi reaberto.
      if (getModal() === modal && modal.open === false && current && panel()?.dataset?.groupHistoryImportToken === current.token) release();
    });
  }
  const button = (item, action, label, {disabled = false,primary = false} = {}) => `<button type="button" class="button${primary ? ' primary' : ''}" data-group-history-import-action="${action}" data-group-history-import-token="${item.token}"${disabled ? ' disabled' : ''}>${label}</button>`;
  const format = value => value.toLocaleString(getLocale());
  function markup(item) {
    const status = item.status, job = status?.job && (!item.intent || status.job.commandId === item.intent.commandId) ? status.job : null, uncertain = Boolean(item.intent && !job);
    const busy = item.loading || item.sending || running.has(status?.state);
    const disabled = busy || !status || !status.anchor.available || item.needsRefresh || uncertain;
    const state = item.sending ? i18nText('Enviando pedido de busca') : uncertain ? i18nText('Pedido ainda não confirmado') : item.loading && !status ? i18nText('Consultando histórico disponível') : stateLabels[status?.state] || i18nText('Não foi possível consultar');
    const choices = i18nHtml`<fieldset class="group-history-import-limit"><legend>Até quantas mensagens buscar?</legend><div class="group-history-import-choices">${limits.map(limit => `<button type="button" class="button${item.limit === limit ? ' primary' : ''}" aria-pressed="${item.limit === limit}" data-group-history-import-action="limit" data-group-history-import-limit="${limit}" data-group-history-import-token="${item.token}"${disabled ? ' disabled' : ''}>${limit}</button>`).join('')}</div><small>Busca em páginas de até 50 mensagens, limitada ao total escolhido.</small></fieldset>`;
    const stats = job ? i18nHtml`<dl class="group-history-import-counts">${[['imported',i18nText('Importadas')],['duplicates',i18nText('Já existentes')],['excluded',i18nText('Não incluídas')],['requested',i18nText('Solicitadas')]].map(([name,label]) => `<div><dt>${label}</dt><dd data-history-import-metric="${name}">${format(job.counters[name])}</dd></div>`).join('')}</dl><p class="group-history-import-meta">Limite deste pedido: ${job.requestedLimit} mensagens. Os números correspondem a esta busca.</p>` : '';
    // A direct conversation (selection.kind 'direct') uses its own copy; groups keep theirs.
    const anchor = status?.state !== 'need_anchor' ? '' : item.direct ? i18nMarkup('<div class="group-history-import-notice"><strong>Receba ou envie uma nova mensagem nesta conversa.</strong><p>A busca começa numa mensagem recebida ou enviada depois desta versão, com os dados confirmados pelo WhatsApp. Depois, clique em “Verificar progresso”.</p></div>') : i18nMarkup('<div class="group-history-import-notice"><strong>Receba ou envie uma nova mensagem no grupo.</strong><p>A busca precisa de uma mensagem original recebida ou enviada, com os dados confirmados pelo WhatsApp. Depois, clique em “Verificar progresso”. Apenas selecionar o grupo ou registrar uma mensagem localmente não cria essa referência.</p></div>');
    const result = status?.state === 'completed' ? (item.direct ? i18nMarkup('<p class="group-history-import-notice">A busca terminou dentro do limite deste pedido. Isso não confirma que todo o histórico desta conversa foi recuperado.</p>') : i18nMarkup('<p class="group-history-import-notice">A busca terminou dentro do limite deste pedido. Isso não confirma que todo o histórico do grupo foi recuperado.</p>')) : status?.state === 'unavailable' ? i18nMarkup('<p class="group-history-import-notice">O WhatsApp não disponibilizou histórico suficiente ou não respondeu a tempo. Nenhuma recuperação completa foi confirmada.</p>') : status?.state === 'failed' ? i18nMarkup('<p class="group-history-import-notice">A busca não foi concluída. Verifique a conexão em Canais antes de fazer um novo pedido explícito.</p>') : status?.state === 'cancelled' ? i18nMarkup('<p class="group-history-import-notice">O servidor informa que este pedido foi cancelado. Fechar esta janela apenas para o acompanhamento na tela.</p>') : '';
    const uncertainNote = uncertain ? i18nMarkup('<p class="group-history-import-notice" role="alert">A confirmação deste pedido ainda não chegou. Use “Verificar progresso” para consultar o mesmo pedido. A busca não será repetida automaticamente.</p>') : '';
    const monitoring = item.pollsStopped && running.has(status?.state) ? i18nMarkup('<p class="group-history-import-notice">O acompanhamento automático foi pausado. O pedido pode continuar no servidor; clique em “Verificar progresso” para consultar.</p>') : '';
    return i18nHtml`<div class="group-history-import-heading"><span class="eyebrow">Histórico do WhatsApp</span><h3>${e(item.title)}</h3><p>Traga mensagens anteriores para o histórico desta empresa, quando o WhatsApp as disponibilizar.</p></div><div class="group-history-import-status" role="status" aria-live="polite"><strong>${e(state)}</strong>${running.has(status?.state) ? i18nMarkup('<span>A consulta pode levar alguns instantes.</span>') : ''}</div>${stats}${anchor}${result}${uncertainNote}${monitoring}${choices}<ul class="group-history-import-notes"><li>A busca começa pelos textos; mídias antigas podem não estar disponíveis.</li><li>Não há garantia de recuperar todas as mensagens anteriores.</li><li>A importação preserva o atendimento: não reabre, não atribui responsável e não aciona automações.</li></ul>${item.error ? `<p class="form-error" role="alert">${e(translateError(item.error))}</p>` : ''}<div class="modal-actions group-history-import-actions">${button(item,'close',i18nText('Fechar'))}${button(item,'refresh',i18nText('Verificar progresso'),{disabled:item.loading || item.sending})}${button(item,'start',job && terminal.has(job.state) ? i18nText('Fazer nova busca') : i18nText('Buscar histórico antigo'),{primary:true,disabled})}</div><p class="group-history-import-meta">Fechar a janela interrompe o acompanhamento aqui, sem cancelar o pedido no servidor.</p>`;
  }
  function paint(item) {
    if (!shown(item)) return false;
    const host = panel(), doc = globalThis.document, focused = doc?.activeElement;
    const ownFocus = host.contains?.(focused) && focused?.dataset?.groupHistoryImportToken === item.token;
    const action = ownFocus ? focused.dataset.groupHistoryImportAction : null, limit = ownFocus ? focused.dataset.groupHistoryImportLimit : null;
    host.innerHTML = markup(item); host.setAttribute?.('aria-busy',String(Boolean(item.loading || item.sending)));
    if (action && (doc.activeElement === doc.body || doc.activeElement === focused)) {
      const selector = `[data-group-history-import-action="${action}"]${limit ? `[data-group-history-import-limit="${limit}"]` : ''}`, next = host.querySelector?.(selector);
      if (next && !next.disabled) next.focus?.({preventScroll:true});
      else item.restoreFocus = {action,limit};
    } else if (item.restoreFocus && doc?.activeElement === doc?.body) {
      const focus = item.restoreFocus, next = host.querySelector?.(`[data-group-history-import-action="${focus.action}"]${focus.limit ? `[data-group-history-import-limit="${focus.limit}"]` : ''}`);
      if (next && !next.disabled) { next.focus?.({preventScroll:true}); item.restoreFocus = null; }
    } else item.restoreFocus = null;
    return true;
  }
  function rememberResult(item, result) {
    item.status = result;
    if (result.job) {
      item.limit = result.job.requestedLimit;
      if (terminal.has(result.job.state)) { intents.delete(item.intentKey); item.intent = null; }
      if (result.job.state === 'completed') {
        const receipt = `${item.intentKey}:${result.job.id}`;
        if (!notified.has(receipt)) {
          notified.add(receipt); if (notified.size > 100) notified.delete(notified.values().next().value);
          if (shown(item)) {
            const notice = () => { if (shown(item)) toast(item.direct ? i18nText('A busca terminou. Atualize a conversa para conferir as mensagens anteriores.') : i18nText('A busca terminou. Atualize o histórico do grupo para conferir as mensagens importadas.'),true); };
            try { const completion = onFinished({tenantId:item.tenantId,conversationId:item.conversationId,channelId:item.channelId,jobId:result.job.id,...result.job.counters}); Promise.resolve(completion).catch(notice); } catch { notice(); }
          }
        }
      }
    }
  }
  function schedulePoll(item) {
    clearPoll();
    if (!shown(item) || !running.has(item.status?.state)) return;
    if (item.polls >= maxPolls) { item.pollsStopped = true; paint(item); return; }
    timer = setTimer(() => { timer = null; if (!shown(item)) return; item.polls++; void load(item,{automatic:true}); },Math.max(250,pollMs));
    timer?.unref?.();
  }
  const pathFor = item => `/api/tenants/${encodeURIComponent(item.tenantId)}/conversations/${encodeURIComponent(item.conversationId)}/${item.direct ? 'history-import' : 'group-history-import'}`;
  const headers = (item, writing = false) => ({'X-Elozi-Workspace':item.workspaceId,...(writing ? {'Content-Type':'application/json'} : {}),...(item.csrfToken ? {'X-CSRF-Token':item.csrfToken} : {})});
  const errorStatus = error => Number(error?.status || error?.statusCode || 0);
  function fail(item, error, writing) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) { release({close:true}); toast(i18nText('O acesso à importação mudou. Abra o painel novamente com a empresa e as permissões corretas.'),true); return; }
    const definiteRejection = writing && [400,404,409,422].includes(status);
    if (definiteRejection) { intents.delete(item.intentKey); item.intent = null; }
    item.needsRefresh = true;
    item.error = status === 409 ? i18nText('O grupo ou a conexão mudou. Verifique o progresso para consultar a revisão atual antes de iniciar outra busca.') : status === 404 ? i18nText('Este grupo não está mais disponível nesta empresa.') : status === 400 || status === 422 ? i18nText('O servidor não aceitou este pedido. Verifique o grupo e consulte o progresso antes de tentar novamente.') : error?.code === 'invalid-history-import-response' ? i18nText('O servidor não confirmou dados consistentes deste grupo. Nenhuma contagem desta resposta foi aplicada.') : writing ? i18nText('A confirmação do pedido não chegou. Verifique o progresso; não faremos outro pedido automaticamente.') : i18nText('Não foi possível consultar o progresso agora. Tente verificar novamente.');
  }
  async function load(item,{automatic = false} = {}) {
    if (!shown(item) || item.loading || item.sending) return false;
    clearPoll(); controller?.abort(); const ownController = new AbortController(), ticket = ++sequence; controller = ownController;
    item.loading = true; item.error = ''; if (!automatic) { item.polls = 0; item.pollsStopped = false; } paint(item);
    try {
      const query = item.intent ? `?commandId=${encodeURIComponent(item.intent.commandId)}` : '';
      const value = await api(pathFor(item)+query,{method:'GET',headers:headers(item),signal:ownController.signal});
      if (ticket !== sequence || !shown(item)) return false;
      const result = statusDTO(value,item); item.needsRefresh = false; rememberResult(item,result); return true;
    } catch (error) { if (ticket === sequence && shown(item)) fail(item,error,false); return false; }
    finally { if (ticket === sequence && shown(item)) { item.loading = false; controller = null; paint(item); if (!item.error) schedulePoll(item); } }
  }
  async function start(item) {
    if (!shown(item) || item.loading || item.sending || item.needsRefresh || item.intent || !item.status?.anchor.available || running.has(item.status.state) || !limits.includes(item.limit)) return false;
    if (intents.size >= 20 && !intents.has(item.intentKey)) { item.error = i18nText('Há pedidos sem confirmação nesta sessão. Verifique o progresso deles antes de iniciar outra busca.'); paint(item); return false; }
    let commandId;
    try { commandId = newCommandId(); if (!uuid(commandId)) throw new Error(); } catch { item.error = i18nText('Não foi possível identificar este pedido. Atualize a página antes de tentar novamente.'); paint(item); return false; }
    item.intent = {commandId,limit:item.limit}; intents.set(item.intentKey,item.intent);
    clearPoll(); controller?.abort(); const ownController = new AbortController(), ticket = ++sequence; controller = ownController;
    item.sending = true; item.error = ''; item.polls = 0; item.pollsStopped = false; paint(item);
    try {
      const value = await api(pathFor(item),{method:'POST',headers:headers(item,true),signal:ownController.signal,body:JSON.stringify({version:item.status.version,limit:item.limit,commandId})});
      if (ticket !== sequence || !shown(item)) return false;
      const result = statusDTO(value,item);
      if (!result.job) invalid();
      item.needsRefresh = false; rememberResult(item,result); return true;
    } catch (error) { if (ticket === sequence && shown(item)) fail(item,error,true); return false; }
    finally { if (ticket === sequence && shown(item)) { item.sending = false; controller = null; paint(item); if (!item.error) schedulePoll(item); } }
  }
  async function open(selection) {
    release({close:true}); const c = readContext();
    if (!allowed(c) || !object(selection) || !text(selection.conversationId,120) || !text(selection.channelId,120) || !text(selection.title)) return false;
    const contextKey = key(c), intentKey = JSON.stringify([contextKey,selection.conversationId,selection.channelId]);
    const item = {token:`history-import-${++sequence}`,key:contextKey,intentKey,boot:c.boot,session:c.session,workspaceId:c.workspaceId,tenantId:c.tenantId,conversationId:selection.conversationId,channelId:selection.channelId,title:selection.title,csrfToken:c.csrfToken,intent:intents.get(intentKey) || null,status:null,limit:50,loading:false,sending:false,needsRefresh:false,error:'',polls:0,pollsStopped:false,restoreFocus:null};
    if (item.intent) item.limit = item.intent.limit;
    item.direct = selection.kind === 'direct';
    current = item;
    openModal(item.direct ? i18nText('Buscar mensagens anteriores') : i18nText('Importar histórico antigo'),item.direct ? i18nText('Busca limitada para esta conversa do WhatsApp') : i18nText('Busca limitada para este grupo do WhatsApp'),`<div class="group-history-import-panel" data-group-history-import-panel data-group-history-import-token="${item.token}">${markup(item)}</div>`);
    observeDialog(getModal()); return load(item);
  }
  async function handleAction(node) {
    const item = current;
    if (!shown(item) || node?.isConnected === false || !panel()?.contains?.(node) || node?.dataset?.groupHistoryImportToken !== item.token) return false;
    const action = node.dataset.groupHistoryImportAction;
    if (action === 'close') { release({close:true}); return true; }
    if (action === 'refresh') return load(item);
    if (action === 'start') return start(item);
    if (action === 'limit' && !item.loading && !item.sending && !item.intent && !item.needsRefresh && item.status?.anchor.available && !running.has(item.status.state)) {
      const value = Number(node.dataset.groupHistoryImportLimit);
      if (limits.includes(value) && String(value) === node.dataset.groupHistoryImportLimit) { item.limit = value; paint(item); return true; }
    }
    return false;
  }
  return {open,handleAction,reset:() => release({close:true}),syncContext:() => current ? shown(current) : false};
}
