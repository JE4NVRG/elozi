import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceHandoffsUI,serviceHandoffsContextKey } from '../public/service-handoffs-ui.js';

const handoff = (extra = {}) => ({id:'request-a',serviceId:'service-a',serviceName:'Hermes sintético',conversationId:'conversation-a',conversationVersion:7,
  reason:'Preciso de apoio humano.',state:'pending',version:3,createdAt:'2026-10-03T12:00:00Z',updatedAt:'2026-10-03T12:00:00Z',decidedBy:null,decisionReason:null,...extra});
function fixture(t,intercept) {
  const context = {active:true,workspaceId:'workspace-a',tenantId:'tenant-a',conversationId:'conversation-a',userId:'person-a',authorityKey:'authority-a',
    supportGrantId:'grant-a',channelId:'whatsapp-a',departmentId:'support',assignedUserId:'person-a',assignedSupportGrantId:'grant-a',status:'active',canDecide:true};
  const calls = [],messages = [],updates = [],opened = [],listeners = new Map(); let rows = [handoff()];
  const modal = {closed:false,open:false,panel:null,querySelector(selector){return selector === '[data-service-handoffs-panel]' ? this.panel : null;},
    addEventListener(event,fn){listeners.set(event,fn);},close(){this.closed=true;this.open=false;listeners.get('close')?.();}};
  const defaultResponse = (path,init) => {
    if (init.method === 'GET') return {requests:structuredClone(rows)};
    assert.ok(path.endsWith('/service-handoffs/request-a'));
    assert.equal(init.method,'POST');
    const payload = JSON.parse(init.body),item = handoff({version:4,state:payload.action === 'acknowledge' ? 'acknowledged' : 'declined',decidedBy:context.userId,decisionReason:payload.reason});
    rows = [item];return {request:item};
  };
  const ui = createServiceHandoffsUI({getContext:()=>context,request:async(path,init)=>{calls.push({path,init});return intercept ? intercept(path,init,defaultResponse) : defaultResponse(path,init);},
    openModal(title,subtitle,html){
      const token = html.match(/data-service-handoff-token="([^"]*)"/)[1];
      const body = {innerHTML:html},panel = {dataset:{serviceHandoffToken:token},body,reason:null,contains:node=>node?.panel === panel,
        querySelector(selector){return selector === '[data-service-handoffs-body]' ? body : selector === 'textarea[name="reason"]' ? this.reason : null;}};
      modal.title=title;modal.closed=false;modal.open=true;modal.panel=panel;opened.push({title,subtitle,html});
    },getModal:()=>modal,toast:(message,error)=>messages.push({message,error}),onError:message=>messages.push({message,error:true}),onUpdate:result=>updates.push(result)});
  const html = () => modal.panel?.body.innerHTML || '';
  function form(reason = 'Revisado pela equipe.') {
    const editor = html().match(/data-service-handoff-editor="([^"]+)"/);assert.ok(editor,'o editor deve estar aberto');
    const field = {value:reason};modal.panel.reason=field;
    return {dataset:{serviceHandoffForm:'decision',serviceHandoffToken:modal.panel.dataset.serviceHandoffToken,serviceHandoffEditor:editor[1]},panel:modal.panel,elements:{namedItem:name=>name==='reason'?field:null}};
  }
  const node = (action,id='') => ({dataset:{serviceHandoffAction:action,serviceHandoffToken:modal.panel?.dataset.serviceHandoffToken,id},panel:modal.panel});
  t.after(()=>ui.reset());
  return {ui,context,calls,messages,updates,opened,modal,html,form,node,setRows:value=>{rows=value;}};
}

test('lista pertence à empresa/conversa/grant e mostra apenas metadados autorizados com escape',async t=>{
  const f=fixture(t);f.setRows([handoff({serviceName:'<script>bad()</script>',reason:'<img src=x onerror=bad()>',secret:'never-render',state:'declined',decisionReason:'<b>Não necessário</b>'})]);
  assert.match(f.ui.markup(),/data-service-handoff-action="open"/);await f.ui.open();
  assert.equal(f.calls[0].path,'/api/tenants/tenant-a/conversations/conversation-a/service-handoffs');
  assert.deepEqual(f.calls[0].init.headers,{'X-Elozi-Workspace':'workspace-a','X-Elozi-Support-Grant':'grant-a'});
  assert.ok(f.html().includes('&lt;script&gt;'));assert.ok(f.html().includes('&lt;img'));assert.ok(f.html().includes('&lt;b&gt;'));
  assert.equal(f.html().includes('never-render'),false);assert.equal(f.html().includes('<script>'),false);
  assert.match(f.html(),/Marcar como visto registra a sua revisão e não transfere a conversa/);assert.match(f.html(),/Recusada/);assert.match(f.html(),/Histórico preservado/);
});

test('observador e colaborador consultam, mas canReply não concede decisão de responsável',async t=>{
  const f=fixture(t);f.context.canDecide=false;f.context.canReply=true;await f.ui.open();
  assert.match(f.html(),/Somente o responsável atual/);assert.equal(f.html().includes('data-service-handoff-action="acknowledge"'),false);
  await f.ui.action('acknowledge','request-a');assert.equal(f.calls.length,1);assert.equal(f.html().includes('data-service-handoff-form'),false);
});

test('marcar como visto exige revisão explícita e envia só CAS, ação e motivo sem envio/transferência',async t=>{
  const f=fixture(t);await f.ui.open();await f.ui.handleAction(f.node('acknowledge','request-a'));
  assert.equal(f.calls.length,1);assert.match(f.html(),/Motivo da sua decisão/);await f.ui.submit(f.form('  Apoio conferido.  '));
  const post=f.calls[1];assert.deepEqual(JSON.parse(post.init.body),{version:3,action:'acknowledge',reason:'Apoio conferido.'});
  assert.match(post.path,/service-handoffs\/request-a$/);assert.equal(f.calls.length,2);assert.equal(f.updates.length,1);
  assert.match(f.html(),/Marcado como visto/);assert.match(f.html(),/não foi transferida/);assert.equal(f.html().includes('data-service-handoff-form'),false);
  assert.equal(f.calls.some(call=>/messages|transfer|take|reply/.test(call.path)),false);assert.equal(f.messages.filter(message=>!message.error).length,1);
});

test('recusa mantém motivo no histórico e não altera atribuição nem mensagem',async t=>{
  const f=fixture(t);await f.ui.open();await f.ui.action('decline','request-a');await f.ui.submit(f.form('Solicitação fora do contexto.'));
  assert.deepEqual(JSON.parse(f.calls[1].init.body),{version:3,action:'decline',reason:'Solicitação fora do contexto.'});
  assert.match(f.html(),/Recusada/);assert.match(f.html(),/Solicitação fora do contexto/);assert.equal(f.context.assignedUserId,'person-a');
});

test('motivo vazio ou maior que500 impede POST e formulário400 mantém texto para correção',async t=>{
  let failing=true;const f=fixture(t,(path,init,fallback)=>{if(init.method==='POST'&&failing)throw Object.assign(new Error('Motivo inválido.'),{status:400});return fallback(path,init);});
  await f.ui.open();await f.ui.action('decline','request-a');await f.ui.submit(f.form('   '));assert.match(f.html(),/entre 1 e 500/);
  await f.ui.submit(f.form('x'.repeat(501)));assert.equal(f.calls.length,1);
  const form=f.form('Texto preservado');await f.ui.submit(form);assert.match(f.html(),/Motivo inválido/);assert.match(f.html(),/Texto preservado/);
  failing=false;await f.ui.submit(form);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,2);assert.match(f.html(),/Recusada/);
});

test('duplo submit não duplica decisão e 409 recarrega sem repetir POST',async t=>{
  let resolve;const f=fixture(t,(path,init,fallback)=>init.method==='POST'?new Promise(done=>{resolve=done;}):fallback(path,init));
  await f.ui.open();await f.ui.action('acknowledge','request-a');const form=f.form(),waiting=f.ui.submit(form);
  assert.equal(f.ui.busy,true);await f.ui.submit(form);assert.equal(f.calls.length,2);
  resolve({request:handoff({version:4,state:'acknowledged',decidedBy:'person-a',decisionReason:'Revisado pela equipe.'})});await waiting;assert.equal(f.ui.busy,false);
  const conflict=fixture(t,(path,init,fallback)=>{if(init.method==='POST')throw Object.assign(new Error('Conflito.'),{status:409});return fallback(path,init);});
  await conflict.ui.open();await conflict.ui.action('decline','request-a');await conflict.ui.submit(conflict.form());
  assert.equal(conflict.calls.filter(call=>call.init.method==='POST').length,1);assert.equal(conflict.calls.filter(call=>call.init.method==='GET').length,2);
  assert.match(conflict.html(),/revise antes de decidir/);assert.equal(conflict.updates.length,0);
});

test('trocas de workspace, empresa, conversa, pessoa, grant e autoridade descartam resposta tardia',async t=>{
  for(const [property,value] of [['workspaceId','other'],['tenantId','other'],['conversationId','other'],['userId','other'],['supportGrantId','other'],['authorityKey','other'],['assignedUserId','other'],['canDecide',false]])await t.test(property,async child=>{
    let resolve;const f=fixture(child,()=>new Promise(done=>{resolve=done;}));const pending=f.ui.open();f.context[property]=value;
    resolve({requests:[handoff({reason:'Resposta antiga não deve aparecer.'})]});await pending;
    assert.equal(f.html().includes('Resposta antiga não deve aparecer'),false);assert.equal(f.updates.length,0);f.ui.sync();assert.equal(f.modal.closed,true);
  });
});

test('troca de autoridade durante POST e substituição de modal suprimem sucesso e atualização tardios',async t=>{
  for(const replace of [false,true])await t.test(replace?'outro modal':'revogação',async child=>{
    let resolve;const f=fixture(child,(path,init,fallback)=>init.method==='POST'?new Promise(done=>{resolve=done;}):fallback(path,init));
    await f.ui.open();await f.ui.action('acknowledge','request-a');const pending=f.ui.submit(f.form());
    if(replace)f.modal.panel=null;else f.context.authorityKey='revoked';
    resolve({request:handoff({version:4,state:'acknowledged',decidedBy:'person-a',decisionReason:'Revisado pela equipe.'})});await pending;
    assert.equal(f.messages.length,0);assert.equal(f.updates.length,0);f.ui.sync();assert.equal(f.modal.closed,!replace);
  });
});

test('fechamento do dialog antes de seu evento close impede resultado tardio',async t=>{
  let resolve;const f=fixture(t,(path,init,fallback)=>init.method==='POST'?new Promise(done=>{resolve=done;}):fallback(path,init));
  await f.ui.open();await f.ui.action('acknowledge','request-a');const pending=f.ui.submit(f.form());f.modal.open=false;
  resolve({request:handoff({version:4,state:'acknowledged',decidedBy:'person-a',decisionReason:'Revisado pela equipe.'})});await pending;
  assert.equal(f.ui.opened,false);assert.equal(f.messages.length,0);assert.equal(f.updates.length,0);
});

test('fechar/reset invalida editores e nodos forjados ou de outra sessão não decidem',async t=>{
  const f=fixture(t);await f.ui.open();await f.ui.action('acknowledge','request-a');const old=f.form();
  f.modal.close();await f.ui.submit(old);assert.equal(f.calls.length,1);await f.ui.open();await f.ui.action('acknowledge','request-a');
  const forged=f.form();forged.dataset.serviceHandoffEditor='forged';await f.ui.submit(forged);assert.equal(f.calls.length,2);
  await f.ui.handleAction({...f.node('decline','request-a'),panel:null});assert.match(f.html(),/Marcar pedido como visto/);
  f.ui.reset();await f.ui.submit(old);assert.equal(f.ui.opened,false);
  assert.equal(await f.ui.handleAction({dataset:{}}),false);assert.equal(await f.ui.submit({dataset:{}}),false);
});

test('transporte incerto e resposta inválida bloqueiam nova decisão até consulta explícita',async t=>{
  for(const mode of ['network','wrong-id','wrong-state','wrong-version','wrong-person'])await t.test(mode,async child=>{
    const f=fixture(child,(path,init,fallback)=>{
      if(init.method!=='POST')return fallback(path,init);if(mode==='network')throw new Error('Rede caiu.');
      return {request:handoff({version:mode==='wrong-version'?3:4,id:mode==='wrong-id'?'foreign':'request-a',state:mode==='wrong-state'?'declined':'acknowledged',decidedBy:mode==='wrong-person'?'other':'person-a',decisionReason:'Revisado pela equipe.'})};
    });
    await f.ui.open();await f.ui.action('acknowledge','request-a');const form=f.form();await f.ui.submit(form);await f.ui.submit(form);await f.ui.action('decline','request-a');
    assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);assert.equal(f.updates.length,0);assert.match(f.html(),/Atualize/);
    await f.ui.action('refresh');await f.ui.action('decline','request-a');assert.match(f.html(),/Recusar solicitação/);
  });
});

test('401,403,404 fecham somente modal próprio e reportam bloqueio real',async t=>{
  for(const status of [401,403,404])await t.test(String(status),async child=>{
    const f=fixture(child,()=>{throw Object.assign(new Error('Acesso indisponível.'),{status});});await f.ui.open();
    assert.equal(f.modal.closed,true);assert.equal(f.ui.opened,false);assert.match(f.messages[0].message,/Acesso indisponível/);
  });
});

test('lista inválida, repetida ou de outra conversa não habilita decisão e atualizar recupera',async t=>{
  let response={requests:[handoff(),handoff()]};const f=fixture(t,()=>response);await f.ui.open();assert.match(f.html(),/repetidas/);
  response={requests:[handoff({conversationId:'other'})]};await f.ui.action('refresh');assert.match(f.html(),/não confirmou/);
  response={requests:[handoff()]};await f.ui.action('refresh');assert.match(f.html(),/Hermes sintético/);await f.ui.action('acknowledge','request-a');assert.match(f.html(),/Marcar pedido como visto/);
});

test('load concorrente conserva só última lista e atendimento inválido não faz requisição',async t=>{
  const resolvers=[];const f=fixture(t,()=>new Promise(done=>resolvers.push(done)));const first=f.ui.open(),second=f.ui.load();
  resolvers[1]({requests:[handoff({reason:'Resultado atual'})]});await second;resolvers[0]({requests:[handoff({reason:'Resultado antigo'})]});await first;
  assert.match(f.html(),/Resultado atual/);assert.equal(f.html().includes('Resultado antigo'),false);
  f.context.active=false;assert.equal(f.ui.markup(),'');await f.ui.open();assert.equal(f.calls.length,2);
});

test('grant expirado e seleção pendente anulam contexto de atendimento',()=>{
  const context={active:true,workspaceId:'w',tenantId:'t',conversationId:'c',userId:'u',supportGrantId:'g'};
  assert.equal(serviceHandoffsContextKey({...context,supportExpiresAt:'2000-01-01T00:00:00Z'}),'');
  assert.equal(serviceHandoffsContextKey({...context,selecting:true}),'');assert.equal(serviceHandoffsContextKey({...context,canRead:false}),'');
  assert.ok(serviceHandoffsContextKey({...context,supportExpiresAt:'2100-01-01T00:00:00Z'}));
});

test('Pendências (P6): "Marcar como visto" e "Assumir" são ações separadas; marcar não transfere e Assumir usa o controle da conversa',async t=>{
  const f=fixture(t);let clicks=0;const control={disabled:false,getAttribute:()=>null,click(){clicks++;}};
  f.modal.ownerDocument={querySelector:selector=>selector==='#app [data-action="takeover"]'?control:null};f.context.canDecide=false;
  await f.ui.open();
  assert.match(f.html(),/data-service-handoff-action="take"[^>]*>Assumir atendimento</);
  assert.equal(f.html().includes('data-service-handoff-action="acknowledge"'),false,'quem não é responsável não marca como visto');
  await f.ui.handleAction(f.node('take'));assert.equal(clicks,1,'Assumir aciona o controle de assumir da conversa (mesmas guardas e permissões)');assert.equal(f.modal.closed,true);
  assert.equal(f.calls.some(call=>call.init.method==='POST'),false,'Assumir pelo modal não decide o pedido');
  const g=fixture(t);g.modal.ownerDocument={querySelector:()=>({...control,disabled:true})};await g.ui.open();
  assert.equal(g.html().includes('data-service-handoff-action="take"'),false,'sem controle habilitado, nenhuma oferta de assumir');
  await g.ui.action('acknowledge','request-a');assert.match(g.html(),/Marcar como visto não transfere a conversa\./);
  await g.ui.submit(g.form('Visto.'));assert.deepEqual(JSON.parse(g.calls[1].init.body),{version:3,action:'acknowledge',reason:'Visto.'});
  assert.equal(g.calls.some(call=>/owner|transfer|messages/.test(call.path)),false,'marcar como visto não transfere nem envia');
  const h=fixture(t);h.modal.ownerDocument={querySelector:()=>null};await h.ui.open();await h.ui.handleAction(h.node('take'));
  assert.equal(h.modal.closed,false);assert.match(h.html(),/não pode ser assumido/);
});
