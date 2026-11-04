import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { Auth } from '../src/auth.js';

const syntheticPassword = () => 'Fixture-local-' + randomBytes(12).toString('hex');
function setup(t, options = {}) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  return { db, auth: new Auth(db, options) };
}
const status = code => error => error.status === code;
const ownerInput = password => ({ username: 'Jean.QA', password, name: 'Administrador QA' });

test('primeiro acesso guarda scrypt com salt e sessão opaca somente pelo hash', async t => {
  const { db, auth } = setup(t), password = syntheticPassword();
  assert.deepEqual(auth.status(), { setupRequired: true });
  const session = await auth.setup(ownerInput(password));
  assert.deepEqual(auth.status(), { setupRequired: false });
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.actor.role, 'reseller'); assert.equal(session.actor.resellerId, 'mep-demo');
  const user = db.prepare('SELECT * FROM auth_users').get();
  assert.equal(user.username, 'jean.qa'); assert.equal(user.password_version, 'scrypt-v1');
  assert.equal(Buffer.from(user.password_salt).length, 16); assert.equal(Buffer.from(user.password_hash).length, 64);
  assert.equal(Buffer.from(user.password_hash).includes(Buffer.from(password)), false);
  const persisted = db.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(persisted.token_hash, createHash('sha256').update(session.token).digest('hex'));
  assert.equal(JSON.stringify(persisted).includes(session.token), false);
  assert.deepEqual(new Auth(db).authenticate(session.token), session.actor);
  await assert.rejects(auth.setup(ownerInput(password)), status(409));
  assert.equal(auth.listUsers(session.actor)[0].password_hash, undefined);
});

test('corrida de primeiro acesso permite um único administrador e uma única sessão', async t => {
  const { db, auth } = setup(t), other = new Auth(db);
  const results = await Promise.allSettled([auth.setup(ownerInput(syntheticPassword())), other.setup({ username: 'Outro.QA', name: 'Outro QA', password: syntheticPassword() })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
});

test('setup pode ser desligado e não aceita senha curta sem deixar usuário parcial', async t => {
  const { db, auth } = setup(t, { allowSetup: false });
  await assert.rejects(auth.setup(ownerInput(syntheticPassword())), status(403));
  const enabled = new Auth(db);
  await assert.rejects(enabled.setup(ownerInput('curta')), status(400));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 0);
});

test('login normaliza usuário, rejeita senha errada e aplica backoff sem timer bloqueante', async t => {
  let clock = Date.now();
  const { auth } = setup(t, { now: () => clock }), password = syntheticPassword();
  await auth.setup(ownerInput(password));
  for (let i = 0; i < 3; i++) await assert.rejects(auth.login({ username: 'JEAN.QA', password: syntheticPassword() }), status(401));
  await assert.rejects(auth.login({ username: 'jean.qa', password }), error => error.status === 429 && error.retryAfter >= 1);
  clock += 1001;
  const session = await auth.login({ username: ' Jean.QA ', password });
  assert.equal(auth.authenticate(session.token).name, 'Administrador QA');
  await assert.rejects(auth.login({ username: 'inexistente', password }), error => error.status === 401 && error.message === 'Usuário ou senha incorretos.');
});

test('logout revoga apenas sua sessão e expiração também vale em uma nova instância', async t => {
  let clock = Date.now();
  const { db, auth } = setup(t, { now: () => clock, sessionTtlMs: 1000 }), password = syntheticPassword();
  const first = await auth.setup(ownerInput(password)), second = await auth.login({ username: 'jean.qa', password });
  auth.logout(first.token); auth.logout(first.token); auth.logout('inválido');
  assert.throws(() => auth.authenticate(first.token), status(401));
  assert.equal(auth.authenticate(second.token).userId, first.actor.userId);
  clock += 1000;
  assert.throws(() => new Auth(db, { now: () => clock }).authenticate(second.token), status(401));
});

test('operador mantém múltiplas empresas e não ganha poderes com actor.role forjado', async t => {
  const { auth } = setup(t), owner = await auth.setup(ownerInput(syntheticPassword())), password = syntheticPassword();
  const user = await auth.createUser(owner.actor, { username: 'atendente.qa', name: 'Atendente QA', password, role: 'operator', tenantIds: ['empresa-a', 'empresa-b', 'empresa-a'] });
  assert.deepEqual(user.tenantIds, ['empresa-a', 'empresa-b']);
  assert.equal(user.permissions, null); assert.equal(user.scopeRules, null); assert.equal(user.presence, 'available');
  assert.equal(user.passwordHash, undefined);
  const session = await auth.login({ username: user.username, password });
  assert.deepEqual(session.actor.tenantIds, ['empresa-a', 'empresa-b']); assert.equal(session.actor.tenantId, undefined);
  const forged = { ...session.actor, role: 'reseller' };
  assert.throws(() => auth.listUsers(forged), status(403));
  await assert.rejects(auth.createUser(forged, { username: 'ilegítimo', password: syntheticPassword(), name: 'Inválido', role: 'reseller' }), status(403));
  assert.throws(() => auth.disableUser(forged, owner.actor.userId), status(403));
  await assert.rejects(auth.createUser(owner.actor, { username: 'sem.empresa', password: syntheticPassword(), name: 'QA', role: 'operator', tenantIds: [] }), status(400));
  await assert.rejects(auth.createUser(owner.actor, { username: 'outro', password: syntheticPassword(), name: 'QA', role: 'superuser' }), status(400));
});

test('desativação revoga todas as sessões e bloqueia login; administrador não se desativa', async t => {
  const { auth, db } = setup(t), owner = await auth.setup(ownerInput(syntheticPassword())), password = syntheticPassword();
  const user = await auth.createUser(owner.actor, { username: 'atendente.qa', name: 'Atendente QA', password, role: 'operator', tenantIds: ['empresa-a'] });
  const first = await auth.login({ username: user.username, password }), second = await auth.login({ username: user.username, password });
  assert.equal(first.actor.tenantId, 'empresa-a');
  const disabled = auth.disableUser(owner.actor, user.id); assert.equal(disabled.disabled, true);
  assert.throws(() => auth.authenticate(first.token), status(401)); assert.throws(() => auth.authenticate(second.token), status(401));
  await assert.rejects(auth.login({ username: user.username, password }), status(401));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL').get(user.id).n, 0);
  assert.throws(() => auth.disableUser(owner.actor, owner.actor.userId), status(409));
  assert.equal(auth.authenticate(owner.token).role, 'reseller');
  assert.equal(auth.disableUser(owner.actor, user.id).disabled, true);
});

test('salt muda entre usuários com a mesma senha; duplicatas e admin revogado são bloqueados', async t => {
  const { auth, db } = setup(t), password = syntheticPassword(), owner = await auth.setup(ownerInput(password));
  const other = await auth.createUser(owner.actor, { username: 'segundo.admin', name: 'Segundo QA', password, role: 'reseller' });
  const rows = db.prepare('SELECT password_salt,password_hash FROM auth_users ORDER BY username').all();
  assert.notDeepEqual(rows[0].password_salt, rows[1].password_salt); assert.notDeepEqual(rows[0].password_hash, rows[1].password_hash);
  await assert.rejects(auth.createUser(owner.actor, { username: 'JEAN.QA', name: 'Duplicado', password, role: 'reseller' }), status(409));
  const session = await auth.login({ username: other.username, password });
  assert.throws(() => auth.disableUser(session.actor, owner.actor.userId), status(403));
  assert.throws(() => auth.disableUser(session.actor, session.actor.userId), status(409));
  auth.disableUser(owner.actor, other.id);
  assert.throws(() => auth.listUsers(session.actor), status(403));
  await assert.rejects(auth.createUser(session.actor, { username: 'terceiro', name: 'QA', password, role: 'reseller' }), status(403));
  assert.throws(() => auth.authenticate(session.token), status(401));
  assert.equal(auth.authenticate(owner.token).platformAdmin,true);
});

test('política aceita exatamente oito caracteres com maiúscula Unicode e especial', async t => {
  const { auth, db } = setup(t);
  for (const value of ['abcdefg!', 'Abcdefgh', 'Abcdefg ', 'Ábcdef!', 'Abcdefg1']) {
    await assert.rejects(auth.setup(ownerInput(value)), status(400));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 0);
  const session = await auth.setup(ownerInput('Ábcdefg!'));
  assert.equal(auth.authenticate(session.token).role, 'reseller');
  assert.equal((await auth.login({ username: 'jean.qa', password: 'Ábcdefg!' })).actor.userId, session.actor.userId);
});

test('schema antigo recebe e-mail compatível sem alterar usuários ou sessões existentes', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE auth_users (id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,
    role TEXT NOT NULL,reseller_id TEXT NOT NULL,tenant_ids TEXT NOT NULL,password_salt BLOB NOT NULL,password_hash BLOB NOT NULL,
    password_version TEXT NOT NULL DEFAULT 'scrypt-v1',created_at INTEGER NOT NULL,disabled_at INTEGER);
    INSERT INTO auth_users VALUES ('existing','existing.user','Preserved','reseller','mep-demo','[]',X'00',X'00','scrypt-v1',1,NULL);`);
  const auth = new Auth(db), again = new Auth(db);
  const metadata = again.me({ userId: 'existing', resellerId: 'mep-demo' });
  assert.equal(metadata.email, null); assert.equal(metadata.emailVerified, false);
  assert.equal(metadata.permissions, null); assert.equal(metadata.scopeRules, null); assert.equal(metadata.presence, 'available');
  assert.equal(auth.status().setupRequired, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 1);
  assert.equal(db.prepare('SELECT password_hash FROM auth_users').get().password_hash[0], 0);
});
