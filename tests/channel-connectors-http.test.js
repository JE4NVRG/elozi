import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const visitorOrigin = 'https://shop.example.test';
const relaySecret = 'synthetic-relay-secret-0123456789abcdef';
const mepmailKey = 'ms_synthetic_http_fixture_0123456789';
const metaCredentials = { accessToken: 'synthetic-http-meta-access', appSecret: 'synthetic-http-meta-app-secret', verifyToken: 'synthetic-http-meta-verify' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const barrier = () => ({ entered: deferred(), release: deferred() });

async function fixture(t) {
  const key = randomBytes(32), calls = { email: [], meta: [], external: [] }, control = { now: Date.now(), emailMode: 'accepted', metaMode: 'accepted' };
  const deny = async () => { calls.external.push(true); throw new Error('External network forbidden in RAM fixture'); };
  let app, vault;
  const send = async (kind, url, input) => {
    calls[kind].push({ url, input });
    const mode = control[kind + 'Mode'];
    if (mode === 'uncertain') throw new Error('Synthetic response lost after provider attempt');
    if (mode === 'until-close') {
      const gate = control[kind + 'ProviderGate']; gate.entered.resolve();
      await new Promise((resolve, reject) => {
        if (input.signal.aborted) return reject(new Error('Synthetic transport aborted'));
        input.signal.addEventListener('abort', () => reject(new Error('Synthetic transport aborted')), { once: true });
      });
    }
    const body = JSON.parse(input.body);
    return { ok: true, status: 200, json: async () => kind === 'email' ? { id: 'synthetic-email-' + calls.email.length } : { recipient_id: body.recipient.id, message_id: 'synthetic-meta-' + calls.meta.length } };
  };
  app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', key, fetchImpl: deny },
    webchatOptions: { now: () => control.now },
    emailChannelOptions: { now: () => control.now, fetchImpl: (url, input) => send('email', url, input),
      getDeliveryConfiguration: async ({ address }) => {
        const gate = control.emailConfigurationGate;
        if (gate) { control.emailConfigurationGate = null; gate.entered.resolve(); await gate.release.promise; }
        return { apiKey: mepmailKey, from: address };
      },
      loadSecrets: async () => {
        vault ||= encryptedChannelSecrets(app.store.db, key);
        return { get: id => vault.get(id), set: async (id, value) => {
          const gate = control.secretWriteGate;
          if (gate) { control.secretWriteGate = null; gate.entered.resolve(); await gate.release.promise; }
          vault.set(id, value);
        } };
      } },
    metaOptions: { now: () => control.now, fetchImpl: (url, input) => send('meta', url, input) }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    for (const name of ['emailConfigurationGate', 'secretWriteGate']) control[name]?.release.resolve();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(calls.external.length, 0, 'no external transport was used');
    app.store.close();
  });
  const request = (path, { method = 'GET', cookie, body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    assert.ok(body === undefined || raw === undefined);
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, headers: response.headers, text, data: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
    });
    pending.setTimeout(5000, () => pending.destroy(new Error('Loopback request exceeded fixture deadline')));
    pending.on('error', reject); pending.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
  let userSequence = 0;
  const member = (tenantIds = [], { role = 'operator', permissions, scopeRules, platformAdmin = false } = {}) => {
    const name = 'Connector HTTP fixture ' + ++userSequence;
    const row = app.auth.insertUser({ username: 'connector.http.' + userSequence, name }, randomBytes(16), randomBytes(64), role, tenantIds, 'mep-demo', { platformAdmin });
    if (permissions !== undefined || scopeRules !== undefined) app.store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions === undefined ? null : JSON.stringify(permissions), scopeRules === undefined ? null : JSON.stringify(scopeRules), row.id);
    const session = app.auth.session(app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    return { id: row.id, cookie: 'mep_session=' + session.token, actor: session.actor };
  };
  const owner = member([], { role: 'reseller', platformAdmin: true });
  assert.equal((await request('/api/auth/me', { cookie: owner.cookie })).status, 200);
  const tenant = async name => {
    const result = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name, segment: 'Synthetic connector integration' } });
    assert.equal(result.status, 201, result.data?.error); return result.data;
  };
  const channel = async (tenantId, kind, name = kind + ' HTTP fixture') => {
    const result = await request(`/api/tenants/${tenantId}/channels`, { method: 'POST', cookie: owner.cookie, body: { kind, name, real: true } });
    assert.equal(result.status, 201, result.data?.error); return result.data;
  };
  const configurationPath = (tenantId, channelId) => `/api/tenants/${tenantId}/channels/${channelId}/configuration`;
  const configure = async (tenantId, channelId, body, cookie = owner.cookie) => {
    const result = await request(configurationPath(tenantId, channelId), { method: 'POST', cookie, body });
    assert.equal(result.status, 200, result.data?.error); return result.data;
  };
  const state = tenantId => app.store.tenant(owner.actor, tenantId);
  const conversation = (tenantId, channelId) => state(tenantId).conversations.find(item => item.channelId === channelId);
  const claim = async (tenantId, current, person) => {
    const result = await request(`/api/tenants/${tenantId}/conversations/${current.id}/owner`, { method: 'POST', cookie: person.cookie, body: { version: current.version, owner: 'human' } });
    assert.equal(result.status, 200, result.data?.error); assert.equal(result.data.assignedUserId, person.id); return result.data;
  };
  const publicPath = (tenantId, channelId, action) => `/api/public/webchat/${tenantId}/${channelId}/${action}`;
  const publicRequest = (tenantId, channelId, action, body = {}, headers = {}) => request(publicPath(tenantId, channelId, action), { method: 'POST', body, headers: { Origin: visitorOrigin, ...headers } });
  const openVisitor = async (tenantId, channelId) => {
    const challenge = await publicRequest(tenantId, channelId, 'challenge'); assert.equal(challenge.status, 200, challenge.data?.error);
    const session = await publicRequest(tenantId, channelId, 'session', { challenge: challenge.data.challenge, name: 'Visitante HTTP' }); assert.equal(session.status, 200, session.data?.error);
    return { token: session.data.token, challenge: challenge.data.challenge, expiresAt: session.data.expiresAt };
  };
  const emailWebhook = (tenantId, channelId, envelope, { raw = JSON.stringify(envelope), secret = relaySecret, timestamp = String(Math.floor(control.now / 1000)), signature } = {}) => request(`/api/webhooks/email/${tenantId}/${channelId}`, {
    method: 'POST', raw, headers: { 'x-elozi-timestamp': timestamp, 'x-elozi-signature': signature ?? createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex') }
  });
  const metaWebhook = (tenantId, channelId, envelope, { raw = JSON.stringify(envelope), signature } = {}) => request(`/api/webhooks/meta/${tenantId}/${channelId}`, {
    method: 'POST', raw, headers: { 'x-hub-signature-256': signature ?? 'sha256=' + createHmac('sha256', metaCredentials.appSecret).update(raw).digest('hex') }
  });
  return { app, base, request, owner, member, tenant, channel, configure, configurationPath, state, conversation, claim, publicRequest, publicPath, openVisitor, emailWebhook, metaWebhook, control, calls };
}

function assertPrivate(result, values = [relaySecret, mepmailKey, ...Object.values(metaCredentials)]) {
  for (const value of values) assert.equal(result.text.includes(value), false, 'response contains only public channel metadata');
}

test('HTTP webchat: scoped CORS, nonce, real operator reply and safe visitor history across two companies', async t => {
  const c = await fixture(t), first = await c.tenant('Webchat company A'), second = await c.tenant('Webchat company B');
  const a = await c.channel(first.id, 'webchat'), sibling = await c.channel(first.id, 'webchat', 'Sibling widget'), b = await c.channel(second.id, 'webchat');
  const alice = c.member([first.id]), bob = c.member([second.id]);
  for (const [tenantId, item] of [[first.id, a], [first.id, sibling], [second.id, b]]) {
    const configured = await c.configure(tenantId, item.id, { version: 0, enabled: true, origins: [visitorOrigin] });
    assert.equal(configured.tenantId, tenantId); assert.equal(configured.channelId, item.id); assert.equal(configured.kind, 'webchat'); assert.equal(configured.enabled, true);
    assert.equal(configured.mediaSupported, true); assert.equal(configured.install.scriptUrl, c.base + '/widget.js');
    assert.ok(configured.install.embedSnippet.includes(`data-tenant-id="${tenantId}"`)); assert.ok(configured.install.embedSnippet.includes('type="module"'));
  }
  const config = c.configurationPath(first.id, a.id);
  assert.equal((await c.request(config)).status, 401);
  assert.equal((await c.request(config, { cookie: alice.cookie })).status, 403);
  assert.equal((await c.request(config, { cookie: bob.cookie })).status, 403);
  const preflight = await c.request(c.publicPath(first.id, a.id, 'history'), { method: 'OPTIONS', headers: { Origin: visitorOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], visitorOrigin); assert.equal(preflight.headers.vary, 'Origin'); assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.equal(c.app.webchat.challenges.size, 0); assert.equal(c.app.store.db.prepare('SELECT count(*) AS count FROM webchat_sessions').get().count, 0);
  const forbiddenPreflight = await c.request(c.publicPath(first.id, a.id, 'history'), { method: 'OPTIONS', headers: { Origin: 'https://outside.example.test' } });
  assert.equal(forbiddenPreflight.status, 403); assert.equal(forbiddenPreflight.headers['access-control-allow-origin'], undefined);
  const widget = await c.request('/widget.js'); assert.equal(widget.status, 200); assert.equal(widget.headers['access-control-allow-origin'], '*'); assert.match(widget.headers['content-type'], /javascript/);
  const visitor = await c.openVisitor(first.id, a.id);
  assert.equal((await c.publicRequest(first.id, a.id, 'session', { challenge: visitor.challenge })).status, 403);
  const input = { token: visitor.token, clientMessageId: randomUUID(), text: 'Preciso de atendimento pelo site.' };
  const incoming = await c.publicRequest(first.id, a.id, 'messages', input); assert.equal(incoming.status, 200); assert.ok(incoming.data.messageId); assert.equal(incoming.data.replayed, false);
  const replay = await c.publicRequest(first.id, a.id, 'messages', input); assert.equal(replay.status, 200); assert.equal(replay.data.messageId, incoming.data.messageId); assert.equal(replay.data.replayed, true);
  assert.equal((await c.publicRequest(first.id, a.id, 'messages', { ...input, text: 'Alterado indevidamente' })).status, 409);
  assert.equal((await c.publicRequest(first.id, a.id, 'messages', { ...input, clientMessageId: randomUUID(), attachments: [{ url: 'https://outside.example.test/private' }] })).status, 400);
  for (const [tenantId, item] of [[first.id, sibling], [second.id, b]]) {
    assert.equal((await c.publicRequest(tenantId, item.id, 'history', { token: visitor.token })).status, 403);
    assert.equal((await c.publicRequest(tenantId, item.id, 'messages', { ...input, clientMessageId: randomUUID() })).status, 403);
  }
  assert.equal((await c.publicRequest(first.id, a.id, 'history', { token: visitor.token }, { Origin: 'https://outside.example.test' })).status, 403);
  assert.equal((await c.request(c.publicPath(first.id, a.id, 'history'), { headers: { Origin: visitorOrigin } })).status, 405);
  let current = c.conversation(first.id, a.id); assert.equal(current.messages.filter(item => item.kind === 'customer').length, 1); assert.equal(current.owner, 'queue');
  assert.equal((await c.request(`/api/tenants/${first.id}/conversations/${current.id}/owner`, { method: 'POST', cookie: bob.cookie, body: { version: current.version, owner: 'human' } })).status, 403);
  current = await c.claim(first.id, current, alice);
  const route = `/api/tenants/${first.id}/conversations/${current.id}/messages`, reply = { version: current.version, channelId: a.id, text: 'Estamos aqui para ajudar.', attachmentIds: [], idempotencyKey: randomUUID() };
  const sent = await c.request(route, { method: 'POST', cookie: alice.cookie, body: reply }); assert.equal(sent.status, 200, sent.data?.error); assert.equal(sent.data.messages.at(-1).delivery, 'sent');
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: reply })).status, 200);
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: { ...reply, text: 'Mudança de conteúdo' } })).status, 409);
  const note = await c.request(`/api/tenants/${first.id}/conversations/${current.id}/notes`, { method: 'POST', cookie: alice.cookie, body: { version: sent.data.version, commandId: randomUUID(), text: 'INTERNAL_NOTE_HTTP_FIXTURE' } }); assert.equal(note.status, 200, note.data?.error);
  c.app.store.mutate(c.owner.actor, first.id, 'Synthetic uncertain message', state => { state.conversations.find(item => item.id === current.id).messages.push({ id: randomUUID(), kind: 'human', text: 'UNCONFIRMED_HTTP_FIXTURE', delivery: 'unconfirmed', createdAt: new Date(c.control.now).toISOString() }); });
  const history = await c.publicRequest(first.id, a.id, 'history', { token: visitor.token }); assert.equal(history.status, 200);
  assert.deepEqual(history.data.messages.map(item => item.text), [input.text, reply.text]); assert.equal(history.data.mediaSupported, true);
  assert.equal(history.text.includes('assignedUserId'), false); assert.equal(history.text.includes('INTERNAL_NOTE_HTTP_FIXTURE'), false); assert.equal(history.text.includes('UNCONFIRMED_HTTP_FIXTURE'), false);
  const after = await c.publicRequest(first.id, a.id, 'history', { token: visitor.token, after: incoming.data.messageId, limit: 1 }); assert.equal(after.status, 200); assert.deepEqual(after.data.messages.map(item => item.text), [reply.text]);
  assert.equal(c.state(second.id).conversations.some(item => item.channelId === b.id), false);
  assert.equal(c.app.outbox.list(alice.actor, first.id).filter(item => item.state === 'confirmed').length, 1);
  assertPrivate(history, [visitor.token]);
});

test('HTTP webchat: disabling and restoring configuration preserves transcript and invalidates old sessions', async t => {
  const c = await fixture(t), tenant = await c.tenant('Webchat epoch company'), channel = await c.channel(tenant.id, 'webchat');
  await c.configure(tenant.id, channel.id, { origins: [visitorOrigin], version: 0 });
  const original = await c.openVisitor(tenant.id, channel.id), inbound = { token: original.token, clientMessageId: randomUUID(), text: 'Preserve esta conversa.' };
  assert.equal((await c.publicRequest(tenant.id, channel.id, 'messages', inbound)).status, 200);
  const receipt = c.app.store.db.prepare('SELECT * FROM webchat_inbound_receipts').get(), originalTranscript = JSON.stringify(c.conversation(tenant.id, channel.id).messages);
  await c.configure(tenant.id, channel.id, { version: 1, enabled: false });
  assert.equal((await c.publicRequest(tenant.id, channel.id, 'challenge')).status, 403);
  await c.configure(tenant.id, channel.id, { version: 2, enabled: true });
  assert.equal((await c.publicRequest(tenant.id, channel.id, 'history', { token: original.token })).status, 403);
  assert.equal((await c.publicRequest(tenant.id, channel.id, 'messages', inbound)).status, 403);
  assert.deepEqual(c.app.store.db.prepare('SELECT * FROM webchat_inbound_receipts').get(), receipt); assert.equal(JSON.stringify(c.conversation(tenant.id, channel.id).messages), originalTranscript);
  const fresh = await c.openVisitor(tenant.id, channel.id); assert.notEqual(fresh.token, original.token);
  assert.deepEqual((await c.publicRequest(tenant.id, channel.id, 'history', { token: fresh.token })).data.messages, []);
  assert.equal(c.app.store.db.prepare('SELECT count(*) AS count FROM webchat_sessions').get().count, 2);
  c.control.now = Date.parse(fresh.expiresAt);
  assert.equal((await c.publicRequest(tenant.id, channel.id, 'history', { token: fresh.token })).status, 403);
});

test('HTTP email: raw HMAC ingress, scoped receipt and MepMail outbox without attachment or secret leakage', async t => {
  const c = await fixture(t), first = await c.tenant('Email company A'), second = await c.tenant('Email company B');
  const a = await c.channel(first.id, 'email'), b = await c.channel(second.id, 'email'), alice = c.member([first.id]), colleague = c.member([first.id]), bob = c.member([second.id]);
  for (const [tenantId, item, address] of [[first.id, a, 'support-a@example.test'], [second.id, b, 'support-b@example.test']]) {
    const result = await c.configure(tenantId, item.id, { version: 0, enabled: true, address, ingressSecret: relaySecret });
    assert.equal(result.kind, 'email'); assert.equal(result.state, 'configured'); assert.equal(result.mailboxConnected, false); assert.equal(result.ingress, 'elozi-signed-relay'); assert.equal(result.ingressConfigured, true); assert.equal(result.enabled, true);
    assert.equal(result.webhookUrl, `${c.base}/api/webhooks/email/${tenantId}/${item.id}`); assert.equal(result.mediaSupported, false);
    const status = await c.request(c.configurationPath(tenantId, item.id), { cookie: c.owner.cookie }); assert.equal(status.status, 200); assertPrivate(status);
  }
  const envelope = { id: 'shared-event-http-1', from: 'visitor@example.test', to: 'support-a@example.test', fromName: 'Contato HTTP', subject: 'Pedido sintético', text: 'Mensagem de entrada por relay.' };
  const raw = JSON.stringify(envelope, null, 2), firstIngress = await c.emailWebhook(first.id, a.id, envelope, { raw }); assert.equal(firstIngress.status, 200); assert.equal(firstIngress.data.accepted, true); assert.equal(firstIngress.data.replayed, false);
  assert.equal((await c.emailWebhook(first.id, a.id, envelope, { raw: JSON.stringify(envelope), signature: createHmac('sha256', relaySecret).update(String(Math.floor(c.control.now / 1000)) + '.').update(raw).digest('hex') })).status, 403);
  assert.equal((await c.emailWebhook(first.id, a.id, envelope)).data.replayed, true);
  assert.equal((await c.emailWebhook(first.id, a.id, { ...envelope, text: 'Conteúdo alterado' })).status, 409);
  assert.equal((await c.emailWebhook(first.id, a.id, { ...envelope, id: 'attachment-http', attachments: [{ name: 'fake.pdf' }] })).status, 400);
  assert.equal((await c.emailWebhook(second.id, b.id, envelope)).status, 403);
  assert.equal((await c.emailWebhook(second.id, b.id, { ...envelope, to: 'support-b@example.test' })).status, 200);
  assert.equal(c.app.store.db.prepare('SELECT count(*) AS count FROM channel_email_seen').get().count, 2);
  const credentials = c.app.store.db.prepare('SELECT payload FROM channel_secrets').all(); assert.ok(credentials.length >= 2); for (const row of credentials) assert.equal(Buffer.from(row.payload).includes(Buffer.from(relaySecret)), false);
  let current = await c.claim(first.id, c.conversation(first.id, a.id), alice);
  const route = `/api/tenants/${first.id}/conversations/${current.id}/messages`, input = { version: current.version, channelId: a.id, text: 'Resposta sintética pelo MepMail.', attachmentIds: [], idempotencyKey: randomUUID() };
  assert.equal((await c.request(route, { method: 'POST', cookie: bob.cookie, body: input })).status, 403);
  assert.equal((await c.request(route, { method: 'POST', cookie: colleague.cookie, body: input })).status, 409);
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: input, headers: { Origin: visitorOrigin } })).status, 403);
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: input, headers: { Origin: c.base, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(c.calls.email.length, 0);
  const sent = await c.request(route, { method: 'POST', cookie: alice.cookie, body: input }); assert.equal(sent.status, 200, sent.data?.error); assert.equal(sent.data.messages.at(-1).delivery, 'sent'); assertPrivate(sent);
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: input })).status, 200); assert.equal(c.calls.email.length, 1);
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: { ...input, text: 'Outro texto na mesma chave' } })).status, 409);
  const delivery = c.calls.email[0]; assert.equal(delivery.url, 'https://api-mepmail.je4ndev.com/emails'); assert.equal(delivery.input.redirect, 'error');
  assert.deepEqual(JSON.parse(delivery.input.body), { from: 'support-a@example.test', to: ['visitor@example.test'], subject: 'Re: ' + envelope.subject, text: input.text });
  assert.equal(delivery.input.headers.Authorization, 'Bearer ' + mepmailKey); assert.match(delivery.input.headers['Idempotency-Key'], /^[a-f0-9]{64}$/);
  current = c.conversation(first.id, a.id);
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: { version: current.version, channelId: a.id, text: 'Anexo negado', attachmentIds: [randomUUID()], idempotencyKey: randomUUID() } })).status, 400);
  assert.equal(c.calls.email.length, 1); assert.equal(c.conversation(second.id, b.id).messages.filter(item => item.kind === 'human').length, 0);
});

test('HTTP email: revocation during delivery setup prevents a call; uncertain attempt cannot be replayed', async t => {
  const c = await fixture(t), tenant = await c.tenant('Email authority company'), channel = await c.channel(tenant.id, 'email'), alice = c.member([tenant.id]);
  await c.configure(tenant.id, channel.id, { version: 0, address: 'support@example.test', ingressSecret: relaySecret });
  await c.emailWebhook(tenant.id, channel.id, { id: 'email-authority-http', from: 'contact@example.test', to: 'support@example.test', subject: 'Autoridade', text: 'Entrada sintética.' });
  let current = await c.claim(tenant.id, c.conversation(tenant.id, channel.id), alice);
  const route = `/api/tenants/${tenant.id}/conversations/${current.id}/messages`, denied = { version: current.version, channelId: channel.id, text: 'Revogada antes do provedor.', attachmentIds: [], idempotencyKey: randomUUID() }, beforeMessages = current.messages.length;
  const gate = barrier(); c.control.emailConfigurationGate = gate;
  const sending = c.request(route, { method: 'POST', cookie: alice.cookie, body: denied }); await gate.entered.promise;
  assert.equal((await c.request('/api/auth/logout', { method: 'POST', cookie: alice.cookie, body: {} })).status, 200); gate.release.resolve();
  assert.equal((await sending).status, 401); assert.equal(c.calls.email.length, 0); assert.equal(c.conversation(tenant.id, channel.id).messages.length, beforeMessages);
  const session = c.app.auth.session(c.app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(alice.id)); alice.cookie = 'mep_session=' + session.token;
  current = c.conversation(tenant.id, channel.id); c.control.emailMode = 'uncertain';
  const uncertain = { version: current.version, channelId: channel.id, text: 'Tentativa com resposta perdida.', attachmentIds: [], idempotencyKey: randomUUID() };
  const result = await c.request(route, { method: 'POST', cookie: alice.cookie, body: uncertain }); assert.equal(result.status, 502);
  assert.equal(c.conversation(tenant.id, channel.id).messages.at(-1).delivery, 'unconfirmed'); assert.equal(c.calls.email.length, 1);
  assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: uncertain })).status, 409); assert.equal(c.calls.email.length, 1);
  const command = c.app.store.db.prepare('SELECT state,attempts FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(tenant.id, uncertain.idempotencyKey); assert.deepEqual({ ...command }, { state: 'unknown', attempts: 1 });
});

test('HTTP email: fresh admin after asynchronous secret write and adapter close before Store.close', async t => {
  const c = await fixture(t), tenant = await c.tenant('Email lifecycle company'), channel = await c.channel(tenant.id, 'email');
  const gate = barrier(); c.control.secretWriteGate = gate;
  const configuring = c.request(c.configurationPath(tenant.id, channel.id), { method: 'POST', cookie: c.owner.cookie, body: { version: 0, address: 'support@example.test', ingressSecret: relaySecret } });
  await gate.entered.promise; assert.equal((await c.request('/api/auth/logout', { method: 'POST', cookie: c.owner.cookie, body: {} })).status, 200); gate.release.resolve();
  assert.equal((await configuring).status, 401); assert.equal(c.state(tenant.id).channels.find(item => item.id === channel.id).email, undefined);
  const orphan = c.app.store.db.prepare('SELECT payload FROM channel_secrets').get(); assert.ok(orphan); assert.equal(Buffer.from(orphan.payload).includes(Buffer.from(relaySecret)), false);
  const session = c.app.auth.session(c.app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(c.owner.id)); c.owner.cookie = 'mep_session=' + session.token;
  const status = await c.request(c.configurationPath(tenant.id, channel.id), { cookie: c.owner.cookie }); assert.equal(status.status, 200); assert.equal(status.data.version, 0); assert.equal(status.data.enabled, false); assert.equal(status.data.ingressConfigured, false); assertPrivate(status);
  await c.configure(tenant.id, channel.id, { version: 0, address: 'support@example.test', ingressSecret: relaySecret });
  assert.equal((await c.emailWebhook(tenant.id, channel.id, { id: 'email-close-http', from: 'contact@example.test', to: 'support@example.test', subject: 'Encerramento', text: 'Entrada sintética.' })).status, 200);
  const alice = c.member([tenant.id]), current = await c.claim(tenant.id, c.conversation(tenant.id, channel.id), alice), providerGate = barrier();
  c.control.emailMode = 'until-close'; c.control.emailProviderGate = providerGate;
  const sending = c.request(`/api/tenants/${tenant.id}/conversations/${current.id}/messages`, { method: 'POST', cookie: alice.cookie, body: { version: current.version, channelId: channel.id, text: 'Enviar até close abortar.', idempotencyKey: randomUUID() } });
  await providerGate.entered.promise; await c.app.emailChannel.close();
  assert.equal(c.app.emailChannel.tasks.size, 0); assert.equal((await sending).status, 502);
  assert.equal(c.conversation(tenant.id, channel.id).messages.at(-1).delivery, 'unconfirmed'); assert.equal(c.calls.email[0].input.signal.aborted, true);
  assert.equal(c.app.store.db.prepare('SELECT count(*) AS count FROM tenants').get().count > 0, true);
});

for (const kind of ['messenger', 'instagram']) {
  test(`HTTP ${kind}: raw signature, scoped binding, atomic batch rollback and provider receipt`, async t => {
    const c = await fixture(t), first = await c.tenant(kind + ' company A'), second = await c.tenant(kind + ' company B');
    const a = await c.channel(first.id, kind), b = await c.channel(second.id, kind), alice = c.member([first.id]), bob = c.member([second.id]);
    const resourceId = '123456789001', resourceB = '123456789002', senderId = '987654321001';
    const configure = (tenantId, item, resource) => c.configure(tenantId, item.id, { version: 0, apiVersion: 'v23.0', resourceId: resource, enabled: true, ...metaCredentials });
    const configured = await configure(first.id, a, resourceId); assert.equal(configured.kind, kind); assert.equal(configured.enabled, true); assert.equal(configured.state, 'configured'); assert.equal(configured.mediaSupported, kind==='messenger');
    assert.equal(configured.webhookUrl, `${c.base}/api/webhooks/meta/${first.id}/${a.id}`);
    const status = await c.request(c.configurationPath(first.id, a.id), { cookie: c.owner.cookie }); assert.equal(status.status, 200); assertPrivate(status);
    assert.equal((await c.request(c.configurationPath(second.id, b.id), { method: 'POST', cookie: c.owner.cookie, body: { version: 0, apiVersion: 'v23.0', resourceId, ...metaCredentials } })).status, 409);
    assert.equal(c.state(second.id).channels.find(item => item.id === b.id).meta, undefined); assert.equal(c.app.store.db.prepare('SELECT count(*) AS count FROM meta_channel_bindings').get().count, 1);
    await configure(second.id, b, resourceB);
    const verifyPath = `/api/webhooks/meta/${first.id}/${a.id}?` + new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': metaCredentials.verifyToken, 'hub.challenge': '120034' });
    const verify = await c.request(verifyPath); assert.equal(verify.status, 200); assert.equal(verify.text, '120034'); assert.match(verify.headers['content-type'], /text\/plain/);
    assert.equal((await c.request(verifyPath.replace(metaCredentials.verifyToken, 'invalid-verify-token'))).status, 403);
    const event = { sender: { id: senderId }, recipient: { id: resourceId }, timestamp: c.control.now, message: { mid: 'shared-provider-message', text: 'Entrada social sintética.' } };
    const payload = events => ({ object: kind === 'messenger' ? 'page' : 'instagram', entry: [{ id: resourceId, messaging: events }] });
    const body = payload([event]), raw = JSON.stringify(body, null, 2), signature = 'sha256=' + createHmac('sha256', metaCredentials.appSecret).update(raw).digest('hex');
    assert.equal((await c.metaWebhook(first.id, a.id, body, { raw: JSON.stringify(body), signature })).status, 403);
    const incoming = await c.metaWebhook(first.id, a.id, body, { raw }); assert.equal(incoming.status, 200); assert.equal(incoming.data.received, 1); assert.equal(incoming.data.replayed, 0);
    assert.equal((await c.metaWebhook(first.id, a.id, body)).data.replayed, 1);
    assert.equal((await c.metaWebhook(first.id, a.id, payload([{ ...event, message: { ...event.message, text: 'Alteração no mesmo ID' } }]))).status, 409);
    assert.equal((await c.metaWebhook(second.id, b.id, body)).status, 403);
    const otherEvent = { ...event, recipient: { id: resourceB } }, otherBody = { object: body.object, entry: [{ id: resourceB, messaging: [otherEvent] }] };
    assert.equal((await c.metaWebhook(second.id, b.id, otherBody)).status, 200);
    const before = JSON.stringify(c.state(first.id)), receiptCount = c.app.store.db.prepare('SELECT count(*) AS count FROM meta_inbound_receipts').get().count;
    const atomicBatch = payload([{ ...event, message: { mid: 'must-rollback-mid', text: 'Não pode persistir parcialmente.' } }, { ...event, recipient: { id: resourceB }, message: { mid: 'bad-recipient-mid', text: 'Origem indevida.' } }]);
    assert.equal((await c.metaWebhook(first.id, a.id, atomicBatch)).status, 403);
    assert.equal(JSON.stringify(c.state(first.id)), before); assert.equal(c.app.store.db.prepare('SELECT count(*) AS count FROM meta_inbound_receipts').get().count, receiptCount);
    assert.equal(c.app.store.db.prepare('SELECT count(*) AS count FROM meta_inbound_receipts WHERE provider_message_id=?').get('must-rollback-mid').count, 0);
    let current = await c.claim(first.id, c.conversation(first.id, a.id), alice);
    const route = `/api/tenants/${first.id}/conversations/${current.id}/messages`, input = { version: current.version, channelId: a.id, text: 'Resposta social sintética.', attachmentIds: [], idempotencyKey: randomUUID() };
    assert.equal((await c.request(route, { method: 'POST', cookie: bob.cookie, body: input })).status, 403);
    const sent = await c.request(route, { method: 'POST', cookie: alice.cookie, body: input }); assert.equal(sent.status, 200, sent.data?.error); assert.equal(sent.data.messages.at(-1).delivery, 'sent'); assertPrivate(sent);
    assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: input })).status, 200); assert.equal(c.calls.meta.length, 1);
    const delivery = c.calls.meta[0]; assert.equal(delivery.url, `https://${kind === 'messenger' ? 'graph.facebook.com' : 'graph.instagram.com'}/v23.0/${resourceId}/messages`); assert.equal(delivery.input.redirect, 'error');
    const outgoing = JSON.parse(delivery.input.body); assert.deepEqual(outgoing.recipient, { id: senderId }); assert.deepEqual(outgoing.message, { text: input.text }); assert.equal(outgoing.messaging_type, kind === 'messenger' ? 'RESPONSE' : undefined);
    current = c.conversation(first.id, a.id); c.control.metaMode = 'uncertain';
    const uncertain = { version: current.version, channelId: a.id, text: 'Resposta social sem confirmação.', idempotencyKey: randomUUID() };
    assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: uncertain })).status, 502);
    assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: uncertain })).status, 409); assert.equal(c.calls.meta.length, 2);
    assert.equal(c.conversation(first.id, a.id).messages.at(-1).delivery, 'unconfirmed');
    c.control.now += 24 * 3600_000; current = c.conversation(first.id, a.id);
    assert.equal((await c.request(route, { method: 'POST', cookie: alice.cookie, body: { version: current.version, channelId: a.id, text: 'Janela encerrada', idempotencyKey: randomUUID() } })).status, 409); assert.equal(c.calls.meta.length, 2);
  });
}
