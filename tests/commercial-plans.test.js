import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CommercialAccounts } from '../src/commercial-accounts.js';
import { CommercialPlans } from '../src/commercial-plans.js';
import { Billing } from '../src/billing.js';

const actor = (userId, resellerId) => ({ userId, resellerId, role: 'reseller' });
const platform = actor('platform-admin', 'platform');
const reseller = actor('reseller-admin', 'reseller-a');
const business = actor('business-admin', 'business-a');
const terms = () => ({ name: 'Plano explícito', targetKind: 'business', state: 'active', currency: 'BRL', periodMonths: 3,
  items: [{ kind: 'subscription', label: 'Mensalidade acordada', unitCents: 12345, units: 1, metered: false },
    { kind: 'connections', label: 'Conexão adicional', unitCents: 678, units: 0, metered: true }], quotas: { users: 5, connections: 2, agent_service: null } });
const createBody = (accountVersion = 1, extras = {}) => ({ requestId: 'create-plan-request', accountVersion, ...terms(), reason: 'Tabela aprovada pelo responsável', ...extras });
const updateBody = (record, extras = {}) => ({ requestId: 'update-plan-request', accountVersion: record.accountVersion, version: record.plan.version,
  ...terms(), reason: 'Revisão comercial conferida', ...extras });
const draftBody = (record, extras = {}) => ({ accountVersion: record.accountVersion, version: record.plan.version, targetWorkspaceId: 'business-a',
  startsAt: '2026-10-03', endsAt: null, graceDays: 5, ...extras });
const status = expected => error => error.status === expected;

function fixture(t, { validateActor = input => input, isPlatformAdmin = input => input.userId === platform.userId } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);
    CREATE TABLE protected_data(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  for (const [id, accountKind, parentWorkspaceId] of [['platform', 'platform', null], ['reseller-a', 'reseller', 'platform'], ['reseller-b', 'reseller', 'platform'],
    ['business-a', 'business', 'reseller-a'], ['business-b', 'business', 'reseller-b'], ['business-direct', 'business', 'platform']]) {
    db.prepare('INSERT INTO resellers VALUES(?,?)').run(id, JSON.stringify({ name: id, accountKind, parentWorkspaceId, version: 1,
      brand: { name: `Marca ${id}` }, commercialLifecycle: { state: 'active', trialStartsAt: null, trialEndsAt: null,
        changedAt: '2026-10-03T12:00:00.000Z', changedBy: { userId: platform.userId, workspaceId: platform.resellerId }, reason: 'Conta inicial conferida' }, futureAccountField: { preserved: true } }));
    db.prepare('INSERT INTO tenants VALUES(?,?,?)').run(`tenant-${id}`, id, JSON.stringify({ channels: [{ id: 'synthetic-channel', state: 'connected' }], messages: ['synthetic-message'] }));
  }
  db.prepare('INSERT INTO protected_data VALUES(?,?)').run('billing-grants-provider', JSON.stringify({ prices: 'existing-contract', grants: ['unchanged'], credentials: 'synthetic-only' }));
  const queued = [];
  const store = { db, provisionReseller() { throw new Error('Catalog must not provision accounts.'); }, queuePostgres: id => queued.push(id) };
  const accounts = new CommercialAccounts(store, { validateActor, isPlatformAdmin, platformWorkspaceId: 'platform', now: () => Date.parse('2026-10-03T12:00:00.000Z') });
  const schemaBefore = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all();
  const plans = new CommercialPlans(accounts);
  return { db, store, accounts, plans, queued, schemaBefore, data: id => JSON.parse(db.prepare('SELECT data FROM resellers WHERE id=?').get(id).data) };
}

test('catálogos legados são vazios sem gravar preço, alterar dados ou schema', t => {
  const { db, plans, schemaBefore } = fixture(t), before = db.prepare('SELECT * FROM resellers ORDER BY id').all();
  assert.deepEqual(plans.list(platform), { workspaceId: 'platform', accountVersion: 1, plans: [], total: 0, offset: 0, limit: 50, hasMore: false, canManage: true });
  assert.equal(plans.list(reseller).total, 0);
  assert.deepEqual(db.prepare('SELECT * FROM resellers ORDER BY id').all(), before);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), schemaBefore);
});

test('plano guarda somente preços explícitos, revisões, autoria e auditoria sem faturar', t => {
  const { db, plans, data, queued, schemaBefore } = fixture(t), original = data('reseller-a');
  const protectedRows = ['tenants', 'protected_data'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]);
  const result = plans.create(reseller, 'reseller-a', createBody());
  assert.equal(result.replayed, false);
  assert.equal(result.accountVersion, 2);
  assert.equal(result.plan.version, 1);
  assert.deepEqual(result.plan.items, terms().items);
  assert.deepEqual(result.plan.quotas, terms().quotas);
  assert.deepEqual(result.plan.changedBy, { userId: reseller.userId, workspaceId: reseller.resellerId });
  assert.equal(result.plan.createdAt, '2026-10-03T12:00:00.000Z');
  assert.deepEqual(plans.detail(reseller, 'reseller-a', result.plan.id).plan, result.plan);
  const saved = data('reseller-a');
  assert.deepEqual(Object.fromEntries(Object.entries(saved).filter(([key]) => !['version', 'commercialPlans'].includes(key))), Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'version')));
  for (const [table, rows] of protectedRows) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
  assert.deepEqual(queued, ['tenant-reseller-a']);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), schemaBefore);
  assert.equal(db.prepare('SELECT action FROM commercial_account_audit').get().action, 'account.plan.created');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='billing_contracts'").get(), undefined);
  assert.equal(saved.commercialPlans.requests.length, 1);
  assert.equal(result.plan.requests, undefined);
});

test('plataforma tem planos para empresas e revendas; revenda somente para empresas', t => {
  const { plans } = fixture(t);
  const wholesale = plans.create(platform, 'platform', createBody(1, { targetKind: 'reseller' }));
  assert.equal(wholesale.plan.targetKind, 'reseller');
  assert.equal(plans.create(platform, 'platform', createBody(2, { requestId: 'platform-business-request' })).plan.targetKind, 'business');
  assert.throws(() => plans.create(reseller, 'reseller-a', createBody(1, { targetKind: 'reseller' })), status(400));
});

test('parentesco e visão global de contas não abrem tabelas privadas de outra revenda', t => {
  const { plans } = fixture(t);
  const result = plans.create(reseller, 'reseller-a', createBody());
  for (const input of [platform, actor('other-admin', 'reseller-b'), business]) {
    assert.throws(() => plans.list(input, { workspaceId: 'reseller-a' }), status(404));
    assert.throws(() => plans.detail(input, 'reseller-a', result.plan.id), status(404));
    assert.throws(() => plans.update(input, 'reseller-a', result.plan.id, updateBody(result)), status(404));
  }
  assert.throws(() => plans.list(reseller, { workspaceId: 'platform' }), status(404));
  assert.throws(() => plans.create(business, 'business-a', createBody()), status(404));
  const explicitPlatformWorkspace = { ...platform, resellerId: 'reseller-a' };
  assert.equal(plans.list(explicitPlatformWorkspace).total, 1);
});

test('operadores, suporte e serviços são recusados antes de ler preços', t => {
  const { plans } = fixture(t);
  for (const input of [{ ...reseller, role: 'agent' }, { ...reseller, supportGrantId: 'support' }, { ...reseller, kind: 'service' }, null]) {
    assert.throws(() => plans.list(input, { workspaceId: 'reseller-a' }), status(403));
    assert.throws(() => plans.create(input, 'reseller-a', createBody()), status(403));
  }
});

test('replay de criação e atualização devolve o resultado original sem duplicar revisão', t => {
  const { plans, db, queued } = fixture(t), body = createBody();
  const initial = plans.create(reseller, 'reseller-a', body);
  assert.deepEqual(plans.create(reseller, 'reseller-a', { ...body, quotas: { agent_service: null, connections: 2, users: 5 } }), { ...initial, replayed: true });
  assert.throws(() => plans.create(reseller, 'reseller-a', { ...body, name: 'Outra condição' }), status(409));
  const update = updateBody(initial, { state: 'archived' }), revised = plans.update(reseller, 'reseller-a', initial.plan.id, update);
  assert.equal(revised.accountVersion, 3);
  assert.equal(revised.plan.version, 2);
  assert.deepEqual(plans.update(reseller, 'reseller-a', initial.plan.id, update), { ...revised, replayed: true });
  assert.deepEqual(plans.create(reseller, 'reseller-a', body), { ...initial, replayed: true });
  assert.equal(plans.list(reseller).total, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 2);
  assert.equal(queued.length, 2);
});

test('replay não abre resultado de outro ator nem contorna revogação atual', t => {
  let valid = true;
  const { plans } = fixture(t, { validateActor: input => valid ? input : null });
  const body = createBody(), initial = plans.create(reseller, 'reseller-a', body);
  assert.throws(() => plans.create(actor('another-user', 'reseller-a'), 'reseller-a', body), status(409));
  valid = false;
  assert.throws(() => plans.create(reseller, 'reseller-a', body), status(403));
  assert.throws(() => plans.update(reseller, 'reseller-a', initial.plan.id, updateBody(initial)), status(403));
});

test('renomeação, versão do catálogo e versão individual impedem escrita obsoleta', t => {
  const { plans, accounts } = fixture(t);
  const initial = plans.create(reseller, 'reseller-a', createBody());
  accounts.update(reseller, 'reseller-a', { version: 2, name: 'Revenda renomeada' });
  assert.throws(() => plans.update(reseller, 'reseller-a', initial.plan.id, updateBody(initial)), status(409));
  assert.throws(() => plans.update(reseller, 'reseller-a', initial.plan.id, updateBody(initial, { accountVersion: 3, version: 2 })), status(409));
  const updated = plans.update(reseller, 'reseller-a', initial.plan.id, updateBody(initial, { accountVersion: 3 }));
  assert.equal(updated.accountVersion, 4);
  assert.throws(() => accounts.update(reseller, 'reseller-a', { version: 3, name: 'Nome obsoleto' }), status(409));
});

test('preço ausente, float, limites, moeda, módulos inventados e campos de acesso falham', t => {
  const { plans, db } = fixture(t);
  for (const extras of [{ currency: 'USD' }, { periodMonths: 0 }, { periodMonths: 13 }, { periodMonths: 1.5 }, { state: 'deleted' }, { targetKind: 'tenant' }, { role: 'reseller' }, { modules: ['arbitrary-access'] }, { reason: '' }, { reason: 'a\nb' }, { accountVersion: 0 }, { requestId: 'short' },
    { items: [] }, { items: Array(21).fill(terms().items[0]) }, { quotas: { voip: 1 } }, { quotas: { users: -1 } }, { quotas: { users: 1000000001 } }, { quotas: null }]) {
    assert.throws(() => plans.create(reseller, 'reseller-a', createBody(1, extras)), status(400));
  }
  for (const item of [{ kind: 'users', label: 'Pessoa', units: 1, metered: false }, { ...terms().items[0], unitCents: 1.5 }, { ...terms().items[0], unitCents: -1 },
    { ...terms().items[0], units: 1000001 }, { ...terms().items[0], metered: 'false' }, { ...terms().items[0], kind: 'whatsapp_official' }, { ...terms().items[0], grants: ['tenant'] }]) {
    assert.throws(() => plans.create(reseller, 'reseller-a', createBody(1, { items: [item] })), status(400));
  }
  assert.equal(plans.list(reseller).total, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
});

test('preços zero decididos explicitamente e limites null são válidos pelo Billing', t => {
  const { plans } = fixture(t);
  const record = plans.create(reseller, 'reseller-a', createBody(1, { items: [{ kind: 'subscription', label: 'Cortesia explícita', unitCents: 0, units: 1, metered: false }], quotas: {} }));
  assert.equal(record.plan.items[0].unitCents, 0);
  assert.deepEqual(Billing.prototype.items.call(plans, record.plan.items), record.plan.items);
  assert.deepEqual(Billing.prototype.quotas.call(plans, terms().quotas), terms().quotas);
});

test('consulta filtra e pagina no catálogo autorizado sem expor recibos', t => {
  const { plans } = fixture(t);
  plans.create(reseller, 'reseller-a', createBody(1, { name: 'Ágil', requestId: 'agil-plan-request' }));
  plans.create(reseller, 'reseller-a', createBody(2, { name: 'Básico', state: 'archived', requestId: 'basic-plan-request' }));
  plans.create(reseller, 'reseller-a', createBody(3, { name: 'Completo', requestId: 'full-plan-request' }));
  const first = plans.list(reseller, { limit: 1 });
  assert.equal(first.plans[0].name, 'Ágil');
  assert.equal(first.total, 3);
  assert.equal(first.hasMore, true);
  assert.equal(plans.list(reseller, { offset: 2, limit: 1 }).hasMore, false);
  assert.equal(plans.list(reseller, { q: ' agil ' }).total, 1);
  assert.equal(plans.list(reseller, { state: 'active' }).total, 2);
  assert.equal(plans.list(reseller, { targetKind: 'reseller' }).total, 0);
  assert.equal(first.requests, undefined);
  for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 101 }, { state: 'paused' }, { q: 'a\nb' }, { targetKind: 'tenant' }, { role: 'reseller' }]) assert.throws(() => plans.list(reseller, options), status(400));
});

test('plano vira rascunho revisável compatível com Billing, sem registrar contrato', t => {
  const { plans, db, data } = fixture(t), record = plans.create(reseller, 'reseller-a', createBody()), before = data('reseller-a');
  const prepared = plans.contractDraft(reseller, 'reseller-a', record.plan.id, draftBody(record));
  assert.equal(prepared.requiresReview, true);
  assert.deepEqual(prepared.source, { workspaceId: 'reseller-a', planId: record.plan.id, version: 1, accountVersion: 2 });
  assert.deepEqual(prepared.draft, { name: terms().name, currency: 'BRL', periodMonths: 3, items: terms().items, quotas: terms().quotas,
    startsAt: '2026-10-03', endsAt: null, graceDays: 5, state: 'active', scope: 'workspace', targetKind: 'reseller', targetWorkspaceId: 'business-a' });
  assert.deepEqual(Billing.prototype.terms.call(plans, prepared.draft).items, record.plan.items);
  assert.equal(prepared.draft.requestId, undefined);
  assert.equal(prepared.draft.reason, undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='billing_contracts'").get(), undefined);
  assert.deepEqual(data('reseller-a'), before);
  prepared.draft.items[0].unitCents = 0;
  assert.equal(plans.detail(reseller, 'reseller-a', record.plan.id).plan.items[0].unitCents, 12345);
});

test('rascunho plataforma atende revenda; tipo, vínculo, revisão e vigência são conferidos', t => {
  const { plans } = fixture(t), wholesale = plans.create(platform, 'platform', createBody(1, { targetKind: 'reseller' }));
  const draft = plans.contractDraft(platform, 'platform', wholesale.plan.id, draftBody(wholesale, { targetWorkspaceId: 'reseller-a' }));
  assert.equal(draft.draft.scope, 'platform');
  assert.throws(() => plans.contractDraft(platform, 'platform', wholesale.plan.id, draftBody(wholesale)), status(400));
  const retail = plans.create(reseller, 'reseller-a', createBody());
  for (const extras of [{ accountVersion: 1 }, { version: 2 }, { targetWorkspaceId: 'business-b' }, { startsAt: '2026-02-30' }, { startsAt: '2026-10-05', endsAt: '2026-10-03' }, { graceDays: 91 }, { grant: 'all' }]) {
    assert.throws(() => plans.contractDraft(reseller, 'reseller-a', retail.plan.id, draftBody(retail, extras)), error => [400, 404, 409].includes(error.status));
  }
  const archived = plans.update(reseller, 'reseller-a', retail.plan.id, updateBody(retail, { state: 'archived' }));
  assert.throws(() => plans.contractDraft(reseller, 'reseller-a', retail.plan.id, draftBody(archived)), status(409));
  assert.equal(plans.update(reseller, 'reseller-a', retail.plan.id, updateBody(archived, { requestId: 'reactivate-plan-request' })).plan.state, 'active');
});

test('credencial revogada, identidade trocada e privilégio plataforma perdido na escrita falham', t => {
  for (const replacement of [null, actor('new-user', 'reseller-a'), actor('reseller-admin', 'reseller-b')]) {
    let calls = 0;
    const { plans, data } = fixture(t, { validateActor: input => ++calls === 1 ? input : replacement }), before = data('reseller-a');
    assert.throws(() => plans.create(reseller, 'reseller-a', createBody()), status(403));
    assert.deepEqual(data('reseller-a'), before);
  }
  let platformCalls = 0;
  const { plans, data } = fixture(t, { isPlatformAdmin: () => ++platformCalls === 1 }), before = data('platform');
  assert.throws(() => plans.create(platform, 'platform', createBody()), status(404));
  assert.deepEqual(data('platform'), before);
});

test('CAS recusado, fila assíncrona e falha de auditoria revertem catálogo e recibo', t => {
  for (const mode of ['cas', 'projection', 'async-projection', 'audit']) {
    const { plans, accounts, db, data } = fixture(t), before = data('reseller-a');
    if (mode === 'cas') db.exec("CREATE TRIGGER skip_catalogue BEFORE UPDATE OF data ON resellers WHEN NEW.id='reseller-a' BEGIN SELECT RAISE(IGNORE); END;");
    if (mode === 'projection') accounts.store.queuePostgres = () => { throw new Error('synthetic failure'); };
    if (mode === 'async-projection') accounts.store.queuePostgres = async () => {};
    if (mode === 'audit') accounts.audit = () => { throw new Error('synthetic failure'); };
    assert.throws(() => plans.create(reseller, 'reseller-a', createBody()));
    assert.deepEqual(data('reseller-a'), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
    assert.equal(db.isTransaction, false);
  }
});

test('metadados futuros são preservados e catálogo malformado não é regravado', t => {
  const { plans, db, data } = fixture(t), initial = plans.create(reseller, 'reseller-a', createBody());
  const saved = data('reseller-a');
  saved.commercialPlans.futureCatalogueField = { kept: true };
  saved.commercialPlans.plans[0].futurePlanField = { kept: true };
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(saved), 'reseller-a');
  plans.update(reseller, 'reseller-a', initial.plan.id, updateBody(initial));
  assert.deepEqual(data('reseller-a').commercialPlans.futureCatalogueField, { kept: true });
  assert.deepEqual(data('reseller-a').commercialPlans.plans[0].futurePlanField, { kept: true });
  const corrupted = { ...data('reseller-b'), commercialPlans: { plans: ['broken'], requests: [] } };
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(corrupted), 'reseller-b');
  assert.throws(() => plans.list(actor('other-admin', 'reseller-b')), status(500));
  assert.throws(() => plans.create(actor('other-admin', 'reseller-b'), 'reseller-b', createBody()), status(500));
  assert.deepEqual(data('reseller-b'), corrupted);
});
