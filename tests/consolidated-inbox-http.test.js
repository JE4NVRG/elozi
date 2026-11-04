import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

async function fixture(t) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido na fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const conversation = (id, channelId = 'shared-channel', departmentId = 'support') => ({ id, channelId, departmentId, contact: 'Contato sintético', owner: 'queue',
    status: 'open', unread: 1, version: 1, updatedAt: '2026-10-02T10:00:00Z', messages: [{ kind: 'customer', text: 'Pública sintética' }, { kind: 'internal', text: 'Nota privada' }] });
  for (const id of ['inbox-a', 'inbox-b']) app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, 'mep-demo', JSON.stringify({ name: id,
    channels: [{ id: 'shared-channel', name: id + ' número', kind: 'whatsapp_qr', transport: 'baileys', expectedNumber: '5511000000000' }, { id: 'blocked-channel', name: 'Restrito', kind: 'telegram' }],
    departments: [{ id: 'support', name: 'Suporte' }, { id: 'private', name: 'Departamento privado' }],
    conversations: [conversation('shared-conversation'), conversation('blocked-channel-conversation', 'blocked-channel'), conversation('blocked-department-conversation', 'shared-channel', 'private')] }));
  app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('foreign-workspace', JSON.stringify({ name: 'Workspace estrangeiro' }));
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('foreign-tenant', 'foreign-workspace', JSON.stringify({ name: 'Empresa estrangeira', channels: [], conversations: [] }));
  const row = app.auth.insertUser({ name: 'Pessoa sintética', username: 'inbox.synthetic' }, Buffer.alloc(16, 7), Buffer.alloc(64, 8), 'operator', ['inbox-a', 'inbox-b']);
  const rules = { 'inbox-a': { channelIds: ['shared-channel'], departmentIds: ['support'] }, 'inbox-b': { channelIds: ['shared-channel'], departmentIds: ['support'] } };
  app.store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(JSON.stringify(['inbox.read']), JSON.stringify(rules), row.id);
  const session = app.auth.session(app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  app.gateway.entries.set('shared-channel', { tenantId: 'inbox-a', state: 'connected' });
  const base = `http://127.0.0.1:${app.server.address().port}`, cookie = 'mep_session=' + session.token;
  const request = (path, { authenticated = true, workspace, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: authenticated ? cookie : '', ...(workspace ? { 'X-Elozi-Workspace': workspace } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, request, row, rules, session };
}

test('HTTP caixa única autentica, filtra ambas as dimensões e preserva origem com IDs iguais', async t => {
  const c = await fixture(t);
  assert.equal((await c.request('/api/inbox', { authenticated: false })).status, 401);
  assert.equal((await c.request('/api/inbox', { workspace: 'foreign-workspace' })).status, 403);
  assert.equal((await c.request('/api/inbox?tenantId=foreign-tenant')).status, 403);
  const response = await c.request('/api/inbox?limit=1'); assert.equal(response.status, 200);
  assert.equal(response.data.total, 2); assert.equal(response.data.hasMore, true);
  assert.deepEqual(response.data.countTabs, { all: 2, mine: 0, queue: 2, agent: 0 });
  assert.equal(response.data.items[0].channelState, 'connected');
  const second = await c.request('/api/inbox?offset=1&limit=1');
  assert.equal(second.data.items[0].tenantId, 'inbox-b'); assert.equal(second.data.items[0].id, response.data.items[0].id);
  assert.equal(second.data.items[0].channelState, 'disconnected');
  const filtered = await c.request('/api/inbox?tenantId=inbox-b&channelId=shared-channel');
  assert.equal(filtered.data.total, 1); assert.equal(filtered.data.items[0].tenantId, 'inbox-b');
  const serialized = JSON.stringify(response.data);
  for (const hidden of ['blocked-channel', 'private', 'expectedNumber', 'messages', 'Nota privada', 'foreign-tenant']) assert.equal(serialized.includes(hidden), false, hidden);
  assert.equal((await c.request('/api/inbox?q=Nota+privada')).data.total, 0);
  assert.equal((await c.request('/api/inbox?limit=201')).status, 400);
});

test('HTTP consulta revalida associação, escopo e permissão atuais entre requisições', async t => {
  const c = await fixture(t);
  assert.equal((await c.request('/api/inbox')).data.total, 2);
  c.app.store.db.prepare('UPDATE auth_users SET tenant_ids=? WHERE id=?').run(JSON.stringify(['inbox-a']), c.row.id);
  c.app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ 'inbox-a': c.rules['inbox-a'] }), c.row.id);
  assert.equal((await c.request('/api/inbox')).data.total, 1);
  assert.equal((await c.request('/api/inbox?tenantId=inbox-b')).status, 403);
  c.app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ 'inbox-a': { channelIds: [], departmentIds: ['support'] } }), c.row.id);
  const revokedScope = await c.request('/api/inbox?q=Pública'); assert.equal(revokedScope.data.total, 0);
  assert.deepEqual(revokedScope.data.channels, []); assert.deepEqual(revokedScope.data.tenants, []);
  c.app.store.db.prepare('UPDATE auth_users SET scope_rules=NULL,permissions=? WHERE id=?').run(JSON.stringify(['contacts.read']), c.row.id);
  assert.equal((await c.request('/api/inbox')).data.total, 0);
  c.app.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), c.row.id);
  assert.equal((await c.request('/api/inbox')).status, 401);
});

test('HTTP importação exige escopo do canal, suporta prévia limitada e aplica uma vez sem mensagens/outbox', async t => {
  const c = await fixture(t), path = '/api/tenants/inbox-a/contacts/import';
  const content = JSON.stringify(Array.from({ length: 130 }, (_, index) => ({ name: 'Contato sintético ' + index, phone: String(5511982000000 + index), notes: 'n'.repeat(300) })));
  assert.ok(Buffer.byteLength(JSON.stringify({ channelId: 'shared-channel', format: 'json', content })) > 32768);
  const input = { channelId: 'shared-channel', format: 'json', content };
  assert.equal((await c.request(path + '/preview', { method: 'POST', body: input, authenticated: false })).status, 401);
  assert.equal((await c.request(path + '/preview', { method: 'POST', body: input })).status, 403);
  c.app.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read', 'contacts.read', 'contacts.write']), c.row.id);
  assert.equal((await c.request(path + '/preview', { method: 'POST', body: input })).status, 403, 'Escopo restrito a departamento não autoriza contatos sem conversa');
  const channelScope = { 'inbox-a': { channelIds: ['shared-channel'] }, 'inbox-b': { channelIds: ['shared-channel'] } };
  c.app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify(channelScope), c.row.id);
  assert.equal((await c.request(path + '/preview', { method: 'POST', body: { ...input, channelId: 'blocked-channel' } })).status, 403, 'Canal fora do escopo não revela seu tipo');
  c.app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ ...channelScope, 'inbox-a': { channelIds: ['blocked-channel'] } }), c.row.id);
  assert.equal((await c.request(path + '/preview', { method: 'POST', body: input })).status, 403, 'Outro canal do tenant não autoriza o canal escolhido');
  c.app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify(channelScope), c.row.id);
  const before = c.app.store.tenant(c.session.actor, 'inbox-a'), beforeConversations = JSON.stringify(before.conversations);
  const preview = await c.request(path + '/preview', { method: 'POST', body: input }); assert.equal(preview.status, 200);
  assert.equal(preview.data.counts.total, 130); assert.equal(preview.data.counts.valid, 130);
  assert.equal(preview.data.rows.length, 100); assert.equal(preview.data.truncated, true);
  assert.equal((c.app.store.tenant(c.session.actor, 'inbox-a').contacts || []).length, 0);
  const confirmation = { previewId: preview.data.previewId, hash: preview.data.hash, version: preview.data.version };
  assert.equal((await c.request('/api/tenants/inbox-b/contacts/import/apply', { method: 'POST', body: confirmation })).status, 409);
  assert.equal((await c.request(path + '/apply', { method: 'POST', body: { ...confirmation, hash: '0'.repeat(64) } })).status, 409);
  const applied = await c.request(path + '/apply', { method: 'POST', body: confirmation }); assert.equal(applied.status, 200);
  assert.equal(applied.data.imported, 130); assert.equal(applied.data.replayed, false);
  const after = c.app.store.tenant(c.session.actor, 'inbox-a'); assert.equal(after.contacts.length, 130);
  assert.equal(after.contacts.every(contact => contact.identities.length === 1 && contact.identities[0].channelId === 'shared-channel'), true);
  assert.equal(JSON.stringify(after.conversations), beforeConversations);
  assert.equal(c.app.store.db.prepare('SELECT COUNT(*) AS count FROM outbound_commands').get().count, 0);
  const replay = await c.request(path + '/apply', { method: 'POST', body: confirmation }); assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true); assert.deepEqual(replay.data.contactIds, applied.data.contactIds);
  assert.equal(c.app.store.tenant(c.session.actor, 'inbox-a').contacts.length, 130);
  c.app.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read', 'contacts.read']), c.row.id);
  assert.equal((await c.request(path + '/apply', { method: 'POST', body: confirmation })).status, 403, 'Replay também revalida autoridade atual');
});
