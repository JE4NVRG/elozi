import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { WebchatIdentity } from '../src/webchat-identity.js';

const code = expected => failure => failure.code === expected && !failure.message.includes('eyJ');
const issuer = 'https://mepmail.example.test';
function fixture(t) {
  const store = new Store(':memory:'), admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'synthetic-owner', name: 'Admin sintético' }, authority = { reauthorize: () => admin };
  const tenant = store.createTenant(admin, { name: 'Identidade sintética', segment: 'QA' }), other = store.createTenant(admin, { name: 'Outra empresa sintética', segment: 'QA' });
  for (const current of [tenant, other]) store.mutate(admin, current.id, 'Fixture identidade', state => { state.channels = [{ id: current.id === tenant.id ? 'site' : 'other-site', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', webchat: { version: 1, enabled: true, origins: [issuer], unrelated: { preserved: true } } }]; });
  const secrets = encryptedChannelSecrets(store.db, Buffer.alloc(32, 71)); secrets.set('site', { legacy: 'synthetic-existing-channel-value', settings: { keep: true } });
  let now = Date.parse('2026-10-09T12:00:00Z');
  const channelContext = ({ actor, tenantId, channelId, origin }) => {
    const state = store.tenant(actor ?? admin, tenantId), channel = state.channels.find(value => value.id === channelId);
    return { tenant: state, channel, ...(origin === undefined ? {} : { origin }) };
  };
  const options = { secrets, channelContext, now: () => now }, identity = new WebchatIdentity(store, options);
  t.after(() => store.close());
  const configure = (extra = {}) => identity.configure(admin, tenant.id, 'site', { version: identity.status(admin, tenant.id, 'site', {}, authority).version, enabled: true, issuer, externalIdPrefix: 'mepmail', ...extra }, authority);
  configure(); const key = identity.createKey(admin, tenant.id, 'site', { version: 1 }, authority);
  const claims = extra => ({ iss: issuer, aud: 'elozi:webchat:site', sub: 'mepmail-user-id', email: 'Owner@Example.test', email_verified: true, name: 'Pessoa sintética', locale: 'pt-BR', iat: Math.floor(now / 1000) - 1, exp: Math.floor(now / 1000) + 599, jti: randomUUID(), ctx: { teamId: 'team-safe', teamName: 'Time de teste', plan: 'Developer', mailboxes: 2 }, ...extra });
  const token = (extra = {}, { signingKey = key.secret, kid = key.kid, header, payload } = {}) => {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid, ...header })).toString('base64url'), body = Buffer.from(payload ?? JSON.stringify(claims(extra))).toString('base64url');
    return `${head}.${body}.${createHmac('sha256', signingKey).update(`${head}.${body}`).digest('base64url')}`;
  };
  const verify = identityToken => identity.verifyAndConsume({ tenantId: tenant.id, channelId: 'site', origin: issuer, identityToken });
  return { store, admin, authority, tenant, other, identity, secrets, options, key, token, verify, claims, configure, now: () => now, advance: ms => { now += ms; }, context: { tenantId: tenant.id, channelId: 'site', origin: issuer } };
}

test('JWT HS256 liga id externo estável, verifica e-mail e limita contexto a dados públicos', t => {
  const f = fixture(t), result = f.verify(f.token());
  assert.equal(result.externalId, 'mepmail:mepmail-user-id'); assert.equal(result.verified, true); assert.equal(result.email, 'owner@example.test'); assert.equal(result.email_verified, true);
  assert.equal(result.name, 'Pessoa sintética'); assert.equal(result.locale, 'pt-BR'); assert.deepEqual(result.ctx, { teamId: 'team-safe', teamName: 'Time de teste', plan: 'Developer', mailboxes: 2 });
  assert.equal(result.kid, f.key.kid); assert.match(result.jtiHash, /^[a-f0-9]{64}$/); assert.equal(result.identityVersion, 1); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.ctx));
  assert.equal(result.identityToken, undefined); assert.equal(result.secret, undefined);
});

test('token ausente é visitante e não consome replay nem consulta segredos', t => {
  const f = fixture(t);
  for (const identityToken of [undefined, null, '']) assert.equal(f.identity.verifyAndConsume({ ...f.context, identityToken }), null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM webchat_identity_jti').get().n, 0);
});

test('assinatura, algoritmo e kid não admitem troca de chave ou conteúdo', t => {
  const f = fixture(t);
  for (const token of [f.token({}, { signingKey: 'synthetic-wrong-secret' }), f.token({}, { header: { alg: 'none' } }), f.token({}, { header: { alg: 'HS384' } }), f.token({}, { header: { jku: 'https://attacker.example.test/key' } }), f.token({}, { header: { typ: 'OTHER' } }), 'not-a-jwt']) assert.throws(() => f.verify(token), code('identity_invalid'));
  assert.throws(() => f.verify(f.token({}, { kid: 'unknown-key' })), code('identity_revoked'));
  const token = f.token(), parts = token.split('.'); parts[1] = Buffer.from(JSON.stringify(f.claims({ sub: 'other-user' }))).toString('base64url'); assert.throws(() => f.verify(parts.join('.')), code('identity_invalid'));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM webchat_identity_jti').get().n, 0);
});

test('issuer/audience/email/locale/contexto e campos obrigatórios são estritos', t => {
  const f = fixture(t);
  for (const patch of [{ iss: issuer + '/' }, { iss: 'https://other.example.test' }, { aud: 'elozi:webchat:other-site' }, { aud: ['elozi:webchat:site'] }, { sub: '' }, { email_verified: false }, { email: 'not-an-email' }, { name: 'Nome\nInjetado' }, { locale: 'fr' }, { jti: 'short' }, { ctx: { password: 'never-store-this' } }, { ctx: { mailboxes: -1 } }, { ctx: { teamName: 'x'.repeat(161) } }, { email_verified: undefined }, { exp: undefined }, { unknown: 'never-store-this' }]) assert.throws(() => f.verify(f.token(patch)), code('identity_invalid'));
  const serialized = JSON.stringify(f.store.db.prepare('SELECT * FROM webchat_identity_jti').all()); assert.equal(serialized.includes('never-store'), false); assert.equal(f.store.db.prepare('SELECT count(*) n FROM webchat_identity_jti').get().n, 0);
});

test('datas exigem <=10 min e tolerância de60s sem ampliar TTL nem aceitar emissão futura', t => {
  const f = fixture(t), now = Math.floor(f.now() / 1000);
  assert.throws(() => f.verify(f.token({ iat: now - 661, exp: now - 61 })), code('identity_expired'));
  for (const patch of [{ iat: now + 61, exp: now + 661 }, { iat: now, exp: now + 601 }, { iat: now, exp: now }, { iat: now + 0.5, exp: now + 60 }, { iat: -1, exp: 1 }]) assert.throws(() => f.verify(f.token(patch)), code('identity_invalid'));
  const tolerated = f.verify(f.token({ iat: now - 659, exp: now - 59 }));
  assert.equal(tolerated.expiresAt, (now - 59) * 1000); f.identity.bindSession('tolerated-session', tolerated, f.context); assert.equal(f.identity.sessionIdentity('tolerated-session', f.context).verified, true);
  assert.equal(f.verify(f.token({ iat: now + 60, exp: now + 660 })).verified, true);
});

test('jti persiste entre instâncias e replay não cria novo vínculo', t => {
  const f = fixture(t), token = f.token(), first = f.verify(token);
  assert.throws(() => f.verify(token), code('identity_replay'));
  const restarted = new WebchatIdentity(f.store, f.options); assert.throws(() => restarted.verifyAndConsume({ ...f.context, identityToken: token }), code('identity_replay'));
  f.identity.bindSession('first-session', first, f.context); assert.throws(() => f.identity.bindSession('second-session', first, f.context), code('identity_replay'));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM webchat_identity_sessions').get().n, 1);
});

test('origem exata e tenant/canal são isolados antes de consumir token', t => {
  const f = fixture(t), token = f.token();
  for (const origin of ['https://attacker.example.test', issuer + '/', issuer + '/support', 'null', 'https://user:password@mepmail.example.test']) assert.throws(() => f.identity.verifyAndConsume({ ...f.context, origin, identityToken: token }), code('identity_origin_denied'));
  assert.throws(() => f.identity.verifyAndConsume({ ...f.context, tenantId: f.other.id, identityToken: token }), code('identity_invalid'));
  assert.throws(() => f.identity.verifyAndConsume({ ...f.context, channelId: 'other-site', identityToken: token }), code('identity_invalid'));
  assert.equal(f.verify(token).verified, true, 'negações não consomem o token da origem certa');
});

test('segredo aparece só na criação e permanece cifrado fora do tenantJSON/DTO/audit', t => {
  const f = fixture(t), status = f.identity.status(f.admin, f.tenant.id, 'site', {}, f.authority), envelope = f.secrets.get('site');
  assert.match(f.key.secret, /^[A-Za-z0-9_-]{43}$/); assert.equal(status.secret, undefined); assert.equal(envelope.legacy, 'synthetic-existing-channel-value'); assert.deepEqual(envelope.settings, { keep: true });
  assert.equal(envelope.webchatIdentity.keys[0].secret, f.key.secret);
  const tenant = f.store.tenant(f.admin, f.tenant.id); assert.equal(tenant.channels[0].webchat.unrelated.preserved, true);
  for (const value of [status, tenant, f.store.db.prepare('SELECT * FROM audit').all()]) assert.equal(JSON.stringify(value).includes(f.key.secret), false);
  const payload = f.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get('site').payload; assert.equal(Buffer.from(payload).includes(Buffer.from(f.key.secret)), false);
  const revoked = f.identity.revokeKey(f.admin, f.tenant.id, 'site', { version: status.version, kid: f.key.kid }, f.authority); assert.equal(revoked.secret, undefined); assert.equal(f.secrets.get('site').webchatIdentity.keys[0].secret, undefined);
});

test('rotação mantém2chaves por <=11min sem invalidar identidadeVersion e revogação corta sessões', t => {
  const f = fixture(t), first = f.verify(f.token()); f.identity.bindSession('old-key-session', first, f.context);
  const rotated = f.identity.rotateKey(f.admin, f.tenant.id, 'site', { version: f.key.version }, f.authority);
  assert.equal(rotated.identityVersion, f.key.identityVersion); assert.equal(rotated.keys.filter(key => key.state === 'active').length, 2); assert.equal(rotated.keys.find(key => key.kid === f.key.kid).validUntil, f.now() + 660_000);
  assert.equal(f.verify(f.token()).verified, true); const fresh = f.verify(f.token({}, { signingKey: rotated.secret, kid: rotated.kid })); f.identity.bindSession('new-key-session', fresh, f.context);
  assert.equal(f.identity.sessionIdentity('old-key-session', f.context).verified, true);
  assert.throws(() => f.identity.rotateKey(f.admin, f.tenant.id, 'site', { version: rotated.version }, f.authority), code('identity_rotation_pending'));
  const revoked = f.identity.revokeKey(f.admin, f.tenant.id, 'site', { version: rotated.version, kid: f.key.kid }, f.authority);
  assert.throws(() => f.identity.sessionIdentity('old-key-session', f.context), code('identity_revoked')); assert.equal(f.identity.sessionIdentity('new-key-session', f.context).verified, true);
  assert.throws(() => f.verify(f.token()), code('identity_revoked')); assert.equal(revoked.secret, undefined);
});

test('chave anterior expira no limite e não recebe extensão por outra rotação', t => {
  const f = fixture(t), rotated = f.identity.rotateKey(f.admin, f.tenant.id, 'site', { version: f.key.version }, f.authority);
  f.advance(660_000); assert.throws(() => f.verify(f.token()), code('identity_revoked'));
  const next = f.identity.rotateKey(f.admin, f.tenant.id, 'site', { version: rotated.version }, f.authority); assert.equal(next.keys.find(key => key.kid === f.key.kid).validUntil, rotated.keys.find(key => key.kid === f.key.kid).validUntil); assert.equal(next.keys.filter(key => key.state === 'active').length, 2);
});

test('binding requer proof interno, escopo e token consumido; logout afeta somente sessão própria', t => {
  const f = fixture(t), one = f.verify(f.token()), two = f.verify(f.token());
  assert.throws(() => f.identity.bindSession('forged-session', { ...one }, f.context), code('identity_invalid'));
  assert.throws(() => f.identity.bindSession('outside-session', one, { ...f.context, channelId: 'other-site' }), code('identity_invalid'));
  f.identity.bindSession('one-session', one, f.context); f.identity.bindSession('two-session', two, f.context);
  assert.throws(() => f.identity.sessionIdentity('one-session', { ...f.context, tenantId: f.other.id }), code('identity_invalid'));
  assert.throws(() => f.identity.revokeSession('one-session', { ...f.context, origin: 'https://attacker.example.test' }), code('identity_invalid'));
  assert.deepEqual(f.identity.revokeSession('one-session', f.context), { revoked: true }); assert.throws(() => f.identity.sessionIdentity('one-session', f.context), code('identity_revoked'));
  assert.equal(f.identity.sessionIdentity('two-session', f.context).externalId, 'mepmail:mepmail-user-id'); assert.equal(f.identity.sessionIdentity('absent-session', f.context), null);
});

test('renew renova mesmo id externo; mesmo email não permite troca de conta e não consome token recusado', t => {
  const f = fixture(t), original = f.verify(f.token()); f.identity.bindSession('renew-session', original, f.context);
  f.advance(661_000); assert.throws(() => f.identity.sessionIdentity('renew-session', f.context), code('identity_expired'));
  const renewed = f.identity.renewSession('renew-session', { ...f.context, identityToken: f.token({ email: 'updated@example.test', name: 'Nome atualizado' }) });
  assert.equal(renewed.externalId, original.externalId); assert.equal(renewed.email, 'updated@example.test'); assert.equal(f.identity.sessionIdentity('renew-session', f.context).name, 'Nome atualizado');
  const changed = f.token({ sub: 'other-user', email: renewed.email }); assert.throws(() => f.identity.renewSession('renew-session', { ...f.context, identityToken: changed }), code('identity_account_changed'));
  assert.equal(f.verify(changed).externalId, 'mepmail:other-user', 'troca recusada não consome token da outra conta'); assert.equal(f.identity.sessionIdentity('renew-session', f.context).externalId, original.externalId);
});

test('desativação/configuração nova invalidam binding sem alterar contatos/canais alheios', t => {
  const f = fixture(t), verified = f.verify(f.token()); f.identity.bindSession('configured-session', verified, f.context);
  const unrelated = JSON.stringify(f.store.tenant(f.admin, f.other.id));
  f.configure({ enabled: false }); assert.throws(() => f.identity.sessionIdentity('configured-session', f.context), code('identity_revoked'));
  f.configure({ enabled: true }); assert.throws(() => f.identity.sessionIdentity('configured-session', f.context), code('identity_configchanged'));
  assert.equal(JSON.stringify(f.store.tenant(f.admin, f.other.id)), unrelated);
});

test('consumo+binding em transaction externo são atômicos e rollback não deixa proof utilizável', t => {
  const f = fixture(t), token = f.token(); let abandoned;
  assert.throws(() => f.identity.transaction(() => { abandoned = f.verify(token); f.identity.bindSession('rolled-back-session', abandoned, f.context); throw new Error('synthetic-rollback'); }), /synthetic-rollback/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM webchat_identity_jti').get().n, 0); assert.equal(f.store.db.prepare('SELECT count(*) n FROM webchat_identity_sessions').get().n, 0);
  assert.throws(() => f.identity.bindSession('abandoned-session', abandoned, f.context), code('identity_invalid'));
  f.store.db.exec('BEGIN IMMEDIATE'); const verified = f.verify(token); f.identity.bindSession('committed-session', verified, f.context); f.store.db.exec('COMMIT');
  assert.equal(f.identity.sessionIdentity('committed-session', f.context).verified, true); assert.throws(() => f.verify(token), code('identity_replay'));
});

test('JSON/base64url ambíguos, claims duplicadas e tokens oversized são recusados sem eco', t => {
  const f = fixture(t), payload = JSON.stringify(f.claims()).replace('"email_verified":true', '"email_verified":false,"email_verified":true');
  for (const token of [f.token({}, { payload }), f.token().replace('.', '=.'), 'x'.repeat(8193), f.token({ name: '\ud800' })]) {
    assert.throws(() => f.verify(token), failure => failure.code === 'identity_invalid' && !failure.message.includes(token) && !failure.message.includes(f.key.secret));
  }
});

test('autoridade e CAS são frescos; armazenamento falho não publica segredo ou configuração parcial', t => {
  const f = fixture(t), before = JSON.stringify(f.store.tenant(f.admin, f.tenant.id)), status = f.identity.status(f.admin, f.tenant.id, 'site', {}, f.authority);
  assert.throws(() => f.identity.configure(f.admin, f.tenant.id, 'site', { version: status.version - 1, enabled: false }, f.authority), code('identity_configchanged'));
  for (const reauthorize of [() => false, () => ({ ...f.admin, userId: 'changed' }), () => ({ ...f.admin, resellerId: 'other' }), () => ({ ...f.admin, role: 'operator' })]) assert.throws(() => f.identity.rotateKey(f.admin, f.tenant.id, 'site', { version: status.version }, { reauthorize }), code('identity_authority_changed'));
  const unavailable = new WebchatIdentity(f.store, { ...f.options, secrets: { get: id => f.secrets.get(id), set() { throw new Error('private-secret-storage-value'); } } });
  assert.throws(() => unavailable.rotateKey(f.admin, f.tenant.id, 'site', { version: status.version }, f.authority), failure => failure.code === 'identity_storage_unavailable' && !failure.message.includes('private-secret'));
  assert.equal(JSON.stringify(f.store.tenant(f.admin, f.tenant.id)), before); assert.equal(f.secrets.get('site').webchatIdentity.keys.length, 1);
});

test('identidade v2 separa conta e usuário com namespace distinto e tuple sem colisão de delimitadores', t => {
  const f = fixture(t), legacy = f.verify(f.token()), accountA = f.verify(f.token({ v: 2, accountId: 'account-a' })), accountB = f.verify(f.token({ v: 2, accountId: 'account-b' }));
  assert.equal(legacy.externalId, 'mepmail:mepmail-user-id'); assert.equal(legacy.v, 1); assert.equal(legacy.accountId, undefined);
  assert.equal(accountA.accountId, 'account-a'); assert.equal(accountA.v, 2); assert.match(accountA.externalId, /^mepmail:v2~[a-f0-9]{64}$/);
  assert.notEqual(accountA.externalId, accountB.externalId); assert.notEqual(accountA.externalId, legacy.externalId);
  assert.equal(f.verify(f.token({ v: 2, accountId: 'account-a' })).externalId, accountA.externalId);
  const one = f.verify(f.token({ v: 2, accountId: 'a:b', sub: 'c' })), two = f.verify(f.token({ v: 2, accountId: 'a', sub: 'b:c' }));
  assert.notEqual(one.externalId, two.externalId);
  assert.throws(() => f.verify(f.token({ sub: accountA.externalId.slice('mepmail:'.length) })), code('identity_invalid'), 'o marcador v2 não cabe no alfabeto legado');
  f.identity.bindSession('v2-session', accountA, f.context);
  const persisted = JSON.parse(f.store.db.prepare('SELECT claims FROM webchat_identity_sessions WHERE session_id=?').get('v2-session').claims);
  assert.equal(persisted.accountId, 'account-a'); assert.equal(persisted.v, 2);
  const restarted = new WebchatIdentity(f.store, f.options); assert.equal(restarted.sessionIdentity('v2-session', f.context).accountId, 'account-a');
});

test('v2 exige accountId opaco; versões e contexto genérico são explícitos sem caminho privado ou query', t => {
  const f = fixture(t);
  for (const patch of [{ v: 2 }, { v: 2, accountId: '' }, { v: 2, accountId: 'account with spaces' }, { v: 2, accountId: 'x'.repeat(161) }, { v: 3, accountId: 'a' }, { v: '2', accountId: 'a' }, { v: null }, { accountId: 'a' }, { v: 1, accountId: 'a' }]) assert.throws(() => f.verify(f.token(patch)), code('identity_invalid'));
  for (const ctx of [{ accountName: 'x'.repeat(161) }, { product: 'x'.repeat(81) }, { billing: {} }, { pagePath: 'https://app.example.test/settings' }, { pagePath: '//another-host' }, { pagePath: '/settings//private' }, { pagePath: '/settings?token=private' }, { pagePath: '/settings#private' }, { pagePath: '/settings/%2e%2e/private' }, { pagePath: '/settings/../private' }, { pagePath: '/reset-password/private' }, { pagePath: '/token/private' }, { pagePath: '/' + 'a'.repeat(510) + '?' }, { pagePath: '/x' + 'a'.repeat(512) }]) assert.throws(() => f.verify(f.token({ v: 2, accountId: 'a', ctx })), code('identity_invalid'));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM webchat_identity_jti').get().n, 0);
  const ctx = { teamId: 'team-safe', teamName: 'Time de teste', plan: 'Developer', mailboxes: 2, accountName: 'Conta sintética', product: 'Produto sintético', pagePath: '/settings/billing' };
  assert.deepEqual(f.verify(f.token({ v: 2, accountId: 'a', ctx })).ctx, ctx);
  assert.deepEqual(f.verify(f.token({ ctx: { product: 'Produto', pagePath: '/' } })).ctx, { product: 'Produto', pagePath: '/' });
});

test('scope account-user é CAS persistido, nega downgrade legado e invalida apenas bindings anteriores', t => {
  const f = fixture(t), initial = f.identity.status(f.admin, f.tenant.id, 'site', {}, f.authority), legacy = f.verify(f.token());
  assert.equal(initial.scope, 'user'); f.identity.bindSession('legacy-session', legacy, f.context);
  const updated = f.configure({ scope: 'account-user' }); assert.equal(updated.scope, 'account-user'); assert.equal(updated.identityVersion, initial.identityVersion + 1);
  assert.equal(f.store.tenant(f.admin, f.tenant.id).channels[0].webchat.identity.scope, 'account-user');
  for (const patch of [{}, { v: 1 }]) assert.throws(() => f.verify(f.token(patch)), code('identity_invalid'));
  assert.throws(() => f.identity.sessionIdentity('legacy-session', f.context), code('identity_configchanged'));
  assert.equal(f.verify(f.token({ v: 2, accountId: 'a' })).accountId, 'a');
  assert.throws(() => f.identity.configure(f.admin, f.tenant.id, 'site', { version: initial.version, scope: 'user' }, f.authority), code('identity_configchanged'));
  for (const scope of [null, '', 'account', true]) assert.throws(() => f.configure({ scope }), code('identity_invalid_configuration'));
  assert.equal(f.identity.status(f.admin, f.tenant.id, 'site', {}, f.authority).scope, 'account-user');
});

test('renovação v2 exige a mesma conta, versão e usuário e não consome o JWT recusado', t => {
  const f = fixture(t), first = f.verify(f.token({ v: 2, accountId: 'a' })); f.identity.bindSession('account-session', first, f.context);
  const renewed = f.identity.renewSession('account-session', { ...f.context, identityToken: f.token({ v: 2, accountId: 'a', ctx: { accountName: 'Atualizado' } }) });
  assert.equal(renewed.externalId, first.externalId); assert.equal(renewed.accountId, 'a'); assert.deepEqual(renewed.ctx, { accountName: 'Atualizado' });
  for (const patch of [{ v: 2, accountId: 'b' }, { v: 2, accountId: 'a', sub: 'other-user' }, {}]) {
    const token = f.token(patch); assert.throws(() => f.identity.renewSession('account-session', { ...f.context, identityToken: token }), code('identity_account_changed'));
    assert.equal(f.verify(token).verified, true, 'recusa não consome o token de uma nova sessão');
  }
  assert.equal(f.identity.sessionIdentity('account-session', f.context).accountId, 'a');
});

test('sessões legadas sem versão persistida permanecem legadas, sem inferir conta nem migrar identificador', t => {
  const f = fixture(t), legacy = f.verify(f.token()); f.identity.bindSession('pre-v2-session', legacy, f.context);
  const row = f.store.db.prepare('SELECT claims FROM webchat_identity_sessions WHERE session_id=?').get('pre-v2-session'), claims = JSON.parse(row.claims); delete claims.v;
  f.store.db.prepare('UPDATE webchat_identity_sessions SET claims=? WHERE session_id=?').run(JSON.stringify(claims), 'pre-v2-session');
  const current = f.identity.sessionIdentity('pre-v2-session', f.context); assert.equal(current.v, 1); assert.equal(current.accountId, undefined); assert.equal(current.externalId, legacy.externalId);
  assert.equal(f.verify(f.token({ v: 1 })).externalId, legacy.externalId);
});

test('v2 mantém replay, expiração, rotação e revogação ligados à conta sem reemitir identidade', t => {
  const f = fixture(t); f.configure({ scope: 'account-user' });
  const token = f.token({ v: 2, accountId: 'a' }), first = f.verify(token); assert.throws(() => f.verify(token), code('identity_replay'));
  f.identity.bindSession('rotated-account-session', first, f.context);
  const status = f.identity.status(f.admin, f.tenant.id, 'site', {}, f.authority), rotated = f.identity.rotateKey(f.admin, f.tenant.id, 'site', { version: status.version }, f.authority);
  const fresh = f.token({ v: 2, accountId: 'a' }, { signingKey: rotated.secret, kid: rotated.kid });
  const renewed = f.identity.renewSession('rotated-account-session', { ...f.context, identityToken: fresh }); assert.equal(renewed.externalId, first.externalId);
  assert.throws(() => f.verify(fresh), code('identity_replay')); f.advance(660_001);
  assert.throws(() => f.identity.sessionIdentity('rotated-account-session', f.context), code('identity_expired'));
  const old = f.token({ v: 2, accountId: 'a' }); assert.throws(() => f.verify(old), code('identity_revoked'));
  const latest = f.verify(f.token({ v: 2, accountId: 'a' }, { signingKey: rotated.secret, kid: rotated.kid })); f.identity.bindSession('latest-account-session', latest, f.context);
  f.identity.revokeKey(f.admin, f.tenant.id, 'site', { version: rotated.version, kid: rotated.kid }, f.authority);
  assert.throws(() => f.identity.sessionIdentity('latest-account-session', f.context), code('identity_revoked'));
});
