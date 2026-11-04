import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

// Reuse the existing local synthetic PostgreSQL fixture after 003/004/005.
// This suite never creates a service or accepts a VPS/arbitrary database URL.
const enabled = process.env.MEPCHAT_TEST_PG_MCP === '1';
function localUrl(value) {
  if (!value) throw new Error('MCP tests require explicit local PostgreSQL fixture URLs.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.pathname !== '/mepchat' || !['15438', '5432'].includes(url.port || '5432')) throw new Error('MCP tests require the explicit local mepchat fixture.');
  return value;
}
function snapshot() {
  const id = `tenant_${randomUUID()}`, resellerId = `reseller_${randomUUID()}`, channelId = randomUUID(), conversationId = randomUUID(), departmentId = randomUUID();
  const date = new Date().toISOString(), serverId = 'mcp-shared-server', agentId = 'mcp-shared-agent', runId = 'mcp-shared-run', hash = 'a'.repeat(64);
  const server = { id: serverId, name: 'Elozi sintético', kind: 'internal', endpoint: '', enabled: true, version: 2, state: 'verified', checkedAt: date,
    tools: [{ name: 'conversation.read', title: 'Consultar atendimento', description: 'Lê somente o atendimento aprovado.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: { conversationId: { type: 'string' } }, required: ['conversationId'] }, hash, readOnly: true }], createdAt: date, updatedAt: date };
  const grant = { serverId, toolName: 'conversation.read', toolHash: hash, serverVersion: 2 };
  const agent = { id: agentId, name: 'Hermes MCP sintético', provider: 'hermes', mode: 'copilot', configured: true, state: 'configured', version: 2,
    mcpGrants: [grant], versions: [{ version: 1, config: { id: agentId, name: 'Hermes MCP anterior', provider: 'hermes', mode: 'copilot', version: 1, mcpGrants: [] } }] };
  const run = { id: runId, tenantId: id, conversationId, conversationVersion: 3, agentId, agentVersion: 2, state: 'waiting_approval', startedAt: date,
    toolSnapshot: [{ ...grant, alias: 'elozi_conversation_read', inputSchema: server.tools[0].inputSchema }],
    toolProposal: { id: 'mcp-shared-proposal', serverId, serverVersion: 2, toolName: 'conversation.read', toolHash: hash, arguments: {}, expiresAt: new Date(Date.now() + 600000).toISOString() },
    toolReceipt: { id: 'mcp-shared-receipt', serverId, toolName: 'conversation.read', state: 'completed', result: { conversationId }, completedAt: date } };
  return { id, resellerId, name: 'Empresa MCP sintética', segment: 'QA', plan: 'Local', brand: {}, reseller: { name: 'Revenda MCP sintética', brand: {} },
    mcpServers: [server], channels: [{ id: channelId, kind: 'telegram', name: 'Canal sintético', state: 'planned' }], agents: [agent], flows: [], runs: [run], audit: [], outbox: [],
    contacts: [], departments: [{ id: departmentId, name: 'Departamento sintético', active: true, distribution: 'manual' }], defaultDepartmentId: departmentId,
    automation: { version: 1, bindings: [], sla: { enabled: false, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, updatedAt: date },
    conversations: [{ id: conversationId, channelId, contact: 'Contato MCP sintético', departmentId, department: 'Departamento sintético', owner: 'queue', agentId: null,
      status: 'open', version: 3, unread: 1, updatedAt: date, messages: [{ id: randomUUID(), kind: 'customer', text: 'Consulta sintética MCP', delivery: 'received', createdAt: date }] }] };
}

test('PostgreSQL MCP: catálogo sem credenciais, grants/recibos, reapply, rollback e isolamento', {
  skip: !enabled && 'MEPCHAT_TEST_PG_MCP=1 é opt-in; exige fixture local com 005'
}, async t => {
  const app = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_URL), max: 3 });
  const admin = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_ADMIN_URL), max: 1 });
  t.after(async () => { await Promise.all([app.end(), admin.end()]); });
  const { rows: [capability] } = await admin.query("SELECT source_id FROM mepchat_private.reseller_sources WHERE reseller_id='mep-demo'");
  assert.ok(capability, 'Execute 003, 004 e 005 na fixture sintética antes desta suíte.');
  const source = capability.source_id, a = snapshot(), b = snapshot();
  const migration = (await readFile(new URL('../db/006-mcp.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  async function apply() {
    const client = await admin.connect();
    try { await client.query(migration); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function scoped(data, fn, options = {}) {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('mepchat.user_id',$1,true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$3,true)",
        [options.user ?? 'mepchat-local-bridge', options.resellerId ?? data.resellerId, options.tenantId ?? data.id]);
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
    const { rows: [agent] } = await admin.query('SELECT service_plan FROM mepchat.agents WHERE tenant_id=$1 AND id=$2', [data.id, data.agents[0].id]);
    const { rows: [run] } = await admin.query('SELECT state,budget FROM mepchat.runs WHERE tenant_id=$1 AND id=$2', [data.id, data.runs[0].id]);
    const { rows: [message] } = await admin.query('SELECT content FROM mepchat.messages WHERE tenant_id=$1 AND id=$2', [data.id, data.conversations[0].messages[0].id]);
    return { tenant, bridge, agent, run, message };
  }

  await t.test('006 reaplica sem trocar OIDs, mantém dono/search_path e as bases privadas', async () => {
    await apply();
    const functions = () => admin.query(`SELECT p.oid::text,p.proname,p.prosecdef,r.rolname AS owner,p.proconfig,
      has_function_privilege('mepchat_app',p.oid,'EXECUTE') AS app,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN (
      to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)'),to_regprocedure('mepchat_private.sync_workspace_base_005(jsonb,text,bigint)'),
      to_regprocedure('mepchat_private.sync_workspace_base_004(jsonb,text,bigint)'),to_regprocedure('mepchat_private.sync_workspace_base_003(jsonb,text,bigint)'),
      to_regprocedure('mepchat_private.valid_automation_calendar(jsonb)')) ORDER BY p.proname`);
    const before = await functions(); await apply(); const after = await functions(); assert.equal(before.rows.length, 5); assert.deepEqual(after.rows, before.rows);
    for (const fn of after.rows) {
      assert.equal(fn.owner, 'supabase_admin'); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog']); assert.equal(fn.public, false);
      assert.equal(fn.app, fn.proname === 'sync_workspace'); assert.equal(fn.prosecdef, fn.proname !== 'valid_automation_calendar');
    }
    for (const name of ['sync_workspace_base_003', 'sync_workspace_base_004', 'sync_workspace_base_005'])
      await assert.rejects(app.query(`SELECT mepchat_private.${name}($1::jsonb,$2,1)`, [JSON.stringify(a), source]), error => error.code === '42501');
  });
  await t.test('duas empresas projetam catálogo/schema, grants e proposta/recibo nos campos existentes', async () => {
    for (const data of [a, b]) {
      assert.equal((await sync(data)).state, 'synced'); const value = await persisted(data);
      assert.deepEqual(value.tenant.settings.mcpServers, data.mcpServers); assert.deepEqual(value.tenant.settings.automation, data.automation);
      assert.deepEqual(value.tenant.settings.departments, data.departments); assert.deepEqual(value.tenant.settings.contacts, []);
      assert.equal(value.tenant.settings.defaultDepartmentId, data.defaultDepartmentId);
      assert.deepEqual(value.agent.service_plan.mcpGrants, data.agents[0].mcpGrants);
      assert.deepEqual(value.run.budget.toolSnapshot, data.runs[0].toolSnapshot); assert.deepEqual(value.run.budget.toolProposal, data.runs[0].toolProposal);
      assert.deepEqual(value.run.budget.toolReceipt, data.runs[0].toolReceipt); assert.equal(value.run.state, data.runs[0].state);
      assert.equal(JSON.stringify(value).includes('configSecret'), false); assert.equal(JSON.stringify(value).includes('reasoning_content'), false);
    }
  });
  await t.test('RLS isola settings/agentes/runs com IDs MCP coincidentes e principal forjado', async () => {
    assert.equal((await app.query('SELECT count(*)::int AS n FROM mepchat.tenants')).rows[0].n, 0);
    for (const [own, other] of [[a, b], [b, a]]) {
      const rows = await scoped(own, client => client.query('SELECT id,settings FROM mepchat.tenants')); assert.deepEqual(rows.rows.map(row => row.id), [own.id]);
      assert.deepEqual(rows.rows[0].settings.mcpServers, own.mcpServers);
      for (const table of ['agents', 'runs']) {
        const foreign = await scoped(own, client => client.query(`SELECT count(*)::int AS n FROM mepchat.${table} WHERE tenant_id=$1`, [other.id]));
        assert.equal(foreign.rows[0].n, 0);
        const permitted = await scoped(own, client => client.query(`SELECT tenant_id FROM mepchat.${table}`)); assert.deepEqual(permitted.rows.map(row => row.tenant_id), [own.id]);
      }
      const forged = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.tenants'), { user: 'forged-principal' }); assert.equal(forged.rows[0].n, 0);
    }
  });
  await t.test('replay antigo não apaga catálogo; snapshot anterior sem MCP preserva 004/005/006', async () => {
    const newer = structuredClone(a); newer.mcpServers[0].version = 3; newer.mcpServers[0].enabled = false;
    assert.equal((await sync(newer, 2)).state, 'synced'); const before = await persisted(a);
    assert.equal((await sync({ ...a, mcpServers: null }, 1)).state, 'already_synced'); assert.deepEqual(await persisted(a), before);
    const legacy = structuredClone(a); delete legacy.mcpServers; delete legacy.automation; delete legacy.contacts; delete legacy.departments; delete legacy.defaultDepartmentId;
    legacy.name = 'Snapshot anterior compatível'; assert.equal((await sync(legacy, 3)).state, 'synced'); const preserved = await persisted(a);
    assert.deepEqual(preserved.tenant.settings.mcpServers, newer.mcpServers); assert.deepEqual(preserved.tenant.settings.automation, a.automation);
    assert.deepEqual(preserved.tenant.settings.departments, a.departments); assert.equal(preserved.tenant.settings.defaultDepartmentId, a.defaultDepartmentId);
  });
  await t.test('catálogo inválido/credenciais reverte projeção, recibo, revisão e provisionamento', async () => {
    const before = await persisted(b), server = b.mcpServers[0], tool = server.tools[0];
    const invalid = [null, {}, [{}], [{ ...server, id: '' }], [{ ...server, version: 0 }], [{ ...server, version: 9007199254740992 }],
      [server, server], [{ ...server, tools: {} }], [{ ...server, tools: [tool, tool] }], [{ ...server, tools: [{ ...tool, inputSchema: null }] }],
      [{ ...server, tools: [{ ...tool, hash: 'not-a-schema-hash' }] }], Array.from({ length: 17 }, (_, i) => ({ ...server, id: `excess-${i}` })),
      [{ ...server, tools: Array.from({ length: 33 }, (_, i) => ({ ...tool, name: `excess_tool_${i}` })) }], [{ ...server, description: 'x'.repeat(1048576) }]];
    // Reject credential fields even with empty synthetic values. Never fixture a real key.
    for (const field of ['token', 'bearer', 'apiKey', 'secret', 'configSecret', 'credentials', 'authorization', 'headers']) invalid.push([{ ...server, [field]: '' }]);
    for (const catalogue of invalid) {
      const bad = structuredClone(b); bad.mcpServers = catalogue; bad.name = 'Nome que deve reverter'; bad.runs[0].toolReceipt.state = 'must-not-persist';
      bad.conversations[0].messages[0].text = 'Conteúdo que deve reverter';
      await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before);
    }
    const fresh = snapshot(); fresh.mcpServers = null; await assert.rejects(sync(fresh), error => error.code === '22023');
    for (const [table, column, identity] of [['mepchat.resellers', 'id', fresh.resellerId], ['mepchat.tenants', 'id', fresh.id],
      ['mepchat_private.reseller_sources', 'reseller_id', fresh.resellerId], ['mepchat_private.bridge_state', 'tenant_id', fresh.id]])
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [identity])).rows[0].n, 0);
  });
  await t.test('catálogo vazio limpa explicitamente e um snapshot sem campo conserva o vazio', async () => {
    assert.equal((await sync({ ...b, mcpServers: [] }, 2)).state, 'synced'); assert.deepEqual((await persisted(b)).tenant.settings.mcpServers, []);
    const omitted = structuredClone(b); delete omitted.mcpServers;
    assert.equal((await sync(omitted, 3)).state, 'synced'); assert.deepEqual((await persisted(b)).tenant.settings.mcpServers, []);
  });
  await t.test('GUC/source/revenda divergentes não escrevem catálogo ou dados anteriores', async () => {
    const beforeA = await persisted(a), beforeB = await persisted(b);
    for (const options of [{ resellerId: b.resellerId }, { tenantId: b.id }, { user: 'forged-principal' }, { source: randomUUID() }])
      await assert.rejects(sync(a, 10, { ...options, provision: false }));
    await assert.rejects(sync({ ...a, resellerId: b.resellerId }, 10, { provision: false }));
    assert.deepEqual(await persisted(a), beforeA); assert.deepEqual(await persisted(b), beforeB);
  });
});
