import test from 'node:test';
import assert from 'node:assert/strict';
import {createBillingUI,parseBillingCents,formatBillingMoney} from '../public/billing-ui.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const decode=value=>String(value||'').replace(/&(quot|#39|lt|gt|amp);/g,(_,key)=>({quot:'"','#39':"'",lt:'<',gt:'>',amp:'&'}[key]));
function form(markup) {
  const values=[];
  for(const [,attrs] of markup.matchAll(/<input\b([^>]*)>/g)){const name=attrs.match(/\bname="([^"]+)"/)?.[1];if(name)values.push({name:decode(name),value:decode(attrs.match(/\bvalue="([^"]*)"/)?.[1]),type:attrs.match(/\btype="([^"]*)"/)?.[1]||'text',checked:/\bchecked\b/.test(attrs)});}
  for(const [,attrs,content] of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)){const name=attrs.match(/\bname="([^"]+)"/)?.[1];if(!name)continue;const selected=[...content.matchAll(/<option\b([^>]*)>/g)].find(match=>/\bselected\b/.test(match[1]));values.push({name,value:decode(selected?.[1].match(/\bvalue="([^"]*)"/)?.[1]),type:'select'});}
  return {dataset:{billingForm:markup.match(/data-billing-form="([^"]+)"/)?.[1],billingToken:markup.match(/data-billing-token="([^"]+)"/)?.[1]},values,set(name,value){const target=values.find(item=>item.name===name);assert.ok(target,name);target.value=value;},check(name,checked){const target=values.find(item=>item.name===name);assert.ok(target,name);target.checked=checked;}};
}
class FormDataAdapter {
  constructor(form){this.entries=form.values.filter(item=>item.type!=='checkbox'||item.checked).map(item=>[item.name,item.value]);}
  has(name){return this.entries.some(([key])=>key===name);}
  [Symbol.iterator](){return this.entries[Symbol.iterator]();}
}
function fixture(t,options={}) {
  const listeners=new Map(),previous={document:globalThis.document,FormData:globalThis.FormData},modal={open:false,innerHTML:'',addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name,fn){if(listeners.get(name)===fn)listeners.delete(name);},close(){this.closed=true;this.open=false;listeners.get('close')?.();}};globalThis.document={querySelector:selector=>selector==='#modal'?modal:null};globalThis.FormData=FormDataAdapter;t.after(()=>{globalThis.document=previous.document;globalThis.FormData=previous.FormData;});
  const contract={id:'contract-a',name:'Contrato real configurado',scope:'workspace',tenantId:'company-a',targetWorkspaceId:'workspace-a',version:1,canManage:true,items:[{kind:'subscription',label:'Mensalidade',unitCents:1200,units:1,metered:false},{kind:'email',label:'E-mail',unitCents:3,units:0,metered:true}],quotas:{email:10},liveUsage:[{metric:'connections',quantity:2,limit:3,exceeded:false}],startsAt:'2026-10-01',endsAt:null,periodMonths:1,graceDays:3,state:'active',status:'active'};
  const invoice={id:'invoice-a',contractId:contract.id,contractName:contract.name,canManage:true,state:'draft',status:'draft',version:1,totalCents:1200,paidCents:0,outstandingCents:1200,periodStart:'2026-10-01',periodEnd:'2026-10-31',dueDate:'2026-11-05',snapshot:{items:[{label:'Mensalidade',units:1,totalCents:1200}]}};
  const source={view:'workspace',canManagePlatform:true,targets:[{id:'company-a',name:'Empresa A'}],contracts:[contract],invoices:[invoice]},state={view:'billing',boot:{session:{userId:'admin',role:'reseller',platformOwner:true},csrfToken:'csrf-a'},workspaceId:'workspace-a'},calls=[],opened=[],messages=[],result={renders:0};
  if(options.kind)state.boot.reseller={kind:options.kind};
  const ui=createBillingUI({state,escape,icon:()=>'',api:async(path,init)=>{calls.push({path,init});if(init?.method){return options.mutate?options.mutate(path,init):{id:'accepted-id'};}if(options.read){const answer=options.read(path,{source,contract,invoice},init);if(answer!==undefined)return answer;}if(path.startsWith('/api/billing?'))return structuredClone(source);if(path.includes('/contracts/'))return {contract:structuredClone(contract),usage:[],audit:[],versions:[]};if(path.includes('/invoices/'))return {invoice:structuredClone(invoice),settlements:[],reconciliation:{balanced:true}};throw new Error('Unexpected API');},openModal(title,description,markup){opened.push({title,description,markup});modal.closed=false;modal.open=true;modal.innerHTML=markup;result.form=form(markup);},render:()=>result.renders++,toast:message=>messages.push(message)});
  return {ui,state,source,contract,invoice,calls,opened,messages,result,modal,ready:ui.load({renderAfter:false}),writes(){return calls.filter(call=>call.init?.method);},payload(){return JSON.parse(this.writes().at(-1).init.body);}};
}
function fillContract(form) {
  form.set('targetId','company-a');form.set('name','Preço acordado');const kind=form.values.find(item=>item.name.startsWith('itemKind-')).name.slice(9);form.set(`itemLabel-${kind}`,'Mensalidade');form.set(`itemPrice-${kind}`,'49,90');form.set(`itemUnits-${kind}`,'1');form.set('reason','Acordo revisado com o cliente');
}

test('moeda é convertida em centavos sem float/expoente/arredondamento',()=>{
  assert.equal(parseBillingCents('49,90'),4990);assert.equal(parseBillingCents('0.03'),3);assert.equal(parseBillingCents('0'),0);assert.equal(parseBillingCents('90071992547409.91'),Number.MAX_SAFE_INTEGER);
  for(const value of ['', '-1','1.001','1e4','0x10','NaN','1 000,00','90071992547409.92'])assert.throws(()=>parseBillingCents(value));
});

test('apresentação de preço e fatura conserva centavos exatos até o limite seguro sem float',async t=>{
  const env=fixture(t);env.contract.items=[{kind:'subscription',label:'Preço explícito máximo',unitCents:Number.MAX_SAFE_INTEGER,units:1,metered:false}];
  env.invoice.totalCents=Number.MAX_SAFE_INTEGER;env.invoice.outstandingCents=Number.MAX_SAFE_INTEGER;env.invoice.snapshot.items=[{label:'Preço explícito máximo',units:1,totalCents:Number.MAX_SAFE_INTEGER}];
  await env.ready;await env.ui.load({renderAfter:false});assert.ok(env.ui.render().includes('90.071.992.547.409,91'));await env.ui.action('billing-invoice-detail',env.invoice.id);assert.ok(env.opened.at(-1).markup.includes('90.071.992.547.409,91'));
  await env.ui.action('billing-settle',env.invoice.id);assert.equal(env.result.form.values.find(item=>item.name==='amount').value,'90071992547409,91');assert.equal(env.writes().length,0);
});

test('formatação monetária valida centavos e preserva unidades/subunidades sem arredondar',()=>{
  assert.ok(formatBillingMoney(0).endsWith('0,00'));assert.ok(formatBillingMoney(3).endsWith('0,03'));assert.ok(formatBillingMoney(123456789).endsWith('1.234.567,89'));
  assert.ok(formatBillingMoney(Number.MAX_SAFE_INTEGER-1).endsWith('90.071.992.547.409,90'));assert.ok(formatBillingMoney(Number.MAX_SAFE_INTEGER).endsWith('90.071.992.547.409,91'));
  for(const value of [undefined,-1,1.1,NaN,Number.MAX_SAFE_INTEGER+1])assert.equal(formatBillingMoney(value),'Valor exige revisão');
});

test('baixas paginadas consultam somente página solicitada e correção relê ID específico com versão fresca',async t=>{
  const receipt={id:'receipt-after-200',reference:'Referência privada <img>',amountCents:1,settledAt:'2026-10-03',reason:'Baixa conferida',canReverse:true};
  const env=fixture(t,{read:(path,{invoice})=>{
    if(!path.includes('/invoices/'))return;const params=new URL(path,'http://local').searchParams,offset=Number(params.get('settlementsOffset')||0),selected=params.get('settlementId');
    return {invoice:{...structuredClone(invoice),version:selected?9:invoice.version},settlements:offset===200||selected?[receipt]:[],settlementsLimit:{shown:offset===200?1:0,total:201,limit:200},settlementPage:{offset,limit:200,total:201,hasMore:offset===0},reconciliation:{balanced:true}};
  }});await env.ready;await env.ui.action('billing-invoice-detail',env.invoice.id);assert.ok(env.opened.at(-1).markup.includes('data-id="invoice-a|200"'));assert.equal(env.calls.filter(call=>call.path.includes('/invoices/')).length,1);
  await env.ui.action('billing-settlement-page','invoice-a|200');const page=env.calls.at(-1);assert.equal(new URL(page.path,'http://local').searchParams.get('settlementsOffset'),'200');assert.equal(new URL(page.path,'http://local').searchParams.get('settlementsLimit'),'200');
  assert.ok(env.opened.at(-1).markup.includes('data-id="invoice-a|0"'));assert.ok(env.opened.at(-1).markup.includes('&lt;img&gt;'));assert.equal(env.writes().length,0);
  await env.ui.action('billing-reverse','invoice-a|receipt-after-200');assert.equal(new URL(env.calls.at(-1).path,'http://local').searchParams.get('settlementId'),receipt.id);
  env.result.form.set('reason','Correção integral conferida');await env.ui.submit(env.result.form);assert.equal(env.payload().settlementId,receipt.id);assert.equal(env.payload().version,9);assert.equal(env.payload().action,'reverse');
  await assert.rejects(env.ui.action('billing-settlement-page','invoice-a|-1'),/Página de baixas/);await assert.rejects(env.ui.action('billing-settlement-page','invoice-a|1000001'),/Página de baixas/);
});

test('páginas fora de ordem cancelam leitura antiga e não substituem detalhe recente',async t=>{
  let release;const env=fixture(t,{read:(path,{invoice})=>{if(!path.includes('/invoices/'))return;const offset=new URL(path,'http://local').searchParams.get('settlementsOffset');
    const answer={invoice:structuredClone(invoice),settlements:[],reconciliation:{balanced:true},settlementPage:{offset:Number(offset||0),limit:200,total:601,hasMore:true}};
    return offset==='200'?new Promise(resolve=>{release=()=>resolve(answer);}):answer;
  }});await env.ready;await env.ui.action('billing-invoice-detail',env.invoice.id);const waiting=env.ui.action('billing-settlement-page','invoice-a|200'),call=env.calls.at(-1);
  await env.ui.action('billing-settlement-page','invoice-a|400');const newer=env.opened.at(-1).markup,count=env.opened.length;assert.equal(call.init.signal.aborted,true);release();await waiting;assert.equal(env.opened.length,count);assert.equal(env.opened.at(-1).markup,newer);assert.equal(env.writes().length,0);
});

for(const change of ['closed','workspace','user','grant','csrf','permissions','view','reset','other-modal','new-editor'])test(`leitura de baixa atrasada ignorada após ${change}`,async t=>{
  let release;const env=fixture(t,{read:(path,{invoice})=>path.includes('settlementsOffset=200')?new Promise(resolve=>{release=()=>resolve({invoice:structuredClone(invoice),settlements:[],reconciliation:{balanced:true}});}):undefined});
  await env.ready;await env.ui.action('billing-invoice-detail',env.invoice.id);const waiting=env.ui.action('billing-settlement-page','invoice-a|200'),count=env.opened.length;
  if(change==='closed')env.modal.close();else if(change==='workspace')env.state.workspaceId='workspace-b';else if(change==='user')env.state.boot.session.userId='other-user';else if(change==='grant')env.state.supportGrantId='temporary-grant';
  else if(change==='csrf')env.state.boot.csrfToken='changed-csrf';else if(change==='permissions')env.state.boot.session.permissions=[];else if(change==='view')env.state.view='inbox';else if(change==='reset')env.ui.reset();
  else if(change==='other-modal')env.modal.innerHTML='<form>Other product dialog</form>';else await env.ui.action('billing-new-contract');
  const markup=env.modal.innerHTML;release();await waiting;assert.equal(env.opened.length,count+(change==='new-editor'?1:0));assert.equal(env.modal.innerHTML,markup);assert.equal(env.writes().length,0);
});

test('formulário fechado/desconectado não grava e submit antigo não repete resposta financeira incerta',async t=>{
  const env=fixture(t,{mutate:async()=>{throw new Error('Uncertain write');}});await env.ready;await env.ui.action('billing-new-contract');let draft=env.result.form;fillContract(draft);env.modal.close();
  await assert.rejects(env.ui.submit(draft),/Abra esta operação/);assert.equal(env.writes().length,0);
  await env.ui.action('billing-new-contract');draft=env.result.form;fillContract(draft);draft.isConnected=false;await assert.rejects(env.ui.submit(draft),/Abra esta operação/);draft.isConnected=true;
  await assert.rejects(env.ui.submit(draft),/incerta/);assert.equal(env.writes().length,1);await assert.rejects(env.ui.submit(draft),/Use Verificar/);assert.equal(env.writes().length,1);
  env.modal.close();await env.ui.action('billing-new-contract');assert.equal(env.opened.at(-1).title,'Verificar operação financeira');assert.equal(env.writes().length,1);
});
test('painel consulta dados reais, uso atual e preços acordados sem pagamento automático',async t=>{
  const env=fixture(t);await env.ready;const markup=env.ui.render();assert.ok(markup.includes('Contrato real configurado'));assert.ok(markup.includes('Conexões: 2 / 3'));assert.ok(markup.includes('Nenhum pagamento é executado'));assert.ok(markup.includes('Criar fatura'));assert.match(markup,/<button type="button" class="ui-btn [^"]*" data-action="billing-new-invoice"/,'ações usam o botão do design system (alvo de 44 px abaixo de 900 px)');assert.equal(env.calls[0].path,'/api/billing?view=workspace');
});
test('novo contrato mantém campos de preço/quantidade vazios e converte só escolha explícita',async t=>{
  const env=fixture(t);await env.ready;await env.ui.action('billing-new-contract');const form=env.result.form;assert.equal(form.values.find(item=>item.name.startsWith('itemPrice-')).value,'');assert.equal(form.values.find(item=>item.name.startsWith('itemUnits-')).value,'');fillContract(form);await env.ui.submit(form);const payload=env.payload();assert.equal(payload.scope,'workspace');assert.equal(payload.tenantId,'company-a');assert.equal(payload.currency,'BRL');assert.equal(payload.items[0].unitCents,4990);assert.equal(payload.items[0].units,1);assert.equal(payload.items[0].metered,false);assert.equal(payload.quotas.email,null);assert.match(payload.requestId,/^[a-f0-9-]{36}$/);
});
test('campo preço/quantidade vazio não vira cobrança ou zero por inferência',async t=>{
  const env=fixture(t);await env.ready;await env.ui.action('billing-new-contract');const form=env.result.form;form.set('name','Plano');form.set('reason','Acordo revisado');await assert.rejects(env.ui.submit(form),/valor em reais/);fillContract(form);const item=form.values.find(row=>row.name.startsWith('itemUnits-'));item.value='';await assert.rejects(env.ui.submit(form),/quantidade/);assert.equal(env.writes().length,0);
});
test('visão plataforma cria alvo revenda e não empresa',async t=>{
  const env=fixture(t);await env.ready;env.state.view='platform-billing';env.source.targets=[{id:'reseller-b',name:'Revenda B'}];await env.ui.load({renderAfter:false});await env.ui.action('billing-new-contract');const form=env.result.form;fillContract(form);form.set('targetId','reseller-b');await env.ui.submit(form);assert.equal(env.payload().scope,'platform');assert.equal(env.payload().targetWorkspaceId,'reseller-b');assert.equal('tenantId' in env.payload(),false);
});
test('edição preserva itens, preço e modo medido em PATCH com revisão',async t=>{
  const env=fixture(t);await env.ready;await env.ui.action('billing-edit-contract',env.contract.id);const form=env.result.form;form.set('name','Nome novo');form.set('reason','Alteração de nome acordada');await env.ui.submit(form);assert.equal(env.writes()[0].init.method,'PATCH');assert.equal(env.payload().version,1);assert.deepEqual(env.payload().items,env.contract.items);assert.equal('scope' in env.payload(),false);assert.equal('tenantId' in env.payload(),false);
});
test('criar fatura envia competência, vencimento e revisão sem emitir ou pagar',async t=>{
  const env=fixture(t);await env.ready;await env.ui.action('billing-new-invoice',env.contract.id);const form=env.result.form;form.set('periodStart','2026-10-01');form.set('periodEnd','2026-10-31');form.set('dueDate','2026-11-05');form.set('reason','Competência conferida');await env.ui.submit(form);assert.equal(env.writes()[0].path,'/api/billing/contracts/contract-a/invoices');assert.equal(env.payload().version,1);assert.equal(env.payload().dueDate,'2026-11-05');assert.equal('action' in env.payload(),false);
});
test('uso registrado é explícito e separado das contagens atuais',async t=>{
  const env=fixture(t);await env.ready;await env.ui.action('billing-usage',env.contract.id);const form=env.result.form;form.set('metric','email');form.set('quantity','13');form.set('reason','Medição de e-mails revisada');await env.ui.submit(form);assert.equal(env.writes()[0].path,'/api/billing/contracts/contract-a/usage');assert.equal(env.payload().quantity,13);assert.equal(env.payload().metric,'email');assert.ok(env.opened[0].markup.includes('sem alterar contagens atuais'));
});
test('baixa manual pede comprovante/referência e usa fatura fresca/revisão',async t=>{
  const env=fixture(t);await env.ready;env.invoice.state='issued';env.invoice.status='issued';env.invoice.version=3;await env.ui.action('billing-settle',env.invoice.id);const form=env.result.form;form.set('amount','12,00');form.set('reference','Comprovante conferido');form.set('settledAt','2026-10-03');form.set('reason','Recebimento já conferido');await env.ui.submit(form);assert.equal(env.writes()[0].path,'/api/billing/invoices/invoice-a/events');assert.equal(env.payload().action,'settle');assert.equal(env.payload().amountCents,1200);assert.equal(env.payload().version,3);assert.ok(env.opened[0].markup.includes('não executa este pagamento'));
});
test('falha de resposta conserva payload e requestId na verificação sem duplicar baixa',async t=>{
  let attempts=0;const env=fixture(t,{mutate:async()=>{if(++attempts===1)throw new Error('Lost response');return {id:'accepted-id'};}});await env.ready;await env.ui.action('billing-issue',env.invoice.id);const form=env.result.form;form.set('reason','Emissão conferida');await assert.rejects(env.ui.submit(form),/incerta/);assert.equal(env.opened.at(-1).title,'Verificar operação financeira');form.set('reason','Mudança posterior');await env.ui.action('billing-verify-write');const [first,second]=env.writes().map(call=>JSON.parse(call.init.body));assert.deepEqual(second,first);assert.equal(first.reason,'Emissão conferida');
});
test('rejeição CAS explícita permite corrigir sem reutilizar requestId rejeitado',async t=>{
  let attempts=0;const env=fixture(t,{mutate:async()=>{if(++attempts===1)throw Object.assign(new Error('Fatura mudou'),{status:409});return {id:'accepted-id'};}});await env.ready;await env.ui.action('billing-issue',env.invoice.id);const form=env.result.form;form.set('reason','Emissão revisada');await assert.rejects(env.ui.submit(form),/Fatura mudou/);await env.ui.submit(form);const [first,second]=env.writes().map(call=>JSON.parse(call.init.body));assert.notEqual(first.requestId,second.requestId);
});
test('formulário antigo ou workspace diferente não aplica valores em outro contrato',async t=>{
  const env=fixture(t);await env.ready;await env.ui.action('billing-new-contract');const old=env.result.form;fillContract(old);await env.ui.action('billing-new-contract');await assert.rejects(env.ui.submit(old),/Abra esta operação/);const form=env.result.form;fillContract(form);env.state.workspaceId='workspace-b';await assert.rejects(env.ui.submit(form),/Abra esta operação/);assert.equal(env.writes().length,0);
});
test('resposta atrasada não abre sucesso nem recarrega outro workspace',async t=>{
  let resolve;const env=fixture(t,{mutate:()=>new Promise(done=>resolve=done)});await env.ready;await env.ui.action('billing-new-contract');const form=env.result.form;fillContract(form);const waiting=env.ui.submit(form);env.state.workspaceId='workspace-b';resolve({id:'accepted-id'});await waiting;assert.equal(env.messages.length,0);assert.equal(env.modal.closed,false);assert.equal(env.calls.filter(call=>call.path.startsWith('/api/billing?')).length,1);
});
test('plano recebido é consultável sem controles de gestão e identidade HTML é escapada',async t=>{
  const env=fixture(t);await env.ready;env.contract.canManage=false;env.contract.scope='platform';env.contract.name='<img onerror=x>';await env.ui.load({renderAfter:false});const markup=env.ui.render();assert.ok(markup.includes('Plano da sua revenda'));assert.ok(markup.includes('&lt;img onerror=x&gt;'));assert.equal(markup.includes('data-action="billing-edit-contract"'),false);assert.equal(markup.includes('data-action="billing-new-invoice"'),false);await assert.rejects(env.ui.action('billing-edit-contract',env.contract.id),/gestão da plataforma/);
});
test('detalhes consultam reconciliação e filtros não criam operações financeiras',async t=>{
  const env=fixture(t);await env.ready;await env.ui.action('billing-invoice-detail',env.invoice.id);assert.ok(env.opened.at(-1).markup.includes('Registros conciliados'));const filter={dataset:{billingForm:'filter'},values:[{name:'status',value:'settled'}]};await env.ui.submit(filter);assert.equal(env.state.billingFilter,'settled');assert.equal(env.writes().length,0);assert.equal(env.ui.render().includes('Nenhuma fatura neste filtro'),true);env.ui.reset();assert.equal(env.state.billing,null);assert.equal(await env.ui.action('unrelated'),false);assert.equal(await env.ui.submit({dataset:{}}),false);
});

// P8 (§8.9): Configurações › Financeiro of a reseller opens what it pays plus its companies' contracts;
// the client billing of the reseller lives in Clientes › Financeiro (#accounts/billing, host 'accounts').
test('revenda abre clientes, preserva empresas legadas e oferece faturas recebidas sem gestão',async t=>{
 const env=fixture(t,{kind:'reseller'});await env.ready;assert.equal(env.calls[0].path,'/api/billing?view=payable');assert.ok(env.ui.render().includes('Minhas faturas'));assert.ok(env.ui.render().includes('Empresas deste workspace'));assert.equal(env.ui.render().includes('Clientes da revenda'),false);
 assert.equal(env.ui.render().includes('data-action="billing-new-contract"'),false);await assert.rejects(env.ui.action('billing-new-contract'),/somente consultar/);await assert.rejects(env.ui.action('billing-view','reseller'),/Visão financeira indisponível/);
 await env.ui.action('billing-view','workspace');assert.ok(env.calls.at(-1).path.includes('view=workspace'));
 env.ui.reset();env.state.view='accounts';await env.ui.load({renderAfter:false});assert.ok(env.calls.at(-1).path.includes('view=reseller'));assert.ok(env.ui.render().includes('Financeiro dos clientes'));await assert.rejects(env.ui.action('billing-view','payable'),/Visão financeira indisponível/);
 env.source.targets=[{id:'business-a',name:'Cliente A'}];await env.ui.action('billing-new-contract');const draft=env.result.form;fillContract(draft);draft.set('targetId','business-a');await env.ui.submit(draft);assert.equal(env.payload().targetKind,'reseller');assert.equal(env.payload().targetWorkspaceId,'business-a');assert.equal(env.payload().scope,'workspace');assert.equal('tenantId' in env.payload(),false);
 env.ui.reset();env.state.view='accounts';env.state.boot.reseller={kind:'business'};assert.ok(env.ui.render().includes('Esta conta não tem clientes de revenda.'));assert.equal(env.ui.render().includes('data-action="billing-new-contract"'),false);
});
test('cliente direto abre minhas faturas e detalhe não ganha botão de emitir mesmo com DTO errado',async t=>{
 const env=fixture(t,{kind:'business'});await env.ready;assert.equal(env.calls[0].path,'/api/billing?view=payable');assert.equal(env.ui.render().includes('data-action="billing-new-contract"'),false);await env.ui.action('billing-invoice-detail',env.invoice.id);assert.equal(env.opened.at(-1).markup.includes('data-action="billing-issue"'),false);await assert.rejects(env.ui.action('billing-issue',env.invoice.id),/somente consultar/);assert.equal(env.writes().length,0);
});
test('filtros e páginas são consultados no servidor com totais verdadeiros sem criação financeira',async t=>{
 const env=fixture(t);await env.ready;env.source.contractPage={offset:0,limit:50,total:211,hasMore:true};env.source.invoicePage={offset:0,limit:50,total:355,hasMore:true};await env.ui.load({renderAfter:false});assert.ok(env.ui.render().includes('211 contratos · 355 faturas'));assert.ok(env.ui.render().includes('1–50 de 355'));
 const filter={dataset:{billingForm:'filter'},values:[{name:'q',value:'Cliente & João'},{name:'targetId',value:'company-a'},{name:'status',value:'partial'}]};await env.ui.submit(filter);let query=new URL('http://fixture'+env.calls.at(-1).path).searchParams;assert.equal(query.get('q'),'Cliente & João');assert.equal(query.get('targetId'),'company-a');assert.equal(query.get('invoiceStatus'),'partial');
 await env.ui.action('billing-invoice-page','50');query=new URL('http://fixture'+env.calls.at(-1).path).searchParams;assert.equal(query.get('invoiceOffset'),'50');assert.equal(query.get('q'),'Cliente & João');assert.equal(env.writes().length,0);await assert.rejects(env.ui.action('billing-contract-page','-1'),/Página inválida/);
 await env.ui.action('billing-view','payable');assert.equal(new URL('http://fixture'+env.calls.at(-1).path).searchParams.has('targetId'),false);
});
test('competência sugerida respeita trimestre, dia31 e não encurta fim para vigência parcial',async t=>{
 const env=fixture(t);await env.ready;env.contract.startsAt='2029-01-31';env.contract.periodMonths=3;env.contract.endsAt='2029-04-15';await env.ui.load({renderAfter:false});await env.ui.action('billing-new-invoice',env.contract.id);assert.equal(env.result.form.values.find(r=>r.name==='periodStart').value,'2029-01-31');assert.equal(env.result.form.values.find(r=>r.name==='periodEnd').value,'2029-04-29');assert.ok(env.opened.at(-1).markup.includes('ultrapassa a vigência'));assert.ok(env.opened.at(-1).markup.includes('Sem proração automática'));
});
test('emissão de consumo manual exige checkbox explícito e mostra ausência separada de zero',async t=>{
 const env=fixture(t);await env.ready;env.invoice.snapshot.items=[{kind:'email',label:'E-mail',units:0,totalCents:0,metered:true}];env.invoice.snapshot.usageReview={source:'manual',entries:0,missingMetrics:['email']};await env.ui.action('billing-issue',env.invoice.id);const draft=env.result.form;draft.set('reason','Zero conferido');assert.ok(env.opened.at(-1).markup.includes('sem registro manual'));assert.equal(draft.values.find(r=>r.name==='usageReviewed').checked,false);await assert.rejects(env.ui.submit(draft),/Confirme a revisão/);assert.equal(env.writes().length,0);draft.check('usageReviewed',true);await env.ui.submit(draft);assert.equal(env.payload().usageReviewed,true);
});
test('corrigir baixa mantém motivo, identidade e CAS e resposta incerta repete somente a mesma correção',async t=>{
 let attempts=0;const receipt={id:'receipt-1',reference:'<img src=x>',amountCents:1200,settledAt:'2026-10-03',reason:'Recebimento',canReverse:true};const env=fixture(t,{read:(path,{invoice})=>path.includes('/invoices/')?{invoice:structuredClone(invoice),settlements:[receipt],settlementsLimit:{shown:1,total:2,limit:200},reconciliation:{balanced:true}}:undefined,mutate:async()=>{if(++attempts===1)throw new Error('Resposta perdida');return {id:'accepted-id'};}});await env.ready;env.invoice.state='settled';env.invoice.version=4;await env.ui.action('billing-invoice-detail',env.invoice.id);assert.ok(env.opened.at(-1).markup.includes('Exibindo 1 de 2'));assert.ok(env.opened.at(-1).markup.includes('Corrigir baixa'));assert.ok(env.opened.at(-1).markup.includes('&lt;img src=x&gt;'));
 await env.ui.action('billing-reverse','invoice-a|receipt-1');assert.ok(env.opened.at(-1).markup.includes('sem devolução de dinheiro'));env.result.form.set('reason','Baixa digitada erroneamente');await assert.rejects(env.ui.submit(env.result.form),/incerta/);await env.ui.action('billing-verify-write');const writes=env.writes().map(w=>JSON.parse(w.init.body));assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].version,4);assert.equal(writes[0].settlementId,'receipt-1');assert.equal(writes[0].action,'reverse');assert.equal('amountCents' in writes[0],false);
});
test('atalho da conta consulta financeiro no alvo selecionado e reset limpa filtros de contexto',async t=>{
 const env=fixture(t);await env.ready;await env.ui.openForAccount({id:'reseller-a'});assert.equal(env.state.view,'platform-billing');assert.equal(new URL('http://fixture'+env.calls.at(-1).path).searchParams.get('targetId'),'reseller-a');assert.ok(env.ui.render().includes('value="reseller-a"')===false);env.ui.reset();assert.equal(env.state.billingTargetId,null);
});
test('atalho de cliente externo vindo de minhas faturas retoma visão comercial da revenda',async t=>{
 const env=fixture(t,{kind:'reseller'});await env.ready;env.state.boot.session.platformOwner=false;await env.ui.action('billing-view','payable');await env.ui.openForAccount({id:'business-a'});assert.equal(env.state.view,'accounts','Clientes › Financeiro');const query=new URL('http://fixture'+env.calls.at(-1).path).searchParams;assert.equal(query.get('view'),'reseller');assert.equal(query.get('targetId'),'business-a');
});
