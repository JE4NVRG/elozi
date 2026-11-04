import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';
import './locales-telegram-account.js';

import {createGroupHistoryImportUI} from './group-history-import-ui.js';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 160, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => count(value) && value > 0;
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19);
const invalid = () => { throw Object.assign(new Error('invalid-groups-response'), {code:'invalid-groups-response'}); };
const storedStates = i18nLabels({connected:'Conectado registrado',disconnected:'Sem conexão registrada',waiting:'Na fila',active:'Em atendimento',open:'Em atendimento',closed:'Encerrado',pending:'Pendente',disabled:'Desativado',planned:'Planejado',sandbox:'Teste'});
const transportNames = i18nLabels({baileys:'WhatsApp','telegram-bot':'Telegram','telegram-user':'Telegram pessoal'});
const personalTelegramAiReason = () => i18nText('Conversas da conta Telegram pessoal estão disponíveis para atendimento humano. Uso por IA exige consentimento específico dos participantes.');
const roleNames = i18nLabels({owner:'Proprietário',admin:'Administrador',member:'Membro',unknown:'Papel não informado'});
const sourceNames = i18nLabels({provider:'Informado pela plataforma',cache:'Último contexto salvo',observed:'Observado nas mensagens',unavailable:'Indisponível'});

function groupDTO(input) {
  if (!object(input) || !text(input.conversationId,120) || !positive(input.version) || !text(input.title) || !text(input.channelId,120) || !text(input.channelName) || !text(input.transport,80) || !text(input.state,80) || input.lastMessageAt !== null && !iso(input.lastMessageAt) || !count(input.unread) || !count(input.historyCount)) invalid();
  const {conversationId,version,title,channelId,channelName,transport,state,lastMessageAt,unread,historyCount} = input;
  return {conversationId,version,title,channelId,channelName,transport,state,lastMessageAt,unread,historyCount,aiAllowed:transport !== 'telegram-user' && input.aiAllowed !== false};
}
function directoryDTO(input, tenantId) {
  if (!object(input) || input.tenantId !== tenantId || !Array.isArray(input.groups) || input.groups.length > 10000) invalid();
  const groups = input.groups.map(groupDTO);
  if (new Set(groups.map(group => group.conversationId)).size !== groups.length) invalid();
  return groups;
}
function contextDTO(input, tenantId, selected) {
  const group = groupDTO(input);
  if (input.tenantId !== tenantId || group.conversationId !== selected.conversationId || group.channelId !== selected.channelId || group.version < selected.version) invalid();
  const metadata = input.group, participants = input.participants, topic = input.topic;
  if (!object(metadata) || !text(metadata.title) || metadata.description !== null && !text(metadata.description,4096,true) || !text(metadata.type,80) || !['provider','cache','observed'].includes(metadata.source) || !['available','unavailable'].includes(metadata.availability) || metadata.observedAt !== null && !iso(metadata.observedAt) || ![null,true,false].includes(metadata.announcement) || ![null,true,false].includes(metadata.forum)) invalid();
  if (topic !== null && (!object(topic) || !count(topic.id) || topic.title !== null && !text(topic.title) || topic.source !== 'observed')) invalid();
  if (!object(participants) || !Array.isArray(participants.items) || participants.items.length > 40 || participants.total !== null && !count(participants.total) || participants.complete !== false || !Object.hasOwn(sourceNames,participants.source) || !['available','unavailable'].includes(participants.availability) || participants.limit !== 40 || typeof participants.truncated !== 'boolean') invalid();
  if (participants.items.some(person => !object(person) || !text(person.id,180) || !text(person.name) || !Object.hasOwn(roleNames,person.role)) || new Set(participants.items.map(person => person.id)).size !== participants.items.length || participants.total !== null && participants.total < participants.items.length) invalid();
  return {...group,group:{title:metadata.title,description:metadata.description,type:metadata.type,announcement:metadata.announcement,forum:metadata.forum,source:metadata.source,availability:metadata.availability,observedAt:metadata.observedAt},topic:topic && {id:topic.id,title:topic.title,source:topic.source},participants:{items:participants.items.map(({id,name,role})=>({id,name,role})),total:participants.total,complete:false,source:participants.source,availability:participants.availability,limit:40,truncated:participants.truncated}};
}
function coverageDTO(input, limit) {
  if (!object(input) || !iso(input.from) || !iso(input.to) || Date.parse(input.from) > Date.parse(input.to) || !count(input.availableCount) || !count(input.includedCount) || input.includedCount > limit || input.includedCount > input.availableCount || typeof input.hasMore !== 'boolean' || input.historySource !== 'elozi' || input.attachmentsAnalyzed !== false || input.textTruncated !== undefined && typeof input.textTruncated !== 'boolean') invalid();
  const {from,to,availableCount,includedCount,hasMore} = input;
  return {from,to,availableCount,includedCount,hasMore,historySource:'elozi',attachmentsAnalyzed:false,textTruncated:input.textTruncated===true};
}
function historyDTO(input, selected) {
  if (!object(input) || input.conversationId !== selected.conversationId || !positive(input.version) || input.version < selected.version || !Array.isArray(input.messages) || input.messages.length > 50 || input.nextCursor !== null && !text(input.nextCursor,4096)) invalid();
  const coverage = coverageDTO(input.coverage,50), messages = input.messages;
  if (coverage.includedCount !== messages.length || coverage.hasMore !== Boolean(input.nextCursor) || new Set(messages.map(message => message.id)).size !== messages.length) invalid();
  let previous = -Infinity;
  for (const message of messages) {
    if (!object(message) || !text(message.id,180) || !text(message.kind,80) || !text(message.text,32768,true) || !text(message.senderName,160) || !iso(message.createdAt) || !Array.isArray(message.attachments) || message.attachments.length > 10 || Date.parse(message.createdAt) < previous || Date.parse(message.createdAt) < Date.parse(coverage.from) || Date.parse(message.createdAt) > Date.parse(coverage.to)) invalid();
    previous = Date.parse(message.createdAt);
    for (const attachment of message.attachments) if (!object(attachment) || !text(attachment.id,180,true) || !text(attachment.kind,80) || !text(attachment.name,240,true) || !text(attachment.mime,120,true) || attachment.size !== null && !count(attachment.size)) invalid();
  }
  return {conversationId:input.conversationId,version:input.version,coverage,nextCursor:input.nextCursor,messages:messages.map(({id,kind,text,senderName,createdAt,attachments})=>({id,kind,text,senderName,createdAt,attachments:attachments.map(({id,kind,name,mime,size})=>({id,kind,name,mime,size}))}))};
}

export function createGroupsWorkspaceUI({api,escape:e = escapeHTML,context = () => ({}),openConversation = () => {},avatar,toast = () => {},getAgents = () => [],onPaint = () => {},openModal,getModal = () => globalThis.document?.querySelector('#modal'),historyImportOptions = {}} = {}) {
  let view = null, root = null, serial = 0, selection = 0;
  const reads = new Map(), bound = new WeakSet();
  const snapshot = () => {
    const current = context();
    if (current?.active !== true || !text(current.workspaceId,120) || !text(current.tenantId,120) || !text(current.userId,120) || !text(current.authorityKey,4096)) return null;
    return {workspaceId:current.workspaceId,tenantId:current.tenantId,userId:current.userId,authorityKey:current.authorityKey,canSummarize:current.canSummarize === true,canImport:current.canManageChannels === true && current.canReadInbox === true && current.kind === 'human' && !current.supportGrantId,boot:current.boot,session:current.session};
  };
  const keyOf = value => value && JSON.stringify([value.workspaceId,value.tenantId,value.userId,value.authorityKey,value.canSummarize,value.canImport]);
  const own = item => Boolean(item && view === item && root?.isConnected !== false && root?.dataset?.groupsToken === item.token);
  const fresh = item => {
    const now = snapshot();
    return Boolean(item && view === item && now && keyOf(now) === item.key && now.boot === item.context.boot && now.session === item.context.session);
  };
  const modalBindings = new WeakSet();
  const historyImporter = createGroupHistoryImportUI({...historyImportOptions,api,escape:e,openModal,getModal,toast,getContext:() => ({...context(),active:Boolean(fresh(view) && own(view))}),onFinished:async result => {
    const item = view, group = activeGroup(item);
    if (!fresh(item) || !own(item) || result.tenantId !== item.context.tenantId || result.conversationId !== group?.conversationId || result.channelId !== group.channelId) return;
    await loadDirectory(item);
  }});
  function bindImportDialog() {
    const modal = getModal(); if (!modal?.addEventListener || modalBindings.has(modal)) return;
    modalBindings.add(modal);
    modal.addEventListener('click',event => {
      const node = event.target?.closest?.('[data-group-history-import-action]');
      if (node) { event.preventDefault(); void historyImporter.handleAction(node).catch(() => toast(i18nText('Não foi possível concluir a consulta do histórico. Verifique o progresso antes de fazer outro pedido.'),true)); }
    });
  }
  function abort(kind) { const ticket = reads.get(kind); ticket?.controller.abort(); reads.delete(kind); }
  function reset() {
    historyImporter.reset();
    const owned = own(view); serial++; selection++;
    for (const kind of [...reads.keys()]) abort(kind);
    view = null;
    if (owned) root.innerHTML = i18nMarkup('<div class="groups-workspace-empty" role="status">Selecione novamente uma empresa autorizada para ver os grupos.</div>');
    root = null;
  }
  function syncContext() { if (view && !fresh(view)) { reset(); return false; } historyImporter.syncContext(); return Boolean(view); }
  function ensure() {
    syncContext(); const current = snapshot();
    if (!current) return null;
    if (!view) view = {context:current,key:keyOf(current),token:String(++serial),groups:null,loading:false,error:'',search:'',channel:'all',visible:50,selectedId:null,meta:null,metaLoading:false,metaError:'',history:null,historyLoading:false,historyError:'',messages:[],after:'',before:'',periodError:'',agentId:'',summary:null,summaryLoading:false,summaryError:''};
    return view;
  }
  const activeGroup = item => item?.groups?.find(group => group.conversationId === item.selectedId) || null;
  const agents = () => {
    const items = getAgents({provider:'hermes',mode:'copilot',configured:true});
    return Array.isArray(items) ? items.filter(agent => object(agent) && text(agent.id,120) && text(agent.name) && agent.provider === 'hermes' && agent.mode === 'copilot' && agent.configured === true).map(({id,name})=>({id,name})) : [];
  };
  const date = value => value ? new Intl.DateTimeFormat(getLocale(),{dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : i18nText('Sem mensagem registrada');
  const amount = value => value.toLocaleString(getLocale());
  const action = (item,name,label,{id,muted=false,unavailable=false}={}) => `<button type="button" class="button${muted?'':' primary'}" data-groups-action="${name}" data-groups-token="${item.token}" data-groups-focus="${name}${id?'-'+e(id):''}"${id?` data-group-id="${e(id)}"`:''}${unavailable?' aria-disabled="true"':''}>${label}</button>`;
  const groupAvatar = group => typeof avatar === 'function' ? avatar(group) : `<span class="groups-avatar" aria-hidden="true">${e(group.title.trim().slice(0,2).toLocaleUpperCase('pt-BR'))}</span>`;
  const failure = error => error?.code === 'invalid-groups-response' ? i18nText('A resposta não confirmou dados consistentes deste grupo. Atualize e tente novamente.') : error?.status === 409 ? i18nText('O grupo ou a conexão mudou. Atualize a seleção antes de continuar.') : error?.status === 403 || error?.status === 401 ? i18nText('Seu acesso a estes grupos mudou. Revise a empresa e as permissões.') : error?.status === 404 ? i18nText('Este grupo não está disponível neste acesso.') : error?.status === 503 ? i18nText('O serviço está indisponível agora. Tente novamente em alguns instantes.') : i18nText('Não foi possível concluir a consulta. Confira a conexão e tente novamente.');
  function accessLost(error) {
    if (![401,403].includes(error?.status)) return false;
    reset(); toast(failure(error),true); return true;
  }
  function paint(item) {
    if (!fresh(item)) { syncContext(); return; }
    if (!own(item)) return;
    const active = globalThis.document?.activeElement, focus = root.contains?.(active) ? active?.dataset?.groupsFocus : null;
    const start = active?.selectionStart, end = active?.selectionEnd;
    root.innerHTML = inner(item);
    if (focus) {
      const control = [...(root.querySelectorAll?.('[data-groups-focus]') || [])].find(node => node.dataset.groupsFocus === focus);
      control?.focus?.({preventScroll:true});
      if (count(start) && count(end)) control?.setSelectionRange?.(start,end);
    }
    try { onPaint(); } catch { /* An avatar enhancement must not expose request failures. */ }
  }
  function requestTicket(kind,item,selected=false) {
    abort(kind); const ticket = {controller:new AbortController(),item,selection:selected?selection:null,groupId:selected?item.selectedId:null}; reads.set(kind,ticket); return ticket;
  }
  function current(ticket,kind) {
    if (!fresh(ticket.item)) { syncContext(); return false; }
    return own(ticket.item) && reads.get(kind) === ticket && !ticket.controller.signal.aborted && (ticket.selection === null || ticket.selection === selection && ticket.groupId === ticket.item.selectedId);
  }
  const path = (item,suffix) => `/api/tenants/${encodeURIComponent(item.context.tenantId)}${suffix}`;
  const init = (item,ticket) => ({method:'GET',headers:{'X-Elozi-Workspace':item.context.workspaceId},signal:ticket.controller.signal});
  function clearSelection(item,{preserveImporter = false} = {}) {
    if (!preserveImporter) historyImporter.reset();
    selection++; for (const kind of ['meta','history','summary']) abort(kind);
    Object.assign(item,{selectedId:null,meta:null,metaError:'',metaLoading:false,history:null,historyLoading:false,historyError:'',messages:[],summary:null,summaryLoading:false,summaryError:''});
  }
  async function loadDirectory(item) {
    if (!fresh(item) || !own(item) || item.loading) return;
    const ticket = requestTicket('directory',item); item.loading = true; item.error = ''; paint(item);
    try {
      const result = await api(path(item,'/groups'),init(item,ticket)); if (!current(ticket,'directory')) return;
      item.groups = directoryDTO(result,item.context.tenantId);
      if (item.selectedId && !activeGroup(item)) clearSelection(item);
      else if (item.selectedId) await selectGroup(item,item.selectedId);
    } catch (error) { if (current(ticket,'directory') && !accessLost(error)) { item.groups = []; clearSelection(item); item.error = failure(error); } }
    finally { if (current(ticket,'directory')) { reads.delete('directory'); item.loading = false; paint(item); } }
  }
  function windowQuery(item,cursor) {
    const query = new URLSearchParams({limit:'50'});
    if (item.after) query.set('after',item.after);
    if (item.before) query.set('before',item.before);
    if (cursor) query.set('cursor',cursor);
    return '?' + query;
  }
  async function loadHistory(item,{older=false}={}) {
    const group = activeGroup(item); if (!group || !fresh(item) || !own(item) || item.historyLoading) return;
    const cursor = older ? item.history?.nextCursor : null; if (older && !cursor) return;
    const ticket = requestTicket('history',item,true); item.historyLoading = true; item.historyError = ''; paint(item);
    try {
      const result = await api(path(item,`/conversations/${encodeURIComponent(group.conversationId)}/group-history${windowQuery(item,cursor)}`),init(item,ticket)); if (!current(ticket,'history')) return;
      const page = historyDTO(result,group);
      if (item.after && Date.parse(page.coverage.from) !== Date.parse(item.after) || item.before && Date.parse(page.coverage.to) !== Date.parse(item.before)) invalid();
      if (older && page.nextCursor === cursor) invalid();
      const known = new Set(item.messages.map(message => message.id));
      if (older && page.messages.some(message => known.has(message.id))) invalid();
      if (older && page.messages.length && item.messages.length && Date.parse(page.messages.at(-1).createdAt) > Date.parse(item.messages[0].createdAt)) invalid();
      item.messages = older ? [...page.messages,...item.messages] : page.messages; item.history = page;
    } catch (error) { if (current(ticket,'history') && !accessLost(error)) item.historyError = failure(error); }
    finally { if (current(ticket,'history')) { reads.delete('history'); item.historyLoading = false; paint(item); } }
  }
  async function loadMetadata(item) {
    const group = activeGroup(item); if (!group || !fresh(item) || !own(item)) return;
    const ticket = requestTicket('meta',item,true); item.metaLoading = true; item.metaError = ''; paint(item);
    try {
      const result = await api(path(item,`/conversations/${encodeURIComponent(group.conversationId)}/group-context`),init(item,ticket)); if (!current(ticket,'meta')) return;
      item.meta = contextDTO(result,item.context.tenantId,group);
    } catch (error) { if (current(ticket,'meta') && !accessLost(error)) item.metaError = failure(error); }
    finally { if (current(ticket,'meta')) { reads.delete('meta'); item.metaLoading = false; paint(item); } }
  }
  async function selectGroup(item,id) {
    if (!fresh(item) || !own(item) || !item.groups?.some(group=>group.conversationId===id)) return;
    clearSelection(item,{preserveImporter:item.selectedId === id}); item.selectedId = id; paint(item);
    await Promise.all([loadMetadata(item),loadHistory(item)]);
  }
  async function prepareSummary(item) {
    const group = activeGroup(item), eligible = agents(), agent = eligible.find(agent=>agent.id === item.agentId) || eligible[0];
    if (group?.aiAllowed === false) { item.summaryError = personalTelegramAiReason(); if (fresh(item) && own(item)) paint(item); return; }
    if (!group || !fresh(item) || !own(item) || !item.context.canSummarize || !agent || item.summaryLoading || item.historyLoading || !item.history) return;
    const commandId = globalThis.crypto?.randomUUID?.(); if (!commandId) { toast(i18nText('Não foi possível preparar uma solicitação segura. Atualize a página.'),true); return; }
    const ticket = requestTicket('summary',item,true); item.summaryLoading = true; item.summary = null; item.summaryError = ''; paint(item);
    const body = {version:Math.max(group.version,item.meta?.version || 0,item.history.version),agentId:agent.id,limit:100,commandId};
    if (item.after) body.after = item.after; if (item.before) body.before = item.before;
    try {
      const result = await api(path(item,`/conversations/${encodeURIComponent(group.conversationId)}/group-summary`),{...init(item,ticket),method:'POST',body:JSON.stringify(body)}); if (!current(ticket,'summary')) return;
      if (!object(result) || result.state !== 'ready' || result.conversationId !== group.conversationId || result.version !== body.version || result.agentId !== agent.id || !iso(result.createdAt) || !text(result.summary,32768)) invalid();
      const coverage = coverageDTO(result.coverage,100);
      if (body.after && Date.parse(coverage.from) !== Date.parse(body.after) || body.before && Date.parse(coverage.to) !== Date.parse(body.before)) invalid();
      item.summary = {summary:result.summary,coverage,createdAt:result.createdAt};
    } catch (error) { if (current(ticket,'summary') && !accessLost(error)) item.summaryError = failure(error); }
    finally { if (current(ticket,'summary')) { reads.delete('summary'); item.summaryLoading = false; paint(item); } }
  }
  function period(form,item) {
    const from = form.elements?.from?.value || '', to = form.elements?.to?.value || '';
    if (!from && !to) return {after:'',before:''};
    if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to)) return null;
    const a = new Date(from+'T00:00:00'), b = new Date(to+'T23:59:59.999');
    if (!Number.isFinite(+a) || !Number.isFinite(+b) || b < a || b-a > 31*86400000 || a.getFullYear()+'-'+String(a.getMonth()+1).padStart(2,'0')+'-'+String(a.getDate()).padStart(2,'0') !== from || b.getFullYear()+'-'+String(b.getMonth()+1).padStart(2,'0')+'-'+String(b.getDate()).padStart(2,'0') !== to) return null;
    return {after:a.toISOString(),before:b.toISOString()};
  }
  function detail(item) {
    const group = activeGroup(item);
    if (!group) return i18nMarkup('<section class="groups-workspace-detail groups-workspace-empty"><span class="groups-empty-mark" aria-hidden="true">G</span><h2>Escolha um grupo</h2><p>Veja o contexto e quem falou, prepare um resumo privado ou abra o atendimento para responder.</p></section>');
    const meta = item.meta, history = item.history, eligible = agents();
    const ready = Boolean(group.aiAllowed && history && !item.historyLoading && item.context.canSummarize && eligible.length);
    return i18nHtml`<section class="groups-workspace-detail" aria-label="Contexto do grupo"><header class="groups-detail-header"><div class="groups-detail-identity">${groupAvatar(group)}<div><span class="groups-kicker">${e(group.channelName)} · ${e(transportNames[group.transport] || group.transport)}</span><h2>${e(group.title)}</h2><p>${e(storedStates[group.state] || group.state)} · estado salvo no painel</p></div></div><div class="groups-detail-actions">${item.mode==='panel'?'':action(item,'open',i18nText('Abrir atendimento'))}${item.mode==='panel'?'':action(item,'reply',i18nText('Responder'),{muted:true})}${item.mode==='panel'?'':action(item,'schedule',i18nText('Agendar mensagem'),{muted:true})}${group.transport === 'baileys' && item.context.canImport && typeof openModal === 'function' ? action(item,'import-history',i18nText('Buscar histórico antigo'),{muted:true}) : ''}</div></header>
      ${!group.aiAllowed?`<p class="groups-note">${e(personalTelegramAiReason())}</p>`:''}
      <div class="groups-context-card"><h3>Contexto e participantes</h3>${item.metaLoading?i18nMarkup('<p role="status">Consultando o contexto disponível…</p>'):item.metaError?`<p class="groups-error" role="alert">${e(translateError(item.metaError))}</p>`:meta?i18nHtml`<p>${meta.group.description?e(meta.group.description):i18nText('Sem descrição disponível para este grupo.')}</p><div class="groups-context-tags"><span>${e(sourceNames[meta.group.source])}</span>${meta.group.announcement===true?i18nMarkup('<span>Somente administradores publicam</span>'):''}${meta.group.forum===true?i18nMarkup('<span>Fórum com tópicos</span>'):''}${meta.topic?i18nHtml`<span>Tópico ${e(meta.topic.title || '#'+meta.topic.id)}</span>`:''}</div><details class="groups-participants"><summary>${amount(meta.participants.items.length)} pessoas no contexto${meta.participants.total !== null?' · '+amount(meta.participants.total)+i18nText(' no grupo'):''}</summary><p>${meta.participants.source==='observed'?i18nText('Esta lista mostra autores observados nas mensagens, não todos os membros.'):i18nText('Lista limitada ao contexto que a plataforma informou, sem confirmar todos os membros.')} Máximo de 40 pessoas. ${meta.participants.truncated?i18nText('Há outras pessoas fora desta lista.'):''}</p><ul>${meta.participants.items.map(person=>`<li><strong>${e(person.name)}</strong><span>${e(roleNames[person.role])}</span></li>`).join('') || i18nMarkup('<li>Participantes indisponíveis neste momento.</li>')}</ul></details>${meta.group.availability==='unavailable'?i18nMarkup('<p class="groups-note">A plataforma está indisponível; somente o contexto seguro já observado está visível.</p>'):''}`:i18nMarkup('<p>Contexto ainda não consultado.</p>')}</div>
      <section class="groups-private-summary" aria-label="Resumo privado"><div class="groups-section-heading"><div><span class="groups-kicker">SOMENTE PARA A EQUIPE</span><h3>Resumo com seu copiloto</h3><p>O resumo não será enviado ao grupo.</p></div>${action(item,'summary',item.summaryLoading?i18nText('Preparando resumo…'):i18nText('Preparar resumo'),{unavailable:!ready || item.summaryLoading})}</div>${eligible.length?i18nHtml`<label class="groups-agent"><span>Copiloto Hermes</span><select data-groups-agent data-groups-focus="agent">${eligible.map(agent=>`<option value="${e(agent.id)}"${agent.id===(item.agentId || eligible[0].id)?' selected':''}>${e(agent.name)}</option>`).join('')}</select></label>`:i18nMarkup('<p class="groups-note">Configure um Hermes em modo copiloto para preparar resumos.</p>')}${!item.context.canSummarize?i18nMarkup('<p class="groups-note">Seu acesso precisa permitir leitura e resposta no atendimento para preparar um resumo.</p>'):''}<p class="groups-note">Até 100 mensagens e 24 KiB de texto no período. Fotos, vídeos, arquivos e áudios não são interpretados aqui.</p>${item.summaryLoading?i18nMarkup('<p role="status">O copiloto está preparando um resumo privado…</p>'):''}${item.summaryError?`<p class="groups-error" role="alert">${e(translateError(item.summaryError))}</p>`:''}${item.summary?i18nHtml`<div class="groups-summary-text">${summaryMarkup(item.summary.summary)}</div><p class="groups-note">${amount(item.summary.coverage.includedCount)} de ${amount(item.summary.coverage.availableCount)} mensagens disponíveis entre ${e(date(item.summary.coverage.from))} e ${e(date(item.summary.coverage.to))}.${item.summary.coverage.hasMore?i18nText(' Há mensagens fora deste resumo.'):''}${item.summary.coverage.textTruncated?i18nText(' Parte do texto foi reduzida para caber no contexto do copiloto.'):''} Mídias não analisadas.</p>`:''}</section>
      <section class="groups-history"><div class="groups-section-heading"><div><h3>Quem falou no grupo</h3><p>Histórico recebido e guardado no painel.</p></div><span>${e(i18nText('{count} mensagens visíveis',{count:amount(item.messages.length)}))}</span></div><form data-groups-period data-groups-token="${item.token}" class="groups-period"><label><span>De</span><input type="date" name="from" data-groups-focus="from" value="${item.after?e(item.after.slice(0,10)):''}"></label><label><span>Até</span><input type="date" name="to" data-groups-focus="to" value="${item.before?e(item.before.slice(0,10)):''}"></label><button type="submit" class="button" data-groups-focus="period">Aplicar período</button>${action(item,'default-period',i18nText('Últimos 7 dias'),{muted:true})}</form><p class="groups-note">Janela padrão: últimos 7 dias. Escolha um período de até 31 dias. O histórico anterior à conexão pode não estar disponível.</p>${item.periodError?`<p class="groups-error" role="alert">${e(item.periodError)}</p>`:''}${item.historyError?`<p class="groups-error" role="alert">${e(translateError(item.historyError))}</p>`:''}${item.historyLoading?i18nMarkup('<p role="status">Consultando as mensagens do período…</p>'):''}${history?i18nHtml`<div class="groups-history-coverage"><span>${amount(history.coverage.availableCount)} disponíveis no período</span><span>${e(date(history.coverage.from))} → ${e(date(history.coverage.to))}</span></div>${history.nextCursor?action(item,'older',i18nText('Mensagens anteriores'),{muted:true,unavailable:item.historyLoading}):''}<ol class="groups-message-list">${item.messages.map(message=>`<li class="groups-message"><header><strong>${e(message.senderName)}</strong><time datetime="${e(message.createdAt)}">${e(date(message.createdAt))}</time></header>${message.text?`<p>${e(message.text)}</p>`:''}${message.attachments.length?`<ul class="groups-attachment-list">${message.attachments.map(file=>`<li><span>${e(({image:i18nText('Foto'),video:i18nText('Vídeo'),audio:i18nText('Áudio'),document:i18nText('Documento'),file:i18nText('Arquivo'),sticker:i18nText('Figurinha')})[file.kind] || i18nText('Anexo'))}</span> ${e(file.name || i18nText('Mídia sem nome'))} · ${file.size === null ? i18nText('tamanho não informado') : amount(file.size)+' bytes'}</li>`).join('')}</ul>`:''}${!message.text&&!message.attachments.length?i18nMarkup('<p class="groups-note">Mensagem sem texto disponível.</p>'):''}</li>`).join('') || i18nMarkup('<li class="groups-workspace-empty">Nenhuma mensagem registrada neste período.</li>')}</ol>`:''}</section></section>`;
  }
  function summaryMarkup(value) {
    // Only bold spans and line breaks are generated, after escaping all source text.
    return e(value).split(/\r?\n/).map(line => line ? `<p>${line.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')}</p>` : '<div class="groups-summary-break" aria-hidden="true"></div>').join('');
  }
  function inner(item) {
    if (item.mode === 'panel') return panelInner(item);
    const groups = item.groups || [], needle = item.search.trim().toLocaleLowerCase('pt-BR');
    const filtered = groups.filter(group=>(item.channel==='all'||group.channelId===item.channel)&&(!needle||[group.title,group.channelName].some(value=>value.toLocaleLowerCase('pt-BR').includes(needle))));
    const channels = [...new Map(groups.map(group=>[group.channelId,group.channelName])).entries()];
    return i18nHtml`<div class="page-heading groups-workspace-heading"><div><span class="eyebrow">OPERAÇÃO POR CONEXÃO</span><h1>Grupos</h1><p>Acompanhe o contexto, leia as conversas e responda pelo atendimento da empresa selecionada.</p></div>${action(item,'refresh',item.loading?i18nText('Atualizando…'):i18nText('Atualizar grupos'),{muted:true,unavailable:item.loading})}</div><div class="groups-workspace-frame"><aside class="groups-workspace-directory" aria-label="Grupos autorizados"><header><h2>Seus grupos</h2><span>${amount(groups.length)} cadastrados</span></header><label class="groups-search"><span>Pesquisar grupo</span><input type="search" data-groups-search data-groups-focus="search" value="${e(item.search)}" maxlength="160" placeholder="Nome do grupo ou conexão"></label><label class="groups-channel"><span>Conexão</span><select data-groups-channel data-groups-focus="channel"><option value="all">Todas as conexões autorizadas</option>${channels.map(([id,name])=>`<option value="${e(id)}"${item.channel===id?' selected':''}>${e(name)}</option>`).join('')}</select></label>${item.loading?i18nMarkup('<p class="groups-directory-status" role="status">Consultando grupos autorizados…</p>'):''}${item.error?`<p class="groups-error" role="alert">${e(translateError(item.error))}</p>`:''}<div class="groups-directory-list">${filtered.slice(0,item.visible).map(group=>i18nHtml`<button type="button" class="groups-directory-item${group.conversationId===item.selectedId?' selected':''}" data-groups-action="select" data-group-id="${e(group.conversationId)}" data-groups-token="${item.token}" data-groups-focus="select-${e(group.conversationId)}" aria-pressed="${group.conversationId===item.selectedId}">${groupAvatar(group)}<span class="groups-directory-copy"><strong>${e(group.title)}</strong><span>${e(group.channelName)} · ${e(transportNames[group.transport] || group.transport)}</span><small>${e(storedStates[group.state] || group.state)} · ${e(date(group.lastMessageAt))} · ${amount(group.historyCount)} no histórico</small></span>${group.unread?i18nHtml`<span class="groups-unread" aria-label="${amount(group.unread)} não lidas">${amount(group.unread)}</span>`:''}</button>`).join('')}${!item.loading&&!filtered.length?`<div class="groups-workspace-empty"><h3>${groups.length?i18nText('Nenhum grupo corresponde à pesquisa'):i18nText('Ainda não há grupos neste acesso')}</h3><p>${groups.length?i18nText('Ajuste o nome ou a conexão selecionada.'):i18nText('Habilite grupos na conexão e receba uma mensagem para começar o histórico.')}</p>${!groups.length?i18nMarkup('<a class="button" href="#channels">Abrir Canais</a>'):''}</div>`:''}</div>${filtered.length>item.visible?action(item,'more-groups',i18nText('Mostrar mais grupos'),{muted:true}):''}<p class="groups-directory-footnote">Somente grupos e conexões permitidos neste acesso. Trocar a empresa muda o contexto desta tela.</p></aside>${detail(item)}</div>`;
  }
  // Grupo tab of the inbox context panel (FRONTEND-V2 §2.2, P3): the detail of one group conversation
  // (context, participants, private summary and history) without the directory of the old screen.
  function panelInner(item) {
    if (item.groups === null || item.loading) return i18nMarkup('<p class="groups-note" role="status">Consultando o grupo…</p>');
    if (item.error) return `<p class="groups-error" role="alert">${e(translateError(item.error))}</p>`;
    if (!item.groups.some(group => group.conversationId === item.panelFor)) return i18nMarkup('<p class="groups-note">Este grupo não está entre os grupos autorizados deste acesso.</p>');
    return detail(item);
  }
  function render({ panelFor = null } = {}) {
    const item = ensure();
    if (!item) return i18nMarkup('<div class="groups-workspace-empty"><h1>Grupos</h1><p>Selecione uma empresa autorizada para consultar os grupos.</p></div>');
    const mode = panelFor ? 'panel' : 'screen';
    if (item.mode !== mode || item.panelFor !== panelFor) { if (item.selectedId && item.selectedId !== panelFor) clearSelection(item); item.mode = mode; item.panelFor = panelFor; }
    return `<div class="groups-workspace${mode === 'panel' ? ' groups-workspace--panel' : ''}" data-groups-workspace data-groups-token="${item.token}">${inner(item)}</div>`;
  }
  async function handleAction(node) {
    const item = view;
    if (!fresh(item)) { syncContext(); return false; }
    if (!own(item) || node?.isConnected === false || node?.dataset?.groupsToken !== item.token || root.contains?.(node) === false) return false;
    const name = node.dataset.groupsAction;
    if (name === 'refresh') { await loadDirectory(item); return true; }
    if (name === 'select') { await selectGroup(item,node.dataset.groupId); return true; }
    if (name === 'more-groups') { item.visible += 50; paint(item); return true; }
    if (name === 'older') { await loadHistory(item,{older:true}); return true; }
    if (name === 'summary') { await prepareSummary(item); return true; }
    if (name === 'import-history') {
      const group = activeGroup(item);
      if (!group || group.transport !== 'baileys' || !item.context.canImport || typeof openModal !== 'function') return false;
      const opening = historyImporter.open({conversationId:group.conversationId,channelId:group.channelId,title:group.title});
      bindImportDialog(); return opening;
    }
    if (name === 'default-period') { item.after = ''; item.before = ''; item.periodError = ''; if(item.selectedId)await selectGroup(item,item.selectedId); return true; }
    if (['open','reply','schedule'].includes(name)) {
      const group = activeGroup(item); if (group) await openConversation(group.conversationId,item.context.tenantId,{intent:name==='open'?null:name}); return true;
    }
    return false;
  }
  async function bind(container = globalThis.document?.querySelector('[data-groups-workspace]')) {
    const item = ensure(); if (!item || !container || container.dataset?.groupsToken !== item.token || container.isConnected === false) return false;
    root = container;
    if (!bound.has(container)) {
      bound.add(container);
      container.addEventListener?.('click',event=>{const node=event.target?.closest?.('[data-groups-action]');if(node){event.preventDefault();return handleAction(node);}});
      container.addEventListener?.('input',event=>{if(event.target?.matches?.('[data-groups-search]')&&own(view)&&fresh(view)){view.search=String(event.target.value).slice(0,160);view.visible=50;paint(view);}});
      container.addEventListener?.('change',event=>{if(!own(view)||!fresh(view))return;const node=event.target;if(node?.matches?.('[data-groups-channel]')){view.channel=node.value;view.visible=50;if(node.value!=='all'&&activeGroup(view)?.channelId!==node.value)clearSelection(view);paint(view);}else if(node?.matches?.('[data-groups-agent]')){abort('summary');view.agentId=node.value;view.summary=null;view.summaryLoading=false;view.summaryError='';paint(view);}});
      container.addEventListener?.('submit',async event=>{const form=event.target;if(!form?.matches?.('[data-groups-period]'))return;event.preventDefault();if(!own(view)||!fresh(view)||form.dataset.groupsToken!==view.token)return;const window=period(form,view);if(!window){view.periodError=i18nText('Informe as duas datas em ordem, com um período de até 31 dias.');paint(view);return;}Object.assign(view,window,{periodError:''});if(view.selectedId)await selectGroup(view,view.selectedId);});
    }
    try { onPaint(); } catch { /* Optional enhancement only. */ }
    if (item.groups === null && !item.loading) await loadDirectory(item);
    if (item.mode === 'panel' && item.panelFor && item.selectedId !== item.panelFor && fresh(item) && own(item) && item.groups?.some(group => group.conversationId === item.panelFor)) await selectGroup(item, item.panelFor);
    return true;
  }
  return {render,bind,reset,syncContext,handleAction};
}
