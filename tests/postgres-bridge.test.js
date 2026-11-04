import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Store } from '../src/store.js';
import { PostgresBridge, directPoolConfig } from '../src/postgres-bridge.js';
import { FlowService } from '../src/flows.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WebchatGateway } from '../src/channel-webchat.js';
import { WebchatIdentity } from '../src/webchat-identity.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Bridge QA' };
function fakePool(handler = async () => {}) {
  const calls = []; let releases = 0;
  return { calls, get releases() { return releases; }, on() {}, async end() {}, async connect() {
    return { async query(sql, values) { calls.push({ sql, values }); return await handler(sql, values) || { rows: [] }; }, release() { releases++; } };
  } };
}
function setup(t, pool) {
  const store = new Store(':memory:'), bridge = new PostgresBridge(store, { pool });
  t.after(async () => { await bridge.close(); store.close(); });
  const tenant = store.createTenant(actor, { name: 'Bridge QA', segment: 'Fixture sintética' });
  return { store, bridge, tenant };
}

test('collaboration roster and transient reply authority stay out of PostgreSQL spool without changing SQLite',t=>{
 const {store,bridge,tenant}=setup(t,fakePool());
 store.mutate(actor,tenant.id,'Synthetic collaboration',state=>{state.conversations=[{id:'synthetic-attendance',owner:'human',assignedUserId:'synthetic-owner',participants:[{userId:'synthetic-member',name:'Synthetic member',addedAt:'2026-10-02T12:00:00Z',addedByUserId:'synthetic-owner'}],attendanceAccess:{canReply:true,canManageParticipants:true},messages:[]}];});
 bridge.queue(tenant.id);
 const snapshot=JSON.parse(store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(tenant.id).payload);
 assert.equal(snapshot.conversations[0].participants,undefined);assert.equal(snapshot.conversations[0].attendanceAccess,undefined);assert.equal(snapshot.conversations[0].assignedUserId,'synthetic-owner');
 const local=store.tenant(actor,tenant.id).conversations[0];assert.equal(local.participants.length,1);assert.equal(local.participants[0].userId,'synthetic-member');assert.equal(local.attendanceAccess.canReply,true);
});

test('projeção real da bridge conserva identidade pública e isola empresas sem JWT, chaves ou tabelas privadas', async t => {
  const pool = fakePool(), c = setup(t,pool), now = Date.parse('2026-10-09T12:00:00Z'), origin = 'https://bridge-identity.example.test';
  const auth = new Auth(c.store.db,{validateTenant:(current,id) => c.store.tenant(current,id)});
  const ownerRow = auth.insertUser({username:'bridge.identity.owner',name:'Owner sintético'},Buffer.alloc(16,7),Buffer.alloc(64,7),'reseller',[],'mep-demo'), owner = auth.actor(ownerRow), authority = {reauthorize:() => auth.actor(ownerRow)};
  const other = c.store.createTenant(owner,{name:'Outra identidade bridge',segment:'QA'}), gateway = new WebchatGateway(c.store,{operations:new Operations(c.store,auth),now:() => now});
  const secrets = encryptedChannelSecrets(c.store.db,Buffer.alloc(32,17)), identity = new WebchatIdentity(c.store,{secrets,channelContext:input => gateway.identityContext(input),now:() => now}); gateway.identity = identity;
  t.after(() => gateway.close());
  const contexts = [];
  for (const [index,tenant] of [c.tenant,other].entries()) {
    const channelId = 'bridge-identity-site-' + index;
    c.store.mutate(owner,tenant.id,'Fixture identidade bridge',state => {state.channels = [{id:channelId,kind:'webchat',state:'planned'}];});
    gateway.configure(owner,tenant.id,channelId,{version:0,origins:[origin]});
    identity.configure(owner,tenant.id,channelId,{version:0,enabled:true,issuer:origin,externalIdPrefix:'mepmail'},authority);
    const key = identity.createKey(owner,tenant.id,channelId,{version:1},authority), jti = randomUUID(), issued = Math.floor(now/1000);
    const head = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT',kid:key.kid})).toString('base64url'), body = Buffer.from(JSON.stringify({iss:origin,aud:'elozi:webchat:'+channelId,sub:'same-account-two-companies',email:'verified@example.test',email_verified:true,name:'Pessoa bridge '+index,locale:'pt-BR',iat:issued-1,exp:issued+599,jti,ctx:{teamId:'company-'+index,mailboxes:2}})).toString('base64url');
    const jwt = `${head}.${body}.${createHmac('sha256',key.secret).update(`${head}.${body}`).digest('base64url')}`, challenge = gateway.challenge({tenantId:tenant.id,channelId,origin}), session = gateway.openSession({tenantId:tenant.id,channelId,origin,challenge:challenge.challenge,identityToken:jwt});
    await gateway.receive({token:session.token,tenantId:tenant.id,channelId,origin,clientMessageId:randomUUID(),text:'Somente empresa '+index});
    contexts.push({tenant,channelId,key,jti,jwt,session});
  }
  const tables = ['webchat_visitor_profiles','webchat_identity_jti','webchat_identity_sessions'], before = Object.fromEntries(tables.map(table => [table,c.store.db.prepare('SELECT * FROM '+table+' ORDER BY tenant_id').all()]));
  for (const table of tables) assert.equal(before[table].length,2);
  for (const context of contexts) {
    c.bridge.queue(context.tenant.id);
    const raw = c.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(context.tenant.id).payload, snapshot = JSON.parse(raw);
    assert.equal(snapshot.id,context.tenant.id); assert.equal(snapshot.channels[0].webchat.identity.issuer,origin); assert.equal(snapshot.channels[0].webchat.identity.keys[0].kid,context.key.kid);
    assert.equal(snapshot.contacts.length,1); assert.equal(snapshot.contacts[0].identities[0].externalId,'mepmail:same-account-two-companies'); assert.equal(snapshot.contacts[0].identities[0].channelId,context.channelId);
    assert.equal(snapshot.conversations.length,1); assert.equal(snapshot.conversations[0].channelId,context.channelId);
    for (const secret of contexts.flatMap(item => [item.key.secret,item.jti,item.jwt,item.session.token])) assert.equal(raw.includes(secret),false);
    for (const privateField of [...tables,'channel_secrets','token_hash','jti_hash','verified_at','revoked_at','webchatIdentity']) assert.equal(raw.includes(privateField),false);
  }
  await c.bridge.flush();
  const writes = pool.calls.filter(call => call.sql.includes('sync_workspace')); assert.equal(writes.length,2);
  for (const table of tables) assert.deepEqual(c.store.db.prepare('SELECT * FROM '+table+' ORDER BY tenant_id').all(),before[table],table+' is not altered by projection');
  assert.equal(c.bridge.status().pending,0);
});

test('pool direto tem limites de conexão, comando e transação ociosa sem mudar destino ou credenciais', () => {
  const credentials = { database: 'mepchat', user: 'mepchat_app', password: 'synthetic-password' }, config = directPoolConfig(credentials);
  assert.deepEqual({ ...config }, { ...credentials, host: 'supabase-db', port: 5432, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 15000,
    statement_timeout: 120000, query_timeout: 125000, idle_in_transaction_session_timeout: 60000 });
  assert.ok(config.query_timeout > config.statement_timeout, 'o servidor cancela antes de o cliente desistir');
  // A large company projection (whole document in one statement) must not be cancelled on every flush and block the spool.
  assert.ok(config.statement_timeout >= 120000, 'projeção grande não é cancelada a cada ciclo');
  const pool = new Pool(config);
  try { for (const key of ['statement_timeout', 'query_timeout', 'idle_in_transaction_session_timeout', 'connectionTimeoutMillis']) assert.equal(pool.options[key], config[key], key); }
  finally { pool.end().catch(() => {}); }
});

test('cliente que falhou no meio da projeção é descartado, não devolvido ao pool', async t => {
  const released = [];
  const pool = { on() {}, async end() {}, async connect() { return { async query(sql) { if (sql.includes('sync_workspace')) throw Object.assign(new Error('Query read timeout'), { code: 'TIMEOUT' }); return { rows: [] }; }, release(error) { released.push(error); } }; } };
  const c = setup(t, pool);
  await assert.rejects(c.bridge.flush(), /local queue preserved/);
  assert.equal(released.length, 1); assert.match(released[0].message, /timeout/i);
  assert.equal(c.bridge.status().state, 'offline'); assert.equal(c.bridge.status().pending, 1);
  const healthy = { on() {}, async end() {}, async connect() { return { async query() { return { rows: [] }; }, release(error) { released.push(error); } }; } };
  c.bridge.pool = healthy; await c.bridge.flush();
  assert.equal(released.at(-1), undefined, 'sucesso devolve a conexão normalmente'); assert.equal(c.bridge.status().pending, 0);
});

test('bridge mantém fila e source estável na falha e reprocessa a mesma revisão', async t => {
  let fail = true;
  const pool = fakePool(async sql => { if (fail && sql.includes('sync_workspace')) throw new Error('Fixture: falha PostgreSQL'); });
  const c = setup(t, pool), original = c.store.db.prepare('SELECT * FROM postgres_spool').get();
  await assert.rejects(c.bridge.flush(), /local queue preserved/);
  assert.equal(c.bridge.status().state, 'offline'); assert.equal(c.bridge.status().pending, 1);
  assert.deepEqual(c.store.db.prepare('SELECT * FROM postgres_spool').get(), original);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.equal(pool.releases, 1);
  fail = false; await c.bridge.flush();
  const writes = pool.calls.filter(call => call.sql.includes('sync_workspace'));
  assert.equal(writes.length, 2); assert.equal(writes[0].values[1], writes[1].values[1]); assert.equal(writes[0].values[2], writes[1].values[2]);
  assert.equal(c.bridge.status().pending, 0); assert.equal(c.bridge.status().state, 'synced');
});

test('commit antigo não apaga snapshot SQLite mais recente enfileirado durante o flush', async t => {
  let c, commits = 0, newerRevision;
  const pool = fakePool(async sql => {
    if (sql === 'COMMIT' && ++commits === 1) {
      c.store.mutate(actor, c.tenant.id, 'Fixture atualização concorrente', state => { state.name = 'Bridge QA mais recente'; });
      newerRevision = c.store.db.prepare('SELECT revision FROM postgres_spool').get().revision;
    }
  });
  c = setup(t, pool); await c.bridge.flush();
  const writes = pool.calls.filter(call => call.sql.includes('sync_workspace'));
  assert.equal(writes.length, 2); assert.ok(newerRevision > writes[0].values[2]); assert.equal(writes[1].values[2], newerRevision);
  assert.equal(JSON.parse(writes[1].values[0]).name, 'Bridge QA mais recente'); assert.equal(c.bridge.status().pending, 0);
});

test('flush simultâneo compartilha processamento e conserva uma única escrita por job', async t => {
  let release, reached, writes = 0;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { reached = resolve; });
  const pool = fakePool(async sql => { if (sql.includes('sync_workspace')) { writes++; reached(); await gate; } });
  const c = setup(t, pool), first = c.bridge.flush(), second = c.bridge.flush();
  await began;
  try { assert.equal(writes, 1); } finally { release(); }
  await Promise.all([first, second]); assert.equal(writes, 1); assert.equal(pool.releases, 1);
});

test('marca da revenda enfileira todos os workspaces na mesma transação', async t => {
  const c = setup(t, fakePool());
  const brand = { name: 'Marca QA', initials: 'QA', accent: '#3157d5', domain: '' };
  c.store.setResellerBrand(actor, brand);
  const jobs = c.store.db.prepare('SELECT payload FROM postgres_spool').all();
  assert.equal(jobs.length, c.store.list(actor).length);
  for (const job of jobs) assert.deepEqual(JSON.parse(job.payload).reseller.brand, brand);
  await c.bridge.flush();
  assert.equal(c.bridge.status().pending, 0);
});

test('transporte SSH mantém fila na falha e só remove a revisão confirmada', async t => {
  const store = new Store(':memory:'); let fail = true; const calls = [];
  const transport = { async sync(job) { calls.push(job); if (fail) throw Error('Falha sintética'); }, close() {} };
  const bridge = new PostgresBridge(store, { transport });
  t.after(async () => { await bridge.close(); store.close(); });
  store.createTenant(actor, { name: 'SSH QA', segment: 'Fixture sintética' });
  await assert.rejects(bridge.flush(), /local queue preserved/);
  assert.equal(bridge.status().pending, 1);
  fail = false; await bridge.flush();
  assert.equal(bridge.status().pending, 0);
  assert.equal(calls[0].sourceId, calls[1].sourceId);
  assert.equal(calls[0].revision, calls[1].revision);
});

// Opt-in only. The calling executor owns schema provisioning and fixture cleanup.
// Never connect to a VPS, real database, or arbitrary host from these tests.
const appUrl = process.env.MEPCHAT_TEST_PG_URL;
function localFixtureUrl(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/mepchat' || !['15438', '5432'].includes(url.port || '5432')) throw new Error('PostgreSQL test requires the explicit local mepchat fixture.');
  return value;
}
function snapshot(id, name) {
  const date = new Date().toISOString(), channelId = `${id}-channel`, conversationId = `${id}-conversation`;
  return { id, resellerId: 'mep-demo', name, brand: {}, segment: 'QA', plan: 'Local', reseller: { name: 'MEP Partner QA', brand: {} },
    channels: [{ id: channelId, kind: 'telegram', name: 'Bot QA', state: 'planned' }], agents: [], audit: [],
    conversations: [{ id: conversationId, channelId, contact: 'Contato sintético', status: 'open', owner: 'human', version: 1, unread: 1, updatedAt: date, messages: [{ id: `${id}-message`, externalId: `${id}:1`, kind: 'customer', text: 'Fixture sintética', delivery: 'received', createdAt: date }] }],
    outbox: [{ id: `${id}-job`, conversation_id: conversationId, channel_id: channelId, version: 1, idempotency_key: randomUUID(), content_hash: 'fixture-sha', payload: JSON.stringify({ text: 'Fixture' }), state: 'pending', attempts: 0, created_at: date }]
  };
}

test('PostgreSQL real: definer restrito, RLS, replay, source e rollback atômico', { skip: !appUrl && 'MEPCHAT_TEST_PG_URL não definido; fixture PostgreSQL é opt-in' }, async t => {
  const adminUrl = process.env.MEPCHAT_TEST_PG_ADMIN_URL;
  if (!adminUrl) throw new Error('MEPCHAT_TEST_PG_ADMIN_URL is required for the disposable local fixture.');
  const app = new Pool({ connectionString: localFixtureUrl(appUrl), max: 2 }), admin = new Pool({ connectionString: localFixtureUrl(adminUrl), max: 1 });
  t.after(async () => { await Promise.all([app.end(), admin.end()]); });
  const prefix = `bridge-qa-${randomUUID()}`, a = snapshot(`${prefix}-a`, 'Bridge QA A'), b = snapshot(`${prefix}-b`, 'Bridge QA B'), source = randomUUID();
  async function scoped(query, tenantId, user = 'mepchat-local-bridge', reseller = 'mep-demo') {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('mepchat.user_id',$1,true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$3,true)", [user, reseller, tenantId]);
      const result = await query(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const sync = (data, revision, sourceId = source, options = {}) => scoped(client => client.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,$3::bigint) AS result', [JSON.stringify(data), sourceId, revision]), options.tenantId || data.id, options.user || 'mepchat-local-bridge', options.reseller || 'mep-demo');

  await t.test('runtime continua sem superuser, bypass ou membership no owner', async () => {
    const { rows: [role] } = await app.query("SELECT current_user AS name,rolsuper,rolbypassrls,pg_has_role(current_user,'mepchat_owner','MEMBER') AS owner_member FROM pg_roles WHERE rolname=current_user");
    assert.equal(role.name, 'mepchat_app'); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false); assert.equal(role.owner_member, false);
    const { rows: [definition] } = await admin.query("SELECT r.rolname AS owner,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='mepchat_private' AND p.proname='sync_workspace'");
    assert.equal(definition.owner, 'supabase_admin'); assert.equal(definition.prosecdef, true);
  });
  await t.test('GUC inválido e contexto de tenant divergente são rejeitados sem criar dados', async () => {
    await assert.rejects(sync(a, 1, source, { user: 'principal-forjado' }));
    await assert.rejects(sync(a, 1, source, { reseller: 'revenda-forjada' }));
    await assert.rejects(sync(a, 1, source, { tenantId: b.id }));
    const { rows: [count] } = await admin.query('SELECT count(*)::int AS n FROM mepchat.tenants WHERE id=$1', [a.id]); assert.equal(count.n, 0);
  });
  await t.test('app sincroniza dois tenants; leitura sem contexto é zero e seleção respeita tenant', async () => {
    assert.equal((await sync(a, 1)).rows[0].result.state, 'synced'); await sync(b, 1);
    const empty = await app.query('SELECT count(*)::int AS n FROM mepchat.messages'); assert.equal(empty.rows[0].n, 0);
    const selected = await scoped(client => client.query('SELECT tenant_id FROM mepchat.messages'), a.id);
    assert.deepEqual(selected.rows.map(row => row.tenant_id), [a.id]);
    const denied = await scoped(client => client.query('SELECT count(*)::int AS n FROM mepchat.messages'), a.id, 'principal-forjado'); assert.equal(denied.rows[0].n, 0);
  });
  await t.test('replay e revisão antiga não duplicam jobs nem regridem snapshot; outra source é negada', async () => {
    const newer = structuredClone(a); newer.name = 'Bridge QA A versão 2'; newer.conversations[0].version = 2;
    await sync(newer, 2);
    assert.equal((await sync(a, 1)).rows[0].result.state, 'already_synced'); assert.equal((await sync(newer, 2)).rows[0].result.state, 'already_synced');
    await assert.rejects(sync(newer, 3, randomUUID()));
    const { rows: [saved] } = await admin.query('SELECT name FROM mepchat.tenants WHERE id=$1', [a.id]); assert.equal(saved.name, newer.name);
    const { rows: [jobs] } = await admin.query('SELECT count(*)::int AS n FROM mepchat.outbox_commands WHERE tenant_id=$1', [a.id]); assert.equal(jobs.n, 1);
    const { rows: [messages] } = await admin.query('SELECT count(*)::int AS n FROM mepchat.messages WHERE tenant_id=$1', [a.id]); assert.equal(messages.n, 1);
  });
  await t.test('tenant de outra revenda não pode ser sobrescrito pelo definer', async () => {
    const resellerId = `${prefix}-other`, tenantId = `${prefix}-foreign`;
    await admin.query('INSERT INTO mepchat.resellers(id,name) VALUES($1,$2)', [resellerId, 'Revenda QA externa']);
    await admin.query('INSERT INTO mepchat.tenants(id,reseller_id,name) VALUES($1,$2,$3)', [tenantId, resellerId, 'Tenant QA preservado']);
    await assert.rejects(sync(snapshot(tenantId, 'Tentativa inválida'), 1));
    const { rows: [saved] } = await admin.query('SELECT reseller_id,name FROM mepchat.tenants WHERE id=$1', [tenantId]); assert.equal(saved.reseller_id, resellerId); assert.equal(saved.name, 'Tenant QA preservado');
  });
  await t.test('FK inválida desfaz tenant, contatos, mensagens, jobs e avanço de revisão', async () => {
    const bad = snapshot(`${prefix}-bad`, 'Não deve persistir'); bad.conversations[0].channelId = `${a.id}-channel`;
    await assert.rejects(sync(bad, 1), error => error.code === '23503');
    for (const table of ['tenants', 'channels', 'contacts', 'conversations', 'messages', 'outbox_commands']) {
      const field = table === 'tenants' ? 'id' : 'tenant_id';
      const { rows: [count] } = await admin.query(`SELECT count(*)::int AS n FROM mepchat.${table} WHERE ${field}=$1`, [bad.id]); assert.equal(count.n, 0, table);
    }
    const { rows: [state] } = await admin.query('SELECT count(*)::int AS n FROM mepchat_private.bridge_state WHERE tenant_id=$1', [bad.id]); assert.equal(state.n, 0);
  });
  await t.test('bridge JavaScript envia snapshot completo do Store ao app restrito no primeiro flush', async () => {
    const store = new Store(':memory:'), pool = new Pool({ connectionString: localFixtureUrl(appUrl), max: 1 });
    const bridge = new PostgresBridge(store, { pool });
    try {
      const demo = store.tenant(actor, 'playtech-demo');
      const tenant = store.createTenant(actor, { name: 'Bridge Store QA', segment: 'Fixture sintética' });
      store.mutate(actor, tenant.id, 'Fixture snapshot completo', state => { state.channels = demo.channels; state.agents = demo.agents; state.conversations = demo.conversations; });
      await bridge.flush();
      assert.equal(bridge.status().state, 'synced'); assert.equal(bridge.status().pending, 0);
      const { rows: [count] } = await admin.query('SELECT count(*)::int AS n FROM mepchat.conversations WHERE tenant_id=$1', [tenant.id]);
      assert.equal(count.n, demo.conversations.length);
      const { rows: [messages] } = await admin.query('SELECT count(*)::int AS n FROM mepchat.messages WHERE tenant_id=$1', [tenant.id]);
      assert.equal(messages.n, demo.conversations.reduce((total, conversation) => total + conversation.messages.length, 0));
    } finally { await bridge.close(); store.close(); }
  });
  await t.test('fluxo rascunho/publicado e run da versão 2 preservam versões e rollback por FK', async () => {
    const store = new Store(':memory:'), pool = new Pool({ connectionString: localFixtureUrl(appUrl), max: 1 });
    const bridge = new PostgresBridge(store, { pool }), flows = new FlowService(store);
    try {
      const tenant = store.createTenant(actor, { name: 'Versões nativas QA', segment: 'Fixture sintética' });
      const data = snapshot(tenant.id, tenant.name), agentId = randomUUID();
      const config = { provider: 'hermes', mode: 'copilot', description: 'Versão publicada sintética 2' };
      store.mutate(actor, tenant.id, 'Fixture versões de agente', state => {
        state.channels = data.channels; state.conversations = data.conversations;
        state.agents = [{ id: agentId, name: 'Hermes QA', provider: 'hermes', state: 'planned', version: 2,
          versions: [{ version: 1, config: { ...config, description: 'Versão sintética 1' } }, { version: 2, config }] }];
      });
      const flow = flows.create(actor, tenant.id, { name: 'Fluxo QA nativo' });
      await bridge.flush();
      const draft = await admin.query('SELECT state FROM mepchat.flows WHERE tenant_id=$1 AND id=$2', [tenant.id, flow.id]);
      assert.equal(draft.rows[0].state, 'draft');
      const published = flows.publish(actor, tenant.id, flow.id, { version: flow.version });
      const runId = randomUUID();
      store.mutate(actor, tenant.id, 'Fixture run versão 2', state => {
        state.runs = [{ id: runId, conversationId: data.conversations[0].id, conversationVersion: 1,
          agentId, agentVersion: 2, state: 'draft', startedAt: new Date().toISOString() }];
      });
      await bridge.flush();
      const versions = await admin.query('SELECT version,config FROM mepchat.agent_versions WHERE tenant_id=$1 AND agent_id=$2 ORDER BY version', [tenant.id, agentId]);
      assert.deepEqual(versions.rows.map(row => row.version), [1, 2]); assert.deepEqual(versions.rows[1].config, config);
      const savedFlow = await admin.query('SELECT f.state,v.version,v.graph,v.published_at FROM mepchat.flows f JOIN mepchat.flow_versions v ON v.tenant_id=f.tenant_id AND v.flow_id=f.id WHERE f.tenant_id=$1 AND f.id=$2', [tenant.id, flow.id]);
      assert.equal(savedFlow.rows[0].state, 'published'); assert.equal(savedFlow.rows[0].version, 1);
      assert.deepEqual(savedFlow.rows[0].graph, published.versions[0].graph);
      assert.equal(savedFlow.rows[0].published_at.toISOString(), published.versions[0].publishedAt);
      const run = await admin.query('SELECT agent_id,agent_version FROM mepchat.runs WHERE tenant_id=$1 AND id=$2', [tenant.id, runId]);
      assert.deepEqual(run.rows[0], { agent_id: agentId, agent_version: 2 });
      store.mutate(actor, tenant.id, 'Fixture tentativa de regravar versões publicadas', state => {
        state.agents[0].versions[1].config = { description: 'Não substituir versão 2' };
        state.flows[0].versions[0].graph = { nodes: [], edges: [] };
      });
      await bridge.flush();
      const immutable = await admin.query('SELECT config FROM mepchat.agent_versions WHERE tenant_id=$1 AND agent_id=$2 AND version=2', [tenant.id, agentId]);
      assert.deepEqual(immutable.rows[0].config, config);
      const immutableGraph = await admin.query('SELECT graph FROM mepchat.flow_versions WHERE tenant_id=$1 AND flow_id=$2 AND version=1', [tenant.id, flow.id]);
      assert.deepEqual(immutableGraph.rows[0].graph, published.versions[0].graph);
      const revision = await admin.query('SELECT revision FROM mepchat_private.bridge_state WHERE tenant_id=$1', [tenant.id]);
      store.mutate(actor, tenant.id, 'Fixture FK de run inválida', state => {
        state.name = 'Não deve substituir tenant';
        state.runs.push({ ...state.runs[0], id: randomUUID(), agentVersion: 999 });
      });
      await assert.rejects(bridge.flush(), /local queue preserved/); assert.equal(bridge.status().pending, 1);
      const retained = await admin.query('SELECT t.name,b.revision,(SELECT count(*)::int FROM mepchat.runs r WHERE r.tenant_id=t.id) AS runs FROM mepchat.tenants t JOIN mepchat_private.bridge_state b ON b.tenant_id=t.id WHERE t.id=$1', [tenant.id]);
      assert.equal(retained.rows[0].name, tenant.name); assert.equal(retained.rows[0].revision, revision.rows[0].revision); assert.equal(retained.rows[0].runs, 1);
    } finally { await bridge.close(); store.close(); }
  });
});
