// Signed webhook push of service event pointers and the channel default agent, through the real HTTP app.
// createApp with in-memory SQLite, the webchat transport as the synthetic channel and a fake HTTPS receiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.js';
import { pinnedWebhookPost, webhookUrl } from '../src/service-webhooks.js';

const origin = 'https://loja.example.test', receiver = 'https://produto.example.com/api/elozi/webhook';
const status = expected => error => error.status === expected;
const until = async (predicate, ms = 3000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'condição esperada não chegou'); };

async function fixture(t, { replies = [], webhookOptions = {} } = {}) {
  const key = Buffer.alloc(32, 53), external = [], posts = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio de webhook'); };
  const post = async (url, headers, body) => { posts.push({ url, headers, body }); return typeof replies === 'function' ? replies({ url, headers, body }) : replies.length ? replies.shift() : { status: 200 }; };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny },
    webhookOptions: { post, flushMs: 30, pollMs: 60000, backoffMs: [0, 0], ...webhookOptions } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '', token } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString() || 'null'), cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); } });
    });
    pending.on('error', reject); pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'webhook.owner', password: 'Senha-sintetica-' + randomUUID() } });
  assert.equal(owner.status, 200);
  const admin = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant = (await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Loja do webhook', segment: 'Varejo' } })).data;
  app.store.mutate(admin, tenant.id, 'Fixture do webhook', state => {
    state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }, { id: 'other', kind: 'webchat', name: 'Outro site', state: 'planned' },
      { id: 'wa', kind: 'whatsapp_qr', name: 'WhatsApp', transport: 'baileys', state: 'disconnected' }];
    state.departments = [];
    state.agents = [{ id: 'sellers', name: 'Agente dos sellers', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'admin', name: 'Agente admin', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'hermes-1', name: 'Hermes', provider: 'hermes', mode: 'copilot', configured: true, version: 1, tools: [] }];
  });
  for (const channelId of ['site', 'other']) app.webchat.configure(admin, tenant.id, channelId, { version: 0, origins: [origin] });
  const principal = (agentId, capabilities = ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'], channelIds = ['site']) => {
    const created = app.servicePrincipals.create(admin, tenant.id, { name: `Serviço ${agentId}`, agentId, capabilities, channelIds, departmentIds: null, dailyRequests: 100, maxConcurrent: 2, ttlHours: 24 });
    return { ...created, actor: app.servicePrincipals.authenticate('Bearer ' + created.token) };
  };
  let counter = 0;
  const visit = async (channelId = 'site') => {
    const challenge = app.webchat.challenge({ tenantId: tenant.id, channelId, origin });
    const session = app.webchat.openSession({ tenantId: tenant.id, channelId, origin, challenge: challenge.challenge, name: 'Visitante' });
    await app.webchat.receive({ token: session.token, text: 'Mensagem privada do cliente', clientMessageId: `webhook-visitor-msg-${String(++counter).padStart(4, '0')}`, origin });
  };
  const hook = principalId => `/api/tenants/${tenant.id}/service-principals/${principalId}/webhook`;
  t.after(async () => {
    await app.serviceWebhooks.close(); await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); app.store.close();
  });
  // The poll timer is disabled in the fixture: drive due retries explicitly until the condition holds.
  const drainUntil = async predicate => { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) { await app.serviceWebhooks.drain(); await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate(), 'entrega esperada não chegou'); };
  return { app, admin, tenant, owner, request, principal, visit, posts, hook, drainUntil, deliveries: () => app.store.db.prepare('SELECT id,state,attempts,last_status FROM service_webhook_deliveries ORDER BY created_at').all() };
}

function conversations(f, values) {
  f.app.store.mutate(f.admin, f.tenant.id, 'Atendimentos sintéticos do backlog', state => {
    state.conversations.push(...values.map(value => ({ channelId: 'site', departmentId: null, owner: 'queue', status: 'open', version: 1, conversationKind: 'direct', messages: [], ...value })));
  });
}

function queuedPointer(f, principal, conversationId, { at = Date.now(), nextAt = at } = {}) {
  const conversation = f.app.store.tenant(f.admin, f.tenant.id).conversations.find(value => value.id === conversationId);
  const deliveryId = 'whd_' + randomUUID().replaceAll('-', '');
  const event = f.app.serviceApi.eventDTO(principal.actor, { ...conversation, conversationId, tenantId: f.tenant.id, type: 'conversation.message', at: new Date(at).toISOString(), messageId: 'synthetic-message', kind: 'customer' });
  const body = JSON.stringify({ schemaVersion: 1, type: 'elozi.service.events', deliveryId, principalId: principal.principal.id, tenantId: f.tenant.id, createdAt: new Date(at).toISOString(), events: [event] });
  f.app.store.db.prepare("INSERT INTO service_webhook_deliveries (id,principal_id,tenant_id,body,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'pending',0,?,?,?)").run(deliveryId, principal.principal.id, f.tenant.id, body, nextAt, at, at);
  return { id: deliveryId, body };
}

test('URL do webhook: só HTTPS público, sem credenciais, porta, query ou fragmento', () => {
  assert.equal(webhookUrl(receiver), receiver);
  for (const value of ['http://produto.example.com/x', 'https://user:pw@produto.example.com/x', 'https://produto.example.com:8443/x', 'https://produto.example.com/x?a=1',
    'https://produto.example.com/x#f', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://servico.localhost/x', 'https://painel.internal/x', 'ftp://produto.example.com/x', 'nada'])
    assert.throws(() => webhookUrl(value), status(400), value);
});

test('envio fixa DNS público e recusa endereço privado antes de conectar', async () => {
  let connected = 0;
  const privateDns = pinnedWebhookPost({ lookupImpl: async () => [{ address: '10.1.2.3', family: 4 }], requestImpl: () => { connected++; } });
  assert.deepEqual(await privateDns(receiver, {}, '{}'), { status: 0, error: 'address-not-public' }); assert.equal(connected, 0);
  let options;
  const publicDns = pinnedWebhookPost({ lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl: (url, value, onResponse) => {
    options = value; const handlers = {};
    const response = { statusCode: 204, on: (name, fn) => { handlers[name] = fn; return response; }, destroy() {} };
    return { on() {}, end() { onResponse(response); handlers.end?.(); } };
  } });
  assert.equal((await publicDns(receiver, { 'X-Test': '1' }, '{"a":1}')).status, 204);
  await new Promise(resolve => options.lookup('produto.example.com', { all: true }, (error, records) => { assert.deepEqual(records, [{ address: '93.184.216.34', family: 4 }]); resolve(); }));
  assert.equal(options.headers['Content-Length'], 7); assert.equal(options.method, 'POST');
});

test('envio revalida a autorização depois do DNS antes de conectar', async () => {
  let allowed = true, connected = 0;
  const post = pinnedWebhookPost({ lookupImpl: async () => { allowed = false; return [{ address: '93.184.216.34', family: 4 }]; }, requestImpl: (_url, _options, onResponse) => {
    connected++; const handlers = {}, response = { statusCode: 204, on(name, fn) { handlers[name] = fn; return this; } };
    return { on() {}, end() { onResponse(response); handlers.end(); } };
  } });
  assert.deepEqual(await post(receiver, {}, '{}', { reauthorize: () => allowed }), { status: 0, error: 'authorization' });
  assert.equal(connected, 0, 'nenhuma conexão após a perda de autorização durante o DNS');
});

test('prazo total limita DNS e nunca abre uma conexão quando a resolução chega tarde', async () => {
  let resolveDns, connected = 0;
  const post = pinnedWebhookPost({ timeoutMs: 30, lookupImpl: () => new Promise(resolve => { resolveDns = resolve; }), requestImpl: () => { connected++; } });
  assert.deepEqual(await post(receiver, {}, '{}'), { status: 0, error: 'timeout' });
  resolveDns([{ address: '93.184.216.34', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connected, 0, 'a resolução tardia não executa o POST depois de o prazo encerrar');
});

test('prazo total encerra conexão sem resposta e resposta que mantém dados chegando', async t => {
  for (const streaming of [false, true]) await t.test(streaming ? 'resposta contínua' : 'conexão sem resposta', async t => {
    let destroyed = 0, stream;
    const post = pinnedWebhookPost({ timeoutMs: 40, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl: (_url, _options, onResponse) => {
      const request = new EventEmitter();
      request.destroy = () => { destroyed++; };
      request.end = () => {
        if (!streaming) return;
        const response = new EventEmitter(); response.statusCode = 200; response.destroy = () => { clearInterval(stream); response.emit('close'); };
        onResponse(response); stream = setInterval(() => response.emit('data', Buffer.from('x')), 3);
      };
      return request;
    } });
    t.after(() => clearInterval(stream));
    assert.deepEqual(await post(receiver, {}, '{}'), { status: 0, error: 'timeout' });
    assert.equal(destroyed, 1, 'o request é encerrado mesmo sem timeout de inatividade do socket');
  });
});

test('resposta acima do limite nunca é aceita como 2xx pelo evento close', async () => {
  const post = pinnedWebhookPost({ lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl: (_url, _options, onResponse) => {
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter(); response.statusCode = 200; response.destroy = () => response.emit('close');
      onResponse(response); response.emit('data', Buffer.alloc(4097));
    };
    return request;
  } });
  assert.deepEqual(await post(receiver, {}, '{}'), { status: 0, error: 'response-size' });
});

test('configuração pelo administrador: segredo fornecido nunca volta, gerado volta uma vez, CAS e events.read obrigatórios', async t => {
  const f = await fixture(t), sellers = f.principal('sellers'), reader = f.principal('admin', ['conversation.read']);
  const provided = 'a'.repeat(64);
  const created = await f.request(f.hook(sellers.principal.id), { method: 'PUT', cookie: f.owner.cookie, body: { url: receiver, enabled: false, revision: 0, secret: provided } });
  assert.equal(created.status, 200, JSON.stringify(created.data)); assert.equal(created.data.secret, undefined);
  assert.equal(created.data.webhook.secretFingerprint, createHash('sha256').update(provided).digest('hex').slice(0, 12)); assert.equal(created.data.webhook.enabled, false);
  assert.equal((await f.request(f.hook(sellers.principal.id), { method: 'PUT', cookie: f.owner.cookie, body: { url: receiver, enabled: true, revision: 0 } })).status, 409, 'stale revision');
  assert.equal((await f.request(f.hook(reader.principal.id), { method: 'PUT', cookie: f.owner.cookie, body: { url: receiver, revision: 0 } })).status, 409, 'needs events.read');
  assert.equal((await f.request(f.hook(sellers.principal.id), { method: 'PUT', body: { url: receiver, revision: 1 } })).status, 401);
  const rotated = await f.request(f.hook(sellers.principal.id) + '/rotate', { method: 'POST', cookie: f.owner.cookie, body: { revision: 1 } });
  assert.equal(rotated.status, 200); assert.match(rotated.data.secret, /^elozi_whsec_/); assert.equal(rotated.data.webhook.revision, 2);
  const read = await f.request(f.hook(sellers.principal.id), { cookie: f.owner.cookie });
  assert.equal(JSON.stringify(read.data).includes(rotated.data.secret), false); assert.equal(JSON.stringify(read.data).includes(provided), false);
  const me = await f.request('/api/service/v1/me', { token: sellers.token });
  assert.deepEqual([me.data.webhook.configured, me.data.webhook.url], [true, 'https://produto.example.com']);
});

test('entrega assinada: ponteiros sem conteúdo, HMAC verificável, mesma deliveryId nas tentativas e escopo da identidade', async t => {
  const f = await fixture(t, { replies: [{ status: 500 }, { status: 202 }] }), sellers = f.principal('sellers'), secret = 'b'.repeat(64);
  assert.equal((await f.request(f.hook(sellers.principal.id), { method: 'PUT', cookie: f.owner.cookie, body: { url: receiver, enabled: true, revision: 0, secret } })).status, 200);
  await f.visit('other');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.posts.length, 0, 'a channel outside the identity scope sends nothing');
  await f.visit('site');
  await until(() => f.posts.length >= 1);
  await f.drainUntil(() => f.posts.length >= 2);
  const [first, second] = f.posts, body = JSON.parse(second.body);
  assert.equal(first.headers['Idempotency-Key'], second.headers['Idempotency-Key'], 'retry keeps the deliveryId');
  assert.equal(first.body, second.body, 'retry keeps the exact signed payload');
  assert.equal(second.url, receiver); assert.equal(body.type, 'elozi.service.events'); assert.equal(body.deliveryId, second.headers['Idempotency-Key']);
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${second.headers['X-Elozi-Timestamp']}.${body.deliveryId}.${second.body}`).digest('hex');
  assert.equal(second.headers['X-Elozi-Signature'], expected);
  assert.ok(body.events.length >= 1); assert.ok(body.events.every(event => event.channelId === 'site'));
  assert.equal(second.body.includes('Mensagem privada do cliente'), false); assert.equal(second.body.includes('Visitante'), false);
  assert.deepEqual(f.deliveries().map(row => [row.state, row.attempts]), [['delivered', 2]]);
  const me = await f.request('/api/service/v1/me', { token: sellers.token });
  assert.equal(me.data.webhook.lastStatus, 202); assert.equal(me.data.webhook.failures, 0);
});

test('backlog anterior à redução de canal, departamento ou agente é cancelado intacto e substituído só por resync', async t => {
  for (const kind of ['canal', 'departamento', 'agente']) await t.test(kind, async t => {
    const f = await fixture(t);
    f.app.store.mutate(f.admin, f.tenant.id, 'Departamentos sintéticos', state => {
      state.departments = [{ id: 'sac', name: 'SAC', active: true }, { id: 'sales', name: 'Vendas', active: true }];
    });
    conversations(f, [{ id: 'backlog-conversation', departmentId: kind === 'departamento' ? 'sac' : null, ...(kind === 'agente' ? { owner: 'agent', agentId: 'sellers' } : {}) }]);
    const sellers = f.principal('sellers', undefined, ['site', 'other']);
    await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, sellers.principal.id, { url: receiver, revision: 0, secret: 'f'.repeat(64) });
    const original = queuedPointer(f, sellers, 'backlog-conversation');
    f.app.servicePrincipals.update(f.admin, f.tenant.id, sellers.principal.id, { revision: 1,
      ...(kind === 'canal' ? { channelIds: ['other'] } : kind === 'departamento' ? { departmentIds: ['sales'] } : { agentId: 'admin' }) });
    await f.app.serviceWebhooks.drain();
    await f.drainUntil(() => f.posts.length > 0);
    const old = f.app.store.db.prepare('SELECT state,attempts,body FROM service_webhook_deliveries WHERE id=?').get(original.id);
    assert.deepEqual([old.state, old.attempts, old.body], ['cancelled', 0, original.body]);
    assert.ok(f.posts.every(post => { const body = JSON.parse(post.body); return body.deliveryId !== original.id && body.resync === true && body.events.length === 0; }), 'nenhum ponteiro do escopo antigo é divulgado');
  });
});

test('adaptador desconfigurado cancela backlog sem POST nem ciclo infinito de resync', async t => {
  const f = await fixture(t);
  conversations(f, [{ id: 'disabled-adapter-conversation' }]);
  const sellers = f.principal('sellers');
  await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, sellers.principal.id, { url: receiver, revision: 0, secret: 'd'.repeat(64) });
  const original = queuedPointer(f, sellers, 'disabled-adapter-conversation');
  f.app.store.mutate(f.admin, f.tenant.id, 'Desconfiguração sintética', state => { state.agents.find(agent => agent.id === 'sellers').configured = false; });
  for (let i = 0; i < 4; i++) await f.app.serviceWebhooks.drain();
  assert.equal(f.posts.length, 0);
  assert.equal(f.app.store.db.prepare('SELECT state FROM service_webhook_deliveries WHERE id=?').get(original.id).state, 'cancelled');
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM service_webhook_deliveries WHERE principal_id=?').get(sellers.principal.id).n, 1);
});

test('muitas entregas de uma identidade não escondem a cabeça da fila de outra', async t => {
  const f = await fixture(t, { webhookOptions: { concurrency: 2 } });
  conversations(f, [{ id: 'busy-conversation' }, { id: 'other-conversation' }]);
  const busy = f.principal('sellers'), other = f.principal('admin');
  for (const principal of [busy, other]) await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, principal.principal.id, { url: receiver, revision: 0, secret: 'g'.repeat(64) });
  for (let index = 0; index < 40; index++) queuedPointer(f, busy, 'busy-conversation');
  const otherDelivery = queuedPointer(f, other, 'other-conversation');
  await f.app.serviceWebhooks.drain();
  const otherIndex = f.posts.findIndex(post => JSON.parse(post.body).deliveryId === otherDelivery.id);
  assert.ok(otherIndex >= 0 && otherIndex <= 1, 'a outra identidade é atendida na primeira admissão, mesmo após 40 linhas da primeira');
});

test('destino lento não bloqueia outro e a mesma identidade nunca envia em paralelo', async t => {
  let slowId, release, active = 0, peak = 0;
  const blocked = new Promise(resolve => { release = resolve; }), perIdentity = new Map(), peaks = new Map();
  const f = await fixture(t, { webhookOptions: { concurrency: 2 }, replies: async ({ body }) => {
    const identity = JSON.parse(body).principalId;
    active++; peak = Math.max(peak, active); perIdentity.set(identity, (perIdentity.get(identity) || 0) + 1); peaks.set(identity, Math.max(peaks.get(identity) || 0, perIdentity.get(identity)));
    try { if (identity === slowId) await blocked; return { status: 200 }; }
    finally { active--; perIdentity.set(identity, perIdentity.get(identity) - 1); }
  } });
  conversations(f, [{ id: 'slow-conversation' }, { id: 'fast-conversation' }]);
  const slow = f.principal('sellers'), fast = f.principal('admin'); slowId = slow.principal.id;
  for (const principal of [slow, fast]) await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, principal.principal.id, { url: receiver, revision: 0, secret: 'h'.repeat(64) });
  const first = queuedPointer(f, slow, 'slow-conversation'), second = queuedPointer(f, slow, 'slow-conversation'), quick = queuedPointer(f, fast, 'fast-conversation');
  const passes = [f.app.serviceWebhooks.drain(), f.app.serviceWebhooks.drain()];
  try {
    await until(() => f.deliveries().some(row => row.id === quick.id && row.state === 'delivered'));
    assert.equal(f.posts.filter(post => JSON.parse(post.body).principalId === slowId).length, 1, 'o segundo lote da identidade lenta espera o primeiro');
    assert.equal(peak, 2); assert.ok([...peaks.values()].every(value => value === 1));
  } finally { release(); await Promise.all(passes); }
  await f.drainUntil(() => f.deliveries().every(row => row.state === 'delivered'));
  assert.deepEqual(f.posts.filter(post => JSON.parse(post.body).principalId === slowId).map(post => JSON.parse(post.body).deliveryId), [first.id, second.id]);
});

test('limite global de concorrência permanece válido quando várias drenagens se sobrepõem', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { webhookOptions: { concurrency: 2 }, replies: async () => { await gate; return { status: 200 }; } });
  conversations(f, [{ id: 'concurrency-conversation' }]);
  for (let index = 0; index < 3; index++) {
    const principal = f.principal('sellers');
    await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, principal.principal.id, { url: receiver, revision: 0, secret: 'i'.repeat(64) });
    queuedPointer(f, principal, 'concurrency-conversation');
  }
  const passes = [f.app.serviceWebhooks.drain(), f.app.serviceWebhooks.drain(), f.app.serviceWebhooks.drain()];
  try { await until(() => f.posts.length >= 2); assert.equal(f.posts.length, 2); assert.equal(f.app.serviceWebhooks.active.size, 2); }
  finally { release(); await Promise.all(passes); }
  await f.drainUntil(() => f.deliveries().every(row => row.state === 'delivered'));
  assert.equal(f.posts.length, 3);
});

test('retry da cabeça mantém ordem, deliveryId e body antes de liberar o lote seguinte', async t => {
  let clock = Date.now();
  const f = await fixture(t, { webhookOptions: { now: () => clock, backoffMs: [1000] }, replies: [{ status: 503 }, { status: 200 }, { status: 200 }] });
  conversations(f, [{ id: 'fifo-conversation' }]);
  const principal = f.principal('sellers');
  await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, principal.principal.id, { url: receiver, revision: 0, secret: 'j'.repeat(64) });
  const first = queuedPointer(f, principal, 'fifo-conversation', { at: clock }), second = queuedPointer(f, principal, 'fifo-conversation', { at: clock + 1, nextAt: clock });
  await f.app.serviceWebhooks.drain(); await f.app.serviceWebhooks.drain();
  assert.equal(f.posts.length, 1, 'lote posterior já elegível não ultrapassa a cabeça em backoff');
  clock += 1000;
  await f.drainUntil(() => f.deliveries().every(row => row.state === 'delivered'));
  assert.deepEqual(f.posts.map(post => JSON.parse(post.body).deliveryId), [first.id, first.id, second.id]);
  assert.equal(f.posts[0].body, f.posts[1].body);
});

test('falhas esgotadas viram resync na próxima entrega; revogação cancela pendentes sem enviar', async t => {
  let failing = true;
  const f = await fixture(t, { replies: () => ({ status: failing ? 503 : 200 }) }), sellers = f.principal('sellers');
  await f.request(f.hook(sellers.principal.id), { method: 'PUT', cookie: f.owner.cookie, body: { url: receiver, enabled: true, revision: 0, secret: 'c'.repeat(64) } });
  await f.visit('site'); await until(() => f.posts.length >= 1);
  await f.drainUntil(() => f.deliveries().length > 0 && f.deliveries().every(row => row.state === 'abandoned'));
  assert.ok(f.deliveries().every(row => row.attempts === 3), 'one attempt plus two retries');
  failing = false; const before = f.posts.length;
  await f.visit('site'); await f.drainUntil(() => f.posts.length > before && f.deliveries().some(row => row.state === 'delivered'));
  assert.equal(JSON.parse(f.posts[before].body).resync, true, 'abandoned pointers are replaced by an explicit resync');
  await f.drainUntil(() => f.deliveries().every(row => row.state !== 'pending'));
  f.app.servicePrincipals.revoke(f.admin, f.tenant.id, sellers.principal.id, { revision: 1 });
  const sent = f.posts.length;
  await f.visit('site'); await new Promise(resolve => setTimeout(resolve, 80)); await f.app.serviceWebhooks.drain();
  assert.equal(f.posts.length, sent, 'a revoked identity receives nothing');
});

test('mudança de autorização durante a leitura do segredo impede o POST antigo', async t => {
  const changes = [
    ['revogação', (f, id) => f.app.servicePrincipals.revoke(f.admin, f.tenant.id, id, { revision: 1 })],
    ['redução de canais', (f, id) => f.app.servicePrincipals.update(f.admin, f.tenant.id, id, { revision: 1, channelIds: ['other'] })],
    ['troca do destino', (f, id) => f.app.serviceWebhooks.configure(f.admin, f.tenant.id, id, { revision: 1, url: 'https://outro.example.com/elozi' })],
    ['webhook desativado', (f, id) => f.app.serviceWebhooks.configure(f.admin, f.tenant.id, id, { revision: 1, enabled: false })]
  ];
  for (const [name, change] of changes) await t.test(name, async t => {
    const f = await fixture(t), sellers = f.principal('sellers');
    await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, sellers.principal.id, { url: receiver, revision: 0, secret: 'd'.repeat(64) });
    const loadSecrets = f.app.serviceWebhooks.loadSecrets;
    let entered, resume;
    const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; });
    f.app.serviceWebhooks.loadSecrets = async () => { entered(); await gate; return loadSecrets(); };
    await f.visit('site'); await waiting;
    try { await change(f, sellers.principal.id); }
    finally { resume(); }
    await f.app.serviceWebhooks.drain();
    assert.ok(f.posts.every(post => JSON.parse(post.body).resync === true && JSON.parse(post.body).events.length === 0), 'a alteração impede o lote antigo; somente resync sem ponteiros pode sair');
    assert.equal(f.deliveries()[0].state, 'cancelled');
  });
});

test('mudança de configuração durante o DNS cancela a entrega sem registrar uma tentativa HTTP', async t => {
  const f = await fixture(t), sellers = f.principal('sellers');
  await f.app.serviceWebhooks.configure(f.admin, f.tenant.id, sellers.principal.id, { url: receiver, revision: 0, secret: 'e'.repeat(64) });
  const post = f.app.serviceWebhooks.post;
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  f.app.serviceWebhooks.post = async (url, headers, body, { reauthorize }) => {
    entered(); await gate;
    return reauthorize() ? post(url, headers, body) : { status: 0, error: 'authorization' };
  };
  await f.visit('site'); await waiting;
  try { f.app.servicePrincipals.rotate(f.admin, f.tenant.id, sellers.principal.id, { revision: 1 }); }
  finally { resume(); }
  await f.app.serviceWebhooks.drain();
  assert.ok(f.posts.every(post => JSON.parse(post.body).resync === true && JSON.parse(post.body).events.length === 0), 'a configuração antiga não pode abrir o POST');
  assert.deepEqual([f.deliveries()[0].state, f.deliveries()[0].attempts], ['cancelled', 0]);
  assert.ok(f.deliveries().some(row => row.id !== f.deliveries()[0].id), 'a configuração atual recebe um novo marcador seguro');
});

test('agente padrão do canal: rota administrativa aceita só WhatsApp QR e agente MCP copiloto configurado', async t => {
  const f = await fixture(t), path = `/api/tenants/${f.tenant.id}/channels`;
  const set = (channelId, agentId, cookie = f.owner.cookie) => f.request(`${path}/${channelId}/default-agent`, { method: 'POST', cookie, body: { agentId } });
  const ok = await set('wa', 'sellers');
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.deepEqual(ok.data, { channelId: 'wa', defaultAgentId: 'sellers' });
  assert.equal(f.app.store.tenant(f.admin, f.tenant.id).channels.find(item => item.id === 'wa').defaultAgentId, 'sellers');
  assert.equal((await set('site', 'sellers')).status, 400, 'webchat');
  assert.equal((await set('wa', 'hermes-1')).status, 409); assert.equal((await set('wa', 'nao-existe')).status, 409);
  assert.equal((await set('nao-existe', 'sellers')).status, 404); assert.equal((await set('wa', 'sellers', '')).status, 401);
  assert.deepEqual((await set('wa', null)).data, { channelId: 'wa', defaultAgentId: null });
  assert.equal(f.app.store.tenant(f.admin, f.tenant.id).channels.find(item => item.id === 'wa').defaultAgentId, undefined);
});
