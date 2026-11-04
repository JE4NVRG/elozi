import {fail} from './store.js';
import {BILLING_KINDS} from './billing.js';

export const COMMERCIAL_USAGE_TRANSPORTS = ['baileys','telegram-bot','telegram-user','webchat','email','instagram','messenger','other'];
const DISCONNECTED_STATES = ['disconnected','offline','planned','sandbox','starting','connecting','qr','waiting','failed','error','reconnecting','pending'];
const quantityBasis = {connections:'registered-whatsapp-qr-telegram',users:'active-users-own-workspace',agent_service:'active-unexpired-service-identities',subscription:'unavailable',email:'unavailable'};
const count = value => { if (!Number.isSafeInteger(value) || value < 0) fail(500,'Inventário comercial inválido.'); return value; };
const sync = (fn,...args) => { const result=fn(...args); if(result&&typeof result.then==='function'){result.catch?.(()=>{});fail(500,'O inventário comercial exige autorização síncrona.');}return result; };
const emptyChannels = () => ({registered:0,connected:0,disconnected:0,disabled:0,unknown:0});
/** The on-demand demo company (tenant.demo) never enters commercial inventory or quotas. */
const REAL = "json_extract(t.data,'$.demo') IS NULL";

/** Read-only inventory and contract previews. No operational access or billing effects. */
export class CommercialUsage {
  constructor(accounts,billing,{now=Date.now}={}) {
    if(!accounts?.db||accounts.db!==billing?.db||typeof now!=='function'||['actor','visible','platform','permitted','accountRow'].some(name=>typeof accounts[name]!=='function')||['actor','contract','contractDTO'].some(name=>typeof billing[name]!=='function'))throw Error('Uso comercial exige contas, cobrança e relógio síncronos.');
    Object.assign(this,{accounts,billing,db:accounts.db,now});
  }
  table(name){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));}
  columns(name){return new Set(this.db.prepare(`PRAGMA table_info(${name})`).all().map(row=>row.name));}
  directory(){
    return this.db.prepare("SELECT id,json_extract(data,'$.name') AS name,json_extract(data,'$.accountKind') AS kind,json_extract(data,'$.parentWorkspaceId') AS parent,json_extract(data,'$.version') AS version FROM resellers").all().map(row=>({
      id:row.id,data:{name:typeof row.name==='string'?row.name:''},accountKind:['platform','reseller','business'].includes(row.kind)?row.kind:row.id===this.accounts.platformWorkspaceId?'platform':'reseller',
      parentWorkspaceId:typeof row.parent==='string'?row.parent:null,version:Number.isSafeInteger(row.version)&&row.version>0?row.version:1
    }));
  }
  included(actor,account,scope){
    if(scope==='own')return [account];
    const platform=this.accounts.platform(actor),own=this.accounts.accountRow(actor.resellerId);
    if(account.accountKind==='business'||account.accountKind==='platform'&&!platform)fail(403,'A carteira pertence à revenda ou ao administrador principal.');
    const rows=this.directory().filter(row=>this.accounts.permitted(actor,row,{platform,own})&&(account.accountKind==='platform'||row.id===account.id||row.accountKind==='business'&&row.parentWorkspaceId===account.id));
    return [...new Map([account,...rows].map(row=>[row.id,row])).values()].sort((a,b)=>a.id.localeCompare(b.id));
  }
  channelCounts(ids){
    // Concrete provider transports win; kind classifies only non-concrete registrations.
    // Billing's raw-transport quantity basis remains independent below.
    const groups=this.db.prepare(`WITH channels AS (
      SELECT CASE json_extract(c.value,'$.transport')
          WHEN 'baileys' THEN 'baileys' WHEN 'telegram-bot' THEN 'telegram-bot' WHEN 'telegram-user' THEN 'telegram-user'
          WHEN 'elozi-webchat' THEN 'webchat' WHEN 'webchat' THEN 'webchat'
          WHEN 'mepmail-channel' THEN 'email' WHEN 'email' THEN 'email'
          WHEN 'meta-instagram' THEN 'instagram' WHEN 'instagram' THEN 'instagram'
          WHEN 'meta-messenger' THEN 'messenger' WHEN 'messenger' THEN 'messenger'
          ELSE CASE WHEN json_type(c.value,'$.transport') IS NULL OR json_type(c.value,'$.transport')='null'
              OR json_extract(c.value,'$.transport') IN ('none','sandbox')
            THEN CASE json_extract(c.value,'$.kind')
              WHEN 'whatsapp_qr' THEN 'baileys' WHEN 'telegram' THEN 'telegram-bot' WHEN 'telegram_user' THEN 'telegram-user'
              WHEN 'webchat' THEN 'webchat' WHEN 'email' THEN 'email'
              WHEN 'instagram' THEN 'instagram' WHEN 'messenger' THEN 'messenger'
              ELSE 'other' END
            ELSE 'other' END END AS transport,
        CASE WHEN json_type(c.value,'$.enabled')='false' OR json_extract(c.value,'$.state')='disabled' THEN 'disabled'
          WHEN json_extract(c.value,'$.state')='connected' THEN 'connected'
          WHEN json_extract(c.value,'$.state') IN (${DISCONNECTED_STATES.map(state=>"'"+state+"'").join(',')}) THEN 'disconnected' ELSE 'unknown' END AS state
      FROM tenants t,json_each(CASE WHEN json_type(t.data,'$.channels')='array' THEN json_extract(t.data,'$.channels') ELSE '[]' END) c
      WHERE t.reseller_id IN (SELECT value FROM json_each(?)) AND ${REAL} AND c.type='object')
      SELECT transport,count(*) AS registered,
        sum(state='connected') AS connected,sum(state='disconnected') AS disconnected,sum(state='disabled') AS disabled,sum(state='unknown') AS unknown
      FROM channels GROUP BY transport`).all(ids);
    const byTransport=COMMERCIAL_USAGE_TRANSPORTS.map(transport=>{const row=groups.find(item=>item.transport===transport);return {transport,...emptyChannels(),...(row?Object.fromEntries(Object.keys(emptyChannels()).map(name=>[name,count(row[name])])):{})};});
    return {...Object.fromEntries(Object.keys(emptyChannels()).map(name=>[name,count(byTransport.reduce((n,row)=>n+row[name],0))])),byTransport};
  }
  userCounts(ids){
    if(!this.table('auth_users'))return {active:0,memberships:0};
    const extra=this.columns('auth_users').has('platform_admin')&&this.table('auth_workspace_access')
      ? "UNION SELECT u.id AS user_id,a.reseller_id AS workspace_id FROM auth_users u JOIN auth_workspace_access a ON a.user_id=u.id WHERE u.disabled_at IS NULL AND u.platform_admin=1 AND a.reseller_id IN (SELECT value FROM json_each(?))" : '';
    const sql=`WITH memberships AS (SELECT id AS user_id,reseller_id AS workspace_id FROM auth_users WHERE disabled_at IS NULL AND reseller_id IN (SELECT value FROM json_each(?)) ${extra}) SELECT count(DISTINCT user_id) AS active,count(*) AS memberships FROM memberships`;
    const result=this.db.prepare(sql).get(...(extra?[ids,ids]:[ids]));return {active:count(result.active),memberships:count(result.memberships)};
  }
  inventory(ids,tick){
    const tenants=count(this.db.prepare(`SELECT count(*) AS n FROM tenants t WHERE t.reseller_id IN (SELECT value FROM json_each(?)) AND ${REAL}`).get(ids).n);
    const agents=this.db.prepare(`SELECT count(*) AS registered,coalesce(sum(json_type(a.value,'$.configured')='true'),0) AS configured
      FROM tenants t,json_each(CASE WHEN json_type(t.data,'$.agents')='array' THEN json_extract(t.data,'$.agents') ELSE '[]' END) a
      WHERE t.reseller_id IN (SELECT value FROM json_each(?)) AND ${REAL} AND a.type='object'`).get(ids);
    const services=this.table('service_principals')?this.db.prepare('SELECT count(*) AS n FROM service_principals WHERE reseller_id IN (SELECT value FROM json_each(?)) AND active=1 AND expires_at>?').get(ids,tick).n:0;
    return {tenants,channels:this.channelCounts(ids),users:this.userCounts(ids),agents:{registered:count(agents.registered),configured:count(agents.configured)},servicePrincipals:{active:count(services)}};
  }
  financialUsage({workspaceId,tenantId},tick){
    const connections=this.db.prepare(`SELECT count(*) AS n FROM tenants t,json_each(CASE WHEN json_type(t.data,'$.channels')='array' THEN json_extract(t.data,'$.channels') ELSE '[]' END) c
      WHERE t.reseller_id=? AND (? IS NULL OR t.id=?) AND ${REAL} AND c.type='object' AND json_extract(c.value,'$.transport') IN ('baileys','telegram-bot','telegram-user')`).get(workspaceId,tenantId??null,tenantId??null).n;
    const users=this.table('auth_users')?this.db.prepare(`SELECT count(*) AS n FROM auth_users u WHERE reseller_id=? AND disabled_at IS NULL
      AND (? IS NULL OR role='reseller' OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(u.tenant_ids) AND json_type(u.tenant_ids)='array' THEN u.tenant_ids ELSE '[]' END) WHERE value=?))`).get(workspaceId,tenantId??null,tenantId??null).n:0;
    const services=this.table('service_principals')?this.db.prepare('SELECT count(*) AS n FROM service_principals WHERE reseller_id=? AND active=1 AND expires_at>? AND (? IS NULL OR tenant_id=?)').get(workspaceId,tick,tenantId??null,tenantId??null).n:0;
    return {connections:count(connections),users:count(users),agent_service:count(services)};
  }
  quotas(input,actor,included,tick){
    const financialActor=this.billing.actor(input);
    if(financialActor.userId!==actor.userId||financialActor.resellerId!==actor.resellerId)fail(403,'A prévia exige a mesma identidade comercial e financeira.');
    if(!this.table('billing_contracts'))return [];
    const ids=JSON.stringify(included.map(account=>account.id)),today=new Date(tick).toISOString().slice(0,10);
    const candidates=this.db.prepare("SELECT id FROM billing_contracts WHERE target_workspace_id IN (SELECT value FROM json_each(?)) AND state='active' AND starts_at<=? AND (ends_at IS NULL OR ends_at>=?) ORDER BY id").all(ids,today,today);
    // Reuse Billing's DTO/authorization without its gateway callback loading tenant JSON.
    const projection=Object.create(this.billing);
    projection.now=()=>tick;projection.getUsage=(_actor,context)=>this.financialUsage(context,tick);
    const results=[];
    for(const candidate of candidates){
      let row;try{row=this.billing.contract(financialActor,candidate.id);}catch(error){if(error.status===404)continue;throw error;}
      projection.getTenants=(_actor,workspaceId)=>this.db.prepare("SELECT id,json_extract(data,'$.name') AS name FROM tenants WHERE reseller_id=? AND id=?").all(workspaceId,row.tenant_id);
      const dto=this.billing.contractDTO.call(projection,financialActor,row);if(dto.status!=='active')continue;
      results.push({id:dto.id,name:dto.name,revision:dto.version,status:dto.status,
        target:{kind:dto.targetKind,workspaceId:dto.targetWorkspaceId,tenantId:dto.tenantId??null,name:typeof dto.target?.name==='string'?dto.target.name:'',workspaceName:included.find(account=>account.id===dto.targetWorkspaceId)?.data.name||''},
        lines:BILLING_KINDS.map(metric=>{const usage=dto.liveUsage.find(line=>line.metric===metric),quantity=usage.quantity,limit=usage.limit;return {metric,quantity,limit,excess:quantity===null||limit===null?null:Math.max(0,quantity-limit),remaining:quantity===null||limit===null?null:Math.max(0,limit-quantity),quantityBasis:quantityBasis[metric]};})});
    }
    return results;
  }
  overview(input,accountId=input?.resellerId,options={}){
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(name=>name!=='scope')||!['own','portfolio'].includes(options.scope===undefined?'own':options.scope))fail(400,'Escolha conta própria ou carteira para o inventário.');
    const scope=options.scope===undefined?'own':options.scope,actor=this.accounts.actor(input),account=this.accounts.visible(actor,accountId),included=this.included(actor,account,scope),tick=sync(this.now);
    if(!Number.isFinite(tick)||!Number.isFinite(new Date(tick).getTime()))fail(500,'Relógio comercial inválido.');
    const ids=included.map(row=>row.id),quotas=this.quotas(input,actor,included,tick);
    return {account:{id:account.id,name:typeof account.data.name==='string'?account.data.name:'',kind:account.accountKind,version:account.version},scope,measuredAt:new Date(tick).toISOString(),includedAccounts:{count:ids.length,ids},
      inventory:this.inventory(JSON.stringify(ids),tick),quotas,definitions:{channelState:'stored',memberships:'distinct-user-workspace',quotaPreviewOnly:true}};
  }
}

/** Plan quota enforcement for Stripe-subscribed business workspaces (lane quota-enforcement).
 * Enforced ONLY when subscriptionQuotas(workspaceId) returns a non-null quota object; every workspace
 * without a Stripe subscription (platform, resellers, legacy/manual contracts) is untouched.
 * Only NEW WhatsApp QR numbers and NEW users/invitations are blocked; existing ones keep working. */
export const PLAN_LIMIT_CODE = 'plan_limit';
export const PLAN_LIMIT_WHATSAPP_MESSAGE = 'Limite de números de WhatsApp do plano atingido. Para conectar outro número, o proprietário pode mudar de plano ou adicionar um número extra em Configurações › Financeiro.';
export const PLAN_LIMIT_USERS_MESSAGE = 'Limite de usuários do plano atingido. Para convidar mais pessoas, o proprietário pode mudar de plano em Configurações › Financeiro. Os usuários atuais continuam com acesso.';
const planLimit = (message, resource, limit, usage) => { throw Object.assign(new Error(message), { status: 409, code: PLAN_LIMIT_CODE, resource, limit, usage }); };
const quotaNumber = value => Number.isSafeInteger(value) && value >= 0;

export class PlanQuotaGuard {
  constructor(db, { subscriptionQuotas, now = Date.now } = {}) {
    if (!db?.prepare || typeof subscriptionQuotas !== 'function' || subscriptionQuotas.constructor?.name === 'AsyncFunction' || typeof now !== 'function') throw Error('O limite do plano exige banco e consulta de assinatura síncronos.');
    Object.assign(this, { db, subscriptionQuotas, now });
  }
  table(name) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)); }
  quotas(workspaceId) {
    if (typeof workspaceId !== 'string' || !workspaceId) return null;
    const quotas = sync(this.subscriptionQuotas, workspaceId);
    if (quotas === null || quotas === undefined) return null;
    if (typeof quotas !== 'object' || !quotaNumber(quotas.whatsappNumbers) || !quotaNumber(quotas.users)) fail(500, 'Não foi possível conferir o limite do plano. Tente novamente em instantes.');
    return quotas;
  }
  workspaceOfTenant(tenantId) { return this.db.prepare('SELECT reseller_id AS workspace FROM tenants WHERE id=?').get(tenantId)?.workspace ?? null; }
  /** Every registered WhatsApp QR (transport baileys) channel of the workspace holds a number reservation,
   * whatever its state (connected, pairing, disconnected, disabled). Telegram/webchat/Meta/email never count. */
  whatsappNumbers(workspaceId, { excludeChannelId = null } = {}) {
    return count(this.db.prepare(`SELECT count(*) AS n FROM tenants t,json_each(CASE WHEN json_type(t.data,'$.channels')='array' THEN json_extract(t.data,'$.channels') ELSE '[]' END) c
      WHERE t.reseller_id=? AND ${REAL} AND c.type='object' AND json_extract(c.value,'$.transport')='baileys' AND (? IS NULL OR json_extract(c.value,'$.id')<>?)`).get(workspaceId, excludeChannelId, excludeChannelId).n);
  }
  persistedChannel(channelId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM tenants t,json_each(CASE WHEN json_type(t.data,'$.channels')='array' THEN json_extract(t.data,'$.channels') ELSE '[]' END) c
      WHERE c.type='object' AND json_extract(c.value,'$.id')=? LIMIT 1`).get(channelId));
  }
  /** Users = active (not disabled) users of the workspace + pending (not accepted/revoked/expired) invitations. */
  users(workspaceId, { now = this.now() } = {}) {
    const active = this.table('auth_users') ? this.db.prepare('SELECT count(*) AS n FROM auth_users WHERE reseller_id=? AND disabled_at IS NULL').get(workspaceId).n : 0;
    const pending = this.table('auth_invitations') ? this.db.prepare('SELECT count(*) AS n FROM auth_invitations WHERE reseller_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?').get(workspaceId, now).n : 0;
    return count(active) + count(pending);
  }
  /** Called before reserving a WhatsApp QR number. Re-pairing a channel that is already persisted is never blocked
   * (no double count, downgrade keeps existing numbers). */
  assertWhatsAppNumber({ tenantId, channelId }) {
    if (typeof channelId === 'string' && this.persistedChannel(channelId)) return;
    const workspaceId = this.workspaceOfTenant(tenantId), quotas = this.quotas(workspaceId);
    if (!quotas) return;
    const usage = this.whatsappNumbers(workspaceId, { excludeChannelId: channelId ?? null });
    if (usage >= quotas.whatsappNumbers) planLimit(PLAN_LIMIT_WHATSAPP_MESSAGE, 'whatsapp_numbers', quotas.whatsappNumbers, usage);
  }
  /** Called before creating an invitation, creating a user or reactivating a disabled user. */
  assertUser(workspaceId, { now = this.now() } = {}) {
    const quotas = this.quotas(workspaceId);
    if (!quotas) return;
    const usage = this.users(workspaceId, { now });
    if (usage >= quotas.users) planLimit(PLAN_LIMIT_USERS_MESSAGE, 'users', quotas.users, usage);
  }
}
