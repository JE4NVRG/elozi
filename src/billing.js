import {createHash,randomUUID} from 'node:crypto';
import {allowedFields} from './access.js';

export const BILLING_KINDS=['subscription','connections','users','agent_service','email'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const ordered=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(ordered):Object.fromEntries(Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>[key,ordered(value[key])])):value;
const canonical=value=>JSON.stringify(ordered(value));
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=120&&value===value.trim()&&!/\p{Cc}/u.test(value);
const integer=(value,label,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(value)||value<0||value>max)fail(400,`${label} precisa ser um inteiro não negativo dentro do limite.`);return value;};
const add=(a,b)=>integer(a+b,'Total em centavos');
const label=(value,name,max=160)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max||/\p{Cc}/u.test(value))fail(400,`${name} inválido.`);return value.trim();};
const date=(value,name)=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)fail(400,`${name} precisa ser uma data válida.`);return value;};
const reason=value=>label(value,'Motivo',500);
const version=value=>{if(!Number.isSafeInteger(value)||value<1)fail(400,'Informe a revisão atual.');return value;};
const sync=(fn,...args)=>{const value=fn(...args);if(value&&typeof value.then==='function')fail(500,'A autorização financeira precisa ser síncrona.');return value;};
const fields=(value,allowed)=>allowedFields(value,allowed,'Informe somente os campos desta operação financeira.');
const quote=value=>`"${value.replaceAll('"','""')}"`;
const normalize=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
const pageNumber=(value,fallback,name,max)=>{if(value===undefined||value==='')return fallback;if(typeof value==='string'&&/^\d+$/.test(value))value=Number(value);return integer(value,name,max);};
const pageInfo=(offset,limit,total)=>({offset,limit,total,hasMore:offset+limit<total});
const contractColumns=['id','scope','seller_workspace_id','target_workspace_id','tenant_id','name','currency','items','quotas','period_months','starts_at','ends_at','grace_days','state','version','created_at','updated_at'];
const contractTable=name=>`CREATE TABLE ${quote(name)} (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('platform','workspace')), seller_workspace_id TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL, tenant_id TEXT, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='BRL'),
  items TEXT NOT NULL, quotas TEXT NOT NULL, period_months INTEGER NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT,
  grace_days INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','suspended','ended')), version INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('tenant','reseller')),
  CHECK((scope='platform' AND tenant_id IS NULL AND target_kind='reseller') OR
    (scope='workspace' AND ((target_kind='tenant' AND tenant_id IS NOT NULL AND seller_workspace_id=target_workspace_id) OR
      (target_kind='reseller' AND tenant_id IS NULL AND seller_workspace_id<>target_workspace_id))))
)`;
function ensureContracts(db){
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='billing_contracts'").get()){db.exec(contractTable('billing_contracts'));return;}
  const columns=db.prepare('PRAGMA table_info(billing_contracts)').all().map(row=>row.name);if(columns.includes('target_kind'))return;
  if(columns.length!==contractColumns.length||contractColumns.some(name=>!columns.includes(name)))fail(503,'Schema financeiro desconhecido; dados preservados para revisão da migração.');
  const foreignKeys=Object.values(db.prepare('PRAGMA foreign_keys').get())[0],legacy=Object.values(db.prepare('PRAGMA legacy_alter_table').get())[0];let started=false;
  db.exec('PRAGMA foreign_keys=OFF');
  if(Object.values(db.prepare('PRAGMA foreign_keys').get())[0]!==0)fail(503,'A migração financeira exige conexão fora de uma transação.');
  try{
    db.exec('PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');started=true;
    const associated=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='billing_contracts' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
    db.exec(contractTable('billing_contracts_v020'));
    db.exec(`INSERT INTO billing_contracts_v020 (${contractColumns.map(quote).join(',')},target_kind) SELECT ${contractColumns.map(quote).join(',')},CASE WHEN scope='platform' THEN 'reseller' ELSE 'tenant' END FROM billing_contracts`);
    db.exec('DROP TABLE billing_contracts; ALTER TABLE billing_contracts_v020 RENAME TO billing_contracts');
    for(const item of associated)db.exec(item.sql);
    if(db.prepare('PRAGMA foreign_key_check').all().length)fail(503,'A migração financeira não passou nas chaves estrangeiras; dados preservados.');
    db.exec('COMMIT');started=false;
  }catch(error){if(started)db.exec('ROLLBACK');throw error;}
  finally{db.exec(`PRAGMA legacy_alter_table=${legacy?1:0}; PRAGMA foreign_keys=${foreignKeys?1:0}`);}
}
function boundary(anchor,index,months){
  const parsed=new Date(`${anchor}T00:00:00Z`),day=parsed.getUTCDate();parsed.setUTCDate(1);parsed.setUTCMonth(parsed.getUTCMonth()+index*months);
  const last=new Date(parsed);last.setUTCMonth(last.getUTCMonth()+1,0);parsed.setUTCDate(Math.min(day,last.getUTCDate()));
  const value=parsed.toISOString().slice(0,10);return date(value,'Limite do ciclo');
}
function cycle(contract,start,end){
  const anchor=contract.starts_at??contract.startsAt,months=contract.period_months??contract.periodMonths,last=contract.ends_at??contract.endsAt;
  date(anchor,'Início do contrato');if(!Number.isInteger(months)||months<1||months>12)fail(400,'Periodicidade do contrato indisponível.');
  const a=new Date(`${anchor}T00:00:00Z`),s=new Date(`${start}T00:00:00Z`),index=((s.getUTCFullYear()-a.getUTCFullYear())*12+s.getUTCMonth()-a.getUTCMonth())/months;
  if(!Number.isInteger(index)||index<0||boundary(anchor,index,months)!==start)fail(400,'A competência deve começar em um ciclo completo do contrato.');
  const finish=new Date(`${boundary(anchor,index+1,months)}T00:00:00Z`);finish.setUTCDate(finish.getUTCDate()-1);
  if(finish.toISOString().slice(0,10)!==end||last&&end>last)fail(400,'Use o ciclo completo dentro da vigência; períodos parciais exigem um acordo revisado, sem proração automática.');
  return {start,end};
}

// Separate bookkeeping namespace. No payment provider, external send, tenant snapshot or agent tool.
export class Billing {
  constructor(db,{validateActor,isPlatformAdmin,getWorkspaces,getTenants,getUsage=()=>({}),now=()=>Date.now()}={}) {
    if(!db||[validateActor,isPlatformAdmin,getWorkspaces,getTenants,getUsage,now].some(fn=>typeof fn!=='function'))throw new Error('Cobrança exige SQLite e validadores síncronos.');
    Object.assign(this,{db,validateActor,isPlatformAdmin,getWorkspaces,getTenants,getUsage,now});
    ensureContracts(db);
    db.exec(`CREATE INDEX IF NOT EXISTS billing_contract_scope ON billing_contracts(scope,seller_workspace_id,target_workspace_id);
    CREATE TABLE IF NOT EXISTS billing_contract_versions (
      contract_id TEXT NOT NULL REFERENCES billing_contracts(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL,
      actor_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(contract_id,version)
    );
    CREATE TABLE IF NOT EXISTS billing_invoices (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES billing_contracts(id), contract_version INTEGER NOT NULL, snapshot TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, due_date TEXT NOT NULL, grace_days INTEGER NOT NULL,
      total_cents INTEGER NOT NULL CHECK(total_cents>=0), paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents>=0 AND paid_cents<=total_cents),
      state TEXT NOT NULL CHECK(state IN ('draft','issued','settled','cancelled')), version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS billing_invoice_period ON billing_invoices(contract_id,period_start,period_end) WHERE state<>'cancelled';
    CREATE TABLE IF NOT EXISTS billing_usage (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES billing_contracts(id), metric TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity>=0), period_start TEXT NOT NULL, period_end TEXT NOT NULL, created_at TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS billing_usage_period ON billing_usage(contract_id,period_start,period_end);
    CREATE TABLE IF NOT EXISTS billing_settlements (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES billing_invoices(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      reference TEXT NOT NULL, settled_at TEXT NOT NULL, created_at TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL,
      UNIQUE(invoice_id,reference)
    ); CREATE TABLE IF NOT EXISTS billing_audit (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES billing_contracts(id), invoice_id TEXT REFERENCES billing_invoices(id),
      actor_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS billing_requests (
      actor_id TEXT NOT NULL, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(actor_id,workspace_id,request_id)
    ); CREATE TABLE IF NOT EXISTS billing_settlement_reversals (
      id TEXT PRIMARY KEY, settlement_id TEXT NOT NULL UNIQUE REFERENCES billing_settlements(id),
      invoice_id TEXT NOT NULL REFERENCES billing_invoices(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      actor_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
  }
  timestamp(){const value=this.now();if(!Number.isFinite(value))fail(500,'Relógio financeiro inválido.');return new Date(value).toISOString();}
  actor(input){const actor=sync(this.validateActor,input);if(!actor||!identity(actor.userId)||!identity(actor.resellerId)||actor.supportGrantId||actor.kind==='service')fail(403,'Acesso financeiro indisponível.');return actor;}
  platform(actor){return actor.role==='reseller'&&sync(this.isPlatformAdmin,actor)===true;}
  admin(actor){if(actor.role!=='reseller')fail(403,'A cobrança pertence ao administrador.');}
  accounts(actor){const rows=sync(this.getWorkspaces,actor);if(!Array.isArray(rows))fail(500,'O diretório de contas é inválido.');return rows;}
  account(actor,id){return this.accounts(actor).find(row=>row.id===id);}
  reseller(actor){this.admin(actor);if(this.account(actor,actor.resellerId)?.accountKind!=='reseller')fail(403,'A gestão dos clientes pertence à revenda cadastrada.');}
  child(actor,id){const account=this.account(actor,id);return account?.accountKind==='business'&&account.parentWorkspaceId===actor.resellerId;}
  manage(actor,row){return row.scope==='platform'?this.platform(actor):actor.role==='reseller'&&row.seller_workspace_id===actor.resellerId&&(row.target_kind==='tenant'||this.account(actor,actor.resellerId)?.accountKind==='reseller'&&this.child(actor,row.target_workspace_id));}
  targetMetadata(actor,row){
    const account=this.account(actor,row.target_workspace_id),tenant=row.target_kind==='tenant'?sync(this.getTenants,actor,row.target_workspace_id)?.find(item=>item.id===row.tenant_id):null;
    return {id:row.target_kind==='tenant'?row.tenant_id:row.target_workspace_id,name:tenant?.name??account?.name??'',accountKind:account?.accountKind??null,parentWorkspaceId:account?.parentWorkspaceId??null};
  }
  contract(actor,id,{write=false}={}) {
    if(!identity(id))fail(400,'Contrato inválido.');
    const row=this.db.prepare('SELECT * FROM billing_contracts WHERE id=?').get(id);if(!row)fail(404,'Contrato não encontrado.');
    const permitted=write?this.manage(actor,row):row.scope==='platform'?(this.platform(actor)||actor.role==='reseller'&&row.target_workspace_id===actor.resellerId):actor.role==='reseller'&&(row.seller_workspace_id===actor.resellerId||row.target_kind==='reseller'&&row.target_workspace_id===actor.resellerId);
    if(!permitted)fail(404,'Contrato não encontrado neste acesso.');return row;
  }
  invoice(actor,id,{write=false}={}){if(!identity(id))fail(400,'Fatura inválida.');const row=this.db.prepare('SELECT * FROM billing_invoices WHERE id=?').get(id);if(!row)fail(404,'Fatura não encontrada.');return {row,contract:this.contract(actor,row.contract_id,{write})};}
  directory(actor,view) {
    if(view==='platform'){if(!this.platform(actor))fail(403,'A gestão da plataforma é reservada ao administrador da plataforma.');return this.accounts(actor).filter(row=>row.accountKind!=='platform');}
    if(view==='reseller'){this.reseller(actor);return this.accounts(actor).filter(row=>row.accountKind==='business'&&row.parentWorkspaceId===actor.resellerId);}
    if(view==='payable'){this.admin(actor);return this.accounts(actor).filter(row=>row.id===actor.resellerId);}
    if(view!=='workspace')fail(400,'Escolha a visão financeira.');this.admin(actor);return sync(this.getTenants,actor,actor.resellerId);
  }
  target(actor,input) {
    if(input.scope==='platform') {
      const targets=this.directory(actor,'platform');if(!Array.isArray(targets)||!targets.some(target=>target.id===input.targetWorkspaceId))fail(400,'Escolha uma revenda disponível.');
      if(input.tenantId!==undefined&&input.tenantId!==null||input.targetKind!==undefined&&input.targetKind!=='reseller')fail(400,'Contrato da plataforma precisa identificar a conta, sem empresa.');return {seller:'platform',workspace:input.targetWorkspaceId,tenant:null,kind:'reseller'};
    }
    if(input.scope!=='workspace')fail(400,'Escolha plataforma ou empresa para o contrato.');
    if(input.targetKind==='reseller'){
      const targets=this.directory(actor,'reseller');if(!targets.some(row=>row.id===input.targetWorkspaceId)||input.tenantId!==undefined&&input.tenantId!==null)fail(400,'Escolha uma conta cliente vinculada a esta revenda.');return {seller:actor.resellerId,workspace:input.targetWorkspaceId,tenant:null,kind:'reseller'};
    }
    if(input.targetKind!==undefined&&input.targetKind!=='tenant')fail(400,'Escolha um alvo financeiro válido.');
    if(input.targetWorkspaceId!==undefined&&input.targetWorkspaceId!==actor.resellerId)fail(403,'O contrato precisa pertencer ao workspace atual.');
    const targets=this.directory(actor,'workspace');if(!Array.isArray(targets)||!targets.some(target=>target.id===input.tenantId))fail(400,'Escolha uma empresa deste workspace.');return {seller:actor.resellerId,workspace:actor.resellerId,tenant:input.tenantId,kind:'tenant'};
  }
  items(input) {
    if(!Array.isArray(input)||!input.length||input.length>20)fail(400,'Cadastre de 1 a 20 itens com preço explícito.');
    return input.map(item=>{fields(item,['kind','label','unitCents','units','metered']);if(!BILLING_KINDS.includes(item.kind)||typeof item.metered!=='boolean')fail(400,'Escolha o item e se o uso será medido.');return {kind:item.kind,label:label(item.label,'Nome do item'),unitCents:integer(item.unitCents,'Preço em centavos'),units:integer(item.units,'Quantidade',1000000),metered:item.metered};});
  }
  quotas(input) {
    if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Informe os limites de uso.');fields(input,BILLING_KINDS);
    return Object.fromEntries(Object.entries(input).map(([metric,value])=>[metric,value===null?null:integer(value,'Limite de uso',1000000000)]));
  }
  terms(input) {
    const starts=date(input.startsAt,'Início'),ends=input.endsAt==null?null:date(input.endsAt,'Fim');if(ends&&ends<starts)fail(400,'O fim precisa ocorrer após o início.');
    if(input.currency!=='BRL')fail(400,'A moeda desta operação é BRL.');
    if(!Number.isInteger(input.periodMonths)||input.periodMonths<1||input.periodMonths>12)fail(400,'Escolha periodicidade entre 1 e 12 meses.');
    if(!['active','suspended','ended'].includes(input.state))fail(400,'Estado de contrato inválido.');
    return {name:label(input.name,'Nome do contrato'),currency:'BRL',items:this.items(input.items),quotas:this.quotas(input.quotas),periodMonths:input.periodMonths,startsAt:starts,endsAt:ends,graceDays:integer(input.graceDays,'Carência em dias',90),state:input.state};
  }
  write(actor,requestId,payload,operation,authorize=()=>{}) {
    if(!identity(requestId)||requestId.length<8)fail(400,'Informe a identificação desta operação.');
    const hash=createHash('sha256').update(canonical(payload)).digest('hex');this.db.exec('BEGIN IMMEDIATE');
    try {
      const fresh=this.actor(actor);if(fresh.userId!==actor.userId||fresh.resellerId!==actor.resellerId)fail(403,'O acesso financeiro mudou.');
      authorize(fresh);
      const previous=this.db.prepare('SELECT * FROM billing_requests WHERE actor_id=? AND workspace_id=? AND request_id=?').get(actor.userId,actor.resellerId,requestId);
      if(previous){if(previous.payload_hash!==hash)fail(409,'A identificação já foi usada com outros dados.');const result=JSON.parse(previous.result);this.db.exec('COMMIT');return result;}
      const result=operation(fresh);this.db.prepare('INSERT INTO billing_requests VALUES (?,?,?,?,?)').run(actor.userId,actor.resellerId,requestId,hash,JSON.stringify(result));this.db.exec('COMMIT');return result;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  audit(actor,contractId,invoiceId,action,why,metadata={}) {this.db.prepare('INSERT INTO billing_audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),contractId,invoiceId,actor.userId,action,why,JSON.stringify(metadata),this.timestamp());}
  saveVersion(actor,id,why){const row=this.contract(actor,id,{write:true});this.db.prepare('INSERT INTO billing_contract_versions VALUES (?,?,?,?,?,?)').run(id,row.version,JSON.stringify(this.contractSnapshot(actor,row)),actor.userId,why,this.timestamp());}
  contractDTO(actor,row) {
    const today=this.timestamp().slice(0,10),status=row.state==='active'?(today<row.starts_at?'scheduled':row.ends_at&&today>row.ends_at?'expired':'active'):row.state;
    const counts=sync(this.getUsage,actor,{scope:row.scope,workspaceId:row.target_workspace_id,tenantId:row.tenant_id});if(!counts||typeof counts!=='object'||Array.isArray(counts))fail(500,'O uso financeiro atual é inválido.');
    const quotas=JSON.parse(row.quotas),liveUsage=BILLING_KINDS.map(metric=>{const quantity=counts[metric]??null;if(quantity!==null)integer(quantity,'Uso atual');return {metric,quantity,limit:quotas[metric]??null,exceeded:quantity!==null&&quotas[metric]!=null&&quantity>quotas[metric]};});
    return {id:row.id,scope:row.scope,targetKind:row.target_kind,targetWorkspaceId:row.target_workspace_id,target:this.targetMetadata(actor,row),tenantId:row.tenant_id,name:row.name,currency:row.currency,items:JSON.parse(row.items),quotas,liveUsage,periodMonths:row.period_months,startsAt:row.starts_at,endsAt:row.ends_at,graceDays:row.grace_days,state:row.state,status,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,canManage:this.manage(actor,row)};
  }
  contractSnapshot(actor,row) {const snapshot=this.contractDTO(actor,row);delete snapshot.canManage;return snapshot;}
  invoiceDTO(actor,row,contract) {
    const now=this.timestamp().slice(0,10),days=Math.max(0,Math.floor((Date.parse(`${now}T00:00:00Z`)-Date.parse(`${row.due_date}T00:00:00Z`))/86400000));
    const status=row.state!=='issued'?row.state:days>row.grace_days?'overdue':days>0?'grace':row.paid_cents>0?'partial':'issued';
    const snapshot=JSON.parse(row.snapshot);return {id:row.id,contractId:row.contract_id,contractVersion:row.contract_version,contractName:snapshot.contract.name,scope:contract.scope,targetKind:contract.target_kind,target:this.targetMetadata(actor,contract),tenantId:contract.tenant_id,targetWorkspaceId:contract.target_workspace_id,snapshot,periodStart:row.period_start,periodEnd:row.period_end,dueDate:row.due_date,graceDays:row.grace_days,totalCents:row.total_cents,paidCents:row.paid_cents,outstandingCents:row.total_cents-row.paid_cents,state:row.state,status,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,canManage:this.manage(actor,contract)};
  }
  overview(input,options={}) {
    fields(options,['view','contractOffset','contractLimit','invoiceOffset','invoiceLimit','q','invoiceStatus','targetId']);const {view='workspace',q='',invoiceStatus='all',targetId=''}=options;
    if(typeof q!=='string'||q.length>160||/\p{Cc}/u.test(q)||!['all','draft','issued','partial','grace','overdue','settled','cancelled'].includes(invoiceStatus)||targetId!==''&&!identity(targetId))fail(400,'Filtros financeiros inválidos.');
    const contractOffset=pageNumber(options.contractOffset,0,'Página de contratos',1000000),contractLimit=pageNumber(options.contractLimit,50,'Limite de contratos',200),invoiceOffset=pageNumber(options.invoiceOffset,0,'Página de faturas',1000000),invoiceLimit=pageNumber(options.invoiceLimit,50,'Limite de faturas',200);if(!contractLimit||!invoiceLimit)fail(400,'Use ao menos um registro por página.');
    const actor=this.actor(input),targets=this.directory(actor,view);if(!Array.isArray(targets))fail(500,'O diretório financeiro é inválido.');
    const condition=view==='platform'?"scope='platform'":view==='reseller'?"scope='workspace' AND target_kind='reseller' AND seller_workspace_id=?":view==='payable'?"target_kind='reseller' AND target_workspace_id=?":"(scope='workspace' AND target_kind='tenant' AND seller_workspace_id=?) OR (target_kind='reseller' AND target_workspace_id=?)";
    const args=view==='platform'?[]:view==='workspace'?[actor.resellerId,actor.resellerId]:[actor.resellerId];
    const search=normalize(q.trim()),rows=this.db.prepare(`SELECT * FROM billing_contracts WHERE ${condition} ORDER BY created_at DESC,id`).all(...args).filter(row=>{
      const target=this.targetMetadata(actor,row);return (!targetId||target.id===targetId)&&(!search||[row.id,row.name,target.name].some(value=>normalize(value).includes(search)));
    }),map=new Map(rows.map(row=>[row.id,row]));
    const invoices=this.db.prepare(`SELECT i.* FROM billing_invoices i JOIN billing_contracts c ON c.id=i.contract_id WHERE ${condition.replace(/\b(scope|target_kind|seller_workspace_id|target_workspace_id)\b/g,'c.$1')} ORDER BY i.created_at DESC,i.id`).all(...args).filter(row=>map.has(row.contract_id)).map(row=>this.invoiceDTO(actor,row,map.get(row.contract_id))).filter(row=>invoiceStatus==='all'||row.status===invoiceStatus);
    const readonly=view==='payable';return {view,canManage:!readonly,canManagePlatform:this.platform(actor),targets:targets.map(target=>({id:target.id,name:target.name,accountKind:target.accountKind??null,parentWorkspaceId:target.parentWorkspaceId??null})),contracts:rows.slice(contractOffset,contractOffset+contractLimit).map(row=>({...this.contractDTO(actor,row),...(readonly?{canManage:false}:{})})),invoices:invoices.slice(invoiceOffset,invoiceOffset+invoiceLimit).map(row=>({...row,...(readonly?{canManage:false}:{})})),contractPage:pageInfo(contractOffset,contractLimit,rows.length),invoicePage:pageInfo(invoiceOffset,invoiceLimit,invoices.length),filters:{q,invoiceStatus,targetId},currency:'BRL',paymentProvider:null,automaticCharges:false};
  }
  createContract(input,body) {
    fields(body,['requestId','scope','targetKind','targetWorkspaceId','tenantId','name','currency','items','quotas','periodMonths','startsAt','endsAt','graceDays','state','reason']);
    const actor=this.actor(input);this.target(actor,body);const terms=this.terms(body),why=reason(body.reason);
    return this.write(actor,body.requestId,{op:'createContract',...body},fresh=>{const target=this.target(fresh,body),id=randomUUID(),timestamp=this.timestamp();this.db.prepare('INSERT INTO billing_contracts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,body.scope,target.seller,target.workspace,target.tenant,terms.name,terms.currency,JSON.stringify(terms.items),JSON.stringify(terms.quotas),terms.periodMonths,terms.startsAt,terms.endsAt,terms.graceDays,terms.state,1,timestamp,timestamp,target.kind);this.saveVersion(fresh,id,why);this.audit(fresh,id,null,'contract.created',why,{version:1});return this.contractDTO(fresh,this.contract(fresh,id));},fresh=>this.target(fresh,body));
  }
  updateContract(input,id,body) {
    fields(body,['requestId','version','name','currency','items','quotas','periodMonths','startsAt','endsAt','graceDays','state','reason']);
    const actor=this.actor(input);this.contract(actor,id,{write:true});const revision=version(body.version),terms=this.terms(body),why=reason(body.reason);
    return this.write(actor,body.requestId,{op:'updateContract',id,...body},fresh=>{const previous=this.contract(fresh,id,{write:true});if(previous.version!==revision)fail(409,'O contrato mudou. Atualize antes de salvar.');this.db.prepare('UPDATE billing_contracts SET name=?,currency=?,items=?,quotas=?,period_months=?,starts_at=?,ends_at=?,grace_days=?,state=?,version=version+1,updated_at=? WHERE id=?').run(terms.name,terms.currency,JSON.stringify(terms.items),JSON.stringify(terms.quotas),terms.periodMonths,terms.startsAt,terms.endsAt,terms.graceDays,terms.state,this.timestamp(),id);this.saveVersion(fresh,id,why);this.audit(fresh,id,null,'contract.updated',why,{previousVersion:revision,version:revision+1});return this.contractDTO(fresh,this.contract(fresh,id));},fresh=>this.contract(fresh,id,{write:true}));
  }
  period(contract,body) {const start=date(body.periodStart,'Início da competência'),end=date(body.periodEnd,'Fim da competência');if(start>end||start<contract.starts_at||contract.ends_at&&end>contract.ends_at)fail(400,'A competência precisa estar dentro da vigência do contrato.');return cycle(contract,start,end);}
  usage(actor,contract,start,end) {
    const quantities=Object.fromEntries(BILLING_KINDS.map(kind=>[kind,0]));for(const row of this.db.prepare('SELECT metric,quantity FROM billing_usage WHERE contract_id=? AND period_start=? AND period_end=?').all(contract.id,start,end))quantities[row.metric]=add(quantities[row.metric],row.quantity);
    const quotas=JSON.parse(contract.quotas);return BILLING_KINDS.map(metric=>({metric,quantity:quantities[metric],limit:quotas[metric]??null,exceeded:quotas[metric]!=null&&quantities[metric]>quotas[metric]}));
  }
  recordUsage(input,id,body) {
    fields(body,['requestId','version','periodStart','periodEnd','metric','quantity','reason']);const actor=this.actor(input),contract=this.contract(actor,id,{write:true}),revision=version(body.version),period=this.period(contract,body),why=reason(body.reason);if(!BILLING_KINDS.includes(body.metric))fail(400,'Métrica de uso inválida.');integer(body.quantity,'Uso registrado',1000000000);
    return this.write(actor,body.requestId,{op:'recordUsage',id,...body},fresh=>{const current=this.contract(fresh,id,{write:true});if(current.version!==revision)fail(409,'O contrato mudou. Atualize antes de registrar o uso.');if(this.db.prepare("SELECT 1 FROM billing_invoices WHERE contract_id=? AND period_start=? AND period_end=? AND state<>'cancelled'").get(id,period.start,period.end))fail(409,'Esta competência já tem uma fatura. O uso faturado permanece congelado.');const eventId=randomUUID();this.db.prepare('INSERT INTO billing_usage VALUES (?,?,?,?,?,?,?,?,?)').run(eventId,id,body.metric,body.quantity,period.start,period.end,this.timestamp(),fresh.userId,why);this.audit(fresh,id,null,'usage.recorded',why,{metric:body.metric,quantity:body.quantity,periodStart:period.start,periodEnd:period.end});return {id:eventId,usage:this.usage(fresh,current,period.start,period.end)};},fresh=>this.contract(fresh,id,{write:true}));
  }
  createInvoice(input,id,body) {
    fields(body,['requestId','version','periodStart','periodEnd','dueDate','reason']);const actor=this.actor(input),contract=this.contract(actor,id,{write:true}),revision=version(body.version),period=this.period(contract,body),due=date(body.dueDate,'Vencimento'),why=reason(body.reason);
    if(due<period.start)fail(400,'O vencimento não pode anteceder o início da competência.');
    return this.write(actor,body.requestId,{op:'createInvoice',id,...body},fresh=>{const current=this.contract(fresh,id,{write:true});if(current.version!==revision)fail(409,'O contrato mudou. Atualize antes de criar a fatura.');if(current.state!=='active')fail(409,'Ative o contrato antes de criar a fatura.');if(this.db.prepare("SELECT 1 FROM billing_invoices WHERE contract_id=? AND state<>'cancelled' AND period_start<=? AND period_end>=?").get(id,period.end,period.start))fail(409,'Já existe uma fatura para esta competência.');const usage=this.usage(fresh,current,period.start,period.end),items=JSON.parse(current.items).map(item=>{const units=item.metered?usage.find(value=>value.metric===item.kind).quantity:item.units;return {...item,units,totalCents:integer(item.unitCents*units,'Total do item')};}),entries=this.db.prepare('SELECT metric,count(*) AS n FROM billing_usage WHERE contract_id=? AND period_start=? AND period_end=? GROUP BY metric').all(id,period.start,period.end),usageReview={source:'manual',entries:entries.reduce((sum,row)=>sum+row.n,0),missingMetrics:[...new Set(items.filter(item=>item.metered&&!entries.some(row=>row.metric===item.kind)).map(item=>item.kind))]},total=items.reduce((sum,item)=>add(sum,item.totalCents),0),invoiceId=randomUUID(),timestamp=this.timestamp(),snapshot={contract:this.contractSnapshot(fresh,current),items,usage,usageReview,currency:'BRL'};this.db.prepare('INSERT INTO billing_invoices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(invoiceId,id,current.version,JSON.stringify(snapshot),period.start,period.end,due,current.grace_days,total,0,'draft',1,timestamp,timestamp);this.audit(fresh,id,invoiceId,'invoice.created',why,{totalCents:total,contractVersion:current.version});return this.invoiceDTO(fresh,this.invoice(fresh,invoiceId).row,current);},fresh=>this.contract(fresh,id,{write:true}));
  }
  changeInvoice(input,id,body) {
    fields(body,['requestId','version','action','amountCents','reference','settledAt','settlementId','usageReviewed','reason']);const actor=this.actor(input);this.invoice(actor,id,{write:true});const revision=version(body.version),why=reason(body.reason);if(!['issue','settle','cancel','reverse'].includes(body.action))fail(400,'Ação de fatura inválida.');
    if(body.action==='settle'){if(!Number.isSafeInteger(body.amountCents)||body.amountCents<1)fail(400,'Informe o valor recebido em centavos.');label(body.reference,'Referência da baixa',120);date(body.settledAt,'Data da baixa');}
    else if(['amountCents','reference','settledAt'].some(field=>body[field]!==undefined))fail(400,'Valor e referência pertencem somente à baixa manual.');
    if(body.action==='reverse'&&!identity(body.settlementId))fail(400,'Escolha a baixa que será corrigida.');if(body.action!=='reverse'&&body.settlementId!==undefined||body.action!=='issue'&&body.usageReviewed!==undefined||body.usageReviewed!==undefined&&typeof body.usageReviewed!=='boolean')fail(400,'Informe apenas os campos da ação financeira escolhida.');
    return this.write(actor,body.requestId,{op:'changeInvoice',id,...body},fresh=>{const {row,contract}=this.invoice(fresh,id,{write:true});if(row.version!==revision)fail(409,'A fatura mudou. Atualize antes de continuar.');let next=row.state,paid=row.paid_cents;
      if(body.action==='issue'){if(row.state!=='draft')fail(409,'Somente um rascunho pode ser emitido.');const snapshot=JSON.parse(row.snapshot);cycle(snapshot.contract,row.period_start,row.period_end);if(snapshot.items.some(item=>item.metered)&&body.usageReviewed!==true)fail(409,'Revise e confirme o uso manual desta competência, incluindo quantidades zero, antes de emitir.');next=row.total_cents===0?'settled':'issued';}
      if(body.action==='cancel'){if(!['draft','issued'].includes(row.state)||paid!==0)fail(409,'Uma fatura com baixa ou encerrada não pode ser cancelada.');next='cancelled';}
      if(body.action==='settle'){if(row.state!=='issued')fail(409,'Emita a fatura antes de registrar a baixa.');paid=add(paid,body.amountCents);if(paid>row.total_cents)fail(400,'A baixa excede o saldo da fatura.');if(this.db.prepare('SELECT 1 FROM billing_settlements WHERE invoice_id=? AND reference=?').get(id,body.reference.trim()))fail(409,'Esta referência de baixa já foi registrada.');this.db.prepare('INSERT INTO billing_settlements VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,body.amountCents,body.reference.trim(),body.settledAt,this.timestamp(),fresh.userId,why);next=paid===row.total_cents?'settled':'issued';}
      if(body.action==='reverse'){
        if(!['issued','settled'].includes(row.state))fail(409,'Somente uma fatura com baixa registrada pode ser corrigida.');
        const settlement=this.db.prepare('SELECT * FROM billing_settlements WHERE id=? AND invoice_id=?').get(body.settlementId,id);if(!settlement)fail(404,'Baixa não encontrada nesta fatura.');if(this.db.prepare('SELECT 1 FROM billing_settlement_reversals WHERE settlement_id=?').get(settlement.id))fail(409,'Esta baixa já foi corrigida.');
        if(settlement.amount_cents>paid)fail(409,'O saldo registrado não permite corrigir esta baixa. Reconcilie os registros.');paid-=settlement.amount_cents;next='issued';
        this.db.prepare('INSERT INTO billing_settlement_reversals VALUES (?,?,?,?,?,?,?)').run(randomUUID(),settlement.id,id,settlement.amount_cents,fresh.userId,why,this.timestamp());
      }
      this.db.prepare('UPDATE billing_invoices SET state=?,paid_cents=?,version=version+1,updated_at=? WHERE id=?').run(next,paid,this.timestamp(),id);this.audit(fresh,contract.id,id,`invoice.${body.action}`,why,{version:revision+1,origin:'manual',...(body.action==='settle'?{amountCents:body.amountCents,reference:body.reference.trim()}:body.action==='reverse'?{settlementId:body.settlementId,accountingOnly:true}:body.action==='issue'?{usageReviewed:body.usageReviewed===true}:{})});return this.invoiceDTO(fresh,this.invoice(fresh,id).row,contract);},fresh=>this.invoice(fresh,id,{write:true}));
  }
  detail(input,id) {
    const actor=this.actor(input),contract=this.contract(actor,id),invoices=this.db.prepare('SELECT * FROM billing_invoices WHERE contract_id=? ORDER BY period_start DESC,id LIMIT 200').all(id);
    const dto=this.contractDTO(actor,contract),usage=this.db.prepare('SELECT metric,quantity,period_start AS periodStart,period_end AS periodEnd,created_at AS createdAt FROM billing_usage WHERE contract_id=? ORDER BY created_at DESC,id LIMIT 200').all(id),versions=dto.canManage?this.db.prepare('SELECT version,snapshot,actor_id AS actorId,reason,created_at AS createdAt FROM billing_contract_versions WHERE contract_id=? ORDER BY version DESC LIMIT 100').all(id).map(row=>({...row,snapshot:JSON.parse(row.snapshot)})):[],audit=dto.canManage?this.db.prepare('SELECT actor_id AS actorId,action,reason,metadata,created_at AS createdAt FROM billing_audit WHERE contract_id=? ORDER BY created_at DESC,id LIMIT 100').all(id).map(row=>({...row,metadata:JSON.parse(row.metadata)})):[],count=table=>this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE contract_id=?`).get(id).n;
    return {contract:dto,invoices:invoices.map(row=>this.invoiceDTO(actor,row,contract)),usage,versions,audit,historyLimits:{invoices:{shown:invoices.length,total:count('billing_invoices'),limit:200},usage:{shown:usage.length,total:count('billing_usage'),limit:200},versions:{shown:versions.length,total:dto.canManage?count('billing_contract_versions'):0,limit:100},audit:{shown:audit.length,total:dto.canManage?count('billing_audit'):0,limit:100}}};
  }
  invoiceDetail(input,id,options={}) {
    fields(options,['settlementsOffset','settlementsLimit','settlementId']);
    const selected=options.settlementId!==undefined;
    if(selected&&(!identity(options.settlementId)||options.settlementsOffset!==undefined||options.settlementsLimit!==undefined))fail(400,'Escolha uma baixa individual ou a página de baixas.');
    const offset=pageNumber(options.settlementsOffset,0,'Página de baixas',1000000),limit=pageNumber(options.settlementsLimit,200,'Limite de baixas',200);
    if(!limit)fail(400,'Use ao menos uma baixa por página.');
    const actor=this.actor(input),{row,contract}=this.invoice(actor,id),dto=this.invoiceDTO(actor,row,contract);
    if(selected&&!dto.canManage)fail(403,'As baixas privadas pertencem ao responsável financeiro da fatura.');
    const total=dto.canManage?this.db.prepare('SELECT count(*) AS n FROM billing_settlements WHERE invoice_id=?').get(id).n:0;
    const settlements=dto.canManage?this.db.prepare(`SELECT s.id,s.amount_cents AS amountCents,s.reference,s.settled_at AS settledAt,s.actor_id AS actorId,s.reason,r.id AS reversalId,r.created_at AS reversedAt,r.reason AS reversalReason FROM billing_settlements s LEFT JOIN billing_settlement_reversals r ON r.settlement_id=s.id WHERE s.invoice_id=?${selected?' AND s.id=?':''} ORDER BY s.created_at,s.id LIMIT ? OFFSET ?`).all(id,...(selected?[options.settlementId]:[]),selected?1:limit,selected?0:offset).map(item=>({...item,canReverse:item.reversalId===null&&['issued','settled'].includes(row.state)})):[];
    if(selected&&!settlements.length)fail(404,'Baixa não encontrada nesta fatura.');
    return {invoice:dto,settlements,settlementsLimit:{shown:settlements.length,total,limit:selected?1:limit},
      settlementPage:selected?null:pageInfo(offset,limit,total),reconciliation:this.reconcile(actor,id)};
  }
  reconcile(input,id){const actor=this.actor(input),{row}=this.invoice(actor,id),gross=this.db.prepare('SELECT amount_cents FROM billing_settlements WHERE invoice_id=?').all(id).reduce((sum,event)=>add(sum,event.amount_cents),0),reversed=this.db.prepare('SELECT amount_cents FROM billing_settlement_reversals WHERE invoice_id=?').all(id).reduce((sum,event)=>add(sum,event.amount_cents),0);if(reversed>gross)fail(409,'As correções excedem as baixas. Revise o ledger.');const ledger=gross-reversed;return {balanced:ledger===row.paid_cents,totalCents:row.total_cents,recordedPaidCents:row.paid_cents,ledgerPaidCents:ledger,grossLedgerCents:gross,reversedCents:reversed,outstandingCents:row.total_cents-ledger,origin:'manual',providerConfirmed:false};}
}
