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
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    if (app.server.listening) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
    app.store.close();
  });
  app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('foreign-reseller', JSON.stringify({ name: 'Revenda Órbita', internalSecret: 'SECRET-RESELLER' }));
  const foreignIds = [];
  for (let index = 0; index < 7; index++) {
    const id = 'foreign-company-' + index; foreignIds.push(id);
    app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, 'foreign-reseller', JSON.stringify({ name: 'Filial sintética ' + index, channels: [], conversations: [], hiddenContent: 'SECRET-TENANT' }));
  }
  let sequence = 0;
  const user = (name, role, resellerId, tenantIds, platformAdmin = false) => {
    const row = app.auth.insertUser({ name, username: 'platform.synthetic.' + ++sequence, email: 'person' + sequence + '@example.invalid' },
      Buffer.from('SECRET-SALT-00000'), Buffer.from('SECRET-PASSWORD-HASH'.padEnd(64, 'X')), role, tenantIds, resellerId, { platformAdmin });
    app.store.db.prepare('UPDATE auth_users SET created_at=?,scope_rules=?,permissions=?,phone=?,bio=? WHERE id=?').run(
      Date.parse('2026-10-02T10:00:00Z') + sequence * 1000, null, JSON.stringify(['inbox.read']), '11900001234', 'SECRET-BIO', row.id);
    const current = app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id);
    const session = app.auth.session(current);
    return { id: row.id, actor: session.actor, cookie: 'mep_session=' + session.token };
  };
  const owner = user('Plataforma sintética', 'reseller', 'mep-demo', [], true);
  const operator = user('Atendente da plataforma', 'operator', 'mep-demo', ['playtech-demo']);
  const foreignManager = user('Gestora externa', 'reseller', 'foreign-reseller', []);
  const foreignOperator = user('Atendente externa', 'operator', 'foreign-reseller', foreignIds.slice(0, 6));
  app.store.db.prepare('UPDATE auth_users SET disabled_at=?,presence=? WHERE id=?').run(Date.parse('2026-10-02T11:00:00Z'), 'busy', foreignOperator.id);
  const query = (actor, options) => app.auth.listPlatformUsers(actor, options);
  const request = async (path, { cookie = owner.cookie, method = 'GET' } = {}) => {
    if (!app.server.listening) await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${app.server.address().port}` + path, { method, headers: { Cookie: cookie } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
      }); req.on('error', reject); req.end();
    });
  };
  return { app, owner, operator, foreignManager, foreignOperator, foreignIds, query, request };
}

test('diretório global lista duas revendas, procura metadados e limita nomes de empresas', async t => {
  const c = await fixture(t), result = c.query(c.owner.actor);
  assert.equal(result.total, 4); assert.equal(result.limit, 50); assert.equal(result.hasMore, false);
  const foreign = result.users.find(user => user.id === c.foreignOperator.id);
  assert.deepEqual(foreign.reseller, { id: 'foreign-reseller', name: 'Revenda Órbita' });
  assert.deepEqual(foreign.tenantIds, c.foreignIds.slice(0, 6)); assert.equal(foreign.tenantCount, 6); assert.equal(foreign.tenants.length, 5);
  assert.equal(foreign.disabled, true); assert.equal(foreign.disabledAt, '2026-10-02T11:00:00.000Z'); assert.equal(foreign.presence, 'busy');
  assert.equal(result.users.find(user => user.id === c.foreignManager.id).tenantCount, 7);
  assert.equal(c.query(c.owner.actor, { q: 'orbita' }).total, 2);
  assert.equal(c.query(c.owner.actor, { q: 'Filial sintética 5' }).total, 2, 'Busca inclui empresa além dos primeiros cinco nomes exibidos');
  assert.equal(c.query(c.owner.actor, { q: 'person4@example.invalid' }).total, 1);
  assert.equal(c.query(c.owner.actor, { state: 'active' }).total, 3); assert.equal(c.query(c.owner.actor, { state: 'disabled' }).total, 1);
  assert.equal(c.query(c.owner.actor, { role: 'operator' }).total, 2);
  const first = c.query(c.owner.actor, { limit: 1 }), second = c.query(c.owner.actor, { limit: 1, offset: 1 });
  assert.equal(first.total, 4); assert.equal(first.hasMore, true); assert.notEqual(first.users[0].id, second.users[0].id);
  assert.equal(c.query(c.owner.actor, { offset: 99 }).users.length, 0);
});

test('diretório seleciona somente DTO permitido e não concede acesso a conversas estrangeiras', async t => {
  const c = await fixture(t), result = c.query(c.owner.actor), serialized = JSON.stringify(result);
  assert.deepEqual(Object.keys(result.users[0]).sort(), ['id', 'name', 'username', 'email', 'role', 'createdAt', 'disabledAt', 'disabled', 'presence', 'platformAdmin', 'reseller', 'tenantIds', 'tenants', 'tenantCount', 'avatar'].sort());
  for (const hidden of ['password', 'salt', 'token', 'scopeRules', 'scope_rules', 'permissions', 'SECRET-', 'bio', 'phone', 'platform_admin', 'tenant_ids']) assert.equal(serialized.includes(hidden), false, hidden);
  assert.throws(() => c.app.store.tenant(c.owner.actor, c.foreignIds[0]), error => error.status === 404);
  assert.equal(c.app.auth.can(c.owner.actor, 'inbox.read', { tenantId: c.foreignIds[0], aggregate: true }), false);
  assert.equal((await c.request('/api/platform/users?state=disabled&limit=1')).data.users[0].id, c.foreignOperator.id);
  assert.equal((await c.request('/api/platform/users', { method: 'POST' })).status, 404);
});

test('diretório mostra foto raster salva somente na página autorizada e rejeita valores legados externos', async t => {
  const c = await fixture(t), photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
  c.app.auth.updateProfile(c.foreignManager.actor, { avatar: photo });
  c.app.store.db.prepare('UPDATE auth_users SET avatar=? WHERE id=?').run('https://untrusted.invalid/photo.png', c.foreignOperator.id);
  const result = c.query(c.owner.actor);
  assert.equal(result.users.find(user => user.id === c.foreignManager.id).avatar, photo);
  assert.equal(result.users.find(user => user.id === c.foreignOperator.id).avatar, null);
  assert.equal(result.users.find(user => user.id === c.operator.id).avatar, null);
  const reads = [], prepare = c.app.store.db.prepare.bind(c.app.store.db);
  t.mock.method(c.app.store.db, 'prepare', sql => {
    const statement = prepare(sql);
    return sql === 'SELECT avatar FROM auth_users WHERE id=?' ? { get(id) { reads.push(id); return statement.get(id); } } : statement;
  });
  const page = c.query(c.owner.actor, { limit: 1, offset: 1 });
  assert.deepEqual(reads, page.users.map(user => user.id), 'somente as fotos desta página são lidas');
  assert.equal(page.users[0].id, c.foreignManager.id); assert.equal(page.users[0].avatar, photo);
  const response = await c.request('/api/platform/users?limit=1&offset=1');
  assert.equal(response.status, 200); assert.equal(response.data.users[0].avatar, photo);
  assert.throws(() => c.query(c.operator.actor), error => error.status === 403);
  assert.equal(c.app.store.db.prepare('SELECT avatar FROM auth_users WHERE id=?').get(c.foreignOperator.id).avatar, 'https://untrusted.invalid/photo.png', 'leitura não modifica perfil legado');
});

test('flag protegida atual é exigida antes de buscar, contar ou validar filtros', async t => {
  const c = await fixture(t);
  for (const actor of [c.operator.actor, c.foreignManager.actor, { ...c.foreignManager.actor, platformAdmin: true }]) {
    assert.throws(() => c.query(actor, { q: 'orbita', limit: 999 }), error => error.status === 403);
  }
  assert.equal((await c.request('/api/platform/users?q=orbita&limit=999', { cookie: c.operator.cookie })).status, 403);
  assert.equal((await c.request('/api/platform/users', { cookie: c.foreignManager.cookie })).status, 403);
  c.app.store.db.prepare('UPDATE auth_users SET platform_admin=0 WHERE id=?').run(c.owner.id);
  assert.throws(() => c.query({ ...c.owner.actor, platformAdmin: true }), error => error.status === 403);
  assert.equal((await c.request('/api/platform/users')).status, 403);
  c.app.store.db.prepare('UPDATE auth_users SET platform_admin=1,disabled_at=? WHERE id=?').run(Date.now(), c.owner.id);
  assert.throws(() => c.query(c.owner.actor), error => error.status === 403);
  assert.equal((await c.request('/api/platform/users')).status, 401);
});

test('página e filtros inválidos são recusados para administrador autorizado', async t => {
  const c = await fixture(t);
  for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 100001 }, { offset: 1.2 }, { q: 'x'.repeat(201) }, { state: 'hidden' }, { role: 'admin' }, { grants: true }]) assert.throws(() => c.query(c.owner.actor, options), error => error.status === 400);
  for (const query of ['limit=101', 'offset=-1', 'offset=1.2', 'state=hidden']) assert.equal((await c.request('/api/platform/users?' + query)).status, 400);
  assert.equal((await c.request('/api/platform/users', { cookie: '' })).status, 401);
});
