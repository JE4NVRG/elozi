import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

// Only the existing local CI PostgreSQL fixture after 003 and 004. Never VPS.
const enabled = process.env.MEPCHAT_TEST_PG_AUTOMATION === '1';
function localUrl(value) {
  if (!value) throw new Error('Automation tests require explicit local PostgreSQL fixture URLs.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.pathname !== '/mepchat' || !['15438', '5432'].includes(url.port || '5432')) throw new Error('Automation tests require the explicit local mepchat fixture.');
  return value;
}
function snapshot() {
  const id = `tenant_${randomUUID()}`, resellerId = `reseller_${randomUUID()}`, channelId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), departmentId = randomUUID(), date = new Date().toISOString();
  const binding = { id: randomUUID(), name: 'Automação sintética', enabled: true, channelId, flowId: randomUUID(), flowVersion: 1, trigger: 'command', command: '/ajuda', authorizedBy: 'synthetic-authority', calendar: { timezone: 'America/Sao_Paulo', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, createdAt: date, updatedAt: date };
  return { id, resellerId, name: 'Empresa automação sintética', segment: 'QA', plan: 'Local', brand: {}, reseller: { name: 'Revenda sintética', brand: {} },
    channels: [{ id: channelId, kind: 'telegram', name: 'Canal sintético', state: 'planned' }], agents: [], flows: [], runs: [], audit: [], outbox: [],
    contacts: [], departments: [{ id: departmentId, name: 'Departamento sintético', active: true, distribution: 'manual' }], defaultDepartmentId: departmentId,
    automation: { version: 2, bindings: [binding], sla: { enabled: true, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, updatedAt: date },
    conversations: [{ id: conversationId, channelId, contact: 'Contato sintético', departmentId, department: 'Departamento sintético', owner: 'queue', assignedUserId: null, agentId: null, status: 'open', version: 3, unread: 1, updatedAt: date,
      slaCycle: { startedAt: date, incomingMessageId: messageId, reopenedEventId: null, source: 'gateway-new-conversation' },
      messages: [{ id: messageId, kind: 'customer', text: '/ajuda sintético', delivery: 'received', createdAt: date,
        automationReceipt: { processedAt: date, bindingId: binding.id, configurationVersion: 2, outcome: 'applied', applied: true, flowId: binding.flowId, flowVersion: 1, steps: [{ nodeId: 'start', type: 'start' }, { nodeId: 'end', type: 'end' }], conversationId, conversationVersion: 3 } }] }] };
}

test('PostgreSQL automação: projeção, base privada, reapply, rollback e isolamento', {
  skip: !enabled && 'MEPCHAT_TEST_PG_AUTOMATION=1 é opt-in; exige fixture local com 004'
}, async t => {
  const app = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_URL), max: 3 });
  const admin = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_ADMIN_URL), max: 1 });
  t.after(async () => { await Promise.all([app.end(), admin.end()]); });
  const { rows: [capability] } = await admin.query("SELECT source_id FROM mepchat_private.reseller_sources WHERE reseller_id='mep-demo'");
  assert.ok(capability, 'Execute 003 e 004 na fixture sintética antes desta suíte.');
  const source = capability.source_id, a = snapshot(), b = snapshot();
  const migration = (await readFile(new URL('../db/005-automation.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  async function apply() { const client = await admin.connect(); try { await client.query(migration); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async function scoped(data, fn, options = {}) {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('mepchat.user_id',$1,true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$3,true)", [options.user || 'mepchat-local-bridge', options.resellerId || data.resellerId, options.tenantId || data.id]);
      const result = await fn(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const sync = (data, revision = 1, options = {}) => scoped(data, async client => {
    if (options.provision !== false) await client.query('SELECT mepchat_private.provision_reseller($1,$2,$3)', [data.resellerId, data.id, options.source || source]);
    return (await client.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,$3::bigint) AS result', [JSON.stringify(data), options.source || source, revision])).rows[0].result;
  }, options);
  async function persisted(data) {
    const { rows: [tenant] } = await admin.query('SELECT name,settings FROM mepchat.tenants WHERE id=$1', [data.id]);
    const { rows: [bridge] } = await admin.query('SELECT revision::text FROM mepchat_private.bridge_state WHERE tenant_id=$1', [data.id]);
    const { rows: [conversation] } = await admin.query('SELECT attributes FROM mepchat.conversations WHERE id=$1', [data.conversations[0].id]);
    const { rows: [message] } = await admin.query('SELECT content FROM mepchat.messages WHERE id=$1', [data.conversations[0].messages[0].id]);
    return { tenant, bridge, conversation, message };
  }

  await t.test('005 reaplica sem trocar OIDs, mantém dono/search_path e bases privadas', async () => {
    await apply();
    const functions = () => admin.query(`SELECT p.oid::text,p.proname,p.prosecdef,r.rolname AS owner,p.proconfig,
      has_function_privilege('mepchat_app',p.oid,'EXECUTE') AS app,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN (
      to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)'),to_regprocedure('mepchat_private.sync_workspace_base_004(jsonb,text,bigint)'),
      to_regprocedure('mepchat_private.sync_workspace_base_003(jsonb,text,bigint)'),to_regprocedure('mepchat_private.valid_automation_calendar(jsonb)')) ORDER BY p.proname`);
    const before = await functions(); await apply(); const after = await functions(); assert.equal(before.rows.length, 4); assert.deepEqual(after.rows, before.rows);
    for (const fn of after.rows) { assert.equal(fn.owner, 'supabase_admin'); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog']); assert.equal(fn.public, false); assert.equal(fn.app, fn.proname === 'sync_workspace'); assert.equal(fn.prosecdef, fn.proname !== 'valid_automation_calendar'); }
    for (const name of ['sync_workspace_base_003', 'sync_workspace_base_004']) await assert.rejects(app.query(`SELECT mepchat_private.${name}($1::jsonb,$2,1)`, [JSON.stringify(a), source]), error => error.code === '42501');
    await assert.rejects(app.query('SELECT mepchat_private.valid_automation_calendar($1::jsonb)', ['null']), error => error.code === '42501');
  });
  await t.test('duas revendas mantêm configuração, operação 004, recibo e marco de ciclo na projeção', async () => {
    for (const data of [a, b]) {
      assert.equal((await sync(data)).state, 'synced'); const value = await persisted(data);
      assert.deepEqual(value.tenant.settings.automation, data.automation); assert.deepEqual(value.tenant.settings.departments, data.departments);
      assert.deepEqual(value.tenant.settings.contacts, []); assert.equal(value.tenant.settings.defaultDepartmentId, data.defaultDepartmentId);
      assert.deepEqual(value.conversation.attributes.slaCycle, data.conversations[0].slaCycle); assert.deepEqual(value.message.content.automationReceipt, data.conversations[0].messages[0].automationReceipt);
    }
  });
  await t.test('RLS recusa leitura cruzada, contexto ausente e principal forjado', async () => {
    assert.equal((await app.query('SELECT count(*)::int AS n FROM mepchat.tenants')).rows[0].n, 0);
    for (const [own, other] of [[a, b], [b, a]]) {
      const rows = await scoped(own, client => client.query('SELECT id,settings FROM mepchat.tenants')); assert.deepEqual(rows.rows.map(row => row.id), [own.id]);
      assert.deepEqual(rows.rows[0].settings.automation, own.automation);
      const messages = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.messages WHERE tenant_id=$1', [other.id])); assert.equal(messages.rows[0].n, 0);
      const forged = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.tenants'), { user: 'forged-principal' }); assert.equal(forged.rows[0].n, 0);
    }
  });
  await t.test('replay não apaga configuração e snapshot antigo sem automação preserva 004+005', async () => {
    const newer = structuredClone(a); newer.automation.version = 3; newer.automation.bindings = []; newer.automation.sla.enabled = false;
    assert.equal((await sync(newer, 2)).state, 'synced'); const before = await persisted(a);
    assert.equal((await sync({ ...a, automation: null }, 1)).state, 'already_synced'); assert.deepEqual(await persisted(a), before);
    const legacy = structuredClone(a); delete legacy.automation; delete legacy.contacts; delete legacy.departments; delete legacy.defaultDepartmentId; legacy.name = 'Snapshot anterior compatível';
    assert.equal((await sync(legacy, 3)).state, 'synced'); const preserved = await persisted(a);
    assert.deepEqual(preserved.tenant.settings.automation, newer.automation); assert.deepEqual(preserved.tenant.settings.departments, a.departments); assert.equal(preserved.tenant.settings.defaultDepartmentId, a.defaultDepartmentId);
  });
  await t.test('configuração inválida reverte dados, configuração, recibo, revisão e provisionamento', async () => {
    const before = await persisted(b);
    for (const badConfig of [null, {}, { ...b.automation, version: 0 }, { ...b.automation, bindings: {} }, { ...b.automation, bindings: [b.automation.bindings[0], b.automation.bindings[0]] },
      { ...b.automation, sla: { ...b.automation.sla, firstReplyMinutes: -1 } }, { ...b.automation, sla: { ...b.automation.sla, resolutionMinutes: 99999 } },
      { ...b.automation, sla: { ...b.automation.sla, calendar: { timezone: 'UTC', days: [7], start: '09:00', end: '18:00' } } },
      { ...b.automation, bindings: [{ ...b.automation.bindings[0], flowVersion: 0 }] }]) {
      const bad = structuredClone(b); bad.automation = badConfig; bad.name = 'Nome que deve reverter'; bad.conversations[0].messages[0].text = 'Conteúdo que deve reverter';
      await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before);
    }
    const fresh = snapshot(); fresh.automation = null; await assert.rejects(sync(fresh), error => error.code === '22023');
    for (const [table, column, identity] of [['mepchat.resellers', 'id', fresh.resellerId], ['mepchat.tenants', 'id', fresh.id], ['mepchat_private.reseller_sources', 'reseller_id', fresh.resellerId], ['mepchat_private.bridge_state', 'tenant_id', fresh.id]]) assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [identity])).rows[0].n, 0);
  });
  await t.test('GUC, autoridade source e identidade de revenda divergentes não sincronizam', async () => {
    const beforeA = await persisted(a), beforeB = await persisted(b);
    for (const options of [{ resellerId: b.resellerId }, { tenantId: b.id }, { user: 'forged-principal' }, { source: randomUUID() }]) await assert.rejects(sync(a, 10, { ...options, provision: false }));
    await assert.rejects(sync({ ...a, resellerId: b.resellerId }, 10, { provision: false })); assert.deepEqual(await persisted(a), beforeA); assert.deepEqual(await persisted(b), beforeB);
  });
});
