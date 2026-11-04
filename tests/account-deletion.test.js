import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
// Isolated key directory: registration enqueues a verification e-mail whose key lives under LOCALAPPDATA
// (the image points it at the mounted /run/elozi-secrets-parent, absent in test containers).
process.env.LOCALAPPDATA = mkdtempSync(joinPath(tmpdir(), 'elozi-deletion-test-'));
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { PostgresBridge } from '../src/postgres-bridge.js';
import { AccountDeletion } from '../src/commercial-account-deletion.js';
import { deletionTransaction } from '../src/ssh-postgres.js';

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
async function register(request, { company = 'Empresa Sintética', locale, email = `owner-${randomUUID()}@example.test` } = {}) {
  const result = await request('/api/auth/register', { method: 'POST', body: { name: 'Owner sintético', email, password, company, ...(locale ? { locale } : {}) } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const me = await request('/api/auth/me', { cookie: result.cookie });
  return { cookie: result.cookie, user: me.data.user, workspaceId: me.data.user.resellerId };
}
const fkClean = db => assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

test('signup locale: EN signup stores en in the new profile, default and unknown values keep pt-BR', async t => {
  const { request } = await http(t);
  assert.equal((await register(request, { locale: 'en' })).user.locale, 'en');
  assert.equal((await register(request)).user.locale, 'pt-BR');
  assert.equal((await register(request, { locale: 'fr' })).user.locale, 'pt-BR');
});

test('owner self-service deletion: dry run, guards, one transaction, session cleared, users of other workspaces unlinked', async t => {
  const { app, request } = await http(t), db = app.store.db;
  const admin = await request('/api/auth/setup', { method: 'POST', body: { name: 'Platform', username: 'platform-admin', password } });
  assert.equal(admin.status, 200);
  const keep = await register(request, { company: 'Outra Empresa' });
  const owner = await register(request, { company: 'Empresa Sintética' });
  const actor = { ...app.auth.actor(db.prepare('SELECT * FROM auth_users WHERE id=?').get(owner.user.id)) };
  const tenantId = db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(owner.workspaceId).id;
  app.store.mutate(actor, tenantId, 'Synthetic data', state => {
    state.channels = [{ id: 'deleted-channel-' + randomUUID(), kind: 'webchat', name: 'Site', state: 'planned' }];
    state.conversations = [{ id: randomUUID(), contact: 'Cliente', channelId: state.channels[0].id, status: 'open', owner: 'human', version: 1, unread: 0, updatedAt: new Date().toISOString(), messages: [{ id: randomUUID(), kind: 'customer', text: 'Olá', createdAt: new Date().toISOString() }] }];
  });
  // A second session and a platform admin linked to the workspace (must only be unlinked).
  const second = await request('/api/auth/login', { method: 'POST', body: { email: owner.user.email, password } });
  const adminRow = db.prepare('SELECT id FROM auth_users WHERE platform_admin=1').get();
  db.prepare('INSERT INTO auth_workspace_access(user_id,reseller_id,created_at) VALUES (?,?,?)').run(adminRow.id, owner.workspaceId, Date.now());

  const dry = await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { dryRun: true } });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.dryRun, true); assert.equal(dry.data.name, 'Empresa Sintética');
  assert.equal(dry.data.counts.tenants, 1); assert.equal(dry.data.counts.channels, 1); assert.equal(dry.data.counts.conversations, 1);
  assert.equal(dry.data.counts.users, 1); assert.equal(dry.data.counts.sessions, 2); assert.equal(dry.data.counts.unlinkedUsers, 1);
  assert.ok(db.prepare('SELECT 1 FROM resellers WHERE id=?').get(owner.workspaceId), 'dry run keeps every row');

  let result = await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { confirmName: 'Outro nome', password } });
  assert.equal(result.status, 400); assert.equal(result.data.code, 'account_delete_name_mismatch');
  result = await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { confirmName: 'empresa  sintética', password: 'wrong-Password-1!' } });
  assert.equal(result.status, 403); assert.equal(result.data.code, 'account_delete_password_invalid');
  result = await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { confirmName: 'x', password, extra: true } });
  assert.equal(result.status, 400);

  db.prepare("INSERT INTO elozi_stripe_subscriptions(workspace_id,livemode,customer_id,subscription_id,status,plan,updated_at) VALUES (?,1,'cus_synthetic','sub_synthetic','active','conecta',?)").run(owner.workspaceId, new Date().toISOString());
  result = await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { confirmName: 'Empresa Sintética', password } });
  assert.equal(result.status, 409); assert.equal(result.data.code, 'account_delete_subscription_active');
  db.prepare("UPDATE elozi_stripe_subscriptions SET status='canceled' WHERE workspace_id=?").run(owner.workspaceId);

  result = await request('/api/account/delete', { method: 'POST', cookie: owner.cookie, body: { confirmName: 'Empresa Sintética', password } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.deleted, true); assert.match(result.cookie, /^mep_session=$/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM resellers WHERE id=?').get(owner.workspaceId).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tenants WHERE reseller_id=?').get(owner.workspaceId).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users WHERE id=?').get(owner.user.id).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE user_id=?').get(owner.user.id).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM elozi_stripe_subscriptions WHERE workspace_id=?').get(owner.workspaceId).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM service_tenant_private WHERE tenant_id=?').get(tenantId).n, 0);
  assert.ok(db.prepare('SELECT 1 FROM auth_users WHERE id=?').get(adminRow.id), 'shared platform user is kept');
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access WHERE reseller_id=?').get(owner.workspaceId).n, 0);
  const audit = db.prepare('SELECT * FROM account_deletion_audit WHERE workspace_id=?').get(owner.workspaceId);
  assert.equal(audit.mode, 'self'); assert.equal(audit.actor_id, owner.user.id); assert.doesNotMatch(audit.counts, /@|Empresa|Cliente/);
  fkClean(db);
  assert.equal((await request('/api/bootstrap', { cookie: second.cookie })).status, 401);
  assert.ok(db.prepare('SELECT 1 FROM resellers WHERE id=?').get(keep.workspaceId), 'other accounts are untouched');
  assert.equal((await request('/api/auth/me', { cookie: keep.cookie })).status, 200);
});

test('platform deletion: platform admin only, protected workspaces and accounts with clients are refused', async t => {
  const { app, request } = await http(t), db = app.store.db;
  const admin = await request('/api/auth/setup', { method: 'POST', body: { name: 'Platform', username: 'platform-admin', password } });
  const target = await register(request, { company: 'Cliente Final' });
  const other = await register(request, { company: 'Curiosa' });
  let result = await request(`/api/platform/accounts/${target.workspaceId}/delete`, { method: 'POST', cookie: other.cookie, body: { dryRun: true } });
  assert.equal(result.status, 403); assert.equal(result.data.code, 'account_delete_forbidden');
  result = await request('/api/platform/accounts/mep-demo/delete', { method: 'POST', cookie: admin.cookie, body: { dryRun: true } });
  assert.equal(result.status, 403);
  const familyId = 'reseller_' + randomUUID();
  db.prepare('INSERT INTO resellers VALUES (?,?)').run(familyId, JSON.stringify({ name: 'FamilyPoints', accountKind: 'business', parentWorkspaceId: 'mep-demo' }));
  // Product workspaces are protected by id (pinned or configured), not by name.
  db.prepare("INSERT INTO account_deletion_protected VALUES (?,'configured',?)").run(familyId, new Date().toISOString());
  result = await request(`/api/platform/accounts/${familyId}/delete`, { method: 'POST', cookie: admin.cookie, body: { dryRun: true } });
  assert.equal(result.status, 403); assert.equal(result.data.code, 'account_delete_platform');
  const childId = 'reseller_' + randomUUID();
  db.prepare('INSERT INTO resellers VALUES (?,?)').run(childId, JSON.stringify({ name: 'Filha', accountKind: 'business', parentWorkspaceId: target.workspaceId }));
  result = await request(`/api/platform/accounts/${target.workspaceId}/delete`, { method: 'POST', cookie: admin.cookie, body: { dryRun: true } });
  assert.equal(result.status, 409); assert.equal(result.data.code, 'account_delete_has_children');
  result = await request('/api/account/delete', { method: 'POST', cookie: target.cookie, body: { dryRun: true } });
  assert.equal(result.data.code, 'account_delete_has_children');
  db.prepare('DELETE FROM resellers WHERE id=?').run(childId);
  result = await request(`/api/platform/accounts/${target.workspaceId}/delete`, { method: 'POST', cookie: admin.cookie, body: { confirmName: 'Cliente Final', password } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.cookie, '', 'platform deletion keeps the admin session');
  assert.equal(db.prepare('SELECT mode FROM account_deletion_audit WHERE workspace_id=?').get(target.workspaceId).mode, 'platform');
  assert.equal((await request('/api/auth/me', { cookie: target.cookie })).status, 401);
  assert.equal((await request('/api/auth/me', { cookie: admin.cookie })).status, 200);
  fkClean(db);
  // Rate limit: 10 attempts per minute per actor.
  let limited = 0;
  for (let index = 0; index < 11; index++) if ((await request('/api/account/delete', { method: 'POST', cookie: other.cookie, body: { dryRun: true } })).status === 429) limited++;
  assert.ok(limited >= 1);
});

async function bridgeFixture(t, handler, { conversationJournal = false } = {}) {
  const calls = [];
  const pool = { on() {}, async end() {}, async connect() { return { async query(sql, values) { calls.push({ sql, values }); return await handler(sql, values) || { rows: [] }; }, release() {} }; } };
  const store = new Store(':memory:', { conversationJournal }), bridge = new PostgresBridge(store, { pool });
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const deletion = new AccountDeletion(store, { auth, isPlatformAdmin: () => false, stopChannels: async channels => { deletion.stopped = channels; } });
  t.after(async () => { await bridge.close(); store.close(); });
  const session = await auth.register({ name: 'Owner', email: `bridge-${randomUUID()}@example.test`, password, company: 'Bridge Empresa' }, { provision: input => store.provisionReseller(input) });
  const actor = session.actor, tenantId = store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(actor.resellerId).id;
  store.mutate(actor, tenantId, 'Synthetic channel', state => { state.channels = [{ id: 'wa-' + randomUUID(), kind: 'whatsapp_qr', name: 'WA', state: 'disconnected', transport: 'baileys' }]; });
  return { store, bridge, auth, deletion, actor, tenantId, calls };
}

test('PostgreSQL mirror: deletion replaces the pending snapshot with a tombstone drained through delete_workspace_tenant', async t => {
  const f = await bridgeFixture(t, async () => {});
  assert.ok(f.store.db.prepare('SELECT 1 FROM postgres_spool WHERE tenant_id=?').get(f.tenantId));
  const result = await f.deletion.remove(f.actor, f.actor.resellerId, { confirmName: 'Bridge Empresa', password });
  assert.equal(result.deleted, true); assert.equal(f.deletion.stopped.length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM postgres_spool WHERE tenant_id=?').get(f.tenantId).n, 0);
  assert.deepEqual(f.store.db.prepare('SELECT tenant_id,reseller_id FROM postgres_deletion_spool').all().map(row => ({ ...row })), [{ tenant_id: f.tenantId, reseller_id: f.actor.resellerId }]);
  fkClean(f.store.db);
  f.bridge.queue(f.tenantId); // A late queue for a removed company is a no-op.
  assert.equal(f.bridge.status().pending, 0);
  await f.bridge.flush();
  const call = f.calls.find(item => /delete_workspace_tenant/.test(item.sql));
  assert.deepEqual(call.values, [f.actor.resellerId, f.tenantId, f.bridge.sourceId]);
  assert.ok(f.calls.some(item => /set_config/.test(item.sql) && item.values[0] === f.tenantId && item.values[1] === f.actor.resellerId));
  assert.equal(f.bridge.status().pendingDeletions, 0); assert.equal(f.bridge.state, 'synced');
});

test('PostgreSQL mirror: a refused tombstone stays queued and never blocks company snapshots', async t => {
  const f = await bridgeFixture(t, async sql => { if (/delete_workspace_tenant/.test(sql)) throw new Error('function does not exist'); });
  await f.bridge.flush();
  const other = f.store.createTenant({ role: 'reseller', resellerId: 'mep-demo', name: 'QA' }, { name: 'Viva', segment: 'QA' });
  await f.deletion.remove(f.actor, f.actor.resellerId, { confirmName: 'Bridge Empresa', password });
  f.bridge.queue(other.id);
  await f.bridge.flush();
  assert.equal(f.bridge.state, 'deletions_pending');
  assert.equal(f.bridge.status().pending, 0, 'snapshots still drain');
  assert.equal(f.store.db.prepare('SELECT attempts FROM postgres_deletion_spool WHERE tenant_id=?').get(f.tenantId).attempts, 1);
});

test('conversation journal stores are deleted without journal guard violations', async t => {
  const f = await bridgeFixture(t, async () => {}, { conversationJournal: true });
  const dry = await f.deletion.remove(f.actor, f.actor.resellerId, { dryRun: true });
  assert.equal(dry.counts.channels, 1);
  await f.deletion.remove(f.actor, f.actor.resellerId, { confirmName: 'bridge empresa', password });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tenants WHERE id=?').get(f.tenantId).n, 0);
  fkClean(f.store.db);
});

test('SSH tombstone transaction is scoped to self-registered ids and calls the deletion function', () => {
  const tenantId = 'tenant_' + randomUUID(), resellerId = 'reseller_' + randomUUID();
  const sql = deletionTransaction({ tenantId, resellerId, sourceId: 'source-1' });
  assert.match(sql, /^BEGIN;[\s\S]*mepchat_private\.delete_workspace_tenant\([\s\S]*COMMIT;\n$/);
  assert.doesNotMatch(sql, new RegExp(tenantId), 'ids travel base64-encoded');
  assert.throws(() => deletionTransaction({ tenantId: 'playtech-demo', resellerId: 'mep-demo', sourceId: 'source-1' }), TypeError);
});
