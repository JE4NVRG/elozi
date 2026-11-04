import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/server.js';

async function fixture(t) {
  const key = randomBytes(32), external = [];
  const denyExternal = async () => {
    external.push('attempt');
    throw new Error('O teste de agenda RAM não permite provedores externos.');
  };
  const app = createApp({
    databasePath: ':memory:', publicOrigin: '', allowRegistration: false, serviceKey: key,
    providerCall: denyExternal, mcpFetchImpl: denyExternal,
    googleOptions: { clientId: '', jwks: denyExternal },
    gatewayOptions: { authKey: key, socketFactory: denyExternal, downloadMediaImpl: denyExternal, fetchImpl: denyExternal },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denyExternal },
    metaOptions: { fetchImpl: denyExternal, mediaDownloader: denyExternal },
    emailOptions: { key, apiKey: '', from: '', fetchImpl: denyExternal },
    emailChannelOptions: { fetchImpl: denyExternal },
    mediaOptions: { directory: null, authKey: key }
  });
  t.after(async () => {
    await app.scheduled.waitIdle();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.meta.close(),
      app.webchat.close(), app.emailChannel.close(), app.bridge.close()]);
    app.store.close();
    assert.deepEqual(external, [], 'Nenhuma integração externa deve ser acionada.');
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie = '' } = {}) => {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text(), type = response.headers.get('content-type') || '';
    return { status: response.status, type, text,
      data: type.includes('application/json') ? JSON.parse(text) : undefined,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const ownerPassword = 'Synthetic-owner-' + randomBytes(16).toString('hex');
  const owner = await request('/api/auth/setup', { method: 'POST', body: {
    name: 'Agenda HTTP RAM', username: 'snapshot-owner', password: ownerPassword
  } });
  assert.equal(owner.status, 200); assert.ok(owner.cookie);
  const createTenant = async name => {
    const result = await request('/api/tenants', { method: 'POST', cookie: owner.cookie,
      body: { name, segment: 'Teste sintético da agenda' } });
    assert.equal(result.status, 201); return result.data.id;
  };
  const tenantId = await createTenant('Empresa agenda RAM');
  const operatorPassword = 'Synthetic-operator-' + randomBytes(16).toString('hex');
  const operator = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: {
    username: 'snapshot-operator', password: operatorPassword, name: 'Leitor RAM', role: 'operator',
    tenantIds: [tenantId], permissions: ['contacts.read']
  } });
  assert.equal(operator.status, 201);
  const login = () => request('/api/auth/login', { method: 'POST',
    body: { username: 'snapshot-operator', password: operatorPassword } });
  const loggedIn = await login(); assert.equal(loggedIn.status, 200); assert.ok(loggedIn.cookie);
  const route = `/api/tenants/${tenantId}/contacts`;
  const read = query => request(route + (query ? '?' + query : ''), { cookie: loggedIn.cookie });
  const createContact = async name => {
    const response = await request(route, { method: 'POST', cookie: owner.cookie,
      body: { name, email: 'person@example.test', notes: 'Notas sintéticas', tags: ['RAM'] } });
    assert.equal(response.status, 201); return response.data;
  };
  const contact = await createContact('Pessoa RAM visível');
  return { request, owner, operator, loggedIn, login, tenantId, route, read, createContact, createTenant, contact };
}

function fresh(response) {
  assert.equal(response.status, 200); assert.match(response.data.revision, /^[a-f0-9]{64}$/);
  assert.equal(response.data.unchanged, false); assert.ok(Array.isArray(response.data.contacts));
  assert.deepEqual(Object.keys(response.data).sort(), ['contacts', 'revision', 'unchanged']);
  return response.data;
}

function unchanged(response, revision) {
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { revision, unchanged: true });
  assert.equal(Object.hasOwn(response.data, 'contacts'), false);
}

test('GET legado permanece exatamente {contacts}; snapshot condicional entrega o mesmo DTO autorizado', async t => {
  const f = await fixture(t), legacy = await f.read(''), first = fresh(await f.read('snapshot=true'));
  assert.equal(legacy.status, 200); assert.deepEqual(Object.keys(legacy.data), ['contacts']);
  assert.deepEqual(first.contacts, legacy.data.contacts);
  assert.equal(first.contacts.length, 1); assert.equal(first.contacts[0].id, f.contact.id);
  assert.equal(first.contacts[0].name, 'Pessoa RAM visível');
  unchanged(await f.read('snapshot=true&since=' + first.revision), first.revision);
  const ignoredSince = await f.read('since=not-a-revision');
  assert.equal(ignoredSince.status, 200); assert.deepEqual(ignoredSince.data, legacy.data);
});

test('edição HTTP de contato visível invalida a revisão e a próxima consulta volta a omitir o array', async t => {
  const f = await fixture(t), before = fresh(await f.read('snapshot=true'));
  const edited = await f.request(`${f.route}/${f.contact.id}`, { method: 'PATCH', cookie: f.owner.cookie,
    body: { version: f.contact.version, name: 'Pessoa RAM editada', notes: 'Notas editadas via HTTP' } });
  assert.equal(edited.status, 200);
  const after = fresh(await f.read('snapshot=true&since=' + before.revision));
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.contacts[0].name, 'Pessoa RAM editada');
  assert.equal(after.contacts[0].notes, 'Notas editadas via HTTP');
  assert.equal(after.contacts[0].version, f.contact.version + 1);
  assert.deepEqual(after.contacts, (await f.read('')).data.contacts);
  unchanged(await f.read('snapshot=true&since=' + after.revision), after.revision);
});

test('search e archived mantêm o filtro legado e não reutilizam revisão de outra seleção', async t => {
  const f = await fixture(t), original = fresh(await f.read('snapshot=true&search=vis%C3%ADvel&archived=true'));
  const archived = await f.request(`${f.route}/${f.contact.id}/archive`, { method: 'POST', cookie: f.owner.cookie,
    body: { version: f.contact.version } });
  assert.equal(archived.status, 200);
  const active = fresh(await f.read('snapshot=true&search=vis%C3%ADvel&since=' + original.revision));
  assert.deepEqual(active.contacts, []); assert.notEqual(active.revision, original.revision);
  const inclusive = fresh(await f.read('snapshot=true&search=vis%C3%ADvel&archived=true&since=' + original.revision));
  assert.ok(inclusive.contacts[0].archivedAt); assert.notEqual(inclusive.revision, original.revision);
  assert.deepEqual(inclusive.contacts, (await f.read('search=vis%C3%ADvel&archived=true')).data.contacts);
  unchanged(await f.read('snapshot=true&search=vis%C3%ADvel&archived=true&since=' + inclusive.revision), inclusive.revision);
});

test('revisão inválida recebe 400; nem GET legado nem snapshot são públicos com uma revisão conhecida', async t => {
  const f = await fixture(t), valid = fresh(await f.read('snapshot=true'));
  for (const since of ['invalid', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    const rejected = await f.read('snapshot=true&since=' + since);
    assert.equal(rejected.status, 400); assert.equal(Object.hasOwn(rejected.data, 'contacts'), false);
    assert.equal(Object.hasOwn(rejected.data, 'revision'), false);
  }
  for (const suffix of ['', '?snapshot=true', '?snapshot=true&since=' + valid.revision]) {
    const rejected = await f.request(f.route + suffix);
    assert.equal(rejected.status, 401); assert.equal(Object.hasOwn(rejected.data, 'contacts'), false);
    assert.equal(Object.hasOwn(rejected.data, 'revision'), false);
  }
});

for (const revoke of ['permission', 'disabled']) {
  test(`snapshot revalida sessão após ${revoke}; hash conhecido nunca autoriza leitura`, async t => {
    const f = await fixture(t), before = fresh(await f.read('snapshot=true'));
    const changed = revoke === 'permission'
      ? await f.request('/api/users/' + f.operator.data.id, { method: 'PATCH', cookie: f.owner.cookie,
        body: { permissions: ['inbox.read'] } })
      : await f.request('/api/users/' + f.operator.data.id + '/disable', { method: 'POST', cookie: f.owner.cookie, body: {} });
    assert.equal(changed.status, 200);
    const denied = await f.read('snapshot=true&since=' + before.revision);
    assert.ok([401, 403].includes(denied.status));
    assert.equal(Object.hasOwn(denied.data, 'contacts'), false); assert.equal(Object.hasOwn(denied.data, 'revision'), false);
    if (revoke === 'permission') {
      const relogged = await f.login(); assert.equal(relogged.status, 200);
      const deniedFresh = await f.request(f.route + '?snapshot=true&since=' + before.revision, { cookie: relogged.cookie });
      assert.equal(deniedFresh.status, 403); assert.equal(Object.hasOwn(deniedFresh.data, 'revision'), false);
    }
  });
}

test('revisão de uma empresa não concede acesso a outra empresa nem é compartilhada com outro ator', async t => {
  const f = await fixture(t), before = fresh(await f.read('snapshot=true'));
  const own = fresh(await f.request(f.route + '?snapshot=true&since=' + before.revision, { cookie: f.owner.cookie }));
  assert.notEqual(own.revision, before.revision); assert.deepEqual(own.contacts, before.contacts);
  const otherTenant = await f.createTenant('Outra empresa RAM');
  const rejected = await f.request(`/api/tenants/${otherTenant}/contacts?snapshot=true&since=${before.revision}`, { cookie: f.loggedIn.cookie });
  assert.equal(rejected.status, 403); assert.equal(Object.hasOwn(rejected.data, 'contacts'), false);
  assert.equal(Object.hasOwn(rejected.data, 'revision'), false);
});

test('contact-refresh.js é servido como JavaScript com a fonte pública exata', async t => {
  const f = await fixture(t), response = await f.request('/contact-refresh.js');
  assert.equal(response.status, 200); assert.match(response.type, /^text\/javascript\b/);
  assert.equal(response.text, await readFile(new URL('../public/contact-refresh.js', import.meta.url), 'utf8'));
  assert.equal((await f.request('/src/contacts.js')).status, 404);
});
