import { t, getLocale, escapeHTML } from './i18n.js';
import { formatHash, parseHash } from './router.js';
import { createWebchatWidget } from './widget.js';
import './locales-channel-journey.js';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const origin = value => {
  if (typeof value !== 'string' || value.length > 240) return null;
  try {
    const url = new URL(value), loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    return url.origin === value && !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && loopback) ? url.origin : null;
  } catch { return null; }
};
const visitorRoute = route => route?.section === 'channels' && identifier(route.params?.channelId) && route.params?.tab === 'visitor' && !route.params?.kind;
const cancelled = () => Object.assign(new Error('Visitor test context changed'), { name:'AbortError' });

/** Private admin page around the existing public visitor widget. No origins/configuration writes. */
export function createChannelVisitorTestUI({ state, api, channels = () => state?.tenant?.channels || [],
  getRoute = () => parseHash(globalThis.location?.hash || ''), onChange = () => {}, canUse = () => true,
  document: doc = globalThis.document, window: win = doc?.defaultView || globalThis.window,
  widgetFactory = createWebchatWidget, fetchImpl = win?.fetch?.bind(win) } = {}) {
  let active = null, revision = 0;
  const session = () => state?.boot?.session || {};
  const find = id => (Array.isArray(channels()) ? channels() : []).find(channel => channel?.id === id && channel.kind === 'webchat');
  const workspaceId = () => state?.workspaceId || session().resellerId || '';
  const canonicalOrigin = () => origin(Object.hasOwn(state?.boot || {}, 'canonicalPublicOrigin') ? state.boot.canonicalPublicOrigin : state?.boot?.publicOrigin);
  const windowOrigin = () => origin(win?.location?.origin);
  const admin = () => canUse() && state?.view === 'channels' && identifier(workspaceId()) && identifier(state?.tenant?.id) && identifier(session().userId)
    && session().role === 'reseller' && session().kind !== 'service' && !state?.supportGrantId && !session().supportGrantId
    && (!state.tenant.resellerId || state.tenant.resellerId === workspaceId());
  const scope = route => JSON.stringify([Boolean(canUse()),workspaceId(),state?.tenant?.id,session().userId,session().role,session().kind,
    state?.supportGrantId || session().supportGrantId || null,state?.boot?.csrfToken || session().csrfToken || '',
    session().permissions,session().scopeRules,session().platformOwner,session().platformAdmin,
    (state?.boot?.workspaces || []).map(item=>[item.id,item.supportGrantId || null]),(state?.boot?.tenants || []).map(item=>item.id),
    state?.boot?.publicOrigin,Object.hasOwn(state?.boot || {},'canonicalPublicOrigin'),state?.boot?.canonicalPublicOrigin,
    windowOrigin(),state?.view,route?.section,route?.params,route?.query || {},route?.workspaceId || null]);
  const current = record => {
    const route = getRoute();
    return active === record && admin() && visitorRoute(route) && route.params.channelId === record.channelId
      && (!route.workspaceId || route.workspaceId === workspaceId()) && Boolean(find(record.channelId)) && scope(route) === record.key;
  };
  const notify = record => { if(current(record))try{onChange();}catch{/* A failed page refresh does not replay a request. */} };
  function stopListeners(record) { for(const dispose of record.listeners.splice(0))dispose(); }
  function stopGuest(record) {
    record.guestRevision++;record.started=false;
    for(const controller of record.publicControllers)controller.abort();record.publicControllers.clear();
    const widget=record.widget;record.widget=null;stopListeners(record);
    // The handle was accepted as newly owned at creation; mutable host attributes cannot revoke cleanup.
    if(widget)widget.destroy();
  }
  function reset() {
    const record=active;active=null;revision++;
    if(!record)return;
    record.readController?.abort();stopGuest(record);record.configuration=null;record.main=null;
  }
  function syncContext() { if(active && !current(active))reset(); }
  function sync(route) {
    if(!visitorRoute(route)){reset();return null;}
    if(active && (!current(active) || active.key !== scope(route)))reset();
    if(!active)active={key:scope(route),token:String(++revision),channelId:route.params.channelId,tenantId:state?.tenant?.id || '',workspaceId:workspaceId(),
      canonicalOrigin:canonicalOrigin(),windowOrigin:windowOrigin(),phase:'loading',reason:'',configuration:null,readController:null,readPromise:null,
      main:null,widget:null,started:false,guestRevision:0,listeners:[],publicControllers:new Set()};
    if(!admin() || !find(active.channelId) || route.workspaceId && route.workspaceId !== workspaceId()){active.phase='blocked';active.reason='authority';}
    else if(!active.canonicalOrigin || !active.windowOrigin){active.phase='blocked';active.reason='canonical';}
    else if(active.canonicalOrigin!==active.windowOrigin){active.phase='blocked';active.reason='panel-origin';}
    return active;
  }
  function bind(record) {
    if(record.listeners.length)return;
    const check=()=>{if(active===record && !current(record))reset();};
    const add=(target,name,handler)=>{if(typeof target?.addEventListener!=='function')return;target.addEventListener(name,handler);record.listeners.push(()=>target.removeEventListener?.(name,handler));};
    for(const name of ['hashchange','elozi:sessionchange','elozi:authoritychange'])add(win,name,check);
    add(win,'elozi:reauth',()=>{if(active===record)reset();});
    add(doc,'visibilitychange',check);add(win,'pagehide',()=>{if(active===record)reset();});
  }
  function normalize(result,record) {
    if(!result || result.kind!=='webchat' || result.channelId!==record.channelId || result.tenantId!==record.tenantId
      || !Number.isSafeInteger(result.version) || result.version<0 || typeof result.enabled!=='boolean'
      || !['planned','configured','connected','disconnected','error'].includes(result.state) || !Array.isArray(result.origins) || result.origins.length>8)throw Error('Invalid visitor test configuration');
    const origins=result.origins.map(value=>{const safe=origin(value);if(!safe)throw Error('Invalid visitor test origin');return safe;});
    return {version:result.version,enabled:result.enabled,state:result.state,origins};
  }
  async function read(record) {
    if(!current(record) || !record.canonicalOrigin || !record.windowOrigin || record.canonicalOrigin!==record.windowOrigin)return false;
    if(record.readPromise)return record.readPromise;
    record.phase='loading';record.reason='';bind(record);
    const Controller=win?.AbortController || globalThis.AbortController,controller=new Controller();record.readController=controller;
    const ticket=++revision;
    const promise=(async()=>{
      try {
        const authority=state.boot?.csrfToken || session().csrfToken;
        const result=await api(`/api/tenants/${encodeURIComponent(record.tenantId)}/channels/${encodeURIComponent(record.channelId)}/configuration`,
          {method:'GET',headers:{'X-Elozi-Workspace':record.workspaceId,...(typeof authority==='string' && authority?{'X-CSRF-Token':authority}:{})},signal:controller.signal});
        if(!current(record) || controller.signal.aborted || ticket!==revision){if(active===record && !current(record))reset();return false;}
        record.configuration=normalize(result,record);
        const value=record.configuration;
        record.reason=!value.enabled || value.state!=='connected'?'disabled':!value.origins.includes(record.windowOrigin)?'origin':'';
        record.phase=record.reason?'blocked':'ready';notify(record);return record.phase==='ready';
      } catch(failure) {
        if(!current(record) || controller.signal.aborted || ticket!==revision){if(active===record && !current(record))reset();return false;}
        record.phase=[401,403,404].includes(failure?.status)?'blocked':'error';record.reason=[401,403,404].includes(failure?.status)?'authority':'query';notify(record);return false;
      } finally { if(record.readController===controller)record.readController=null;record.readPromise=null; }
    })();record.readPromise=promise;return promise;
  }
  const assertGuest=(record,generation)=>{
    if(!current(record) || !record.started || record.guestRevision!==generation){if(active===record && !current(record))reset();throw cancelled();}
  };
  function responseFor(response,guard,finish) {
    const wrapReader=reader=>new Proxy(reader,{get(target,name){const value=Reflect.get(target,name,target);
      if(name==='read')return async(...args)=>{guard();try{const result=await value.apply(target,args);guard();if(result.done)finish();return result;}catch(failure){finish();throw failure;}};
      if(name==='cancel')return(...args)=>{finish();return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;}});
    return new Proxy(response,{get(target,name){const value=Reflect.get(target,name,target);
      if(['json','text','blob','arrayBuffer','formData'].includes(name) && typeof value==='function')return async(...args)=>{guard();try{const result=await value.apply(target,args);guard();return result;}finally{finish();}};
      if(name==='clone' && typeof value==='function')return()=>{guard();return responseFor(value.call(target),guard,finish);};
      if(name==='body' && value)return new Proxy(value,{get(stream,key){const member=Reflect.get(stream,key,stream);if(key==='getReader')return(...args)=>{guard();return wrapReader(member.apply(stream,args));};return typeof member==='function'?member.bind(stream):member;}});
      return typeof value==='function'?value.bind(target):value;
    }});
  }
  function publicFetch(record,generation) {
    return async(url,options={})=>{
      const guard=()=>assertGuest(record,generation);guard();
      const parsed=new URL(url),prefix=`/api/public/webchat/${encodeURIComponent(record.tenantId)}/${encodeURIComponent(record.channelId)}/`;
      if(parsed.origin!==record.canonicalOrigin || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith(prefix)
        || !/^(?:config|challenge|session|identity|contact|feedback|messages|history|logout|media(?:\/[A-Za-z0-9_-]{1,120})?)$/.test(parsed.pathname.slice(prefix.length)) || options.method!=='POST')throw cancelled();
      const Controller=win?.AbortController || globalThis.AbortController,controller=new Controller(),upstream=options.signal;
      const abort=()=>controller.abort();if(upstream?.aborted)controller.abort();else upstream?.addEventListener?.('abort',abort,{once:true});
      record.publicControllers.add(controller);
      const finish=()=>{record.publicControllers.delete(controller);upstream?.removeEventListener?.('abort',abort);};
      try {
        guard();if(controller.signal.aborted)throw cancelled();
        const safeHeaders=new Headers();for(const [name,value] of new Headers(options.headers || {}))if(['content-type','authorization'].includes(name.toLowerCase()))safeHeaders.set(name,value);
        const response=await fetchImpl(parsed.href,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:safeHeaders,body:options.body,signal:controller.signal});
        guard();if(controller.signal.aborted)throw cancelled();
        return responseFor(response,()=>{guard();if(controller.signal.aborted)throw cancelled();},finish);
      } catch(failure){finish();throw failure;}
    };
  }
  function openGuest(record) {
    if(!current(record) || record.phase!=='ready' || !record.configuration?.enabled || !record.configuration.origins.includes(windowOrigin()))return false;
    if(record.widget){record.widget.open();return true;}
    const context=JSON.stringify([record.canonicalOrigin,record.tenantId,record.channelId]),existing=Array.from(doc?.querySelectorAll?.('[data-elozi-widget]') || []).find(host=>host.dataset.eloziWidget===context);
    if(existing){record.reason='existing';notify(record);return false;}
    if(!doc?.body || !win || typeof fetchImpl!=='function'){record.phase='error';record.reason='query';notify(record);return false;}
    bind(record);record.started=true;const generation=++record.guestRevision;
    const before=new Set(Array.from(doc.querySelectorAll?.('[data-elozi-widget]') || []));let widget;
    try {
      const script=doc.querySelector?.('script[nonce]');
      widget=widgetFactory({document:doc,window:win,fetchImpl:publicFetch(record,generation),apiOrigin:record.canonicalOrigin,tenantId:record.tenantId,channelId:record.channelId,locale:getLocale(),nonce:script?.nonce || script?.getAttribute?.('nonce') || ''});
      if(!widget?.host || before.has(widget.host) || widget.host.parentNode!==doc.body || typeof widget.open!=='function' || typeof widget.destroy!=='function')throw Error('Visitor widget not owned');
      widget.host.dataset.channelVisitorTest=record.token;record.widget=widget;
      assertGuest(record,generation);record.reason='';widget.open();notify(record);return true;
    } catch {
      if(widget?.host && !before.has(widget.host) && typeof widget.destroy==='function')widget.destroy();
      record.widget=null;record.started=false;
      for(const controller of record.publicControllers)controller.abort();record.publicControllers.clear();
      stopListeners(record);
      if(current(record)){record.phase='error';record.reason='query';notify(record);}return false;
    }
  }
  function view(route=getRoute()) {
    const record=sync(route);if(!record)return '';
    const label=source=>escapeHTML(t(source)),channel=find(record.channelId),ready=record.phase==='ready' && record.reason!=='existing';
    const back=formatHash({section:'channels',params:{channelId:record.channelId,tab:'test'},workspaceId:record.workspaceId}),configure=formatHash({section:'channels',params:{channelId:record.channelId,tab:'connect'},workspaceId:record.workspaceId});
    const explanation=record.reason==='origin'?'Este endereço não está nas origens autorizadas do canal. Confira a configuração; este teste não amplia a lista de sites.'
      :record.reason==='disabled'?'Este canal está desativado. Confira a configuração antes de abrir uma conversa.'
        :record.reason==='panel-origin'?'Abra este teste no endereço público da Elozi. Neste domínio, teste o chat no site autorizado.'
        :record.reason==='canonical'?'O painel não confirmou um endereço seguro para o widget. Atualize seu acesso e tente novamente.'
          :record.reason==='authority'?'Esta página pertence ao administrador da empresa e ao canal webchat selecionado. Abra o acesso autorizado novamente.'
            :record.reason==='existing'?'Já existe um chat desse canal nesta página. Este teste não reutiliza nem remove uma instalação existente.'
              :record.phase==='error'?'Não foi possível consultar o canal. Tente atualizar a configuração.'
                :record.phase==='loading'?'Consultando a origem e a configuração atual do canal…'
                  :record.widget?'O chat de teste está aberto nesta página. Use o formulário do visitante para iniciar a conversa.'
                    :'Origem habilitada. Você pode abrir o chat real deste canal como visitante de teste.';
    return `<section class="channel-visitor-test" data-channel-visitor-test="${escapeHTML(record.channelId)}"><header class="channel-visitor-test__heading"><div><p class="channel-visitor-test__eyebrow">${label('VALIDAÇÃO DO CANAL')}</p><h1>${label('Chat visitante de teste')}</h1><p>${escapeHTML(channel?.name || t('Webchat'))} · ${escapeHTML(state?.tenant?.name || '')}</p></div><a class="button" href="${escapeHTML(back)}">${label('Voltar ao teste do canal')}</a></header><div class="channel-visitor-test__notice"><strong>${label('Uma conversa real, aberta por você')}</strong><p>${label('Esta página verifica a entrada da mensagem e a resposta no canal. Ela não comprova que o código está instalado em um site externo.')}</p></div><div class="channel-visitor-test__card"><h2>${label('Como testar')}</h2><ol><li>${label('Abra o chat e informe um nome de teste. O e-mail é opcional quando o canal oferece esse campo.')}</li><li>${label('Inicie a conversa no formulário do visitante e envie uma mensagem de teste autorizada.')}</li><li>${label('Confira a entrada no Atendimento, responda com a equipe e confira a resposta neste chat.')}</li><li>${label('Volte ao teste do canal para conferir a prova e confirmar o recebimento no destino.')}</li></ol><p class="channel-visitor-test__origin"><strong>${label('Origem desta página')}</strong> <code>${escapeHTML(record.windowOrigin || '')}</code></p><p class="channel-visitor-test__status" role="status" aria-live="polite">${label(explanation)}</p><div class="channel-visitor-test__actions"><button type="button" class="button primary" data-action="channels:visitor-open" data-id="${escapeHTML(record.channelId)}" ${ready?'':'disabled'}>${label(record.widget?'Reabrir chat de teste':'Abrir conversa de teste')}</button>${record.widget?`<button type="button" class="button" data-action="channels:visitor-close" data-id="${escapeHTML(record.channelId)}">${label('Fechar chat de teste')}</button>`:''}<button type="button" class="button" data-action="channels:visitor-refresh" data-id="${escapeHTML(record.channelId)}" ${record.phase==='loading'?'disabled':''}>${label('Atualizar configuração do canal')}</button>${record.phase==='blocked' && ['origin','disabled'].includes(record.reason)?`<a class="button" href="${escapeHTML(configure)}">${label('Conferir configuração do canal')}</a>`:''}</div><small>${label('Abrir o chat não cria atendimento nem envia mensagens. Iniciar e enviar dependem de suas ações no formulário do visitante. A sessão de teste fica apenas nesta página.')}</small></div></section>`;
  }
  async function mount(main,route=getRoute()) {
    const record=sync(route);if(!record)return false;
    const page=main?.matches?.('[data-channel-visitor-test]')?main:main?.querySelector?.('[data-channel-visitor-test]');
    if(!page || page.dataset.channelVisitorTest!==record.channelId || main.isConnected===false)return false;
    record.main=main;
    if(!current(record) || record.phase==='blocked' && ['authority','canonical','panel-origin'].includes(record.reason))return false;
    if(record.configuration || record.phase==='error' || record.phase==='blocked')return record.phase==='ready';
    return read(record);
  }
  async function act(action,id) {
    if(!['channels:visitor-open','channels:visitor-close','channels:visitor-refresh'].includes(action))return false;
    const record=active;
    if(!record || id!==record.channelId || !current(record)){if(record && !current(record))reset();return true;}
    if(action==='channels:visitor-open')openGuest(record);
    if(action==='channels:visitor-close'){stopGuest(record);record.reason='';notify(record);}
    if(action==='channels:visitor-refresh'){
      if(record.readPromise)return true;
      stopGuest(record);record.configuration=null;await read(record);
    }
    return true;
  }
  return {view,mount,act,reset,syncContext};
}
