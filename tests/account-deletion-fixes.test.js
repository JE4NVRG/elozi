import test from 'node:test';
import { join as joinPath } from 'node:path';
// Isolated key directory: registration enqueues a verification e-mail whose key lives under LOCALAPPDATA
// (the image points it at the mounted /run/elozi-secrets-parent, absent in test containers).
process.env.LOCALAPPDATA = mkdtempSync(joinPath(tmpdir(), 'elozi-deletion-test-'));
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { PostgresBridge, DELETION_MAX_ATTEMPTS } from '../src/postgres-bridge.js';
import { SignupTrials } from '../src/signup-trial.js';
import { AccountDeletion, classifyTable, ERASE_PLAN, RETAIN_ARCHIVE, RETAIN_IN_PLACE, GLOBAL_TABLES, CORE_TABLES, pseudonymize } from '../src/commercial-account-deletion.js';

const password = 'Synthetic-Owner-4567!';

async function http(t, options = {}) {
  const app = createApp({ databasePath: ':memory:', ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.bridge.close(); app.store.close(); });
  const request = async (path, { method = 'GET', body, cookie = '' } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  };
  return { app, request };
}
async function register(request, { company = 'Empresa Sintética', email = `owner-${randomUUID()}@example.test` } = {}) {
  const result = await request('/api/auth/register', { method: 'POST', body: { name: 'Owner sintético', email, password, company } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const me = await request('/api/auth/me', { cookie: result.cookie });
  return { cookie: result.cookie, user: me.data.user, workspaceId: me.data.user.resellerId, email };
}
// Without a pool: the fully wired app (billing, Stripe and auth tables). With a pool: Store + PostgresBridge only.
function unit(t, { path = ':memory:', pool, seed } = {}) {
  const calls = [];
  let store, bridge, auth;
  if (pool) {
    store = new Store(path); seed?.(store);
    bridge = new PostgresBridge(store, { pool });
    auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  } else {
    const app = createApp({ databasePath: path });
    ({ store, bridge, auth } = app); seed?.(store);
    store.db.prepare('DELETE FROM local_meta WHERE key=?').run('account_deletion_protected_pinned_v1'); // re-run the one-time pinning on the seeded rows
  }
  const deletion = new AccountDeletion(store, { auth, isPlatformAdmin: actor => actor.platform === true, stopChannels: async channels => { deletion.stopped = channels; return deletion.onStop?.(channels); } });
  t.after(async () => { await bridge.close(); store.close(); });
  const owner = async (company = 'Fixture Empresa') => {
    const session = await auth.register({ name: 'Owner', email: `fx-${randomUUID()}@example.test`, password, company }, { provision: input => store.provisionReseller(input) });
    return { actor: session.actor, tenantId: store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(session.actor.resellerId).id };
  };
  return { store, bridge, auth, deletion, calls, owner };
}
const platformActor = (store, f) => {
  const id = 'user_' + randomUUID();
  store.db.prepare("INSERT INTO auth_users(id,username,name,role,reseller_id,tenant_ids,password_salt,password_hash,created_at,platform_admin) VALUES (?,?,?,'reseller','mep-demo','[]',x'00',x'00',?,1)").run(id, 'pa-' + id, 'Plataforma', Date.now());
  return { userId: id, resellerId: 'mep-demo', role: 'reseller', platform: true };
};

test('P1-1: a deleted account keeps a pseudonymous trial tombstone, so the same CPF cannot start another trial', async t => {
  const f = unit(t), key = Buffer.alloc(32, 7);
  const trials = new SignupTrials(f.store.db, { keyLoader: async () => key });
  const { actor } = await f.owner('Trial Empresa');
  const reserve = async (workspaceId, document) => { const prepared = await trials.prepare(document); f.store.db.exec('BEGIN'); try { return trials.reserve(workspaceId, prepared); } finally { if (f.store.db.isTransaction) f.store.db.exec('ROLLBACK'); } };
  const prepared = await trials.prepare('529.982.247-25');
  f.store.db.exec('BEGIN'); trials.reserve(actor.resellerId, prepared); f.store.db.exec('COMMIT');
  await f.deletion.remove(actor, actor.resellerId, { confirmName: 'Trial Empresa', password });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM signup_trial_registrations').get().n, 0);
  const tombstone = f.store.db.prepare('SELECT * FROM signup_trial_tombstones').get();
  assert.equal(tombstone.document_kind, 'cpf'); assert.match(tombstone.identity_digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(tombstone), /52998224725|529\.982/, 'no raw document is stored');
  const other = await f.owner('Nova Empresa');
  await assert.rejects(reserve(other.actor.resellerId, '52998224725'), error => error.status === 409);
  assert.ok(await reserve(other.actor.resellerId, '111.444.777-35'), 'a different document still gets a trial');
});

test('P1-2: protection is by workspace id and ancestry, not by name', async t => {
  const pinnedId = 'reseller_' + randomUUID();
  const f = unit(t, { seed: store => store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(pinnedId, JSON.stringify({ name: 'Family Points', accountKind: 'reseller', parentWorkspaceId: 'mep-demo' })) });
  const admin = platformActor(f.store);
  // Pinned at first start by id; renaming it afterwards does not remove the protection.
  f.store.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify({ name: 'Outro Nome', accountKind: 'reseller', parentWorkspaceId: 'mep-demo' }), pinnedId);
  await assert.rejects(f.deletion.remove(admin, pinnedId, { mode: 'platform', dryRun: true }), error => error.code === 'account_delete_platform');
  // A child (and grandchild) of a protected workspace is refused, even if it has no children itself.
  const child = 'reseller_' + randomUUID(), grandchild = 'reseller_' + randomUUID();
  f.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(child, JSON.stringify({ name: 'Cliente FP', accountKind: 'reseller', parentWorkspaceId: pinnedId }));
  f.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(grandchild, JSON.stringify({ name: 'Neto FP', accountKind: 'business', parentWorkspaceId: child }));
  await assert.rejects(f.deletion.remove(admin, grandchild, { mode: 'platform', dryRun: true }), error => error.code === 'account_delete_platform');
  // A self-registered account renamed to a product name is NOT protected (only ids are).
  const { actor } = await f.owner('Empresa Qualquer');
  f.store.db.prepare('UPDATE resellers SET data=json_set(data,\'$.name\',\'Family Points\') WHERE id=?').run(actor.resellerId);
  const dry = await f.deletion.remove(admin, actor.resellerId, { mode: 'platform', dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(dry.name, 'Family Points');
  // Configured ids and a cyclic parent chain are refused; an account with any child is refused.
  const configured = new AccountDeletion(f.store, { auth: f.auth, isPlatformAdmin: () => true, protectedWorkspaceIds: [actor.resellerId] });
  await assert.rejects(configured.remove(admin, actor.resellerId, { mode: 'platform', dryRun: true }), error => error.code === 'account_delete_platform');
  const a = 'reseller_' + randomUUID(), b = 'reseller_' + randomUUID();
  f.store.db.prepare('INSERT INTO resellers VALUES (?,?),(?,?)').run(a, JSON.stringify({ name: 'A', parentWorkspaceId: b }), b, JSON.stringify({ name: 'B', parentWorkspaceId: a }));
  await assert.rejects(f.deletion.remove(admin, a, { mode: 'platform', dryRun: true }), error => error.code === 'account_delete_platform');
  await assert.rejects(f.deletion.remove(admin, child, { mode: 'platform', dryRun: true }), error => error.code === 'account_delete_platform');
});

test('P1-3: every table of a fully migrated database is classified (erase, retain, global or core)', async t => {
  const lists = [ERASE_PLAN.map(item => item.table), RETAIN_ARCHIVE.map(item => item.table), RETAIN_IN_PLACE.map(item => item.table), GLOBAL_TABLES, CORE_TABLES].flat();
  assert.equal(new Set(lists).size, lists.length, 'a table belongs to exactly one list');
  const { app } = await http(t);
  const journal = createApp({ databasePath: ':memory:', conversationJournal: true });
  t.after(async () => { await journal.bridge.close(); journal.store.close(); });
  for (const db of [app.store.db, journal.store.db]) {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    assert.ok(names.length > 60);
    assert.deepEqual(names.filter(name => !classifyTable(name)), [], 'classify every new table in commercial-account-deletion.js');
  }
});

test('P1-3: financial records are retained and pseudonymized, operational data is erased, other accounts untouched', async t => {
  const f = unit(t), db = f.store.db, admin = platformActor(f.store);
  const { actor, tenantId } = await f.owner('Fiscal Empresa');
  const keep = await f.owner('Vizinha');
  const rid = actor.resellerId, now = new Date().toISOString(), contract = 'contract_' + randomUUID(), other = 'contract_' + randomUUID();
  const insertContract = db.prepare(`INSERT INTO billing_contracts(id,scope,seller_workspace_id,target_workspace_id,tenant_id,name,currency,items,quotas,period_months,starts_at,ends_at,grace_days,state,version,created_at,updated_at,target_kind)
    VALUES (?,'platform','mep-demo',?,NULL,?,'BRL','[{"code":"conecta","name":"Plano Conecta","unitCents":9900}]','{}',1,'2026-01-01','2026-06-30',5,'ended',1,?,?,'reseller')`);
  insertContract.run(contract, rid, 'Contrato Fiscal Empresa Ltda', now, now);
  insertContract.run(other, keep.actor.resellerId, 'Contrato Vizinha', now, now);
  db.prepare(`INSERT INTO billing_invoices(id,contract_id,contract_version,snapshot,period_start,period_end,due_date,grace_days,total_cents,paid_cents,state,version,created_at,updated_at)
    VALUES (?,?,1,?,'2026-01-01','2026-01-31','2026-02-05',5,9900,9900,'settled',1,?,?)`).run('inv_' + randomUUID(), contract, JSON.stringify({ customerName: 'Fulano', customerEmail: 'f@example.test', totalCents: 9900, plan: 'conecta' }), now, now);
  db.prepare("INSERT INTO elozi_stripe_customers VALUES (?,1,'cus_fiscal','cpf',?)").run(rid, now);
  db.prepare("INSERT INTO elozi_stripe_subscriptions(workspace_id,livemode,customer_id,subscription_id,status,plan,updated_at,provider_status) VALUES (?,1,'cus_fiscal','sub_fiscal','canceled','conecta',?,'canceled')").run(rid, now);
  db.prepare("INSERT INTO elozi_stripe_audit VALUES (?,?,NULL,?,'checkout.created',?,?)").run(randomUUID(), rid, actor.userId, JSON.stringify({ email: 'f@example.test', amountCents: 9900 }), now);
  assert.equal((await f.deletion.remove(admin, rid, { mode: 'platform', dryRun: true })).counts.retained, 5, 'dry run counts retained rows');
  const result = await f.deletion.remove(actor, rid, { confirmName: 'Fiscal Empresa', password });
  assert.equal(result.deleted, true); assert.ok(result.counts.retained >= 4);
  const kept = db.prepare('SELECT * FROM billing_contracts WHERE id=?').get(contract);
  assert.equal(kept.name, '[removido]'); assert.equal(kept.target_workspace_id, rid); assert.equal(kept.state, 'ended');
  const invoice = db.prepare('SELECT * FROM billing_invoices WHERE contract_id=?').get(contract);
  assert.equal(invoice.total_cents, 9900); assert.doesNotMatch(invoice.snapshot, /Fulano|example\.test/); assert.match(invoice.snapshot, /"plan":"conecta"/);
  assert.equal(db.prepare('SELECT name FROM billing_contracts WHERE id=?').get(other).name, 'Contrato Vizinha');
  assert.equal(db.prepare('SELECT count(*) AS n FROM elozi_stripe_subscriptions WHERE workspace_id=?').get(rid).n, 0);
  const archived = db.prepare('SELECT source_table,record FROM account_deletion_retained WHERE workspace_id=? ORDER BY source_table').all(rid).map(row => ({ table: row.source_table, record: JSON.parse(row.record) }));
  const subscription = archived.find(item => item.table === 'elozi_stripe_subscriptions').record;
  assert.equal(subscription.subscription_id, 'sub_fiscal'); assert.equal(subscription.plan, 'conecta'); assert.equal(subscription.status, 'canceled');
  assert.equal(archived.find(item => item.table === 'elozi_stripe_customers').record.customer_id, 'cus_fiscal');
  assert.doesNotMatch(db.prepare('SELECT detail FROM elozi_stripe_audit WHERE workspace_id=?').get(rid).detail, /example\.test/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tenants WHERE id=?').get(tenantId).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM resellers WHERE id=?').get(keep.actor.resellerId).n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(pseudonymize({ id: 'x', customerName: 'A', items: [{ amountCents: 1, description: 'd', email: 'e' }] }), { id: 'x', customerName: '[removido]', items: [{ amountCents: 1, description: 'd', email: '[removido]' }] });
});

test('P1-3: an unclassified table blocks the deletion and nothing is removed', async t => {
  const f = unit(t);
  const { actor } = await f.owner('Rogue Empresa');
  f.store.db.exec('CREATE TABLE rogue_feature (tenant_id TEXT, payload TEXT)');
  await assert.rejects(f.deletion.remove(actor, actor.resellerId, { dryRun: true }), error => error.code === 'account_delete_integrity' && error.tables.includes('rogue_feature'));
  await assert.rejects(f.deletion.remove(actor, actor.resellerId, { confirmName: 'Rogue Empresa', password }), error => error.code === 'account_delete_integrity');
  assert.ok(f.store.db.prepare('SELECT 1 FROM resellers WHERE id=?').get(actor.resellerId));
});

test('P1-4: dry run runs while another connection holds the write lock; deletion uses no whole-database FK scan', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elozi-delete-lock-')), path = join(dir, 'lock.sqlite');
  const f = unit(t, { path });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); // after the store closes
  const { actor } = await f.owner('Lock Empresa');
  const writer = new DatabaseSync(path); writer.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  try {
    const dry = await f.deletion.remove(actor, actor.resellerId, { dryRun: true });
    assert.equal(dry.counts.tenants, 1, 'read-only dry run does not need the write lock');
    await assert.rejects(f.deletion.remove(actor, actor.resellerId, { confirmName: 'Lock Empresa', password }), /locked|busy/i);
  } finally { writer.exec('ROLLBACK'); writer.close(); }
  const executed = [], exec = f.store.db.exec.bind(f.store.db), prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.exec = sql => { executed.push(sql); return exec(sql); };
  f.store.db.prepare = sql => { executed.push(sql); return prepare(sql); };
  await f.deletion.remove(actor, actor.resellerId, { dryRun: true });
  assert.ok(!executed.some(sql => /BEGIN IMMEDIATE|foreign_key_check/i.test(sql) || /^\s*(DELETE|UPDATE|INSERT)\b(?![\s\S]*temp\.account_deletion_keys)/i.test(sql)), 'dry run: no write lock, no write, no FK scan');
  executed.length = 0;
  await f.deletion.remove(actor, actor.resellerId, { confirmName: 'Lock Empresa', password });
  assert.equal(executed.filter(sql => /BEGIN IMMEDIATE/.test(sql)).length, 1, 'one write transaction');
  assert.ok(!executed.some(sql => /PRAGMA foreign_key_check\s*$/i.test(sql)), 'no whole-database foreign_key_check');
  assert.ok(f.deletion.lastTiming.lockMs >= 0);
  f.store.db.exec = exec; f.store.db.prepare = prepare;
});

test('P2-5: incomplete subscriptions and open checkout sessions block the deletion', async t => {
  const f = unit(t), db = f.store.db;
  const { actor } = await f.owner('Stripe Empresa');
  const rid = actor.resellerId, now = new Date().toISOString();
  db.prepare("INSERT INTO elozi_stripe_subscriptions(workspace_id,livemode,customer_id,subscription_id,status,plan,updated_at) VALUES (?,1,'cus_i','sub_i','incomplete','conecta',?)").run(rid, now);
  await assert.rejects(f.deletion.remove(actor, rid, { dryRun: true }), error => error.code === 'account_delete_subscription_active');
  db.prepare("UPDATE elozi_stripe_subscriptions SET status='canceled',provider_status='incomplete_expired' WHERE workspace_id=?").run(rid);
  db.prepare("INSERT INTO elozi_stripe_checkouts VALUES (?,1,'cs_open','conecta',0,'https://checkout.stripe.test/cs_open',?,?)").run(rid, Math.floor(Date.now() / 1000) + 1800, now);
  await assert.rejects(f.deletion.remove(actor, rid, { dryRun: true }), error => error.code === 'account_delete_checkout_open');
  db.prepare('UPDATE elozi_stripe_checkouts SET expires_at=? WHERE workspace_id=?').run(Math.floor(Date.now() / 1000) - 1, rid);
  assert.equal((await f.deletion.remove(actor, rid, { dryRun: true })).dryRun, true);
});

test('P2-6: channels stop only after every guard passes; a failing transaction reports the disconnected channels', async t => {
  const f = unit(t), db = f.store.db;
  const { actor, tenantId } = await f.owner('Canal Empresa');
  f.store.mutate(actor, tenantId, 'Synthetic channel', state => { state.channels = [{ id: 'wa-' + randomUUID(), kind: 'whatsapp_qr', name: 'WA', state: 'disconnected', transport: 'baileys' }]; });
  db.prepare("INSERT INTO elozi_stripe_subscriptions(workspace_id,livemode,customer_id,subscription_id,status,plan,updated_at) VALUES (?,1,'cus_c','sub_c','active','conecta',?)").run(actor.resellerId, new Date().toISOString());
  await assert.rejects(f.deletion.remove(actor, actor.resellerId, { confirmName: 'Canal Empresa', password }), error => error.code === 'account_delete_subscription_active');
  assert.equal(f.deletion.stopped, undefined, 'guards fail before any channel is stopped');
  db.prepare("UPDATE elozi_stripe_subscriptions SET status='canceled' WHERE workspace_id=?").run(actor.resellerId);
  // Simulate a race between the stop and the transaction (a schema change that the transaction refuses).
  f.deletion.onStop = () => { db.exec('CREATE TABLE late_feature (tenant_id TEXT)'); return { failures: 1 }; };
  await assert.rejects(f.deletion.remove(actor, actor.resellerId, { confirmName: 'Canal Empresa', password }),
    error => error.code === 'account_delete_reconnect_required' && error.causeCode === 'account_delete_integrity' && error.reconnectRequired === true && error.channelsStopped === 1 && /reconectados/.test(error.message));
  assert.ok(db.prepare('SELECT 1 FROM resellers WHERE id=?').get(actor.resellerId), 'the account stays');
  db.exec('DROP TABLE late_feature'); f.deletion.onStop = () => ({ failures: 1 });
  const done = await f.deletion.remove(actor, actor.resellerId, { confirmName: 'Canal Empresa', password });
  assert.equal(done.counts.channelStopFailures, 1);
  assert.equal(JSON.parse(db.prepare('SELECT counts FROM account_deletion_audit WHERE workspace_id=?').get(actor.resellerId).counts).channelStopFailures, 1);
});

test('P2-7: tombstones back off exponentially, end failed after the cap, legacy ids are manual, snapshots never block erasure', async t => {
  let refuse = true, snapshotDown = false, deletes = 0;
  const pool = { on() {}, async end() {}, async connect() { return { async query(sql) {
    if (/delete_workspace_tenant/.test(sql)) { deletes++; if (refuse) throw new Error('refused'); }
    if (/sync_workspace/.test(sql) && snapshotDown) throw new Error('down');
    return { rows: [] };
  }, release() {} }; } };
  const f = unit(t, { pool });
  let clock = Date.parse('2026-11-03T12:00:00Z'); f.bridge.now = () => clock;
  const { actor, tenantId } = await f.owner('Backoff Empresa');
  await f.bridge.flush();
  await f.deletion.remove(actor, actor.resellerId, { confirmName: 'Backoff Empresa', password });
  await f.bridge.flush();
  let job = f.store.db.prepare('SELECT * FROM postgres_deletion_spool WHERE tenant_id=?').get(tenantId);
  assert.equal(job.attempts, 1); assert.equal(job.next_attempt_at, clock + 30000); assert.equal(f.bridge.state, 'deletions_pending');
  await f.bridge.flush(); assert.equal(deletes, 1, 'not retried before the backoff elapses');
  for (let attempt = 2; attempt <= DELETION_MAX_ATTEMPTS; attempt++) { clock += 31 * 60 * 1000; await f.bridge.flush(); }
  job = f.store.db.prepare('SELECT * FROM postgres_deletion_spool WHERE tenant_id=?').get(tenantId);
  assert.equal(job.state, 'failed'); assert.equal(job.attempts, DELETION_MAX_ATTEMPTS);
  assert.equal(f.bridge.status().failedDeletions, 1); assert.equal(f.bridge.state, 'deletions_failed'); assert.ok(f.bridge.status().oldestDeletionAgeMs > 0);
  clock += 60 * 60 * 1000; await f.bridge.flush(); assert.equal(deletes, DELETION_MAX_ATTEMPTS, 'failed jobs are not retried automatically');
  f.bridge.queueDeletion('playtech-demo', 'mep-demo');
  assert.equal(f.store.db.prepare("SELECT state FROM postgres_deletion_spool WHERE tenant_id='playtech-demo'").get().state, 'manual');
  assert.equal(f.bridge.status().manualDeletions, 1);
  // A snapshot outage does not block tombstones.
  refuse = false; snapshotDown = true;
  const next = await f.owner('Outra Backoff');
  const third = await f.owner('Terceira Backoff');
  await f.deletion.remove(next.actor, next.actor.resellerId, { confirmName: 'Outra Backoff', password });
  f.bridge.queue(third.tenantId);
  await assert.rejects(f.bridge.flush());
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM postgres_deletion_spool WHERE tenant_id=?').get(next.tenantId).n, 0, 'tombstone drained despite the snapshot failure');
  assert.equal(f.bridge.state, 'offline');
});

test('P2-9 and P2-10: malformed ids are 400; only the owner deletes; dry runs are limited to 3 per minute', async t => {
  const { app, request } = await http(t), db = app.store.db;
  const admin = await request('/api/auth/setup', { method: 'POST', body: { name: 'Platform', username: 'platform-admin', password } });
  let result = await request('/api/platform/accounts/%E0%A4%A/delete', { method: 'POST', cookie: admin.cookie, body: { dryRun: true } });
  assert.equal(result.status, 400); assert.equal(result.data.code, 'account_delete_invalid_id');
  result = await request('/api/platform/accounts/a%20b/delete', { method: 'POST', cookie: admin.cookie, body: { dryRun: true } });
  assert.equal(result.status, 400); assert.equal(result.data.code, 'account_delete_invalid_id');
  const owner = await register(request, { company: 'Dona Empresa' });
  const row = db.prepare('SELECT * FROM auth_users WHERE id=?').get(owner.user.id);
  const secondEmail = `second-${randomUUID()}@example.test`, secondId = 'user_' + randomUUID();
  db.prepare(`INSERT INTO auth_users(id,username,name,role,reseller_id,tenant_ids,password_salt,password_hash,password_version,created_at,email,email_verified)
    VALUES (?,?,?,'reseller',?,?,?,?,?,?,?,1)`).run(secondId, secondEmail, 'Segunda admin', row.reseller_id, row.tenant_ids, row.password_salt, row.password_hash, row.password_version, row.created_at + 1000, secondEmail);
  const second = await request('/api/auth/login', { method: 'POST', body: { email: secondEmail, password } });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  result = await request('/api/account/delete', { method: 'POST', cookie: second.cookie, body: { dryRun: true } });
  assert.equal(result.status, 403); assert.equal(result.data.code, 'account_delete_not_owner');
  result = await request('/api/account/delete', { method: 'POST', cookie: second.cookie, body: { confirmName: 'Dona Empresa', password } });
  assert.equal(result.data.code, 'account_delete_not_owner');
  assert.ok(db.prepare('SELECT 1 FROM resellers WHERE id=?').get(owner.workspaceId));
  const statuses = [];
  for (let index = 0; index < 4; index++) statuses.push((await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { dryRun: true } })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  result = await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { confirmName: 'Dona Empresa', password } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users WHERE id=?').get(secondId).n, 0);
});
