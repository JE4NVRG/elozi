import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/server.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const signup = (email, extra = {}) => ({ fiscalDocument: syntheticFiscalDocument(), name: 'Pessoa sintética', email, company: 'Empresa sintética', password: password(), ...extra });
const status = code => error => error.status === code;
const rejected = error => Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
const denyExternal = async () => { throw new Error('External transport forbidden in fixture'); };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';

async function fixture(t) {
  const key = randomBytes(32);
  const app = createApp({
    databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: denyExternal,
    gatewayOptions: { authKey: key, socketFactory: denyExternal },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denyExternal },
    googleOptions: { clientId: '' },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: denyExternal }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '', workspace } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: {
      'Content-Type': 'application/json', Cookie: cookie,
      ...(workspace === undefined ? {} : { 'X-Elozi-Workspace': workspace })
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try {
          const setCookie = (response.headers['set-cookie'] || []).join(', ');
          resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), setCookie, cookie: setCookie.split(';')[0] });
        } catch (error) { reject(error); }
      });
    });
    pending.on('error', reject); pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, db: app.store.db, request };
}

function identity(db, userId) {
  const row = db.prepare('SELECT * FROM auth_users WHERE id=?').get(userId);
  return { userId, expectedEmail: row.email, expectedResellerId: row.reseller_id, workspaceId: 'mep-demo' };
}
function user(db, id) { return db.prepare('SELECT * FROM auth_users WHERE id=?').get(id); }
function sessions(db, id) { return db.prepare('SELECT * FROM auth_sessions WHERE user_id=? ORDER BY token_hash').all(id); }
function token(account) { return account.cookie.slice('mep_session='.length); }
function without(row, fields) { return Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key))); }

test('cadastro público não forja administrador da plataforma nem vínculos; setup privado cria o primeiro', async t => {
  const { db, request } = await fixture(t);
  const publicAccount = await request('/api/auth/register', { method: 'POST', body: signup('public@example.test') });
  assert.equal(publicAccount.status, 200);
  assert.equal(user(db, publicAccount.data.session.userId).platform_admin, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 0);
  for (const extra of [
    { platformAdmin: true }, { platform_admin: 1 }, { workspaceId: 'mep-demo' },
    { workspaceIds: ['mep-demo'] }, { workspaces: ['mep-demo'] }, { workspaceAccess: ['mep-demo'] }
  ]) {
    const result = await request('/api/auth/register', { method: 'POST', body: signup('forged@example.test', extra) });
    assert.equal(result.status, 400);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 0);
  assert.equal((await request('/api/auth/status')).data.setupRequired, true);
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'private.owner', password: password() } });
  assert.equal(owner.status, 200);
  assert.equal(user(db, owner.data.session.userId).platform_admin, 1);
  assert.equal((await request('/api/bootstrap', { cookie: owner.cookie })).data.session.platformOwner, true);
  assert.equal((await request('/api/bootstrap', { cookie: publicAccount.cookie })).data.session.platformOwner, false);
  assert.equal((await request('/api/auth/status')).data.setupRequired, false);
  assert.throws(() => db.prepare('UPDATE auth_users SET platform_admin=1 WHERE id=?').run(publicAccount.data.session.userId), /UNIQUE constraint/);
  assert.throws(() => db.prepare('UPDATE auth_users SET platform_admin=2 WHERE id=?').run(publicAccount.data.session.userId), /CHECK constraint/);
});

test('promoção privada preserva revenda pública, credenciais e cookie; o mesmo login abre o workspace fundador', async t => {
  const { app, db, request } = await fixture(t);
  const input = signup('founder@example.test');
  const account = await request('/api/auth/register', { method: 'POST', body: input });
  assert.equal(account.status, 200); assert.match(account.setCookie, /HttpOnly; SameSite=Strict/);
  const userId = account.data.session.userId, before = user(db, userId), activeSessions = sessions(db, userId);
  const publicReseller = db.prepare('SELECT * FROM resellers WHERE id=?').get(before.reseller_id);
  const publicTenants = db.prepare('SELECT * FROM tenants WHERE reseller_id=? ORDER BY id').all(before.reseller_id);
  assert.equal((await request('/api/auth/promote-first-platform-admin', { method: 'POST', cookie: account.cookie, body: identity(db, userId) })).status, 404);
  assert.equal(user(db, userId).platform_admin, 0);
  await app.auth.promoteFirstPlatformAdmin(identity(db, userId));
  const promoted = user(db, userId);
  assert.equal(promoted.platform_admin, 1);
  assert.deepEqual(without(promoted, ['platform_admin']), without(before, ['platform_admin']));
  assert.deepEqual(sessions(db, userId), activeSessions);
  assert.deepEqual(db.prepare('SELECT * FROM resellers WHERE id=?').get(before.reseller_id), publicReseller);
  assert.deepEqual(db.prepare('SELECT * FROM tenants WHERE reseller_id=? ORDER BY id').all(before.reseller_id), publicTenants);
  assert.deepEqual(db.prepare('SELECT reseller_id FROM auth_workspace_access WHERE user_id=?').all(userId).map(row => row.reseller_id), ['mep-demo']);
  const actor = app.auth.authenticate(token(account));
  assert.equal(actor.resellerId, before.reseller_id); assert.equal(actor.platformAdmin, true);
  assert.equal(app.auth.workspaceActor(actor).resellerId, 'mep-demo');
  const bootstrap = await request('/api/bootstrap', { cookie: account.cookie });
  assert.equal(bootstrap.status, 200); assert.equal(bootstrap.data.session.userId, userId);
  assert.equal(bootstrap.data.session.resellerId, 'mep-demo'); assert.equal(bootstrap.data.session.platformOwner, true);
  assert.deepEqual(bootstrap.data.tenants.map(tenant => tenant.id).sort(), ['loja-demo', 'playtech-demo', 'studio-demo']);
  const workspaces = await request('/api/workspaces', { cookie: account.cookie });
  assert.equal(workspaces.status, 200); assert.equal(workspaces.data.currentResellerId, 'mep-demo');
  assert.deepEqual(workspaces.data.workspaces.map(workspace => workspace.id).sort(), [before.reseller_id, 'mep-demo'].sort());
  assert.equal(workspaces.data.workspaces.find(workspace => workspace.id === 'mep-demo').platformWorkspace, true);
  assert.deepEqual(bootstrap.data.workspaces, workspaces.data.workspaces);
  const own = await request('/api/bootstrap', { cookie: account.cookie, workspace: before.reseller_id });
  assert.equal(own.status, 200); assert.equal(own.data.session.resellerId, before.reseller_id);
  assert.equal(own.data.session.platformOwner, true);
  assert.deepEqual(own.data.tenants.map(tenant => tenant.id), publicTenants.map(tenant => tenant.id));
  const me = await request('/api/auth/me', { cookie: account.cookie });
  assert.equal(me.data.user.resellerId, before.reseller_id); assert.equal(me.data.user.platformAdmin, true);
  const login = await request('/api/auth/login', { method: 'POST', body: { email: input.email, password: input.password } });
  assert.equal(login.status, 200); assert.equal(login.data.session.userId, userId);
  assert.equal((await request('/api/bootstrap', { cookie: login.cookie })).data.session.resellerId, 'mep-demo');
});

test('promoção exige identidade conferida, conta ativa administradora e workspace existente sem alteração parcial', async t => {
  const { app, db, request } = await fixture(t);
  const account = await request('/api/auth/register', { method: 'POST', body: signup('guarded@example.test') });
  const userId = account.data.session.userId, expected = identity(db, userId), original = user(db, userId);
  for (const changed of [
    { userId: 'absent-user' }, { expectedEmail: 'different@example.test' },
    { expectedResellerId: 'mep-demo' }, { workspaceId: 'absent-workspace' }
  ]) {
    await assert.rejects(Promise.resolve().then(() => app.auth.promoteFirstPlatformAdmin({ ...expected, ...changed })), rejected);
    assert.deepEqual(user(db, userId), original);
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 0);
  }
  for (const change of [{ role: 'operator' }, { disabled_at: Date.now() }]) {
    const [field, value] = Object.entries(change)[0];
    db.prepare(`UPDATE auth_users SET ${field}=? WHERE id=?`).run(value, userId);
    const changed = user(db, userId);
    await assert.rejects(Promise.resolve().then(() => app.auth.promoteFirstPlatformAdmin(expected)), rejected);
    assert.deepEqual(user(db, userId), changed);
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 0);
    db.prepare(`UPDATE auth_users SET ${field}=? WHERE id=?`).run(original[field], userId);
  }
  await app.auth.promoteFirstPlatformAdmin(expected);
  await assert.rejects(Promise.resolve().then(() => app.auth.promoteFirstPlatformAdmin(expected)), status(409));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users WHERE platform_admin=1').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 1);
});

test('duas promoções concorrentes elegem um primeiro administrador e a unicidade resiste fora do helper', async t => {
  const { app, db, request } = await fixture(t);
  const first = await request('/api/auth/register', { method: 'POST', body: signup('race-one@example.test') });
  const second = await request('/api/auth/register', { method: 'POST', body: signup('race-two@example.test') });
  const otherAuth = new Auth(db);
  const candidates = [first.data.session.userId, second.data.session.userId];
  const results = await Promise.allSettled(candidates.map((id, index) => Promise.resolve().then(() => (index ? otherAuth : app.auth).promoteFirstPlatformAdmin(identity(db, id)))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users WHERE platform_admin=1').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 1);
  const loser = candidates.find(id => user(db, id).platform_admin === 0);
  assert.throws(() => db.prepare('UPDATE auth_users SET platform_admin=1 WHERE id=?').run(loser), /UNIQUE constraint/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access WHERE user_id=?').get(loser).n, 0);
  assert.equal(app.auth.workspaceActor(app.auth.authenticate(token(loser === candidates[0] ? first : second))).resellerId, user(db, loser).reseller_id);
});

test('cabeçalho de workspace respeita vínculo e flag atuais, inclusive diante de actor forjado ou permissão revogada', async t => {
  const { app, db, request } = await fixture(t);
  const founder = await request('/api/auth/register', { method: 'POST', body: signup('scoped-founder@example.test') });
  const ordinary = await request('/api/auth/register', { method: 'POST', body: signup('ordinary@example.test') });
  await app.auth.promoteFirstPlatformAdmin(identity(db, founder.data.session.userId));
  const ordinaryId = ordinary.data.session.userId, ordinaryRow = user(db, ordinaryId);
  const ordinaryActor = app.auth.authenticate(token(ordinary)), founderActor = app.auth.authenticate(token(founder));
  assert.equal((await request('/api/bootstrap', { cookie: ordinary.cookie, workspace: ordinaryRow.reseller_id })).status, 200);
  assert.equal((await request('/api/bootstrap', { cookie: ordinary.cookie, workspace: 'mep-demo' })).status, 403);
  assert.equal((await request('/api/bootstrap', { cookie: ordinary.cookie, workspace: user(db, founder.data.session.userId).reseller_id })).status, 403);
  assert.equal((await request('/api/bootstrap', { cookie: founder.cookie, workspace: ordinaryRow.reseller_id })).status, 403);
  assert.throws(() => app.auth.currentActor({ ...ordinaryActor, resellerId: 'mep-demo', platformAdmin: true }), status(403));
  assert.throws(() => app.auth.workspaceActor({ ...ordinaryActor, platformAdmin: true }, 'mep-demo'), status(403));
  db.prepare('INSERT INTO auth_workspace_access(user_id,reseller_id,created_at) VALUES (?,?,?)').run(ordinaryId, 'mep-demo', Date.now());
  assert.equal((await request('/api/bootstrap', { cookie: ordinary.cookie, workspace: 'mep-demo' })).status, 403);
  assert.deepEqual(app.auth.workspaces(ordinaryActor).map(workspace => workspace.id), [ordinaryRow.reseller_id]);
  assert.throws(() => app.auth.listUsers({ ...ordinaryActor, resellerId: 'mep-demo', platformAdmin: true }), status(403));
  const founderScope = app.auth.workspaceActor(founderActor, 'mep-demo');
  db.prepare('DELETE FROM auth_workspace_access WHERE user_id=?').run(founder.data.session.userId);
  assert.equal((await request('/api/bootstrap', { cookie: founder.cookie, workspace: 'mep-demo' })).status, 403);
  assert.throws(() => app.auth.currentActor(founderScope), status(403));
  assert.throws(() => app.auth.listUsers(founderScope), status(403));
  const fallback = await request('/api/bootstrap', { cookie: founder.cookie });
  assert.equal(fallback.status, 200); assert.equal(fallback.data.session.resellerId, founderActor.resellerId);
  assert.equal(fallback.data.session.platformOwner, true);
});

test('equipe criada pelo administrador promovido pertence ao workspace selecionado e operador não administra integrações', async t => {
  const { app, db, request } = await fixture(t);
  const account = await request('/api/auth/register', { method: 'POST', body: signup('team-founder@example.test') });
  const ownerId = account.data.session.userId, originalResellerId = user(db, ownerId).reseller_id;
  await app.auth.promoteFirstPlatformAdmin(identity(db, ownerId));
  const secret = password();
  const created = await request('/api/users', { method: 'POST', cookie: account.cookie, body: {
    name: 'Operador fundador', username: 'founder.operator', password: secret, role: 'operator', tenantIds: ['playtech-demo']
  } });
  assert.equal(created.status, 201); assert.equal(created.data.resellerId, 'mep-demo');
  assert.equal(user(db, created.data.id).platform_admin, 0);
  const team = await request('/api/users', { cookie: account.cookie });
  assert.equal(team.status, 200);
  assert.deepEqual(team.data.users.map(member => member.id).sort(), [ownerId, created.data.id].sort());
  assert.equal(team.data.users.find(member => member.id === ownerId).platformAdmin, true);
  assert.equal(team.data.users.find(member => member.id === ownerId).resellerId, originalResellerId);
  const ownTeam = await request('/api/users', { cookie: account.cookie, workspace: originalResellerId });
  assert.equal(ownTeam.status, 200); assert.deepEqual(ownTeam.data.users.map(member => member.id), [ownerId]);
  assert.equal((await request('/api/users', { method: 'POST', cookie: account.cookie, workspace: originalResellerId, body: {
    name: 'Empresa indevida', username: 'foreign.operator', password: password(), role: 'operator', tenantIds: ['playtech-demo']
  } })).status, 404);
  const login = await request('/api/auth/login', { method: 'POST', body: { username: 'founder.operator', password: secret } });
  assert.equal(login.status, 200);
  const operatorBootstrap = await request('/api/bootstrap', { cookie: login.cookie });
  assert.equal(operatorBootstrap.status, 200); assert.equal(operatorBootstrap.data.session.resellerId, 'mep-demo');
  assert.equal(operatorBootstrap.data.session.platformOwner, false);
  assert.deepEqual(operatorBootstrap.data.tenants.map(tenant => tenant.id), ['playtech-demo']);
  assert.equal((await request('/api/integrations', { cookie: login.cookie })).status, 403);
  assert.equal((await request('/api/integrations', { cookie: login.cookie, method: 'POST', body: { googleClientId: 'fixture.apps.googleusercontent.com' } })).status, 403);
  assert.equal((await request('/api/users', { cookie: login.cookie })).status, 403);
  assert.equal((await request('/api/integrations', { cookie: account.cookie })).status, 200);
  assert.equal((await request('/api/integrations', { cookie: account.cookie, workspace: originalResellerId })).status, 200);
});

test('PATCH de perfil preserva identidade, permissões, senha e sessão e rejeita injeção sem edição parcial', async t => {
  const { app, db, request } = await fixture(t);
  assert.equal((await request('/api/auth/me', { method: 'PATCH', body: { name: 'Sem sessão' } })).status, 401);
  const input = signup('profile@example.test');
  const account = await request('/api/auth/register', { method: 'POST', body: input });
  const userId = account.data.session.userId, original = user(db, userId), activeSessions = sessions(db, userId);
  const edited = await request('/api/auth/me', { method: 'PATCH', cookie: account.cookie, body: {
    name: ' Perfil sintético ', phone: ' +55 (11) 99999-9999 ', bio: ' Bio sintética ', avatar: png
  } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.user.name, 'Perfil sintético'); assert.equal(edited.data.user.phone, '+55 (11) 99999-9999');
  assert.equal(edited.data.user.bio, 'Bio sintética'); assert.equal(edited.data.user.avatar, png);
  assert.equal(edited.data.user.role, 'reseller'); assert.equal(edited.data.user.resellerId, original.reseller_id);
  assert.equal(edited.data.user.platformAdmin, false); assert.equal(edited.data.user.password_hash, undefined);
  const allowed = ['name', 'phone', 'bio', 'avatar'];
  assert.deepEqual(without(user(db, userId), allowed), without(original, allowed));
  assert.deepEqual(sessions(db, userId), activeSessions);
  const partial = await request('/api/auth/me', { method: 'PATCH', cookie: account.cookie, body: { name: 'Renomeado' } });
  assert.equal(partial.status, 200); assert.equal(partial.data.user.avatar, png); assert.equal(partial.data.user.bio, 'Bio sintética');
  const saved = user(db, userId);
  for (const fields of [
    { role: 'reseller' }, { platformAdmin: true }, { platform_admin: 1 }, { resellerId: 'mep-demo' },
    { reseller_id: 'mep-demo' }, { tenantIds: ['playtech-demo'] }, { workspaceId: 'mep-demo' },
    { email: 'different@example.test' }, { password: password() }, { username: 'changed.user' },
    { userId: 'other-user' }, { id: 'other-user' }, JSON.parse('{"__proto__":{"platformAdmin":true}}')
  ]) {
    const result = await request('/api/auth/me', { method: 'PATCH', cookie: account.cookie, body: { name: 'Não salvar', ...fields } });
    assert.equal(result.status, 400);
    assert.deepEqual(user(db, userId), saved);
  }
  assert.deepEqual(sessions(db, userId), activeSessions);
  assert.equal(app.auth.authenticate(token(account)).userId, userId);
  const bootstrap = await request('/api/bootstrap', { cookie: account.cookie });
  assert.equal(bootstrap.status, 200); assert.equal(bootstrap.data.session.name, 'Renomeado');
  assert.equal(bootstrap.data.session.platformOwner, false); assert.equal(bootstrap.data.session.resellerId, original.reseller_id);
  const me = await request('/api/auth/me', { cookie: account.cookie });
  assert.equal(me.status, 200); assert.equal(me.data.user.email, input.email); assert.equal(me.data.user.avatar, png);
  const login = await request('/api/auth/login', { method: 'POST', body: { email: input.email, password: input.password } });
  assert.equal(login.status, 200); assert.equal(login.data.session.userId, userId);
});

test('migração legada marca apenas o primeiro administrador de mep-demo e não concede novamente ao reiniciar', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('reseller','operator')), reseller_id TEXT NOT NULL,
    tenant_ids TEXT NOT NULL, password_salt BLOB NOT NULL, password_hash BLOB NOT NULL,
    password_version TEXT NOT NULL DEFAULT 'scrypt-v1', created_at INTEGER NOT NULL, disabled_at INTEGER
  );`);
  const insert = db.prepare('INSERT INTO auth_users(id,username,name,role,reseller_id,tenant_ids,password_salt,password_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const [id, role, resellerId, createdAt] of [
    ['public-first', 'reseller', 'reseller-public', 10], ['operator-first', 'operator', 'mep-demo', 20],
    ['legacy-founder', 'reseller', 'mep-demo', 30], ['legacy-second', 'reseller', 'mep-demo', 40]
  ]) insert.run(id, id, id, role, resellerId, '[]', randomBytes(16), randomBytes(64), createdAt);
  new Auth(db);
  assert.deepEqual(db.prepare('SELECT id FROM auth_users WHERE platform_admin=1').all().map(row => row.id), ['legacy-founder']);
  assert.equal(user(db, 'public-first').platform_admin, 0); assert.equal(user(db, 'operator-first').platform_admin, 0);
  assert.equal(user(db, 'legacy-second').platform_admin, 0);
  new Auth(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users WHERE platform_admin=1').get().n, 1);
  db.prepare('UPDATE auth_users SET platform_admin=0 WHERE id=?').run('legacy-founder');
  const restarted = new Auth(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users WHERE platform_admin=1').get().n, 0);
  assert.equal(restarted.status().setupRequired, true);
});
