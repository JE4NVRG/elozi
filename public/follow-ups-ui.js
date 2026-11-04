import { h, t, getLocale, translateError } from './i18n.js';
import './locales-follow-ups.js';

const kinds = {support:'Suporte',quote:'Orçamento',task:'Tarefa'};
const states = {pending:'Pendente',done:'Concluído',cancelled:'Cancelado'};
const revision = value => Number.isSafeInteger(value) && value >= 0;
const zonedDate = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const dateLabel = value => zonedDate(value) ? new Date(value).toLocaleString(getLocale()) : t('Data indisponível');
const fail = () => new Error(t('Não foi possível confirmar os acompanhamentos. Atualize e confira a lista.'));

export function followUpsContextKey(c = {}) {
  return c.active === true && c.canRead === true && ['workspaceId','tenantId','conversationId','userId'].every(key=>typeof c[key] === 'string' && c[key])
    ? JSON.stringify([c.workspaceId,c.tenantId,c.conversationId,c.channelId || '',c.userId,c.authorityKey || '',c.canWrite === true]) : '';
}

// datetime-local is interpreted in the browser's actual timezone, never by appending an invented offset.
// Round-trip every calendar component: Date normalizes impossible days and DST gaps otherwise.
export function followUpDueAt(value) {
  if (value === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(String(value));
  if (!match) throw new Error(t('Informe uma data e hora locais válidas ou deixe o prazo vazio.'));
  const [,y,m,d,hh,mm,ss='0',ms='0'] = match;
  const parts = [+y,+m-1,+d,+hh,+mm,+ss,Number(ms.padEnd(3,'0'))];
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone) throw new Error(t('O navegador não informou um fuso horário válido.'));
  new Intl.DateTimeFormat('en',{timeZone:zone});
  const date = new Date(0); date.setFullYear(parts[0],parts[1],parts[2]); date.setHours(parts[3],parts[4],parts[5],parts[6]);
  const roundtrip = [date.getFullYear(),date.getMonth(),date.getDate(),date.getHours(),date.getMinutes(),date.getSeconds(),date.getMilliseconds()];
  if (!Number.isFinite(date.getTime()) || parts.some((part,index)=>part!==roundtrip[index])) throw new Error(t('Informe uma data e hora locais válidas ou deixe o prazo vazio.'));
  return date.toISOString();
}
function localInput(value) {
  if (!value) return '';
  if (!zonedDate(value)) throw fail();
  const d = new Date(value), pad = n=>String(n).padStart(2,'0');
  return `${String(d.getFullYear()).padStart(4,'0')}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}
function normalize(item) {
  if (!item || typeof item.id !== 'string' || !item.id || !Object.hasOwn(kinds,item.kind) || !Object.hasOwn(states,item.state)
    || typeof item.title !== 'string' || !item.title.trim() || item.title.length>160 || typeof item.nextAction !== 'string' || item.nextAction.length>500
    || !(item.dueAt === null || zonedDate(item.dueAt)) || typeof item.userId !== 'string' || !item.userId || typeof item.authorName !== 'string'
    || !zonedDate(item.createdAt) || !zonedDate(item.updatedAt) || !(item.outcome == null || typeof item.outcome === 'string' && item.outcome.length<=500)
    || item.state !== 'pending' && !item.outcome?.trim()) throw fail();
  return {id:item.id,kind:item.kind,title:item.title,nextAction:item.nextAction,dueAt:item.dueAt,state:item.state,userId:item.userId,authorName:item.authorName,createdAt:item.createdAt,updatedAt:item.updatedAt,outcome:item.outcome ?? null};
}

export function createFollowUpsUI({getContext,request,getHost,onMutation=()=>{},onError=()=>{}}) {
  let view = null, generation = 0;
  const context = () => getContext() || {};
  const current = v => Boolean(v && v===view && v.generation===generation && v.host===getHost() && v.host.isConnected!==false && v.key===followUpsContextKey(context()));
  // Global permission is only a prefilter; the fresh scoped GET is the write authority.
  const writable = v => current(v) && context().canWrite===true && v.loaded && v.serverCanWrite===true;
  function reset() {
    const previous = view; view = null; generation++;
    if (previous) {
      previous.controller.abort(); previous.readController?.abort();
      previous.host.removeEventListener('click',previous.click); previous.host.removeEventListener('submit',previous.submit);
      previous.host.innerHTML = '';
    }
  }
  const button = (action,label,id='',disabled=false) => h`<button type="button" class="button" data-follow-up-action="${action}" data-id="${id}" ${disabled?'disabled':''}>${t(label)}</button>`;
  function capture(v) {
    if (!v.editor || v.drawnEditor!==v.editor) return;
    for (const key of ['kind','title','nextAction','dueAt','outcome']) {
      const field = v.host.querySelector(`[name="${key}"]`);
      if (field) v.editor[key] = field.value;
    }
  }
  function render(v) {
    if (!current(v)) return;
    capture(v);
    const busy = v.loading || v.saving;
    v.host.setAttribute('aria-busy',String(busy));
    v.host.querySelector('[data-follow-up-feedback]').innerHTML = String(h`${v.error?h`<p class="form-error" role="alert">${translateError(v.error)}</p>`:''}${v.status?h`<p role="status" aria-live="polite">${v.status}</p>`:''}${v.loading?h`<p role="status">${t('Consultando acompanhamentos…')}</p>`:''}${v.conflict?h`<p>${t('O atendimento mudou. Seu rascunho foi preservado. Atualize a lista e revise antes de salvar novamente.')}</p>`:''}`);
    v.host.querySelector('[data-follow-up-toolbar]').innerHTML = String(h`${button('refresh','Atualizar lista','',busy)}${writable(v)?button('new','Novo acompanhamento','',busy):h`<p class="muted">${t('Somente leitura. Você não tem permissão para alterar acompanhamentos.')}</p>`}`);
    v.host.querySelector('[data-follow-up-list]').innerHTML = String(h`${v.items.map(item=>h`<li class="follow-up-item"><div class="follow-up-heading"><strong>${item.title}</strong><span class="badge">${t(states[item.state])}</span></div><small>${t(kinds[item.kind])} · ${t('Criado por')}: ${item.authorName} · ${dateLabel(item.createdAt)}</small><p class="follow-up-copy">${item.nextAction}</p><p>${item.dueAt? h`${t('Prazo')}: ${dateLabel(item.dueAt)}${item.state==='pending'&&Date.parse(item.dueAt)<Date.now()?h` <span class="badge amber">${t('Atrasado')}</span>`:''}`:t('Sem prazo')}</p>${item.outcome?h`<p class="follow-up-copy">${t('Resultado')}: ${item.outcome}</p>`:''}<small>${t('Atualizado em')}: ${dateLabel(item.updatedAt)}</small>${item.state==='pending'&&writable(v)?h`<div class="row-actions">${button('edit','Editar próximo passo',item.id,busy||v.conflict)}${button('done','Concluir',item.id,busy||v.conflict)}${button('cancel','Cancelar acompanhamento',item.id,busy||v.conflict)}</div>`:''}</li>`)}`);
    const empty = v.host.querySelector('[data-follow-up-empty]');
    empty.hidden = v.items.length>0 || v.loading || !v.loaded;
    empty.innerHTML = String(h`${t('Nenhum acompanhamento manual. Registre o próximo passo deste atendimento.')}`);
    const target = v.host.querySelector('[data-follow-up-editor]');
    if (v.drawnEditor!==v.editor) {
      v.drawnEditor = v.editor; const e = v.editor;
      target.innerHTML = e ? String(h`<form data-follow-up-form="editor" class="follow-up-form"><h4>${t(e.action==='new'?'Novo acompanhamento':e.action==='edit'?'Editar próximo passo':e.action==='done'?'Concluir acompanhamento':'Cancelar acompanhamento')}</h4>${e.action==='new'?h`<label>${t('Tipo')}<select name="kind">${Object.entries(kinds).map(([key,label])=>h`<option value="${key}">${t(label)}</option>`)}</select></label><label>${t('Título')}<input name="title" maxlength="160" required></label>`:h`<strong>${e.item.title}</strong>`}<label>${t('Próximo passo')}<textarea name="nextAction" maxlength="500" rows="3"></textarea></label><label>${t('Prazo no fuso do navegador')}<input name="dueAt" type="datetime-local" step="0.001"></label>${['done','cancel'].includes(e.action)?h`<label>${t('Resultado obrigatório')}<textarea name="outcome" maxlength="500" rows="3" required></textarea></label>`:''}<div class="row-actions"><button type="submit" class="button primary">${t('Salvar acompanhamento')}</button>${button('close','Descartar rascunho')}</div></form>`) : '';
      if (e) for (const name of ['kind','title','nextAction','dueAt','outcome']) { const field=target.querySelector(`[name="${name}"]`);if(field)field.value=e[name] ?? ''; }
    }
    for (const node of target.querySelectorAll('input, textarea, select, button')) node.disabled = busy || (node.type==='submit' || node.getAttribute('type')==='submit') && v.conflict || !writable(v);
  }
  const options = (v,extra,signal=v.controller.signal) => ({...extra,signal,headers:{'X-Elozi-Workspace':v.context.workspaceId}});
  function denied(v,error) { if(current(v)){reset();onError(translateError(error.message || t('Acesso aos acompanhamentos indisponível.')));} }
  function load(v) {
    const pending=read(v);v.readPromise=pending;return pending;
  }
  async function read(v) {
    if (!current(v) || v.saving) return false;
    v.readController?.abort();v.readController=new AbortController(); const ticket=++v.readGeneration;
    v.started=true;v.loading=true;v.error='';v.observed=context().version;render(v);
    try {
      const result=await request(v.path,options(v,{method:'GET'},v.readController.signal));
      if(!current(v)||ticket!==v.readGeneration)return false;
      if(!Array.isArray(result?.items)||result.items.length>40||!revision(result.version))throw fail();
      const items=result.items.map(normalize);if(new Set(items.map(i=>i.id)).size!==items.length)throw fail();
      v.items=items;v.version=result.version;v.loaded=true;v.serverCanWrite=result.canWrite===true;v.conflict=false;v.error='';v.needsReconcile=false;
      if(!v.serverCanWrite)v.editor=null;
      if(v.editor?.item) {
        const updated=items.find(i=>i.id===v.editor.item.id);
        if(!updated || updated.state!=='pending') {v.conflict=true;v.error=t('Este registro já foi encerrado ou não está disponível. Seu rascunho foi preservado.');}
        else v.editor.item=updated;
      }
      return true;
    } catch(error) {
      if(!current(v)||ticket!==v.readGeneration)return false;
      if([401,403,404].includes(error.status)){denied(v,error);return false;}
      v.conflict=true;v.error=error.message || t('Não foi possível consultar os acompanhamentos. Tente atualizar a lista.');return false;
    } finally { if(current(v)&&ticket===v.readGeneration){v.loading=false;render(v);} }
  }
  function begin(v,action,id) {
    if(!writable(v)||v.saving||v.loading)return false;
    if(v.editor) { capture(v); v.error=t('Salve ou descarte o rascunho atual antes de abrir outro.');render(v);return false; }
    const item=action==='new'?null:v.items.find(i=>i.id===id&&i.state==='pending');
    if(action!=='new'&&(!item||v.conflict))return false;
    v.editor={action,item,kind:item?.kind || 'support',title:item?.title || '',nextAction:item?.nextAction || '',dueAt:localInput(item?.dueAt),outcome:''};
    v.error='';v.status='';render(v);v.host.querySelector('[name="title"], [name="outcome"], [name="nextAction"]')?.focus();return true;
  }
  async function submit(v,form) {
    if(!current(v)||!v.host.contains(form)||!writable(v)||!v.editor||v.saving||v.loading||v.conflict||!v.loaded)return false;
    capture(v);const editor=v.editor;let payload;
    try {
      const title=editor.title.trim(), nextAction=editor.nextAction.trim(), outcome=editor.outcome.trim();
      if(editor.action==='new'&&(!Object.hasOwn(kinds,editor.kind)||!title||title.length>160)||nextAction.length>500||outcome.length>500||['done','cancel'].includes(editor.action)&&!outcome)throw new Error(t('Confira título (1–160), próximo passo (até 500) e resultado obrigatório (1–500).'));
      const dueAt=followUpDueAt(editor.dueAt);
      payload=editor.action==='new'?{version:v.version,kind:editor.kind,title,nextAction,dueAt}:{version:v.version,state:editor.action==='edit'?'pending':editor.action==='done'?'done':'cancelled',nextAction,dueAt,outcome};
      if(editor.action==='new') {
        // A refreshed conversation revision is not a new user command. Keep the
        // original CAS and key after an ambiguous POST, until an explicit rejection.
        const signature=JSON.stringify([payload.kind,payload.title,payload.nextAction,payload.dueAt]);
        if(editor.attempt?.signature!==signature)editor.attempt={signature,version:payload.version,commandId:globalThis.crypto.randomUUID()};
        payload={version:editor.attempt.version,commandId:editor.attempt.commandId,kind:payload.kind,title:payload.title,nextAction:payload.nextAction,dueAt:payload.dueAt};
      }
    } catch(error) {v.error=error.message;render(v);return false;}
    const capturedContext={...context()}, baseVersion=payload.version,observedVersion=v.version;
    v.saving=true;v.error='';v.status='';render(v);
    try {
      const result=await request(v.path+(editor.item?'/'+encodeURIComponent(editor.item.id):''),options(v,{method:editor.item?'PATCH':'POST',body:JSON.stringify(payload)}));
      if(!current(v)||v.editor!==editor)return false;
      const item=normalize(result?.item);
      if(!revision(result.version)||result.version<=baseVersion||item.nextAction!==payload.nextAction||item.dueAt!==payload.dueAt
        || editor.item&&(item.id!==editor.item.id||item.kind!==editor.item.kind||item.title!==editor.item.title||item.userId!==editor.item.userId||item.state!==payload.state||item.outcome!==payload.outcome)
        || !editor.item&&(item.kind!==payload.kind||item.title!==payload.title||item.state!=='pending'||item.userId!==capturedContext.userId))throw fail();
      v.items=editor.item?v.items.map(i=>i.id===item.id?item:i):[item,...v.items.filter(i=>i.id!==item.id)].slice(0,40);
      v.needsReconcile=result.version<observedVersion;v.version=Math.max(observedVersion,result.version);v.editor=null;v.status=t('Acompanhamento registrado. Nenhuma mensagem foi enviada.');
      // The parent alone applies the conversation revision; this module never publishes/sends a message.
      onMutation(result,capturedContext);return true;
    } catch(error) {
      if(!current(v))return false;
      if([401,403,404].includes(error.status)){denied(v,error);return false;}
      if(error.status===409){if(editor.action==='new')editor.attempt=null;v.conflict=true;v.error=t('O atendimento mudou. Seu rascunho foi preservado. Atualize a lista e revise antes de salvar novamente.');}
      else v.error=error.status?error.message:t('Não foi possível confirmar a gravação. Confira a lista ou tente novamente com a mesma tentativa.');
      return false;
    } finally {if(current(v)){v.saving=false;render(v);if(v.needsReconcile||context().version!==v.observed)await load(v);}}
  }
  function mount(c,host,key) {
    const v={context:{...c},host,key,generation:++generation,controller:new AbortController(),readController:null,readGeneration:0,observed:undefined,
      path:`/api/tenants/${encodeURIComponent(c.tenantId)}/conversations/${encodeURIComponent(c.conversationId)}/follow-ups`,items:[],version:null,loaded:false,loading:false,saving:false,editor:null,drawnEditor:undefined,conflict:false,error:'',status:''};
    view=v;
    host.innerHTML=String(h`<section class="follow-ups-panel" aria-label="${t('Acompanhamentos manuais')}"><h3>${t('Acompanhamentos manuais')}</h3><p class="muted">${t('Registro interno manual: não envia mensagens, não agenda envios e não aciona IA.')}</p><small>${t('Datas e atrasos usam o relógio e o fuso do navegador.')}</small><div class="row-actions" data-follow-up-toolbar></div><div data-follow-up-feedback aria-live="polite"></div><div data-follow-up-editor></div><p class="empty" data-follow-up-empty hidden></p><ul class="follow-up-list" data-follow-up-list></ul></section>`);
    v.click=async event=>{
      const node=event.target?.closest?.('[data-follow-up-action]');if(!node||!host.contains(node))return;
      event.preventDefault();event.stopPropagation();if(!current(v)||node.disabled||v.saving)return;
      const action=node.getAttribute('data-follow-up-action');
      if(action==='refresh'){await load(v);return;}
      if(action==='close'){v.editor=null;v.error='';render(v);return;}
      if(['new','edit','done','cancel'].includes(action))begin(v,action,node.getAttribute('data-id'));
    };
    v.submit=event=>{const form=event.target?.closest?.('[data-follow-up-form]');if(!form||!host.contains(form))return;event.preventDefault();event.stopPropagation();return submit(v,form);};
    host.addEventListener('click',v.click);host.addEventListener('submit',v.submit);render(v);return v;
  }
  async function sync() {
    const c=context(),key=followUpsContextKey(c),host=getHost();
    if(!key||!host||host.isConnected===false){reset();return false;}
    if(!current(view)){reset();mount(c,host,key);}
    const v=view;
    // An opener must await the same fresh authority read already started by render.
    if(v.loading&&v.observed===c.version)return v.readPromise;
    if((!v.started||v.observed!==c.version)&&!v.saving)return load(v);
    return true;
  }
  async function open() {
    const pending=sync(),v=view;await pending;
    if(!current(v)||!writable(v))return false;
    if(v.editor?.action==='new'){render(v);v.host.querySelector('[name="title"]')?.focus();return true;}
    return begin(v,'new');
  }
  return {sync,open,reset};
}
