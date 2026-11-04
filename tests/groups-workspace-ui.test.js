import * as i18n from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import {createGroupsWorkspaceUI} from '../public/groups-workspace-ui.js';
import {groupHistory} from '../src/group-history.js';
import {excerpt} from './helpers/app-source.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';

const pending = () => { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject}; };
const group = (extra={}) => ({conversationId:'group-a',version:2,title:'Grupo Operação',channelId:'wa-a',channelName:'WhatsApp Empresa',transport:'baileys',state:'active',lastMessageAt:'2026-10-06T12:00:00.000Z',unread:2,historyCount:4,...extra});
const coverage = (extra={}) => ({from:'2026-10-01T00:00:00.000Z',to:'2026-10-07T23:59:59.999Z',availableCount:4,includedCount:2,hasMore:true,historySource:'elozi',attachmentsAnalyzed:false,...extra});
const message = (id,day,text='Mensagem de teste') => ({id,kind:'customer',text,senderName:'Pessoa do grupo',createdAt:`2026-10-0${day}T12:00:00.000Z`,attachments:[]});
const metadata = (g=group()) => ({...g,tenantId:'tenant-a',group:{title:g.title,description:'Descrição do grupo',type:'group',announcement:null,forum:false,source:'observed',availability:'available',observedAt:'2026-10-06T12:00:00.000Z'},topic:null,participants:{items:[{id:'person-a',name:'Pessoa observada',role:'unknown'}],total:10,complete:false,source:'observed',availability:'available',limit:40,truncated:true}});
const history = (g=group(),extra={}) => ({conversationId:g.conversationId,version:g.version,messages:[message('m5',5),message('m6',6)],coverage:coverage(),nextCursor:'opaque-own-cursor',...extra});
function fixture({intercept,groups=[group()],agents,ctxExtra={}}={}) {
  const ctx={active:true,workspaceId:'workspace-a',tenantId:'tenant-a',userId:'user-a',authorityKey:'authority-a',canSummarize:true,boot:{},session:{},...ctxExtra};
  const calls=[],opened=[],toasts=[],events=new Map(),modalEvents=new Map(),modalOpenings=[]; let paints=0,importPanel=null,importStatus=null;
  const modal={open:false,querySelector:selector=>selector==='[data-group-history-import-panel]'?importPanel:null,addEventListener:(name,handler)=>modalEvents.set(name,handler),close(){this.open=false;modalEvents.get('close')?.();}};
  const openModal=(title,subtitle,html)=>{modal.open=true;const token=html.match(/data-group-history-import-token="([^"]+)"/)?.[1];importPanel={dataset:{groupHistoryImportToken:token},innerHTML:html,contains:node=>node?.owner===importPanel,setAttribute(){},querySelector:()=>null};modalOpenings.push({title,subtitle,html});};
  const host={isConnected:true,dataset:{},innerHTML:'',contains:node=>node?.owner===host,querySelectorAll:()=>[],addEventListener:(name,handler)=>events.set(name,handler)};
  const fallback=(url,init)=>{
    const id=url.pathname.split('/conversations/')[1]?.split('/')[0],g=groups.find(group=>group.conversationId===id)||group();
    if(url.pathname.endsWith('/groups'))return{tenantId:ctx.tenantId,groups};
    if(url.pathname.endsWith('/group-context'))return metadata(g);
    if(url.pathname.endsWith('/group-history-import')){
      if(init.method==='POST'){const body=JSON.parse(init.body);importStatus={tenantId:ctx.tenantId,conversationId:g.conversationId,channelId:g.channelId,version:g.version,anchor:{available:true},state:'pending',job:{id:'import-a',commandId:body.commandId,requestedLimit:body.limit,state:'pending',counters:{imported:0,duplicates:0,excluded:0,requested:body.limit},createdAt:'2026-10-05T07:00:00Z',updatedAt:'2026-10-05T07:00:01Z'}};}
      return importStatus || {tenantId:ctx.tenantId,conversationId:g.conversationId,channelId:g.channelId,version:g.version,anchor:{available:true},state:'idle',job:null};
    }
    if(url.pathname.endsWith('/group-summary')){const body=JSON.parse(init.body);return{state:'ready',summary:'Resumo privado de teste',coverage:coverage({...body.after?{from:body.after}:{},...body.before?{to:body.before}:{}}),conversationId:g.conversationId,version:body.version,agentId:body.agentId,createdAt:'2026-10-07T12:00:00.000Z'};}
    return history(g,{coverage:coverage({...url.searchParams.has('after')?{from:url.searchParams.get('after')}:{},...url.searchParams.has('before')?{to:url.searchParams.get('before')}:{}})});
  };
  const api=async(path,init)=>{const url=new URL(path,'https://qa.invalid');calls.push({path,init});return intercept?intercept(url,init,()=>fallback(url,init)):fallback(url,init);};
  const ui=createGroupsWorkspaceUI({api,context:()=>ctx,openModal,getModal:()=>modal,getAgents:()=>agents||[{id:'hermes-a',name:'Hermes Interno',provider:'hermes',mode:'copilot',configured:true},{id:'disabled',name:'Não configurado',provider:'hermes',mode:'copilot',configured:false},{id:'api',name:'Outro agente',provider:'api',mode:'copilot',configured:true}],onPaint:()=>paints++,openConversation:(...args)=>opened.push(args),toast:(...args)=>toasts.push(args)});
  const node=(action,id,extra={})=>({owner:host,isConnected:true,dataset:{groupsAction:action,groupsToken:host.dataset.groupsToken,groupId:id,...extra}});
  const event=(selector,value,extra={})=>({target:{owner:host,value,...extra,matches:target=>target===selector},preventDefault(){}});
  function mount(){host.innerHTML=ui.render();host.dataset.groupsToken=host.innerHTML.match(/data-groups-token="([^"]+)"/)?.[1];return ui.bind(host);}
  const importNode=action=>({owner:importPanel,isConnected:true,dataset:{groupHistoryImportAction:action,groupHistoryImportToken:importPanel?.dataset.groupHistoryImportToken}});
  return{ui,ctx,host,calls,opened,toasts,node,event,events,mount,api,modal,openModal,modalOpenings,modalEvents,importNode,setImportStatus:value=>{importStatus=value;},get importHTML(){return importPanel?.innerHTML || '';},get paints(){return paints;}};
}

test('diretório por empresa identifica canal, histórico, não lidas e CTA de atendimento',async()=>{
  const env=fixture();await env.mount();assert.equal(env.calls.length,1);assert.equal(env.calls[0].path,'/api/tenants/tenant-a/groups');assert.equal(env.calls[0].init.headers['X-Elozi-Workspace'],'workspace-a');
  assert.ok(env.host.innerHTML.includes('Grupo Operação'));assert.ok(env.host.innerHTML.includes('WhatsApp Empresa'));assert.ok(env.host.innerHTML.includes('2 não lidas'));assert.ok(env.host.innerHTML.includes('4 no histórico'));
  await env.ui.handleAction(env.node('select','group-a'));assert.ok(env.host.innerHTML.includes('Quem falou no grupo'));assert.ok(env.host.innerHTML.includes('Pessoa do grupo'));assert.ok(env.host.innerHTML.includes('autores observados'));assert.ok(env.host.innerHTML.includes('não todos os membros'));assert.ok(!env.host.innerHTML.includes('Não configurado'));assert.ok(!env.host.innerHTML.includes('Outro agente'));assert.ok(env.paints>0);
});

test('grupos ausentes apontam Canais sem afirmar importação histórica',async()=>{
  const env=fixture({groups:[]});await env.mount();assert.ok(env.host.innerHTML.includes('Ainda não há grupos'));assert.ok(env.host.innerHTML.includes('href="#channels"'));assert.ok(!env.host.innerHTML.includes('Quem falou'));
});

test('busca e filtro por canal ficam locais e preservam a seleção autorizada',async()=>{
  const env=fixture({groups:[group(),group({conversationId:'group-b',title:'Equipe Telegram',channelId:'tg-b',channelName:'Telegram Operação',transport:'telegram-bot'})]});await env.mount();
  env.events.get('input')(env.event('[data-groups-search]','Telegram'));assert.ok(!env.host.innerHTML.includes('data-group-id="group-a"'));assert.ok(env.host.innerHTML.includes('data-group-id="group-b"'));
  env.events.get('input')(env.event('[data-groups-search]',''));env.events.get('change')(env.event('[data-groups-channel]','wa-a'));assert.ok(env.host.innerHTML.includes('data-group-id="group-a"'));assert.ok(!env.host.innerHTML.includes('data-group-id="group-b"'));assert.equal(env.calls.length,1);
});

test('trocar a conexão remove o detalhe de outro canal antes de permitir ações',async()=>{
  const env=fixture({groups:[group(),group({conversationId:'group-b',title:'Equipe Telegram',channelId:'tg-b',channelName:'Telegram Operação',transport:'telegram-bot'})]});await env.mount();await env.ui.handleAction(env.node('select','group-a'));
  env.events.get('change')(env.event('[data-groups-channel]','tg-b'));assert.ok(!env.host.innerHTML.includes('Descrição do grupo'));await env.ui.handleAction(env.node('reply'));assert.equal(env.opened.length,0);
});

test('atualizar diretório recarrega contexto e histórico selecionados, sem conservar resumo antigo',async()=>{
  const env=fixture();await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));assert.ok(env.host.innerHTML.includes('Resumo privado de teste'));
  const n=env.calls.length;await env.ui.handleAction(env.node('refresh'));assert.equal(env.calls.length,n+3);assert.ok(!env.host.innerHTML.includes('Resumo privado de teste'));assert.ok(env.host.innerHTML.includes('Pessoa do grupo'));
});

for(const action of ['open','reply','schedule'])test(`${action} só abre atendimento existente, sem POST ou envio`,async()=>{
  const env=fixture();await env.mount();await env.ui.handleAction(env.node('select','group-a'));const calls=env.calls.length;await env.ui.handleAction(env.node(action));
  assert.deepEqual(env.opened,[['group-a','tenant-a',{intent:action==='open'?null:action}]]);assert.equal(env.calls.length,calls);assert.ok(env.calls.every(call=>call.init.method==='GET'));
});

test('Mensagens anteriores usa cursor opaco e acrescenta antes da página atual em ordem',async()=>{
  const env=fixture({intercept:(url,init,fallback)=>url.searchParams.has('cursor')?history(group(),{messages:[message('m2',2),message('m3',3)],coverage:coverage({hasMore:false}),nextCursor:null}):fallback()});
  await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('older'));
  assert.ok(env.calls.at(-1).path.includes('cursor=opaque-own-cursor'));assert.ok(env.host.innerHTML.includes('4 mensagens visíveis'));assert.ok(env.host.innerHTML.indexOf('datetime="2026-10-02T12:00:00.000Z"')<env.host.innerHTML.indexOf('datetime="2026-10-06T12:00:00.000Z"'));assert.ok(!env.host.innerHTML.includes('data-groups-action="older"'));
});

for(const [label,mutate] of [
  ['conversa divergente',r=>{r.conversationId='other';}],['versão velha',r=>{r.version=1;}],['ordem invertida',r=>{r.messages.reverse();}],['ID duplicado',r=>{r.messages[1].id=r.messages[0].id;}],['cobertura falsa',r=>{r.coverage.includedCount=3;}],['mídia interpretada',r=>{r.coverage.attachmentsAnalyzed=true;}],['origem externa',r=>{r.coverage.historySource='whatsapp';}],['cursor incoerente',r=>{r.nextCursor=null;}],['data fora do período',r=>{r.messages[0].createdAt='2025-01-01T00:00:00.000Z';}],['arquivo inválido',r=>{r.messages[0].attachments=[{id:'a',kind:'video',name:'video',mime:'video/mp4',size:-1}];}]
])test(`histórico recusa ${label} sem mostrar leitura parcial`,async()=>{
  const env=fixture({intercept:(url,init,fallback)=>{const r=fallback();if(url.pathname.endsWith('/group-history'))mutate(r);return r;}});await env.mount();await env.ui.handleAction(env.node('select','group-a'));
  assert.ok(env.host.innerHTML.includes('dados consistentes'));assert.ok(!env.host.innerHTML.includes('Pessoa do grupo'));
});

test('cursores repetidos e páginas sobrepostas são recusados mantendo a página aceita',async()=>{
  const env=fixture();await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('older'));
  assert.ok(env.host.innerHTML.includes('dados consistentes'));assert.ok(env.host.innerHTML.includes('2 mensagens visíveis'));
});

test('contrato real de groupHistory aceita tamanho de mídia não informado sem inventar zero',async()=>{
  const conversation={id:'group-a',channelId:'wa-a',conversationKind:'group',version:2,messages:[{...message('m5',5),attachments:[{kind:'video',name:'Video de teste',mime:'video/mp4'}]}]};
  const env=fixture({intercept:(url,init,fallback)=>url.pathname.endsWith('/group-history')?groupHistory(conversation,{limit:50},{tenantId:'tenant-a',now:Date.parse('2026-10-07T23:00:00.000Z')}):fallback()});
  await env.mount();await env.ui.handleAction(env.node('select','group-a'));assert.ok(env.host.innerHTML.includes('Video de teste'));assert.ok(env.host.innerHTML.includes('tamanho não informado'));assert.ok(!env.host.innerHTML.includes('dados consistentes'));
});

for(const [label,mutate] of [['tenant',r=>{r.tenantId='other';}],['grupo repetido',r=>{r.groups.push(structuredClone(r.groups[0]));}],['quantidade insegura',r=>{r.groups[0].unread=-1;}]])test(`diretório recusa ${label}`,async()=>{
  const env=fixture({intercept:(url,init,fallback)=>{const r=fallback();mutate(r);return r;}});await env.mount();assert.ok(env.host.innerHTML.includes('dados consistentes'));assert.ok(!env.host.innerHTML.includes('Grupo Operação'));
});

for(const [label,mutate] of [['roster presumido',r=>{r.participants.complete=true;}],['pessoa sem identidade',r=>{r.participants.items[0].id='';}],['total menor',r=>{r.participants.total=0;}],['origem forjada',r=>{r.group.source='all-members';}]])test(`contexto recusa ${label}, sem inventar participantes`,async()=>{
  const env=fixture({intercept:(url,init,fallback)=>{const r=fallback();if(url.pathname.endsWith('/group-context'))mutate(r);return r;}});await env.mount();await env.ui.handleAction(env.node('select','group-a'));assert.ok(env.host.innerHTML.includes('dados consistentes'));assert.ok(!env.host.innerHTML.includes('Pessoa observada'));
});

test('contexto do backend admite descrição e data de cache ausentes sem anunciar consulta ao vivo',async()=>{
  const env=fixture({intercept:(url,init,fallback)=>{const r=fallback();if(url.pathname.endsWith('/group-context'))Object.assign(r.group,{description:null,observedAt:null,source:'cache'});return r;}});
  await env.mount();await env.ui.handleAction(env.node('select','group-a'));assert.ok(env.host.innerHTML.includes('Último contexto salvo'));assert.ok(!env.host.innerHTML.includes('dados consistentes'));assert.ok(!env.host.innerHTML.includes('ao vivo'));
});

test('resumo privado usa somente Hermes configurado, versão atual e comando único; nunca envia',async()=>{
  const env=fixture();await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));
  const call=env.calls.at(-1),body=JSON.parse(call.init.body);assert.ok(call.path.endsWith('/group-summary'));assert.equal(call.init.method,'POST');assert.equal(body.agentId,'hermes-a');assert.equal(body.version,2);assert.equal(body.limit,100);assert.match(body.commandId,/^[a-f\d-]{36}$/);assert.equal('send' in body,false);assert.equal('text' in body,false);assert.ok(env.host.innerHTML.includes('Resumo privado de teste'));assert.ok(env.host.innerHTML.includes('não será enviado ao grupo'));assert.ok(env.host.innerHTML.includes('Mídias não analisadas'));assert.equal(env.opened.length,0);
});

for(const extra of [{ctxExtra:{canSummarize:false}},{agents:[]}])test(`resumo sem ${extra.agents?'Hermes configurado':'permissão'} não chama o provedor`,async()=>{
  const env=fixture(extra);await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));assert.ok(!env.calls.some(call=>call.init.method==='POST'));
});

test('resumo em execução impede duplo clique; trocar agente aborta e recusa resultado antigo',async()=>{
  const slow=pending(),env=fixture({intercept:(url,init,fallback)=>url.pathname.endsWith('/group-summary')?slow.promise:fallback()});await env.mount();await env.ui.handleAction(env.node('select','group-a'));
  const job=env.ui.handleAction(env.node('summary'));await env.ui.handleAction(env.node('summary'));assert.equal(env.calls.filter(call=>call.init.method==='POST').length,1);
  const call=env.calls.at(-1),body=JSON.parse(call.init.body);env.events.get('change')(env.event('[data-groups-agent]','different'));assert.equal(call.init.signal.aborted,true);
  slow.resolve({state:'ready',summary:'Resumo antigo',coverage:coverage(),conversationId:'group-a',version:2,agentId:body.agentId,createdAt:'2026-10-07T12:00:00.000Z'});await job;assert.ok(!env.host.innerHTML.includes('Resumo antigo'));
});

test('erro de provedor não revela payload ou chave e permite nova tentativa',async()=>{
  let fail=true;const env=fixture({intercept:(url,init,fallback)=>{if(url.pathname.endsWith('/group-summary')&&fail)throw new Error('private-key-customer-payload');return fallback();}});await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));
  assert.ok(!env.host.innerHTML.includes('private-key'));assert.ok(env.host.innerHTML.includes('Confira a conexão'));fail=false;await env.ui.handleAction(env.node('summary'));assert.ok(env.host.innerHTML.includes('Resumo privado de teste'));
});

test('resumo parcial identifica texto reduzido mesmo quando a contagem de mensagens está completa',async()=>{
  const env=fixture({intercept:(url,init,fallback)=>{const r=fallback();if(url.pathname.endsWith('/group-summary'))Object.assign(r.coverage,{textTruncated:true,availableCount:2,includedCount:2,hasMore:false});return r;}});
  await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));assert.ok(env.host.innerHTML.includes('Parte do texto foi reduzida'));assert.ok(env.host.innerHTML.includes('Resumo privado de teste'));assert.ok(!env.host.innerHTML.includes('Há mensagens fora deste resumo'));
  assert.ok(env.host.innerHTML.includes('24 KiB'));assert.ok(!env.host.innerHTML.includes('32 KiB'));
});

test('mudança de seleção cancela histórico/contexto e respostas antigas não aparecem no novo grupo',async()=>{
  const slowHistory=pending(),slowMetadata=pending(),groups=[group(),group({conversationId:'group-b',title:'Outro Grupo'})];
  const env=fixture({groups,intercept:(url,init,fallback)=>url.pathname.includes('/group-a/')?url.pathname.endsWith('/group-context')?slowMetadata.promise:slowHistory.promise:fallback()});await env.mount();
  const old=env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('select','group-b'));assert.ok(env.calls.slice(1,3).every(call=>call.init.signal.aborted));
  const html=env.host.innerHTML;slowHistory.resolve(history());slowMetadata.resolve(metadata());await old;assert.equal(env.host.innerHTML,html);assert.ok(env.host.innerHTML.includes('Outro Grupo'));
});

for(const [label,change] of [['empresa',e=>{e.ctx.tenantId='tenant-b';}],['workspace',e=>{e.ctx.workspaceId='workspace-b';}],['pessoa',e=>{e.ctx.userId='user-b';}],['autoridade',e=>{e.ctx.authorityKey='new-authority';}],['boot',e=>{e.ctx.boot={};}],['sessão',e=>{e.ctx.session={};}],['rota',e=>{e.ctx.active=false;}],['permissão',e=>{e.ctx.canSummarize=false;}],['reset',e=>{e.ui.reset();}]])test(`resposta atrasada após ${label} é cancelada sem dados de outro contexto`,async()=>{
  const slow=pending(),env=fixture({intercept:()=>slow.promise});const mounting=env.mount();change(env);env.ui.syncContext();assert.equal(env.calls[0].init.signal.aborted,true);
  slow.resolve({tenantId:'tenant-a',groups:[group({title:'Título privado antigo'})]});await mounting;assert.ok(!env.host.innerHTML.includes('Título privado antigo'));
});

test('ABA com reset mantém apenas resposta da nova identidade/contexto',async()=>{
  const slow=pending();let first=true;const env=fixture({intercept:(url,init,fallback)=>first?(first=false,slow.promise):fallback()});const old=env.mount();env.ctx.authorityKey='second';env.ui.reset();env.ctx.authorityKey='authority-a';await env.mount();const html=env.host.innerHTML;slow.resolve({tenantId:'tenant-a',groups:[group({title:'Leitura antiga'})]});await old;assert.equal(env.host.innerHTML,html);assert.equal(env.calls[0].init.signal.aborted,true);
});

test('403 retira contexto e histórico da tela em vez de conservar dados após acesso perdido',async()=>{
  const env=fixture({intercept:(url,init,fallback)=>{if(url.pathname.endsWith('/group-summary'))throw Object.assign(new Error('private payload'),{status:403});return fallback();}});await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));assert.ok(!env.host.innerHTML.includes('Pessoa do grupo'));assert.ok(!env.host.innerHTML.includes('Descrição do grupo'));assert.equal(env.toasts.at(-1)[1],true);
});

test('ações forjadas, desconectadas ou com token anterior não consultam nem abrem atendimento',async()=>{
  const env=fixture();await env.mount();const old=env.node('refresh');env.ui.reset();await env.mount();const n=env.calls.length;await env.ui.handleAction(old);const off=env.node('select','group-a');off.isConnected=false;await env.ui.handleAction(off);const outside=env.node('refresh');outside.owner={};await env.ui.handleAction(outside);await env.ui.handleAction(env.node('select','not-visible'));assert.equal(env.calls.length,n);assert.equal(env.opened.length,0);
});

test('resposta assíncrona não toma foco de fora da tela de grupos',async t=>{
  const old=globalThis.document,outside={isConnected:true},document={activeElement:outside};globalThis.document=document;t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
  const slow=pending(),env=fixture({intercept:()=>slow.promise});let focus=0;env.host.querySelectorAll=()=>[{dataset:{groupsFocus:'search'},focus(){focus++;}}];const mounted=env.mount();slow.resolve({tenantId:'tenant-a',groups:[group()]});await mounted;assert.equal(document.activeElement,outside);assert.equal(focus,0);
});

test('busca preserva foco e posição do cursor dentro do mesmo contexto',async t=>{
  const old=globalThis.document,document={activeElement:null};globalThis.document=document;t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
  const env=fixture();await env.mount();const selections=[],replacement={owner:env.host,dataset:{groupsFocus:'search'},focus(){document.activeElement=this;},setSelectionRange(...range){selections.push(range);}};env.host.querySelectorAll=()=>[replacement];
  document.activeElement={owner:env.host,dataset:{groupsFocus:'search'},selectionStart:2,selectionEnd:2};env.events.get('input')(env.event('[data-groups-search]','Op'));assert.equal(document.activeElement,replacement);assert.deepEqual(selections,[[2,2]]);
});

test('período valida ambas datas e31 dias antes da rede e aplica after/before ISO em histórico/resumo',async()=>{
  const env=fixture();await env.mount();await env.ui.handleAction(env.node('select','group-a'));const before=env.calls.length;
  const form=(from,to)=>env.event('[data-groups-period]',null,{dataset:{groupsToken:env.host.dataset.groupsToken},elements:{from:{value:from},to:{value:to}}});
  await env.events.get('submit')(form('2026-10-01',''));await env.events.get('submit')(form('2026-10-10','2026-10-01'));await env.events.get('submit')(form('2026-02-30','2026-03-01'));await env.events.get('submit')(form('2026-08-01','2026-10-01'));assert.equal(env.calls.length,before);assert.ok(env.host.innerHTML.includes('Informe as duas datas'));
  await env.events.get('submit')(form('2026-10-01','2026-10-07'));const call=env.calls.findLast(call=>call.path.includes('/group-history'));const url=new URL(call.path,'https://qa.invalid');assert.ok(url.searchParams.has('after'));assert.ok(url.searchParams.has('before'));await env.ui.handleAction(env.node('summary'));const body=JSON.parse(env.calls.at(-1).init.body);assert.equal(body.after,url.searchParams.get('after'));assert.equal(body.before,url.searchParams.get('before'));
});

test('texto do grupo, pessoa, mensagem e resumo é escapado; anexos não viram links ou HTML ativos',async()=>{
  const env=fixture({groups:[group({title:'Grupo <svg onload=1>'})],intercept:(url,init,fallback)=>{const r=fallback();if(url.pathname.endsWith('/group-context'))r.group.description='<script>bad</script>';if(url.pathname.endsWith('/group-history')){r.messages[0].text='<img src=x onerror=1>';r.messages[0].senderName='<svg onload=1>';r.messages[0].attachments=[{id:'safe',kind:'video',name:'<img onerror=1>',mime:'video/mp4',size:10}];}if(url.pathname.endsWith('/group-summary'))r.summary='<script>summary</script>';return r;}});
  await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));assert.ok(env.host.innerHTML.includes('&lt;script&gt;'));assert.ok(env.host.innerHTML.includes('&lt;img'));assert.ok(!env.host.innerHTML.includes('<script>'));assert.ok(!env.host.innerHTML.includes('<img'));assert.ok(!env.host.innerHTML.includes('href="http'));
});

test('Grupos vive na aba Grupo da caixa: groups-workspace.css removido no P10, textos longos contidos e foco visível sem !important',()=>{
  assert.equal(existsSync(new URL('../public/groups-workspace.css',import.meta.url)),false);
  const css=readFileSync(new URL('../public/screen-inbox.css',import.meta.url),'utf8');assert.ok(css.includes('.groups-workspace--panel'));assert.ok(css.includes('overflow-wrap: anywhere'));assert.ok(css.includes(':focus-visible'));assert.ok(css.includes('minmax(0, 1fr)'));assert.ok(!css.includes('!important'));
});

const appSource=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function appFixture({permissions=['inbox.read','inbox.reply'],reply=true,coordinate=true,select,intercept}={}){
  const env=fixture({intercept}),effects=[],selections=[];
  const conversation={id:'group-a',conversationKind:'group',assignedUserId:'user-a',status:'open'};
  const state={view:'groups',workspaceId:'workspace-a',supportGrantId:null,tenant:{id:'tenant-a',agents:[{id:'hermes-a',name:'Hermes Interno',provider:'hermes',mode:'copilot',configured:true}],conversations:[conversation]},boot:{csrfToken:'synthetic-csrf',session:{userId:'user-a',role:'operator',permissions},tenants:[{id:'tenant-a'}]}};
  const line=prefix=>appSource.split('\n').find(text=>text.startsWith(prefix));
  const executable=[
    excerpt('permissions'),
    line('const inboxContactAuthority='),
    excerpt('groups-workspace-ui'),
    excerpt('navigation-render'),
    excerpt('attendance-action'),
    excerpt('navigate')
  ].join('\n')+'\n({ui:groupsWorkspaceUI,openGroupConversation,navigationMarkup,navigate})';
  const selected=async(tid,cid,options)=>{
    selections.push({tid,cid,options});if(!options.isCurrent())return;
    const result=select?await select({state,options,conversation}):conversation;
    if(result){state.view='inbox';state.conversation=cid;}
    return result;
  };
  const vm=runInNewContext(executable,{...i18n,
    state,createGroupsWorkspaceUI,api:env.api,openModal:env.openModal,
    escape:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    toast:(...args)=>env.toasts.push(args),icon:()=>'<svg></svg>',
    avatarUI:{markup:(...args)=>{effects.push(['avatar',...args]);return'<span class="avatar">QA</span>';},bind:()=>effects.push(['avatars-bound'])},
    selectInboxConversation:selected,canReplyTo:()=>reply,canCoordinate:()=>coordinate,
    setComposerMode:mode=>effects.push(['composer',mode]),currentConversation:()=>conversation,
    showSchedules:async()=>effects.push(['existing-schedules']),
    consolidatedInbox:{data:{counts:{active:0}}},activeConversations:()=>[],
    mediaUI:{sending:false},voiceRecorder:{busy:false},blockPendingSend:()=>false,
    contactLinksUI:{reset(){}},platformUsersUI:{reset(){}},commercialUsageUI:{reset(){}},contactRefresh:{reset(){}},memoryUI:{reset(){}},teamChatUI:{reset(){}},
    render:()=>effects.push(['render']),focusViewContent:()=>{},loadNavigatedPanels:()=>{},
    refreshInboxList:async()=>{},location:{hash:'groups'},$:selector=>selector==='#modal'?env.modal:null,window:{scrollTo(){}},
    ...nav,...shell
  });
  async function mount(){env.host.innerHTML=vm.ui.render();env.host.dataset.groupsToken=env.host.innerHTML.match(/data-groups-token="([^"]+)"/)?.[1];await vm.ui.bind(env.host);}
  return{...env,...vm,state,effects,selections,mount};
}

test('factory servida liga avatar privado, copiloto, contexto e autoridade reais da aplicação',async()=>{
  const env=appFixture();await env.mount();assert.ok(env.effects.some(e=>e[0]==='avatar'&&e[4].kind==='conversations'&&e[4].id==='group-a'));assert.ok(env.effects.some(e=>e[0]==='avatars-bound'));
  await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));assert.equal(JSON.parse(env.calls.at(-1).init.body).agentId,'hermes-a');
  env.state.boot.session.permissions=['inbox.read'];env.ui.syncContext();assert.ok(!env.host.innerHTML.includes('Resumo privado de teste'));
});

test('importação só aparece e consulta no WhatsApp com gestão humana e leitura fora do suporte',async()=>{
  for(const blocked of ['operator','read','support','service','telegram']){
    const ctxExtra={canManageChannels:true,canReadInbox:true,kind:'human'};
    if(blocked==='operator')ctxExtra.canManageChannels=false;if(blocked==='read')ctxExtra.canReadInbox=false;if(blocked==='support')ctxExtra.supportGrantId='delegated';if(blocked==='service')ctxExtra.kind='service';
    const env=fixture({ctxExtra,groups:[group(blocked==='telegram'?{transport:'telegram-bot',channelId:'tg-a'}:{})]});await env.mount();await env.ui.handleAction(env.node('select','group-a'));const count=env.calls.length;
    assert.ok(!env.host.innerHTML.includes('data-groups-action="import-history"'),blocked);assert.equal(await env.ui.handleAction(env.node('import-history')),false);assert.equal(env.calls.length,count);assert.equal(env.modal.open,false);
  }
  const env=fixture({ctxExtra:{canManageChannels:true,canReadInbox:true,kind:'human'}});await env.mount();await env.ui.handleAction(env.node('select','group-a'));
  assert.ok(env.host.innerHTML.includes('Buscar histórico antigo'));assert.equal(await env.ui.handleAction(env.node('import-history')),true);assert.equal(env.calls.at(-1).path,'/api/tenants/tenant-a/conversations/group-a/group-history-import');assert.equal(env.calls.at(-1).init.method,'GET');env.ui.reset();assert.equal(env.modal.open,false);
});

test('botão servido calcula administração real sem criar channels.manage e bloqueia suporte/serviço',async()=>{
  for(const blocked of ['operator','support-state','support-session','service']){
    const env=appFixture();if(blocked!=='operator')env.state.boot.session.role='reseller';if(blocked==='support-state')env.state.supportGrantId='grant';if(blocked==='support-session')env.state.boot.session.supportGrantId='grant';if(blocked==='service')env.state.boot.session.kind='service';
    await env.mount();await env.ui.handleAction(env.node('select','group-a'));assert.equal(await env.ui.handleAction(env.node('import-history')),false);assert.ok(!env.host.innerHTML.includes('data-groups-action="import-history"'));assert.equal(env.modal.open,false);
  }
  const env=appFixture();env.state.boot.session.role='reseller';await env.mount();await env.ui.handleAction(env.node('select','group-a'));assert.equal(await env.ui.handleAction(env.node('import-history')),true);assert.equal(env.calls.at(-1).init.headers['X-CSRF-Token'],'synthetic-csrf');env.ui.reset();
});

test('delegação encapsulada do modal envia só por ação explícita e atualiza histórico após completed',async()=>{
  const env=fixture({ctxExtra:{canManageChannels:true,canReadInbox:true,kind:'human'}});await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('import-history'));
  assert.equal(env.calls.filter(c=>c.init.method==='POST').length,0);
  const click=action=>env.modalEvents.get('click')?.({target:{closest:selector=>selector==='[data-group-history-import-action]'?env.importNode(action):null},preventDefault(){}});
  click('start');await new Promise(resolve=>setImmediate(resolve));const writing=env.calls.filter(c=>c.init.method==='POST');assert.equal(writing.length,1);const body=JSON.parse(writing[0].init.body);
  const before=env.calls.length;env.setImportStatus({tenantId:'tenant-a',conversationId:'group-a',channelId:'wa-a',version:3,anchor:{available:true},state:'completed',job:{id:'import-a',commandId:body.commandId,requestedLimit:body.limit,state:'completed',counters:{imported:2,duplicates:0,excluded:0,requested:50},createdAt:'2026-10-05T07:00:00Z',updatedAt:'2026-10-05T07:00:02Z'}});
  click('refresh');await new Promise(resolve=>setImmediate(resolve));assert.equal(env.calls.slice(before).filter(c=>c.path.endsWith('/groups')).length,1);assert.ok(env.calls.slice(before).some(c=>c.path.endsWith('/group-context')));assert.ok(env.calls.slice(before).some(c=>c.path.includes('/group-history?')));assert.equal(env.modal.open,true);assert.ok(env.importHTML.includes('Busca concluída'));assert.equal(env.opened.length,0);env.ui.reset();
});

test('troca de grupo ou reset do workspace encerra modal encapsulado e ignora consulta atrasada',async()=>{
  const response=pending(),env=fixture({ctxExtra:{canManageChannels:true,canReadInbox:true,kind:'human'},groups:[group(),group({conversationId:'group-b'})],intercept:(url,_init,fallback)=>url.pathname.endsWith('/group-history-import')?response.promise:fallback()});
  await env.mount();await env.ui.handleAction(env.node('select','group-a'));const opening=env.ui.handleAction(env.node('import-history')),request=env.calls.at(-1);
  await env.ui.handleAction(env.node('select','group-b'));assert.equal(env.modal.open,false);assert.equal(request.init.signal.aborted,true);response.resolve({tenantId:'tenant-a',conversationId:'group-a',channelId:'wa-a',version:2,anchor:{available:true},state:'idle',job:null});assert.equal(await opening,false);assert.equal(env.modal.open,false);
  env.ui.reset();assert.ok(!env.host.innerHTML.includes('Buscar histórico antigo'));
});

test('resumo formata negrito/linhas somente após escape, mantendo HTML e links como texto',async()=>{
  const payload='**Resumo da operação**\nLinha seguinte\n\n**<img src=x onerror=alert(1)>**\n[abrir](javascript:alert(1))\n<a href="javascript:1">link</a>\n&langle;script&rangle;\n__sem transformação__';
  const env=fixture({intercept:(url,_init,fallback)=>{const value=fallback();if(url.pathname.endsWith('/group-summary'))value.summary=payload;return value;}});await env.mount();await env.ui.handleAction(env.node('select','group-a'));await env.ui.handleAction(env.node('summary'));
  assert.ok(env.host.innerHTML.includes('<p><strong>Resumo da operação</strong></p><p>Linha seguinte</p>'));assert.ok(env.host.innerHTML.includes('<strong>&lt;img'));assert.ok(env.host.innerHTML.includes('&lt;a href=&quot;javascript:1&quot;&gt;'));
  for(const forbidden of ['**Resumo da operação**','<img src=x','<a href="javascript','<script','<iframe'])assert.ok(!env.host.innerHTML.includes(forbidden));assert.ok(env.host.innerHTML.includes('[abrir](javascript:alert(1))'));assert.ok(env.host.innerHTML.includes('__sem transformação__'));assert.ok(env.host.innerHTML.includes('groups-summary-break'));
});

test('navegação real apresenta Grupos somente com leitura e empresa autorizadas',()=>{
  const env=appFixture();assert.ok(env.navigationMarkup().includes('data-view="groups"'));
  env.state.boot.session.permissions=['contacts.read'];assert.ok(!env.navigationMarkup().includes('data-view="groups"'));
  env.state.boot.session.permissions=['inbox.read'];env.state.tenant=null;assert.ok(!env.navigationMarkup().includes('data-view="groups"'));
});

for(const intent of [null,'reply','schedule'])test(`ponte real para atendimento usa seleção protegida e intenção ${intent||'consultar'}`,async()=>{
  const env=appFixture();await env.mount();await env.ui.handleAction(env.node('select','group-a'));const before=env.calls.length;
  await env.ui.handleAction(env.node(intent||'open'));assert.equal(env.selections.length,1);assert.equal(env.selections[0].tid,'tenant-a');assert.equal(env.selections[0].cid,'group-a');assert.equal(env.selections[0].options.fromContact,true);assert.equal(env.state.view,'inbox');assert.equal(env.calls.length,before);
  assert.equal(env.effects.some(e=>e[0]==='composer'),intent==='reply');assert.equal(env.effects.some(e=>e[0]==='existing-schedules'),intent==='schedule');
});

for(const intent of ['reply','schedule'])test(`ponte ${intent} abre conversa mas respeita responsável sem assumir ou enviar`,async()=>{
  const env=appFixture({reply:false,coordinate:false});await env.openGroupConversation('group-a','tenant-a',{intent});assert.equal(env.state.view,'inbox');assert.equal(env.selections.length,1);assert.equal(env.calls.length,0);assert.ok(env.toasts.length);assert.ok(!env.effects.some(e=>['composer','existing-schedules'].includes(e[0])));
});

test('seleção atrasada com autoridade ou sessão trocada não abre compositor nem agendamento',async()=>{
  const slow=pending(),env=appFixture({select:()=>slow.promise});const opening=env.openGroupConversation('group-a','tenant-a',{intent:'schedule'});
  env.state.boot.session={...env.state.boot.session,userId:'user-b'};slow.resolve({id:'group-a'});await opening;assert.ok(!env.effects.some(e=>e[0]==='existing-schedules'));assert.equal(env.calls.length,0);
});

test('callback servido recusa navegação de outra empresa e UI real cancela leitura ao navegar',async()=>{
  const slow=pending(),env=appFixture({intercept:()=>slow.promise});await env.openGroupConversation('group-a','tenant-b',{intent:'reply'});assert.equal(env.selections.length,0);
  const mounting=env.mount();env.navigate('guide');assert.equal(env.calls[0].init.signal.aborted,true);slow.resolve({tenantId:'tenant-a',groups:[group({title:'Grupo privado antigo'})]});await mounting;assert.ok(!env.host.innerHTML.includes('Grupo privado antigo'));assert.equal(env.state.view,'guide');
});

test('render sem mudança de autoridade preserva consulta; boot novo retira contexto anterior',async()=>{
  const env=appFixture();await env.mount();await env.ui.handleAction(env.node('select','group-a'));env.state.scopedRunsEpoch=15;env.ui.syncContext();assert.ok(env.host.innerHTML.includes('Pessoa do grupo'));
  env.state.boot={...env.state.boot};env.ui.syncContext();assert.ok(!env.host.innerHTML.includes('Pessoa do grupo'));
});
