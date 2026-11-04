import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const owner = { role: 'reseller', resellerId: 'mep-demo', name: 'Synthetic owner' };
const source = () => ({ name: 'Synthetic company', segment: 'Synthetic segment', plan: 'Synthetic plan', identityVersion: 7,
  parentTenantId: 'hidden-parent', brand: { name: 'Synthetic brand', accent: '#3157d5' },
  channels: [{ id: 'wa', kind: 'whatsapp_qr', allowedGroups: ['synthetic@g.us'] }, { id: 'tg', kind: 'telegram', telegramGroups: { mode: 'allowlist', groupIds: ['-123'] } }],
  agents: [], departments: [{ id: 'sales', name: 'Sales' }, { id: 'support', name: 'Support' }],
  conversations: [
    { id: 'a', channelId: 'wa', department: 'Sales', status: 'open', messages: [{ text: 'HISTORY_MUST_NOT_BE_PARSED' }] },
    { id: 'b', channelId: 'tg', departmentId: 'support', status: 'pending', messages: [] },
    { id: 'c', channelId: 'wa', departmentId: 'sales', status: 'closed', messages: [] },
    { id: 'unknown', channelId: 'removed', departmentId: 'sales', status: 'open', messages: [] }
  ] });
function seed(store) {
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('startup-a', owner.resellerId, JSON.stringify(source()));
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('hidden-parent', owner.resellerId, JSON.stringify({ ...source(), name: 'Hidden parent' }));
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('foreign-workspace', '{}');
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('foreign-tenant', 'foreign-workspace', JSON.stringify(source()));
}
function historyFence(store) {
  const full = store.tenant, parse = JSON.parse;
  let histories = 0;
  store.tenant = () => { throw Error('Full-history tenant forbidden'); };
  JSON.parse = function (value, ...rest) {
    if (typeof value === 'string' && value.includes('HISTORY_MUST_NOT_BE_PARSED')) { histories++; throw Error('History parsed'); }
    return parse(value, ...rest);
  };
  return () => { store.tenant = full; JSON.parse = parse; assert.equal(histories, 0); };
}
for (const conversationJournal of [false, true]) {
  test(`header and bootstrap summaries preserve private metadata without reading histories (journal=${conversationJournal})`, t => {
    const store = new Store(':memory:', { conversationJournal }); t.after(() => store.close()); seed(store);
    const restore = historyFence(store);
    try {
      const header = store.readonlyTenantHeader(owner, 'startup-a');
      assert.equal(header.name, source().name); assert.equal(header.plan, source().plan);
      assert.deepEqual(header.brand, source().brand); assert.equal(header.identityVersion, 7);
      assert.equal(Object.hasOwn(header, 'conversations'), false);
      assert.deepEqual(header.channels[0].allowedGroups, ['synthetic@g.us']);
      assert.deepEqual(header.channels[1].telegramGroups, source().channels[1].telegramGroups);
      assert.throws(() => header.channels.push({ id: 'poison' }), TypeError);
      const next = store.readonlyTenantHeader(owner, 'startup-a', { conversationSummaries: true });
      assert.notStrictEqual(next, header); assert.strictEqual(next.channels, header.channels);
      assert.equal(next.conversations.length, 4); assert.ok(next.conversations.every(item => !Object.hasOwn(item, 'messages')));
      const restricted = { ...owner, role: 'operator', tenantIds: ['startup-a'] };
      assert.throws(() => store.readonlyTenantHeader(restricted, 'hidden-parent'), error => error.status === 403);
      assert.throws(() => store.readonlyTenantHeader(owner, 'foreign-tenant'), error => error.status === 404);
    } finally { restore(); }
  });
}

test('header authority stays live through canonical writes, rollback, index version changes and invalid tokens', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seed(store);
  const read = () => store.readonlyTenantHeader(owner, 'startup-a');
  const original = read();
  store.db.exec('BEGIN IMMEDIATE');
  store.db.prepare("UPDATE tenants SET data=json_set(data,'$.channels',json('[]'),'$.name','uncommitted') WHERE id=?").run('startup-a');
  assert.equal(read().channels.length, 0); assert.equal(read().name, 'uncommitted');
  store.db.exec('ROLLBACK');
  assert.deepEqual(read().channels, original.channels); assert.equal(read().name, original.name);
  store.db.prepare("UPDATE tenants SET data=json_set(data,'$.name','fresh canonical') WHERE id=?").run('startup-a');
  assert.equal(read().name, 'fresh canonical');
  store.db.exec("UPDATE service_read_model_meta SET version=8 WHERE id='routing'");
  assert.throws(read, error => error.status === 404);
  store.db.exec("UPDATE service_read_model_meta SET version=9 WHERE id='routing'");
  store.db.prepare("UPDATE service_tenant_private SET header_token='' WHERE tenant_id=?").run('startup-a');
  assert.throws(read, error => error.code === 'ELOZI_READONLY_HEADER_TOKEN');
});

test('malformed canonical JSON remains an error rather than a cached authorization or full-history fallback', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seed(store);
  store.readonlyTenantHeader(owner, 'startup-a');
  store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run('{', 'startup-a');
  assert.throws(() => store.readonlyTenantHeader(owner, 'startup-a'), /malformed JSON/i);
  store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(source()), 'startup-a');
  assert.equal(store.readonlyTenantHeader(owner, 'startup-a').name, source().name);
});

async function appFixture(t) {
  const key = randomBytes(32), deny = async () => { throw Error('External transport forbidden'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny } });
  seed(app.store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const person = (username, role, scopeRules = null) => {
    const row = app.auth.insertUser({ name: username, username }, Buffer.alloc(16, 3), Buffer.alloc(64, 4), role, role === 'operator' ? ['startup-a'] : []);
    if (scopeRules) app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify(scopeRules), row.id);
    const { token } = app.auth.session(app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    return { actor: app.auth.workspaceActor(app.auth.authenticate(token)), cookie: 'mep_session=' + token, id: row.id };
  };
  const request = cookie => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path: '/api/bootstrap', headers: { Cookie: cookie } }, response => {
      const chunks = []; response.on('data', value => chunks.push(value)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end();
  });
  return { app, person, request };
}

test('real Auth permission contexts and assignees remain equivalent to full snapshots, without history reads', async t => {
  const { app, person } = await appFixture(t), admin = person('startup.owner', 'reseller');
  const operator = person('startup.operator', 'operator', { 'startup-a': { channelIds: ['wa'], departmentIds: ['sales'] } });
  const contexts = [{ tenantId: 'startup-a', aggregate: true }, { tenantId: 'startup-a', channelId: 'wa', departmentId: 'sales' },
    { tenantId: 'startup-a', channelId: 'tg', departmentId: 'support' }, { tenantId: 'startup-a', channelId: 'removed' },
    { tenantId: 'startup-a', departmentId: 'missing' }, { tenantId: 'hidden-parent', channelId: 'wa' }, { tenantId: 'foreign-tenant', channelId: 'wa' }];
  const current = app.auth.validateTenant;
  app.auth.validateTenant = (actor, id) => app.store.tenant(actor, id);
  const expected = [admin, operator].map(({ actor }) => contexts.map(context => app.auth.can(actor, 'inbox.read', context)));
  const assignees = app.auth.assignees(admin.actor, 'startup-a', { channelId: 'wa', departmentId: 'sales' });
  app.auth.validateTenant = current;
  const restore = historyFence(app.store);
  try {
    assert.deepEqual([admin, operator].map(({ actor }) => contexts.map(context => app.auth.can(actor, 'inbox.read', context))), expected);
    assert.deepEqual(app.auth.assignees(admin.actor, 'startup-a', { channelId: 'wa', departmentId: 'sales' }), assignees);
    assert.equal(app.auth.can(operator.actor, 'inbox.read', contexts[1]), true);
    app.store.db.prepare("UPDATE tenants SET data=json_set(data,'$.channels',json('[]')) WHERE id=?").run('startup-a');
    await Promise.resolve();
    assert.equal(app.auth.can(operator.actor, 'inbox.read', contexts[1]), false, 'no retained permission state across await');
  } finally { restore(); }
});

test('real bootstrap keeps full branding, hierarchy visibility and scoped counts; subsequent requests see revocation and writes', async t => {
  const { app, person, request } = await appFixture(t), operator = person('startup.bootstrap', 'operator', { 'startup-a': { channelIds: ['wa'], departmentIds: ['sales'] } });
  const admin = person('startup.bootstrapowner', 'reseller');
  const restore = historyFence(app.store);
  try {
    const unrestricted = await request(admin.cookie); assert.equal(unrestricted.status, 200);
    const ownTenant = unrestricted.data.tenants.find(item => item.id === 'startup-a');
    assert.equal(ownTenant.parentTenantId, 'hidden-parent');
    assert.equal(ownTenant.channels, 2); assert.equal(ownTenant.conversations, 2);
    assert.equal(unrestricted.data.tenants.some(item => item.id === 'foreign-tenant'), false);
    const before = await request(operator.cookie); assert.equal(before.status, 200);
    assert.deepEqual(before.data.tenants, [{ id: 'startup-a', name: source().name, segment: source().segment, parentTenantId: null,
      identityVersion: 7, plan: source().plan, brand: source().brand, demo: false, channels: 1, conversations: 1 }]);
    app.store.db.prepare("UPDATE tenants SET data=json_set(data,'$.name','Fresh name','$.brand.name','Fresh brand') WHERE id=?").run('startup-a');
    app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ 'startup-a': { channelIds: [] } }), operator.id);
    const after = await request(operator.cookie); assert.equal(after.status, 200);
    assert.equal(after.data.tenants[0].name, 'Fresh name'); assert.equal(after.data.tenants[0].brand.name, 'Fresh brand');
    assert.equal(after.data.tenants[0].channels, 0); assert.equal(after.data.tenants[0].conversations, 0);
    app.store.db.prepare('UPDATE auth_users SET disabled_at=1 WHERE id=?').run(operator.id);
    assert.equal((await request(operator.cookie)).status, 401);
  } finally { restore(); }
});
