import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Store } from '../src/store.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { PostgresBridge } from '../src/postgres-bridge.js';

const migrationPath = new URL('../db/009-telegram-account.sql', import.meta.url);
const enabled = process.env.MEPCHAT_TEST_PG_TELEGRAM_ACCOUNT === '1';
const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'QA sintético' };
const legacyKinds = ['whatsapp_qr', 'whatsapp_cloud', 'webchat', 'telegram', 'instagram', 'messenger', 'email'];
function localUrl(value, role) {
  if (!value) throw new Error('Telegram projection tests require explicit local fixture URLs.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/mepchat' || (url.port || '5432') !== '5432' || url.username !== role || url.search || url.hash) {
    throw new Error('Telegram projection tests require the existing local CI mepchat fixture and explicit role.');
  }
  return value;
}

test('Telegram projection fixture rejects other hosts, databases, ports and roles', () => {
  for (const url of ['postgresql://mepchat_app@vps.example.test:5432/mepchat', 'postgresql://mepchat_app@localhost:49555/mepchat',
    'postgresql://mepchat_app@localhost:5432/production', 'postgresql://postgres@localhost:5432/mepchat', '',
    'postgresql://mepchat_app@localhost:5432/mepchat?options=-csearch_path=public']) assert.throws(() => localUrl(url, 'mepchat_app'));
  assert.equal(localUrl('postgresql://mepchat_app@127.0.0.1:5432/mepchat', 'mepchat_app'), 'postgresql://mepchat_app@127.0.0.1:5432/mepchat');
});

test('Native personal channel snapshot excludes encrypted app credentials, session and peer hashes', async t => {
  const store = new Store(':memory:'), key = randomBytes(32), calls = [];
  const bridge = new PostgresBridge(store, { transport: { async sync(job) { calls.push(JSON.parse(job.payload)); }, async close() {} } });
  t.after(async () => { await bridge.close(); store.close(); });
  const tenant = store.createTenant(actor, { name: 'Telegram QA', segment: 'QA' }), channelId = randomUUID();
  const privateValues = { apiId: 2147483001, apiHash: 'synthetic-private-api-hash', session: 'synthetic-private-StringSession',
    phone: '+5511999999999', peers: { '81': { rawId: '81', accessHash: 'synthetic-private-access-hash' } } };
  encryptedChannelSecrets(store.db, key).set(`telegram-user:${tenant.id}:${channelId}`, privateValues);
  store.mutate(actor, tenant.id, 'Fixture pública', state => state.channels.push({ id: channelId, kind: 'telegram_user', transport: 'telegram-user',
    name: 'Telegram pessoal QA', state: 'connected', telegramUser: { configured: true, version: 1, accountId: '123456789123456789',
      accountName: 'Conta sintética', selectedPeerIds: ['81'], dialogs: [{ id: '81', title: 'Pessoa QA', type: 'private', canSend: true }] } }));
  const payload = store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(tenant.id).payload;
  const projected = JSON.parse(payload).channels[0];
  assert.equal(projected.kind, 'telegram_user'); assert.equal(projected.transport, 'telegram-user');
  assert.deepEqual(projected.telegramUser.selectedPeerIds, ['81']);
  for (const value of [privateValues.apiId, privateValues.apiHash, privateValues.session, privateValues.phone, privateValues.peers['81'].accessHash]) assert.equal(payload.includes(String(value)), false);
  for (const field of ['apiId', 'apiHash', 'session', 'StringSession', 'accessHash', 'privatePeer', 'password', 'phoneCodeHash']) assert.equal(payload.includes(`"${field}"`), false);
  const ciphertext = Buffer.from(store.db.prepare('SELECT payload FROM channel_secrets').get().payload);
  assert.equal(ciphertext.includes(Buffer.from(privateValues.session)), false);
  await bridge.flush(); assert.equal(bridge.status().pending, 0); assert.equal(calls[0].channels[0].kind, 'telegram_user');
});

test('009 is a bounded transactional widening of the known channel check without baseline or access DDL', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /^BEGIN;/m); assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/); assert.match(sql, /SET LOCAL statement_timeout='30s'/);
  assert.match(sql, /LOCK TABLE mepchat\.channels IN ACCESS EXCLUSIVE MODE/);
  assert.match(sql, /pg_get_constraintdef\(existing\.oid,false\)/); assert.match(sql, /existing\.convalidated/);
  assert.match(sql, /current_database\(\)<>'mepchat'/); assert.match(sql, /relrowsecurity AND c\.relforcerowsecurity/);
  assert.equal((sql.match(/ALTER TABLE /g) || []).length, 2);
  assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|CREATE\s+(?:TABLE|FUNCTION|SCHEMA)|INSERT\s+INTO|UPDATE\s+mepchat|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i);
  const baseline = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  assert.match(baseline, /kind text NOT NULL CHECK\(kind IN \('whatsapp_qr','whatsapp_cloud','webchat','telegram','instagram','messenger','email'\)\)/);
});

function snapshot() {
  const id = 'tenant_' + randomUUID(), resellerId = 'reseller_' + randomUUID(), date = new Date().toISOString(), channelId = randomUUID(), conversationId = randomUUID();
  return { id, resellerId, name: 'Telegram pessoal sintético', segment: 'QA', plan: 'Local', brand: {}, reseller: { name: 'Conta QA', brand: {} },
    commercialAccount: { id: resellerId, name: 'Conta QA', accountKind: 'business', parentWorkspaceId: 'mep-demo', version: 1, createdAt: date },
    unit: { parentTenantId: null, identityVersion: 1 }, channels: [{ id: channelId, kind: 'telegram_user', transport: 'telegram-user', name: 'Pessoal QA', state: 'connected',
      telegramUser: { configured: true, version: 2, accountId: String(100000000000000000n + BigInt(Date.now())), accountName: 'Pessoa QA',
        selectedPeerIds: ['81'], dialogs: [{ id: '81', title: 'Pessoa QA', type: 'private', canSend: true }] } }],
    agents: [], flows: [], runs: [], audit: [], outbox: [], contacts: [], departments: [], defaultDepartmentId: null, mcpServers: [], knowledgeSources: [],
    automation: { version: 1, bindings: [], sla: { enabled: false, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, updatedAt: date },
    conversations: [{ id: conversationId, channelId, contact: 'Pessoa sintética', status: 'open', owner: 'queue', version: 1, unread: 1, updatedAt: date,
      messages: [{ id: randomUUID(), kind: 'customer', text: 'Mensagem sintética da fixture', delivery: 'received', createdAt: date }] }] };
}

// Opt-in only: the existing CI service/database has 001, 002 and the complete chain through 008.
// No service/database creation or cleanup. All new rows have unique synthetic IDs.
test('PostgreSQL Telegram account: known-check preflight, idempotence, native projection and unchanged RLS', {
  skip: !enabled && 'MEPCHAT_TEST_PG_TELEGRAM_ACCOUNT=1 exige o mesmo serviço CI após 008'
}, async t => {
  const app = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_URL, 'mepchat_app'), max: 2 }),
    admin = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_ADMIN_URL, 'postgres'), max: 1 });
  t.after(async () => { await Promise.all([app.end(), admin.end()]); });
  assert.ok((await admin.query("SELECT to_regprocedure('mepchat_private.sync_workspace_base_007(jsonb,text,bigint)') AS installed")).rows[0].installed, 'Existing fixture must have migration 008.');
  const capability = (await admin.query("SELECT source_id FROM mepchat_private.reseller_sources WHERE reseller_id='mep-demo'")).rows[0];
  assert.ok(capability, 'Existing fixture must retain its synthetic bridge source.');
  const source = capability.source_id, a = snapshot(), b = snapshot(), operatorId = 'telegram-qa-' + randomUUID();
  const sql = (await readFile(migrationPath, 'utf8')).replace(/\r\n/g, '\n');
  const body = sql.replace(/^BEGIN;\n/m, '').replace(/COMMIT;\s*$/, '');
  const definition = () => admin.query("SELECT oid::text,pg_get_constraintdef(oid,false) AS definition,convalidated FROM pg_constraint WHERE conrelid='mepchat.channels'::regclass AND conname='channels_kind_check'");
  const protectedMetadata = async () => {
    const table = (await admin.query("SELECT c.oid::text,r.rolname AS owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='mepchat.channels'::regclass")).rows;
    const policies = (await admin.query("SELECT polname,polcmd,polroles::text,pg_get_expr(polqual,polrelid) AS using,pg_get_expr(polwithcheck,polrelid) AS check FROM pg_policy WHERE polrelid='mepchat.channels'::regclass ORDER BY polname")).rows;
    const functions = (await admin.query("SELECT p.oid::text,p.proname,p.proowner::text,p.proacl::text,p.proconfig,md5(p.prosrc) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mepchat_private' ORDER BY p.oid")).rows;
    const constraints = (await admin.query("SELECT oid::text,conname,pg_get_constraintdef(oid,false) AS definition FROM pg_constraint WHERE conrelid='mepchat.channels'::regclass AND conname<>'channels_kind_check' ORDER BY conname")).rows;
    return { table, policies, functions, constraints };
  };
  async function apply() { const client = await admin.connect(); try { await client.query(sql); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async function scoped(data, callback, options = {}) {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('mepchat.user_id',$1,true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$3,true)", [options.user ?? 'mepchat-local-bridge', options.resellerId ?? data.resellerId, options.tenantId ?? data.id]);
      const result = await callback(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const sync = (data, revision = 1, options = {}) => scoped(data, async client => {
    if (options.provision !== false) await client.query('SELECT mepchat_private.provision_reseller($1,$2,$3)', [data.resellerId, data.id, source]);
    return (await client.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,$3::bigint) AS result', [JSON.stringify(data), options.source ?? source, revision])).rows[0].result;
  }, options);
  const before = await protectedMetadata(), previousCount = (await admin.query('SELECT count(*)::int AS count FROM mepchat.channels')).rows[0].count;
  assert.equal((await definition()).rows[0].definition.includes('telegram_user'), false, 'This fixture must exercise the original baseline check first.');

  await t.test('the legacy check rejects native projection atomically before 009', async () => {
    await assert.rejects(sync(a), error => error.code === '23514');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM mepchat.tenants WHERE id=$1', [a.id])).rows[0].count, 0);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM mepchat.resellers WHERE id=$1', [a.resellerId])).rows[0].count, 0);
  });
  for (const [label, suffix] of [['unknown definition', ", 'unexpected_kind'"], ['unvalidated legacy check', '']]) {
    await t.test(`009 rejects ${label} without replacing it or committing any data`, async () => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE mepchat.channels DROP CONSTRAINT channels_kind_check');
        const literals = legacyKinds.map(kind => "'" + kind + "'").join(',') + suffix;
        await client.query(`ALTER TABLE mepchat.channels ADD CONSTRAINT channels_kind_check CHECK(kind IN (${literals}))${suffix ? '' : ' NOT VALID'}`);
        const read = async () => (await client.query("SELECT oid::text,pg_get_constraintdef(oid,false) AS definition,convalidated FROM pg_constraint WHERE conrelid='mepchat.channels'::regclass AND conname='channels_kind_check'")).rows;
        const malformed = await read(); await client.query('SAVEPOINT preflight');
        await assert.rejects(client.query(body), error => error.code === '55000');
        await client.query('ROLLBACK TO SAVEPOINT preflight'); assert.deepEqual(await read(), malformed);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
  }
  await t.test('009 widens once, preserves table/function/RLS/grants and reapplies without changing the constraint OID', async () => {
    await apply(); const widened = await definition(); await apply(); assert.deepEqual((await definition()).rows, widened.rows);
    assert.equal(widened.rows[0].convalidated, true); assert.ok(widened.rows[0].definition.includes('telegram_user'));
    assert.deepEqual(await protectedMetadata(), before); assert.equal((await admin.query('SELECT count(*)::int AS count FROM mepchat.channels')).rows[0].count, previousCount);
    const role = (await app.query("SELECT rolsuper,rolbypassrls,pg_has_role(current_user,'mepchat_owner','MEMBER') AS owner_member,pg_has_role(current_user,'supabase_admin','MEMBER') AS admin_member FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, owner_member: false, admin_member: false });
    await assert.rejects(app.query('ALTER TABLE mepchat.channels DROP CONSTRAINT channels_kind_check'), error => error.code === '42501');
  });
  await t.test('native metadata and all seven legacy kinds project through the existing private bridge chain', async () => {
    a.channels.push(...legacyKinds.map(kind => ({ id: randomUUID(), kind, name: 'Legado ' + kind, state: 'planned' })));
    for (const data of [a, b]) {
      assert.equal((await sync(data)).state, 'synced');
      const channels = (await admin.query('SELECT kind,settings,external_account_id FROM mepchat.channels WHERE tenant_id=$1 ORDER BY kind', [data.id])).rows;
      const personal = channels.find(channel => channel.kind === 'telegram_user');
      assert.deepEqual(personal.settings.telegramUser, data.channels[0].telegramUser); assert.equal(personal.settings.transport, 'telegram-user');
      assert.equal(personal.external_account_id, null); // Identity uniqueness remains the existing private operational binding.
      const stored = (await admin.query('SELECT settings FROM mepchat.tenants WHERE id=$1', [data.id])).rows[0];
      assert.deepEqual(stored.settings.commercialAccount, data.commercialAccount);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM mepchat.messages WHERE tenant_id=$1', [data.id])).rows[0].count, 1);
      assert.equal((await sync(data)).state, 'already_synced');
    }
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM mepchat.channels WHERE tenant_id=$1', [a.id])).rows[0].count, 8);
  });
  await t.test('an operator sees only its selected tenant and cannot administer native channels or run the service projection', async () => {
    await admin.query('INSERT INTO mepchat.users(id,display_name) VALUES($1,$2)', [operatorId, 'Operador sintético']);
    await admin.query("INSERT INTO mepchat_private.tenant_memberships(tenant_id,user_id,role,active) VALUES($1,$2,'operator',true)", [a.id, operatorId]);
    const own = await scoped(a, client => client.query('SELECT tenant_id,kind FROM mepchat.channels ORDER BY kind'), { user: operatorId });
    assert.equal(own.rows.length, 8); assert.ok(own.rows.every(row => row.tenant_id === a.id));
    const cross = await scoped(a, client => client.query('SELECT * FROM mepchat.channels WHERE tenant_id=$1', [b.id]), { user: operatorId }); assert.deepEqual(cross.rows, []);
    const foreignContext = await scoped(b, client => client.query('SELECT * FROM mepchat.channels'), { user: operatorId }); assert.deepEqual(foreignContext.rows, []);
    await assert.rejects(scoped(a, client => client.query("INSERT INTO mepchat.channels(tenant_id,id,kind,name) VALUES($1,$2,'telegram_user','Denied')", [a.id, randomUUID()]), { user: operatorId }), error => error.code === '42501');
    await assert.rejects(sync(a, 2, { provision: false, user: operatorId }), /Bridge context denied/i);
    await assert.rejects(sync(a, 2, { provision: false, tenantId: b.id }), /Tenant context mismatch/i);
    // reseller_access rejects the foreign reseller before sync_workspace reaches its mismatch diagnostic.
    await assert.rejects(sync(a, 2, { provision: false, resellerId: b.resellerId }), error => error.code === 'P0001' && error.message === 'Bridge context denied');
    const changed = structuredClone(a); changed.channels[0].kind = 'unexpected_kind';
    await assert.rejects(sync(changed, 2, { provision: false }), error => error.code === '23514');
    assert.equal((await admin.query('SELECT revision::text FROM mepchat_private.bridge_state WHERE tenant_id=$1', [a.id])).rows[0].revision, '1');
    assert.equal((await admin.query('SELECT kind FROM mepchat.channels WHERE tenant_id=$1 AND id=$2', [a.id, a.channels[0].id])).rows[0].kind, 'telegram_user');
  });
});
