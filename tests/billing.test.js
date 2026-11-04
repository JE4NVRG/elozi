import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {Billing} from '../src/billing.js';

const request=()=>randomUUID();
const terms=(overrides={})=>({requestId:request(),scope:'workspace',tenantId:'company',name:'Contrato configurado',currency:'BRL',items:[{kind:'subscription',label:'Mensalidade',unitCents:1099,units:1,metered:false},{kind:'email',label:'E-mail por uso',unitCents:3,units:0,metered:true}],quotas:{email:10,connections:2},periodMonths:1,startsAt:'2026-10-01',endsAt:null,graceDays:3,state:'active',reason:'Configuração autorizada no contrato',...overrides});
const period=()=>({periodStart:'2026-10-01',periodEnd:'2026-10-31'});
function fixture(t,options={}) {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');t.after(()=>db.close());
  const users={owner:{role:'reseller',workspace:'workspace-a',platform:true},alice:{role:'reseller',workspace:'workspace-a'},bob:{role:'reseller',workspace:'workspace-b'},operator:{role:'operator',workspace:'workspace-a'}},clock={value:Date.parse('2026-10-03T15:00:00Z')};
  const validateActor=input=>{const user=users[input.userId];if(!user||user.disabled||!user.platform&&input.resellerId!==user.workspace)throw Object.assign(new Error('Acesso revogado'),{status:403});return {userId:input.userId,resellerId:input.resellerId,role:user.role};};
  const callbacks={validateActor,isPlatformAdmin:actor=>Boolean(users[actor.userId]?.platform),getWorkspaces:()=>[{id:'workspace-a',name:'Revenda A'},{id:'workspace-b',name:'Revenda B'}],getTenants:(_actor,workspaceId)=>[{id:'company',name:`Empresa de ${workspaceId}`}],now:()=>clock.value,...options};
  const billing=new Billing(db,callbacks),actors={owner:{userId:'owner',resellerId:'workspace-a'},alice:{userId:'alice',resellerId:'workspace-a'},bob:{userId:'bob',resellerId:'workspace-b'},operator:{userId:'operator',resellerId:'workspace-a'}};
  return {db,billing,actors,users,clock,contract(actor=actors.alice,extra={}){return billing.createContract(actor,terms(extra));},invoice(actor,contract,extra={}){return billing.createInvoice(actor,contract.id,{requestId:request(),version:contract.version,...period(),dueDate:'2026-11-05',reason:'Competência revisada para cobrança',...extra});},change(actor,invoice,action,extra={}){return billing.changeInvoice(actor,invoice.id,{requestId:request(),version:invoice.version,action,...(action==='issue'?{usageReviewed:true}:{}),reason:'Ação financeira autorizada e revisada',...extra});}};
}

test('dois níveis de contrato ficam isolados e revenda recebe seu plano somente para leitura',t=>{
  const env=fixture(t),platform=env.contract(env.actors.owner,{scope:'platform',tenantId:undefined,targetWorkspaceId:'workspace-b'}),a=env.contract(),b=env.contract(env.actors.bob);
  assert.equal(platform.scope,'platform');assert.equal(a.tenantId,b.tenantId);
  assert.deepEqual(env.billing.overview(env.actors.alice).contracts.map(c=>c.id),[a.id]);const bob=env.billing.overview(env.actors.bob);assert.equal(bob.contracts.length,2);assert.equal(bob.contracts.find(c=>c.id===platform.id).canManage,false);
  assert.throws(()=>env.billing.detail(env.actors.alice,b.id),error=>error.status===404);assert.throws(()=>env.billing.detail(env.actors.alice,platform.id),error=>error.status===404);
  assert.throws(()=>env.billing.updateContract(env.actors.bob,platform.id,{...terms(),scope:undefined,tenantId:undefined,version:1}),error=>[400,404].includes(error.status));
  assert.deepEqual(env.billing.overview(env.actors.owner,{view:'platform'}).contracts.map(c=>c.id),[platform.id]);assert.equal(env.billing.overview(env.actors.bob).automaticCharges,false);
});
test('role enviado pelo cliente não concede financeiro ou plataforma e callback assíncrono é rejeitado',t=>{
  const env=fixture(t);assert.throws(()=>env.billing.overview({...env.actors.operator,role:'reseller',platformAdmin:true}),error=>error.status===403);
  assert.throws(()=>env.contract(env.actors.alice,{scope:'platform',tenantId:undefined,targetWorkspaceId:'workspace-b'}),error=>error.status===403);assert.throws(()=>env.contract(env.actors.alice,{targetWorkspaceId:'workspace-b'}),error=>error.status===403);
  const asyncEnv=fixture(t,{validateActor:async actor=>actor});assert.throws(()=>asyncEnv.billing.overview(asyncEnv.actors.alice),error=>error.status===500);
});
test('contrato exige preços em centavos, moeda explícita e alvo/vigência válidos',t=>{
  const env=fixture(t);
  for(const extra of [{currency:'USD'},{currency:undefined},{items:[]},{items:[{kind:'subscription',label:'Preço',unitCents:1.5,units:1,metered:false}]},{items:[{kind:'subscription',label:'Preço',units:1,metered:false}]},{startsAt:'2026-02-31'},{endsAt:'2026-09-30'},{periodMonths:0},{graceDays:91},{tenantId:'other-company'},{reason:''},{taxId:'do-not-store'}])assert.throws(()=>env.contract(env.actors.alice,extra),error=>error.status===400);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM billing_contracts').get().n,0);
});
test('uso idempotente soma em inteiros, sinaliza quota e compõe o valor medido da fatura',t=>{
  const env=fixture(t),contract=env.contract(),body={requestId:request(),version:1,...period(),metric:'email',quantity:13,reason:'Quantidade revisada do serviço'};
  const first=env.billing.recordUsage(env.actors.alice,contract.id,body);assert.deepEqual(env.billing.recordUsage(env.actors.alice,contract.id,body),first);assert.equal(first.usage.find(u=>u.metric==='email').exceeded,true);
  const invoice=env.invoice(env.actors.alice,contract);assert.equal(invoice.totalCents,1138);assert.equal(invoice.snapshot.items.find(i=>i.kind==='email').units,13);assert.equal(invoice.snapshot.usage.find(u=>u.metric==='email').limit,10);
  assert.throws(()=>env.billing.recordUsage(env.actors.alice,contract.id,{...body,requestId:request()}),error=>error.status===409);
});
test('fatura congela preço, carência e revisão mesmo quando contrato muda',t=>{
  const env=fixture(t),contract=env.contract(),invoice=env.invoice(env.actors.alice,contract),snapshot=structuredClone(invoice.snapshot);
  const update=terms({name:'Contrato atualizado',items:[{kind:'subscription',label:'Novo valor',unitCents:9999,units:1,metered:false}],graceDays:15});delete update.scope;delete update.tenantId;
  const next=env.billing.updateContract(env.actors.alice,contract.id,{...update,version:1});assert.equal(next.version,2);const saved=env.billing.invoiceDetail(env.actors.alice,invoice.id).invoice;assert.deepEqual(saved.snapshot,snapshot);assert.equal(saved.totalCents,1099);assert.equal(saved.graceDays,3);assert.equal(saved.contractVersion,1);assert.equal(saved.contractName,'Contrato configurado');const history=env.billing.detail(env.actors.alice,contract.id).versions;assert.equal(history.length,2);assert.equal(history[0].snapshot.items[0].unitCents,9999);assert.equal(history[1].snapshot.items[0].unitCents,1099);
  assert.throws(()=>env.billing.updateContract(env.actors.alice,contract.id,{...update,requestId:request(),version:1}),error=>error.status===409);
});
test('rascunho, emissão, baixas parciais/totais e reconciliação seguem revisão e ledger',t=>{
  const env=fixture(t),contract=env.contract(),draft=env.invoice(env.actors.alice,contract);assert.equal(draft.state,'draft');assert.throws(()=>env.change(env.actors.alice,draft,'settle',{amountCents:1099,reference:'receipt-a',settledAt:'2026-10-03'}),error=>error.status===409);
  const issued=env.change(env.actors.alice,draft,'issue'),partial=env.change(env.actors.alice,issued,'settle',{amountCents:100,reference:'receipt-a',settledAt:'2026-10-03'});assert.equal(partial.status,'partial');assert.equal(partial.outstandingCents,999);
  const settled=env.change(env.actors.alice,partial,'settle',{amountCents:999,reference:'receipt-b',settledAt:'2026-10-03'});assert.equal(settled.state,'settled');assert.equal(settled.version,4);assert.equal(settled.paidCents,1099);
  assert.deepEqual(env.billing.reconcile(env.actors.alice,settled.id),{balanced:true,totalCents:1099,recordedPaidCents:1099,ledgerPaidCents:1099,grossLedgerCents:1099,reversedCents:0,outstandingCents:0,origin:'manual',providerConfirmed:false});assert.equal(env.billing.invoiceDetail(env.actors.alice,settled.id).settlements.length,2);
});
test('baixa idempotente não duplica e conflito de payload, referência, saldo ou revisão falha',t=>{
  const env=fixture(t),contract=env.contract(),issued=env.change(env.actors.alice,env.invoice(env.actors.alice,contract),'issue'),body={requestId:request(),version:issued.version,action:'settle',amountCents:100,reference:'unique-receipt',settledAt:'2026-10-03',reason:'Recebimento confirmado manualmente'};
  const partial=env.billing.changeInvoice(env.actors.alice,issued.id,body);assert.deepEqual(env.billing.changeInvoice(env.actors.alice,issued.id,body),partial);assert.equal(env.db.prepare('SELECT count(*) AS n FROM billing_settlements').get().n,1);
  assert.throws(()=>env.billing.changeInvoice(env.actors.alice,issued.id,{...body,amountCents:99}),error=>error.status===409);
  assert.throws(()=>env.change(env.actors.alice,partial,'settle',{amountCents:100,reference:'unique-receipt',settledAt:'2026-10-03'}),error=>error.status===409);
  assert.throws(()=>env.change(env.actors.alice,partial,'settle',{amountCents:1000,reference:'other',settledAt:'2026-10-03'}),error=>error.status===400);
  assert.throws(()=>env.change(env.actors.alice,issued,'cancel'),error=>error.status===409);assert.throws(()=>env.change(env.actors.alice,partial,'cancel'),error=>error.status===409);
});
test('cancelamento sem baixa preserva histórico e permite refazer competência com outra fatura',t=>{
  const env=fixture(t),contract=env.contract(),draft=env.invoice(env.actors.alice,contract),cancelled=env.change(env.actors.alice,draft,'cancel');assert.equal(cancelled.state,'cancelled');const replacement=env.invoice(env.actors.alice,contract);assert.notEqual(replacement.id,draft.id);assert.equal(env.billing.detail(env.actors.alice,contract.id).invoices.length,2);assert.throws(()=>env.change(env.actors.alice,cancelled,'issue'),error=>error.status===409);
});
test('competências sobrepostas e uso inválido são recusados sem escrita parcial',t=>{
  const env=fixture(t),contract=env.contract();env.invoice(env.actors.alice,contract);assert.throws(()=>env.invoice(env.actors.alice,contract,{periodStart:'2026-10-15',periodEnd:'2026-11-14'}),error=>error.status===400);assert.throws(()=>env.invoice(env.actors.alice,contract),error=>error.status===409);
  for(const extra of [{quantity:-1},{quantity:0.5},{metric:'arbitrary'},{periodStart:'2026-09-30'},{periodEnd:'2026-09-01'}])assert.throws(()=>env.billing.recordUsage(env.actors.alice,contract.id,{requestId:request(),version:1,...period(),metric:'users',quantity:1,reason:'Medição revisada',...extra}),error=>error.status===400);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM billing_usage').get().n,0);assert.equal(env.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('vencimento, carência e vigência são derivados sem job nem mudança de estado financeiro',t=>{
  const env=fixture(t),contract=env.contract(env.actors.alice,{endsAt:'2026-10-31'}),issued=env.change(env.actors.alice,env.invoice(env.actors.alice,contract,{dueDate:'2026-10-05'}),'issue');env.clock.value=Date.parse('2026-10-06T12:00:00Z');assert.equal(env.billing.invoiceDetail(env.actors.alice,issued.id).invoice.status,'grace');env.clock.value=Date.parse('2026-10-09T12:00:00Z');assert.equal(env.billing.invoiceDetail(env.actors.alice,issued.id).invoice.status,'overdue');env.clock.value=Date.parse('2026-11-01T12:00:00Z');assert.equal(env.billing.detail(env.actors.alice,contract.id).contract.status,'expired');assert.equal(env.billing.invoiceDetail(env.actors.alice,issued.id).invoice.state,'issued');
});
test('revogação é revalidada antes de replay ou mudança; requestId não contorna isolamento',t=>{
  const env=fixture(t),body=terms(),created=env.billing.createContract(env.actors.alice,body);env.users.alice.role='operator';assert.throws(()=>env.billing.createContract(env.actors.alice,body),error=>error.status===403);assert.throws(()=>env.billing.detail(env.actors.alice,created.id),error=>error.status===404);env.users.alice.role='reseller';env.users.alice.disabled=true;assert.throws(()=>env.billing.createContract(env.actors.alice,body),error=>error.status===403);assert.throws(()=>env.billing.detail(env.actors.bob,created.id),error=>error.status===404);
});
test('plano recebido não vaza auditoria, recibos privados ou contratos de terceiros',t=>{
  const env=fixture(t),contract=env.contract(env.actors.owner,{scope:'platform',tenantId:undefined,targetWorkspaceId:'workspace-b'}),issued=env.change(env.actors.owner,env.invoice(env.actors.owner,contract),'issue');env.change(env.actors.owner,issued,'settle',{amountCents:1099,reference:'private-bank-reference',settledAt:'2026-10-03',reason:'private-issuer-comment'});
  const detail=env.billing.detail(env.actors.bob,contract.id),invoice=env.billing.invoiceDetail(env.actors.bob,issued.id);assert.deepEqual(detail.audit,[]);assert.deepEqual(detail.versions,[]);assert.deepEqual(invoice.settlements,[]);assert.equal(JSON.stringify([detail,invoice]).includes('private-bank-reference'),false);assert.equal(JSON.stringify([detail,invoice]).includes('private-issuer-comment'),false);assert.equal(invoice.invoice.canManage,false);assert.equal(invoice.reconciliation.balanced,true);assert.throws(()=>env.billing.invoiceDetail(env.actors.alice,issued.id),error=>error.status===404);
});
test('overflow e centavos fracionários nunca geram cobrança arredondada',t=>{
  const env=fixture(t),contract=env.contract(env.actors.alice,{items:[{kind:'subscription',label:'Valor extremo',unitCents:Number.MAX_SAFE_INTEGER,units:2,metered:false}]});assert.throws(()=>env.invoice(env.actors.alice,contract),error=>error.status===400);assert.equal(env.db.prepare('SELECT count(*) AS n FROM billing_invoices').get().n,0);
  const regular=env.contract(),issued=env.change(env.actors.alice,env.invoice(env.actors.alice,regular),'issue');assert.throws(()=>env.change(env.actors.alice,issued,'settle',{amountCents:0.5,reference:'fractional',settledAt:'2026-10-03'}),error=>error.status===400);
});
test('valor zero explicitamente configurado liquida na emissão sem pagamento inventado',t=>{
  const env=fixture(t),contract=env.contract(env.actors.alice,{items:[{kind:'subscription',label:'Cortesia configurada',unitCents:0,units:1,metered:false}]}),invoice=env.change(env.actors.alice,env.invoice(env.actors.alice,contract),'issue');assert.equal(invoice.state,'settled');assert.equal(invoice.totalCents,0);assert.equal(env.billing.reconcile(env.actors.alice,invoice.id).balanced,true);assert.equal(env.db.prepare('SELECT count(*) AS n FROM billing_settlements').get().n,0);
});
test('contagens atuais vêm do callback autorizado; métricas ausentes ficam indisponíveis',t=>{
  const contexts=[],env=fixture(t,{getUsage:(_actor,context)=>{contexts.push(context);return {connections:3,users:8};}}),contract=env.contract();assert.equal(contract.liveUsage.find(u=>u.metric==='connections').quantity,3);assert.equal(contract.liveUsage.find(u=>u.metric==='connections').exceeded,true);assert.equal(contract.liveUsage.find(u=>u.metric==='email').quantity,null);assert.deepEqual(contexts[0],{scope:'workspace',workspaceId:'workspace-a',tenantId:'company'});const invoice=env.invoice(env.actors.alice,contract);assert.equal(invoice.snapshot.items.find(line=>line.kind==='email').units,0);assert.equal('canManage' in invoice.snapshot.contract,false);
});
