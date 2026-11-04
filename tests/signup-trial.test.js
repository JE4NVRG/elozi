import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { Store } from '../src/store.js';
import { SignupTrials, SIGNUP_TRIAL_MS, normalizeFiscalDocument } from '../src/signup-trial.js';
import { commercialMetadataSnapshot } from '../src/postgres-bridge.js';

const cpf = '12345678909', otherCpf = '11144477735';
const alphaCnpj = '12ABC34501DE35', cnpj = '11222333000181', branchCnpj = '11222333000262';
const instant = Date.parse('2026-10-04T21:37:12.345Z');
const status = expected => error => error.status === expected;
const identity = (email, fiscalDocument = cpf, extra = {}) => ({ name: 'Pessoa sintética', company: 'Empresa sintética', email, password: 'Synthetic-Only!', fiscalDocument, ...extra });
const googleProfile = (subject, email) => ({ sub: subject, name: 'Google sintético', email, email_verified: true });

function fixture(t, options = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let clock = instant;
  const now = () => clock;
  const service = new SignupTrials(store.db, { keyLoader: async () => Buffer.alloc(32, 7), now, ...options });
  const auth = new Auth(store.db, { registrationTrial: service, now });
  return { store, db: store.db, service, auth, now, clock: value => { clock = value; }, provision: input => store.provisionReseller(input) };
}
const counts = db => Object.fromEntries(['resellers', 'tenants', 'auth_users', 'auth_sessions', 'auth_google_identities', 'signup_trial_registrations'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));

test('validação aceita CPF, CNPJ numérico e exemplo alfanumérico oficial com pontuação e case equivalentes', () => {
  assert.deepEqual(normalizeFiscalDocument('123.456.789-09'), { kind: 'cpf', document: cpf });
  assert.deepEqual(normalizeFiscalDocument('11.222.333/0001-81'), { kind: 'cnpj', document: cnpj });
  assert.deepEqual(normalizeFiscalDocument(' 12.abc.345/01de-35 '), { kind: 'cnpj', document: alphaCnpj });
  assert.deepEqual(normalizeFiscalDocument(alphaCnpj), { kind: 'cnpj', document: alphaCnpj });
  assert.deepEqual(normalizeFiscalDocument(branchCnpj), { kind: 'cnpj', document: branchCnpj });
});

test('validação recusa checksum inválido, repetições, pontuação incompleta e caracteres não permitidos', () => {
  for (const input of [undefined, null, 12345678909, '', '00000000000', '11111111111', '00000000000000', '12345678900', '11222333000180', '12ABC34501DE34', '12ABC34501DE3A', '123-456-789-09', '123 456 789 09', '123.456789-09', 'x12345678909', '12ABC34501DÉ35', '12ABC34501DE35\0', '12ABC34501DE\n35', '12ＡBC34501DE35']) assert.throws(() => normalizeFiscalDocument(input), status(400));
});

test('cadastro obrigatório prepara chave fora da transação e inicia exatamente sete vezes 24h', async t => {
  const f = fixture(t, { keyLoader: async () => { assert.equal(f.db.isTransaction, false); return Buffer.alloc(32, 7); } });
  const account = await f.auth.register(identity('first@example.test'), { provision: f.provision });
  assert.equal(f.service.registered(account.actor.resellerId), true);
  const record = f.db.prepare('SELECT * FROM signup_trial_registrations').get();
  const data = JSON.parse(f.db.prepare('SELECT data FROM resellers WHERE id=?').get(account.actor.resellerId).data);
  assert.equal(record.starts_at, '2026-10-04T21:37:12.345Z');
  assert.equal(Date.parse(record.expires_at) - Date.parse(record.starts_at), SIGNUP_TRIAL_MS);
  assert.deepEqual(data.commercialLifecycle, { state: 'trial', trialStartsAt: '2026-10-04', trialEndsAt: '2026-10-11', trialExpiresAt: '2026-10-11T21:37:12.345Z', changedAt: record.starts_at, changedBy: { userId: 'self-registration', workspaceId: account.actor.resellerId }, reason: 'Teste iniciado no cadastro público' });
  assert.equal(account.actor.platformAdmin, false);
});

test('documento obrigatório ou chave indisponível não deixa conta, pessoa ou reserva', async t => {
  const f = fixture(t), before = counts(f.db);
  for (const fiscalDocument of [undefined, null, '', '12345678900']) await assert.rejects(f.auth.register(identity('invalid@example.test', cpf, { fiscalDocument }), { provision: f.provision }), status(400));
  assert.deepEqual(counts(f.db), before);
  for (const keyLoader of [async () => Buffer.alloc(31), async () => { throw new Error('private loader failure'); }]) {
    const service = new SignupTrials(f.db, { keyLoader, now: f.now });
    await assert.rejects(service.prepare(cpf), error => error.status === 503 && !error.message.includes('private loader'));
  }
  assert.deepEqual(counts(f.db), before);
});

test('formatação e case do mesmo documento reservam um teste para somente uma conta', async t => {
  const f = fixture(t);
  await f.auth.register(identity('alpha@example.test', alphaCnpj), { provision: f.provision });
  const before = counts(f.db);
  await assert.rejects(f.auth.register(identity('alpha-other@example.test', '12.abc.345/01de-35'), { provision: f.provision }), status(409));
  assert.deepEqual(counts(f.db), before);
});

test('dois cadastros concorrentes de e-mails diferentes não duplicam documento nem criam órfãos', async t => {
  const f = fixture(t), before = counts(f.db);
  const results = await Promise.allSettled([f.auth.register(identity('race-a@example.test', cpf), { provision: f.provision }), f.auth.register(identity('race-b@example.test', '123.456.789-09'), { provision: f.provision })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const after = counts(f.db);
  for (const table of ['resellers', 'tenants', 'auth_users', 'auth_sessions', 'signup_trial_registrations']) assert.equal(after[table], before[table] + 1);
});

test('falha depois da reserva reverte todos os dados e libera tentativa que nunca concluiu', async t => {
  const f = fixture(t), before = counts(f.db), session = f.auth.session;
  f.auth.session = () => { throw new Error('Synthetic session failure'); };
  await assert.rejects(f.auth.register(identity('rollback@example.test'), { provision: f.provision }), /Synthetic session failure/);
  assert.deepEqual(counts(f.db), before);
  f.auth.session = session;
  const completed = await f.auth.register(identity('rollback@example.test'), { provision: f.provision });
  assert.equal(f.service.registered(completed.actor.resellerId), true);
});

test('objeto preparado forjado e reserva fora da transação não gravam digest', async t => {
  const f = fixture(t), prepared = await f.service.prepare(cpf), workspaceId = 'reseller_' + randomUUID();
  assert.equal(JSON.stringify(prepared).includes(cpf), false);
  assert.equal(Object.isFrozen(prepared), true); assert.equal(Object.isFrozen(prepared.onboardingTrial), true);
  assert.throws(() => f.service.reserve(workspaceId, prepared), status(500));
  f.db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => f.service.reserve(workspaceId, { ...prepared }), status(500)); }
  finally { f.db.exec('ROLLBACK'); }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM signup_trial_registrations').get().n, 0);
});

test('Google novo exige documento; vínculo existente entra sem documento e conserva teste', async t => {
  const f = fixture(t), profile = googleProfile('new-google', 'google@example.test');
  await assert.rejects(f.auth.googleLogin(profile, { provision: f.provision }), status(400));
  const created = await f.auth.googleLogin(profile, { provision: f.provision, fiscalDocument: cpf });
  const record = f.db.prepare('SELECT * FROM signup_trial_registrations').get();
  f.clock(instant + SIGNUP_TRIAL_MS * 2);
  const entered = await f.auth.googleLogin({ ...profile, email: 'changed@example.test' }, { provision: f.provision, fiscalDocument: 'invalid' });
  assert.equal(entered.actor.userId, created.actor.userId);
  assert.deepEqual(f.db.prepare('SELECT * FROM signup_trial_registrations').get(), record);
  await assert.rejects(f.auth.googleLogin(googleProfile('other-google', 'other-google@example.test'), { provision: f.provision, fiscalDocument: '123.456.789-09' }), status(409));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_google_identities').get().n, 1);
});

test('Google previamente vinculado em conta legada continua entrando quando trial passa a ser obrigatório', async t => {
  const f = fixture(t), legacy = new Auth(f.db, { now: f.now }), profile = googleProfile('legacy-google', 'legacy@example.test');
  const first = await legacy.googleLogin(profile, { provision: f.provision });
  const entered = await f.auth.googleLogin(profile, { allowRegistration: false });
  assert.equal(entered.actor.userId, first.actor.userId);
  assert.equal(f.service.registered(first.actor.resellerId), false);
});

test('e-mail Google já reservado orienta vínculo sem exigir documento e não cria outra conta', async t => {
  const f = fixture(t), created = await f.auth.register(identity('local-email@example.test'), { provision: f.provision });
  const before = counts(f.db);
  await assert.rejects(f.auth.googleLogin(googleProfile('unlinked-google', 'local-email@example.test'), { provision: f.provision }), status(409));
  assert.deepEqual(counts(f.db), before);
  assert.equal(f.service.registered(created.actor.resellerId), true);
});

test('reabrir serviços com a chave estável conserva a reserva HMAC e recusa o mesmo documento', async t => {
  const f = fixture(t), created = await f.auth.register(identity('before-reopen@example.test', alphaCnpj), { provision: f.provision });
  const before = counts(f.db), record = f.db.prepare('SELECT * FROM signup_trial_registrations').get();
  const reopened = new SignupTrials(f.db, { keyLoader: async () => Buffer.alloc(32, 7), now: () => instant + SIGNUP_TRIAL_MS * 10 });
  const auth = new Auth(f.db, { registrationTrial: reopened, now: f.now });
  assert.equal(reopened.registered(created.actor.resellerId), true);
  await assert.rejects(auth.register(identity('after-reopen@example.test', '12.abc.345/01de-35'), { provision: f.provision }), status(409));
  assert.deepEqual(counts(f.db), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM signup_trial_registrations').get(), record);
});

test('vencimento e desativação da pessoa conservam reserva do documento', async t => {
  const f = fixture(t), account = await f.auth.register(identity('expired@example.test'), { provision: f.provision });
  f.clock(instant + SIGNUP_TRIAL_MS * 10);
  f.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(f.now(), account.actor.userId);
  await assert.rejects(f.auth.register(identity('repeat@example.test'), { provision: f.provision }), status(409));
  assert.equal(f.service.registered(account.actor.resellerId), true);
});

test('CNPJs completos de matriz e filial são distintos; unidades existentes não consomem outro teste', async t => {
  const f = fixture(t), matrix = await f.auth.register(identity('matrix@example.test', cnpj), { provision: f.provision });
  const branch = await f.auth.register(identity('branch@example.test', branchCnpj), { provision: f.provision });
  assert.notEqual(matrix.actor.resellerId, branch.actor.resellerId);
  const tenant = f.store.list(matrix.actor)[0], before = f.db.prepare('SELECT count(*) AS n FROM signup_trial_registrations').get().n;
  const created = f.store.createTenant(matrix.actor, { name: 'Filial sintética', segment: 'Atendimento', parentTenantId: tenant.id });
  assert.equal(created.parentTenantId, tenant.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM signup_trial_registrations').get().n, before);
});

test('documento e digest não vazam para JSON de conta/unidade, identidade autenticada ou projeção PG', async t => {
  const f = fixture(t), created = await f.auth.register(identity('privacy@example.test', alphaCnpj), { provision: f.provision });
  const record = f.db.prepare('SELECT * FROM signup_trial_registrations').get(), raw = f.db.prepare('SELECT data FROM resellers WHERE id=?').get(created.actor.resellerId).data;
  assert.match(record.identity_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(record.identity_digest, createHash('sha256').update(alphaCnpj).digest('hex'));
  const reseller = f.store.reseller(created.actor), tenant = f.store.tenant(created.actor, f.store.list(created.actor)[0].id);
  const projected = commercialMetadataSnapshot({ ...tenant, reseller: JSON.parse(raw) });
  const exposed = JSON.stringify({ raw, reseller, tenant, user: f.auth.me(created.actor), projected });
  assert.equal(exposed.includes(alphaCnpj), false); assert.equal(exposed.includes(record.identity_digest), false);
  assert.equal(Object.hasOwn(reseller, 'commercialLifecycle'), false);
  assert.equal(JSON.stringify(projected).includes('trialExpiresAt'), false);
});

test('alterar marca preserva trial, plano, domínio, versão e futuros metadados privados', async t => {
  const f = fixture(t), account = await f.auth.register(identity('brand@example.test'), { provision: f.provision });
  const read = () => JSON.parse(f.db.prepare('SELECT data FROM resellers WHERE id=?').get(account.actor.resellerId).data);
  const data = { ...read(), version: 9, commercialPlans: { private: true }, workspaceDomain: { host: 'synthetic.example.test' }, futurePrivate: { retained: true } };
  f.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), account.actor.resellerId);
  const result = f.store.setResellerBrand(account.actor, { name: 'Marca sintética' }), after = read();
  assert.deepEqual({ ...after, brand: data.brand }, data);
  assert.equal(after.brand.name, 'Marca sintética');
  assert.equal(Object.hasOwn(result, 'commercialLifecycle'), false); assert.equal(Object.hasOwn(result, 'commercialPlans'), false); assert.equal(Object.hasOwn(result, 'workspaceDomain'), false);
});

test('consumidor Auth sem registrationTrial conserva cadastro legado sem documento ou trial automático', async t => {
  const f = fixture(t), legacy = new Auth(f.db, { now: f.now }), created = await legacy.register(identity('legacy-register@example.test', cpf, { fiscalDocument: undefined }), { provision: f.provision });
  const data = JSON.parse(f.db.prepare('SELECT data FROM resellers WHERE id=?').get(created.actor.resellerId).data);
  assert.equal(Object.hasOwn(data, 'commercialLifecycle'), false); assert.equal(f.service.registered(created.actor.resellerId), false);
});

test('desativar oferta mantém reserva e prazo existentes, sem impedir login nem renovar teste', async t => {
  const f = fixture(t), input = identity('preserved-trial@example.test');
  const existing = await f.auth.register(input, { provision: f.provision });
  const reservation = f.db.prepare('SELECT * FROM signup_trial_registrations').get();
  const before = f.db.prepare('SELECT data FROM resellers WHERE id=?').get(existing.actor.resellerId).data;
  const inactiveOffer = new Auth(f.db, { now: f.now });
  f.clock(instant + 9 * 86400000);
  const login = await inactiveOffer.login({ username: input.email, password: input.password });
  assert.equal(login.actor.resellerId, existing.actor.resellerId);
  assert.equal(f.db.prepare('SELECT data FROM resellers WHERE id=?').get(existing.actor.resellerId).data, before);
  assert.deepEqual(f.db.prepare('SELECT * FROM signup_trial_registrations').get(), reservation);
});

test('provisão recusa datas forjadas e preserva criação comercial sem trial', t => {
  const f = fixture(t), before = counts(f.db);
  for (const onboardingTrial of [{ startsAt: 'invalid', expiresAt: 'invalid' }, { startsAt: '2026-10-04T00:00:00.000Z', expiresAt: '2026-10-12T00:00:00.000Z' }, { ...f.service.window(), state: 'active' }]) assert.throws(() => f.store.provisionReseller({ resellerId: 'reseller_' + randomUUID(), tenantId: 'tenant_' + randomUUID(), name: 'Inválida', onboardingTrial }), status(400));
  assert.deepEqual(counts(f.db), before);
  const resellerId = 'reseller_' + randomUUID();
  f.store.provisionReseller({ resellerId, tenantId: 'tenant_' + randomUUID(), name: 'Conta gerida' });
  assert.equal(Object.hasOwn(JSON.parse(f.db.prepare('SELECT data FROM resellers WHERE id=?').get(resellerId).data), 'commercialLifecycle'), false);
});
