import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { Auth } from '../src/auth.js';

const secret = () => 'Synthetic-' + randomBytes(12).toString('hex');
const status = code => error => error.status === code;
const registration = (email, password = secret()) => ({ name: 'Pessoa sintética', email, company: 'Empresa sintética', password });
const profile = (sub, email) => ({ sub, email, email_verified: true, name: 'Google sintético' });
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE provisioned_resellers(id TEXT PRIMARY KEY,name TEXT,email TEXT); CREATE TABLE provisioned_tenants(id TEXT PRIMARY KEY,reseller_id TEXT REFERENCES provisioned_resellers(id));');
  t.after(() => db.close());
  const provision = ({ resellerId, tenantId, name, email }) => {
    db.prepare('INSERT INTO provisioned_resellers VALUES (?,?,?)').run(resellerId, name, email);
    db.prepare('INSERT INTO provisioned_tenants VALUES (?,?)').run(tenantId, resellerId);
  };
  return { db, auth: new Auth(db, options), provision };
}

test('cadastro fechado impede criação via Google e preserva login previamente vinculado', async t => {
  const { db, auth, provision } = fixture(t);
  const existing = await auth.googleLogin(profile('known-subject', 'known@example.test'), { provision });
  const before = { users: db.prepare('SELECT count(*) AS n FROM auth_users').get().n, workspaces: db.prepare('SELECT count(*) AS n FROM provisioned_resellers').get().n, sessions: db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n };
  await assert.rejects(auth.googleLogin(profile('unknown-subject', 'unknown@example.test'), { provision, allowRegistration: false }), status(403));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, before.users);
  assert.equal(db.prepare('SELECT count(*) AS n FROM provisioned_resellers').get().n, before.workspaces);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, before.sessions);
  const returned = await auth.googleLogin(profile('known-subject', 'changed@example.test'), { provision, allowRegistration: false });
  assert.equal(returned.actor.userId, existing.actor.userId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, before.users);
});

test('cadastros públicos criam revendas isoladas e login global por e-mail normalizado', async t => {
  const { db, auth, provision } = fixture(t), password = secret();
  const first = await auth.register(registration(' FIRST@EXAMPLE.COM ', password), { provision });
  const second = await auth.register(registration('second@example.com'), { provision });
  assert.notEqual(first.actor.resellerId, second.actor.resellerId);
  assert.match(first.actor.resellerId, /^reseller_/); assert.notEqual(first.actor.resellerId, 'mep-demo');
  assert.equal(first.actor.email, 'first@example.com'); assert.equal(first.actor.emailVerified, false);
  assert.equal(auth.status().setupRequired, true);
  assert.equal(auth.listUsers(first.actor).length, 1); assert.equal(auth.listUsers(second.actor).length, 1);
  const member = await auth.createUser(first.actor, { name: 'Operador', username: 'isolated.user', password, role: 'operator', tenantIds: ['own-tenant'], email: 'operator@example.com' });
  assert.equal(member.resellerId, first.actor.resellerId);
  assert.equal((await auth.login({ username: ' FIRST@EXAMPLE.COM ', password })).actor.userId, first.actor.userId);
  assert.equal(new Auth(db).authenticate(second.token).resellerId, second.actor.resellerId);
  assert.throws(() => auth.listUsers({ ...first.actor, resellerId: second.actor.resellerId }), status(403));
  assert.throws(() => auth.me({ ...first.actor, resellerId: second.actor.resellerId }), status(403));
  assert.throws(() => auth.disableUser(first.actor, second.actor.userId), status(404));
  const operator = await auth.login({ username: member.username, password });
  assert.throws(() => auth.listUsers({ ...operator.actor, role: 'reseller' }), status(403));
  const owner = await auth.setup({ name: 'Owner sintético', username: 'platform.owner', password });
  assert.equal(owner.actor.resellerId, 'mep-demo'); assert.equal(auth.status().setupRequired, false);
  await assert.rejects(auth.setup({ name: 'Outra', username: 'other.owner', password }), status(409));
});

test('campos de privilégios e dados inválidos não provisionam revenda', async t => {
  const { db, auth, provision } = fixture(t);
  for (const fields of [{ resellerId: 'mep-demo' }, { tenantIds: ['foreign'] }, { role: 'reseller' }, { company: 'x'.repeat(81) }, { email: 'bad\n@example.com' }, { email: 'bad.@example.com' }, { name: '' }]) {
    await assert.rejects(auth.register({ ...registration('valid@example.com'), ...fields }, { provision }), status(400));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM provisioned_resellers').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 0);
});

test('duplicata concorrente e falha de provisionamento fazem rollback sem órfãos', async t => {
  const { db, auth, provision } = fixture(t);
  const results = await Promise.allSettled([auth.register(registration('race@example.com'), { provision }), auth.register(registration('RACE@example.com'), { provision })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(auth.register(registration('rollback@example.com'), { provision: context => { provision(context); throw new Error('Synthetic failure'); } }), /Synthetic failure/);
  await assert.rejects(auth.register(registration('async@example.com'), { provision: async context => provision(context) }), status(500));
  assert.equal(db.prepare('SELECT count(*) AS n FROM provisioned_resellers').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM provisioned_tenants').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
});

test('Google exige perfil verificado e subject estável; não usa e-mail para relogar', async t => {
  const { db, auth, provision } = fixture(t);
  for (const value of [{ ...profile('subject-a', 'google@example.com'), email_verified: false }, { ...profile('subject-a', 'google@example.com'), email_verified: 'true' }, profile('', 'google@example.com'), profile('x'.repeat(256), 'google@example.com')]) await assert.rejects(auth.googleLogin(value, { provision }), status(401));
  const google = await auth.googleLogin(profile('subject-a', 'google@example.com'), { provision });
  assert.equal(google.actor.emailVerified, true); assert.notEqual(google.actor.resellerId, 'mep-demo');
  assert.equal(auth.status().setupRequired, true);
  const row = db.prepare('SELECT * FROM auth_users WHERE id=?').get(google.actor.userId);
  assert.equal(row.password_version, 'google-only'); assert.equal(Buffer.from(row.password_hash).length, 64);
  await assert.rejects(auth.login({ email: row.email, password: secret() }), status(401));
  const same = await auth.googleLogin(profile('subject-a', 'changed@example.com'));
  assert.equal(same.actor.userId, google.actor.userId); assert.equal(same.actor.email, 'google@example.com');
  await assert.rejects(auth.googleLogin(profile('different-subject', 'google@example.com'), { provision }), status(409));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_google_identities').get().n, 1);
});

test('Google não vincula conta local automaticamente e prova do mesmo e-mail verifica a conta', async t => {
  const { db, auth, provision } = fixture(t), password = secret();
  const local = await auth.register(registration('local@example.com', password), { provision });
  await assert.rejects(auth.googleLogin(profile('local-sub', 'LOCAL@example.com'), { provision }), error => error.status === 409 && /senha/.test(error.message));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_google_identities').get().n, 0);
  assert.throws(() => auth.linkGoogle({ ...local.actor, resellerId: 'mep-demo' }, profile('local-sub', 'local@example.com')), status(403));
  const linked = auth.linkGoogle(local.actor, profile('local-sub', 'local@example.com'));
  assert.equal(linked.emailVerified, true); assert.equal(linked.googleLinked, true);
  assert.equal(auth.linkGoogle(local.actor, profile('local-sub', 'local@example.com')).id, linked.id);
  assert.throws(() => auth.linkGoogle(local.actor, profile('another-sub', 'local@example.com')), status(409));
  assert.equal((await auth.googleLogin(profile('local-sub', 'changed@example.com'))).actor.userId, linked.id);
  assert.equal((await auth.login({ email: 'local@example.com', password })).actor.userId, linked.id);
});

test('vínculo preenche e-mail ausente, preserva unicidade e desativação revoga Google', async t => {
  const { db, auth, provision } = fixture(t), password = secret();
  const owner = await auth.setup({ name: 'Owner', username: 'owner.fixture', password });
  const local = await auth.createUser(owner.actor, { name: 'Pessoa', username: 'blank.email', password, role: 'reseller' });
  const session = await auth.login({ username: local.username, password });
  const foreign = await auth.googleLogin(profile('foreign-sub', 'foreign@example.com'), { provision });
  assert.throws(() => auth.linkGoogle(session.actor, profile('foreign-sub', 'foreign@example.com')), status(409));
  assert.equal(auth.me(session.actor).email, null);
  const linked = auth.linkGoogle(session.actor, profile('local-sub', 'new@example.com'));
  assert.equal(linked.email, 'new@example.com');
  const challenge = auth.emailChallenge(local.id);
  auth.disableUser(owner.actor, local.id);
  assert.throws(() => auth.consumeEmailChallenge(challenge), status(400));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_email_challenges WHERE user_id=? AND consumed_at IS NULL').get(local.id).n, 0);
  await assert.rejects(auth.googleLogin(profile('local-sub', 'new@example.com')), status(401));
  assert.throws(() => auth.authenticate(session.token), status(401));
  assert.throws(() => auth.linkGoogle(session.actor, profile('local-sub', 'new@example.com')), status(403));
  assert.equal(auth.authenticate(foreign.token).email, 'foreign@example.com');
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL').get(local.id).n, 0);
});

test('e-mail é único globalmente, inclusive entre administradores de revendas distintas', async t => {
  const { auth, provision } = fixture(t), password = secret();
  const first = await auth.register(registration('unique@example.com'), { provision });
  const second = await auth.register(registration('other@example.com'), { provision });
  await assert.rejects(auth.createUser(second.actor, { name: 'Duplicata', username: 'duplicate.email', password, role: 'reseller', email: 'UNIQUE@example.com' }), status(409));
  await auth.createUser(first.actor, { name: 'Outro admin', username: 'global.username', password, role: 'reseller' });
  await assert.rejects(auth.createUser(second.actor, { name: 'Duplicata', username: 'GLOBAL.USERNAME', password, role: 'reseller' }), status(409));
});

test('verificação tem hash somente, uso único, validade de uma hora e vínculo ao e-mail original', async t => {
  let clock = Date.now();
  const { db, auth, provision } = fixture(t, { now: () => clock });
  const first = await auth.register(registration('verify@example.com'), { provision });
  const second = await auth.register(registration('other@example.com'), { provision });
  const raw = auth.emailChallenge(first.actor.userId);
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  const stored = db.prepare('SELECT * FROM auth_email_challenges').get();
  assert.equal(stored.token_hash, createHash('sha256').update(raw).digest('hex'));
  assert.equal(stored.expires_at - stored.created_at, 3600000); assert.equal(JSON.stringify(stored).includes(raw), false);
  assert.equal(auth.consumeEmailChallenge(raw).emailVerified, true);
  assert.equal(auth.me(second.actor).emailVerified, false);
  assert.throws(() => auth.consumeEmailChallenge(raw), status(400));
  const expired = auth.emailChallenge(second.actor.userId); clock += 3600000;
  assert.throws(() => auth.consumeEmailChallenge(expired), status(400));
  const replaced = auth.emailChallenge(second.actor.userId), current = auth.emailChallenge(second.actor.userId);
  assert.throws(() => auth.consumeEmailChallenge(replaced), status(400));
  db.prepare('UPDATE auth_users SET email=? WHERE id=?').run('changed@example.com', second.actor.userId);
  assert.throws(() => auth.consumeEmailChallenge(current), status(400));
  assert.equal(auth.me(second.actor).emailVerified, false);
  assert.throws(() => auth.emailChallenge(second.actor.userId, 'reset-password'), status(400));
  assert.equal(auth.me(first.actor).token_hash, undefined);
});
