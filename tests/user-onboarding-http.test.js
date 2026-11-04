import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { PostgresBridge } from '../src/postgres-bridge.js';

const secret = () => 'Synthetic-' + randomBytes(12).toString('hex');
const invitation = (extra = {}) => ({ requestId: randomBytes(12).toString('hex'), name: 'Pessoa convidada sintética', email: 'invited@example.test', role: 'operator', tenantIds: ['playtech-demo'], permissions: ['inbox.read'], scopeRules: null, ...extra });
const tokenFrom = value => {
  const url = new URL(value);
  assert.equal(url.pathname, '/accept-invite'); assert.equal(url.searchParams.has('token'), false);
  const token = new URLSearchParams(url.hash.slice(1)).get('token'); assert.ok(token); return token;
};
const mailURL = delivery => new URL(delivery.payload.text.match(/https?:\/\/[^\s]+/)[0]);

async function fixture(t, { configured = false } = {}) {
  const key = randomBytes(32), deliveries = [], deny = async () => { throw new Error('External transport denied in synthetic fixture'); };
  const app = createApp({
    databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: deny,
    gatewayOptions: { authKey: key, socketFactory: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' },
    emailOptions: { apiKey: configured ? 'ms_' + randomBytes(24).toString('hex') : '', from: configured ? 'fixture@example.test' : '', key,
      fetchImpl: async (url, options) => {
        deliveries.push({ url, payload: JSON.parse(options.body) });
        return new Response(JSON.stringify({ id: 'synthetic-delivery-' + deliveries.length }), { status: 200 });
      }
    }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]); app.store.close();
  });
  const request = async (path, { cookie = '', method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const setCookie = res.headers.get('set-cookie') || '';
    return { status: res.status, data: await res.json(), setCookie, cookie: setCookie.split(';')[0] };
  };
  const password = secret(), owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Admin sintético', username: 'onboarding.admin', password } });
  assert.equal(owner.status, 200);
  return { app, base, request, owner, password, key, deliveries,
    create: input => request('/api/users/invitations', { cookie: owner.cookie, method: 'POST', body: input }),
    login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } })
  };
}

test('HTTP convite é exclusivo de admin atual e do workspace; token não aparece em listas, dados de empresas ou projeção', async t => {
  const f = await fixture(t), { app, request, owner } = f;
  assert.equal((await request('/api/users/invitations')).status, 401);
  assert.equal((await request('/api/users/invitations', { method: 'POST', body: invitation() })).status, 401);
  const memberPassword = secret(), member = await request('/api/users', { cookie: owner.cookie, method: 'POST', body: { name: 'Operador sintético', username: 'onboarding.operator', password: memberPassword, role: 'operator', tenantIds: ['playtech-demo'] } });
  assert.equal(member.status, 201);
  const signed = await f.login('onboarding.operator', memberPassword);
  assert.equal((await request('/api/users/invitations', { cookie: signed.cookie })).status, 403);
  assert.equal((await request('/api/users/invitations', { cookie: signed.cookie, method: 'POST', body: invitation() })).status, 403);
  const foreign = await request('/api/auth/register', { method: 'POST', body: { fiscalDocument: syntheticFiscalDocument(), name: 'Admin outro workspace', company: 'Outra empresa sintética', email: 'foreign@example.test', password: secret() } });
  assert.equal(foreign.status, 200);
  const foreignTenant = (await request('/api/bootstrap', { cookie: foreign.cookie })).data.tenants[0].id;
  assert.ok([400, 403, 404].includes((await f.create(invitation({ tenantIds: [foreignTenant] }))).status));
  const snapshot = JSON.stringify(app.store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all());
  const outbox = app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n;
  const created = await f.create(invitation({ name: 'PRIVATE_INVITATION_SYNTHETIC' })); assert.equal(created.status, 201);
  const token = tokenFrom(created.data.inviteUrl);
  assert.equal(created.data.invitation.token, undefined); assert.equal(created.data.invitation.token_hash, undefined);
  const listed = await request('/api/users/invitations', { cookie: owner.cookie }); assert.equal(listed.status, 200);
  assert.equal(listed.data.invitations.length, 1); assert.equal(JSON.stringify(listed.data).includes(token), false);
  const foreignList = await request('/api/users/invitations', { cookie: foreign.cookie }); assert.equal(foreignList.data.invitations.length, 0);
  assert.equal((await request('/api/users/invitations/' + created.data.invitation.id + '/revoke', { cookie: foreign.cookie, method: 'POST', body: {} })).status, 404);
  assert.equal(JSON.stringify(app.store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all()), snapshot);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, outbox);
  const bridge = new PostgresBridge(app.store, { enabled: true, execute: async () => {} }); app.store.queuePostgres('playtech-demo');
  const projection = JSON.stringify(app.store.db.prepare('SELECT * FROM postgres_spool').all());
  assert.equal(projection.includes(token), false); assert.equal(projection.includes('PRIVATE_INVITATION_SYNTHETIC'), false); await bridge.close();
});

test('HTTP replay da criação recupera mesmo link e envio de e-mail opt-in é único sem transporte de mensagens', async t => {
  const f = await fixture(t, { configured: true }), input = invitation({ sendEmail: true });
  const first = await f.create(input); assert.equal(first.status, 201); assert.equal(first.data.email.configured, true); assert.equal(first.data.email.queued, true);
  await f.app.email.flush(); const again = await f.create(input); assert.equal(again.status, 201); await f.app.email.flush();
  assert.equal(again.data.inviteUrl, first.data.inviteUrl); assert.equal(again.data.invitation.id, first.data.invitation.id);
  assert.equal(f.deliveries.length, 1); const sentURL = mailURL(f.deliveries[0]);
  assert.equal(sentURL.pathname, '/accept-invite'); assert.equal(sentURL.searchParams.has('token'), false);
  assert.equal(new URLSearchParams(sentURL.hash.slice(1)).get('token'), tokenFrom(first.data.inviteUrl));
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_invitations').get().n, 1);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
  const mismatch = await f.create({ ...input, name: 'Outro destinatário sintético' }); assert.equal(mismatch.status, 409);
  const manual = await f.create(invitation({ email: 'manual@example.test', sendEmail: false })); assert.equal(manual.status, 201);
  await f.app.email.flush(); assert.equal(manual.data.email.queued, false); assert.equal(f.deliveries.length, 1);
});

test('HTTP aceite preserva empresas e permissões definidas pelo admin sem provisionar outra revenda', async t => {
  const f = await fixture(t), beforeWorkspaces = f.app.store.db.prepare('SELECT count(*) n FROM resellers').get().n;
  const created = await f.create(invitation()); assert.equal(created.status, 201); const token = tokenFrom(created.data.inviteUrl);
  const preview = await f.request('/api/auth/invitations/preview', { method: 'POST', body: { token } }); assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.tenantIds, ['playtech-demo']); assert.deepEqual(preview.data.permissions, ['inbox.read']);
  for (const extra of [{ role: 'reseller' }, { tenantIds: ['studio-demo'] }, { email: 'forged@example.test' }]) {
    assert.equal((await f.request('/api/auth/invitations/accept', { method: 'POST', body: { token, name: 'Pessoa sintética', username: 'onboarding.invited', password: secret(), ...extra } })).status, 400);
  }
  const password = secret(), accepted = await f.request('/api/auth/invitations/accept', { method: 'POST', body: { token, name: 'Pessoa sintética', username: 'onboarding.invited', password } });
  assert.equal(accepted.status, 200); assert.ok(accepted.data.user.id); assert.equal(accepted.data.token, undefined);
  assert.match(accepted.setCookie, /HttpOnly; SameSite=Strict/); assert.equal((accepted.setCookie.match(/mep_session=/g) || []).length, 1);
  const boot = await f.request('/api/bootstrap', { cookie: accepted.cookie }); assert.equal(boot.status, 200);
  assert.deepEqual(boot.data.tenants.map(item => item.id), ['playtech-demo']); assert.equal(boot.data.session.platformOwner, false);
  assert.deepEqual(boot.data.session.permissions, ['inbox.read']); assert.equal(boot.data.session.resellerId, 'mep-demo');
  assert.equal((await f.request('/api/tenants/studio-demo', { cookie: accepted.cookie })).status, 403);
  assert.equal((await f.request('/api/users', { cookie: accepted.cookie })).status, 403);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM resellers').get().n, beforeWorkspaces);
  const again = await f.request('/api/auth/invitations/accept', { method: 'POST', body: { token, name: 'Replay', username: 'onboarding.replay', password } }); assert.equal(again.status, 400);
  const listed = (await f.request('/api/users/invitations', { cookie: f.owner.cookie })).data.invitations;
  assert.equal(listed[0].state, 'accepted'); assert.equal((await f.login('onboarding.invited', password)).status, 200);
});

test('HTTP segredo é aceito somente no body; revogar e expirar bloqueia prévia e aceite', async t => {
  const f = await fixture(t), created = await f.create(invitation()); assert.equal(created.status, 201); const token = tokenFrom(created.data.inviteUrl);
  assert.equal((await f.request('/api/auth/invitations/preview?token=' + token, { method: 'POST', body: {} })).status, 400);
  assert.equal((await f.request('/api/auth/invitations/accept?token=' + token, { method: 'POST', body: { name: 'Pessoa', username: 'onboarding.query', password: secret() } })).status, 400);
  const revoked = await f.request('/api/users/invitations/' + created.data.invitation.id + '/revoke', { cookie: f.owner.cookie, method: 'POST', body: {} }); assert.equal(revoked.status, 200); assert.equal(revoked.data.invitation?.state || revoked.data.state, 'revoked');
  assert.equal((await f.request('/api/auth/invitations/preview', { method: 'POST', body: { token } })).status, 400);
  const expires = await f.create(invitation({ email: 'expired@example.test' })); assert.equal(expires.status, 201);
  f.app.store.db.prepare('UPDATE auth_invitations SET expires_at=? WHERE id=?').run(Date.now() - 1, expires.data.invitation.id);
  assert.equal((await f.request('/api/auth/invitations/accept', { method: 'POST', body: { token: tokenFrom(expires.data.inviteUrl), name: 'Pessoa', username: 'onboarding.expired', password: secret() } })).status, 400);
});

test('HTTP logout durante body incompleto impede criação de convite e enfileiramento de e-mail', async t => {
  const f = await fixture(t, { configured: true }), token = f.owner.cookie.split('=')[1], authenticate = f.app.auth.authenticate.bind(f.app.auth);
  let entered; const seen = new Promise(resolve => { entered = resolve; });
  f.app.auth.authenticate = value => { const actor = authenticate(value); if (value === token) entered(); return actor; };
  let pending; const response = new Promise((resolve, reject) => {
    pending = httpRequest(f.base + '/api/users/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: f.owner.cookie, 'Transfer-Encoding': 'chunked' } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    }); pending.on('error', reject); pending.write('{"requestId":');
  });
  await seen; f.app.auth.logout(token);
  const input = invitation({ sendEmail: true }); pending.end(JSON.stringify(input).slice('{"requestId":'.length));
  assert.equal((await response).status, 401); await f.app.email.flush();
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_invitations').get().n, 0);
  assert.equal(f.deliveries.length, 0); assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
});

test('HTTP logout durante body incompleto impede cadastro manual e preserva empresas e vínculos', async t => {
  const f = await fixture(t, { configured: true }), token = f.owner.cookie.split('=')[1], authenticate = f.app.auth.authenticate.bind(f.app.auth);
  const snapshot = () => ({
    users: f.app.store.db.prepare('SELECT id,name,reseller_id,tenant_ids FROM auth_users ORDER BY id').all(),
    tenants: f.app.store.db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all(),
    workspaces: f.app.store.db.prepare('SELECT user_id,reseller_id,created_at FROM auth_workspace_access ORDER BY user_id,reseller_id').all(),
    members: f.app.store.db.prepare('SELECT * FROM team_chat_members ORDER BY reseller_id,tenant_id,room_id,user_id').all(),
    outbox: f.app.store.db.prepare('SELECT id FROM outbound_commands ORDER BY id').all(),
    emails: f.app.store.db.prepare('SELECT id FROM email_outbox ORDER BY id').all()
  }), before = snapshot();
  let entered; const seen = new Promise(resolve => { entered = resolve; });
  f.app.auth.authenticate = value => { const actor = authenticate(value); if (value === token) entered(); return actor; };
  const input = { username: 'onboarding.aborted', name: 'Cadastro manual sintético', email: 'aborted@example.test', password: secret(), role: 'operator', tenantIds: ['playtech-demo'], permissions: ['inbox.read'], scopeRules: null };
  let pending; const response = new Promise((resolve, reject) => {
    pending = httpRequest(f.base + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: f.owner.cookie, 'Transfer-Encoding': 'chunked' } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    }); pending.on('error', reject); pending.write('{"username":');
  });
  await seen; f.app.auth.logout(token); pending.end(JSON.stringify(input).slice('{"username":'.length));
  assert.equal((await response).status, 401); await f.app.email.flush();
  assert.deepEqual(snapshot(), before); assert.equal(f.deliveries.length, 0);
  assert.equal(f.app.store.db.prepare('SELECT 1 FROM auth_users WHERE username=?').get(input.username), undefined);
});

test('HTTP recuperação mantém resposta uniforme para conta conhecida, desconhecida e desativada', async t => {
  const f = await fixture(t, { configured: true }), member = await f.request('/api/users', { cookie: f.owner.cookie, method: 'POST', body: { name: 'Conta de recuperação sintética', username: 'onboarding.recovery', email: 'recovery@example.test', password: secret(), role: 'operator', tenantIds: ['playtech-demo'] } }); assert.equal(member.status, 201);
  const responses = [];
  responses.push(await f.request('/api/auth/password/forgot', { method: 'POST', body: { email: 'recovery@example.test' } }));
  responses.push(await f.request('/api/auth/password/forgot', { method: 'POST', body: { email: 'unknown@example.test' } }));
  f.app.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), member.data.id);
  responses.push(await f.request('/api/auth/password/forgot', { method: 'POST', body: { email: 'recovery@example.test' } }));
  for (const result of responses) { assert.equal(result.status, 200); assert.deepEqual(result.data, { requested: true, configured: true }); assert.equal(result.setCookie, ''); }
  await f.app.email.flush(); assert.equal(f.deliveries.length, 1); const url = mailURL(f.deliveries[0]);
  assert.equal(url.pathname, '/reset-password'); assert.equal(url.searchParams.has('token'), false); assert.ok(new URLSearchParams(url.hash.slice(1)).get('token'));
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_password_resets').get().n, 1);
});

test('HTTP recuperação sem provedor informa indisponibilidade sem criar segredo nem prometer envio', async t => {
  const f = await fixture(t), member = await f.request('/api/users', { cookie: f.owner.cookie, method: 'POST', body: { name: 'Conta sem provedor sintética', username: 'onboarding.noemail', email: 'noemail@example.test', password: secret(), role: 'operator', tenantIds: ['playtech-demo'] } }); assert.equal(member.status, 201);
  for (const email of ['noemail@example.test', 'unknown@example.test']) {
    const result = await f.request('/api/auth/password/forgot', { method: 'POST', body: { email } }); assert.equal(result.status, 200); assert.deepEqual(result.data, { requested: true, configured: false });
  }
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_password_resets').get().n, 0); assert.equal(f.deliveries.length, 0);
});

test('HTTP redefinir por link revoga todas as sessões, não emite cookie e não permite replay', async t => {
  const f = await fixture(t, { configured: true }), password = secret(), member = await f.request('/api/users', { cookie: f.owner.cookie, method: 'POST', body: { name: 'Conta sintética reset', username: 'onboarding.reset', email: 'reset@example.test', password, role: 'operator', tenantIds: ['playtech-demo'] } }); assert.equal(member.status, 201);
  const a = await f.login('onboarding.reset', password), b = await f.login('onboarding.reset', password);
  assert.equal((await f.request('/api/auth/password/forgot', { method: 'POST', body: { email: 'reset@example.test' } })).status, 200); await f.app.email.flush();
  const token = new URLSearchParams(mailURL(f.deliveries[0]).hash.slice(1)).get('token'), next = secret();
  const result = await f.request('/api/auth/password/reset', { method: 'POST', body: { token, password: next } }); assert.equal(result.status, 200); assert.deepEqual(result.data, { reset: true }); assert.equal(result.setCookie, '');
  for (const cookie of [a.cookie, b.cookie]) assert.equal((await f.request('/api/auth/me', { cookie })).status, 401);
  assert.equal((await f.request('/api/auth/password/reset', { method: 'POST', body: { token, password: secret() } })).status, 400);
  assert.equal((await f.login('onboarding.reset', password)).status, 401); assert.equal((await f.login('onboarding.reset', next)).status, 200);
});

test('HTTP senha autenticada mantém sessão atual; lista e revogação não alcançam sessão de outra pessoa', async t => {
  const f = await fixture(t), otherLogin = await f.login('onboarding.admin', f.password);
  assert.equal((await f.request('/api/auth/sessions')).status, 401);
  const list = await f.request('/api/auth/sessions', { cookie: f.owner.cookie }); assert.equal(list.status, 200);
  assert.equal(list.data.sessions.length, 2); assert.equal(list.data.sessions.filter(item => item.current).length, 1);
  assert.equal(JSON.stringify(list.data).includes('token_hash'), false); assert.equal(JSON.stringify(list.data).includes(f.owner.cookie.split('=')[1]), false);
  const bad = await f.request('/api/auth/password/change', { cookie: f.owner.cookie, method: 'POST', body: { currentPassword: secret(), password: secret() } }); assert.equal(bad.status, 401);
  assert.equal((await f.request('/api/auth/me', { cookie: f.owner.cookie })).status, 200);
  const next = secret(), changed = await f.request('/api/auth/password/change', { cookie: f.owner.cookie, method: 'POST', body: { currentPassword: f.password, password: next } }); assert.equal(changed.status, 200); assert.equal(changed.data.changed, true); assert.equal(changed.data.revokedSessions, 1);
  assert.equal((await f.request('/api/auth/me', { cookie: f.owner.cookie })).status, 200); assert.equal((await f.request('/api/auth/me', { cookie: otherLogin.cookie })).status, 401);
  const renewed = await f.login('onboarding.admin', next), sessions = (await f.request('/api/auth/sessions', { cookie: f.owner.cookie })).data.sessions;
  const target = sessions.find(item => !item.current); assert.ok(target);
  const strangerPassword = secret(), stranger = await f.request('/api/users', { cookie: f.owner.cookie, method: 'POST', body: { name: 'Outro usuário sintético', username: 'onboarding.stranger', password: strangerPassword, role: 'operator', tenantIds: ['playtech-demo'] } }); assert.equal(stranger.status, 201);
  const signed = await f.login('onboarding.stranger', strangerPassword);
  assert.equal((await f.request('/api/auth/sessions/' + target.id + '/revoke', { cookie: signed.cookie, method: 'POST', body: {} })).status, 404);
  const revoked = await f.request('/api/auth/sessions/' + target.id + '/revoke', { cookie: f.owner.cookie, method: 'POST', body: {} }); assert.equal(revoked.status, 200); assert.equal(revoked.data.revoked, true); assert.equal(revoked.data.current, false);
  assert.equal((await f.request('/api/auth/me', { cookie: renewed.cookie })).status, 401); assert.equal((await f.request('/api/auth/me', { cookie: f.owner.cookie })).status, 200);
});
