import { createHash, randomUUID } from 'node:crypto';
import { allowedFields, BUSINESS_PERMISSIONS, normalizePermissions, normalizeScopeRules, accessOf } from './access.js';

const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const id = value => { if(typeof value!=='string'||!value||value!==value.trim()||value.length>120||/[\x00-\x20\x7f]/.test(value))fail(400,'Identificação inválida.');return value; };
const text = (value,max,required=false) => { if(value===undefined&&!required)return '';if(typeof value!=='string'||value.trim().length>max||required&&!value.trim()||/[\x00-\x1f\x7f]/.test(value))fail(400,'Informe motivo e ticket válidos.');return value.trim(); };
const canonical = value => JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

export class SupportAccess {
  constructor(store,auth,{now=Date.now,onChange=()=>{}}={}) {
    this.store=store;this.db=store.db;this.auth=auth;this.now=now;this.onChange=onChange;
    this.db.exec(`CREATE TABLE IF NOT EXISTS support_grants (
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES resellers(id),granter_id TEXT NOT NULL REFERENCES auth_users(id),
      support_user_id TEXT NOT NULL REFERENCES auth_users(id),authority_stamp TEXT NOT NULL,tenant_ids TEXT NOT NULL,permissions TEXT NOT NULL,scope_rules TEXT NOT NULL,
      reason TEXT NOT NULL,ticket TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      request_id TEXT,request_hash TEXT NOT NULL,revoked_at INTEGER,end_kind TEXT,end_reason TEXT,released_at INTEGER
    ); CREATE UNIQUE INDEX IF NOT EXISTS support_grants_request ON support_grants(workspace_id,granter_id,request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS support_grants_user ON support_grants(support_user_id,expires_at);
      CREATE TABLE IF NOT EXISTS support_audit (id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES support_grants(id),workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES auth_users(id),actor_name TEXT NOT NULL,action TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL,reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS support_audit_grant ON support_audit(grant_id,created_at);`);
    auth.supportAccess=this;
  }
  event(row,actorId,action,reason) {
    const name=this.db.prepare('SELECT name FROM auth_users WHERE id=?').get(actorId)?.name||'';
    this.db.prepare('INSERT INTO support_audit VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.workspace_id,actorId,name,action,row.version,this.now(),reason);
  }
  metadata(row) {
    const workspace=this.db.prepare('SELECT data FROM resellers WHERE id=?').get(row.workspace_id), person=this.db.prepare('SELECT id,name FROM auth_users WHERE id=?').get(row.support_user_id), granter=this.db.prepare('SELECT id,name FROM auth_users WHERE id=?').get(row.granter_id);
    const state=row.revoked_at!==null?row.end_kind==='expired'?'expired':'revoked':row.expires_at<=this.now()?'expired':'active';
    const tenantIds=JSON.parse(row.tenant_ids),scopeRules=JSON.parse(row.scope_rules);
    const tenants=tenantIds.flatMap(tenantId=>{
      const entry=this.db.prepare('SELECT data FROM tenants WHERE id=? AND reseller_id=?').get(tenantId,row.workspace_id);if(!entry)return [];
      const tenant=JSON.parse(entry.data),rule=scopeRules[tenantId]||{};
      return [{id:tenantId,name:tenant.name||tenantId,
        channels:(tenant.channels||[]).filter(channel=>(rule.channelIds||[]).includes(channel.id)).map(channel=>({id:channel.id,name:channel.name||channel.id})),
        departments:(tenant.departments||[]).filter(department=>(rule.departmentIds||[]).includes(department.id)).map(department=>({id:department.id,name:department.name||department.id}))}];
    });
    return {id:row.id,workspaceId:row.workspace_id,workspaceName:workspace?JSON.parse(workspace.data).name:'',supportUser:person||{id:row.support_user_id,name:''},granter:granter||{id:row.granter_id,name:''},tenantIds,tenants,permissions:JSON.parse(row.permissions),scopeRules,reason:row.reason,ticket:row.ticket,
      createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),version:row.version,state,revokedAt:row.revoked_at===null?null:new Date(row.revoked_at).toISOString(),endReason:row.end_reason||''};
  }
  authority(actor) { return this.auth.invitationAuthority(actor).stamp; }
  valid(row) {
    if(!row||row.revoked_at!==null||row.expires_at<=this.now())fail(403,'O acesso de suporte expirou ou foi revogado.');
    const granter={userId:row.granter_id,resellerId:row.workspace_id};
    if(this.authority(granter)!==row.authority_stamp)fail(403,'A autoridade que concedeu o suporte mudou.');
    const person=this.db.prepare('SELECT * FROM auth_users WHERE id=? AND disabled_at IS NULL').get(row.support_user_id);
    if(!person)fail(403,'A pessoa de suporte não está disponível.');
    this.auth.validateAccess(this.auth.resolveActor(granter),JSON.parse(row.tenant_ids),JSON.parse(row.scope_rules));
    return person;
  }
  resolve(actor,base) {
    const grantId=id(actor.supportGrantId), row=this.db.prepare('SELECT * FROM support_grants WHERE id=? AND support_user_id=? AND workspace_id=?').get(grantId,base.id,actor.resellerId);
    this.valid(row);
    return {...base,role:'operator',platform_admin:0,reseller_id:row.workspace_id,tenant_ids:row.tenant_ids,permissions:row.permissions,scope_rules:row.scope_rules,
      supportGrantId:row.id,supportExpiresAt:new Date(row.expires_at).toISOString(),supportReason:row.reason};
  }
  create(actor,input) {
    allowedFields(input,['requestId','supportUserId','tenantIds','permissions','scopeRules','reason','ticket','ttlMinutes']);
    this.auth.admin(actor);
    const supportUserId=id(input.supportUserId), reason=text(input.reason,500,true),ticket=text(input.ticket,120),ttlMinutes=input.ttlMinutes??60;
    if(!Number.isInteger(ttlMinutes)||ttlMinutes<1||ttlMinutes>1440)fail(400,'Escolha validade entre 1 minuto e 24 horas.');
    if(!Array.isArray(input.tenantIds)||!input.tenantIds.length||input.tenantIds.length>50)fail(400,'Escolha as empresas do suporte.');
    const tenantIds=[...new Set(input.tenantIds.map(id))].sort(),permissions=normalizePermissions(input.permissions),scopeRules=normalizeScopeRules(input.scopeRules,tenantIds,'operator');
    if(!Array.isArray(permissions)||!permissions.length||!scopeRules||tenantIds.some(tenantId=>!scopeRules[tenantId]||!Array.isArray(scopeRules[tenantId].channelIds)||!scopeRules[tenantId].channelIds.length||!Array.isArray(scopeRules[tenantId].departmentIds)||!scopeRules[tenantId].departmentIds.length))fail(400,'Escolha ações, canais e departamentos explícitos para cada empresa.');
    const requestId=input.requestId===undefined?null:id(input.requestId),requestHash=createHash('sha256').update(canonical({supportUserId,tenantIds,permissions,scopeRules,reason,ticket,ttlMinutes})).digest('hex');
    return this.auth.transaction(()=>{
      const admin=this.auth.admin(actor),authorityStamp=this.authority(actor), person=this.db.prepare('SELECT id FROM auth_users WHERE id=? AND disabled_at IS NULL').get(supportUserId);
      if(!person)fail(400,'Escolha uma pessoa real e ativa para prestar o suporte.');
      this.auth.validateAccess(this.auth.resolveActor(actor),tenantIds,scopeRules);
      for(const tenantId of tenantIds)this.store.tenant(this.auth.resolveActor(actor),tenantId);
      if(requestId){const previous=this.db.prepare('SELECT * FROM support_grants WHERE workspace_id=? AND granter_id=? AND request_id=?').get(actor.resellerId,admin.id,requestId);if(previous){if(previous.request_hash!==requestHash)fail(409,'A identificação já foi usada com outro escopo.');this.valid(previous);return this.metadata(previous);}}
      const date=this.now(),grantId=randomUUID();
      this.db.prepare('INSERT INTO support_grants (id,workspace_id,granter_id,support_user_id,authority_stamp,tenant_ids,permissions,scope_rules,reason,ticket,created_at,expires_at,request_id,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(grantId,actor.resellerId,admin.id,supportUserId,authorityStamp,JSON.stringify(tenantIds),JSON.stringify(permissions),JSON.stringify(scopeRules),reason,ticket,date,date+ttlMinutes*60000,requestId,requestHash);
      const row=this.db.prepare('SELECT * FROM support_grants WHERE id=?').get(grantId);this.event(row,admin.id,'created',reason);return this.metadata(row);
    });
  }
  list(actor) {this.auth.admin(actor);return {grants:this.db.prepare('SELECT * FROM support_grants WHERE workspace_id=? ORDER BY created_at DESC,id LIMIT 200').all(actor.resellerId).map(row=>this.metadata(row))};}
  available(actor) {
    const user=this.auth.currentActor(actor);
    return this.db.prepare('SELECT * FROM support_grants WHERE support_user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,id').all(user.id,this.now()).flatMap(row=>{try{this.valid(row);return [this.metadata(row)];}catch(error){if(error.status>=400&&error.status<500)return [];throw error;}});
  }
  preview(actor,grantId) {
    const user=this.auth.currentActor(actor),row=this.db.prepare('SELECT * FROM support_grants WHERE id=? AND support_user_id=?').get(id(grantId),user.id);
    this.valid(row);return this.metadata(row);
  }
  directory(actor,{q='',limit=10}={}) {
    this.auth.admin(actor);if(typeof q!=='string'||q.trim().length<3||q.length>64||!Number.isInteger(limit)||limit<1||limit>20)fail(400,'Informe o usuário exato da pessoa de suporte.');
    return {users:this.db.prepare('SELECT id,name,username FROM auth_users WHERE username=? COLLATE NOCASE AND disabled_at IS NULL LIMIT ?').all(q.trim(),limit)};
  }
  revoke(actor,grantId,input) {
    allowedFields(input,['version','reason']);this.auth.admin(actor);if(!Number.isSafeInteger(input.version)||input.version<1)fail(400,'Informe a revisão atual da delegação.');const reason=text(input.reason,500,true);
    const result=this.auth.transaction(()=>{
      this.auth.admin(actor);const row=this.db.prepare('SELECT * FROM support_grants WHERE id=? AND workspace_id=?').get(id(grantId),actor.resellerId);
      if(!row)fail(404,'Delegação não encontrada neste workspace.');if(row.version!==input.version)fail(409,'A delegação mudou. Atualize antes de revogar.');
      if(row.revoked_at===null){this.db.prepare("UPDATE support_grants SET revoked_at=?,end_kind='revoked',end_reason=?,version=version+1 WHERE id=? AND version=?").run(this.now(),reason,row.id,row.version);const updated=this.db.prepare('SELECT * FROM support_grants WHERE id=?').get(row.id);this.event(updated,actor.userId,'revoked',reason);return updated;}return row;
    });
    this.release(result);return this.metadata(this.db.prepare('SELECT * FROM support_grants WHERE id=?').get(result.id));
  }
  audit(actor,grantId) {
    this.auth.admin(actor);const row=this.db.prepare('SELECT id FROM support_grants WHERE id=? AND workspace_id=?').get(id(grantId),actor.resellerId);if(!row)fail(404,'Delegação não encontrada neste workspace.');
    return {events:this.db.prepare('SELECT id,actor_id AS actorId,actor_name AS actorName,action,version,created_at,reason FROM support_audit WHERE grant_id=? AND workspace_id=? ORDER BY created_at,rowid LIMIT 500').all(row.id,actor.resellerId).map(({created_at,...event})=>({...event,createdAt:new Date(created_at).toISOString()}))};
  }
  assignees(workspaceId,tenantId,context) {
    const rows=this.db.prepare('SELECT * FROM support_grants WHERE workspace_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,id').all(workspaceId,this.now()),seen=new Set();
    return rows.flatMap(row=>{try{const person=this.valid(row),actor=this.auth.resolveActor({userId:person.id,resellerId:workspaceId,supportGrantId:row.id});if(seen.has(person.id)||!this.auth.can(actor,'inbox.reply',{...context,tenantId}))return [];seen.add(person.id);return [{id:person.id,name:person.name,role:'operator',avatar:person.avatar??null,presence:accessOf(person).presence,supportGrantId:row.id,supportExpiresAt:actor.supportExpiresAt}];}catch(error){if(error.status>=400&&error.status<500)return [];throw error;}});
  }
  invalidateUser(userId) {
    for(const row of this.db.prepare('SELECT * FROM support_grants WHERE (granter_id=? OR support_user_id=?) AND revoked_at IS NULL').all(userId,userId)){
      this.db.prepare("UPDATE support_grants SET revoked_at=?,end_kind='authority',end_reason='Acesso da pessoa alterado.',version=version+1 WHERE id=?").run(this.now(),row.id);
      const updated=this.db.prepare('SELECT * FROM support_grants WHERE id=?').get(row.id);this.event(updated,userId,'authority-revoked','Acesso da pessoa alterado.');
    }
  }
  release(row) {
    if(row.released_at!==null)return;
    // Lifecycle callback executes outside the Auth transaction; retries retain an unreleased record.
    const result=this.onChange({grantId:row.id,workspaceId:row.workspace_id,tenantIds:JSON.parse(row.tenant_ids),supportUserId:row.support_user_id,reason:row.end_reason||'Acesso temporário de suporte encerrado.'});
    if(result&&typeof result.then==='function')fail(500,'O lifecycle do suporte precisa concluir na mesma operação.');
    this.db.prepare('UPDATE support_grants SET released_at=? WHERE id=? AND released_at IS NULL').run(this.now(),row.id);
  }
  sweep() {
    let released=0;
    for(let row of this.db.prepare('SELECT * FROM support_grants WHERE released_at IS NULL').all()) {
      if(row.revoked_at===null){try{this.valid(row);continue;}catch(error){if(!(error.status>=400&&error.status<500))throw error;const expired=row.expires_at<=this.now();
        this.auth.transaction(()=>{this.db.prepare('UPDATE support_grants SET revoked_at=?,end_kind=?,end_reason=?,version=version+1 WHERE id=? AND revoked_at IS NULL').run(this.now(),expired?'expired':'authority',expired?'Prazo do suporte encerrado.':'Autoridade do suporte indisponível.',row.id);row=this.db.prepare('SELECT * FROM support_grants WHERE id=?').get(row.id);this.event(row,row.granter_id,expired?'expired':'authority-revoked',row.end_reason);});
      }}
      this.release(row);released++;
    }
    return {released};
  }
}
