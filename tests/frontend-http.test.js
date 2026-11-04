import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp, etagMatches } from '../src/server.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const denied = async () => { throw new Error('External transport forbidden in frontend HTTP fixture'); };
const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
const png = Buffer.from(pngData.split(',')[1], 'base64');
const jpegData = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==';
const webpData = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const branding = extra => ({ name: 'Marca sintética', initials: 'MS', accent: '#3157d5', domain: '', ...extra });

async function fixture(t) {
  const key = randomBytes(32);
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: denied,
    gatewayOptions: { authKey: key, socketFactory: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denied },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', cookie = '', body, workspace } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie,
      ...(workspace === undefined ? {} : { 'X-Elozi-Workspace': workspace }) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        try { resolve({ status: response.statusCode, headers: response.headers, bytes,
          data: response.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString()) : null,
          cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Admin frontend QA', username: 'frontend.owner', password: password() } });
  assert.equal(owner.status, 200);
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const created = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Frontend sintético', segment: 'QA' } });
  assert.equal(created.status, 201);
  const tenantId = created.data.id, path = `/api/tenants/${tenantId}`, channelId = 'frontend-wa', hiddenChannelId = 'frontend-hidden-wa';
  const conversationId = 'frontend-conversation', hiddenConversationId = 'frontend-hidden-conversation';
  const contactId = 'frontend-contact', hiddenContactId = 'frontend-hidden-contact';
  app.store.mutate(actor, tenantId, 'Fixture de fotos privadas', tenant => {
    tenant.channels = [{ id: channelId, name: 'WhatsApp sintético', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' },
      { id: hiddenChannelId, name: 'Canal restrito', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }];
    tenant.conversations = [[conversationId, channelId, contactId, '5511900000000'], [hiddenConversationId, hiddenChannelId, hiddenContactId, '5511900000001']].map(([id, channelId, contactId, number]) => ({
      id, channelId, contactId, remoteJid: number + '@s.whatsapp.net', contact: 'Contato sintético', initials: 'CS',
      departmentId: 'unassigned', department: 'Sem departamento', owner: 'queue', status: 'open', version: 1, messages: [], tags: [], updatedAt: new Date().toISOString()
    }));
    tenant.contacts = [[contactId, channelId, '5511900000000'], [hiddenContactId, hiddenChannelId, '5511900000001']].map(([id, channelId, number]) => ({
      id, name: 'Contato sintético', type: 'person', phone: '', email: '', notes: '', tags: [], version: 1,
      identities: [{ channelId, kind: 'person', externalId: number + '@s.whatsapp.net' }]
    }));
  });
  const calls = [];
  let image = { mime: 'image/png', bytes: png };
  app.avatars.conversation = async (user, tenantId, conversationId) => { calls.push({ kind: 'conversation', userId: user.userId, tenantId, id: conversationId }); return image; };
  app.avatars.channel = async (user, tenantId, channelId) => { calls.push({ kind: 'channel', userId: user.userId, tenantId, id: channelId }); return image; };
  let sequence = 0;
  const member = async (extra = {}) => {
    const username = 'frontend.member.' + ++sequence, secret = password();
    const created = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Pessoa sintética', username, password: secret,
      role: 'operator', tenantIds: [tenantId], permissions: ['inbox.read', 'contacts.read'], ...extra } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const logged = await request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
    assert.equal(logged.status, 200); return { ...created.data, cookie: logged.cookie };
  };
  const avatarPath = kind => `${path}/${kind}/${kind === 'conversations' ? conversationId : kind === 'contacts' ? contactId : channelId}/avatar`;
  return { app, request, owner, actor, tenantId, path, channelId, hiddenChannelId, conversationId, hiddenConversationId,
    contactId, hiddenContactId, calls, member, avatarPath, setImage: value => { image = value; } };
}

test('HTTP fotos privadas recusam sessão ausente, empresa e canal fora do escopo antes de consultar o provedor', async t => {
  const c = await fixture(t);
  for (const kind of ['conversations', 'contacts', 'channels']) assert.equal((await c.request(c.avatarPath(kind))).status, 401);
  assert.equal((await c.request(`/api/tenants/unknown/conversations/${c.conversationId}/avatar`, { cookie: c.owner.cookie })).status, 404);
  assert.equal((await c.request(`${c.path}/channels/unknown/avatar`, { cookie: c.owner.cookie })).status, 404);
  const user = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.channelId] } } });
  for (const [kind, id] of [['conversations', c.hiddenConversationId], ['contacts', c.hiddenContactId], ['channels', c.hiddenChannelId]]) {
    const refused = await c.request(`${c.path}/${kind}/${id}/avatar`, { cookie: user.cookie });
    assert.equal(refused.status, 403); assert.equal(refused.headers['content-type'], 'application/json; charset=utf-8');
  }
  const other = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Outra empresa sintética', segment: 'QA' } });
  assert.equal((await c.request(`/api/tenants/${other.data.id}/channels/${c.channelId}/avatar`, { cookie: user.cookie })).status, 403);
  assert.equal((await c.request(c.avatarPath('conversations'), { cookie: user.cookie, workspace: 'unknown-workspace' })).status, 403);
  assert.equal(c.calls.length, 0);
});

test('HTTP conversa, contato e canal retornam os bytes PNG privados sem cache nem URL externa', async t => {
  const c = await fixture(t);
  for (const kind of ['conversations', 'contacts', 'channels']) {
    const response = await c.request(c.avatarPath(kind), { cookie: c.owner.cookie });
    assert.equal(response.status, 200); assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(Number(response.headers['content-length']), png.length); assert.deepEqual(response.bytes, png);
  }
  assert.deepEqual(c.calls.map(call => [call.kind, call.id]), [['conversation', c.conversationId], ['conversation', c.conversationId], ['channel', c.channelId]]);
});

test('HTTP pessoa com contacts.read acessa foto do CRM autorizado sem ganhar acesso à conversa', async t => {
  const c = await fixture(t), user = await c.member({ permissions: ['contacts.read'], scopeRules: { [c.tenantId]: { channelIds: [c.channelId] } } });
  const contact = await c.request(c.avatarPath('contacts'), { cookie: user.cookie });
  assert.equal(contact.status, 200); assert.deepEqual(contact.bytes, png);
  assert.equal((await c.request(c.avatarPath('channels'), { cookie: user.cookie })).status, 200);
  const calls = c.calls.length;
  assert.equal((await c.request(c.avatarPath('conversations'), { cookie: user.cookie })).status, 403);
  assert.equal((await c.request(`${c.path}/contacts/${c.hiddenContactId}/avatar`, { cookie: user.cookie })).status, 403);
  assert.equal(c.calls.length, calls);
});

test('HTTP foto indisponível usa 204 sem cache e contato sem conversa não chama o provedor', async t => {
  const c = await fixture(t); c.setImage(null);
  for (const kind of ['conversations', 'contacts', 'channels']) {
    const response = await c.request(c.avatarPath(kind), { cookie: c.owner.cookie });
    assert.equal(response.status, 204); assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.bytes.length, 0);
  }
  c.app.store.mutate(c.actor, c.tenantId, 'Fixture sem identidade externa', tenant => {
    tenant.contacts.push({ id: 'unlinked', name: 'Contato sem conversa', type: 'person', tags: [], identities: [], version: 1 });
  });
  const calls = c.calls.length;
  assert.equal((await c.request(`${c.path}/contacts/unlinked/avatar`, { cookie: c.owner.cookie })).status, 204);
  assert.equal(c.calls.length, calls);
});

test('HTTP foto revalida sessão revogada depois de aguardar o provedor nas três rotas', async t => {
  const c = await fixture(t);
  for (const kind of ['conversations', 'contacts', 'channels']) {
    const user = await c.member(), entered = deferred(), release = deferred();
    const method = kind === 'channels' ? 'channel' : 'conversation';
    c.app.avatars[method] = async () => { entered.resolve(); await release.promise; return { mime: 'image/png', bytes: png }; };
    const pending = c.request(c.avatarPath(kind), { cookie: user.cookie });
    try { await entered.promise; c.app.auth.logout(user.cookie.slice('mep_session='.length)); } finally { release.resolve(); }
    const response = await pending; assert.equal(response.status, 401); assert.equal(response.data?.error?.length > 0, true);
    assert.notDeepEqual(response.bytes, png);
  }
});

test('HTTP foto revalida escopo atual depois de aguardar o provedor sem depender da invalidação do cookie', async t => {
  const c = await fixture(t);
  for (const kind of ['conversations', 'contacts', 'channels']) {
    const user = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.channelId] } } }), entered = deferred(), release = deferred();
    const method = kind === 'channels' ? 'channel' : 'conversation';
    c.app.avatars[method] = async () => { entered.resolve(); await release.promise; return { mime: 'image/png', bytes: png }; };
    const pending = c.request(c.avatarPath(kind), { cookie: user.cookie });
    try {
      await entered.promise;
      // The fixture changes authoritative access without revoking the cookie, isolating the post-await scope check.
      c.app.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenantId]: { channelIds: [c.hiddenChannelId] } }), user.id);
    } finally { release.resolve(); }
    const response = await pending; assert.equal(response.status, 403); assert.notDeepEqual(response.bytes, png);
  }
});

test('HTTP marca valida PNG, JPEG e WebP e recusa URLs, SVG e conteúdo raster inválido sem substituir o logo', async t => {
  const c = await fixture(t);
  for (const route of [`${c.path}/brand`, '/api/reseller/brand']) {
    for (const logo of [pngData, jpegData, webpData]) {
      const result = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: branding({ logo }) });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal((result.data.brand || result.data.reseller.brand).logo, logo);
    }
    for (const logo of ['https://example.test/photo.png', 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
      'data:image/png;base64,' + Buffer.from('not a PNG').toString('base64'), pngData.replace('image/png', 'image/jpeg'),
      'data:image/png;base64,' + png.subarray(0, png.length - 12).toString('base64')]) {
      const refused = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: branding({ logo }) });
      assert.equal(refused.status, 400);
    }
    const unchanged = route.startsWith('/api/reseller') ? c.app.store.reseller(c.actor).brand : c.app.store.tenant(c.actor, c.tenantId).brand;
    assert.equal(unchanged.logo, webpData);
  }
});

test('HTTP logo omitido preserva, null remove e as marcas ficam isoladas por revenda e empresa', async t => {
  const c = await fixture(t);
  const other = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Segunda empresa sintética', segment: 'QA' } });
  assert.equal(other.status, 201);
  const otherBefore = c.app.store.tenant(c.actor, other.data.id).brand;
  const resellerBefore = c.app.store.reseller(c.actor).brand;
  assert.equal((await c.request(`${c.path}/brand`, { method: 'PATCH', cookie: c.owner.cookie, body: branding({ logo: pngData }) })).status, 200);
  assert.deepEqual(c.app.store.tenant(c.actor, other.data.id).brand, otherBefore);
  assert.deepEqual(c.app.store.reseller(c.actor).brand, resellerBefore);
  const renamed = await c.request(`${c.path}/brand`, { method: 'PATCH', cookie: c.owner.cookie, body: branding({ name: 'Nova marca' }) });
  assert.equal(renamed.status, 200); assert.equal(renamed.data.brand.logo, pngData);
  const reseller = await c.request('/api/reseller/brand', { method: 'PATCH', cookie: c.owner.cookie, body: branding({ logo: jpegData }) });
  assert.equal(reseller.status, 200); assert.equal(reseller.data.reseller.brand.logo, jpegData);
  assert.equal(c.app.store.tenant(c.actor, c.tenantId).brand.logo, pngData);
  assert.deepEqual(c.app.store.tenant(c.actor, other.data.id).brand, otherBefore);
  assert.equal((await c.request('/api/reseller/brand', { method: 'PATCH', cookie: c.owner.cookie, body: branding() })).data.reseller.brand.logo, jpegData);
  const removed = await c.request(`${c.path}/brand`, { method: 'PATCH', cookie: c.owner.cookie, body: branding({ logo: null }) });
  assert.equal(removed.status, 200); assert.equal(removed.data.brand.logo, null);
  assert.equal(c.app.store.reseller(c.actor).brand.logo, jpegData);
  assert.equal((await c.request('/api/reseller/brand', { method: 'PATCH', cookie: c.owner.cookie, body: branding({ logo: null }) })).data.reseller.brand.logo, null);
  const member = await c.member();
  for (const route of [`${c.path}/brand`, '/api/reseller/brand']) assert.equal((await c.request(route, { method: 'PATCH', cookie: member.cookie, body: branding({ logo: pngData }) })).status, 403);
  const foreign = await c.request('/api/auth/register', { method: 'POST', body: { fiscalDocument: syntheticFiscalDocument(), name: 'Revenda independente', email: 'frontend.other@example.test', company: 'Outra revenda', password: password() } });
  assert.equal(foreign.status, 200);
  const foreignActor = c.app.auth.workspaceActor(c.app.auth.authenticate(foreign.cookie.slice('mep_session='.length)));
  const foreignBrand = c.app.store.reseller(foreignActor).brand;
  assert.equal((await c.request(`${c.path}/brand`, { method: 'PATCH', cookie: foreign.cookie, body: branding({ logo: pngData }) })).status, 404);
  assert.equal((await c.request('/api/reseller/brand', { method: 'PATCH', cookie: c.owner.cookie, workspace: foreignActor.resellerId, body: branding({ logo: pngData }) })).status, 403);
  assert.deepEqual(c.app.store.reseller(foreignActor).brand, foreignBrand);
  assert.equal(c.app.store.tenant(c.actor, c.tenantId).brand.logo, null);
});

test('HTTP assets revalidam por ETag (SHA-256 do verify) com no-cache; HTML e API continuam no-store', async t => {
  const c = await fixture(t);
  const sha = file => `"${createHash('sha256').update(readFileSync(new URL('../public/' + file, import.meta.url))).digest('hex')}"`;
  const head = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${c.app.server.address().port}${path}`, { method: 'HEAD', headers }, response => { response.resume(); response.on('end', () => resolve(response)); });
    req.on('error', reject); req.end();
  });
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${c.app.server.address().port}${path}`, { headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  for (const file of ['mark.svg', 'fonts/manrope-latin-wght-normal.woff2', 'widget.js']) {
    const first = await get('/' + file), etag = sha(file);
    assert.equal(first.status, 200, file); assert.equal(first.headers['cache-control'], 'no-cache', file); assert.equal(first.headers.etag, etag, file);
    assert.equal(Number(first.headers['content-length']), first.bytes.length); assert.equal(`"${createHash('sha256').update(first.bytes).digest('hex')}"`, etag);
    for (const header of [etag, 'W/' + etag, `"outro", ${etag}`, '*']) {
      const cached = await get('/' + file, { 'If-None-Match': header });
      assert.equal(cached.status, 304, file + ' ' + header); assert.equal(cached.bytes.length, 0); assert.equal(cached.headers.etag, etag); assert.equal(cached.headers['cache-control'], 'no-cache');
      assert.equal(cached.headers['x-content-type-options'], 'nosniff');
    }
    assert.equal((await get('/' + file, { 'If-None-Match': '"outro"' })).status, 200);
  }
  const widget = await head('/widget.js');
  assert.equal(widget.statusCode, 200); assert.equal(widget.headers.etag, sha('widget.js')); assert.ok(Number(widget.headers['content-length']) > 0); assert.equal(widget.headers['access-control-allow-origin'], '*');
  assert.equal((await head('/widget.js', { 'If-None-Match': sha('widget.js') })).statusCode, 304);
  for (const path of ['/', '/login']) {
    const page = await get(path, { 'If-None-Match': '*' });
    assert.equal(page.status, 200, path); assert.equal(page.headers['cache-control'], 'no-store', path); assert.equal(page.headers.etag, undefined, path);
  }
  const api = await get('/api/health', { 'If-None-Match': '*' });
  assert.equal(api.status, 200); assert.equal(api.headers['cache-control'], 'no-store'); assert.equal(api.headers.etag, undefined);
  assert.equal((await head('/app.js')).statusCode, 404, 'HEAD stays limited to the public widget graph');
  assert.equal((await get('/nao-listado.js')).status, 404);
  assert.equal(etagMatches(undefined, '"a"'), false); assert.equal(etagMatches('"a" , W/"b"', '"b"'), true); assert.equal(etagMatches('x'.repeat(9000), '"a"'), false);
});
