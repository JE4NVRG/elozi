import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApp } from '../src/server.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const signup = (email, extra = {}) => ({ fiscalDocument: syntheticFiscalDocument(), name: 'Pessoa sintética', email, company: 'Empresa sintética', password: password(), ...extra });
const denyExternal = async () => { throw new Error('External transport forbidden in fixture'); };
const clientId = 'onboarding-fixture.apps.googleusercontent.com';

const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey); jwk.kid = 'onboarding-fixture';
async function credential(nonce, { sub = 'fixture-google-subject', email = 'google@example.test', ...claims } = {}) {
  return new SignJWT({ nonce, email, email_verified: true, name: 'Google sintético', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://accounts.google.com')
    .setAudience(clientId).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
}

async function fixture(t, options = {}) {
  const key = randomBytes(32), deliveries = [];
  const app = createApp({
    databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: denyExternal, ...options,
    gatewayOptions: { authKey: key, socketFactory: denyExternal },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denyExternal },
    googleOptions: { clientId: '', jwks: createLocalJWKSet({ keys: [jwk] }), ...options.googleOptions },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: async (url, request) => {
      deliveries.push({ url, request, payload: JSON.parse(request.body) });
      return new Response(JSON.stringify({ id: 'fixture-mail-' + deliveries.length }), { status: 200 });
    }, ...options.emailOptions }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie = '', host, origin, headers = {} } = {}) => {
    // Native HTTP keeps the explicit Host so proxy-facing host checks are actually exercised.
    return new Promise((resolve, reject) => {
      const pending = httpRequest(base + path, { method, headers: {
        'Content-Type': 'application/json', Cookie: cookie,
        ...(host ? { Host: host } : {}), ...(origin ? { Origin: origin } : {}), ...headers
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
  };
  return { app, request, key, deliveries };
}

test('servidor cadastra duas revendas isoladas e não aceita identidades ou papéis do cliente', async t => {
  const { app, request } = await fixture(t);
  const first = await request('/api/auth/register', { method: 'POST', body: signup('first@example.test') });
  const second = await request('/api/auth/register', { method: 'POST', body: signup('second@example.test') });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(first.data.token, undefined); assert.match(first.setCookie, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(first.setCookie, /; Secure/);
  const a = await request('/api/bootstrap', { cookie: first.cookie }), b = await request('/api/bootstrap', { cookie: second.cookie });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.session.platformOwner, false); assert.equal(b.data.session.platformOwner, false);
  assert.equal(a.data.tenants.length, 1); assert.equal(b.data.tenants.length, 1);
  assert.notEqual(a.data.tenants[0].id, b.data.tenants[0].id);
  assert.match(a.data.tenants[0].id, /^tenant_/);
  assert.equal((await request(`/api/tenants/${b.data.tenants[0].id}`, { cookie: first.cookie })).status, 404);
  assert.equal((await request('/api/tenants/playtech-demo', { cookie: first.cookie })).status, 404);
  const own = await request(`/api/tenants/${a.data.tenants[0].id}`, { cookie: first.cookie });
  assert.deepEqual(own.data.channels, []); assert.deepEqual(own.data.conversations, []);
  const me = await request('/api/auth/me', { cookie: first.cookie });
  assert.match(me.data.user.resellerId, /^reseller_/); assert.notEqual(me.data.user.resellerId, 'mep-demo');
  assert.equal((await request('/api/users', { cookie: first.cookie })).data.users.length, 1);
  assert.equal((await request('/api/users', { cookie: second.cookie })).data.users[0].id, second.data.session.userId);
  const forbidden = await request('/api/users', { method: 'POST', cookie: first.cookie, body: {
    name: 'Operador', username: 'cross-company', password: password(), role: 'operator', tenantIds: [b.data.tenants[0].id]
  } });
  assert.equal(forbidden.status, 404);
  for (const extra of [{ role: 'operator' }, { resellerId: 'mep-demo' }, { tenantIds: ['playtech-demo'] }, { userId: first.data.session.userId }]) {
    assert.equal((await request('/api/auth/register', { method: 'POST', body: signup('forged@example.test', extra) })).status, 400);
  }
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 2);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM resellers').get().n, 3);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM tenants').get().n, 5);
  assert.equal((await request('/api/auth/status')).data.setupRequired, true);
});

test('host público exige origem HTTPS, entrega cookie Secure e bloqueia setup remoto', async t => {
  assert.throws(() => createApp({ publicOrigin: 'http://onboarding.example.test' }), /HTTPS/);
  assert.throws(() => createApp({ publicOrigin: 'https://onboarding.example.test/path' }), /HTTPS/);
  const publicOrigin = 'https://onboarding.example.test', host = 'onboarding.example.test';
  const { app, request } = await fixture(t, { publicOrigin });
  const status = await request('/api/auth/status', { host });
  assert.equal(status.status, 200); assert.equal(status.data.setupRequired, false);
  const setup = await request('/api/auth/setup', { host, origin: publicOrigin, method: 'POST', body: { name: 'Owner', username: 'remote-owner', password: password() } });
  assert.equal(setup.status, 403);
  for (const origin of ['http://onboarding.example.test', 'https://foreign.example.test']) {
    assert.equal((await request('/api/auth/register', { host, origin, method: 'POST', body: signup('blocked@example.test') })).status, 403);
  }
  assert.equal((await request('/api/auth/register', { host, origin: publicOrigin, method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: signup('blocked@example.test') })).status, 403);
  assert.equal((await request('/api/health', { host: 'foreign.example.test' })).status, 403);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 0);
  const account = await request('/api/auth/register', { host, origin: publicOrigin, method: 'POST', body: signup('public@example.test') });
  assert.equal(account.status, 200); assert.match(account.setCookie, /; Secure/);
  assert.equal((await request('/api/health', { host })).data.mode, 'hosted-pilot');
  const logout = await request('/api/auth/logout', { host, origin: publicOrigin, method: 'POST', body: {}, cookie: account.cookie });
  assert.match(logout.setCookie, /Max-Age=0; Secure/);
  assert.equal((await request('/api/auth/me', { host, cookie: account.cookie })).status, 401);
});

test('integrações são exclusivas do primeiro owner; validação inválida não altera segredo nem configuração', async t => {
  const { app, request, key } = await fixture(t);
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'fixture-owner', password: password() } });
  assert.equal(owner.status, 200);
  const secondPassword = password();
  const other = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Outro admin', username: 'other-admin', password: secondPassword, role: 'reseller' } });
  assert.equal(other.status, 201);
  const sameReseller = await request('/api/auth/login', { method: 'POST', body: { username: 'other-admin', password: secondPassword } });
  const publicAdmin = await request('/api/auth/register', { method: 'POST', body: signup('public-admin@example.test') });
  for (const cookie of [sameReseller.cookie, publicAdmin.cookie]) {
    assert.equal((await request('/api/integrations', { cookie })).status, 403);
    assert.equal((await request('/api/integrations', { cookie, method: 'POST', body: { googleClientId: clientId } })).status, 403);
  }
  assert.equal((await request('/api/bootstrap', { cookie: owner.cookie })).data.session.platformOwner, true);
  assert.equal((await request('/api/bootstrap', { cookie: sameReseller.cookie })).data.session.platformOwner, false);
  assert.equal((await request('/api/integrations', { cookie: owner.cookie })).status, 200);
  const settings = { googleClientId: clientId, emailApiKey: 'ms_' + randomBytes(24).toString('hex'), emailFrom: 'fixture@example.test',commandCodeApiKey:'' };
  const saved = await request('/api/integrations', { cookie: owner.cookie, method: 'POST', body: settings });
  assert.equal(saved.status, 200); assert.equal(saved.data.googleEnabled, true);
  assert.equal(JSON.stringify(saved.data).includes(settings.emailApiKey), false);
  await app.email.flush();
  const blob = Buffer.from(app.store.db.prepare("SELECT payload FROM channel_secrets WHERE channel_id='platform-services'").get().payload);
  assert.equal(blob.includes(Buffer.from(settings.emailApiKey)), false);
  assert.deepEqual(encryptedChannelSecrets(app.store.db, key).get('platform-services'), settings);
  for (const input of [{ ...settings, googleClientId: 'changed-fixture.apps.googleusercontent.com', emailApiKey: 'invalid' }, { ...settings, googleClientId: 'invalid-client' }]) {
    assert.equal((await request('/api/integrations', { cookie: owner.cookie, method: 'POST', body: input })).status, 400);
    assert.equal(app.google.clientId, clientId);
    assert.equal(app.email.status().from, settings.emailFrom);
    assert.deepEqual(encryptedChannelSecrets(app.store.db, key).get('platform-services'), settings);
  }
  const ownerChallenge = await request('/api/auth/me', { cookie: owner.cookie });
  assert.equal(ownerChallenge.data.google.enabled, true);
  assert.match(ownerChallenge.cookie, /^mep_google=/);
  const read = await request('/api/integrations', { cookie: owner.cookie + '; ' + ownerChallenge.cookie });
  assert.equal(read.setCookie, '', 'O refresh de integrações deve preservar o desafio emitido por /me.');
  assert.equal(JSON.stringify(read.data).includes(settings.emailApiKey), false);
  const linked = await request('/api/auth/google/link', { method: 'POST', cookie: owner.cookie + '; ' + (read.cookie || ownerChallenge.cookie), body: {
    credential: await credential(ownerChallenge.data.google.nonce, { sub: 'fixture-owner-google', email: 'owner@example.test' })
  } });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.user.id, owner.data.session.userId);
  assert.equal(linked.data.user.googleLinked, true);
});

test('me e verificação por e-mail usam token vinculado, uso único, expiração e reenvio limitado', async t => {
  const { app, request, deliveries } = await fixture(t, { emailOptions: { apiKey: 'ms_' + randomBytes(24).toString('hex'), from: 'fixture@example.test' } });
  assert.equal((await request('/api/auth/me')).status, 401);
  const first = await request('/api/auth/register', { method: 'POST', body: signup('verify@example.test') });
  await app.email.flush();
  const second = await request('/api/auth/register', { method: 'POST', body: signup('other@example.test') });
  await app.email.flush();
  assert.equal(deliveries.length, 2);
  const tokenFrom = delivery => new URL(delivery.payload.text.match(/http[^\s]+/)[0]).searchParams.get('token');
  const token = tokenFrom(deliveries[0]);
  const row = app.store.db.prepare('SELECT token_hash FROM auth_email_challenges WHERE user_id=?').get(first.data.session.userId);
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  const me = await request('/api/auth/me', { cookie: first.cookie });
  assert.equal(me.data.user.email, 'verify@example.test'); assert.equal(me.data.user.emailVerified, false);
  assert.equal(me.data.user.password_hash, undefined); assert.equal(me.data.user.token_hash, undefined);
  assert.equal((await request('/api/auth/verify-email', { cookie: second.cookie, method: 'POST', body: { token } })).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: first.cookie })).data.user.emailVerified, true);
  assert.equal((await request('/api/auth/me', { cookie: second.cookie })).data.user.emailVerified, false);
  assert.equal((await request('/api/auth/verify-email', { method: 'POST', body: { token } })).status, 400);
  assert.equal((await request('/api/auth/email/resend', { cookie: second.cookie, method: 'POST', body: {} })).status, 200);
  await app.email.flush();
  assert.equal(deliveries.length, 3);
  assert.equal((await request('/api/auth/email/resend', { cookie: second.cookie, method: 'POST', body: {} })).status, 429);
  assert.equal((await request('/api/auth/verify-email', { method: 'POST', body: { token: tokenFrom(deliveries[1]) } })).status, 400);
  app.store.db.prepare('UPDATE auth_email_challenges SET expires_at=? WHERE user_id=? AND consumed_at IS NULL').run(Date.now() - 1, second.data.session.userId);
  assert.equal((await request('/api/auth/verify-email', { method: 'POST', body: { token: tokenFrom(deliveries[2]) } })).status, 400);
  assert.equal((await request('/api/auth/me', { cookie: second.cookie })).data.user.emailVerified, false);
});

test('login Google verdadeiro com JWKS local não concede owner nem aceita replay ou vínculo por e-mail', async t => {
  const { request } = await fixture(t, { googleOptions: { clientId } });
  const challenge = await request('/api/auth/status');
  const jwt = await credential(challenge.data.google.nonce, { role: 'platform-owner', resellerId: 'mep-demo' });
  const login = await request('/api/auth/google', { method: 'POST', cookie: challenge.cookie, body: { fiscalDocument: syntheticFiscalDocument(), credential: jwt, role: 'platform-owner', resellerId: 'mep-demo' } });
  assert.equal(login.status, 200);
  const me = await request('/api/auth/me', { cookie: login.cookie });
  assert.equal(me.data.user.emailVerified, true); assert.equal(me.data.user.googleLinked, true);
  assert.notEqual(me.data.user.resellerId, 'mep-demo');
  assert.equal((await request('/api/bootstrap', { cookie: login.cookie })).data.session.platformOwner, false);
  assert.equal((await request('/api/auth/google', { method: 'POST', cookie: challenge.cookie, body: { credential: jwt } })).status, 401);
  const local = await request('/api/auth/register', { method: 'POST', body: signup('local@example.test') });
  const existingChallenge = await request('/api/auth/status');
  const localJwt = await credential(existingChallenge.data.google.nonce, { sub: 'local-account-subject', email: 'local@example.test' });
  assert.equal((await request('/api/auth/google', { method: 'POST', cookie: existingChallenge.cookie, body: { credential: localJwt } })).status, 409);
  const linkChallenge = await request('/api/auth/me', { cookie: local.cookie });
  const linked = await request('/api/auth/google/link', { method: 'POST', cookie: local.cookie + '; ' + linkChallenge.cookie, body: {
    credential: await credential(linkChallenge.data.google.nonce, { sub: 'local-account-subject', email: 'local@example.test' })
  } });
  assert.equal(linked.status, 200); assert.equal(linked.data.user.id, local.data.session.userId);
  assert.equal(linked.data.user.googleLinked, true); assert.equal(linked.data.user.emailVerified, true);
});

test('HTTP: cadastro fechado recusa nova identidade Google e permite login da identidade já vinculada', async t => {
  const { app, request } = await fixture(t, { allowRegistration: false, googleOptions: { clientId } });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner QA', username: 'closed-owner', password: password() } });
  const link = await request('/api/auth/me', { cookie: owner.cookie });
  const linked = await request('/api/auth/google/link', { method: 'POST', cookie: owner.cookie + '; ' + link.cookie, body: { credential: await credential(link.data.google.nonce, { sub: 'closed-known', email: 'known@example.test' }) } });
  assert.equal(linked.status, 200);
  const counts = () => ['auth_users', 'resellers', 'tenants'].map(table => app.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const before = counts(), unknown = await request('/api/auth/status');
  const denied = await request('/api/auth/google', { method: 'POST', cookie: unknown.cookie, body: { credential: await credential(unknown.data.google.nonce, { sub: 'closed-unknown', email: 'unknown@example.test' }) } });
  assert.equal(denied.status, 403); assert.match(denied.data.error, /cadastro está fechado/); assert.deepEqual(counts(), before);
  const known = await request('/api/auth/status');
  const login = await request('/api/auth/google', { method: 'POST', cookie: known.cookie, body: { credential: await credential(known.data.google.nonce, { sub: 'closed-known', email: 'changed@example.test' }) } });
  assert.equal(login.status, 200); assert.equal(login.data.session.userId, owner.data.session.userId); assert.deepEqual(counts(), before);
});

test('cadastro público padrão não oferece teste, exige documento nem aceita prazo forjado', async t => {
  const { app, request } = await fixture(t);
  const status = (await request('/api/auth/status')).data;
  assert.equal(status.registrationEnabled, true); assert.equal(status.publicTrial, null);
  const signed = await request('/api/auth/register', { method: 'POST', body: signup('no-trial@example.test', {
    fiscalDocument: undefined, publicTrialEnabled: true,
    onboardingTrial: { startsAt: '2026-10-04T00:00:00.000Z', expiresAt: '2026-10-11T00:00:00.000Z' }
  }) });
  assert.equal(signed.status, 200, signed.data.error);
  const boot = (await request('/api/bootstrap', { cookie: signed.cookie })).data;
  assert.equal(boot.accountOnboarding.publicTrialEnabled, false);
  assert.equal(boot.accountOnboarding.lifecycle.state, 'active');
  assert.equal(boot.accountOnboarding.lifecycle.trialExpiresAt, null);
  assert.equal(boot.accountOnboarding.documentRegistered, false);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM signup_trial_registrations').get().n, 0);
  const stored = JSON.parse(app.store.db.prepare('SELECT data FROM resellers WHERE id=?').get(boot.reseller.id).data);
  assert.equal(Object.hasOwn(stored, 'commercialLifecycle'), false);
});

test('primeiro cadastro Google com oferta desativada não cria prazo ou reserva fiscal', async t => {
  const { app, request } = await fixture(t, { googleOptions: { clientId } });
  const challenge = await request('/api/auth/status');
  assert.equal(challenge.data.publicTrial, null);
  const signed = await request('/api/auth/google', { method: 'POST', cookie: challenge.cookie, body: {
    credential: await credential(challenge.data.google.nonce, { sub: 'google-without-trial', email: 'no-google-trial@example.test' })
  } });
  assert.equal(signed.status, 200, signed.data.error);
  const boot = (await request('/api/bootstrap', { cookie: signed.cookie })).data;
  assert.equal(boot.accountOnboarding.publicTrialEnabled, false);
  assert.equal(boot.accountOnboarding.lifecycle.state, 'active');
  assert.equal(boot.accountOnboarding.lifecycle.trialExpiresAt, null);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM signup_trial_registrations').get().n, 0);
});

test('configuração da oferta pública não aceita string como booleano verdadeiro', () => {
  assert.throws(() => createApp({ databasePath: ':memory:', publicTrialEnabled: 'false' }), /booleana/);
});

test('teste público exige documento, reserva uma vez e publica somente status da própria conta', async t => {
  const { app, request } = await fixture(t, { publicTrialEnabled: true }), fiscalDocument = syntheticFiscalDocument();
  assert.deepEqual((await request('/api/auth/status')).data.publicTrial, { days: 7, documentRequired: true });
  const missing = await request('/api/auth/register', { method: 'POST', body: signup('missing-doc@example.test', { fiscalDocument: undefined }) });
  assert.equal(missing.status, 400);
  const before = app.store.db.prepare('SELECT count(*) n FROM resellers').get().n;
  const signed = await request('/api/auth/register', { method: 'POST', body: signup('first-doc@example.test', { fiscalDocument }) });
  assert.equal(signed.status, 200, signed.data.error);
  const boot = await request('/api/bootstrap', { cookie: signed.cookie }), onboarding = boot.data.accountOnboarding;
  assert.equal(onboarding.documentRegistered, true); assert.equal(onboarding.lifecycle.state, 'trial');
  const stored = JSON.parse(app.store.db.prepare('SELECT data FROM resellers WHERE id=?').get(boot.data.reseller.id).data).commercialLifecycle;
  assert.equal(Date.parse(stored.trialExpiresAt) - Date.parse(stored.changedAt), 7 * 86400000);
  assert.equal(onboarding.lifecycle.daysRemaining, 7); assert.equal(onboarding.lifecycle.trialExpired, false);
  assert.equal((await request('/api/accounts')).status, 401);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM signup_trial_registrations').get().n, 1);
  const formatted = fiscalDocument.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  const duplicate = await request('/api/auth/register', { method: 'POST', body: signup('second-doc@example.test', { fiscalDocument: formatted }) });
  assert.equal(duplicate.status, 409); assert.match(duplicate.data.error, /já iniciou/);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM resellers').get().n, before + 1);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, 1);
  const payload = JSON.stringify(boot.data), registry = app.store.db.prepare('SELECT * FROM signup_trial_registrations').get();
  assert.ok(!payload.includes(fiscalDocument)); assert.ok(!payload.includes(registry.identity_digest));
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT data FROM resellers').all()).includes(fiscalDocument));
  assert.equal(boot.data.reseller.commercialLifecycle, undefined);
  const operator = await request('/api/users', { method: 'POST', cookie: signed.cookie, body: { name: 'Atendente QA', username: 'operator.trial', password: password(), role: 'operator', tenantIds: [boot.data.tenants[0].id] } });
  assert.equal(operator.status, 201, operator.data.error);
  // Resolve the actual operator through Auth without exporting a test credential.
  const row = app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(operator.data.id), operatorSession = app.auth.session(row);
  assert.equal((await request('/api/bootstrap', { cookie: 'mep_session=' + operatorSession.token })).data.accountOnboarding, null);
});
