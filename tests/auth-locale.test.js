import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { EmailService } from '../src/email.js';
import { createApp } from '../src/server.js';

const status = value => error => error.status === value;
function decrypt(db, key, id) {
  const blob = Buffer.from(db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(id).payload), cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  cipher.setAAD(Buffer.from(`elozi:email:${id}`)); cipher.setAuthTag(blob.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]).toString());
}

test('preferência pessoal valida dois idiomas e preserva credenciais, sessões e demais pessoas', t => {
  const db = new DatabaseSync(':memory:'), auth = new Auth(db); t.after(() => db.close());
  const one = auth.insertUser({ username: 'locale.one', name: 'Nome literal Usuário' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'workspace-one');
  const two = auth.insertUser({ username: 'locale.two', name: 'Outro literal' }, Buffer.alloc(16, 2), Buffer.alloc(64, 2), 'reseller', [], 'workspace-two');
  const actor = auth.actor(one), before = db.prepare('SELECT * FROM auth_users WHERE id=?').get(one.id), other = db.prepare('SELECT * FROM auth_users WHERE id=?').get(two.id);
  assert.equal(auth.me(actor).locale, 'pt-BR'); assert.equal(actor.locale, 'pt-BR');
  const updated = auth.updateProfile(actor, { locale: 'en' }); assert.equal(updated.locale, 'en'); assert.equal(updated.name, one.name);
  assert.equal(auth.actor(db.prepare('SELECT * FROM auth_users WHERE id=?').get(one.id)).locale, 'en');
  const after = db.prepare('SELECT * FROM auth_users WHERE id=?').get(one.id); assert.deepEqual({ ...after, locale: before.locale }, { ...before });
  assert.deepEqual(db.prepare('SELECT * FROM auth_users WHERE id=?').get(two.id), other); assert.equal(db.prepare('SELECT count(*) n FROM auth_sessions').get().n, 0);
  for (const locale of ['en-US', 'pt', 'es', 'EN', '', null, true, {}, ['en']]) assert.throws(() => auth.updateProfile(actor, { name: 'Não gravar', locale }), status(400));
  assert.equal(auth.me(actor).name, one.name); assert.equal(auth.updateProfile(actor, { locale: 'pt-BR' }).locale, 'pt-BR');
});

test('GET/PATCHme e bootstrap refletem idioma sem nova senha, sessão ou mudança de empresa', async t => {
  const key = randomBytes(32), deny = async () => assert.fail('Teste de idioma não autoriza transporte externo');
  const app = createApp({ databasePath: ':memory:', serviceKey: key, emailOptions: { apiKey: '', from: '', key, fetchImpl: deny }, googleOptions: { jwks: deny }, providerCall: deny, telegramOptions: { polling: false, authKey: key, fetchImpl: deny }, gatewayOptions: { authKey: key, socketFactory: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.meta.close(), app.webchat.close(), app.bridge.close()]); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, request = async (path, { method = 'GET', body, cookie = '', origin } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = await request('/api/auth/setup', { method: 'POST', body: { username: 'locale.synthetic', name: 'Usuário não traduzido', password: 'Synthetic-locale-4567' } }); assert.equal(owner.status, 200);
  const before = await request('/api/auth/me', { cookie: owner.cookie }); assert.equal(before.data.user.locale, 'pt-BR');
  const sessions = app.store.db.prepare('SELECT * FROM auth_sessions').all();
  const changed = await request('/api/auth/me', { method: 'PATCH', cookie: owner.cookie, body: { locale: 'en' } }); assert.equal(changed.status, 200); assert.equal(changed.data.user.locale, 'en');
  assert.equal((await request('/api/auth/me', { cookie: owner.cookie })).data.user.locale, 'en');
  const boot = await request('/api/bootstrap', { cookie: owner.cookie }); assert.equal(boot.data.session.locale, 'en'); assert.equal(boot.data.session.name, 'Usuário não traduzido');
  assert.deepEqual(app.store.db.prepare('SELECT * FROM auth_sessions').all(), sessions);
  assert.equal((await request('/api/auth/me', { method: 'PATCH', body: { locale: 'en' } })).status, 401);
  assert.equal((await request('/api/auth/me', { method: 'PATCH', cookie: owner.cookie, origin: 'https://foreign.invalid', body: { locale: 'pt-BR' } })).status, 403);
  assert.equal((await request('/api/auth/me', { method: 'PATCH', cookie: owner.cookie, body: { locale: 'en-US', role: 'operator' } })).status, 400);
  assert.equal((await request('/api/auth/me', { cookie: owner.cookie })).data.user.locale, 'en');
});

test('e-mails PT/EN usam preferência do usuário ou origem do convite sem alterar token/idempotência', async t => {
  const db = new DatabaseSync(':memory:'), key = randomBytes(32), service = new EmailService(db, { key, fetchImpl: async () => assert.fail('Nenhum e-mail real autorizado') });
  t.after(async () => { await service.close(); db.close(); });
  db.exec("CREATE TABLE auth_users(id TEXT PRIMARY KEY,locale TEXT); CREATE TABLE auth_invitations(id TEXT PRIMARY KEY,creator_id TEXT); INSERT INTO auth_users VALUES('user-en','en'),('user-pt','pt-BR'); INSERT INTO auth_invitations VALUES('inv-en','user-en'),('inv-pt','user-pt');");
  const tokens = ['VerificationSyntheticEN123456', 'VerificationSyntheticPT123456', 'InvitationSyntheticEN123456', 'InvitationSyntheticPT123456', 'PasswordSyntheticEN123456', 'PasswordSyntheticPT123456'];
  const cases = [
    ['verification', () => service.enqueueVerification({ userId: 'user-en', email: 'en@example.test', name: 'Nome <Usuário>', token: tokens[0] }), 'Confirm your email'],
    ['verification', () => service.enqueueVerification({ userId: 'user-pt', email: 'pt@example.test', name: 'Nome <Usuário>', token: tokens[1] }), 'Confirme seu e-mail'],
    ['invitation', () => service.enqueueInvitation({ invitationId: 'inv-en', email: 'en@example.test', name: 'Nome <Usuário>', workspaceName: 'Empresa Português', token: tokens[2], expiresAt: '2026-10-06T12:00:00Z' }), 'Your invitation to Elozi'],
    ['invitation', () => service.enqueueInvitation({ invitationId: 'inv-pt', email: 'pt@example.test', name: 'Nome <Usuário>', workspaceName: 'Empresa Português', token: tokens[3], expiresAt: '2026-10-06T12:00:00Z' }), 'Seu convite para a Elozi'],
    ['password_reset', () => service.enqueuePasswordReset({ userId: 'user-en', email: 'en@example.test', name: 'Nome <Usuário>', token: tokens[4], expiresAt: '2026-10-06T12:00:00Z' }), 'Reset your Elozi password'],
    ['password_reset', () => service.enqueuePasswordReset({ userId: 'user-pt', email: 'pt@example.test', name: 'Nome <Usuário>', token: tokens[5], expiresAt: '2026-10-06T12:00:00Z' }), 'Redefina sua senha da Elozi']
  ];
  for (let index = 0; index < cases.length; index++) {
    const [kind, enqueue, title] = cases[index], first = await enqueue(), repeated = await enqueue(), payload = decrypt(db, key, first.id);
    assert.equal(first.id, repeated.id); assert.match(payload.subject, new RegExp(title)); assert.ok(payload.text.includes(tokens[index])); assert.ok(payload.text.includes('Nome <Usuário>')); assert.ok(payload.html.includes('Nome &lt;Usuário&gt;')); assert.equal(payload.html.includes('<Usuário>'), false);
    if (kind === 'invitation') assert.ok(payload.text.includes('Empresa Português'));
    assert.equal(db.prepare('SELECT kind FROM email_outbox WHERE id=?').get(first.id).kind, kind);
  }
  const input = { userId: 'user-en', email: 'en@example.test', name: 'Nome <Usuário>', token: tokens[0] };
  const prior = await service.enqueueVerification(input), replay = await service.enqueueVerification({ ...input, locale: 'pt-BR' }); assert.equal(prior.id, replay.id); assert.match(decrypt(db, key, replay.id).subject, /Confirm your email/);
  for (const locale of ['es', '', 'en-US', null, {}, ['en']]) await assert.rejects(service.enqueueVerification({ ...input, token: 'DifferentSynthetic123456', locale }), status(400));
  assert.equal(db.prepare('SELECT count(*) n FROM email_outbox').get().n, 6); assert.equal((await service.flush()).pending, 6);
});
