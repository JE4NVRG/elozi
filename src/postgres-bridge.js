import { Pool } from 'pg';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadLocalKey } from './wa-auth.js';
import { SshPostgresTransport } from './ssh-postgres.js';
import { effectiveTenantRows } from './conversation-journal.js';

export async function localDatabaseConfig() {
  const key=await loadLocalKey(), blob=await readFile(join(process.env.LOCALAPPDATA||join(homedir(),'.local','share'),'MEPChat','database-vps.enc'));
  const decipher=createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));decipher.setAAD(Buffer.from('mepchat:database-vps'));decipher.setAuthTag(blob.subarray(12,28));
  const c=JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]).toString());
  if(c.database!=='mepchat'||c.user!=='mepchat_app'||c.host!=='supabase-db')throw Error('Invalid database scope');
  return {database:c.database,user:c.user,password:c.password};
}

/** Publish only knowledge metadata to the projection; private text stays in SQLite. */
export function knowledgeMetadataSnapshot(snapshot){
  // Curated memory belongs to a private SQLite table, never a tenant payload.
  delete snapshot.agentMemories;
  delete snapshot.supportAssistantJobs;
  // Autopilot receipts (ids, hashes and states) stay in SQLite like the support jobs.
  delete snapshot.agentAutopilotJobs;
  delete snapshot.agentAdminProposals;
  // Channel validation receipts, like support jobs, stay in authoritative SQLite and its encrypted backups.
  if(Array.isArray(snapshot.channels))snapshot.channels=snapshot.channels.map(({supportAssistant,centralSupportScope,onboarding,...channel})=>channel);
  // Quick reply bodies stay in the authoritative SQLite database and its
  // encrypted backups until a dedicated PostgreSQL catalog is implemented.
  delete snapshot.quickReplies;
  // Collaboration rosters remain in authoritative SQLite and encrypted backups.
  // Project only the existing attendance metadata, never a transient access DTO.
  if(Array.isArray(snapshot.conversations))snapshot.conversations=snapshot.conversations.map(({participants,attendanceAccess,supportAssistantHandoff,...conversation})=>({...conversation,...(Array.isArray(conversation.messages)?{messages:conversation.messages.map(({supportAssistantJobId,autopilotJobId,...message})=>message)}:{})}));
  if(Array.isArray(snapshot.knowledgeSources))snapshot.knowledgeSources=snapshot.knowledgeSources.map(({id,title,category,version,archived,createdAt,updatedAt,publicationCounter,published})=>({id,title,category,version,archived,createdAt,updatedAt,publicationCounter,...(published?{published:{version:published.version,title:published.title,hash:published.hash,publishedAt:published.publishedAt}}:{})}));
  if(Array.isArray(snapshot.runs))snapshot.runs=snapshot.runs.map(({memorySnapshot,memoryReferences,supportMemorySnapshot,supportVisitorHash,...run})=>{
    // A generated draft or tool proposal can repeat a private fact. Preserve the
    // execution receipt in SQLite, project only metadata for memory-backed runs.
    if(memorySnapshot?.pins?.length || supportMemorySnapshot?.pins?.length){delete run.draft;delete run.toolProposal;delete run.toolReceipt;}
    return {...run,...(Array.isArray(run.knowledgeReferences)?{knowledgeReferences:run.knowledgeReferences.map(({sourceId,title,publicationVersion,publicationHash,chunkId})=>({sourceId,title,publicationVersion,publicationHash,chunkId}))}:{})};
  });
  return snapshot;
}

/** Commercial relationships describe accounts; they never become access grants. */
export function commercialMetadataSnapshot(snapshot) {
  const reseller=snapshot.reseller||{},field=(object,name,fallback)=>Object.hasOwn(object,name)?object[name]:fallback;
  snapshot.commercialAccount={id:snapshot.resellerId,name:reseller.name,
    accountKind:field(reseller,'accountKind',snapshot.resellerId==='mep-demo'?'platform':'reseller'),
    parentWorkspaceId:field(reseller,'parentWorkspaceId',null),version:field(reseller,'version',1),createdAt:field(reseller,'createdAt',null)};
  snapshot.unit={parentTenantId:field(snapshot,'parentTenantId',null),identityVersion:field(snapshot,'identityVersion',1)};
  // Only public branding is projected. Unknown account fields and private tables
  // (requests, billing, invitations, sessions and audit actors) stay in SQLite.
  const branding=reseller.brand&&typeof reseller.brand==='object'&&!Array.isArray(reseller.brand)?Object.fromEntries(
    ['name','initials','accent','domain','logo'].filter(name=>typeof reseller.brand[name]==='string'||reseller.brand[name]===null).map(name=>[name,reseller.brand[name]])):{};
  snapshot.reseller={name:reseller.name,brand:branding};
  delete snapshot.parentTenantId;delete snapshot.identityVersion;
  return snapshot;
}

/** Direct pool bounds: a stuck connection or projection fails (state offline, queue preserved) instead of holding sends
 * forever. sync_workspace carries a whole company document and the spool drains in order, so the statement bound is
 * generous (120 s): it releases a statement stuck on locks or a dead backend without failing a large company on every
 * flush. The client gives up shortly after the server, a session left idle inside a transaction is closed so its locks
 * are released, and a failed client is discarded, not reused. */
export function directPoolConfig(credentials) {
  return {...credentials,host:'supabase-db',port:5432,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:15000,
    statement_timeout:120000,query_timeout:125000,idle_in_transaction_session_timeout:60000};
}

const DELETION_TENANT_ID=/^tenant_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DELETION_RESELLER_ID=/^reseller_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DELETION_MAX_ATTEMPTS=12;
/** 30 s, 60 s, 120 s ... capped at 30 min (12 attempts span about 3.5 hours). */
export const deletionBackoffMs=attempts=>Math.min(30000*2**Math.max(0,attempts-1),30*60*1000);

export class PostgresBridge {
  constructor(store,{pool,transport,enabled=true}={}) {
    this.store=store;this.pool=pool;this.transport=transport;this.enabled=enabled;this.running=null;this.state=enabled?'starting':'disabled';this.syncedAt=null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS postgres_spool (revision INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    store.db.prepare('INSERT OR IGNORE INTO local_meta VALUES (?,?)').run('postgres_source_id',randomUUID());
    this.sourceId=store.db.prepare('SELECT value FROM local_meta WHERE key=?').get('postgres_source_id').value;
    store.queuePostgres=id=>this.queue(id);
    // Account deletion tombstones: one per removed company, drained after the snapshot spool. A tombstone that the
    // database refuses (for example before db/010 is applied) stays queued without blocking the snapshot spool.
    store.db.exec('CREATE TABLE IF NOT EXISTS postgres_deletion_spool (revision INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL UNIQUE,reseller_id TEXT NOT NULL,created_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');
    // Retry state: exponential backoff (30 s .. 30 min), then 'failed' after DELETION_MAX_ATTEMPTS; 'manual' for ids the
    // PostgreSQL function can never accept (legacy, non-UUID). Both stay visible in status() and /api/health storage.
    const spoolColumns=new Set(store.db.prepare('PRAGMA table_info(postgres_deletion_spool)').all().map(column=>column.name));
    if(!spoolColumns.has('state'))store.db.exec("ALTER TABLE postgres_deletion_spool ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','failed','manual'))");
    if(!spoolColumns.has('next_attempt_at'))store.db.exec('ALTER TABLE postgres_deletion_spool ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
    if(!spoolColumns.has('last_error'))store.db.exec('ALTER TABLE postgres_deletion_spool ADD COLUMN last_error TEXT');
    this.now=Date.now;
    store.queuePostgresDeletion=(tenantId,resellerId)=>this.queueDeletion(tenantId,resellerId);
  }
  /** Called inside the deleting SQLite transaction: drops any pending snapshot so the company cannot be resurrected.
   * Always queued, also while the bridge is disabled: a database mirrored earlier must still be erased once the bridge
   * is enabled again. Only drain() sends; status() (and /api/health storage) shows the pending count meanwhile. */
  queueDeletion(tenantId,resellerId) {
    this.store.db.prepare('DELETE FROM postgres_spool WHERE tenant_id=?').run(tenantId);
    const valid=DELETION_TENANT_ID.test(tenantId)&&DELETION_RESELLER_ID.test(resellerId);
    this.store.db.prepare('INSERT INTO postgres_deletion_spool(tenant_id,reseller_id,created_at,state,last_error) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id) DO NOTHING')
      .run(tenantId,resellerId,new Date(this.now()).toISOString(),valid?'pending':'manual',valid?null:'legacy_id_requires_manual_erasure');
  }
  async drainDeletions() {
    let failed=false;
    for(const job of this.store.db.prepare("SELECT * FROM postgres_deletion_spool WHERE state='pending' AND next_attempt_at<=? ORDER BY revision LIMIT 50").all(this.now())){
      try{
        if(this.transport){
          if(typeof this.transport.deleteWorkspaceTenant!=='function')throw Error('Transport without deletion');
          await this.transport.deleteWorkspaceTenant({tenantId:job.tenant_id,resellerId:job.reseller_id,sourceId:this.sourceId});
        }else{const client=await this.pool.connect();let failure;try{
          await client.query('BEGIN');
          await client.query("SELECT set_config('mepchat.user_id','mepchat-local-bridge',true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$1,true)",[job.tenant_id,job.reseller_id]);
          await client.query('SELECT mepchat_private.delete_workspace_tenant($1,$2,$3)',[job.reseller_id,job.tenant_id,this.sourceId]);
          await client.query('COMMIT');
        }catch(error){failure=error;await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release(failure);}}
        this.store.db.prepare('DELETE FROM postgres_deletion_spool WHERE revision=?').run(job.revision);
      }catch{
        failed=true;const attempts=job.attempts+1;
        this.store.db.prepare('UPDATE postgres_deletion_spool SET attempts=?,state=?,next_attempt_at=?,last_error=? WHERE revision=?')
          .run(attempts,attempts>=DELETION_MAX_ATTEMPTS?'failed':'pending',this.now()+deletionBackoffMs(attempts),'postgres_refused',job.revision);
      }
    }
    return !failed&&!this.store.db.prepare("SELECT 1 FROM postgres_deletion_spool WHERE state<>'pending' LIMIT 1").get();
  }
  queue(id) {
    if(!this.enabled)return;
    const row=effectiveTenantRows(this.store.db,{tenantId:id})[0];if(!row)return;
    const data=JSON.parse(row.data);if(data.demo)return; // Fictitious demo companies never reach the mirror.
    const snapshot={id:row.id,resellerId:row.reseller_id,...data,reseller:JSON.parse(this.store.db.prepare('SELECT data FROM resellers WHERE id=?').get(row.reseller_id).data),audit:this.store.db.prepare('SELECT * FROM audit WHERE tenant_id=? ORDER BY created_at DESC LIMIT 250').all(id)};
    knowledgeMetadataSnapshot(snapshot);commercialMetadataSnapshot(snapshot);
    snapshot.outbox=this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='outbound_commands'").get()?this.store.db.prepare('SELECT * FROM outbound_commands WHERE tenant_id=?').all(id):[];
    this.store.db.prepare('INSERT INTO postgres_spool(tenant_id,payload) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(id,JSON.stringify(snapshot));
  }
  status(){
    const deletions=this.store.db.prepare("SELECT sum(state='pending') AS pending,sum(state='failed') AS failed,sum(state='manual') AS manual,min(created_at) AS oldest FROM postgres_deletion_spool").get();
    return {mode:this.enabled?'postgres-backed-local':'local',state:this.state,pending:this.store.db.prepare('SELECT count(*) AS n FROM postgres_spool').get().n,
      pendingDeletions:deletions.pending||0,failedDeletions:deletions.failed||0,manualDeletions:deletions.manual||0,
      oldestDeletionAgeMs:deletions.oldest?Math.max(0,this.now()-Date.parse(deletions.oldest)):null,syncedAt:this.syncedAt};
  }
  async start() {
    if(!this.enabled)return;
    if(!this.pool&&!this.transport){
      const c=await localDatabaseConfig();
      if(process.env.MEPCHAT_DATABASE_TRANSPORT==='direct')this.pool=new Pool(directPoolConfig(c));
      else this.transport=new SshPostgresTransport({password:c.password});
    }
    this.pool?.on?.('error',()=>{this.state='offline';});
    for(const {id}of this.store.db.prepare('SELECT id FROM tenants').all())this.queue(id);
    this.timer=setInterval(()=>this.flush().catch(()=>{}),5000);this.timer.unref();
    await this.flush();
  }
  async flush() {
    if(!this.enabled)return;
    if(this.running)return this.running;
    this.running=this.drain().finally(()=>{this.running=null;});return this.running;
  }
  async drain() {
    if(!this.pool&&!this.transport)throw Error('Database not initialized');
    // Tombstones drain independently: a snapshot failure (or backlog) never blocks erasure.
    let snapshotsFailed=false,deletions=false;
    try {
      while(true){const job=this.store.db.prepare('SELECT * FROM postgres_spool ORDER BY revision LIMIT 1').get();if(!job)break;
        if(this.transport)await this.transport.sync({tenantId:job.tenant_id,payload:job.payload,sourceId:this.sourceId,revision:job.revision});
        else {const client=await this.pool.connect();let failure;try{
          await client.query('BEGIN');
          const rid=JSON.parse(job.payload).resellerId;
          await client.query("SELECT set_config('mepchat.user_id','mepchat-local-bridge',true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$1,true)",[job.tenant_id,rid]);
          if(/^reseller_[0-9a-f-]{36}$/.test(rid)&&/^tenant_[0-9a-f-]{36}$/.test(job.tenant_id))await client.query('SELECT mepchat_private.provision_reseller($1,$2,$3)',[rid,job.tenant_id,this.sourceId]);
          await client.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,$3::bigint)',[job.payload,this.sourceId,job.revision]);
          await client.query('COMMIT');
        }catch(error){failure=error;await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release(failure);}}
        this.store.db.prepare('DELETE FROM postgres_spool WHERE revision=?').run(job.revision);
      }
    }catch{snapshotsFailed=true;}
    finally{try{deletions=await this.drainDeletions();}catch{deletions=false;}}
    if(snapshotsFailed){this.state='offline';throw Error('PostgreSQL synchronization unavailable; local queue preserved');}
    this.state=deletions?'synced':this.store.db.prepare("SELECT 1 FROM postgres_deletion_spool WHERE state IN ('failed','manual') LIMIT 1").get()?'deletions_failed':'deletions_pending';
    this.syncedAt=new Date().toISOString();
  }
  async close(){this.state='closed';clearInterval(this.timer);await this.running?.catch(()=>{});await this.pool?.end();await this.transport?.close();delete this.store.queuePostgres;delete this.store.queuePostgresDeletion;}
}
