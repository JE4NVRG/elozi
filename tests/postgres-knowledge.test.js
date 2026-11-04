import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

// Reuse the synthetic local fixture after 003/004/005/006. This suite does not
// create a service and refuses VPS/arbitrary database destinations.
const enabled = process.env.MEPCHAT_TEST_PG_KNOWLEDGE === '1';
function localUrl(value) {
  if (!value) throw new Error('Knowledge tests require explicit local PostgreSQL fixture URLs.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.pathname !== '/mepchat' || !['15438', '5432'].includes(url.port || '5432')) throw new Error('Knowledge tests require the explicit local mepchat fixture.');
  return value;
}
function snapshot() {
  const id = `tenant_${randomUUID()}`, resellerId = `reseller_${randomUUID()}`, channelId = randomUUID(), conversationId = randomUUID(), departmentId = randomUUID();
  const date = new Date().toISOString(), sourceId = 'knowledge-shared-source', agentId = 'knowledge-shared-agent', runId = 'knowledge-shared-run', hash = 'a'.repeat(64);
  const source = { id: sourceId, title: 'Política sintética', category: '', version: 2, archived: false, publicationCounter: 1, createdAt: date, updatedAt: date,
    published: { version: 1, title: 'Política publicada sintética', hash, publishedAt: date } };
  const pin = { sourceId, publicationVersion: 1, publicationHash: hash };
  const agent = { id: agentId, name: 'Hermes conhecimento sintético', provider: 'hermes', mode: 'copilot', configured: true, state: 'configured', version: 2,
    knowledgeGrants: [pin], versions: [{ version: 1, config: { id: agentId, name: 'Hermes anterior', provider: 'hermes', mode: 'copilot', version: 1, knowledgeGrants: [pin] } }] };
  const run = { id: runId, tenantId: id, conversationId, conversationVersion: 3, agentId, agentVersion: 2, state: 'completed', startedAt: date,
    knowledgeSnapshot: [pin], knowledgeState: 'matched', knowledgeReferences: [{ ...pin, title: source.published.title, chunkId: `${sourceId}:1:0` }] };
  const server = { id: 'knowledge-mcp', name: 'MCP preservado', kind: 'internal', endpoint: '', enabled: true, version: 1, state: 'configured', tools: [] };
  return { id, resellerId, name: 'Empresa conhecimento sintética', segment: 'QA', plan: 'Local', brand: {}, reseller: { name: 'Revenda conhecimento sintética', brand: {} },
    knowledgeSources: [source], mcpServers: [server], channels: [{ id: channelId, kind: 'telegram', name: 'Canal sintético', state: 'planned' }], agents: [agent], flows: [], runs: [run], audit: [], outbox: [],
    contacts: [], departments: [{ id: departmentId, name: 'Departamento sintético', active: true, distribution: 'manual' }], defaultDepartmentId: departmentId,
    automation: { version: 1, bindings: [], sla: { enabled: false, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, updatedAt: date },
    conversations: [{ id: conversationId, channelId, contact: 'Contato sintético', departmentId, department: 'Departamento sintético', owner: 'queue', agentId: null,
      status: 'open', version: 3, unread: 1, updatedAt: date, messages: [{ id: randomUUID(), kind: 'customer', text: 'Mensagem sintética independente da fonte', delivery: 'received', createdAt: date }] }] };
}

test('PostgreSQL conhecimento: metadata privada por empresa, pins, reapply, rollback e isolamento', {
  skip: !enabled && 'MEPCHAT_TEST_PG_KNOWLEDGE=1 é opt-in; exige fixture local com 006'
}, async t => {
  const app = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_URL), max: 3 });
  const admin = new Pool({ connectionString: localUrl(process.env.MEPCHAT_TEST_PG_ADMIN_URL), max: 1 });
  t.after(async () => { await Promise.all([app.end(), admin.end()]); });
  const { rows: [capability] } = await admin.query("SELECT source_id FROM mepchat_private.reseller_sources WHERE reseller_id='mep-demo'");
  assert.ok(capability, 'Execute 003, 004, 005 e 006 na fixture sintética antes desta suíte.');
  const source = capability.source_id, a = snapshot(), b = snapshot();
  b.knowledgeSources[0].published.hash = 'b'.repeat(64);
  for (const pin of [b.agents[0].knowledgeGrants[0], b.agents[0].versions[0].config.knowledgeGrants[0], b.runs[0].knowledgeSnapshot[0], b.runs[0].knowledgeReferences[0]]) pin.publicationHash = 'b'.repeat(64);
  const migration = (await readFile(new URL('../db/007-knowledge.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
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
    const versions = (await admin.query('SELECT version,config FROM mepchat.agent_versions WHERE tenant_id=$1 AND agent_id=$2 ORDER BY version', [data.id, data.agents[0].id])).rows;
    const { rows: [run] } = await admin.query('SELECT state,budget FROM mepchat.runs WHERE tenant_id=$1 AND id=$2', [data.id, data.runs[0].id]);
    const { rows: [message] } = await admin.query('SELECT content FROM mepchat.messages WHERE tenant_id=$1 AND id=$2', [data.id, data.conversations[0].messages[0].id]);
    return { tenant, bridge, agent, versions, run, message };
  }
  const functions = () => admin.query(`SELECT p.oid::text,p.proname,p.prosecdef,r.rolname AS owner,p.proconfig,md5(p.prosrc) AS body,
    has_function_privilege('mepchat_app',p.oid,'EXECUTE') AS app,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='mepchat_private'
    AND p.proname IN ('sync_workspace','sync_workspace_base_003','sync_workspace_base_004','sync_workspace_base_005','sync_workspace_base_006',
    'valid_automation_calendar','valid_knowledge_source','valid_knowledge_pin') ORDER BY p.proname`);

  await t.test('007 preserva os corpos anteriores e reaplica sem trocar OIDs ou ACLs', async () => {
    const previous = await functions();
    const mcp = previous.rows.find(row => row.proname === 'sync_workspace_base_006') ?? previous.rows.find(row => row.proname === 'sync_workspace');
    await apply(); const before = await functions(); await apply(); const after = await functions();
    assert.equal(after.rows.length, 8); assert.deepEqual(after.rows, before.rows);
    assert.equal(after.rows.find(row => row.proname === 'sync_workspace_base_006').body, mcp.body);
    for (const name of ['sync_workspace_base_003', 'sync_workspace_base_004', 'sync_workspace_base_005', 'valid_automation_calendar'])
      assert.deepEqual(after.rows.find(row => row.proname === name), previous.rows.find(row => row.proname === name));
    for (const fn of after.rows) {
      assert.equal(fn.owner, 'supabase_admin'); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog']); assert.equal(fn.public, false);
      assert.equal(fn.app, fn.proname === 'sync_workspace'); assert.equal(fn.prosecdef, fn.proname.startsWith('sync_workspace'));
    }
    for (const name of ['sync_workspace_base_003', 'sync_workspace_base_004', 'sync_workspace_base_005', 'sync_workspace_base_006'])
      await assert.rejects(app.query(`SELECT mepchat_private.${name}($1::jsonb,$2,1)`, [JSON.stringify(a), source]), error => error.code === '42501');
    await assert.rejects(app.query('SELECT mepchat_private.valid_knowledge_source($1::jsonb)', [JSON.stringify(a.knowledgeSources[0])]), error => error.code === '42501');
    await assert.rejects(app.query('SELECT mepchat_private.valid_knowledge_pin($1::jsonb)', [JSON.stringify(a.agents[0].knowledgeGrants[0])]), error => error.code === '42501');
  });
  await t.test('capability privada, aplicação sem SUPER/BYPASS/membership e 18 tabelas FORCE RLS', async () => {
    await assert.rejects(app.query('SELECT * FROM mepchat_private.reseller_sources'), error => error.code === '42501');
    const { rows: [role] } = await app.query("SELECT rolsuper,rolbypassrls,pg_has_role(current_user,'mepchat_owner','MEMBER') AS owner_member,pg_has_role(current_user,'supabase_admin','MEMBER') AS admin_member FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, owner_member: false, admin_member: false });
    const forced = await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mepchat' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity");
    assert.equal(forced.rows[0].n, 18);
    await assert.rejects(admin.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,1)', [JSON.stringify(a), source]), /Knowledge bridge context denied/);
  });
  await t.test('duas empresas projetam somente metadata e pins, preservando 004/005/006', async () => {
    for (const data of [a, b]) {
      assert.equal((await sync(data)).state, 'synced'); const value = await persisted(data);
      assert.deepEqual(value.tenant.settings.knowledgeSources, data.knowledgeSources);
      for (const field of ['mcpServers', 'automation', 'departments', 'contacts', 'defaultDepartmentId']) assert.deepEqual(value.tenant.settings[field], data[field]);
      assert.deepEqual(value.agent.service_plan.knowledgeGrants, data.agents[0].knowledgeGrants);
      assert.deepEqual(value.versions[0].config.knowledgeGrants, data.agents[0].versions[0].config.knowledgeGrants);
      for (const field of ['knowledgeSnapshot', 'knowledgeReferences', 'knowledgeState']) {
        assert.deepEqual(value.run.budget[field], data.runs[0][field]); assert.deepEqual(value.tenant.settings.runs[0][field], data.runs[0][field]);
      }
      assert.equal(value.run.state, data.runs[0].state);
      for (const forbidden of ['"excerpt"', '"configSecret"', '"credentials"', '"reasoning_content"']) assert.equal(JSON.stringify(value).includes(forbidden), false);
    }
  });
  await t.test('RLS isola fontes/grants/runs mesmo com IDs coincidentes; principal forjado não lê', async () => {
    assert.equal((await app.query('SELECT count(*)::int AS n FROM mepchat.tenants')).rows[0].n, 0);
    for (const [own, other] of [[a, b], [b, a]]) {
      const rows = await scoped(own, client => client.query('SELECT id,settings FROM mepchat.tenants')); assert.deepEqual(rows.rows.map(row => row.id), [own.id]);
      assert.deepEqual(rows.rows[0].settings.knowledgeSources, own.knowledgeSources);
      for (const table of ['agents', 'agent_versions', 'runs']) {
        const foreign = await scoped(own, client => client.query(`SELECT count(*)::int AS n FROM mepchat.${table} WHERE tenant_id=$1`, [other.id])); assert.equal(foreign.rows[0].n, 0);
        const permitted = await scoped(own, client => client.query(`SELECT DISTINCT tenant_id FROM mepchat.${table}`)); assert.deepEqual(permitted.rows.map(row => row.tenant_id), [own.id]);
      }
      const forged = await scoped(own, client => client.query('SELECT count(*)::int AS n FROM mepchat.tenants'), { user: 'forged-principal' }); assert.equal(forged.rows[0].n, 0);
    }
  });
  await t.test('replay antigo e snapshot legado preservam fontes, grants e metadata histórica', async () => {
    const newer = structuredClone(a); newer.knowledgeSources[0].version = 3; newer.knowledgeSources[0].archived = true; newer.knowledgeSources[0].publicationCounter = 2;
    newer.knowledgeSources[0].published = { ...newer.knowledgeSources[0].published, version: 2, hash: 'c'.repeat(64) };
    // Existing run and agent-version pins are history, not silently repinned.
    assert.equal((await sync(newer, 2)).state, 'synced'); const before = await persisted(a);
    assert.equal((await sync({ ...a, knowledgeSources: null }, 1)).state, 'already_synced'); assert.deepEqual(await persisted(a), before);
    const legacy = structuredClone(a); delete legacy.knowledgeSources; delete legacy.mcpServers; delete legacy.automation; delete legacy.contacts; delete legacy.departments; delete legacy.defaultDepartmentId;
    delete legacy.agents[0].knowledgeGrants; delete legacy.agents[0].versions[0].config.knowledgeGrants;
    for (const field of ['knowledgeSnapshot', 'knowledgeReferences', 'knowledgeState']) delete legacy.runs[0][field];
    legacy.name = 'Snapshot legado compatível'; assert.equal((await sync(legacy, 3)).state, 'synced'); const preserved = await persisted(a);
    for (const field of ['knowledgeSources', 'mcpServers', 'automation', 'departments', 'defaultDepartmentId']) assert.deepEqual(preserved.tenant.settings[field], before.tenant.settings[field]);
    assert.deepEqual(preserved.agent.service_plan.knowledgeGrants, before.agent.service_plan.knowledgeGrants);
    assert.deepEqual(preserved.versions, before.versions);
    for (const field of ['knowledgeSnapshot', 'knowledgeReferences', 'knowledgeState']) {
      assert.deepEqual(preserved.run.budget[field], before.run.budget[field]); assert.deepEqual(preserved.tenant.settings.runs[0][field], before.run.budget[field]);
    }
  });
  await t.test('fonte inválida ou texto/segredo nested reverte toda a cadeia e revisão', async () => {
    const before = await persisted(b), knowledge = b.knowledgeSources[0], publication = knowledge.published;
    const invalid = [null, {}, [{}], [{ ...knowledge, id: '' }], [{ ...knowledge, title: '' }], [{ ...knowledge, title: 'x'.repeat(121) }],
      [{ ...knowledge, category: 'x'.repeat(81) }], [{ ...knowledge, archived: 'false' }], [{ ...knowledge, version: 0 }], [{ ...knowledge, version: 1.5 }],
      [{ ...knowledge, version: 9007199254740992 }], [{ ...knowledge, publicationCounter: -1 }], [{ ...knowledge, publicationCounter: 9007199254740992 }],
      [{ ...knowledge, publicationCounter: 0 }], [{ ...knowledge, published: {} }], [{ ...knowledge, published: { ...publication, version: 0 } }],
      [{ ...knowledge, published: { ...publication, hash: 'A'.repeat(64) } }], [{ ...knowledge, published: { ...publication, hash: 'not-a-hash' } }],
      [{ ...knowledge, createdAt: {} }], [{ ...knowledge, updatedAt: null }], [knowledge, knowledge],
      Array.from({ length: 51 }, (_, i) => ({ ...knowledge, id: `excess-${i}` })), [{ ...knowledge, content: 'x'.repeat(2097152) }]];
    for (const field of ['content', 'text', 'excerpt', 'token', 'apiKey', 'secret', 'configSecret', 'credentials', 'authorization', 'headers']) {
      invalid.push([{ ...knowledge, [field]: { nested: 'synthetic-private' } }]); invalid.push([{ ...knowledge, published: { ...publication, [field]: { nested: 'synthetic-private' } } }]);
    }
    for (const catalogue of invalid) {
      const bad = structuredClone(b); bad.knowledgeSources = catalogue; bad.name = 'Nome que deve reverter'; bad.runs[0].state = 'cancelled';
      bad.mcpServers[0].enabled = false; bad.automation.version = 2; bad.conversations[0].messages[0].text = 'Mensagem que deve reverter';
      await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before);
    }
  });
  await t.test('pins/references malformados, duplicados, estrangeiros ou excessivos são rejeitados', async () => {
    const before = await persisted(b), pin = b.agents[0].knowledgeGrants[0], reference = b.runs[0].knowledgeReferences[0];
    const pins = [null, {}, [{}], [{ ...pin, sourceId: '' }], [{ ...pin, sourceId: 'foreign-source' }], [{ ...pin, publicationVersion: 0 }],
      [{ ...pin, publicationVersion: 1.5 }], [{ ...pin, publicationVersion: 9007199254740992 }], [{ ...pin, publicationHash: 'bad' }], [pin, pin],
      Array.from({ length: 17 }, (_, i) => ({ ...pin, sourceId: `excess-${i}` }))];
    for (const field of ['content', 'text', 'excerpt', 'secret', 'credentials']) pins.push([{ ...pin, [field]: { nested: 'synthetic-private' } }]);
    for (const catalogue of pins) {
      for (const location of ['current', 'history', 'run']) {
        const bad = structuredClone(b);
        if (location === 'current') bad.agents[0].knowledgeGrants = catalogue;
        if (location === 'history') bad.agents[0].versions[0].config.knowledgeGrants = catalogue;
        if (location === 'run') bad.runs[0].knowledgeSnapshot = catalogue;
        await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before);
      }
    }
    const references = [null, {}, [{}], [{ ...reference, sourceId: 'foreign-source' }], [{ ...reference, title: '' }], [{ ...reference, chunkId: '' }],
      [{ ...reference, publicationHash: 'c'.repeat(64) }], [{ ...reference, publicationVersion: 2 }], [reference, reference],
      Array.from({ length: 6 }, (_, i) => ({ ...reference, chunkId: `excess-${i}` }))];
    for (const field of ['content', 'text', 'excerpt', 'secret', 'credentials']) references.push([{ ...reference, [field]: { nested: 'synthetic-private' } }]);
    for (const catalogue of references) {
      const bad = structuredClone(b); bad.runs[0].knowledgeReferences = catalogue;
      await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before);
    }
    for (const state of [null, {}, '', 'free-text-state']) {
      const bad = structuredClone(b); bad.runs[0].knowledgeState = state;
      await assert.rejects(sync(bad, 2), error => error.code === '22023'); assert.deepEqual(await persisted(b), before);
    }
  });
  await t.test('entrada inválida em empresa nova reverte provisionamento, capability e memberships', async () => {
    const fresh = snapshot(); fresh.knowledgeSources[0].published.content = 'Texto privado sintético';
    await assert.rejects(sync(fresh), error => error.code === '22023');
    for (const [table, column, identity] of [['mepchat.resellers', 'id', fresh.resellerId], ['mepchat.tenants', 'id', fresh.id],
      ['mepchat_private.reseller_sources', 'reseller_id', fresh.resellerId], ['mepchat_private.reseller_memberships', 'reseller_id', fresh.resellerId],
      ['mepchat_private.bridge_state', 'tenant_id', fresh.id], ['mepchat_private.tenant_memberships', 'tenant_id', fresh.id]])
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [identity])).rows[0].n, 0);
  });
  await t.test('limpeza explícita aceita [] e snapshot sem conhecimento preserva esse vazio', async () => {
    const clear = structuredClone(b); clear.knowledgeSources = []; clear.agents[0].knowledgeGrants = []; clear.agents[0].versions = [];
    clear.runs[0].knowledgeSnapshot = []; clear.runs[0].knowledgeReferences = []; clear.runs[0].knowledgeState = 'not_configured';
    assert.equal((await sync(clear, 2)).state, 'synced');
    const omitted = structuredClone(clear); delete omitted.knowledgeSources; delete omitted.agents[0].knowledgeGrants;
    for (const field of ['knowledgeSnapshot', 'knowledgeReferences', 'knowledgeState']) delete omitted.runs[0][field];
    assert.equal((await sync(omitted, 3)).state, 'synced'); const saved = await persisted(b);
    assert.deepEqual(saved.tenant.settings.knowledgeSources, []); assert.deepEqual(saved.agent.service_plan.knowledgeGrants, []);
    assert.deepEqual(saved.run.budget.knowledgeSnapshot, []); assert.deepEqual(saved.run.budget.knowledgeReferences, []); assert.equal(saved.run.budget.knowledgeState, 'not_configured');
    const draft = snapshot(); draft.knowledgeSources[0].published = null; draft.knowledgeSources[0].publicationCounter = 0;
    draft.agents[0].knowledgeGrants = []; draft.agents[0].versions = []; draft.runs[0].knowledgeSnapshot = []; draft.runs[0].knowledgeReferences = []; draft.runs[0].knowledgeState = 'no_match';
    assert.equal((await sync(draft)).state, 'synced'); assert.deepEqual((await persisted(draft)).tenant.settings.knowledgeSources, draft.knowledgeSources);
  });
  await t.test('GUC/source/revenda divergentes não escrevem conhecimento nem projeções anteriores', async () => {
    const beforeA = await persisted(a), beforeB = await persisted(b);
    for (const options of [{ resellerId: b.resellerId }, { tenantId: b.id }, { user: 'forged-principal' }, { source: randomUUID() }])
      await assert.rejects(sync(a, 10, { ...options, provision: false }));
    await assert.rejects(sync({ ...a, resellerId: b.resellerId }, 10, { provision: false }));
    assert.deepEqual(await persisted(a), beforeA); assert.deepEqual(await persisted(b), beforeB);
  });
});
