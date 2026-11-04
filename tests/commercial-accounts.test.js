import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { CommercialAccounts } from '../src/commercial-accounts.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';

const status = code => error => error.status === code;
const input = (extra = {}) => ({ requestId: randomUUID(), name: 'Cliente QA', accountKind: 'business', parentWorkspaceId: 'partner-a', initialTenantName: 'Matriz QA', segment: 'Serviços QA', ...extra });
const actor = (id, resellerId) => ({ userId: id, resellerId });
function fixture(t, { optionalTables = true } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);
    CREATE TABLE qa_projection_queue(tenant_id TEXT NOT NULL REFERENCES tenants(id));
    CREATE TABLE qa_operational_access(user_id TEXT NOT NULL,workspace_id TEXT NOT NULL);
    CREATE TABLE qa_users(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,platform INTEGER NOT NULL DEFAULT 0);`);
  if (optionalTables) db.exec(`CREATE TABLE auth_users(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),role TEXT NOT NULL,disabled_at INTEGER,name TEXT,email TEXT,password TEXT);
    CREATE TABLE billing_contracts(id TEXT PRIMARY KEY,target_workspace_id TEXT NOT NULL,state TEXT NOT NULL);`);
  const insertAccount = (id, data) => db.prepare('INSERT INTO resellers VALUES (?,?)').run(id, JSON.stringify(data));
  insertAccount('mep-demo', { name: 'Plataforma QA', brand: { name: 'Elozi', accent: '#3157d5', initials: 'E', domain: '', privateCredential: 'secret-brand-marker' } });
  insertAccount('partner-a', { name: 'Águia QA', brand: { name: 'Marca A' }, private: 'account-secret-marker' });
  insertAccount('partner-b', { name: 'Revenda B', accountKind: 'reseller', parentWorkspaceId: 'mep-demo', version: 4 });
  insertAccount('business-a', { name: 'Cliente A', accountKind: 'business', parentWorkspaceId: 'partner-a', version: 2 });
  insertAccount('business-b', { name: 'Cliente B', accountKind: 'business', parentWorkspaceId: 'partner-b', version: 1 });
  const insertTenant = (id, workspace, data = {}) => db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, workspace, JSON.stringify({ name: 'Nome privado da empresa', channels: [], agents: [], conversations: [{ messages: [{ text: 'private-message-marker' }], contact: 'private-contact-marker' }], ...data }));
  insertTenant('company-a', 'partner-a'); insertTenant('company-b', 'partner-b'); insertTenant('customer-a', 'business-a'); insertTenant('customer-b', 'business-b');
  for (const [id, workspace, role, platform] of [['owner', 'mep-demo', 'reseller', 1], ['partner-admin', 'partner-a', 'reseller', 0], ['other-admin', 'partner-b', 'reseller', 0], ['business-admin', 'business-a', 'reseller', 0], ['operator', 'partner-a', 'operator', 0]]) {
    db.prepare('INSERT INTO qa_users(id,reseller_id,role,platform) VALUES (?,?,?,?)').run(id, workspace, role, platform);
    if (optionalTables) db.prepare('INSERT INTO auth_users VALUES (?,?,?,NULL,?,?,?)').run(id, workspace, role, 'private-person-marker', 'private-email-marker', 'private-password-marker');
  }
  const store = { db, provisionReseller: Store.prototype.provisionReseller, queuePostgres: id => db.prepare('INSERT INTO qa_projection_queue VALUES (?)').run(id) };
  Object.defineProperty(store, 'gateway', { get() { throw new Error('Nenhum transporte permitido em teste comercial'); } });
  const validateActor = candidate => {
    const row = db.prepare('SELECT * FROM qa_users WHERE id=?').get(candidate?.userId ?? '');
    if (!row || row.disabled || candidate.resellerId !== row.reseller_id && !db.prepare('SELECT 1 FROM qa_operational_access WHERE user_id=? AND workspace_id=?').get(row.id, candidate.resellerId)) throw Object.assign(new Error('Acesso revogado'), { status: 403 });
    return { userId: row.id, resellerId: candidate.resellerId, role: row.role, platformAdmin: Boolean(row.platform), ...(candidate.supportGrantId ? { supportGrantId: candidate.supportGrantId } : {}) };
  };
  let clock = Date.parse('2026-10-03T12:00:00Z');
  const options = { validateActor, isPlatformAdmin: value => Boolean(validateActor(value).platformAdmin), now: () => clock };
  const accounts = new CommercialAccounts(store, options);
  return { db, store, accounts, options, insertAccount, insertTenant, platform: actor('owner', 'mep-demo'), partner: actor('partner-admin', 'partner-a'), business: actor('business-admin', 'business-a'), advance(ms) { clock += ms; } };
}

test('contas legadas são virtuais, preservam IDs e não recebem parent inferido ou persistência automática', t => {
  const { db, accounts, platform, partner } = fixture(t), before = db.prepare('SELECT * FROM resellers ORDER BY id').all();
  const current = accounts.current(partner);
  assert.equal(current.accountKind, 'reseller'); assert.equal(current.parentWorkspaceId, null); assert.equal(current.createdAt, null); assert.equal(current.version, 1);
  assert.equal(accounts.current(platform).accountKind, 'platform'); assert.equal(accounts.current(platform).parentWorkspaceId, null);
  assert.deepEqual(db.prepare('SELECT * FROM resellers ORDER BY id').all(), before);
});

test('listagem global paginada inclui a plataforma e só metadata pública com quantidades conhecidas', t => {
  const { accounts, platform } = fixture(t), result = accounts.list(platform, { view: 'platform', limit: 2 });
  assert.equal(result.accounts.length, 2); assert.equal(result.total, 5); assert.equal(result.hasMore, true);
  assert.deepEqual(result.summary, { total: 5, platform: 1, reseller: 2, business: 2, activeUsers: 5, connectedChannels: 0, activeAgents: 0 });
  const all = accounts.list(platform, { view: 'platform', limit: 100 });
  assert.equal(all.accounts.some(item => item.id === 'mep-demo'), true);
  for (const marker of ['private-message-marker', 'private-contact-marker', 'private-person-marker', 'private-email-marker', 'private-password-marker', 'account-secret-marker', 'secret-brand-marker', 'Nome privado da empresa']) assert.equal(JSON.stringify(all).includes(marker), false);
  assert.equal(Object.hasOwn(all.accounts[0], 'tenants'), false);
});

test('revenda vê própria conta e filhos comerciais diretos; cliente vê só própria conta', t => {
  const { accounts, platform, partner, business } = fixture(t);
  assert.deepEqual(new Set(accounts.list(partner).accounts.map(item => item.id)), new Set(['partner-a', 'business-a']));
  assert.deepEqual(accounts.list(business).accounts.map(item => item.id), ['business-a']);
  assert.deepEqual(new Set(accounts.list(platform).accounts.map(item => item.id)), new Set(['mep-demo', 'partner-b']));
  assert.throws(() => accounts.overview(partner, 'business-b'), status(404));
  assert.throws(() => accounts.overview(business, 'partner-a'), status(404));
  assert.throws(() => accounts.list(partner, { view: 'platform' }), status(403));
});

test('filtros respeitam autorização, busca sem acento, totais e página sem truncamento de diretório', t => {
  const { accounts, platform, partner } = fixture(t);
  const filtered = accounts.list(platform, { view: 'platform', q: 'aguia', kind: 'reseller', limit: 1 });
  assert.equal(filtered.total, 1); assert.equal(filtered.accounts[0].id, 'partner-a'); assert.equal(filtered.summary.total, 5);
  assert.equal(accounts.list(partner, { q: 'Cliente B' }).total, 0);
  assert.equal(accounts.list(platform, { view: 'platform', offset: 5 }).accounts.length, 0);
  for (const options of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 100001 }, { offset: 1.5 }, { q: 'x\n' }, { kind: 'admin' }, { view: 'all' }, { debug: true }]) assert.throws(() => accounts.list(platform, options), status(400));
});

test('autoridade fresca ignora role, platformAdmin e resellerId forjados; suporte nunca administra comercial', t => {
  const { accounts, db, platform, partner } = fixture(t);
  assert.throws(() => accounts.list({ ...actor('operator', 'partner-a'), role: 'reseller', platformAdmin: true }), status(403));
  assert.throws(() => accounts.list({ ...partner, role: 'reseller', platformAdmin: true }, { view: 'platform' }), status(403));
  assert.throws(() => accounts.list({ ...partner, resellerId: 'partner-b' }), status(403));
  assert.throws(() => accounts.list({ ...platform, supportGrantId: 'grant-qa' }, { view: 'platform' }), status(403));
  db.prepare('UPDATE qa_users SET disabled=1 WHERE id=?').run(platform.userId);
  assert.throws(() => accounts.list(platform, { view: 'platform' }), status(403));
});

test('revenda cria cliente isolado com empresa inicial e sem humano, senha, convite, contrato ou acesso operacional', t => {
  const { db, accounts, partner } = fixture(t), before = db.prepare('SELECT count(*) AS n FROM auth_users').get().n;
  const { account, replayed } = accounts.create(partner, input());
  assert.equal(replayed, false); assert.match(account.id, /^reseller_[0-9a-f-]{36}$/);
  assert.equal(account.accountKind, 'business'); assert.equal(account.parentWorkspaceId, 'partner-a'); assert.equal(account.createdAt, '2026-10-03T12:00:00.000Z');
  assert.deepEqual(account.counts, { tenants: 1, users: 0, admins: 0, channels: 0, connectedChannels: 0, agents: 0, activeAgents: 0 });
  assert.deepEqual(account.onboarding, { companyCreated: true, administratorActive: false, channelConnected: false, teamReady: false, contractConfigured: false });
  const company = db.prepare('SELECT * FROM tenants WHERE reseller_id=?').get(account.id), data = JSON.parse(company.data);
  assert.match(company.id, /^tenant_[0-9a-f-]{36}$/); assert.equal(data.name, 'Matriz QA'); assert.equal(data.segment, 'Serviços QA');
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM billing_contracts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM qa_operational_access').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM qa_projection_queue WHERE tenant_id=?').get(company.id).n, 2);
  assert.throws(() => accounts.current({ ...partner, resellerId: account.id }), status(403));
});

test('plataforma cria revenda e clientes diretos ou da revenda com parent validado', t => {
  const { accounts, platform } = fixture(t);
  const reseller = accounts.create(platform, input({ accountKind: 'reseller', parentWorkspaceId: 'mep-demo' })).account;
  assert.equal(reseller.accountKind, 'reseller'); assert.equal(reseller.parentWorkspaceId, 'mep-demo');
  const direct = accounts.create(platform, input({ parentWorkspaceId: 'mep-demo' })).account;
  assert.equal(direct.accountKind, 'business'); assert.equal(direct.parentWorkspaceId, 'mep-demo');
  assert.equal(accounts.create(platform, input({ parentWorkspaceId: reseller.id })).account.parentWorkspaceId, reseller.id);
  assert.throws(() => accounts.create(platform, input({ accountKind: 'reseller', parentWorkspaceId: 'partner-a' })), status(400));
  assert.throws(() => accounts.create(platform, input({ parentWorkspaceId: 'business-a' })), status(400));
});

test('revenda não cria revenda, não usa parent de outro fornecedor e cliente não cria filhos', t => {
  const { accounts, partner, business, db } = fixture(t), count = db.prepare('SELECT count(*) AS n FROM resellers').get().n;
  for (const [who, values] of [[partner, { accountKind: 'reseller', parentWorkspaceId: 'mep-demo' }], [partner, { parentWorkspaceId: 'partner-b' }], [partner, { parentWorkspaceId: 'mep-demo' }], [business, { parentWorkspaceId: 'business-a' }]]) assert.throws(() => accounts.create(who, input(values)), status(403));
  assert.equal(db.prepare('SELECT count(*) AS n FROM resellers').get().n, count);
});

test('criação valida todos os campos e rejeita elevação, espaços, dados de usuário e parent inexistente', t => {
  const { accounts, partner } = fixture(t);
  for (const values of [{ accountKind: 'platform' }, { requestId: '' }, { requestId: 'bad\n' }, { parentWorkspaceId: null }, { name: '' }, { name: 'x'.repeat(81) }, { name: 'x\n' }, { initialTenantName: '' }, { segment: '' }, { users: [] }, { password: 'should-not-save' }, { id: 'hijack' }, { platformAdmin: true }]) assert.throws(() => accounts.create(partner, input(values)), status(400));
  assert.throws(() => accounts.create(partner, input({ parentWorkspaceId: 'missing' })), status(404));
});

test('mesmo request cria uma conta apenas e payload distinto com mesmo ID retorna conflito', t => {
  const { db, accounts, partner } = fixture(t), body = input(), first = accounts.create(partner, body), next = accounts.create(partner, { ...body });
  assert.equal(first.replayed, false); assert.equal(next.replayed, true); assert.deepEqual(first.account, next.account);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_requests').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 1);
  for (const values of [{ name: 'Diferente' }, { initialTenantName: 'Filial' }, { segment: 'Outro' }, { parentWorkspaceId: 'partner-a', accountKind: 'business', name: 'Outra' }]) assert.throws(() => accounts.create(partner, { ...body, ...values }), status(409));
  const retry = accounts.create(partner, { ...body, name: ' Cliente QA ' }); assert.equal(retry.replayed, true);
  const request = db.prepare('SELECT * FROM commercial_account_requests').get(); assert.match(request.payload_hash, /^[a-f0-9]{64}$/); assert.equal(Object.hasOwn(request, 'payload'), false);
});

test('request é isolado por criador e workspace e retry verifica autoridade e linhagem frescas', t => {
  const { db, accounts, partner, platform } = fixture(t), body = input(), first = accounts.create(partner, body);
  const other = accounts.create(platform, body); assert.notEqual(first.account.id, other.account.id);
  db.prepare("UPDATE qa_users SET role='operator' WHERE id=?").run(partner.userId);
  assert.throws(() => accounts.create(partner, body), status(403));
  db.prepare("UPDATE qa_users SET role='reseller' WHERE id=?").run(partner.userId);
  const data = JSON.parse(db.prepare('SELECT data FROM resellers WHERE id=?').get(first.account.id).data); data.parentWorkspaceId = 'partner-b';
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), first.account.id);
  assert.throws(() => accounts.create(partner, body), status(404));
});

test('criação revalida depois de BEGIN e revogação no intervalo não deixa conta parcial', t => {
  const { db, store, options, partner } = fixture(t); let calls = 0;
  const accounts = new CommercialAccounts(store, { ...options, validateActor(candidate) { if (++calls === 2) throw Object.assign(new Error('Autoridade mudou'), { status: 403 }); return options.validateActor(candidate); } });
  const before = db.prepare('SELECT * FROM resellers').all(); assert.throws(() => accounts.create(partner, input()), status(403));
  assert.deepEqual(db.prepare('SELECT * FROM resellers').all(), before); assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_requests').get().n, 0);
});

test('falha na provisão, fila ou IDs devolvidos reverte workspace, empresa, auditoria e request', t => {
  const { db, store, options, partner } = fixture(t), before = db.prepare('SELECT count(*) AS n FROM resellers').get().n;
  const original = store.provisionReseller, queue = store.queuePostgres;
  for (const variant of ['provision', 'queue', 'wrong-id']) {
    store.queuePostgres = variant === 'queue' ? () => { throw new Error('Projeção recusada'); } : queue;
    store.provisionReseller = function (...args) { const result = original.apply(this, args); if (variant === 'provision') throw new Error('Provisão recusada'); return variant === 'wrong-id' ? { ...result, resellerId: 'wrong' } : result; };
    const accounts = new CommercialAccounts(store, options); assert.throws(() => accounts.create(partner, input()));
    assert.equal(db.prepare('SELECT count(*) AS n FROM resellers').get().n, before); assert.equal(db.prepare('SELECT count(*) AS n FROM tenants').get().n, 4);
    for (const table of ['commercial_account_requests', 'commercial_account_audit', 'qa_projection_queue']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
});

test('validador, persistência e relógio assíncronos são recusados antes de commit', t => {
  const { db, store, options, partner } = fixture(t), before = db.prepare('SELECT count(*) AS n FROM resellers').get().n;
  for (const override of [{ validateActor: async value => options.validateActor(value) }, { isPlatformAdmin: async () => false }, { now: async () => Date.now() }]) {
    const accounts = new CommercialAccounts(store, { ...options, ...override }); assert.throws(() => accounts.create(partner, input()), status(500));
  }
  store.provisionReseller = async () => { throw new Error('Assíncrono negado'); };
  assert.throws(() => new CommercialAccounts(store, options).create(partner, input()), status(500));
  assert.equal(db.prepare('SELECT count(*) AS n FROM resellers').get().n, before);
});

test('CAS de renomear preserva marca, identidade, parent, valores desconhecidos e fila; revisão antiga não escreve', t => {
  const { db, accounts, partner } = fixture(t), previous = JSON.parse(db.prepare('SELECT data FROM resellers WHERE id=?').get('partner-a').data);
  // Existing records may have noncanonical whitespace; compare the exact persisted representation.
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(previous, null, 2), 'partner-a');
  const { account } = accounts.update(partner, 'partner-a', { version: 1, name: 'Nova Águia' });
  assert.equal(account.version, 2); assert.equal(account.name, 'Nova Águia');
  const persisted = JSON.parse(db.prepare('SELECT data FROM resellers WHERE id=?').get('partner-a').data);
  assert.deepEqual(persisted, { ...previous, name: 'Nova Águia', version: 2 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM qa_projection_queue').get().n, 1);
  assert.throws(() => accounts.update(partner, 'partner-a', { version: 1, name: 'Perdido' }), status(409));
  const unchanged = accounts.update(partner, 'partner-a', { version: 2, name: 'Nova Águia' }); assert.equal(unchanged.account.version, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 1);
});

test('renomear conta não permite converter tipo, mover parent ou editar marca ou operação', t => {
  const { accounts, partner, business } = fixture(t);
  for (const values of [{ accountKind: 'reseller' }, { parentWorkspaceId: 'partner-b' }, { brand: {} }, { channels: [] }, { version: 0 }, { name: '' }]) assert.throws(() => accounts.update(partner, 'business-a', { version: 2, name: 'Cliente', ...values }), status(400));
  assert.equal(accounts.update(partner, 'business-a', { version: 2, name: 'Cliente filho' }).account.version, 3);
  assert.equal(accounts.update(business, 'business-a', { version: 3, name: 'Meu cliente' }).account.version, 4);
  assert.throws(() => accounts.update(business, 'business-b', { version: 1, name: 'Intruso' }), status(404));
});

test('falha na fila da renomeação conserva nome, versão e auditoria e permite retry', t => {
  const { accounts, db, store, partner } = fixture(t), previous = db.prepare('SELECT data FROM resellers WHERE id=?').get('partner-a').data, queue = store.queuePostgres;
  store.queuePostgres = () => { throw new Error('Fila indisponível'); };
  assert.throws(() => accounts.update(partner, 'partner-a', { version: 1, name: 'Nome novo' }));
  assert.equal(db.prepare('SELECT data FROM resellers WHERE id=?').get('partner-a').data, previous);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
  store.queuePostgres = queue; assert.equal(accounts.update(partner, 'partner-a', { version: 1, name: 'Nome novo' }).account.version, 2);
});

test('checklist usa só valores persistidos reais, não confunde sandbox com conexão ou adaptador planejado com ativo', t => {
  const { accounts, db, partner, insertTenant } = fixture(t);
  insertTenant('second-company-a', 'partner-a', { channels: [{ state: 'connected' }, { state: 'sandbox' }, { state: 'configured' }, { state: 'disconnected' }], agents: [{ configured: true }, { configured: false }, { configured: 'true' }, { state: 'planned' }] });
  db.prepare('INSERT INTO auth_users VALUES (?,?,?,?,?,?,?)').run('disabled-admin', 'partner-a', 'reseller', 1, 'secret', 'secret', 'secret');
  const dto = accounts.current(partner);
  assert.deepEqual(dto.counts, { tenants: 2, users: 2, admins: 1, channels: 4, connectedChannels: 1, agents: 4, activeAgents: 1 });
  assert.deepEqual(dto.onboarding, { companyCreated: true, administratorActive: true, channelConnected: true, teamReady: true, contractConfigured: false });
  db.prepare('INSERT INTO billing_contracts VALUES (?,?,?)').run('inactive', 'partner-a', 'suspended'); assert.equal(accounts.current(partner).onboarding.contractConfigured, false);
  db.prepare('INSERT INTO billing_contracts VALUES (?,?,?)').run('foreign', 'partner-b', 'active'); assert.equal(accounts.current(partner).onboarding.contractConfigured, false);
  db.prepare('INSERT INTO billing_contracts VALUES (?,?,?)').run('active', 'partner-a', 'active'); assert.equal(accounts.current(partner).onboarding.contractConfigured, true);
});

test('tabelas opcionais ausentes e coleções desconhecidas retornam false e zero, sem inferir configuração', t => {
  const { accounts, partner, db, insertTenant } = fixture(t, { optionalTables: false });
  insertTenant('unknown', 'partner-a', { channels: null, agents: { configured: true } });
  const dto = accounts.current(partner); assert.equal(dto.counts.users, 0); assert.equal(dto.counts.admins, 0); assert.equal(dto.counts.channels, 0); assert.equal(dto.counts.agents, 0);
  assert.equal(dto.onboarding.administratorActive, false); assert.equal(dto.onboarding.teamReady, false); assert.equal(dto.onboarding.contractConfigured, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, 0);
});

test('autorizar convite administrativo é puro, usa relação comercial fresca e não abre workspace operacional', t => {
  const { accounts, db, platform, partner, business } = fixture(t), before = db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n;
  const result = accounts.authorizeAdministration(partner, 'business-a'); assert.equal(result.actor.resellerId, 'partner-a'); assert.equal(result.account.id, 'business-a');
  assert.equal(accounts.authorizeAdministration(platform, 'business-b').account.id, 'business-b');
  assert.equal(accounts.authorizeAdministration(business, 'business-a').account.id, 'business-a');
  assert.throws(() => accounts.authorizeAdministration(partner, 'business-b'), status(404));
  assert.throws(() => accounts.authorizeAdministration({ ...platform, supportGrantId: 'grant' }, 'business-a'), status(403));
  assert.equal(db.prepare('SELECT count(*) AS n FROM qa_operational_access').get().n, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n, before);
  db.prepare('UPDATE qa_users SET disabled=1 WHERE id=?').run(partner.userId); assert.throws(() => accounts.authorizeAdministration(partner, 'business-a'), status(403));
});

test('auth real conserva privilégios originais e recusa trocar para novo cliente criado pelo fornecedor', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);`);
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('mep-demo', JSON.stringify({ name: 'Plataforma sintética' }));
  const auth = new Auth(db), owner = await auth.setup({ name: 'Admin QA', username: 'admin.qa', email: 'admin@example.test', password: 'QA-' + randomBytes(16).toString('hex') });
  const store = { db, provisionReseller: Store.prototype.provisionReseller }, accounts = new CommercialAccounts(store, { validateActor: value => auth.resolveActor(value), isPlatformAdmin: value => auth.isPlatformAdmin(value) });
  const created = accounts.create(owner.actor, input({ parentWorkspaceId: 'mep-demo' })).account;
  assert.equal(auth.resolveActor(owner.actor).platformAdmin, true); assert.equal(auth.resolveActor(owner.actor).resellerId, 'mep-demo');
  assert.throws(() => auth.workspaceActor(owner.actor, created.id), status(403));
  assert.equal(auth.workspaces(owner.actor).some(workspace => workspace.id === created.id), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n, 1);
});

test('principal com home em cliente e grant explícito na plataforma conta uma pessoa por conta e uma no resumo global', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);`);
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('mep-demo', JSON.stringify({ name: 'Plataforma sintética' }));
  db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('platform-unit', 'mep-demo', JSON.stringify({ name: 'Unidade principal', channels: [{ id: 'channel', state: 'connected' }], agents: [{ id: 'agent', configured: true }], conversations: [] }));
  const store = { db, provisionReseller: Store.prototype.provisionReseller }, auth = new Auth(db);
  const signed = await auth.register({ name: 'Principal QA', company: 'Home do principal', email: 'principal@example.test', password: 'QA-' + randomBytes(16).toString('hex') }, { provision: value => store.provisionReseller(value) });
  assert.notEqual(signed.actor.resellerId, 'mep-demo');
  auth.promoteFirstPlatformAdmin({ userId: signed.actor.userId, expectedEmail: 'principal@example.test', expectedResellerId: signed.actor.resellerId });
  const selected = auth.workspaceActor(auth.authenticate(signed.token), 'mep-demo');
  assert.equal(selected.platformAdmin, true); assert.equal(selected.resellerId, 'mep-demo');
  const accounts = new CommercialAccounts(store, { validateActor: value => auth.resolveActor(value), isPlatformAdmin: value => auth.isPlatformAdmin(value) });
  const child = accounts.create(selected, input({ parentWorkspaceId: 'mep-demo' })).account;
  db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,?)').run(signed.actor.userId, child.id, Date.now());
  db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,?)').run(signed.actor.userId, signed.actor.resellerId, Date.now());
  assert.equal(accounts.current(selected).counts.users, 1); assert.equal(accounts.current(selected).counts.admins, 1); assert.equal(accounts.current(selected).onboarding.administratorActive, true);
  assert.equal(accounts.overview(selected, signed.actor.resellerId).counts.users, 1); assert.equal(accounts.overview(selected, child.id).counts.users, 1);
  const homeTenant = db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(signed.actor.resellerId).id;
  const operator = await auth.createUser(auth.workspaceActor(selected, signed.actor.resellerId), { name: 'Operador QA', username: 'count.operator', password: 'QA-' + randomBytes(16).toString('hex'), role: 'operator', tenantIds: [homeTenant] });
  // A row without platform authority cannot turn a directory entry into access.
  db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,?)').run(operator.id, 'mep-demo', Date.now());
  assert.equal(accounts.current(selected).counts.users, 1);
  assert.throws(() => auth.workspaceActor({ userId: operator.id, resellerId: signed.actor.resellerId }, 'mep-demo'), status(403));
  const listed = accounts.list(selected, { view: 'platform', q: 'no match', limit: 1 });
  assert.equal(listed.total, 0); assert.equal(listed.summary.activeUsers, 2); assert.equal(listed.summary.connectedChannels, 1); assert.equal(listed.summary.activeAgents, 1);
  assert.equal(accounts.list(selected, { view: 'platform' }).accounts.reduce((sum, item) => sum + item.counts.users, 0), 4);
  db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), signed.actor.userId);
  assert.equal(accounts.counts('mep-demo').users, 0); assert.equal(accounts.counts(child.id).admins, 0);
});
