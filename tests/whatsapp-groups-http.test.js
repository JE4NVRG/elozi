import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const origin = 'https://whatsapp-groups-fixture.example.test';
const groupA = '120000000001@g.us', groupB = '120000000002@g.us';
const providerGroups = { [groupA]: { id: groupA, subject: 'Grupo sintético A' }, [groupB]: { id: groupB, subject: 'Grupo sintético B', announce: true } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waiting = (gate, pending) => Promise.race([gate.entered.promise, pending.then(result => assert.fail(`A consulta terminou antes do await esperado: HTTP ${result.status} ${result.data.error || ''}`))]);

async function fixture(t) {
  const key = randomBytes(32), calls = { external: 0, groups: 0 }, gates = [];
  const deny = async () => { calls.external++; throw Error('Provedor externo proibido no teste em RAM.'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: origin, allowRegistration: false, serviceKey: key,
    providerCall: deny, mcpFetchImpl: deny, googleOptions: { clientId: '' },
    gatewayOptions: { authKey: key, socketFactory: deny, downloadMediaImpl: deny, fetchImpl: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny }, metaOptions: { fetchImpl: deny, mediaDownloader: deny },
    mediaOptions: { directory: null, authKey: key }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    await app.scheduled.waitIdle(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.bridge.close()]);
    app.store.close(); assert.equal(calls.external, 0);
  });
  let sequence = 0;
  const member = (role, tenantIds = []) => {
    const row = app.auth.insertUser({ username: 'whatsapp.groups.http.' + ++sequence, name: 'Pessoa sintética ' + sequence }, randomBytes(16), randomBytes(64), role, tenantIds, 'mep-demo');
    const session = app.auth.session(row); return { id: row.id, actor: session.actor, cookie: 'mep_session=' + session.token };
  };
  const admin = member('reseller'), secondAdmin = member('reseller');
  const tenant = app.store.createTenant(admin.actor, { name: 'WhatsApp grupos RAM', segment: 'QA' });
  const otherTenant = app.store.createTenant(admin.actor, { name: 'Outra empresa RAM', segment: 'QA' });
  const operator = member('operator', [tenant.id]), channelId = 'wa-groups-http';
  app.store.mutate(admin.actor, tenant.id, 'Fixture: canal QR conectado', state => {
    state.channels = [{ id: channelId, kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', name: 'QR sintético', expectedNumber: '5511999990000', allowedGroups: [groupA], groupNames: { [groupA]: 'Nome anterior A' } }];
    state.conversations = [];
  });
  const entry = { tenantId: tenant.id, channelId, expectedNumber: '5511999990000', actor: app.gateway.actor('mep-demo'), generation: 1,
    state: 'connected', matched: true, groupCache: new Map(), socket: { end() {}, groupFetchAllParticipating: async () => { calls.groups++; return providerGroups; } } };
  app.gateway.entries.set(channelId, entry);
  const base = `http://127.0.0.1:${app.server.address().port}`, path = `/api/tenants/${tenant.id}/channels/${channelId}/groups`;
  const request = (options = {}, url = path) => {
    const { method = 'GET', cookie = admin.cookie, body } = options;
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + url, { method, headers: { Host: new URL(origin).hostname, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...(bytes ? { 'Content-Length': bytes.length } : {}) } }, response => {
        const chunks = []; response.on('error', reject); response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
      });
      req.setTimeout(3000, () => req.destroy(Error('A consulta em RAM não terminou.'))); req.on('error', reject); req.end(bytes);
    });
  };
  const choose = (groupIds, version = 0, options = {}) => request({ method: 'POST', body: { version, groupIds }, ...options });
  const channel = () => app.store.tenant(admin.actor, tenant.id).channels.find(item => item.id === channelId);
  const auditCount = () => app.store.db.prepare("SELECT count(*) AS n FROM audit WHERE tenant_id=? AND action='WhatsApp: grupos de atendimento atualizados'").get(tenant.id).n;
  const snapshot = () => ({ channel: JSON.stringify(channel()), audit: auditCount(), messages: app.store.tenant(admin.actor, tenant.id).conversations.reduce((n, c) => n + c.messages.length, 0), outbox: app.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n });
  const hold = () => {
    const gate = { entered: deferred(), release: deferred() }; gates.push(gate);
    entry.socket.groupFetchAllParticipating = async () => { calls.groups++; gate.entered.resolve(); await gate.release.promise; return providerGroups; };
    return gate;
  };
  return { app, calls, admin, secondAdmin, operator, tenant, otherTenant, channelId, entry, path, request, choose, channel, auditCount, snapshot, hold };
}

test('HTTP grupos WhatsApp fornece escopo/versão, mantém legado v0 e salva com CAS sem mensagens/envios', async t => {
  const f = await fixture(t), read = await f.request();
  assert.equal(read.status, 200); assert.equal(read.data.tenantId, f.tenant.id); assert.equal(read.data.channelId, f.channelId); assert.equal(read.data.version, 0);
  assert.deepEqual(read.data.groups, [{ id: groupA, name: 'Grupo sintético A', selected: true, announcement: false }, { id: groupB, name: 'Grupo sintético B', selected: false, announcement: true }]);
  const accepted = await f.choose([groupB, groupB]);
  assert.equal(accepted.status, 200, accepted.data.error); assert.deepEqual(accepted.data, { tenantId: f.tenant.id, channelId: f.channelId, version: 1, enabledGroups: 1 });
  assert.deepEqual(f.channel().allowedGroups, [groupB]); assert.equal(f.channel().whatsappGroupsVersion, 1); assert.equal(f.auditCount(), 1);
  assert.equal((await f.choose([groupA], 0)).status, 409); assert.deepEqual(f.channel().allowedGroups, [groupB]); assert.equal(f.auditCount(), 1);
  assert.equal((await f.request()).data.version, 1); assert.equal(f.snapshot().messages, 0); assert.equal(f.snapshot().outbox, 0);
});

for (const method of ['GET', 'POST']) {
  test(`HTTP ${method} grupos WhatsApp revalida sessão após consulta suspensa e não expõe/grava após revogação`, async t => {
    const f = await fixture(t), before = f.snapshot(), gate = f.hold();
    const pending = method === 'GET' ? f.request() : f.choose([groupB]);
    await waiting(gate, pending); f.app.auth.revokeUserSessions(f.admin.id); gate.release.resolve();
    const denied = await pending;
    assert.equal(denied.status, 401); assert.equal(denied.data.groups, undefined); assert.equal(denied.data.version, undefined);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.entry.groupCache.size, 0);
  });
  test(`HTTP ${method} grupos WhatsApp revalida papel persistido após consulta suspensa`, async t => {
    const f = await fixture(t), before = f.snapshot(), gate = f.hold();
    const pending = method === 'GET' ? f.request() : f.choose([groupB]);
    await waiting(gate, pending); f.app.store.db.prepare('UPDATE auth_users SET role=? WHERE id=?').run('operator', f.admin.id); gate.release.resolve();
    const denied = await pending;
    assert.equal(denied.status, 403); assert.equal(denied.data.groups, undefined); assert.deepEqual(f.snapshot(), before); assert.equal(f.entry.groupCache.size, 0);
  });
}

test('HTTP grupos WhatsApp permite atualização legítima do nome durante await sem inventar identidade nova', async t => {
  const f = await fixture(t), gate = f.hold(), pending = f.choose([groupB]);
  await waiting(gate, pending); f.app.store.db.prepare('UPDATE auth_users SET name=? WHERE id=?').run('Administrador renomeado', f.admin.id); gate.release.resolve();
  const accepted = await pending;
  assert.equal(accepted.status, 200); assert.equal(accepted.data.version, 1); assert.deepEqual(f.channel().allowedGroups, [groupB]); assert.equal(f.auditCount(), 1);
});

test('HTTP grupos WhatsApp revalida sessão dentro do commit e desfaz alteração/audit se revogada antes dele', async t => {
  const f = await fixture(t), before = f.snapshot(), mutate = f.app.store.mutate.bind(f.app.store);
  f.app.store.mutate = (actor, id, action, update) => {
    if (action === 'WhatsApp: grupos de atendimento atualizados') f.app.auth.revokeUserSessions(f.admin.id);
    return mutate(actor, id, action, update);
  };
  const denied = await f.choose([groupB]);
  assert.equal(denied.status, 401); assert.deepEqual(f.snapshot(), before);
});

test('HTTP grupos WhatsApp verifica CAS no commit além da versão observada após consulta', async t => {
  const f = await fixture(t), mutate = f.app.store.mutate.bind(f.app.store);
  f.app.store.mutate = (actor, id, action, update) => {
    if (action === 'WhatsApp: grupos de atendimento atualizados') mutate(f.secondAdmin.actor, id, 'Fixture: commit concorrente antes do CAS', state => {
      state.channels[0].whatsappGroupsVersion = 1; state.channels[0].allowedGroups = [];
    });
    return mutate(actor, id, action, update);
  };
  assert.equal((await f.choose([groupB])).status, 409); assert.equal(f.channel().whatsappGroupsVersion, 1);
  assert.deepEqual(f.channel().allowedGroups, []); assert.equal(f.auditCount(), 0); assert.equal(f.snapshot().outbox, 0);
});

test('HTTP falha de consulta WhatsApp preserva seleção e revalida sessão também no erro do provedor', async t => {
  const f = await fixture(t), before = f.snapshot();
  f.entry.socket.groupFetchAllParticipating = async () => { f.calls.groups++; throw Error('Falha sintética privada'); };
  const failed = await f.choose([groupB]); assert.equal(failed.status, 502); assert.doesNotMatch(failed.data.error, /privada/);
  const gate = f.hold();
  f.entry.socket.groupFetchAllParticipating = async () => { f.calls.groups++; gate.entered.resolve(); await gate.release.promise; throw Error('Falha sintética privada'); };
  const pending = f.request(); await waiting(gate, pending); f.app.auth.revokeUserSessions(f.admin.id); gate.release.resolve();
  assert.equal((await pending).status, 401); assert.deepEqual(f.snapshot(), before); assert.equal(f.entry.groupCache.size, 0);
});

test('gateway grupos WhatsApp rejeita troca de ator, suporte/serviço e callback assíncrono antes do provedor', async t => {
  const f = await fixture(t), before = f.snapshot(), actor = { ...f.admin.actor };
  await assert.rejects(f.app.gateway.groups(actor, f.tenant.id, f.channelId, { reauthorize: () => { actor.userId = f.secondAdmin.id; } }), error => error.status === 403);
  for (const input of [{ ...f.admin.actor, kind: 'service' }, { ...f.admin.actor, supportGrantId: 'synthetic-untrusted-support' }]) await assert.rejects(f.app.gateway.groups(input, f.tenant.id, f.channelId), error => error.status === 403);
  await assert.rejects(f.app.gateway.groups(f.admin.actor, f.tenant.id, f.channelId, { reauthorize: async () => {} }), error => error.status === 400);
  assert.equal(f.calls.groups, 0); assert.deepEqual(f.snapshot(), before);
});

test('HTTP seleções WhatsApp concorrentes da mesma versão não sobrescrevem commit confirmado', async t => {
  const f = await fixture(t), first = f.hold(), second = f.hold();
  let sequence = 0;
  f.entry.socket.groupFetchAllParticipating = async () => { f.calls.groups++; const gate = sequence++ === 0 ? first : second; gate.entered.resolve(); await gate.release.promise; return providerGroups; };
  const pendingA = f.choose([groupB]), pendingB = f.choose([], 0, { cookie: f.secondAdmin.cookie });
  await Promise.all([waiting(first, pendingA), waiting(second, pendingB)]); second.release.resolve();
  assert.equal((await pendingB).status, 200); const committed = f.snapshot();
  first.release.resolve(); assert.equal((await pendingA).status, 409);
  assert.deepEqual(f.snapshot(), committed); assert.deepEqual(f.channel().allowedGroups, []); assert.equal(f.channel().whatsappGroupsVersion, 1); assert.equal(f.auditCount(), 1);
});

for (const change of ['generation', 'socket', 'connection', 'binding', 'tenant']) {
  test(`HTTP grupos WhatsApp recusa mudança ${change} durante consulta antes de atualizar seleção`, async t => {
    const f = await fixture(t), gate = f.hold(), before = f.snapshot(), pending = f.choose([groupB]);
    await waiting(gate, pending);
    if (change === 'generation') f.entry.generation++;
    if (change === 'socket') f.app.gateway.entries.set(f.channelId, { ...f.entry, socket: { ...f.entry.socket } });
    if (change === 'connection') f.entry.state = 'disconnected';
    if (change === 'binding') f.entry.expectedNumber = '5511999991111';
    if (change === 'tenant') f.entry.tenantId = f.otherTenant.id;
    gate.release.resolve(); assert.equal((await pending).status, 409); assert.deepEqual(f.snapshot(), before); assert.equal(f.entry.groupCache.size, 0);
  });
}

test('HTTP grupos WhatsApp exige admin/empresa/canal válidos e campos exatos antes de consultar provedor', async t => {
  const f = await fixture(t), before = f.snapshot();
  for (const options of [{ cookie: '' }, { cookie: f.operator.cookie }]) {
    const denied = await f.request(options); assert.ok([401, 403].includes(denied.status)); assert.equal(denied.data.groups, undefined);
  }
  assert.equal((await f.request({}, `/api/tenants/${f.otherTenant.id}/channels/${f.channelId}/groups`)).status, 404);
  for (const body of [{ groupIds: [] }, { version: '0', groupIds: [] }, { version: -1, groupIds: [] }, { version: 0, groupIds: [], tenantId: f.otherTenant.id }]) assert.equal((await f.request({ method: 'POST', body })).status, 400);
  assert.equal(f.calls.groups, 0); assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.choose(['foreign@g.us'])).status, 400); assert.deepEqual(f.snapshot(), before);
});
