import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Store } from '../src/store.js';
import { CommercialAccounts } from '../src/commercial-accounts.js';
import { PostgresBridge, commercialMetadataSnapshot } from '../src/postgres-bridge.js';

const migrationPath = new URL('../db/008-commercial-accounts.sql', import.meta.url);
const actor = { userId: 'synthetic-commercial-admin', role: 'reseller', resellerId: 'mep-demo', name: 'Admin sintético' };
const enabled = process.env.MEPCHAT_TEST_PG_COMMERCIAL === '1';
function localUrl(value) {
  if (!value) throw new Error('Commercial tests require explicit local PostgreSQL fixture URLs.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/mepchat' || !['15438', '5432'].includes(url.port || '5432')) throw new Error('Commercial tests require the explicit local mepchat fixture.');
  return value;
}
function localFixture(t) {
  const store = new Store(':memory:');
  const calls = [], transport = { async sync(job) { calls.push(job); }, async close() {} };
  const bridge = new PostgresBridge(store, { transport });
  t.after(async () => { await bridge.close(); store.close(); });
  return { store, bridge, calls };
}

test('projeção comercial mantém somente campos públicos, unidade e defaults virtuais do legado', () => {
  const source = { id: 'tenant-a', resellerId: 'mep-demo', reseller: { name: 'Elozi', brand: { name: 'Elozi', accent: '#3157d5', logo: { credentials: 'private-nested-marker' }, apiKey: 'private-brand-marker' }, token: 'private-account-marker' }, parentTenantId: null, identityVersion: 2 };
  const projected = commercialMetadataSnapshot(source);
  assert.deepEqual(projected.commercialAccount, { id: 'mep-demo', name: 'Elozi', accountKind: 'platform', parentWorkspaceId: null, version: 1, createdAt: null });
  assert.deepEqual(projected.unit, { parentTenantId: null, identityVersion: 2 });
  assert.deepEqual(projected.reseller, { name: 'Elozi', brand: { name: 'Elozi', accent: '#3157d5' } });
  assert.equal(Object.hasOwn(projected, 'parentTenantId'), false); assert.equal(Object.hasOwn(projected, 'identityVersion'), false);
  assert.equal(JSON.stringify(projected).includes('private-'), false);
  const legacy = commercialMetadataSnapshot({ id: 'legacy-company', resellerId: 'legacy-partner', reseller: { name: 'Legado' } });
  assert.equal(legacy.commercialAccount.accountKind, 'reseller'); assert.equal(legacy.commercialAccount.parentWorkspaceId, null);
  assert.deepEqual(legacy.unit, { parentTenantId: null, identityVersion: 1 });
});

test('campos conhecidos inválidos permanecem explícitos para rejeição SQL e valores não ampliam a whitelist', () => {
  const projected = commercialMetadataSnapshot({ id: 'tenant-a', resellerId: 'account-a', reseller: { name: 'A', accountKind: 'bad', parentWorkspaceId: 7, version: null, createdAt: {}, permissions: ['*'] }, parentTenantId: 3, identityVersion: 0 });
  assert.deepEqual(projected.commercialAccount, { id: 'account-a', name: 'A', accountKind: 'bad', parentWorkspaceId: 7, version: null, createdAt: {} });
  assert.deepEqual(projected.unit, { parentTenantId: 3, identityVersion: 0 });
  assert.equal(Object.hasOwn(projected.commercialAccount, 'permissions'), false);
});

test('fila publica conta comercial e filial corretas sem requests, atores, credenciais ou mudanças no SQLite', async t => {
  const { store, bridge, calls } = localFixture(t);
  const accounts = new CommercialAccounts(store, { validateActor: value => value, isPlatformAdmin: () => true });
  const created = accounts.create(actor, { requestId: randomUUID(), name: 'Cliente comercial QA', accountKind: 'business', parentWorkspaceId: 'mep-demo', initialTenantName: 'Matriz QA', segment: 'QA' }).account;
  const tenant = store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(created.id);
  const customerActor = { ...actor, resellerId: created.id };
  const branch = store.createTenant(customerActor, { name: 'Filial QA', segment: 'QA', parentTenantId: tenant.id });
  const raw = JSON.parse(store.db.prepare('SELECT data FROM resellers WHERE id=?').get(created.id).data);
  raw.secret = 'private-account-marker'; raw.brand.credentials = 'private-brand-marker';
  store.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(raw), created.id);
  bridge.queue(branch.id);
  const before = store.db.prepare('SELECT data FROM resellers WHERE id=?').get(created.id).data;
  const snapshot = JSON.parse(store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(branch.id).payload);
  assert.deepEqual(snapshot.commercialAccount, { id: created.id, name: created.name, accountKind: 'business', parentWorkspaceId: 'mep-demo', version: 1, createdAt: created.createdAt });
  assert.deepEqual(snapshot.unit, { parentTenantId: tenant.id, identityVersion: 1 });
  for (const privateValue of ['private-account-marker', 'private-brand-marker', actor.userId, 'commercial_account_requests', 'commercial_account_audit', 'payload_hash']) assert.equal(JSON.stringify(snapshot).includes(privateValue), false);
  assert.equal(store.db.prepare('SELECT data FROM resellers WHERE id=?').get(created.id).data, before);
  await bridge.flush(); assert.equal(bridge.status().pending, 0);
  assert.deepEqual(JSON.parse(calls.find(item => item.tenantId === branch.id).payload).unit, snapshot.unit);
});

test('renomeação comercial enfileira versão nova para todas as unidades, sem mudar parent ou identidade', t => {
  const { store, bridge } = localFixture(t), accounts = new CommercialAccounts(store, { validateActor: value => value, isPlatformAdmin: () => true });
  const created = accounts.create(actor, { requestId: randomUUID(), name: 'Cliente QA', accountKind: 'business', parentWorkspaceId: 'mep-demo' }).account;
  const tenant = store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(created.id), customerActor = { ...actor, resellerId: created.id };
  store.createTenant(customerActor, { name: 'Filial QA', segment: 'QA', parentTenantId: tenant.id });
  accounts.update(actor, created.id, { version: 1, name: 'Cliente renomeado' });
  const jobs = store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id IN (SELECT id FROM tenants WHERE reseller_id=?)').all(created.id);
  assert.equal(jobs.length, 2);
  for (const job of jobs) { const metadata = JSON.parse(job.payload).commercialAccount; assert.equal(metadata.name, 'Cliente renomeado'); assert.equal(metadata.version, 2); assert.equal(metadata.parentWorkspaceId, 'mep-demo'); }
  assert.equal(bridge.status().pending, 2);
});

test('008 mantém a cadeia 007, wrappers restritos, replay e whitelists sem qualquer DDL de acesso', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /RENAME TO sync_workspace_base_007/); assert.match(sql, /valid_knowledge_source\(jsonb\)/); assert.match(sql, /valid_knowledge_pin\(jsonb,boolean\)/);
  assert.match(sql, /result:=mepchat_private\.sync_workspace_base_007\(snapshot,source_id,revision\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION mepchat_private\.sync_workspace_base_007\(jsonb,text,bigint\) FROM PUBLIC,mepchat_app/);
  assert.match(sql, /current_user<>'supabase_admin' OR session_user<>'mepchat_app'/);
  assert.match(sql, /SECURITY DEFINER SET search_path=pg_catalog/);
  assert.match(sql, /IF result->>'state' IS DISTINCT FROM 'synced' THEN RETURN result; END IF/);
  assert.ok(sql.indexOf("IF result->>'state'") < sql.indexOf('mepchat_private.valid_commercial_account(account)'));
  assert.match(sql, /ELSE previous_account END/); assert.match(sql, /ELSE previous_unit END/);
  assert.match(sql, /name NOT IN \('id','name','accountKind','parentWorkspaceId','version','createdAt'\)/);
  assert.match(sql, /name NOT IN \('parentTenantId','identityVersion'\)/);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|CREATE TABLE)\s+(?:mepchat_private\.)?(?:tenant_memberships|reseller_memberships|principal_state|auth_identities)/i);
  assert.doesNotMatch(sql, /CREATE POLICY|ALTER POLICY|BYPASSRLS|GRANT .* ON (?:TABLE|SCHEMA)/i);
});

test('opt-in PostgreSQL comercial recusa URL VPS, porta arbitrária ou banco diferente antes de conectar', () => {
  for (const value of ['postgresql://user@vps.example.test:5432/mepchat', 'postgresql://user@127.0.0.1:49555/mepchat', 'postgresql://user@localhost:5432/production', 'https://localhost/mepchat', '']) assert.throws(() => localUrl(value));
  assert.equal(localUrl('postgresql://mepchat_app@127.0.0.1:5432/mepchat'), 'postgresql://mepchat_app@127.0.0.1:5432/mepchat');
});

function snapshot() {
  const id = 'tenant_' + randomUUID(), resellerId = 'reseller_' + randomUUID(), date = new Date().toISOString(), channelId = randomUUID(), conversationId = randomUUID();
  return { id, resellerId, name: 'Matriz sintética', segment: 'QA', plan: 'Local', brand: {}, reseller: { name: 'Cliente comercial sintético', brand: {} },
    commercialAccount: { id: resellerId, name: 'Cliente comercial sintético', accountKind: 'business', parentWorkspaceId: 'mep-demo', version: 1, createdAt: date }, unit: { parentTenantId: null, identityVersion: 1 },
    channels: [{ id: channelId, kind: 'telegram', name: 'Canal sintético', state: 'planned' }], agents: [], flows: [], runs: [], audit: [], outbox: [], contacts: [], departments: [], defaultDepartmentId: null,
    automation: { version: 1, bindings: [], sla: { enabled: false, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, updatedAt: date }, mcpServers: [], knowledgeSources: [],
    conversations: [{ id: conversationId, channelId, contact: 'Pessoa sintética', status: 'open', owner: 'queue', version: 1, unread: 1, updatedAt: date,
      messages: [{ id: randomUUID(), kind: 'customer', text: 'Mensagem sintética', delivery: 'received', createdAt: date }] }] };
}

// Reuses the existing CI PostgreSQL service after 007. No service or database is
// created here; data are synthetic, URLs are local, and the app retains its RLS.
test('PostgreSQL comercial: 008 idempotente, isolamento, replay, legado e rollback completo', {
  skip: !enabled && 'MEPCHAT_TEST_PG_COMMERCIAL=1 é opt-in; exige fixture local com 007'
}, async t => {
  const app = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_URL), max: 3 }), admin = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_ADMIN_URL), max: 1 });
  t.after(async () => { await Promise.all([app.end(), admin.end()]); });
  const { rows: [capability] } = await admin.query("SELECT source_id FROM mepchat_private.reseller_sources WHERE reseller_id='mep-demo'");
  assert.ok(capability, 'Execute a cadeia até 007 na fixture sintética antes desta suíte.');
  const source = capability.source_id, a = snapshot(), b = snapshot(); b.commercialAccount.accountKind = 'reseller'; a.commercialAccount.parentWorkspaceId = b.resellerId;
  const migration = (await readFile(migrationPath, 'utf8')).replace(/\r\n/g, '\n');
  async function apply() { const client = await admin.connect(); try { await client.query(migration); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async function scoped(data, fn, options = {}) {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('mepchat.user_id',$1,true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$3,true)", [options.user ?? 'mepchat-local-bridge', options.resellerId ?? data.resellerId, options.tenantId ?? data.id]);
      const result = await fn(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const sync = (data, revision = 1, options = {}) => scoped(data, async client => {
    if (options.provision !== false) await client.query('SELECT mepchat_private.provision_reseller($1,$2,$3)', [data.resellerId, data.id, options.source ?? source]);
    return (await client.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,$3::bigint) AS result', [JSON.stringify(data), options.source ?? source, revision])).rows[0].result;
  }, options);
  async function persisted(data) {
    const { rows: [tenant] } = await admin.query('SELECT name,settings FROM mepchat.tenants WHERE id=$1', [data.id]);
    const { rows: [bridge] } = await admin.query('SELECT revision::text FROM mepchat_private.bridge_state WHERE tenant_id=$1', [data.id]);
    const { rows: [message] } = await admin.query('SELECT content FROM mepchat.messages WHERE tenant_id=$1 AND id=$2', [data.id, data.conversations[0].messages[0].id]);
    return { tenant, bridge, message };
  }
  const functions = () => admin.query(`SELECT p.oid::text,p.proname,p.prosecdef,r.rolname AS owner,p.proconfig,md5(p.prosrc) AS body,
    has_function_privilege('mepchat_app',p.oid,'EXECUTE') AS app,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='mepchat_private'
    AND p.proname IN ('sync_workspace','sync_workspace_base_003','sync_workspace_base_004','sync_workspace_base_005','sync_workspace_base_006','sync_workspace_base_007',
      'valid_automation_calendar','valid_knowledge_source','valid_knowledge_pin','valid_commercial_account','valid_unit_metadata') ORDER BY p.proname`);

  await t.test('008 preserva corpo 007 e reaplica com OIDs, privilégios e search_path estáveis', async () => {
    const previous = await functions(), knowledge = previous.rows.find(row => row.proname === 'sync_workspace_base_007') ?? previous.rows.find(row => row.proname === 'sync_workspace');
    await apply(); const before = await functions(); await apply(); const after = await functions();
    assert.equal(after.rows.length, 11); assert.deepEqual(after.rows, before.rows);
    assert.equal(after.rows.find(row => row.proname === 'sync_workspace_base_007').body, knowledge.body);
    for (const name of ['sync_workspace_base_003', 'sync_workspace_base_004', 'sync_workspace_base_005', 'sync_workspace_base_006', 'valid_automation_calendar', 'valid_knowledge_source', 'valid_knowledge_pin']) assert.deepEqual(after.rows.find(row => row.proname === name), previous.rows.find(row => row.proname === name));
    for (const fn of after.rows) { assert.equal(fn.owner, 'supabase_admin'); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog']); assert.equal(fn.public, false); assert.equal(fn.app, fn.proname === 'sync_workspace'); assert.equal(fn.prosecdef, fn.proname.startsWith('sync_workspace')); }
    for (const name of ['sync_workspace_base_003', 'sync_workspace_base_004', 'sync_workspace_base_005', 'sync_workspace_base_006', 'sync_workspace_base_007']) await assert.rejects(app.query(`SELECT mepchat_private.${name}($1::jsonb,$2,1)`, [JSON.stringify(a), source]), error => error.code === '42501');
    for (const name of ['valid_commercial_account', 'valid_unit_metadata']) await assert.rejects(app.query(`SELECT mepchat_private.${name}($1::jsonb)`, [JSON.stringify(a.commercialAccount)]), error => error.code === '42501');
  });
  await t.test('capability privada, app sem SUPER/BYPASS/membership e 18 tabelas FORCE RLS permanecem', async () => {
    await assert.rejects(app.query('SELECT * FROM mepchat_private.reseller_sources'), error => error.code === '42501');
    const { rows: [role] } = await app.query("SELECT rolsuper,rolbypassrls,pg_has_role(current_user,'mepchat_owner','MEMBER') AS owner_member,pg_has_role(current_user,'supabase_admin','MEMBER') AS admin_member FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, owner_member: false, admin_member: false });
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mepchat' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity")).rows[0].n, 18);
    await assert.rejects(admin.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,1)', [JSON.stringify(a), source]), /Commercial bridge context denied/);
  });
  await t.test('matriz e revenda projetam só metadata, preservando CRM, automation, MCP e knowledge', async () => {
    for (const data of [b, a]) {
      assert.equal((await sync(data)).state, 'synced'); const saved = await persisted(data);
      assert.deepEqual(saved.tenant.settings.commercialAccount, data.commercialAccount); assert.deepEqual(saved.tenant.settings.unit, data.unit);
      for (const field of ['contacts', 'departments', 'defaultDepartmentId', 'automation', 'mcpServers', 'knowledgeSources']) assert.deepEqual(saved.tenant.settings[field], data[field]);
      assert.equal(saved.message.content.text, data.conversations[0].messages[0].text);
    }
  });
  await t.test('admin lista unidades próprias; operador não herda matriz/filial nem acesso pelo parent comercial', async () => {
    const branch = snapshot(); branch.resellerId = a.resellerId; branch.reseller = structuredClone(a.reseller); branch.commercialAccount = structuredClone(a.commercialAccount); branch.unit.parentTenantId = a.id;
    assert.equal((await sync(branch)).state, 'synced'); assert.deepEqual((await persisted(branch)).tenant.settings.unit, branch.unit);
    assert.equal((await app.query('SELECT count(*)::int AS n FROM mepchat.tenants')).rows[0].n, 0);
    for (const [own, other] of [[a, b], [b, a], [branch, a]]) {
      // 003 provisions the bridge as account admin. tenant_read intentionally
      // lists its own account's units through reseller_access; the hierarchy
      // does not authorize any other account or widen message tenant_access.
      const expected = own.resellerId === a.resellerId ? [a.id, branch.id] : [b.id];
      const rows = await scoped(own, client => client.query('SELECT id FROM mepchat.tenants')); assert.deepEqual(rows.rows.map(row => row.id).sort(), expected.sort());
      const hidden = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.messages WHERE tenant_id=$1', [other.id])); assert.equal(hidden.rows[0].n, 0);
      const forged = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.tenants'), { user: 'forged-principal' }); assert.equal(forged.rows[0].n, 0);
    }
    for (const [own, sibling] of [[a, branch], [branch, a]]) {
      const user = 'commercial-operator-' + randomUUID();
      // A tenant membership is the PG equivalent of an explicitly assigned
      // operator tenant. No reseller membership or administrative role exists.
      await admin.query('INSERT INTO mepchat.users(id,display_name) VALUES ($1,$2)', [user, 'Operador sintético da unidade']);
      await admin.query("INSERT INTO mepchat_private.tenant_memberships(tenant_id,user_id,role,active) VALUES ($1,$2,'operator',true)", [own.id, user]);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM mepchat_private.reseller_memberships WHERE user_id=$1', [user])).rows[0].n, 0);
      const rows = await scoped(own, client => client.query('SELECT id FROM mepchat.tenants'), { user }); assert.deepEqual(rows.rows.map(row => row.id), [own.id]);
      const messages = await scoped(own, client => client.query('SELECT DISTINCT tenant_id FROM mepchat.messages'), { user }); assert.deepEqual(messages.rows.map(row => row.tenant_id), [own.id]);
      for (const inaccessible of [sibling, b]) {
        const hidden = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.messages WHERE tenant_id=$1', [inaccessible.id]), { user }); assert.equal(hidden.rows[0].n, 0);
        // Selecting an unassigned tenant or even forging its account GUC does
        // not substitute a membership, despite the known parent relationship.
        const selected = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.tenants'), { user, tenantId: inaccessible.id, resellerId: inaccessible.resellerId }); assert.equal(selected.rows[0].n, 0);
        const selectedMessages = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.messages'), { user, tenantId: inaccessible.id, resellerId: inaccessible.resellerId }); assert.equal(selectedMessages.rows[0].n, 0);
      }
    }
    const bad = structuredClone(a); bad.unit.parentTenantId = b.id;
    const before = await persisted(a); await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(a), before);
  });
  await t.test('replay antigo ignora metadata malformada e runtime degradado não apaga relações mais novas', async () => {
    const newer = structuredClone(a); newer.commercialAccount.name = 'Cliente renomeado'; newer.commercialAccount.version = 2; newer.unit.identityVersion = 2;
    assert.equal((await sync(newer, 2)).state, 'synced'); const before = await persisted(a);
    assert.equal((await sync({ ...a, commercialAccount: null, unit: null }, 1)).state, 'already_synced'); assert.deepEqual(await persisted(a), before);
    assert.equal((await sync({ ...a, commercialAccount: {}, unit: {} }, 2)).state, 'already_synced'); assert.deepEqual(await persisted(a), before);
    const legacy = structuredClone(a); delete legacy.commercialAccount; delete legacy.unit; legacy.name = 'Runtime anterior compatível';
    assert.equal((await sync(legacy, 3)).state, 'synced'); const saved = await persisted(a);
    assert.deepEqual(saved.tenant.settings.commercialAccount, before.tenant.settings.commercialAccount); assert.deepEqual(saved.tenant.settings.unit, before.tenant.settings.unit);
    const legacyFresh = snapshot(); delete legacyFresh.commercialAccount; delete legacyFresh.unit;
    assert.equal((await sync(legacyFresh)).state, 'synced'); const fresh = await persisted(legacyFresh); assert.equal(Object.hasOwn(fresh.tenant.settings, 'commercialAccount'), false); assert.equal(Object.hasOwn(fresh.tenant.settings, 'unit'), false);
  });
  await t.test('metadata comercial inválida reverte mensagem, tenant, cadeia 007 e avanço de revisão', async () => {
    const before = await persisted(b), metadata = b.commercialAccount;
    const invalid = [null, {}, [], { ...metadata, id: a.resellerId }, { ...metadata, id: '' }, { ...metadata, name: '' }, { ...metadata, name: 'x'.repeat(81) }, { ...metadata, name: 'bad\nname' },
      { ...metadata, accountKind: 'admin' }, { ...metadata, accountKind: 1 }, { ...metadata, version: 0 }, { ...metadata, version: 1.5 }, { ...metadata, version: 9007199254740992 },
      { ...metadata, parentWorkspaceId: {} }, { ...metadata, parentWorkspaceId: '' }, { ...metadata, parentWorkspaceId: metadata.id }, { ...metadata, accountKind: 'platform', parentWorkspaceId: 'mep-demo' },
      { ...metadata, createdAt: {} }, { ...metadata, createdAt: 'not-a-date' }, { ...metadata, createdAt: '2026-13-01T00:00:00Z' }];
    for (const field of ['token', 'credentials', 'grants', 'permissions', 'users', 'supportGrantId', 'price']) invalid.push({ ...metadata, [field]: { nested: 'private-marker' } });
    for (const field of ['id', 'name', 'accountKind', 'parentWorkspaceId', 'version', 'createdAt']) { const incomplete = structuredClone(metadata); delete incomplete[field]; invalid.push(incomplete); }
    for (const commercialAccount of invalid) {
      const bad = structuredClone(b); bad.commercialAccount = commercialAccount; bad.name = 'Nome deve reverter'; bad.conversations[0].messages[0].text = 'Mensagem deve reverter'; bad.automation.version = 2;
      await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before);
    }
  });
  await t.test('unidade inválida ou estrangeira reverte a transação; pai null é explícito', async () => {
    const before = await persisted(b), invalid = [null, {}, [], { identityVersion: 1 }, { parentTenantId: null }, { parentTenantId: null, identityVersion: 0 }, { parentTenantId: null, identityVersion: 1.5 },
      { parentTenantId: null, identityVersion: 9007199254740992 }, { parentTenantId: '', identityVersion: 1 }, { parentTenantId: {}, identityVersion: 1 }, { parentTenantId: b.id, identityVersion: 1 },
      { parentTenantId: a.id, identityVersion: 1 }, { parentTenantId: null, identityVersion: 1, grant: 'private-marker' }];
    for (const unit of invalid) { const bad = structuredClone(b); bad.unit = unit; bad.name = 'Não deve persistir'; await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before); }
  });
  await t.test('entrada malformada nova reverte provisionamento, capability e memberships; metadata não amplia grants', async () => {
    const fresh = snapshot(); fresh.commercialAccount.secret = 'private-marker';
    await assert.rejects(sync(fresh), error => error.code === '22023');
    for (const [table, column, identity] of [['mepchat.resellers', 'id', fresh.resellerId], ['mepchat.tenants', 'id', fresh.id], ['mepchat_private.reseller_sources', 'reseller_id', fresh.resellerId],
      ['mepchat_private.reseller_memberships', 'reseller_id', fresh.resellerId], ['mepchat_private.bridge_state', 'tenant_id', fresh.id], ['mepchat_private.tenant_memberships', 'tenant_id', fresh.id]]) assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [identity])).rows[0].n, 0);
    const memberships = async () => (await admin.query('SELECT user_id,role,active FROM mepchat_private.tenant_memberships WHERE tenant_id=$1 ORDER BY user_id', [b.id])).rows;
    const before = await memberships(), renamed = structuredClone(b); renamed.commercialAccount.name = 'Nome comercial atualizado'; renamed.commercialAccount.version = 2;
    assert.equal((await sync(renamed, 2)).state, 'synced'); assert.deepEqual(await memberships(), before);
  });
  await t.test('guards GUC/source/revenda continuam aplicados antes de metadata e preservam ambas contas', async () => {
    const beforeA = await persisted(a), beforeB = await persisted(b);
    for (const options of [{ resellerId: b.resellerId }, { tenantId: b.id }, { user: 'forged-principal' }, { source: randomUUID() }]) await assert.rejects(sync(a, 20, { ...options, provision: false }));
    await assert.rejects(sync({ ...a, resellerId: b.resellerId }, 20, { provision: false }));
    assert.deepEqual(await persisted(a), beforeA); assert.deepEqual(await persisted(b), beforeB);
  });
});
