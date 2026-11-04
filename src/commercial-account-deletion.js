import { randomUUID } from 'node:crypto';
import { materializeTenant, effectiveTenantRows } from './conversation-journal.js';
import { MEDIA_DELETION_SPOOL_SQL } from './media.js';

/**
 * Account (workspace) deletion for LGPD erasure requests.
 *
 * Every table of the SQLite database is classified explicitly (ERASE_PLAN, RETAIN_ARCHIVE, RETAIN_IN_PLACE,
 * GLOBAL_TABLES, CORE_TABLES). A table that is not classified blocks the deletion (account_delete_integrity), so a
 * new table forces a retention decision instead of being silently swept or silently kept.
 *
 * - ERASE_PLAN: rows of this account, deleted in an explicit order (children first).
 * - RETAIN_ARCHIVE: fiscal/financial or audit rows whose foreign keys point at rows that disappear. A pseudonymized
 *   copy (ids, amounts, dates, plan, status, Stripe ids; no names, e-mails, phones, documents, addresses or free text)
 *   goes to account_deletion_retained, then the row is removed. Legal basis: LGPD art. 16 I (fiscal retention).
 * - RETAIN_IN_PLACE: billing contracts/invoices/settlements and Stripe event/audit rows without such foreign keys stay
 *   where they are and are pseudonymized in place.
 *
 * Dry run is read-only: a deferred read transaction with SELECT count(*) over the same plan, no write lock.
 * The real deletion is one BEGIN IMMEDIATE transaction; foreign keys are enforced by SQLite's deferred counter at
 * COMMIT (it only counts violations created by this transaction) and, on failure, PRAGMA foreign_key_check(<table>)
 * runs only on the affected tables to name them. No whole-database scan happens in the happy path.
 * The PostgreSQL mirror receives one tombstone per removed company through the bridge deletion spool.
 * Encrypted attachment files (data/media/<id>.mepmedia) are queued in media_deletion_spool inside the same transaction
 * and unlinked after COMMIT by MediaService (again at startup and periodically if the process stops in between).
 * Existing backups are not rewritten: they keep their copies until backup rotation removes them, and a backup is never
 * restored for a deleted account (operational rule; new backups never copy queued files, see media-backup.js).
 */

export const ACCOUNT_DELETION_CODES = Object.freeze(['account_delete_forbidden', 'account_delete_not_owner', 'account_delete_platform',
  'account_delete_has_children', 'account_delete_subscription_active', 'account_delete_checkout_open', 'account_delete_contract_active',
  'account_delete_shared_user', 'account_delete_name_mismatch', 'account_delete_password_invalid', 'account_delete_password_unavailable',
  'account_delete_integrity', 'account_delete_invalid_id', 'account_delete_reconnect_required']);
const LIVE_SUBSCRIPTION = ['active', 'past_due', 'trialing', 'unpaid', 'incomplete'];
// One-time pinning only (first start of this version): existing, not self-registered product workspaces are pinned
// by id. Afterwards protection is by id; a later rename (in either direction) changes nothing.
const PIN_NAMES = /^(je4ndev|familypoints|fullcommerce360)$/;
const PIN_KEY = 'account_deletion_protected_pinned_v1';
const OWNER_KEY = 'workspace_owners_backfilled_v1';
const MAX_ANCESTORS = 32;
const REDACTED = '[removido]';

const k = kind => `(SELECT id FROM temp.account_deletion_keys WHERE kind='${kind}')`;
const T = k('tenant'), C = k('channel'), U = k('user'), P = k('principal'), W = k('workspace'), S = k('secret');
const CONTRACTS = `(SELECT id FROM billing_contracts WHERE target_workspace_id IN ${W} OR seller_workspace_id IN ${W} OR tenant_id IN ${T})`;
const INVOICES = `(SELECT id FROM billing_invoices WHERE contract_id IN ${CONTRACTS})`;
const GRANTS = `(SELECT id FROM support_grants WHERE workspace_id IN ${W} OR granter_id IN ${U} OR support_user_id IN ${U})`;
const entry = (table, where, requires = []) => Object.freeze({ table, where, requires: Object.freeze(requires) });

/** Rows of the account, deleted in this order. `requires` lists other tables used by the condition. */
export const ERASE_PLAN = Object.freeze([
  entry('auth_session_ids', `token_hash IN (SELECT token_hash FROM auth_sessions WHERE user_id IN ${U})`, ['auth_sessions']),
  entry('auth_sessions', `user_id IN ${U}`),
  entry('auth_email_challenges', `user_id IN ${U}`),
  entry('auth_password_resets', `user_id IN ${U}`),
  entry('auth_google_identities', `user_id IN ${U}`),
  entry('email_outbox', `user_id IN ${U}`),
  entry('auth_workspace_access', `reseller_id IN ${W} OR user_id IN ${U}`),
  entry('auth_invitations', `reseller_id IN ${W} OR creator_id IN ${U}`),
  entry('service_handoff_requests', `tenant_id IN ${T} OR principal_id IN ${P}`),
  entry('service_notification_recipients', `tenant_id IN ${T} OR principal_id IN ${P}`),
  entry('service_notification_policies', `tenant_id IN ${T} OR principal_id IN ${P}`),
  entry('service_webhook_deliveries', `tenant_id IN ${T} OR principal_id IN ${P}`),
  entry('service_webhook_tests', `principal_id IN ${P}`),
  entry('service_webhooks', `tenant_id IN ${T} OR principal_id IN ${P}`),
  entry('service_principal_conversation_policies', `principal_id IN ${P}`),
  entry('service_principal_presence', `principal_id IN ${P}`),
  entry('service_principal_usage', `principal_id IN ${P}`),
  entry('service_principal_receipts', `tenant_id IN ${T} OR principal_id IN ${P}`),
  entry('service_principals', `id IN ${P}`),
  entry('team_chat_audit', `tenant_id IN ${T}`),
  entry('team_chat_messages', `tenant_id IN ${T}`),
  entry('team_chat_members', `tenant_id IN ${T}`),
  entry('team_chat_rooms', `tenant_id IN ${T}`),
  entry('webchat_inbound_receipts', `session_id IN (SELECT id FROM webchat_sessions WHERE tenant_id IN ${T}) OR session_id IN (SELECT session_id FROM webchat_identity_sessions WHERE tenant_id IN ${T})`, ['webchat_sessions', 'webchat_identity_sessions']),
  entry('webchat_visitor_profiles', `tenant_id IN ${T}`),
  entry('webchat_identity_jti', `tenant_id IN ${T}`),
  entry('webchat_identity_sessions', `tenant_id IN ${T}`),
  entry('webchat_sessions', `tenant_id IN ${T}`),
  entry('telegram_bindings', `tenant_id IN ${T} OR channel_id IN ${C}`),
  entry('telegram_offset_activity', `channel_id IN ${C}`),
  entry('telegram_offsets', `channel_id IN ${C}`),
  entry('telegram_seen', `channel_id IN ${C}`),
  entry('wa_number_bindings', `tenant_id IN ${T} OR channel_id IN ${C}`),
  entry('wa_contacts', `channel_id IN ${C}`),
  entry('wa_seen', `channel_id IN ${C}`),
  entry('wa_auth', `channel_id IN ${C}`),
  entry('channel_secrets', `channel_id IN ${S}`),
  entry('meta_inbound_receipts', `tenant_id IN ${T}`),
  entry('meta_channel_bindings', `tenant_id IN ${T}`),
  entry('channel_email_seen', `tenant_id IN ${T}`),
  entry('agent_memories', `tenant_id IN ${T} OR reseller_id IN ${W}`),
  entry('ai_usage', `tenant_id IN ${T}`),
  entry('audit', `tenant_id IN ${T}`),
  entry('contact_merge_journals', `tenant_id IN ${T} OR reseller_id IN ${W}`),
  entry('media_attachments', `tenant_id IN ${T}`),
  entry('outbound_commands', `tenant_id IN ${T}`),
  entry('conversation_journal_write_guard', `tenant_id IN ${T}`),
  entry('conversation_journal', `tenant_id IN ${T}`),
  entry('service_conversation_write_proof', `tenant_id IN ${T}`),
  entry('service_conversation_write_guard', `tenant_id IN ${T}`),
  entry('service_conversation_lookup', `tenant_id IN ${T}`),
  entry('service_conversation_lookup_meta', `tenant_id IN ${T}`),
  entry('service_conversation_private', `tenant_id IN ${T}`),
  entry('service_conversation_read', `tenant_id IN ${T}`),
  entry('service_tenant_private', `tenant_id IN ${T}`),
  entry('service_tenant_read', `tenant_id IN ${T}`),
  entry('commercial_account_requests', `workspace_id IN ${W} OR created_workspace_id IN ${W}`),
  entry('billing_requests', `workspace_id IN ${W}`),
  entry('signup_trial_registrations', `workspace_id IN ${W}`),
  entry('workspace_owners', `workspace_id IN ${W}`)
]);

/** Retained as a pseudonymized copy, then removed (their foreign keys point at rows that disappear). */
export const RETAIN_ARCHIVE = Object.freeze([
  { ...entry('support_audit', `workspace_id IN ${W} OR actor_id IN ${U} OR grant_id IN ${GRANTS}`, ['support_grants']), redact: ['actor_name', 'reason'] },
  { ...entry('support_grants', `workspace_id IN ${W} OR granter_id IN ${U} OR support_user_id IN ${U}`), redact: ['reason', 'ticket', 'end_reason', 'scope_rules'] },
  { ...entry('service_principal_audit', `tenant_id IN ${T} OR principal_id IN ${P} OR actor_user_id IN ${U}`), redact: [] },
  { ...entry('commercial_account_audit', `workspace_id IN ${W}`), redact: [] },
  { ...entry('elozi_stripe_checkouts', `workspace_id IN ${W}`), redact: ['url'] },
  { ...entry('elozi_stripe_customers', `workspace_id IN ${W}`), redact: [] },
  { ...entry('elozi_stripe_subscriptions', `workspace_id IN ${W}`), redact: [] }
].map(Object.freeze));

/** Retained where they are (no foreign key to removed rows); free text and personal fields are pseudonymized. */
export const RETAIN_IN_PLACE = Object.freeze([
  { ...entry('billing_contracts', `id IN ${CONTRACTS}`), text: ['name'], json: [] },
  { ...entry('billing_contract_versions', `contract_id IN ${CONTRACTS}`, ['billing_contracts']), text: ['reason'], json: ['snapshot'] },
  { ...entry('billing_invoices', `contract_id IN ${CONTRACTS}`, ['billing_contracts']), text: [], json: ['snapshot'] },
  { ...entry('billing_settlements', `invoice_id IN ${INVOICES}`, ['billing_contracts', 'billing_invoices']), text: ['reason'], json: [] },
  { ...entry('billing_settlement_reversals', `invoice_id IN ${INVOICES}`, ['billing_contracts', 'billing_invoices']), text: ['reason'], json: [] },
  { ...entry('billing_usage', `contract_id IN ${CONTRACTS}`, ['billing_contracts']), text: ['reason'], json: [] },
  { ...entry('billing_audit', `contract_id IN ${CONTRACTS} OR invoice_id IN ${INVOICES}`, ['billing_contracts', 'billing_invoices']), text: ['reason'], json: ['metadata'] },
  { ...entry('elozi_stripe_audit', `workspace_id IN ${W}`), text: [], json: ['detail'] },
  { ...entry('elozi_stripe_events', `workspace_id IN ${W}`), text: [], json: [] },
  { ...entry('elozi_stripe_ended', `workspace_id IN ${W}`), text: [], json: [] }
].map(Object.freeze));

/** Not workspace data (or deletion bookkeeping): never touched by a workspace deletion. */
export const GLOBAL_TABLES = Object.freeze(['local_meta', 'google_challenges', 'elozi_stripe_settings', 'conversation_journal_meta',
  'service_read_model_meta', 'postgres_spool', 'postgres_deletion_spool', 'account_deletion_audit', 'account_deletion_retained',
  'account_deletion_protected', 'signup_trial_tombstones', 'media_deletion_spool']);
/** Deleted last, explicitly. */
export const CORE_TABLES = Object.freeze(['tenants', 'auth_users', 'resellers']);

const classification = new Map([...ERASE_PLAN.map(item => [item.table, 'erase']), ...RETAIN_ARCHIVE.map(item => [item.table, 'retain']),
  ...RETAIN_IN_PLACE.map(item => [item.table, 'retain']), ...GLOBAL_TABLES.map(name => [name, 'global']), ...CORE_TABLES.map(name => [name, 'core'])]);
export const classifyTable = name => classification.get(name) || null;

const failCode = (status, message, code, detail = {}) => { throw Object.assign(new Error(message), { status, code, ...detail }); };
const normalizedName = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR') : '';
const pinName = value => typeof value === 'string' ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') : '';
const quote = name => `"${String(name).replaceAll('"', '""')}"`;
const PERSONAL_KEY = /(name|email|phone|document|cpf|cnpj|taxid|address|contact|street|city|zip|cep|note|comment|reason|ticket|message|text)/i;
/** Recursive JSON pseudonymization: personal or free-text keys are replaced; ids, amounts, dates, plan and status stay. */
export function pseudonymize(value) {
  if (Array.isArray(value)) return value.map(pseudonymize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, PERSONAL_KEY.test(key) && !/(^|_)id$|Id$/.test(key) ? (item === null ? null : REDACTED) : pseudonymize(item)]));
}
const redactJson = text => { if (typeof text !== 'string') return text; try { return JSON.stringify(pseudonymize(JSON.parse(text))); } catch { return REDACTED; } };

export class AccountDeletion {
  /**
   * @param store Store (db, conversationJournal, queuePostgresDeletion?)
   * @param options.auth Auth (currentActor, verifyPassword)
   * @param options.isPlatformAdmin synchronous actor => boolean
   * @param options.stopChannels async (channels) => ({failures}?), stops live transports
   * @param options.protectedWorkspaceIds extra protected workspace ids (default: MEPCHAT_PROTECTED_WORKSPACE_IDS, comma separated)
   */
  constructor(store, { auth, isPlatformAdmin, platformWorkspaceId = 'mep-demo', stopChannels = async () => {}, now = Date.now,
    protectedWorkspaceIds = String(process.env.MEPCHAT_PROTECTED_WORKSPACE_IDS || '').split(',').map(value => value.trim()).filter(Boolean) } = {}) {
    if (!store?.db || !auth || typeof isPlatformAdmin !== 'function' || typeof stopChannels !== 'function') throw new Error('A exclusão de contas exige Store, Auth e autorização síncrona.');
    Object.assign(this, { store, db: store.db, auth, isPlatformAdmin, platformWorkspaceId, stopChannels, now, lastTiming: null });
    const stamp = new Date(now()).toISOString();
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_deletion_audit (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_workspace_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('self','platform')), counts TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS account_deletion_retained (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_table TEXT NOT NULL, record TEXT NOT NULL, retained_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS account_deletion_retained_workspace ON account_deletion_retained(workspace_id);
    CREATE TABLE IF NOT EXISTS account_deletion_protected (workspace_id TEXT PRIMARY KEY, reason TEXT NOT NULL, pinned_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_owners (workspace_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL, recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signup_trial_tombstones (identity_digest TEXT PRIMARY KEY, document_kind TEXT NOT NULL CHECK(document_kind IN ('cpf','cnpj')), deleted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec(MEDIA_DELETION_SPOOL_SQL);
    const protect = this.db.prepare('INSERT OR IGNORE INTO account_deletion_protected VALUES (?,?,?)');
    protect.run(platformWorkspaceId, 'platform_root', stamp);
    for (const id of protectedWorkspaceIds) if (typeof id === 'string' && id.length <= 120) protect.run(id, 'configured', stamp);
    if (!this.db.prepare('SELECT 1 FROM local_meta WHERE key=?').get(PIN_KEY)) {
      const selfRegistered = this.table('signup_trial_registrations') ? new Set(this.db.prepare('SELECT workspace_id FROM signup_trial_registrations').all().map(row => row.workspace_id)) : new Set();
      for (const row of this.db.prepare('SELECT id,data FROM resellers').all()) {
        let data = {}; try { data = JSON.parse(row.data) || {}; } catch {}
        if (!selfRegistered.has(row.id) && (PIN_NAMES.test(pinName(data.name)) || data.accountKind === 'platform')) protect.run(row.id, 'pinned_by_name_v1', stamp);
      }
      this.db.prepare('INSERT OR IGNORE INTO local_meta VALUES (?,?)').run(PIN_KEY, stamp);
    }
    // Owner backfill, once per database (marker in local_meta, like the pin above): the earliest administrator of each
    // workspace that existed when this version first started (the user who registered it). Workspaces created later have
    // no row and ownerOf applies the same earliest-admin rule. Running once keeps a restored backup byte-identical to its
    // source instead of materializing new owner rows when the restored copy is opened.
    // INSERT OR IGNORE is idempotent, so a stop between the two statements only repeats the same backfill.
    if (this.table('auth_users') && !this.db.prepare('SELECT 1 FROM local_meta WHERE key=?').get(OWNER_KEY)) {
      this.db.prepare(`INSERT OR IGNORE INTO workspace_owners SELECT u.reseller_id,u.id,'backfill_earliest_admin',? FROM auth_users u
        WHERE u.role='reseller' AND NOT EXISTS (SELECT 1 FROM auth_users v WHERE v.reseller_id=u.reseller_id AND v.role='reseller'
        AND (v.created_at<u.created_at OR (v.created_at=u.created_at AND v.rowid<u.rowid)))`).run(stamp);
      this.db.prepare('INSERT OR IGNORE INTO local_meta VALUES (?,?)').run(OWNER_KEY, stamp);
    }
  }
  table(name) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  account(id) {
    const row = typeof id === 'string' && id.length <= 120 ? this.db.prepare('SELECT id,data FROM resellers WHERE id=?').get(id) : null;
    if (!row) failCode(404, 'Conta não encontrada neste acesso.', 'account_delete_forbidden');
    const data = JSON.parse(row.data);
    return { id, data, name: typeof data.name === 'string' ? data.name : '', accountKind: data.accountKind || (id === this.platformWorkspaceId ? 'platform' : 'reseller'), parentWorkspaceId: data.parentWorkspaceId || null };
  }
  isProtected(id, data) {
    return id === this.platformWorkspaceId || data?.protected === true || data?.accountKind === 'platform'
      || Boolean(this.db.prepare('SELECT 1 FROM account_deletion_protected WHERE workspace_id=?').get(id));
  }
  /** Protection by id: the target itself or any ancestor below the platform root (bounded, cycle-safe). */
  protectedChain(account) {
    if (this.isProtected(account.id, account.data)) return true;
    const seen = new Set([account.id]);
    let parent = account.parentWorkspaceId;
    for (let depth = 0; parent && depth < MAX_ANCESTORS; depth++) {
      if (parent === this.platformWorkspaceId) return false; // the root is the parent of every self-service business
      if (seen.has(parent)) return true; // a cycle is not a trustworthy hierarchy
      seen.add(parent);
      const row = this.db.prepare('SELECT data FROM resellers WHERE id=?').get(parent);
      if (!row) return false;
      let data = {}; try { data = JSON.parse(row.data) || {}; } catch {}
      if (this.isProtected(parent, data)) return true;
      parent = data.parentWorkspaceId || null;
    }
    return Boolean(parent); // deeper than the bound: refuse
  }
  /** Recorded owner, or the earliest administrator when no owner row exists yet (that is the registering user). */
  ownerOf(workspaceId) {
    const recorded = this.db.prepare('SELECT o.user_id FROM workspace_owners o JOIN auth_users u ON u.id=o.user_id AND u.reseller_id=o.workspace_id WHERE o.workspace_id=?').get(workspaceId);
    if (recorded) return recorded.user_id;
    return this.db.prepare("SELECT id FROM auth_users WHERE reseller_id=? AND role='reseller' ORDER BY created_at,rowid LIMIT 1").get(workspaceId)?.id || null;
  }

  /** Authorization for the two entry points; returns the target account. */
  authorize(input, workspaceId, mode) {
    if (!input || input.kind === 'service' || input.supportGrantId) failCode(403, 'Somente o administrador da própria conta pode excluí-la.', 'account_delete_forbidden');
    const row = this.auth.currentActor(input);
    if (row.role !== 'reseller') failCode(403, 'Somente o administrador da própria conta pode excluí-la.', 'account_delete_forbidden');
    const platform = this.isPlatformAdmin(input) === true;
    if (mode === 'platform') {
      if (!platform) failCode(403, 'Somente a administração da plataforma exclui outras contas.', 'account_delete_forbidden');
    } else if (row.reseller_id !== workspaceId || input.resellerId !== workspaceId) failCode(403, 'Somente o administrador da própria conta pode excluí-la.', 'account_delete_forbidden');
    const account = this.account(workspaceId);
    if (this.protectedChain(account)) failCode(403, 'A conta da plataforma e seus produtos não podem ser excluídos.', 'account_delete_platform');
    // Self-service is only for directly billed companies; partner-billed clients and resellers go through the platform.
    if (mode === 'self' && (account.accountKind !== 'business' || account.parentWorkspaceId !== this.platformWorkspaceId))
      failCode(403, 'Esta conta é administrada pelo parceiro responsável. Peça a exclusão ao parceiro ou ao suporte.', 'account_delete_forbidden');
    if (mode === 'self' && this.ownerOf(account.id) !== row.id) failCode(403, 'Somente o responsável que criou a conta pode excluí-la.', 'account_delete_not_owner');
    if (mode === 'platform' && row.reseller_id === account.id) failCode(403, 'Use a exclusão da própria conta em Configurações.', 'account_delete_forbidden');
    return { account, actorRow: row };
  }

  /** Guards that depend on data; reads only. Checked by the dry run and again inside the deleting transaction. */
  guard(account) {
    const children = this.db.prepare("SELECT count(*) AS n FROM resellers WHERE json_extract(data,'$.parentWorkspaceId')=? AND id<>?").get(account.id, account.id).n;
    if (children > 0) failCode(409, 'Esta conta tem contas de clientes vinculadas. Remova ou transfira essas contas antes de excluir.', 'account_delete_has_children', { children });
    if (this.table('elozi_stripe_subscriptions')) {
      const live = this.db.prepare(`SELECT 1 FROM elozi_stripe_subscriptions WHERE workspace_id=? AND status IN (${LIVE_SUBSCRIPTION.map(() => '?').join(',')}) AND coalesce(provider_status,'') NOT IN ('canceled','incomplete_expired') LIMIT 1`).get(account.id, ...LIVE_SUBSCRIPTION);
      if (live) failCode(409, 'Cancele a assinatura em Configurações > Financeiro antes de excluir a conta.', 'account_delete_subscription_active');
    }
    if (this.table('elozi_stripe_checkouts') && this.db.prepare('SELECT 1 FROM elozi_stripe_checkouts WHERE workspace_id=? AND expires_at>? LIMIT 1').get(account.id, Math.floor(this.now() / 1000)))
      failCode(409, 'Há um pagamento em andamento para esta conta. Aguarde o link de pagamento expirar ou conclua o pagamento e cancele a assinatura antes de excluir.', 'account_delete_checkout_open');
    if (this.table('billing_contracts')) {
      const today = new Date(this.now()).toISOString().slice(0, 10);
      if (this.db.prepare("SELECT 1 FROM billing_contracts WHERE (target_workspace_id=? OR seller_workspace_id=?) AND state='active' AND (ends_at IS NULL OR ends_at>=?) LIMIT 1").get(account.id, account.id, today))
        failCode(409, 'Esta conta tem um contrato comercial ativo. Encerre o contrato com o comercial antes de excluir.', 'account_delete_contract_active');
    }
    const shared = this.db.prepare(`SELECT count(*) AS n FROM auth_users u WHERE u.reseller_id=? AND (u.platform_admin=1
      OR EXISTS (SELECT 1 FROM auth_workspace_access a WHERE a.user_id=u.id AND a.reseller_id<>?))`).get(account.id, account.id).n;
    if (shared > 0) failCode(409, 'Há usuários desta conta com acesso a outros workspaces. Retire esses acessos antes de excluir.', 'account_delete_shared_user');
  }

  async verify(input, { confirmName, password }) {
    if (typeof confirmName !== 'string' || typeof password !== 'string') failCode(400, 'Digite o nome da conta e a sua senha atual para confirmar.', 'account_delete_name_mismatch');
    await this.auth.verifyPassword(input, password);
  }

  /** Entry point for both modes. Returns counts; dryRun is read-only (no write lock). */
  async remove(input, workspaceId, { mode = 'self', dryRun = false, confirmName, password } = {}) {
    if (!['self', 'platform'].includes(mode)) throw new TypeError('Modo de exclusão inválido.');
    const { account } = this.authorize(input, workspaceId, mode);
    if (dryRun) return { dryRun: true, workspaceId: account.id, name: account.name, counts: this.preview(account).counts };
    if (normalizedName(confirmName) !== normalizedName(account.name) || !normalizedName(account.name)) failCode(400, 'O nome digitado não corresponde ao nome da conta.', 'account_delete_name_mismatch');
    await this.verify(input, { confirmName, password });
    // Every guard and the whole plan are validated read-only first; channels stop only after that, right before the transaction.
    const { account: current } = this.authorize(input, workspaceId, mode);
    const plan = this.preview(current);
    let stopped = { failures: 0 };
    if (plan.channels.length) stopped = { failures: 0, ...(await this.stopChannels(plan.channels) || {}) };
    let result;
    try {
      result = this.erase(current, { audit: { actorId: input.userId, actorWorkspaceId: input.resellerId, mode, channelStopFailures: Number(stopped.failures) || 0 } });
    } catch (error) {
      // A stable code (not message text) tells the browser that channels must be reconnected; the cause stays available.
      if (plan.channels.length) Object.assign(error, { channelsStopped: plan.channels.length, reconnectRequired: true, causeCode: error.code || null,
        code: 'account_delete_reconnect_required', status: error.status || 500,
        message: `${error.message} Os canais desta conta já foram desconectados e precisam ser reconectados.` });
      throw error;
    }
    // Files after COMMIT; a failure keeps the spool rows for the startup/periodic sweep and never fails the deletion.
    await Promise.resolve().then(() => this.store.sweepMediaDeletions?.()).catch(() => {});
    return { deleted: true, workspaceId: current.id, counts: result.counts };
  }

  /** Account context (tenants, channels, users, principals) in the temp key table; temp writes take no main-database lock. */
  collect(account) {
    const db = this.db, rid = account.id;
    const tenants = db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(rid).map(row => row.id);
    const channels = [], secrets = new Set(), counts = { tenants: tenants.length, channels: 0, conversations: 0, contacts: 0, users: 0, sessions: 0, invitations: 0, servicePrincipals: 0, unlinkedUsers: 0, rows: 0, retained: 0 };
    for (const id of tenants) {
      const row = db.prepare("SELECT json_extract(data,'$.channels') AS channels, json_extract(data,'$.agents') AS agents, json_array_length(json_extract(data,'$.conversations')) AS conversations FROM tenants WHERE id=?").get(id);
      for (const channel of JSON.parse(row.channels || '[]')) if (channel && typeof channel.id === 'string') { channels.push({ tenantId: id, channelId: channel.id, kind: channel.kind, transport: channel.transport || null }); secrets.add(channel.id); }
      for (const agent of JSON.parse(row.agents || '[]')) if (agent && typeof agent.id === 'string') secrets.add(`agent:${agent.id}`);
      if (this.store.conversationJournal) {
        const effective = effectiveTenantRows(db, { tenantId: id })[0];
        try { counts.conversations += JSON.parse(effective?.data || '{}').conversations?.length || 0; } catch {}
      } else counts.conversations += row.conversations || 0;
    }
    counts.channels = channels.length;
    const users = db.prepare('SELECT id FROM auth_users WHERE reseller_id=?').all(rid).map(row => row.id);
    counts.users = users.length;
    const principals = this.table('service_principals') ? db.prepare('SELECT id FROM service_principals WHERE tenant_id IN (SELECT id FROM tenants WHERE reseller_id=?)').all(rid).map(row => row.id) : [];
    counts.servicePrincipals = principals.length;
    counts.unlinkedUsers = this.table('auth_workspace_access') ? db.prepare('SELECT count(*) AS n FROM auth_workspace_access WHERE reseller_id=? AND user_id NOT IN (SELECT id FROM auth_users WHERE reseller_id=?)').get(rid, rid).n : 0;
    if (this.table('contacts')) try { counts.contacts = db.prepare('SELECT count(*) AS n FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE reseller_id=?)').get(rid).n; } catch { counts.contacts = 0; }
    counts.sessions = db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE user_id IN (SELECT id FROM auth_users WHERE reseller_id=?)').get(rid).n;
    counts.invitations = this.table('auth_invitations') ? db.prepare('SELECT count(*) AS n FROM auth_invitations WHERE reseller_id=?').get(rid).n : 0;
    db.exec('CREATE TEMP TABLE IF NOT EXISTS account_deletion_keys (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind,id))');
    db.exec('DELETE FROM temp.account_deletion_keys');
    const key = db.prepare('INSERT OR IGNORE INTO temp.account_deletion_keys VALUES (?,?)');
    key.run('workspace', rid);
    for (const id of tenants) key.run('tenant', id);
    for (const item of channels) key.run('channel', item.channelId);
    for (const id of secrets) key.run('secret', id);
    for (const id of users) key.run('user', id);
    for (const id of principals) key.run('principal', id);
    return { tenants, channels, users, counts };
  }
  /** Main tables present now; an unclassified table blocks the deletion. */
  tables() {
    const names = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
    const unclassified = [...names].filter(name => !classifyTable(name)).sort();
    if (unclassified.length) failCode(500, 'A exclusão foi cancelada: há tabelas sem regra de exclusão ou retenção.', 'account_delete_integrity', { tables: unclassified });
    return names;
  }
  applicable(items, names) { return items.filter(item => names.has(item.table) && item.requires.every(name => names.has(name))); }

  /** Read-only: guards and exact counts of the plan, no write lock and no whole-database scan. */
  preview(account) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      this.guard(account);
      const names = this.tables(), context = this.collect(account);
      for (const item of this.applicable(ERASE_PLAN, names)) context.counts.rows += db.prepare(`SELECT count(*) AS n FROM ${quote(item.table)} WHERE ${item.where}`).get().n;
      for (const item of this.applicable([...RETAIN_ARCHIVE, ...RETAIN_IN_PLACE], names)) context.counts.retained += db.prepare(`SELECT count(*) AS n FROM ${quote(item.table)} WHERE ${item.where}`).get().n;
      context.counts.rows += context.counts.tenants + context.counts.users + 1;
      db.exec('DELETE FROM temp.account_deletion_keys');
      db.exec('ROLLBACK');
      return context;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }

  /** The deletion: one write transaction, explicit order, deferred foreign keys verified at COMMIT. */
  erase(account, { audit }) {
    const db = this.db, rid = account.id, started = performance.now();
    db.exec('BEGIN IMMEDIATE');
    const locked = performance.now();
    try {
      this.guard(account);
      const names = this.tables();
      const { tenants, channels, counts } = this.collect(account);
      if (this.store.conversationJournal) for (const id of tenants) materializeTenant(db, id, { workspaceId: rid });
      db.exec('PRAGMA defer_foreign_keys=ON');
      const stamp = new Date(this.now()).toISOString();
      // Trial abuse prevention: a pseudonymous (keyed HMAC) tombstone of the document survives the account.
      // Key rotation: the digest is HMAC-SHA256 under the signup-trial key with the fixed domain tag
      // 'mepchat-signup-document:v1' (signup-trial.js). There is no key-version column, so rotating that key silently
      // voids every tombstone and every registration digest (a deleted document could start a new trial). Treat the key
      // as non-rotating; a rotation must add a key_version column and keep the old key to check old digests.
      if (names.has('signup_trial_registrations')) db.prepare('INSERT OR IGNORE INTO signup_trial_tombstones SELECT identity_digest,document_kind,? FROM signup_trial_registrations WHERE workspace_id=?').run(stamp, rid);
      let removed = 0, retained = 0;
      const archive = db.prepare('INSERT INTO account_deletion_retained VALUES (?,?,?,?,?)');
      for (const item of this.applicable(RETAIN_ARCHIVE, names)) {
        for (const row of db.prepare(`SELECT * FROM ${quote(item.table)} WHERE ${item.where}`).all()) {
          const record = Object.fromEntries(Object.entries(row).map(([column, value]) => [column, item.redact.includes(column) && value !== null ? REDACTED
            : typeof value === 'string' && /^[[{]/.test(value) ? redactJson(value) : value instanceof Uint8Array ? null : value]));
          archive.run(randomUUID(), rid, item.table, JSON.stringify(record), stamp); retained++;
        }
        removed += db.prepare(`DELETE FROM ${quote(item.table)} WHERE ${item.where}`).run().changes;
      }
      for (const item of this.applicable(RETAIN_IN_PLACE, names)) {
        const present = new Set(db.prepare(`PRAGMA table_info(${quote(item.table)})`).all().map(column => column.name));
        const text = item.text.filter(name => present.has(name)), json = item.json.filter(name => present.has(name));
        if (text.length) db.prepare(`UPDATE ${quote(item.table)} SET ${text.map(name => `${quote(name)}=CASE WHEN ${quote(name)} IS NULL THEN NULL ELSE '${REDACTED}' END`).join(',')} WHERE ${item.where}`).run();
        if (json.length) for (const row of db.prepare(`SELECT rowid AS _rowid, ${json.map(quote).join(',')} FROM ${quote(item.table)} WHERE ${item.where}`).all())
          db.prepare(`UPDATE ${quote(item.table)} SET ${json.map(name => `${quote(name)}=?`).join(',')} WHERE rowid=?`).run(...json.map(name => redactJson(row[name])), row._rowid);
        retained += db.prepare(`SELECT count(*) AS n FROM ${quote(item.table)} WHERE ${item.where}`).get().n;
      }
      // Attachment files: ids and the relative file name only (no personal data), queued before the rows disappear.
      if (names.has('media_attachments')) counts.mediaFiles = db.prepare(`INSERT OR IGNORE INTO media_deletion_spool(attachment_id,file,queued_at) SELECT id,id||'.mepmedia',? FROM media_attachments WHERE tenant_id IN ${T}`).run(stamp).changes;
      for (const item of this.applicable(ERASE_PLAN, names)) removed += db.prepare(`DELETE FROM ${quote(item.table)} WHERE ${item.where}`).run().changes;
      // Invitations accepted by users of this account but issued elsewhere keep their history, without the user link.
      if (names.has('auth_invitations')) db.prepare(`UPDATE auth_invitations SET accepted_user_id=NULL WHERE accepted_user_id IN ${U}`).run();
      removed += db.prepare('DELETE FROM tenants WHERE reseller_id=?').run(rid).changes;
      removed += db.prepare('DELETE FROM auth_users WHERE reseller_id=?').run(rid).changes;
      removed += db.prepare('DELETE FROM resellers WHERE id=?').run(rid).changes;
      Object.assign(counts, { rows: removed, retained, channelStopFailures: audit.channelStopFailures || 0 });
      if (names.has('postgres_spool')) db.prepare(`DELETE FROM postgres_spool WHERE tenant_id IN ${T}`).run();
      for (const id of tenants) this.store.queuePostgresDeletion?.(id, rid);
      db.prepare('INSERT INTO account_deletion_audit VALUES (?,?,?,?,?,?,?)').run(randomUUID(), rid, String(audit.actorId), String(audit.actorWorkspaceId), audit.mode, JSON.stringify(counts), stamp);
      db.exec('DELETE FROM temp.account_deletion_keys');
      this.commit(names);
      const committed = performance.now();
      this.lastTiming = { waitMs: locked - started, lockMs: committed - locked, rows: removed, retained };
      for (const id of tenants) this.store.readonlyHeaderCache?.invalidate(rid, id);
      return { counts, channels, tenants };
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  /** COMMIT; a deferred foreign key violation keeps the transaction open: name the affected tables, then roll back. */
  commit(names) {
    const db = this.db;
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) {
      const left = this.violations(names);
      if (left.length) failCode(500, 'A exclusão foi cancelada para preservar a integridade dos dados.', 'account_delete_integrity', { tables: left });
    }
    try { db.exec('COMMIT'); }
    catch (error) {
      if (!/FOREIGN KEY/i.test(String(error?.message))) throw error;
      failCode(500, 'A exclusão foi cancelada para preservar a integridade dos dados.', 'account_delete_integrity', { tables: this.violations(names) });
    }
  }
  /** PRAGMA foreign_key_check(<table>) only on tables with a foreign key into a table this deletion touches. */
  violations(names) {
    const touched = new Set([...CORE_TABLES, ...ERASE_PLAN.map(item => item.table), ...RETAIN_ARCHIVE.map(item => item.table)]);
    const affected = [...names].filter(name => { try { return this.db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all().some(fk => touched.has(fk.table)); } catch { return false; } });
    return [...new Set(affected.flatMap(name => this.db.prepare(`PRAGMA foreign_key_check(${quote(name)})`).all().map(item => item.table)))].sort();
  }
}
