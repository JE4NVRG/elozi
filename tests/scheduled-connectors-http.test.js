import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const kinds = ['webchat', 'email', 'instagram', 'messenger'];
const denied = async () => { throw new Error('External access forbidden in scheduled connector fixture'); };
const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const siteOrigin = 'https://scheduled-fixture.example.test';
const relaySecret = 'synthetic-scheduled-relay-' + 'x'.repeat(32);
const appSecret = 'synthetic-scheduled-meta-secret';
const resourceId = '123456789001', senderId = '987654321001';

async function fixture(t, kind, { uncertain = false } = {}) {
  const key = randomBytes(32), providerCalls = []; let clock = Date.now();
  const app = createApp({ databasePath: ':memory:', serviceKey: key, publicOrigin: '',
    scheduledOptions: { now: () => clock }, automationOptions: { now: () => clock },
    providerCall: denied, mediaOptions: { directory: null, authKey: key },
    gatewayOptions: { authKey: key, socketFactory: denied, downloadMediaImpl: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denied },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied },
    webchatOptions: { now: () => clock },
    emailChannelOptions: { now: () => clock,
      getDeliveryConfiguration: async () => ({ apiKey: 'ms_synthetic_scheduled_fixture_key', from: 'mailbox@example.test' }),
      fetchImpl: async (url, input) => {
        providerCalls.push({ url, payload: JSON.parse(input.body) });
        if (uncertain) throw new Error('Synthetic lost provider response');
        return { ok: true, status: 200, json: async () => ({ id: 'synthetic-scheduled-email-id' }) };
      } },
    metaOptions: { now: () => clock, fetchImpl: async (url, input) => {
      providerCalls.push({ url, payload: JSON.parse(input.body) });
      if (uncertain) throw new Error('Synthetic lost provider response');
      return { ok: true, status: 200, json: async () => ({ recipient_id: senderId, message_id: 'synthetic-scheduled-meta-id' }) };
    } }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.scheduled.waitIdle();
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.webchat.close(), app.emailChannel.close(), app.meta.close()]);
    await app.bridge.close(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, raw, cookie = '', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Gestor sintético', username: 'scheduled.owner', password: password() } });
  assert.equal(owner.status, 200, JSON.stringify(owner.data));
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Agendamentos sintéticos', segment: 'QA RAM' } });
  assert.equal(tenant.status, 201, JSON.stringify(tenant.data));
  const tenantId = tenant.data.id, path = `/api/tenants/${tenantId}`;
  const created = await request(path + '/channels', { method: 'POST', cookie: owner.cookie, body: { name: 'Conector sintético', kind, real: true } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.id, configurationPath = `${path}/channels/${channelId}/configuration`;
  const settings = kind === 'webchat' ? { origins: [siteOrigin] } : kind === 'email'
    ? { address: 'mailbox@example.test', ingressSecret: relaySecret }
    : { resourceId, apiVersion: 'v23.0', accessToken: 'synthetic-scheduled-meta-token', appSecret, verifyToken: 'synthetic-scheduled-meta-verification' };
  const configured = await request(configurationPath, { method: 'POST', cookie: owner.cookie, body: { version: 0, enabled: true, ...settings } });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  let visitor;
  if (kind === 'webchat') {
    const publicPath = `/api/public/webchat/${tenantId}/${channelId}`, headers = { Origin: siteOrigin };
    const challenge = await request(publicPath + '/challenge', { method: 'POST', headers, body: {} });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
    const session = await request(publicPath + '/session', { method: 'POST', headers, body: { challenge: challenge.data.challenge, name: 'Visitante sintético' } });
    assert.equal(session.status, 200, JSON.stringify(session.data)); visitor = session.data;
    const incoming = await request(publicPath + '/messages', { method: 'POST', headers, body: { token: visitor.token, clientMessageId: 'scheduled-incoming-webchat-0001', text: 'Pedido sintético' } });
    assert.equal(incoming.status, 200, JSON.stringify(incoming.data));
  } else if (kind === 'email') {
    const raw = Buffer.from(JSON.stringify({ id: 'scheduled-incoming-email-0001', from: 'visitor@example.test', to: 'mailbox@example.test', subject: 'Pedido sintético', text: 'Pedido sintético' }));
    const timestamp = String(Math.floor(clock / 1000)), signature = createHmac('sha256', relaySecret).update(`${timestamp}.`).update(raw).digest('hex');
    const incoming = await request(`/api/webhooks/email/${tenantId}/${channelId}`, { method: 'POST', raw, headers: { 'X-Elozi-Timestamp': timestamp, 'X-Elozi-Signature': signature } });
    assert.equal(incoming.status, 200, JSON.stringify(incoming.data));
  } else {
    const raw = Buffer.from(JSON.stringify({ object: kind === 'messenger' ? 'page' : 'instagram', entry: [{ id: resourceId, messaging: [{ sender: { id: senderId }, recipient: { id: resourceId }, timestamp: clock, message: { mid: 'scheduled-incoming-meta-0001', text: 'Pedido sintético' } }] }] }));
    const signature = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
    const incoming = await request(`/api/webhooks/meta/${tenantId}/${channelId}`, { method: 'POST', raw, headers: { 'X-Hub-Signature-256': signature } });
    assert.equal(incoming.status, 200, JSON.stringify(incoming.data));
  }
  const state = () => app.store.tenant(actor, tenantId);
  const conversation = () => state().conversations.find(item => item.channelId === channelId);
  assert.ok(conversation(), 'Signed/public ingress must create the connector conversation');
  const operatorPassword = password();
  const member = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Responsável sintético', username: 'scheduled.operator', password: operatorPassword, role: 'operator', tenantIds: [tenantId] } });
  assert.equal(member.status, 201, JSON.stringify(member.data));
  const login = await request('/api/auth/login', { method: 'POST', body: { username: 'scheduled.operator', password: operatorPassword } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const operator = { ...member.data, cookie: login.cookie };
  const take = await request(`${path}/conversations/${conversation().id}/owner`, { method: 'POST', cookie: operator.cookie, body: { version: conversation().version, owner: 'human' } });
  assert.equal(take.status, 200, JSON.stringify(take.data));
  const route = `${path}/conversations/${conversation().id}/scheduled`;
  const adapter = kind === 'webchat' ? app.webchat : kind === 'email' ? app.emailChannel : app.meta;
  const originalSend = adapter.send.bind(adapter); let adapterCalls = 0;
  adapter.send = async (...args) => {
    adapterCalls++;
    const result = await originalSend(...args);
    // The worker can lose its local receipt after acceptance, even when no remote API is involved.
    if (uncertain && kind === 'webchat') throw Object.assign(new Error('Synthetic lost local receipt'), { status: 502 });
    return result;
  };
  const input = (overrides = {}) => ({ version: conversation().version, text: 'Resposta agendada sintética', dueAt: new Date(clock + 65_000).toISOString(), commandId: randomUUID(), ...overrides });
  const schedule = body => request(route, { method: 'POST', cookie: operator.cookie, body });
  const list = async () => {
    const result = await request(route, { cookie: owner.cookie }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.schedules;
  };
  const command = () => app.store.db.prepare('SELECT state,attempts FROM outbound_commands WHERE tenant_id=? AND conversation_id=?').get(tenantId, conversation().id);
  return { app, request, owner, operator, actor, tenantId, channelId, path, route, configurationPath, visitor, state, conversation, input, schedule, list, command, providerCalls,
    adapterCalls: () => adapterCalls, time: value => { clock += value; } };
}

for (const kind of kinds) {
  test(`HTTP ${kind}: CAS e replay do agendamento enviam uma vez pelo adaptador autorizado`, async t => {
    const c = await fixture(t, kind), body = c.input();
    assert.equal((await c.request(c.route)).status, 401);
    assert.equal((await c.request(c.route, { method: 'POST', cookie: c.owner.cookie, body })).status, 409);
    assert.equal((await c.schedule({ ...body, commandId: randomUUID(), version: body.version - 1 })).status, 409);
    const created = await c.schedule(body); assert.equal(created.status, 200, JSON.stringify(created.data)); assert.equal(created.data.state, 'pending');
    for (const key of ['commandId', 'idempotencyKey', 'supportGrantId', 'accessToken', 'ingressSecret']) assert.equal(created.data[key], undefined);
    const replay = await c.schedule(body); assert.equal(replay.status, 200); assert.deepEqual(replay.data, created.data);
    assert.equal((await c.schedule({ ...body, text: 'Conteúdo alterado' })).status, 409);
    await c.app.scheduled.tick(); assert.equal(c.adapterCalls(), 0);
    c.time(65_000); await Promise.all([c.app.scheduled.tick(), c.app.scheduled.tick()]);
    const sent = (await c.list())[0]; assert.equal(sent.state, 'sent'); assert.ok(sent.sentAt);
    assert.equal(c.adapterCalls(), 1); assert.equal(c.providerCalls.length, kind === 'webchat' ? 0 : 1);
    assert.deepEqual({ ...c.command() }, { state: 'confirmed', attempts: 1 });
    const humans = c.conversation().messages.filter(message => message.kind === 'human');
    assert.equal(humans.length, 1); assert.equal(humans[0].delivery, 'sent'); assert.equal(humans[0].authorUserId, c.operator.id);
    const stable = JSON.stringify(c.conversation());
    const terminalReplay = await c.schedule(body); assert.equal(terminalReplay.status, 200); assert.equal(terminalReplay.data.state, 'sent');
    await c.app.scheduled.tick(); assert.equal(JSON.stringify(c.conversation()), stable); assert.equal(c.adapterCalls(), 1);
    if (kind === 'webchat') {
      const history = await c.request(`/api/public/webchat/${c.tenantId}/${c.channelId}/history`, { method: 'POST', headers: { Origin: siteOrigin }, body: { token: c.visitor.token } });
      assert.equal(history.status, 200); assert.deepEqual(history.data.messages.map(message => message.text), ['Pedido sintético', body.text]);
    } else if (kind === 'email') {
      assert.equal(c.providerCalls[0].url, 'https://api-mepmail.je4ndev.com/emails'); assert.deepEqual(c.providerCalls[0].payload.to, ['visitor@example.test']);
    } else {
      assert.equal(c.providerCalls[0].url, `https://${kind === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com'}/v23.0/${resourceId}/messages`);
      assert.deepEqual(c.providerCalls[0].payload.recipient, { id: senderId });
    }
  });

  test(`HTTP ${kind}: resultado incerto fica terminal e não dispara novamente`, async t => {
    const c = await fixture(t, kind, { uncertain: true }), body = c.input();
    assert.equal((await c.schedule(body)).status, 200); c.time(65_000); await c.app.scheduled.tick();
    const unknown = (await c.list())[0]; assert.equal(unknown.state, 'unknown'); assert.equal(unknown.reasonCode, 'send_unconfirmed');
    assert.deepEqual({ ...c.command() }, { state: 'unknown', attempts: 1 }); assert.equal(c.adapterCalls(), 1);
    const stable = JSON.stringify(c.conversation()), calls = c.providerCalls.length;
    c.app.scheduled.recover(); await c.app.scheduled.tick(); await c.app.scheduled.tick();
    const replay = await c.schedule(body); assert.equal(replay.status, 200); assert.equal(replay.data.state, 'unknown');
    assert.equal((await c.request(c.route + '/cancel', { method: 'POST', cookie: c.operator.cookie, body: { id: unknown.id, version: c.conversation().version } })).status, 409);
    assert.equal(JSON.stringify(c.conversation()), stable); assert.equal(c.adapterCalls(), 1); assert.equal(c.providerCalls.length, calls);
    assert.equal(c.conversation().messages.filter(message => message.kind === 'human').length, 1);
  });

  for (const gate of [1, 2]) test(`HTTP ${kind}: retirar autoridade no gate ${gate} bloqueia antes do adaptador`, async t => {
    const c = await fixture(t, kind); assert.equal((await c.schedule(c.input())).status, 200);
    let gates = 0;
    c.app.outbox.beforeSend = async () => {
      if (++gates === gate) {
        const revoked = await c.request(`/api/users/${c.operator.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { permissions: ['inbox.read'] } });
        assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
      }
    };
    c.time(65_000); await c.app.scheduled.tick();
    const blocked = (await c.list())[0]; assert.equal(blocked.state, 'blocked'); assert.equal(blocked.reasonCode, 'authority_changed');
    assert.equal(gates, gate); assert.equal(c.adapterCalls(), 0); assert.equal(c.providerCalls.length, 0);
    assert.deepEqual({ ...c.command() }, { state: 'failed', attempts: gate - 1 });
    assert.equal(c.conversation().messages.filter(message => message.kind === 'human').length, 0);
    await c.app.scheduled.tick(); assert.equal(c.adapterCalls(), 0);
    assert.equal((await c.request(c.route, { cookie: c.operator.cookie })).status, 401);
  });

  test(`HTTP ${kind}: canal desativado preserva agendamento pendente e permite cancelar`, async t => {
    const c = await fixture(t, kind), created = await c.schedule(c.input()); assert.equal(created.status, 200);
    const current = await c.request(c.configurationPath, { cookie: c.owner.cookie }); assert.equal(current.status, 200);
    const disabled = await c.request(c.configurationPath, { method: 'POST', cookie: c.owner.cookie, body: { version: current.data.version, enabled: false } });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
    c.time(65_000); await c.app.scheduled.tick();
    const pending = (await c.list())[0]; assert.equal(pending.state, 'pending'); assert.equal(c.command(), undefined);
    const cancelled = await c.request(c.route + '/cancel', { method: 'POST', cookie: c.operator.cookie, body: { id: pending.id, version: c.conversation().version } });
    assert.equal(cancelled.status, 200); assert.equal(cancelled.data.state, 'cancelled');
    await c.app.scheduled.tick(); assert.equal(c.adapterCalls(), 0); assert.equal(c.providerCalls.length, 0);
    assert.equal(c.conversation().messages.filter(message => message.kind === 'customer').length, 1);
  });
}

for (const kind of ['instagram', 'messenger']) {
  test(`HTTP ${kind}: criar fora da janela Meta é recusado sem agendamento nem outbox`, async t => {
    const c = await fixture(t, kind), body = c.input({ dueAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString() });
    const before = JSON.stringify(c.conversation()); assert.equal((await c.schedule(body)).status, 409);
    assert.equal((await c.list()).length, 0); assert.equal(c.command(), undefined); assert.equal(c.adapterCalls(), 0); assert.equal(c.providerCalls.length, 0);
    assert.equal(JSON.stringify(c.conversation()), before);
    c.time(25 * 60 * 60 * 1000 + 65_000); await c.app.scheduled.tick(); assert.equal(c.command(), undefined); assert.equal(c.adapterCalls(), 0);
  });

  test(`HTTP ${kind}: agendamento legado dentro da janela é bloqueado quando a janela expira antes do claim`, async t => {
    const c = await fixture(t, kind), created = await c.schedule(c.input()); assert.equal(created.status, 200); assert.equal(created.data.state, 'pending');
    c.time(25 * 60 * 60 * 1000 + 65_000); await c.app.scheduled.tick();
    const blocked = (await c.list())[0]; assert.equal(blocked.state, 'blocked'); assert.equal(blocked.reasonCode, 'channel_policy_changed');
    assert.equal(c.command(), undefined); assert.equal(c.adapterCalls(), 0); assert.equal(c.providerCalls.length, 0);
    assert.equal(c.conversation().messages.filter(message => message.kind === 'human').length, 0);
    await c.app.scheduled.tick(); assert.equal(c.command(), undefined); assert.equal(c.providerCalls.length, 0);
  });
}
