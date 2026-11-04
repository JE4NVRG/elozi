import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {Billing} from '../src/billing.js';

const status=code=>error=>error.status===code;
const terms=extra=>({requestId:randomUUID(),scope:'workspace',tenantId:'unit',name:'Contrato sintético',currency:'BRL',items:[{kind:'subscription',label:'Valor sintético por ciclo',unitCents:1001,units:1,metered:false}],quotas:{connections:2},periodMonths:1,startsAt:'2026-10-01',endsAt:null,graceDays:3,state:'active',reason:'Acordo apenas da fixture',...extra});
function fixture(t,existing){
  const db=existing||new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');t.after(()=>db.close());
  const accounts=[{id:'platform',name:'Plataforma',accountKind:'platform',parentWorkspaceId:null},{id:'seller',name:'Revenda sintética',accountKind:'reseller',parentWorkspaceId:'platform'},{id:'other',name:'Outra revenda',accountKind:'reseller',parentWorkspaceId:'platform'},{id:'buyer',name:'Cliente João',accountKind:'business',parentWorkspaceId:'seller'},{id:'foreign',name:'Cliente externo',accountKind:'business',parentWorkspaceId:'other'}];
  const users={root:{workspace:'platform',role:'reseller',platform:true},seller:{workspace:'seller',role:'reseller'},buyer:{workspace:'buyer',role:'reseller'},other:{workspace:'other',role:'reseller'},operator:{workspace:'seller',role:'operator'},support:{workspace:'seller',role:'reseller',supportGrantId:'temporary'}};
  const actor=name=>({userId:name,resellerId:users[name].workspace});
  const callbacks={validateActor:input=>{const user=users[input.userId];if(!user||user.disabled||input.resellerId!==user.workspace)throw Object.assign(new Error('Revogado'),{status:403});return {...input,role:user.role,...(user.supportGrantId?{supportGrantId:user.supportGrantId}:{})};},isPlatformAdmin:a=>users[a.userId]?.platform===true,getWorkspaces:()=>accounts,getTenants:(_a,id)=>[{id:'unit',name:'Filial '+id}],getUsage:()=>({connections:99,email:999}),now:()=>Date.parse('2026-10-03T00:00:00Z')};
  const billing=new Billing(db,callbacks);
  return {db,accounts,users,actor,billing,callbacks,contract(extra={}){return billing.createContract(actor('seller'),terms(extra));},invoice(c,extra={}){return billing.createInvoice(actor('seller'),c.id,{requestId:randomUUID(),version:c.version,periodStart:'2026-10-01',periodEnd:'2026-10-31',dueDate:'2026-11-05',reason:'Período sintético conferido',...extra});},event(i,action,extra={}){return billing.changeInvoice(actor('seller'),i.id,{requestId:randomUUID(),version:i.version,action,reason:'Operação sintética conferida',...extra});}};
}

test('ciclos trimestrais/mensais preservam âncora e recusam proração, fim parcial e vencimento antecipado',t=>{
  const f=fixture(t),quarter=f.contract({startsAt:'2026-01-31',periodMonths:3});
  const valid=f.invoice(quarter,{periodStart:'2026-04-30',periodEnd:'2026-07-30',dueDate:'2026-05-05'});assert.equal(valid.snapshot.contract.periodMonths,3);
  for(const extra of [{periodStart:'2026-04-01',periodEnd:'2026-06-30'},{periodStart:'2026-04-30',periodEnd:'2026-07-31'},{periodStart:'2026-04-30',periodEnd:'2026-07-30',dueDate:'2026-04-29'}])assert.throws(()=>f.invoice(quarter,extra),status(400));
  const monthly=f.contract({startsAt:'2024-01-31',endsAt:'2024-03-30'});
  assert.equal(f.invoice(monthly,{periodStart:'2024-01-31',periodEnd:'2024-02-28',dueDate:'2024-02-01'}).periodEnd,'2024-02-28');
  assert.equal(f.invoice(monthly,{periodStart:'2024-02-29',periodEnd:'2024-03-30',dueDate:'2024-03-01'}).periodStart,'2024-02-29');
  assert.throws(()=>f.invoice(monthly,{periodStart:'2024-03-31',periodEnd:'2024-04-29',dueDate:'2024-04-01'}),status(400));
  const mid=f.contract({startsAt:'2026-09-15',endsAt:'2026-10-10'});assert.throws(()=>f.invoice(mid,{periodStart:'2026-09-15',periodEnd:'2026-10-10',dueDate:'2026-10-05'}),status(400));
});

test('emissão exige consumo manual conferido, distingue zero de ausência e congela preços sem usar contagem atual',t=>{
  const f=fixture(t),items=[{kind:'email',label:'E-mail sintético',unitCents:7,units:0,metered:true}],c=f.contract({items,quotas:{email:5}}),i=f.invoice(c);
  assert.equal(i.totalCents,0);assert.deepEqual(i.snapshot.usageReview,{source:'manual',entries:0,missingMetrics:['email']});assert.equal(i.snapshot.contract.liveUsage.find(u=>u.metric==='email').quantity,999);
  assert.throws(()=>f.event(i,'issue'),status(409));assert.throws(()=>f.event(i,'issue',{usageReviewed:false}),status(409));
  const {requestId,scope,tenantId,...revision}=terms({items,periodMonths:3,startsAt:'2026-09-15'});f.billing.updateContract(f.actor('seller'),c.id,{...revision,requestId:randomUUID(),version:1});
  const issued=f.event(i,'issue',{usageReviewed:true});assert.equal(issued.state,'settled');assert.equal(issued.snapshot.contract.periodMonths,1);assert.equal(issued.snapshot.contract.startsAt,'2026-10-01');
  const audit=f.db.prepare("SELECT metadata FROM billing_audit WHERE action='invoice.issue' AND invoice_id=?").get(i.id);assert.equal(JSON.parse(audit.metadata).usageReviewed,true);
  const c2=f.contract({items});f.billing.recordUsage(f.actor('seller'),c2.id,{requestId:randomUUID(),version:1,periodStart:'2026-10-01',periodEnd:'2026-10-31',metric:'email',quantity:0,reason:'Zero realmente conferido'});assert.deepEqual(f.invoice(c2).snapshot.usageReview,{source:'manual',entries:1,missingMetrics:[]});
});

test('rascunho legado fora do ciclo não é emitido, sem afetar revisão nem ledger',t=>{
  const f=fixture(t),c=f.contract(),i=f.invoice(c);f.db.prepare('UPDATE billing_invoices SET period_end=? WHERE id=?').run('2026-10-15',i.id);
  assert.throws(()=>f.event(i,'issue'),status(400));assert.equal(f.db.prepare('SELECT version FROM billing_invoices WHERE id=?').get(i.id).version,1);assert.equal(f.db.prepare("SELECT count(*) n FROM billing_audit WHERE action='invoice.issue'").get().n,0);
});

test('correção integral é auditada e idempotente, mantém baixa original e reabre saldo sem devolver dinheiro',t=>{
  const f=fixture(t),c=f.contract(),draft=f.invoice(c),issued=f.event(draft,'issue'),partial=f.event(issued,'settle',{amountCents:401,reference:'Comprovante-A',settledAt:'2026-10-03'}),settled=f.event(partial,'settle',{amountCents:600,reference:'Comprovante-B',settledAt:'2026-10-03'}),original=f.db.prepare('SELECT * FROM billing_settlements WHERE reference=?').get('Comprovante-A');
  const body={requestId:randomUUID(),version:settled.version,action:'reverse',settlementId:original.id,reason:'Digitação errada revisada'};
  const reversed=f.billing.changeInvoice(f.actor('seller'),settled.id,body);assert.deepEqual(f.billing.changeInvoice(f.actor('seller'),settled.id,body),reversed);assert.equal(reversed.state,'issued');assert.equal(reversed.paidCents,600);assert.equal(reversed.outstandingCents,401);assert.deepEqual(f.db.prepare('SELECT * FROM billing_settlements WHERE id=?').get(original.id),original);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_settlement_reversals').get().n,1);assert.equal(f.billing.reconcile(f.actor('seller'),settled.id).grossLedgerCents,1001);assert.equal(f.billing.reconcile(f.actor('seller'),settled.id).reversedCents,401);assert.equal(f.billing.reconcile(f.actor('seller'),settled.id).balanced,true);
  const detail=f.billing.invoiceDetail(f.actor('seller'),settled.id);assert.equal(detail.settlements.find(r=>r.id===original.id).canReverse,false);assert.equal(detail.settlementsLimit.total,2);
  const audit=f.db.prepare("SELECT metadata FROM billing_audit WHERE action='invoice.reverse'").get();assert.equal(JSON.parse(audit.metadata).accountingOnly,true);
  assert.throws(()=>f.event(reversed,'reverse',{settlementId:original.id}),status(409));assert.throws(()=>f.billing.changeInvoice(f.actor('seller'),settled.id,{...body,requestId:randomUUID()}),status(409));
  f.users.seller.disabled=true;assert.throws(()=>f.billing.changeInvoice(f.actor('seller'),settled.id,body),status(403));
});

test('correção não cruza faturas e não permite cancelamento com outra baixa ativa',t=>{
  const f=fixture(t),c=f.contract(),a=f.event(f.invoice(c),'issue'),b=f.event(f.invoice(c,{periodStart:'2026-11-01',periodEnd:'2026-11-30',dueDate:'2026-12-05'}),'issue'),aPaid=f.event(a,'settle',{amountCents:100,reference:'Receipt',settledAt:'2026-10-03'}),receipt=f.billing.invoiceDetail(f.actor('seller'),a.id).settlements[0];
  assert.throws(()=>f.event(b,'reverse',{settlementId:receipt.id}),status(404));assert.throws(()=>f.event(aPaid,'cancel'),status(409));assert.equal(f.db.prepare('SELECT count(*) n FROM billing_settlement_reversals').get().n,0);
});

test('baixas além de200 são paginadas e corrigidas por ID fresco sem truncar ledger ou duplicar reversal',t=>{
  const f=fixture(t),contract=f.contract({tenantId:undefined,targetKind:'reseller',targetWorkspaceId:'buyer'});let invoice=f.event(f.invoice(contract),'issue');
  for(let index=0;index<201;index++)invoice=f.event(invoice,'settle',{amountCents:1,reference:`PRIVATE_RECEIPT_${index}`,settledAt:'2026-10-03'});
  const before=f.db.prepare('SELECT * FROM billing_settlements ORDER BY created_at,id').all(),first=f.billing.invoiceDetail(f.actor('seller'),invoice.id);
  assert.equal(first.settlements.length,200);assert.equal(first.settlementPage.total,201);assert.equal(first.settlementPage.hasMore,true);
  const last=f.billing.invoiceDetail(f.actor('seller'),invoice.id,{settlementsOffset:'200',settlementsLimit:'200'});
  assert.deepEqual(last.settlementPage,{offset:200,limit:200,total:201,hasMore:false});assert.equal(last.settlements.length,1);assert.equal(first.settlements.some(row=>row.id===last.settlements[0].id),false);
  const selected=f.billing.invoiceDetail(f.actor('seller'),invoice.id,{settlementId:last.settlements[0].id});assert.equal(selected.settlements.length,1);assert.equal(selected.settlements[0].id,last.settlements[0].id);assert.equal(selected.invoice.version,invoice.version);assert.equal(selected.settlementPage,null);
  assert.deepEqual(f.db.prepare('SELECT * FROM billing_settlements ORDER BY created_at,id').all(),before);assert.equal(last.reconciliation.ledgerPaidCents,201);
  const body={requestId:randomUUID(),version:invoice.version,action:'reverse',settlementId:selected.settlements[0].id,reason:'Correção conferida além da primeira página'};
  const result=f.billing.changeInvoice(f.actor('seller'),invoice.id,body);assert.equal(result.paidCents,200);assert.deepEqual(f.billing.changeInvoice(f.actor('seller'),invoice.id,body),result);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_settlement_reversals').get().n,1);assert.equal(f.billing.reconcile(f.actor('seller'),invoice.id).balanced,true);
  assert.equal(f.billing.invoiceDetail(f.actor('seller'),invoice.id,{settlementId:body.settlementId}).settlements[0].canReverse,false);
  const payer=f.billing.invoiceDetail(f.actor('buyer'),invoice.id,{settlementsOffset:200,settlementsLimit:1});assert.deepEqual(payer.settlements,[]);assert.equal(payer.settlementsLimit.total,0);assert.equal(JSON.stringify(payer).includes('PRIVATE_RECEIPT_'),false);
  assert.throws(()=>f.billing.invoiceDetail(f.actor('buyer'),invoice.id,{settlementId:body.settlementId}),status(403));
  f.users.seller.disabled=true;assert.throws(()=>f.billing.invoiceDetail(f.actor('seller'),invoice.id,{settlementId:body.settlementId}),status(403));
});

test('página de baixas valida opções estritas e ID individual não atravessa faturas/workspaces',t=>{
  const f=fixture(t),contract=f.contract(),a=f.event(f.invoice(contract),'issue'),paid=f.event(a,'settle',{amountCents:1,reference:'PRIVATE_RECEIPT',settledAt:'2026-10-03'}),receipt=f.billing.invoiceDetail(f.actor('seller'),paid.id).settlements[0];
  const b=f.event(f.invoice(contract,{periodStart:'2026-11-01',periodEnd:'2026-11-30',dueDate:'2026-12-01'}),'issue');
  for(const options of [{limit:200},{settlementsLimit:0},{settlementsLimit:201},{settlementsOffset:-1},{settlementsOffset:'1.5'},{settlementsOffset:'1e3'},
    {settlementsOffset:1000001},{settlementId:''},{settlementId:'bad\nID'},{settlementId:receipt.id,settlementsOffset:0}])assert.throws(()=>f.billing.invoiceDetail(f.actor('seller'),paid.id,options),status(400));
  assert.throws(()=>f.billing.invoiceDetail(f.actor('seller'),b.id,{settlementId:receipt.id}),status(404));assert.throws(()=>f.billing.invoiceDetail(f.actor('other'),paid.id,{settlementId:receipt.id}),status(404));
  const far=f.billing.invoiceDetail(f.actor('seller'),paid.id,{settlementsOffset:'100',settlementsLimit:'1'});assert.deepEqual(far.settlements,[]);assert.equal(far.settlementPage.total,1);assert.equal(far.reconciliation.balanced,true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_settlements').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM billing_settlement_reversals').get().n,0);
});

test('revenda contrata somente business filhos; parentesco não dá acesso operacional/financeiro ao cliente externo',t=>{
  const f=fixture(t),c=f.contract({tenantId:undefined,targetKind:'reseller',targetWorkspaceId:'buyer',reason:'PRIVATE_SELLER_REASON'}),i=f.invoice(c);
  assert.equal(c.target.name,'Cliente João');assert.equal(c.target.parentWorkspaceId,'seller');assert.equal(f.billing.overview(f.actor('seller'),{view:'reseller'}).contracts[0].id,c.id);
  const received=f.billing.overview(f.actor('buyer'),{view:'payable'});assert.equal(received.canManage,false);assert.equal(received.contracts[0].canManage,false);assert.equal(received.invoices[0].id,i.id);
  const detail=f.billing.detail(f.actor('buyer'),c.id);assert.deepEqual(detail.audit,[]);assert.deepEqual(detail.versions,[]);assert.equal(JSON.stringify(detail).includes('PRIVATE_SELLER_REASON'),false);
  assert.throws(()=>f.billing.updateContract(f.actor('buyer'),c.id,{version:1}),status(404));assert.throws(()=>f.billing.detail(f.actor('root'),c.id),status(404));assert.throws(()=>f.billing.detail(f.actor('other'),c.id),status(404));
  for(const targetWorkspaceId of ['foreign','other','seller','platform'])assert.throws(()=>f.contract({tenantId:undefined,targetKind:'reseller',targetWorkspaceId}),status(400));
  for(const name of ['operator','support'])assert.throws(()=>f.billing.overview({...f.actor(name),role:'reseller',platformOwner:true},{view:'reseller'}),status(403));
  const payer=f.billing.invoiceDetail(f.actor('buyer'),i.id);assert.deepEqual(payer.settlements,[]);assert.equal(payer.settlementsLimit.total,0);
  f.accounts.find(a=>a.id==='buyer').parentWorkspaceId='other';assert.equal(f.billing.detail(f.actor('seller'),c.id).contract.canManage,false);assert.throws(()=>f.invoice(c),status(404));assert.equal(f.billing.overview(f.actor('buyer'),{view:'payable'}).contracts.length,1);
});

test('plataforma pode contratar cliente direto e revenda, com leituras recebidas limitadas à conta',t=>{
  const f=fixture(t),create=targetWorkspaceId=>f.billing.createContract(f.actor('root'),terms({scope:'platform',tenantId:undefined,targetWorkspaceId,targetKind:'reseller',reason:'PRIVATE_PLATFORM_REASON'})),direct=create('buyer'),reseller=create('seller');
  assert.equal(f.billing.overview(f.actor('root'),{view:'platform'}).contractPage.total,2);assert.deepEqual(f.billing.overview(f.actor('buyer'),{view:'payable'}).contracts.map(c=>c.id),[direct.id]);assert.deepEqual(f.billing.overview(f.actor('seller'),{view:'payable'}).contracts.map(c=>c.id),[reseller.id]);assert.throws(()=>create('platform'),status(400));
  f.users.root.role='operator';assert.throws(()=>f.billing.overview(f.actor('root'),{view:'platform'}),status(403));
});

test('paginação passa 200, mantém faturas independentes da página de contratos e filtros antes de totais',t=>{
  const f=fixture(t);for(let n=0;n<211;n++){const c=f.contract({name:'Contrato '+String(n).padStart(3,'0')});f.invoice(c);}
  const first=f.billing.overview(f.actor('seller'),{contractLimit:'2',invoiceLimit:'3'});assert.equal(first.contractPage.total,211);assert.equal(first.invoicePage.total,211);assert.equal(first.contracts.length,2);assert.equal(first.invoices.length,3);
  const last=f.billing.overview(f.actor('seller'),{contractOffset:'200',contractLimit:'200',invoiceOffset:'200',invoiceLimit:'50'});assert.equal(last.contracts.length,11);assert.equal(last.invoices.length,11);assert.equal(last.contractPage.hasMore,false);
  const filtered=f.billing.overview(f.actor('seller'),{q:'contrato 210',targetId:'unit',invoiceStatus:'draft'});assert.equal(filtered.contractPage.total,1);assert.equal(filtered.invoicePage.total,1);
  assert.equal(f.billing.overview(f.actor('seller'),{invoiceStatus:'settled'}).invoicePage.total,0);assert.equal(f.billing.overview(f.actor('other')).contractPage.total,0);
  for(const options of [{invoiceLimit:'0'},{invoiceLimit:'201'},{contractOffset:'-1'},{contractOffset:'1e2'},{contractLimit:'NaN'},{invoiceStatus:'paid'},{q:'x\nx'},{unscoped:true}])assert.throws(()=>f.billing.overview(f.actor('seller'),options),status(400));
});

const legacyDDL=String.raw`CREATE TABLE billing_contracts (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('platform','workspace')), seller_workspace_id TEXT NOT NULL,
 target_workspace_id TEXT NOT NULL, tenant_id TEXT, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='BRL'),
 items TEXT NOT NULL, quotas TEXT NOT NULL, period_months INTEGER NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT,
 grace_days INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','suspended','ended')), version INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((scope='platform' AND tenant_id IS NULL) OR (scope='workspace' AND tenant_id IS NOT NULL AND seller_workspace_id=target_workspace_id))
);
CREATE TABLE legacy_child(id TEXT PRIMARY KEY,contract_id TEXT NOT NULL REFERENCES billing_contracts(id));
CREATE TABLE migration_marker(name TEXT);
CREATE INDEX legacy_contract_name ON billing_contracts(name);
CREATE TRIGGER legacy_contract_update AFTER UPDATE OF name ON billing_contracts BEGIN INSERT INTO migration_marker VALUES(new.name); END;
CREATE TRIGGER child_contract_exists BEFORE INSERT ON legacy_child BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_contracts WHERE id=new.contract_id) THEN RAISE(ABORT,'missing parent') END; END;
CREATE VIEW legacy_contract_view AS SELECT id,name FROM billing_contracts;`;
function legacy(t){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;'+legacyDDL);db.prepare('INSERT INTO billing_contracts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy','workspace','seller','seller','unit','Legado','BRL',JSON.stringify(terms().items),'{}',1,'2026-10-01',null,0,'active',1,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');db.exec("INSERT INTO legacy_child VALUES('child','legacy')");return db;
}
test('migração preserva rows, FKs, índices, gatilhos próprios/externos e views e pode repetir sem rebuild',t=>{
 const db=legacy(t),before=Object.fromEntries(db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('legacy_contract_name','legacy_contract_update','child_contract_exists','legacy_contract_view')").all().map(r=>[r.name,r.sql])),f=fixture(t,db);
 assert.equal(db.prepare("SELECT target_kind FROM billing_contracts WHERE id='legacy'").get().target_kind,'tenant');assert.equal(db.prepare('SELECT count(*) n FROM legacy_child').get().n,1);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(db.prepare('PRAGMA legacy_alter_table').get().legacy_alter_table,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.deepEqual(Object.fromEntries(db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('legacy_contract_name','legacy_contract_update','child_contract_exists','legacy_contract_view')").all().map(r=>[r.name,r.sql])),before);
 db.prepare('UPDATE billing_contracts SET name=? WHERE id=?').run('Preservado','legacy');assert.equal(db.prepare('SELECT name FROM migration_marker').get().name,'Preservado');assert.equal(db.prepare('SELECT name FROM legacy_contract_view').get().name,'Preservado');assert.throws(()=>db.exec("INSERT INTO legacy_child VALUES('invalid','missing')"));
 new Billing(db,f.callbacks);assert.equal(db.prepare('SELECT count(*) n FROM billing_contracts').get().n,1);f.contract({tenantId:undefined,targetKind:'reseller',targetWorkspaceId:'buyer'});
});
test('migração recusa transação externa sem comitá-la, preservar pragmas e a responsabilidade do chamador',t=>{
 const db=legacy(t);t.after(()=>db.close());db.exec('BEGIN IMMEDIATE');db.exec("INSERT INTO migration_marker VALUES('uncommitted')");
 assert.throws(()=>new Billing(db,{validateActor:a=>a,isPlatformAdmin:()=>false,getWorkspaces:()=>[],getTenants:()=>[]}),status(503));assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(db.prepare('PRAGMA table_info(billing_contracts)').all().some(c=>c.name==='target_kind'),false);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM migration_marker').get().n,0);
});
test('erro de FK na migração desfaz rebuild e restaura pragmas sem apagar dados anteriores',t=>{
 const db=legacy(t);t.after(()=>db.close());db.exec("INSERT INTO legacy_child VALUES('orphan','legacy'); PRAGMA foreign_keys=OFF; UPDATE legacy_child SET contract_id='missing' WHERE id='orphan'; PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=ON");
 assert.throws(()=>new Billing(db,{validateActor:a=>a,isPlatformAdmin:()=>false,getWorkspaces:()=>[],getTenants:()=>[]}),status(503));assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(db.prepare('PRAGMA legacy_alter_table').get().legacy_alter_table,1);assert.equal(db.prepare('SELECT count(*) n FROM legacy_child').get().n,2);assert.equal(db.prepare('SELECT count(*) n FROM billing_contracts').get().n,1);assert.equal(db.prepare('PRAGMA table_info(billing_contracts)').all().some(c=>c.name==='target_kind'),false);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='billing_contracts_v020'").get().n,0);assert.equal(db.prepare('SELECT name FROM legacy_contract_view').get().name,'Legado');
});

