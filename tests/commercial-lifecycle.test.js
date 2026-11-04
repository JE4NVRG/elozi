import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CommercialAccounts } from '../src/commercial-accounts.js';
import { CommercialLifecycle, COMMERCIAL_STATES } from '../src/commercial-lifecycle.js';

const administrator = (userId, resellerId) => ({ userId, resellerId, role: 'reseller' });
const platform = administrator('platform-admin', 'platform');
const reseller = administrator('reseller-admin', 'reseller-a');
const client = administrator('client-admin', 'business-a');
const today = '2026-10-03';

function fixture(t, { validateActor = actor => actor } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);
    CREATE TABLE auth_workspace_access(user_id TEXT,reseller_id TEXT);
    CREATE TABLE protected_data(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  const records = [
    ['platform', 'platform', null], ['reseller-a', 'reseller', 'platform'], ['reseller-b', 'reseller', 'platform'],
    ['business-a', 'business', 'reseller-a'], ['business-b', 'business', 'reseller-b'], ['business-direct', 'business', 'platform'],
  ];
  for (const [id, accountKind, parentWorkspaceId] of records) {
    db.prepare('INSERT INTO resellers VALUES(?,?)').run(id, JSON.stringify({ name: id, accountKind, parentWorkspaceId, version: 1,
      brand: { name: id, accent: '#123456' }, agents: [{ id: 'provider-config' }], unknownFutureField: { kept: true } }));
    db.prepare('INSERT INTO tenants VALUES(?,?,?)').run(`tenant-${id}`, id, JSON.stringify({ channels: [{ state: 'connected', token: 'synthetic-sensitive-token' }], messages: ['synthetic-preserved-message'] }));
  }
  db.prepare('INSERT INTO protected_data VALUES(?,?)').run('billing-and-grants', JSON.stringify({ contracts: ['active'], invoices: ['issued'], members: ['client-admin'] }));
  let instant = Date.parse(`${today}T12:00:00.000Z`);
  const queued = [], store = { db, provisionReseller() { throw new Error('Lifecycle must not provision an account.'); }, queuePostgres: tenantId => queued.push(tenantId) };
  const accounts = new CommercialAccounts(store, { validateActor, isPlatformAdmin: actor => actor.userId === platform.userId && actor.resellerId === platform.resellerId,
    platformWorkspaceId: 'platform', now: () => instant });
  const lifecycle = new CommercialLifecycle(accounts);
  return { db, accounts, lifecycle, queued, clock: value => { instant = value; }, data: id => JSON.parse(db.prepare('SELECT data FROM resellers WHERE id=?').get(id).data) };
}

const change = (version, state, extras = {}) => ({ version, state, reason: 'Acordo comercial conferido', ...extras });
const status = expected => error => error.status === expected;

test('prazo preciso do cadastro expira em 7×24h e mudança comercial substitui o prazo', t => {
  const { db, lifecycle, clock, data } = fixture(t), account = data('business-a');
  account.commercialLifecycle = { state: 'trial', trialStartsAt: today, trialEndsAt: '2026-10-10',
    trialExpiresAt: '2026-10-10T12:00:00.000Z', changedAt: `${today}T12:00:00.000Z`,
    changedBy: { userId: 'self-registration', workspaceId: 'business-a' }, reason: 'Teste público' };
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(account), 'business-a');
  clock(Date.parse('2026-10-10T11:59:59.999Z'));
  assert.equal(lifecycle.overview(client).trialExpired, false); assert.equal(lifecycle.overview(client).daysRemaining, 1);
  clock(Date.parse('2026-10-10T12:00:00.000Z'));
  assert.equal(lifecycle.overview(client).trialExpired, true); assert.equal(lifecycle.overview(client).daysRemaining, 0);
  assert.equal(lifecycle.overview(client).state, 'trial'); assert.deepEqual(data('business-a'), account);
  const changed = lifecycle.update(reseller, 'business-a', change(1, 'trial', { trialEndsAt: '2026-10-12' }));
  assert.equal(changed.lifecycle.trialExpiresAt, '2026-10-13T00:00:00.000Z');
  assert.equal(data('business-a').commercialLifecycle.trialExpiresAt, undefined);
});

test('contas existentes são ativas sem regravação ou auditoria inferida', t => {
  const { db, lifecycle } = fixture(t), before = db.prepare('SELECT * FROM resellers ORDER BY id').all();
  assert.deepEqual(COMMERCIAL_STATES, ['active', 'trial', 'paused', 'archived']);
  assert.deepEqual(lifecycle.overview(reseller, 'business-a'), { workspaceId: 'business-a', state: 'active', trialStartsAt: null, trialEndsAt: null,
    changedAt: null, changedBy: null, reason: null, version: 1, trialExpired: false, canManage: true });
  assert.equal(lifecycle.overview(client).canManage, false);
  assert.equal(lifecycle.overview(platform, 'platform').canManage, false);
  assert.deepEqual(db.prepare('SELECT * FROM resellers ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
});

test('teste, pausa, arquivo e reativação preservam datas, ator, dados e acesso explícito', t => {
  const { db, lifecycle, queued, data } = fixture(t), original = data('business-a');
  const preserved = ['tenants', 'auth_workspace_access', 'protected_data'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]);
  const trial = lifecycle.update(reseller, 'business-a', change(1, 'trial', { trialEndsAt: '2026-10-10' }));
  assert.equal(trial.unchanged, false);
  assert.equal(trial.lifecycle.state, 'trial');
  assert.equal(trial.lifecycle.trialStartsAt, today);
  assert.equal(trial.lifecycle.version, 2);
  assert.deepEqual(trial.lifecycle.changedBy, { userId: 'reseller-admin', workspaceId: 'reseller-a' });
  assert.equal(trial.lifecycle.changedAt, `${today}T12:00:00.000Z`);
  assert.equal(lifecycle.update(reseller, 'business-a', change(2, 'paused')).lifecycle.version, 3);
  assert.equal(lifecycle.update(reseller, 'business-a', change(3, 'archived')).lifecycle.version, 4);
  const active = lifecycle.update(reseller, 'business-a', change(4, 'active')).lifecycle;
  assert.equal(active.version, 5);
  assert.equal(active.trialStartsAt, today);
  assert.equal(active.trialEndsAt, '2026-10-10');
  assert.equal(active.trialExpired, false);
  const final = data('business-a');
  assert.deepEqual(Object.fromEntries(Object.entries(final).filter(([key]) => !['commercialLifecycle', 'version'].includes(key))), Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'version')));
  for (const [table, rows] of preserved) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
  assert.deepEqual(queued, Array(4).fill('tenant-business-a'));
  assert.deepEqual(db.prepare('SELECT action,previous_version,version,actor_id,actor_workspace_id FROM commercial_account_audit ORDER BY version').all().map(row => ({ ...row })), [2, 3, 4, 5].map((version, index) => ({
    action: `account.lifecycle.${['trial', 'paused', 'archived', 'active'][index]}`, previous_version: version - 1, version, actor_id: reseller.userId, actor_workspace_id: reseller.resellerId,
  })));
});

test('expiração do teste é derivada após o último dia sem mutação ou suspensão', t => {
  const { db, lifecycle, clock, data } = fixture(t);
  lifecycle.update(platform, 'business-direct', change(1, 'trial', { trialEndsAt: today }));
  const snapshot = data('business-direct');
  clock(Date.parse(`${today}T23:59:59.999Z`));
  assert.equal(lifecycle.overview(platform, 'business-direct').trialExpired, false);
  clock(Date.parse('2026-10-04T00:00:00.000Z'));
  const expired = lifecycle.overview(platform, 'business-direct');
  assert.equal(expired.state, 'trial');
  assert.equal(expired.trialExpired, true);
  assert.deepEqual(data('business-direct'), snapshot);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 1);
  assert.equal(lifecycle.update(platform, 'business-direct', change(2, 'trial', { trialEndsAt: '2026-10-15' })).lifecycle.trialStartsAt, today);
});

test('data inválida, passado, campos de acesso e estados destrutivos são recusados', t => {
  const { db, lifecycle } = fixture(t);
  for (const trialEndsAt of [undefined, null, '', '2026-02-29', '2026-02-30', '2026-13-01', '2026-10-2', '2026-10-02', '2026-10-03T12:00:00Z']) {
    assert.throws(() => lifecycle.update(reseller, 'business-a', change(1, 'trial', { trialEndsAt })), status(400));
  }
  for (const extras of [{ state: 'deleted' }, { role: 'reseller' }, { grants: ['tenant-business-a'] }, { parentWorkspaceId: 'reseller-b' }, { trialEndsAt: today }, { reason: '' }, { reason: 'a\nb' }, { version: 0 }, { version: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => lifecycle.update(reseller, 'business-a', change(1, 'paused', extras)), status(400));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
});

test('plataforma gere revendas e empresas; relação comercial não abre outros workspaces', t => {
  const { lifecycle, db } = fixture(t);
  assert.equal(lifecycle.update(platform, 'reseller-a', change(1, 'paused')).lifecycle.version, 2);
  assert.equal(lifecycle.update(platform, 'business-b', change(1, 'archived')).lifecycle.version, 2);
  assert.throws(() => lifecycle.overview(reseller, 'business-b'), status(404));
  assert.throws(() => lifecycle.update(reseller, 'business-b', change(2, 'active')), status(404));
  assert.throws(() => lifecycle.update(reseller, 'reseller-a', change(2, 'active')), status(403));
  assert.throws(() => lifecycle.update(client, 'business-a', change(1, 'trial', { trialEndsAt: today })), status(403));
  assert.throws(() => lifecycle.update(platform, 'platform', change(1, 'paused')), status(403));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 0);
});

test('operador, suporte e serviço não alteram nem leem o ciclo administrativo', t => {
  const { lifecycle } = fixture(t);
  for (const actor of [{ ...reseller, role: 'agent' }, { ...reseller, supportGrantId: 'support-id' }, { ...reseller, kind: 'service' }, { ...reseller, userId: '' }, null]) {
    assert.throws(() => lifecycle.overview(actor, 'business-a'), status(403));
    assert.throws(() => lifecycle.update(actor, 'business-a', change(1, 'paused')), status(403));
  }
});

test('revisão da conta impede salvar estado após renomeação e estado impede nome obsoleto', t => {
  const { lifecycle, accounts } = fixture(t);
  accounts.update(reseller, 'business-a', { version: 1, name: 'Empresa renomeada' });
  assert.throws(() => lifecycle.update(reseller, 'business-a', change(1, 'paused')), status(409));
  assert.equal(lifecycle.update(reseller, 'business-a', change(2, 'paused')).lifecycle.version, 3);
  assert.throws(() => accounts.update(reseller, 'business-a', { version: 2, name: 'Nome obsoleto' }), status(409));
});

test('salvar estado idêntico não cria revisão, motivo ou auditoria artificial', t => {
  const { db, lifecycle, data } = fixture(t);
  assert.equal(lifecycle.update(reseller, 'business-a', change(1, 'active')).unchanged, true);
  lifecycle.update(reseller, 'business-a', change(1, 'trial', { trialEndsAt: today }));
  const snapshot = data('business-a');
  const unchanged = lifecycle.update(reseller, 'business-a', change(2, 'trial', { trialEndsAt: today, reason: 'Outro motivo sem mudança' }));
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.lifecycle.version, 2);
  assert.deepEqual(data('business-a'), snapshot);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 1);
});

test('ator revogado ou identidade trocada entre validações não chega à escrita', t => {
  for (const replacement of [null, administrator('another-admin', 'reseller-a'), administrator('reseller-admin', 'reseller-b')]) {
    let calls = 0;
    const { lifecycle, data, db } = fixture(t, { validateActor: actor => ++calls === 1 ? actor : replacement });
    const before = data('business-a');
    assert.throws(() => lifecycle.update(reseller, 'business-a', change(1, 'paused')), status(403));
    assert.deepEqual(data('business-a'), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
  }
});

test('vínculo comercial revalidado dentro da transação e CAS protegem concorrência', t => {
  let calls = 0, fixtureResult;
  fixtureResult = fixture(t, { validateActor: actor => {
    if (++calls === 2) {
      const current = fixtureResult.data('business-a');
      fixtureResult.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify({ ...current, parentWorkspaceId: 'reseller-b' }), 'business-a');
    }
    return actor;
  } });
  assert.throws(() => fixtureResult.lifecycle.update(reseller, 'business-a', change(1, 'paused')), status(404));
  assert.equal(fixtureResult.data('business-a').commercialLifecycle, undefined);
  const { db, lifecycle, data } = fixture(t);
  const before = data('business-a');
  db.exec(`CREATE TRIGGER skip_lifecycle BEFORE UPDATE OF data ON resellers WHEN NEW.id='business-a' BEGIN SELECT RAISE(IGNORE); END;`);
  assert.throws(() => lifecycle.update(reseller, 'business-a', change(1, 'paused')), status(409));
  assert.deepEqual(data('business-a'), before);
});

test('falha da auditoria ou projeção reverte estado e revisão integralmente', t => {
  for (const mode of ['audit', 'projection', 'async-projection']) {
    const { accounts, lifecycle, data, db } = fixture(t), before = data('business-a');
    if (mode === 'audit') accounts.audit = () => { throw new Error('synthetic audit failure'); };
    else if (mode === 'projection') accounts.store.queuePostgres = () => { throw new Error('synthetic projection failure'); };
    else accounts.store.queuePostgres = async () => {};
    assert.throws(() => lifecycle.update(reseller, 'business-a', change(1, 'paused')));
    assert.deepEqual(data('business-a'), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
    assert.equal(db.isTransaction, false);
  }
});

test('metadado corrompido e relógio inválido são recusados sem sobrescrever dados', t => {
  const { lifecycle, db, data, clock } = fixture(t);
  const malformed = { ...data('business-a'), commercialLifecycle: { state: 'deleted', trialEndsAt: '2026-02-30' } };
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(malformed), 'business-a');
  assert.throws(() => lifecycle.overview(reseller, 'business-a'), status(500));
  assert.throws(() => lifecycle.update(reseller, 'business-a', change(1, 'active')), status(500));
  assert.deepEqual(data('business-a'), malformed);
  for (const instant of [NaN, Infinity, 1e30]) {
    clock(instant);
    assert.throws(() => lifecycle.overview(platform, 'business-direct'), status(500));
  }
});

test('datas bissextas válidas e campos futuros da conta e do ciclo são preservados', t => {
  const { lifecycle, clock, db, data } = fixture(t);
  clock(Date.parse('2028-02-28T12:00:00.000Z'));
  lifecycle.update(reseller, 'business-a', change(1, 'trial', { trialEndsAt: '2028-02-29' }));
  const record = data('business-a');
  record.commercialLifecycle.futureLifecycleField = { preserve: true };
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(record), 'business-a');
  lifecycle.update(reseller, 'business-a', change(2, 'paused'));
  assert.deepEqual(data('business-a').commercialLifecycle.futureLifecycleField, { preserve: true });
  assert.equal(lifecycle.overview(reseller, 'business-a').futureLifecycleField, undefined);
});
