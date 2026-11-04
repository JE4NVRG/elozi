import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { Auth } from '../src/auth.js';

const status = code => error => error.status === code;
const secret = () => 'Synthetic-' + randomBytes(12).toString('hex');
const google = (sub, email) => ({ sub, email, email_verified: true, name: 'Google sintético' });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const auth = new Auth(db);
  const provision = () => {};
  const register = (email, password = secret()) => auth.register({ name: 'Pessoa sintética', company: 'Empresa sintética', email, password }, { provision });
  return { db, auth, provision, register };
}

test('vínculo autenticado de Google diferente preserva conta, autoridade, senha e sessões', async t => {
  const { db, auth } = fixture(t), password = secret();
  const local = await auth.setup({ name: 'Admin sintético', username: 'owner.google', email: 'principal@example.com', password });
  const before = db.prepare('SELECT * FROM auth_users WHERE id=?').get(local.actor.userId);
  const sessions = db.prepare('SELECT * FROM auth_sessions').all();
  const linked = auth.linkGoogle(local.actor,google('verified-person',' GOOGLE@EXAMPLE.COM '));
  const after = db.prepare('SELECT * FROM auth_users WHERE id=?').get(local.actor.userId);
  assert.deepEqual(after,before);
  assert.equal(linked.id,local.actor.userId); assert.equal(linked.email,'principal@example.com');
  assert.equal(linked.emailVerified,false); assert.equal(linked.googleLinked,true);
  assert.equal(linked.platformAdmin,true); assert.equal(linked.role,'reseller');
  assert.deepEqual(db.prepare('SELECT * FROM auth_sessions').all(),sessions);
  assert.deepEqual(auth.authenticate(local.token),local.actor);
  assert.equal((await auth.login({email:'principal@example.com',password})).actor.userId,linked.id);
  assert.equal((await auth.googleLogin(google('verified-person','changed-google@example.com'))).actor.userId,linked.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);
  assert.equal(db.prepare('SELECT email FROM auth_google_identities').get().email,'google@example.com');
});

test('alias Google não pode pertencer a outra conta nem ser usado por novo cadastro', async t => {
  const { db, auth, register, provision } = fixture(t);
  const first = await register('first@example.com'), second = await register('second@example.com');
  const before = db.prepare('SELECT count(*) AS n FROM auth_google_identities').get().n;
  assert.throws(()=>auth.linkGoogle(first.actor,google('first-sub',' SECOND@EXAMPLE.COM ')),status(409));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_google_identities').get().n,before);
  auth.linkGoogle(first.actor,google('first-sub','alias@example.com'));
  assert.throws(()=>auth.linkGoogle(second.actor,google('second-sub','ALIAS@example.com')),status(409));
  await assert.rejects(register(' ALIAS@EXAMPLE.COM '),status(409));
  await assert.rejects(auth.googleLogin(google('different-sub','alias@example.com'),{provision}),status(409));
  await assert.rejects(auth.createUser(second.actor,{name:'Duplicata',username:'alias.duplicate',email:'alias@example.com',password:secret(),role:'reseller'}),status(409));
  assert.equal(auth.me(second.actor).googleLinked,false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,2);
});

test('subject vinculado permanece único e a prova inválida não altera nenhuma conta', async t => {
  const { db, auth, register } = fixture(t);
  const first = await register('first@example.com'), second = await register('second@example.com');
  auth.linkGoogle(first.actor,google('first-sub','alias@example.com'));
  const before = db.prepare('SELECT * FROM auth_google_identities').all();
  assert.throws(()=>auth.linkGoogle(second.actor,google('first-sub','free@example.com')),status(409));
  assert.throws(()=>auth.linkGoogle(first.actor,google('replacement-sub','free@example.com')),status(409));
  assert.throws(()=>auth.linkGoogle(first.actor,{...google('first-sub','free@example.com'),email_verified:false}),status(401));
  assert.throws(()=>auth.linkGoogle({...first.actor,resellerId:second.actor.resellerId},google('first-sub','free@example.com')),status(403));
  assert.deepEqual(db.prepare('SELECT * FROM auth_google_identities').all(),before);
  auth.linkGoogle(first.actor,google('first-sub','alias@example.com'));
  assert.deepEqual(db.prepare('SELECT * FROM auth_google_identities').all(),before);
});

test('migração do vínculo legado preserva reservas, conta e idempotência', async t => {
  const { db, auth, register } = fixture(t);
  const local = await register('legacy@example.com');
  auth.linkGoogle(local.actor,google('legacy-sub','legacy@example.com'));
  const before = db.prepare('SELECT * FROM auth_users').all();
  db.exec('DROP INDEX auth_google_email; ALTER TABLE auth_google_identities DROP COLUMN email');
  const restored = new Auth(db);
  assert.deepEqual(db.prepare('SELECT * FROM auth_users').all(),before);
  assert.equal(db.prepare('SELECT email FROM auth_google_identities').get().email,'legacy@example.com');
  new Auth(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_google_identities').get().n,1);
  assert.equal(restored.authenticate(local.token).userId,local.actor.userId);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
