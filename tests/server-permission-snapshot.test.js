import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

// Listings (/api/inbox, /api/bootstrap, GET /api/tenants/:id) now authorize with one snapshot per company. The expected
// sets below come from auth.can per conversation, the previous per-item decision, over a fixture with mixed scopes.
const conversation = (id, channelId, extra = {}) => ({ id, channelId, contact: 'Contato ' + id, owner: 'queue', status: 'open', unread: 0, version: 1,
  updatedAt: '2026-10-05T10:00:00Z', messages: [{ kind: 'customer', text: 'Mensagem sintética ' + id }], ...extra });

async function fixture(t) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido na fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const departments = [{ id: 'd-sales', name: 'Vendas' }, { id: 'd-support', name: 'Suporte' }];
  const bulk = Array.from({ length: 40 }, (_, index) => conversation('bulk-' + index, index % 2 ? 'ch-1' : 'ch-2', index % 3 ? { departmentId: index % 2 ? 'd-sales' : 'd-support' } : { department: 'Vendas' }));
  const tenants = {
    'perm-a': { name: 'Permissões A', channels: [{ id: 'ch-1', name: 'WhatsApp A', kind: 'whatsapp_qr' }, { id: 'ch-2', name: 'Telegram A', kind: 'telegram' }], departments,
      conversations: [conversation('c1', 'ch-1', { departmentId: 'd-sales' }), conversation('c2', 'ch-1', { departmentId: 'd-support' }), conversation('c3', 'ch-2', { department: 'Vendas' }),
        conversation('c4', 'ch-2', { status: 'pending' }), conversation('c5', 'ch-1', { department: 'Inexistente', status: 'closed' }), conversation('c6', 'ch-removido', { departmentId: 'd-sales' }), ...bulk] },
    'perm-b': { name: 'Permissões B', channels: [{ id: 'ch-1', name: 'WhatsApp B', kind: 'whatsapp_qr' }], departments: [departments[0]],
      conversations: [conversation('c1', 'ch-1', { departmentId: 'd-sales' }), conversation('c7', 'ch-1'), conversation('c8', 'ch-1', { departmentId: 'd-support' })] },
    'perm-c': { name: 'Permissões C', channels: [{ id: 'ch-1', name: 'WhatsApp C', kind: 'whatsapp_qr' }], departments: [], conversations: [conversation('c9', 'ch-1')] }
  };
  for (const [id, data] of Object.entries(tenants)) app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, 'mep-demo', JSON.stringify(data));
  const person = (username, role, tenantIds, { permissions = null, scopeRules = null } = {}) => {
    const row = app.auth.insertUser({ name: 'Pessoa ' + username, username }, Buffer.alloc(16, 3), Buffer.alloc(64, 4), role, tenantIds);
    app.store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions && JSON.stringify(permissions), scopeRules && JSON.stringify(scopeRules), row.id);
    const { token } = app.auth.session(app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    return { username, cookie: 'mep_session=' + token, actor: app.auth.workspaceActor(app.auth.authenticate(token)) };
  };
  const people = [
    person('owner.snapshot', 'reseller', []),
    person('operator.all', 'operator', ['perm-a', 'perm-b']),
    person('operator.channel', 'operator', ['perm-a', 'perm-b'], { scopeRules: { 'perm-a': { channelIds: ['ch-1'] } } }),
    person('operator.department', 'operator', ['perm-a', 'perm-b'], { scopeRules: { 'perm-a': { departmentIds: ['d-sales', 'unassigned'] }, 'perm-b': { channelIds: [] } } }),
    person('operator.contacts', 'operator', ['perm-a'], { permissions: ['contacts.read'] }),
    person('operator.mixed', 'operator', ['perm-a', 'perm-b'], { permissions: ['inbox.read', 'contacts.read'], scopeRules: { 'perm-a': { channelIds: ['ch-2'], departmentIds: ['d-sales'] }, 'perm-b': { departmentIds: ['unassigned'] } } })
  ];
  const request = (path, cookie) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, headers: { Cookie: cookie } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { const raw = Buffer.concat(chunks).toString(); try { resolve({ status: response.statusCode, data: JSON.parse(raw) }); } catch { reject(Error(`HTTP ${response.statusCode} ${path}: ${raw.slice(0, 200)}`)); } });
    }); req.on('error', reject); req.end();
  });
  return { app, people, request };
}

function legacy(app, actor) {
  const ids = app.store.db.prepare('SELECT id FROM tenants WHERE reseller_id=? ORDER BY id').all(actor.resellerId).map(row => row.id)
    .filter(id => actor.role !== 'operator' || actor.tenantIds.includes(id));
  const result = { conversations: [], open: {}, channels: [], departments: [], tenantChannels: {}, tenantConversations: {}, tenantDepartments: {} };
  for (const tenantId of ids) {
    const tenant = app.store.tenant(actor, tenantId);
    const context = c => ({ tenantId, channelId: c.channelId, departmentId: c.departmentId || (tenant.departments || []).find(d => d.name === c.department)?.id || 'unassigned' });
    const readable = tenant.conversations.filter(c => app.auth.can(actor, 'inbox.read', context(c)));
    const channels = tenant.channels.filter(c => app.auth.can(actor, 'inbox.read', { tenantId, channelId: c.id, aggregate: true }));
    const departments = (tenant.departments || []).filter(d => app.auth.can(actor, 'inbox.read', { tenantId, departmentId: d.id, aggregate: true }));
    result.tenantConversations[tenantId] = readable.map(c => c.id).sort(); result.tenantChannels[tenantId] = channels.map(c => c.id).sort();
    result.tenantDepartments[tenantId] = departments.map(d => d.id).sort();
    result.open[tenantId] = { conversations: readable.filter(c => c.status !== 'closed').length, channels: channels.length };
    if (!app.auth.can(actor, 'inbox.read', { tenantId, aggregate: true })) continue;
    result.conversations.push(...readable.map(c => tenantId + ':' + c.id)); result.channels.push(...channels.map(c => tenantId + ':' + c.id));
    result.departments.push(...departments.map(d => tenantId + ':' + d.id));
  }
  for (const list of [result.conversations, result.channels, result.departments]) list.sort();
  return result;
}

test('caixa única, bootstrap e empresa decidem igual ao auth.can por conversa em escopos mistos', async t => {
  const { app, people, request } = await fixture(t);
  let checked = 0;
  for (const { username, cookie, actor } of people) {
    const expected = legacy(app, actor);
    const inbox = await request('/api/inbox?status=all&limit=200', cookie);
    assert.equal(inbox.status, 200, username);
    assert.deepEqual(inbox.data.items.map(item => item.tenantId + ':' + item.id).sort(), expected.conversations, username + ' conversas');
    assert.deepEqual(inbox.data.channels.map(item => item.tenantId + ':' + item.id).sort(), expected.channels, username + ' canais');
    assert.deepEqual(inbox.data.departments.map(item => item.tenantId + ':' + item.id).sort(), expected.departments, username + ' departamentos');
    const boot = await request('/api/bootstrap', cookie);
    assert.equal(boot.status, 200, username);
    for (const tenant of boot.data.tenants) assert.deepEqual({ conversations: tenant.conversations, channels: tenant.channels }, expected.open[tenant.id], username + ' bootstrap ' + tenant.id);
    for (const tenantId of Object.keys(expected.tenantConversations)) {
      const detail = await request('/api/tenants/' + tenantId, cookie);
      assert.equal(detail.status, 200, username + ' ' + tenantId);
      assert.deepEqual(detail.data.conversations.map(c => c.id).sort(), expected.tenantConversations[tenantId], username + ' empresa ' + tenantId);
      assert.deepEqual(detail.data.channels.map(c => c.id).sort(), expected.tenantChannels[tenantId], username + ' canais ' + tenantId);
      if (actor.role !== 'reseller') assert.deepEqual(detail.data.departments.map(d => d.id).sort(), expected.tenantDepartments[tenantId], username + ' departamentos ' + tenantId);
      checked++;
    }
  }
  assert.ok(checked >= 10);
  // The fixture really mixes outcomes: scoped people see a strict, non-empty subset; the contacts-only person sees nothing.
  const owner = legacy(app, people[0].actor), channel = legacy(app, people[2].actor), mixed = legacy(app, people[5].actor), contactsOnly = legacy(app, people[4].actor);
  assert.ok(channel.tenantConversations['perm-a'].length > 0 && channel.tenantConversations['perm-a'].length < owner.tenantConversations['perm-a'].length);
  assert.ok(mixed.tenantConversations['perm-a'].length > 0 && mixed.tenantConversations['perm-a'].length < channel.tenantConversations['perm-a'].length);
  assert.deepEqual(contactsOnly.conversations, []); assert.equal(owner.tenantConversations['perm-a'].includes('c6'), false, 'canal removido continua negado');
  assert.equal((await request('/api/tenants/perm-c', people[1].cookie)).status, 403);
});

test('a listagem lê pessoa e empresa uma vez por empresa, não uma vez por conversa', async t => {
  const { app, people, request } = await fixture(t), tenantState = app.auth.tenantState.bind(app.auth);
  let reads = 0;
  app.auth.tenantState = (...args) => { reads++; return tenantState(...args); };
  const operator = people[3];
  const conversations = app.store.tenant(operator.actor, 'perm-a').conversations.length;
  assert.ok(conversations > 40);
  reads = 0; assert.equal((await request('/api/tenants/perm-a', operator.cookie)).status, 200);
  assert.ok(reads <= 4, `GET da empresa leu a empresa ${reads} vezes`);
  reads = 0; assert.equal((await request('/api/inbox?status=all&limit=200', operator.cookie)).status, 200);
  assert.ok(reads <= 4, `caixa única leu as empresas ${reads} vezes`);
  reads = 0; assert.equal((await request('/api/inbox?status=all&limit=200&q=' + encodeURIComponent('sintética'), operator.cookie)).status, 200);
  assert.ok(reads <= 6, `busca na caixa única leu as empresas ${reads} vezes`);
  reads = 0; assert.equal((await request('/api/bootstrap', operator.cookie)).status, 200);
  assert.ok(reads <= 6, `bootstrap leu as empresas ${reads} vezes`);
  // The previous per-conversation path is the reference cost: one read per conversation.
  reads = 0; const tenant = app.store.tenant(operator.actor, 'perm-a');
  for (const c of tenant.conversations) app.auth.can(operator.actor, 'inbox.read', { tenantId: 'perm-a', channelId: c.channelId, departmentId: c.departmentId || 'unassigned' });
  assert.equal(reads, conversations);
});

test('bootstrap preserva metadata e counts sem snapshots completos nem cache de autoridade entre chamadas', async t => {
  const { app, people, request } = await fixture(t), db = app.store.db;
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('workspace-foreign', JSON.stringify({ name: 'Conta sintética externa' }));
  db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-foreign', 'workspace-foreign', JSON.stringify({ name: 'Empresa externa', channels: [], conversations: [] }));
  app.store.mutate(people[0].actor, 'perm-a', 'Metadata sintética de matriz', tenant => {
    tenant.parentTenantId = 'perm-c'; tenant.identityVersion = 7; tenant.plan = 'Synthetic';
    tenant.brand = { name: 'Marca sintética', accent: '#3157d5' };
  });
  const prepare = db.prepare.bind(db), snapshots = [];
  db.prepare = sql => {
    const statement = prepare(sql);
    if (/\bFROM\s+tenants\b/i.test(sql)) for (const method of ['get', 'all']) {
      const execute = statement[method].bind(statement);
      statement[method] = (...args) => {
        const result = execute(...args);
        for (const row of Array.isArray(result) ? result : result ? [result] : []) if (typeof row.data === 'string') snapshots.push({ id: row.id, bytes: Buffer.byteLength(row.data) });
        return result;
      };
    }
    return statement;
  };
  t.after(() => { db.prepare = prepare; });
  const read = async person => {
    const metadata = app.store.list(person.actor), expected = legacy(app, person.actor);
    snapshots.length = 0;
    const boot = await request('/api/bootstrap', person.cookie);
    assert.equal(boot.status, 200, person.username);
    assert.deepEqual(snapshots, [], 'bootstrap must not select any full tenant document or foreign payload');
    assert.equal(snapshots.reduce((sum, row) => sum + row.bytes, 0), 0, 'zero full-history snapshot bytes');
    assert.deepEqual(boot.data.tenants, JSON.parse(JSON.stringify(metadata.map(({ channels, conversations, ...item }) => ({ ...item, ...expected.open[item.id] })))), 'public metadata and scoped counts remain identical');
    return boot.data;
  };
  for (const person of [people[0], people[3], people[4], people[5]]) await read(person);
  const owner = people[0], before = await read(owner);
  app.store.mutate(owner.actor, 'perm-a', 'Alteração sintética entre bootstraps', tenant => {
    tenant.name = 'Nome atualizado'; tenant.channels.push({ id: 'ch-3', name: 'Novo canal sintético', kind: 'webchat' });
    tenant.conversations.push(conversation('fresh', 'ch-3'));
  });
  const after = await read(owner);
  assert.equal(after.tenants.find(item => item.id === 'perm-a').name, 'Nome atualizado');
  assert.equal(after.tenants.find(item => item.id === 'perm-a').channels, before.tenants.find(item => item.id === 'perm-a').channels + 1);
  assert.equal(after.tenants.find(item => item.id === 'perm-a').conversations, before.tenants.find(item => item.id === 'perm-a').conversations + 1);
});

test('acesso revogado entre requisições é aplicado na listagem seguinte', async t => {
  const { app, people, request } = await fixture(t), operator = people[1];
  assert.ok((await request('/api/inbox?status=all&limit=200', operator.cookie)).data.items.some(item => item.tenantId === 'perm-a'));
  app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE username=?').run(JSON.stringify({ 'perm-a': { channelIds: ['ch-2'] } }), operator.username);
  const after = await request('/api/inbox?status=all&limit=200&tenantId=perm-a', operator.cookie);
  assert.ok(after.data.items.length > 0 && after.data.items.every(item => item.channelId === 'ch-2'));
  const detail = await request('/api/tenants/perm-a', operator.cookie);
  assert.ok(detail.data.conversations.every(c => c.channelId === 'ch-2')); assert.deepEqual(detail.data.channels.map(c => c.id), ['ch-2']);
  const boot = await request('/api/bootstrap', operator.cookie), expected = legacy(app, operator.actor);
  assert.equal(boot.status, 200);
  assert.deepEqual({ channels: boot.data.tenants.find(item => item.id === 'perm-a').channels, conversations: boot.data.tenants.find(item => item.id === 'perm-a').conversations }, expected.open['perm-a']);
});
