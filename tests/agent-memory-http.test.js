import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { syncConversationContact } from '../src/contacts.js';

const secret = () => 'Memory-synthetic-' + randomBytes(12).toString('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const permissions = ['inbox.read', 'inbox.reply', 'inbox.transfer', 'contacts.read', 'contacts.write'];

async function fixture(t, provider = async () => 'Rascunho sintético, somente para revisão.') {
  const key = randomBytes(32), external = [], calls = [];
  const deny = async () => { external.push(true); throw Error('Transporte externo proibido na fixture RAM.'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, allowRegistration: false,
    providerCall: context => { calls.push(context); return provider(context); }, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny, downloadMediaImpl: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    webchatOptions: {}, metaOptions: { fetchImpl: deny, mediaDownloader: deny },
    googleOptions: { clientId: '', jwks: deny }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny },
    emailChannelOptions: { fetchImpl: deny }, mediaOptions: { directory: null, authKey: key } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const controller of app.runtime.controllers.values()) controller.abort();
    await turn(); await app.scheduled.waitIdle();
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.gateway.close(), app.telegram.close(), app.meta.close(), app.email.close(), app.emailChannel.close(), app.webchat.close(), app.bridge.close()]);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM outbound_commands').get().n, 0);
    app.store.close(); assert.deepEqual(external, []);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie = '', origin = base, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Administrador RAM memória', username: 'memory-owner', password: secret() } });
  assert.equal(setup.status, 200);
  const owner = { cookie: setup.cookie }, actor = app.auth.resolveActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  owner.id = actor.userId;
  const own = (path, options = {}) => request(path, { ...options, cookie: owner.cookie });
  const tenant = await own('/api/tenants', { method: 'POST', body: { name: 'Memória HTTP RAM', segment: 'QA' } });
  assert.equal(tenant.status, 201);
  const tenantId = tenant.data.id, path = `/api/tenants/${tenantId}`, agentId = 'memory-hermes', channelId = 'memory-web-a';
  const seed = id => app.store.mutate(actor, id, 'Fixture RAM de memória', state => {
    state.channels = [{ id: channelId, kind: 'webchat', transport: 'elozi-webchat' }, { id: 'memory-web-b', kind: 'webchat', transport: 'elozi-webchat' }];
    state.departments = [{ id: 'support', name: 'Suporte RAM', active: true }, { id: 'sales', name: 'Comercial RAM', active: true }];
    state.agents = [{ id: agentId, name: 'Hermes RAM', provider: 'hermes', mode: 'copilot', configured: true, version: 1 }];
  });
  seed(tenantId);
  let userSequence = 0, conversationSequence = 0;
  const member = async (extra = {}) => {
    const username = 'memory-member-' + ++userSequence, password = secret();
    const result = await own('/api/users', { method: 'POST', body: { username, password, name: 'Pessoa RAM ' + userSequence,
      role: 'operator', tenantIds: [tenantId], permissions, ...extra } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const login = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(login.status, 200);
    app.store.mutate(actor, tenantId, 'Fixture RAM de membresia do departamento', state => {
      for (const department of state.departments) department.memberIds = [...(department.memberIds || []), result.data.id];
    });
    return { ...result.data, cookie: login.cookie };
  };
  const state = () => app.store.tenant(actor, tenantId);
  const conversation = (extra = {}) => app.store.mutate(actor, tenantId, 'Fixture RAM de atendimento próprio', data => {
    const sequence = ++conversationSequence, now = new Date().toISOString();
    const value = { id: 'memory-conversation-' + sequence, channelId, departmentId: 'support', department: 'Suporte RAM',
      contact: 'Contato RAM ' + sequence, conversationKind: 'direct', remoteChatId: 'visitor-memory-' + sequence,
      owner: 'queue', assignedUserId: null, assignedUserName: null, agentId: null, status: 'open', version: 1,
      unread: 1, messages: [{ id: 'memory-incoming-' + sequence, kind: 'customer', text: 'Pedido sintético RAM', createdAt: now }], updatedAt: now, ...extra };
    data.conversations.push(value); syncConversationContact(data, value, data.channels.find(channel => channel.id === value.channelId)); return value;
  });
  const current = id => state().conversations.find(item => item.id === id);
  const claim = async (value, user = owner) => {
    const result = await request(`${path}/conversations/${value.id}/owner`, { method: 'POST', cookie: user.cookie, body: { owner: 'human', version: value.version } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  };
  const route = id => `${path}/conversations/${id}/memories`;
  const list = (id, user = owner, selectedAgent = agentId) => request(`${route(id)}?agentId=${encodeURIComponent(selectedAgent)}`, { cookie: user.cookie });
  const create = (id, user = owner, extra = {}) => request(route(id), { method: 'POST', cookie: user.cookie, body: {
    agentId, scope: 'contact', title: 'Preferência RAM', content: 'MEMORY_PRIVATE_RAM: prefira texto breve.',
    expiresAt: null, conversationVersion: current(id).version, reviewed: true, ...extra } });
  const queue = (id, user = owner, extra = {}) => request(`${path}/conversations/${id}/run`, { method: 'POST', cookie: user.cookie,
    body: { agentId, version: current(id).version, ...extra } });
  const runs = (id, user = owner) => request(`${path}/conversations/${id}/runs`, { cookie: user.cookie });
  const waitRun = async (id, runId, user = owner, terminal = run => run.state !== 'running') => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await runs(id, user); assert.equal(result.status, 200);
      const run = result.data.runs.find(item => item.id === runId); if (run && terminal(run)) return run;
      await turn();
    }
    assert.fail('Execução RAM não alcançou estado terminal.');
  };
  return { app, base, request, own, owner, actor, tenantId, path, agentId, channelId, seed, member, state, conversation, current, claim, route, list, create, queue, runs, waitRun, calls };
}

test('HTTP memória revisada possui CAS próprio e fica fora do tenant/DTO geral/projeção', async t => {
  const c = await fixture(t), conversation = await c.claim(c.conversation());
  const before = await c.list(conversation.id); assert.equal(before.status, 200); assert.deepEqual(before.data.items, []);
  const created = await c.create(conversation.id); assert.equal(created.status, 201, JSON.stringify(created.data));
  const memory = created.data; assert.equal(memory.scope, 'contact'); assert.equal(memory.version, 1);
  assert.equal(memory.origin.conversationId, conversation.id); assert.equal(memory.origin.contactId, c.current(conversation.id).contactId);
  const listed = await c.list(conversation.id); assert.equal(listed.data.items[0].content, memory.content);
  const patch = { version: memory.version, conversationVersion: conversation.version, title: 'Preferência revisada RAM', content: 'MEMORY_PRIVATE_RAM_UPDATED', expiresAt: null, reviewed: true };
  const updated = await c.own(`${c.route(conversation.id)}/${memory.id}`, { method: 'PATCH', body: patch }); assert.equal(updated.status, 200); assert.equal(updated.data.version, 2);
  const conflict = await c.own(`${c.route(conversation.id)}/${memory.id}`, { method: 'PATCH', body: patch }); assert.equal(conflict.status, 409);
  assert.equal((await c.list(conversation.id)).data.items.find(item => item.id === memory.id).content, patch.content);
  const raw = JSON.stringify(c.state()), general = await c.own(c.path); assert.equal(general.status, 200);
  for (const privateValue of [memory.id, memory.content, patch.content, patch.title]) {
    assert.equal(raw.includes(privateValue), false); assert.equal(JSON.stringify(general.data).includes(privateValue), false);
  }
  c.app.bridge.enabled = true; c.app.bridge.queue(c.tenantId);
  const spool = c.app.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(c.tenantId).payload;
  for (const privateValue of [memory.id, memory.content, patch.content]) assert.equal(spool.includes(privateValue), false);
  c.app.bridge.enabled = false;
  const archived = await c.own(`${c.route(conversation.id)}/${memory.id}/archive`, { method: 'POST', body: { version: 2, conversationVersion: conversation.version } });
  assert.equal(archived.status, 200); assert.equal(archived.data.status, 'archived'); assert.equal(archived.data.version, 3);
  assert.equal((await c.own(`${c.route(conversation.id)}/${memory.id}/archive`, { method: 'POST', body: { version: 2, conversationVersion: conversation.version } })).status, 409);
});

test('HTTP memória exige revisão, responsável atual e contacts.write; operation exige admin real', async t => {
  const c = await fixture(t), user = await c.member(), other = await c.member();
  const conversation = await c.claim(c.conversation(), user);
  assert.equal((await c.create(conversation.id, user, { reviewed: false })).status, 400);
  assert.equal((await c.create(conversation.id, other)).status, 403);
  assert.equal((await c.create(conversation.id, user, { scope: 'operation' })).status, 403);
  assert.equal((await c.create(conversation.id, user)).status, 201);
  const lackingWrite = await c.member({ permissions: permissions.filter(permission => permission !== 'contacts.write') });
  const owned = await c.claim(c.conversation(), lackingWrite); assert.equal((await c.create(owned.id, lackingWrite)).status, 403);
  const operation = await c.create(conversation.id, c.owner, { scope: 'operation', title: 'Regra da operação RAM', content: 'OPERATION_MEMORY_RAM' });
  assert.equal(operation.status, 201);
  const read = await c.list(conversation.id, user); assert.equal(read.status, 200);
  assert.equal(read.data.canManageOperation, false); assert.equal(read.data.items.some(item => item.id === operation.data.id), true);
});

test('HTTP leitura de memória respeita tenant, canal, departamento, origem e contacts.read', async t => {
  const c = await fixture(t), allowed = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.channelId], departmentIds: ['support'] } } });
  const own = await c.claim(c.conversation(), allowed), channelHidden = await c.claim(c.conversation({ channelId: 'memory-web-b' }));
  const departmentHidden = await c.claim(c.conversation({ departmentId: 'sales', department: 'Comercial RAM' }));
  const hiddenContact = c.current(channelHidden.id).contactId, ownContact = c.current(own.id).contactId;
  const preview = await c.own(`${c.path}/contacts/${hiddenContact}/merge-preview?targetId=${ownContact}`); assert.equal(preview.status, 200);
  const merged = await c.own(`${c.path}/contacts/${hiddenContact}/merge`, { method: 'POST', body: { targetId: ownContact,
    sourceVersion: preview.data.sourceContact.version, targetVersion: preview.data.targetContact.version, revision: preview.data.revision } }); assert.equal(merged.status, 200);
  const hiddenMemory = await c.create(channelHidden.id); assert.equal(hiddenMemory.status, 201);
  assert.equal((await c.list(own.id)).data.items.some(item => item.id === hiddenMemory.data.id), true);
  assert.equal((await c.list(own.id, allowed)).data.items.some(item => item.id === hiddenMemory.data.id), false);
  assert.equal((await c.list(channelHidden.id, allowed)).status, 403); assert.equal((await c.list(departmentHidden.id, allowed)).status, 403);
  const lackingRead = await c.member({ permissions: permissions.filter(permission => !['contacts.read', 'contacts.write'].includes(permission)) });
  assert.equal((await c.list(own.id, lackingRead)).status, 403);
  const foreign = await c.own('/api/tenants', { method: 'POST', body: { name: 'Empresa distinta RAM memória', segment: 'QA' } }); assert.equal(foreign.status, 201); c.seed(foreign.data.id);
  const crossed = await c.request(`/api/tenants/${foreign.data.id}/conversations/${own.id}/memories?agentId=${c.agentId}`, { cookie: allowed.cookie }); assert.equal(crossed.status, 403);
  assert.equal((await c.list(own.id, c.owner, 'agent-missing')).status, 404);
  assert.equal((await c.request(`${c.route(own.id)}/${hiddenMemory.data.id}`, { method: 'PATCH', cookie: allowed.cookie,
    body: { version: 1, conversationVersion: c.current(own.id).version, title: 'Tentativa RAM', content: 'Não salvar', expiresAt: null, reviewed: true } })).status, 403);
});

test('HTTP suporte não herda responsabilidade da mesma pessoa no contexto próprio', async t => {
  const c = await fixture(t), conversation = await c.claim(c.conversation());
  const grant = c.app.support.create(c.actor, { requestId: randomUUID(), supportUserId: c.owner.id, tenantIds: [c.tenantId],
    permissions, scopeRules: { [c.tenantId]: { channelIds: [c.channelId], departmentIds: ['support'] } }, reason: 'Delegação sintética RAM', ttlMinutes: 60 });
  const result = await c.request(c.route(conversation.id), { method: 'POST', cookie: c.owner.cookie,
    headers: { 'X-Elozi-Workspace': c.actor.resellerId, 'X-Elozi-Support-Grant': grant.id },
    body: { agentId: c.agentId, scope: 'contact', title: 'Não herdar responsável', content: 'MEMORY_WRONG_SUPPORT_CONTEXT', expiresAt: null, reviewed: true, conversationVersion: conversation.version } });
  assert.ok([403, 409].includes(result.status), JSON.stringify(result));
  assert.deepEqual((await c.list(conversation.id)).data.items, []);
  assert.equal(c.current(conversation.id).assignedSupportGrantId, undefined);
});

test('HTTP rascunho refletido permanece visível somente com ACL de memória e fica fora do PG', async t => {
  const content = 'MEMORY_ECHO_PRIVATE_RAM_FACT';
  const c = await fixture(t, () => 'Texto derivado: ' + content), conversation = await c.claim(c.conversation());
  const memory = await c.create(conversation.id, c.owner, { title: 'Título privado refletido RAM', content }); assert.equal(memory.status, 201);
  const started = await c.queue(conversation.id); assert.equal(started.status, 202);
  const run = await c.waitRun(conversation.id, started.data.id); assert.equal(run.state, 'draft'); assert.equal(run.draft, 'Texto derivado: ' + content);
  assert.equal(JSON.stringify(c.calls[0].messages).includes(content), true);
  assert.equal(JSON.stringify(run.memoryReferences).includes(memory.data.title), false);
  const general = await c.own(c.path); assert.equal(general.status, 200);
  for (const value of [memory.data.id, memory.data.title, 'memorySnapshot', 'memoryReferences']) assert.equal(JSON.stringify(general.data).includes(value), false);
  assert.equal(general.data.runs.find(item => item.id === run.id).draft, 'Texto derivado: ' + content);
  const viewer = await c.member({ permissions: permissions.filter(permission => !['contacts.read', 'contacts.write'].includes(permission)) });
  const unauthorized = await c.request(c.path, { cookie: viewer.cookie }); assert.equal(unauthorized.status, 200);
  assert.equal(unauthorized.data.runs.find(item => item.id === run.id).draft, null);
  for (const value of [memory.data.id, memory.data.title, content]) assert.equal(JSON.stringify(unauthorized.data).includes(value), false);
  c.app.bridge.enabled = true; c.app.bridge.queue(c.tenantId); c.app.bridge.enabled = false;
  const spool = c.app.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(c.tenantId).payload;
  for (const value of [memory.data.id, memory.data.title, content, 'memorySnapshot', 'memoryReferences']) assert.equal(spool.includes(value), false);
});

test('HTTP memória nega CSRF e revalida sessão quando o corpo chega depois do logout', async t => {
  const c = await fixture(t), user = await c.member(), conversation = await c.claim(c.conversation(), user);
  const body = { agentId: c.agentId, scope: 'contact', title: 'Corpo pausado RAM', content: 'MEMORY_BODY_MUST_NOT_SAVE', expiresAt: null, conversationVersion: conversation.version, reviewed: true };
  assert.equal((await c.request(c.route(conversation.id), { method: 'POST', cookie: user.cookie, body, origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await c.request(c.route(conversation.id), { method: 'POST', cookie: user.cookie, body, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const text = JSON.stringify(body), first = text.slice(0, 20), partialBodyReceived = deferred(); let req;
  c.app.server.prependOnceListener('request', incoming => {
    assert.equal(incoming.url, c.route(conversation.id)); incoming.once('data', () => partialBodyReceived.resolve());
  });
  const response = new Promise((resolve, reject) => {
    req = httpRequest(c.base + c.route(conversation.id), { method: 'POST', headers: { Cookie: user.cookie, Origin: c.base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => resolve({ status: incoming.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) })); incoming.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(Error('Corpo RAM pausado expirou.'))); req.write(first);
  });
  await partialBodyReceived.promise;
  assert.equal((await c.request('/api/auth/logout', { method: 'POST', cookie: user.cookie, body: {} })).status, 200);
  req.end(text.slice(first.length)); assert.equal((await response).status, 401);
  const current = await c.list(conversation.id); assert.equal(current.status, 200); assert.deepEqual(current.data.items, []);
});

for (const mutation of ['create', 'update', 'archive']) test(`HTTP ${mutation} de memória invalida provider pendente sem late draft ou segunda chamada`, async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), conversation = await c.claim(c.conversation());
  let memory;
  if (mutation !== 'create') { const result = await c.create(conversation.id); assert.equal(result.status, 201); memory = result.data; }
  const input = { runId: randomUUID(), idempotencyKey: randomUUID() };
  const started = await c.queue(conversation.id, c.owner, input); assert.equal(started.status, 202); await turn(); assert.equal(c.calls.length, 1);
  if (mutation !== 'create') assert.equal(JSON.stringify(c.calls[0].messages).includes(memory.content), true);
  if (mutation === 'create') assert.equal((await c.create(conversation.id)).status, 201);
  if (mutation === 'update') assert.equal((await c.own(`${c.route(conversation.id)}/${memory.id}`, { method: 'PATCH', body: { version: memory.version, conversationVersion: conversation.version, title: 'Revisada', content: 'MEMORY_CHANGED_PENDING', expiresAt: null, reviewed: true } })).status, 200);
  if (mutation === 'archive') assert.equal((await c.own(`${c.route(conversation.id)}/${memory.id}/archive`, { method: 'POST', body: { version: memory.version, conversationVersion: conversation.version } })).status, 200);
  pending.resolve({ text: 'DRAFT_AFTER_MEMORY_CHANGE_MUST_DISAPPEAR' });
  const run = await c.waitRun(conversation.id, started.data.id); assert.equal(run.state, 'invalidated'); assert.equal(run.draft, null);
  const repeated = await c.queue(conversation.id, c.owner, input); assert.equal(repeated.status, 202); assert.equal(repeated.data.id, started.data.id); assert.equal(c.calls.length, 1);
  const stored = c.state().runs.find(item => item.id === started.data.id); assert.equal(JSON.stringify(stored).includes('MEMORY_PRIVATE_RAM'), false);
  const dto = await c.runs(conversation.id); assert.equal(JSON.stringify(dto.data).includes('memorySnapshot'), false);
});

test('HTTP merge de contato invalida memória da identidade antiga sem transportá-la ao destino', async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), source = await c.claim(c.conversation()), target = c.conversation();
  const memory = await c.create(source.id); assert.equal(memory.status, 201);
  const started = await c.queue(source.id); assert.equal(started.status, 202); await turn();
  const sourceContact = c.current(source.id).contactId, targetContact = c.current(target.id).contactId;
  const preview = await c.own(`${c.path}/contacts/${sourceContact}/merge-preview?targetId=${targetContact}`); assert.equal(preview.status, 200);
  const merged = await c.own(`${c.path}/contacts/${sourceContact}/merge`, { method: 'POST', body: { targetId: targetContact,
    sourceVersion: preview.data.sourceContact.version, targetVersion: preview.data.targetContact.version, revision: preview.data.revision } }); assert.equal(merged.status, 200);
  pending.resolve({ text: 'DRAFT_FROM_OLD_CONTACT_MUST_DISAPPEAR' });
  const run = await c.waitRun(source.id, started.data.id); assert.equal(run.state, 'invalidated'); assert.equal(run.draft, null); assert.equal(c.calls.length, 1);
  const list = await c.list(source.id); assert.equal(list.status, 200); assert.equal(list.data.items.some(item => item.id === memory.data.id), false);
});
