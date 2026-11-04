import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const denied = async () => { throw new Error('External transport forbidden in agent HTTP fixture'); };
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const serviceOrigin = 'http://elozi-hermes-fixture:8660';

async function fixture(t, providerCall = async () => 'Rascunho sintético para revisão humana.', { useConfiguredProvider = false, agentProfileOrigins = [] } = {}) {
  const key = randomBytes(32), calls = [];
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, agentOrigins: [serviceOrigin, 'http://mepchat-hermes:8660'], agentProfileOrigins,
    providerCall: useConfiguredProvider ? undefined : context => { calls.push(context); return providerCall(context); },
    gatewayOptions: { authKey: key, socketFactory: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denied },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const controller of app.runtime.controllers.values()) controller.abort();
    await settle();
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', cookie = '', body, workspace } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie,
      ...(workspace === undefined ? {} : { 'X-Elozi-Workspace': workspace }) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()),
          cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Agent HTTP fixture request timed out')));
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Admin agentes QA', username: 'agent.owner', password: password() } });
  assert.equal(owner.status, 200);
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const created = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Atendimento com copiloto QA', segment: 'QA' } });
  assert.equal(created.status, 201);
  const tenantId = created.data.id, path = `/api/tenants/${tenantId}`, channelId = 'agent-channel', hiddenChannelId = 'agent-hidden-channel', agentId = 'agent-hermes';
  const seedAgent = id => app.store.mutate(actor, id, 'Fixture de agente e canais sintéticos', tenant => {
    tenant.channels = [{ id: channelId, kind: 'telegram', name: 'Canal sintético', state: 'planned' },
      { id: hiddenChannelId, kind: 'telegram', name: 'Canal restrito sintético', state: 'planned' }];
    tenant.agents = [{ id: agentId, name: 'Hermes QA', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Apoie a equipe com rascunhos.' }];
  });
  seedAgent(tenantId);
  let memberSequence = 0, conversationSequence = 0;
  const member = async (extra = {}) => {
    const username = 'agent.member.' + ++memberSequence, secret = password();
    const created = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Atendente QA ' + memberSequence,
      username, password: secret, role: 'operator', tenantIds: [tenantId], permissions: ['inbox.read', 'inbox.reply', 'inbox.transfer'], ...extra } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const logged = await request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
    assert.equal(logged.status, 200); return { ...created.data, cookie: logged.cookie };
  };
  const state = () => app.store.tenant(actor, tenantId);
  const conversation = (extra = {}) => app.store.mutate(actor, tenantId, 'Fixture de conversa sintética', tenant => {
    const sequence = ++conversationSequence, now = new Date().toISOString();
    const current = { id: 'agent-conversation-' + sequence, channelId, contact: 'Contato sintético', owner: 'queue', assignedUserId: null,
      assignedUserName: null, agentId: null, departmentId: null, department: '', status: 'open', version: 1, tags: [], unread: 1,
      messages: [{ id: 'agent-message-' + sequence, kind: 'customer', text: 'Pedido sintético', createdAt: now }], updatedAt: now, ...extra };
    tenant.conversations.push(current); return current;
  });
  const claim = async (current, user) => {
    const response = await request(`${path}/conversations/${current.id}/owner`, { method: 'POST', cookie: user.cookie, body: { owner: 'human', version: current.version } });
    assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
  };
  const queue = (current, user, extra = {}) => request(`${path}/conversations/${current.id}/run`, { method: 'POST', cookie: user.cookie,
    body: { version: current.version, agentId, ...extra } });
  const runs = (id, user = owner) => request(`${path}/conversations/${id}/runs`, { cookie: user.cookie });
  const waitRun = async (id, runId, user = owner, terminal = run => run.state !== 'running') => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await runs(id, user); assert.equal(response.status, 200);
      const run = response.data.runs.find(item => item.id === runId); if (run && terminal(run)) return run;
      await settle();
    }
    assert.fail('Execução sintética não alcançou o estado esperado.');
  };
  return { app, key, request, owner, actor, tenantId, path, channelId, hiddenChannelId, agentId, calls, seedAgent, member, state, conversation, claim, queue, runs, waitRun };
}

test('HTTP aceita copiloto com202 sem aguardar provedor, mantém responsável e lista identidade do rascunho', async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), user = await c.member();
  const current = await c.claim(c.conversation(), user);
  const input = { runId: 'http-queued', idempotencyKey: 'http-queued-key' };
  const accepted = await c.queue(current, user, input);
  assert.equal(accepted.status, 202); assert.equal(accepted.data.state, 'running'); assert.equal(c.calls.length, 1);
  assert.equal(accepted.data.actorUserId, user.id); assert.equal(accepted.data.actorName, user.name);
  assert.equal(accepted.data.agentName, 'Hermes QA'); assert.equal(accepted.data.agentVersion, 1);
  const listed = await c.runs(current.id, user); assert.equal(listed.status, 200); assert.equal(listed.data.runs[0].state, 'running');
  const repeated = await c.queue(current, user, input); assert.equal(repeated.status, 202); assert.equal(repeated.data.id, accepted.data.id); assert.equal(c.calls.length, 1);
  pending.resolve({ text: 'Rascunho HTTP identificado.' });
  const draft = await c.waitRun(current.id, accepted.data.id, user); assert.equal(draft.state, 'draft'); assert.equal(draft.draft, 'Rascunho HTTP identificado.');
  const conversation = c.state().conversations.find(item => item.id === current.id);
  assert.equal(conversation.owner, 'human'); assert.equal(conversation.assignedUserId, user.id); assert.equal(conversation.version, current.version);
  assert.equal(conversation.messages.filter(message => message.kind === 'human' || message.kind === 'agent').length, 0);
  assert.equal(c.app.runtime.controllers.size, 0);
});

test('HTTP exige sessão, responsável, empresa e canal autorizado antes de acionar copiloto', async t => {
  const c = await fixture(t), user = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.channelId] } } }), other = await c.member();
  const queued = c.conversation(), current = await c.claim(queued, user), hidden = c.conversation({ channelId: c.hiddenChannelId, owner: 'human', assignedUserId: user.id });
  const route = `${c.path}/conversations/${current.id}/run`, input = { version: current.version, agentId: c.agentId };
  assert.equal((await c.request(route, { method: 'POST', body: input })).status, 401);
  assert.equal((await c.queue(current, other)).status, 409);
  assert.equal((await c.queue(hidden, user)).status, 403);
  assert.equal((await c.request(route, { method: 'POST', cookie: user.cookie, body: input, workspace: 'foreign-workspace' })).status, 403);
  const another = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Empresa distinta QA', segment: 'QA' } });
  assert.equal((await c.request(`/api/tenants/${another.data.id}/conversations/${current.id}/run`, { method: 'POST', cookie: user.cookie, body: input })).status, 403);
  assert.equal((await c.runs(hidden.id, user)).status, 403);
  assert.equal((await c.queue(current, user, { version: 1 })).status, 409);
  assert.equal((await c.queue(current, user, { endpoint: serviceOrigin + '/v1/chat/completions' })).status, 400);
  c.app.store.mutate(c.actor, c.tenantId, 'Agente sintético sem configuração', tenant => { tenant.agents[0].configured = false; });
  assert.equal((await c.queue(current, user)).status, 409);
  assert.equal(c.calls.length, 0); assert.equal((c.state().runs || []).length, 0);
});

test('HTTP somente responsável cancela; resposta tardia permanece descartada', async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), user = await c.member(), other = await c.member();
  const current = await c.claim(c.conversation(), user), accepted = await c.queue(current, user);
  assert.equal(accepted.status, 202);
  const cancel = `${c.path}/runs/${accepted.data.id}/cancel`;
  assert.equal((await c.request(cancel, { method: 'POST', cookie: other.cookie, body: {} })).status, 409);
  const cancelled = await c.request(cancel, { method: 'POST', cookie: user.cookie, body: {} });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.state, 'cancelled'); assert.equal(c.calls[0].signal.aborted, true);
  pending.resolve({ text: 'Texto após cancelamento que não pode reaparecer.' }); await settle();
  const run = await c.waitRun(current.id, accepted.data.id, user); assert.equal(run.state, 'cancelled'); assert.equal(run.draft, null);
});

test('HTTP logout em voo revoga conclusão sem alterar versão ou expor rascunho', async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), user = await c.member();
  const current = await c.claim(c.conversation(), user), accepted = await c.queue(current, user);
  assert.equal(accepted.status, 202); assert.equal((await c.request('/api/auth/logout', { method: 'POST', cookie: user.cookie, body: {} })).status, 200);
  pending.resolve({ text: 'Conteúdo descartado depois do logout.' });
  const run = await c.waitRun(current.id, accepted.data.id); assert.equal(run.state, 'invalidated'); assert.equal(run.draft, null);
  assert.equal((await c.runs(current.id, user)).status, 401);
  const saved = c.state().conversations.find(item => item.id === current.id); assert.equal(saved.version, current.version); assert.equal(saved.assignedUserId, user.id);
});

test('HTTP handoff invalida execução, registra identidade humana e bloqueia texto tardio', async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), user = await c.member();
  const current = await c.claim(c.conversation(), user), accepted = await c.queue(current, user);
  assert.equal(accepted.status, 202);
  const handoff = await c.request(`${c.path}/conversations/${current.id}/owner`, { method: 'POST', cookie: user.cookie,
    body: { version: current.version, owner: 'queue', reason: 'Transferência sintética para equipe.' } });
  assert.equal(handoff.status, 200); assert.equal(handoff.data.owner, 'queue'); assert.equal(handoff.data.assignedUserId, null);
  assert.equal(handoff.data.attendantEvents.at(-1).actorId, user.id); assert.equal(c.calls[0].signal.aborted, true);
  pending.resolve({ text: 'Rascunho da atribuição anterior.' }); await settle();
  const run = await c.waitRun(current.id, accepted.data.id); assert.equal(run.state, 'invalidated'); assert.equal(run.draft, null);
  assert.equal(c.state().conversations.find(item => item.id === current.id).messages.some(message => message.text === 'Rascunho da atribuição anterior.'), false);
});

test('HTTP configuração exige revisão atual, preserva segredo no conflito e recusa origem externa', async t => {
  const c = await fixture(t), user = await c.member(), route = `${c.path}/agents/${c.agentId}`;
  const token = 'synthetic-agent-key-' + randomBytes(12).toString('hex');
  const config = { version: 1, endpoint: serviceOrigin + '/v1/chat/completions', model: 'synthetic-model', token };
  assert.equal((await c.request(route, { method: 'PATCH', cookie: user.cookie, body: config })).status, 403);
  const { version: ignored, ...withoutVersion } = config;
  assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: withoutVersion })).status, 400);
  assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { ...config, endpoint: 'http://169.254.169.254/v1/chat/completions' } })).status, 400);
  const saved = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: config });
  assert.equal(saved.status, 200); assert.equal(saved.data.configured, true); assert.equal(c.state().agents[0].version, 2);
  const vault = encryptedChannelSecrets(c.app.store.db, c.key), secretId = `agent:${c.tenantId}:${c.agentId}`;
  assert.deepEqual(vault.get(secretId), { endpoint: config.endpoint, model: config.model, token });
  assert.equal(vault.get('agent:' + c.agentId), null);
  const before = c.app.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get(secretId).payload;
  const stale = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { ...config, token: 'synthetic-stale-token', model: 'stale-model' } });
  assert.equal(stale.status, 409); assert.deepEqual(c.app.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get(secretId).payload, before);
  assert.equal(c.state().agents[0].version, 2); assert.equal(JSON.stringify(c.state()).includes(token), false); assert.equal(JSON.stringify(saved.data).includes(token), false);
  const preserved = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 2, endpoint: config.endpoint, model: 'next-model' } });
  assert.equal(preserved.status, 200); assert.equal(vault.get(secretId).token, token); assert.equal(c.state().agents[0].version, 3);
});

test('HTTP origem de perfil Hermes declarada pelo operador vale como serviço de agente', async t => {
  assert.throws(() => createApp({ databasePath: ':memory:', publicOrigin: '', agentProfileOrigins: ['http://172.18.0.1:8671/t'] }), /perfil Hermes/);
  const profileOrigin = 'http://172.18.0.1:8671', c = await fixture(t, undefined, { agentProfileOrigins: [profileOrigin] });
  const route = `${c.path}/agents/${c.agentId}`, token = 'synthetic-router-key-' + randomBytes(12).toString('hex');
  const saved = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 1, endpoint: profileOrigin + '/t/mepmail/v1/chat/completions', model: 'mepmail-equipe', token } });
  assert.equal(saved.status, 200); assert.equal(c.state().agents[0].endpoint, profileOrigin + '/t/mepmail/v1/chat/completions');
  assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 2, endpoint: 'http://172.18.0.1:9999/t/x/v1/chat/completions', model: 'm', token } })).status, 400);
});

test('HTTP segredo do agente fica isolado por empresa mesmo com ID sintético coincidente', async t => {
  const c = await fixture(t);
  const second = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Outra empresa de agentes QA', segment: 'QA' } });
  assert.equal(second.status, 201); c.seedAgent(second.data.id);
  const firstToken = 'synthetic-first-tenant-key', secondToken = 'synthetic-second-tenant-key';
  for (const [tenantId, token] of [[c.tenantId, firstToken], [second.data.id, secondToken]]) {
    const saved = await c.request(`/api/tenants/${tenantId}/agents/${c.agentId}`, { method: 'PATCH', cookie: c.owner.cookie,
      body: { version: 1, endpoint: serviceOrigin + '/v1/chat/completions', model: 'fixture-model', token } });
    assert.equal(saved.status, 200);
  }
  const vault = encryptedChannelSecrets(c.app.store.db, c.key);
  assert.equal(vault.get(`agent:${c.tenantId}:${c.agentId}`).token, firstToken);
  assert.equal(vault.get(`agent:${second.data.id}:${c.agentId}`).token, secondToken);
  const user = await c.member();
  assert.equal((await c.request(`/api/tenants/${second.data.id}/agents/${c.agentId}`, { method: 'PATCH', cookie: user.cookie,
    body: { version: 2, endpoint: serviceOrigin + '/v1/chat/completions', model: 'fixture-model' } })).status, 403);
  assert.equal(c.calls.length, 0);
});

test('HTTP proprietário cadastra CommandCode cifrada, preserva no vazio ou erro e limpa por ação explícita', async t => {
  const c = await fixture(t), token = 'synthetic-platform-key-' + randomBytes(12).toString('hex');
  const status = await c.request('/api/integrations', { cookie: c.owner.cookie });
  assert.equal(status.status, 200); assert.equal(status.data.commandCode.configured, false);
  const saved = await c.request('/api/integrations', { method: 'POST', cookie: c.owner.cookie, body: { commandCodeApiKey: token } });
  assert.equal(saved.status, 200); assert.equal(saved.data.commandCode.configured, true);
  assert.equal(saved.data.commandCode.model, 'deepseek/deepseek-v4.1-flash'); assert.equal(JSON.stringify(saved.data).includes(token), false);
  const vault = encryptedChannelSecrets(c.app.store.db, c.key), record = () => c.app.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get('platform-services').payload;
  assert.equal(vault.get('platform-services').commandCodeApiKey, token); assert.equal(Buffer.from(record()).includes(Buffer.from(token)), false);
  for (const invalid of ['short', 'synthetic key with spaces', 'synthetic-key\nwith-newline', 'x'.repeat(4097), true, false, 0, null, {}, []]) {
    const before = record();
    const refused = await c.request('/api/integrations', { method: 'POST', cookie: c.owner.cookie, body: { commandCodeApiKey: invalid } });
    assert.equal(refused.status, 400); assert.deepEqual(record(), before); assert.equal(vault.get('platform-services').commandCodeApiKey, token);
  }
  for (const invalid of ['false', 1, null]) {
    const before = record();
    const refused = await c.request('/api/integrations', { method: 'POST', cookie: c.owner.cookie, body: { disableCommandCode: invalid } });
    assert.equal(refused.status, 400); assert.deepEqual(record(), before);
  }
  for (const body of [{ commandCodeApiKey: '' }, {}, { disableCommandCode: false }]) {
    const kept = await c.request('/api/integrations', { method: 'POST', cookie: c.owner.cookie, body });
    assert.equal(kept.status, 200); assert.equal(kept.data.commandCode.configured, true); assert.equal(vault.get('platform-services').commandCodeApiKey, token);
  }
  const read = await c.request('/api/integrations', { cookie: c.owner.cookie }); assert.equal(read.status, 200);
  assert.deepEqual(read.data.commandCode, { configured: true, model: 'deepseek/deepseek-v4.1-flash' }); assert.equal(JSON.stringify(read.data).includes(token), false);
  const disabled = await c.request('/api/integrations', { method: 'POST', cookie: c.owner.cookie, body: { disableCommandCode: true } });
  assert.equal(disabled.status, 200); assert.equal(disabled.data.commandCode.configured, false); assert.equal(vault.get('platform-services').commandCodeApiKey, '');
  assert.equal((await c.request('/api/integrations', { cookie: c.owner.cookie })).data.commandCode.configured, false);
  assert.equal(c.calls.length, 0);
});

test('HTTP administrador da revenda e operador não consultam nem alteram a chave global CommandCode', async t => {
  const c = await fixture(t), reseller = await c.member({ role: 'reseller', tenantIds: [] }), operator = await c.member();
  const token = 'synthetic-owner-platform-key';
  assert.equal((await c.request('/api/integrations', { method: 'POST', cookie: c.owner.cookie, body: { commandCodeApiKey: token } })).status, 200);
  const before = c.app.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get('platform-services').payload;
  for (const user of [reseller, operator]) {
    assert.equal(user.platformAdmin, false);
    assert.equal((await c.request('/api/integrations', { cookie: user.cookie })).status, 403);
    for (const body of [{ commandCodeApiKey: 'synthetic-unauthorized-key' }, { disableCommandCode: true }]) {
      const refused = await c.request('/api/integrations', { method: 'POST', cookie: user.cookie, body });
      assert.equal(refused.status, 403); assert.equal(JSON.stringify(refused.data).includes(token), false);
    }
  }
  assert.equal((await c.request('/api/integrations')).status, 401);
  assert.deepEqual(c.app.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get('platform-services').payload, before);
  assert.equal(encryptedChannelSecrets(c.app.store.db, c.key).get('platform-services').commandCodeApiKey, token);
});

test('HTTP chave global atende empresas distintas e só segue para a origem privada Hermes dedicada', async t => {
  const c = await fixture(t, undefined, { useConfiguredProvider: true }), observed = [], token = 'synthetic-private-provider-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'POST'); assert.ok([serviceOrigin, 'http://mepchat-hermes:8660'].includes(new URL(url).origin));
    observed.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Rascunho privado sintético.' } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal((await c.request('/api/integrations', { method: 'POST', cookie: c.owner.cookie, body: { commandCodeApiKey: token } })).status, 200);
  const second = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Segunda empresa copiloto QA', segment: 'QA' } });
  assert.equal(second.status, 201); c.seedAgent(second.data.id);
  for (const [tenantId, origin] of [[c.tenantId, 'http://mepchat-hermes:8660'], [second.data.id, serviceOrigin]]) {
    const path = `/api/tenants/${tenantId}`;
    assert.equal((await c.request(`${path}/agents/${c.agentId}`, { method: 'PATCH', cookie: c.owner.cookie,
      body: { version: 1, endpoint: origin + '/v1/chat/completions', model: 'fixture-model', token: 'synthetic-service-token' } })).status, 200);
    const current = c.app.store.mutate(c.actor, tenantId, 'Fixture de responsável e contexto isolados', tenant => {
      const conversation = { id: 'private-conversation-' + tenantId, channelId: c.channelId, contact: 'Contato sintético', owner: 'human',
        assignedUserId: c.actor.userId, assignedUserName: c.actor.name, agentId: null, departmentId: null, department: '', status: 'open',
        version: 1, tags: [], unread: 1, messages: [{ id: 'message-' + tenantId, kind: 'customer', text: 'Contexto sintético ' + tenantId }], updatedAt: new Date().toISOString() };
      tenant.conversations.push(conversation); return conversation;
    });
    const accepted = await c.request(`${path}/conversations/${current.id}/run`, { method: 'POST', cookie: c.owner.cookie,
      body: { version: current.version, agentId: c.agentId } });
    assert.equal(accepted.status, 202); await settle();
    const listed = await c.request(`${path}/conversations/${current.id}/runs`, { cookie: c.owner.cookie });
    assert.equal(listed.status, 200); assert.equal(listed.data.runs[0].state, 'draft');
    assert.equal(JSON.stringify(listed.data).includes(token), false); assert.equal(JSON.stringify(c.app.store.tenant(c.actor, tenantId)).includes(token), false);
  }
  assert.equal(observed.length, 2); assert.equal(observed[0].body.provider_key, token); assert.equal(Object.hasOwn(observed[1].body, 'provider_key'), false);
  assert.ok(observed[0].body.messages.some(message => message.content.includes(c.tenantId)));
  assert.equal(observed[0].body.messages.some(message => message.content.includes(second.data.id)), false);
  assert.ok(observed[1].body.messages.some(message => message.content.includes(second.data.id)));
});

test('HTTP política de ferramentas do agente aceita só valores conhecidos, exige administrador e revisão atual', async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), user = await c.member(), route = `${c.path}/agents/${c.agentId}`;
  const current = await c.claim(c.conversation(), user), accepted = await c.queue(current, user);
  assert.equal(accepted.status, 202); assert.equal(accepted.data.toolPolicy, 'auto_readonly', 'Sem política gravada, o padrão é consulta automática.');
  assert.equal((await c.request(route, { method: 'PATCH', cookie: user.cookie, body: { version: 1, toolPolicy: 'approve_all' } })).status, 403);
  for (const toolPolicy of ['sempre', '', null, true]) assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 1, toolPolicy } })).status, 400);
  assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 2, toolPolicy: 'approve_all' } })).status, 409);
  assert.equal(c.state().agents[0].toolPolicy, undefined); assert.equal(c.state().agents[0].version, 1);
  const saved = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 1, toolPolicy: 'approve_all' } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data, { toolPolicy: 'approve_all', version: 2 });
  const agent = c.state().agents[0]; assert.equal(agent.toolPolicy, 'approve_all'); assert.equal(agent.configured, true); assert.equal(agent.versions.at(-1).version, 1);
  const invalidated = await c.waitRun(current.id, accepted.data.id, user); assert.equal(invalidated.state, 'invalidated', 'Mudar a política invalida a preparação em andamento.');
  pending.resolve({ text: 'Rascunho da política anterior.' }); await settle();
  assert.equal((await c.runs(current.id, user)).data.runs[0].draft, null);
  const token = 'synthetic-policy-token-' + randomBytes(8).toString('hex');
  const configured = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 2, endpoint: serviceOrigin + '/v1/chat/completions', model: 'synthetic-model', token, toolPolicy: 'auto_readonly' } });
  assert.equal(configured.status, 200); assert.equal(c.state().agents[0].toolPolicy, 'auto_readonly'); assert.equal(c.state().agents[0].version, 3);
  assert.equal(JSON.stringify(c.state()).includes(token), false);
  const created = await c.request(`${c.path}/agents`, { method: 'POST', cookie: c.owner.cookie, body: { name: 'Hermes com aprovação', provider: 'hermes', mode: 'copilot', description: 'Pede aprovação para toda ferramenta.', toolPolicy: 'approve_all' } });
  assert.equal(created.status, 201); assert.equal(created.data.toolPolicy, 'approve_all');
  assert.equal(c.state().agents.find(item => item.id === created.data.id).toolPolicy, 'approve_all');
  assert.equal((await c.request(`${c.path}/agents`, { method: 'POST', cookie: c.owner.cookie, body: { name: 'Hermes inválido', provider: 'hermes', mode: 'copilot', description: 'Política inválida.', toolPolicy: 'never' } })).status, 400);
  assert.equal((await c.request(`${c.path}/agents`, { method: 'POST', cookie: user.cookie, body: { name: 'Sem acesso', provider: 'hermes', mode: 'copilot', description: 'Operador.', toolPolicy: 'approve_all' } })).status, 403);
  assert.equal(c.state().agents.length, 2);
});

test('HTTP rascunho fica anterior às novas mensagens e pedido defasado só por mensagens do cliente é aceito', async t => {
  const c = await fixture(t), user = await c.member();
  const current = await c.claim(c.conversation(), user);
  assert.equal((await c.queue(current, user, { runId: 'http-stale' })).status, 202);
  const draft = await c.waitRun(current.id, 'http-stale', user); assert.equal(draft.state, 'draft');
  c.app.store.mutate(c.actor, c.tenantId, 'Mensagem sintética recebida', tenant => {
    const conversation = tenant.conversations.find(item => item.id === current.id);
    conversation.messages.push({ id: 'incoming-stale', kind: 'customer', text: 'Mais um detalhe sintético.', createdAt: new Date().toISOString() }); conversation.version++;
  });
  const stale = (await c.runs(current.id, user)).data.runs.find(run => run.id === 'http-stale');
  assert.equal(stale.state, 'draft'); assert.equal(stale.stale, true); assert.equal(stale.draft, draft.draft);
  assert.equal(stale.memoryUnavailable, undefined, 'A memória é conferida contra a conversa atual, sem perder o rascunho.');
  assert.equal(c.state().runs.find(run => run.id === 'http-stale').memorySnapshot.binding.conversationVersion, current.version, 'O vínculo gravado continua sendo o da preparação.');
  const caughtUp = await c.queue(current, user, { runId: 'http-caught-up', lastMessageId: current.messages.at(-1).id });
  assert.equal(caughtUp.status, 202, JSON.stringify(caughtUp.data)); assert.equal(caughtUp.data.conversationVersion, current.version + 1); assert.equal(caughtUp.data.requestedVersion, current.version);
  assert.equal((await c.waitRun(current.id, 'http-caught-up', user)).state, 'draft');
  assert.equal((await c.queue(current, user, { runId: 'http-no-anchor' })).status, 409, 'Sem a última mensagem vista, a versão antiga continua em conflito.');
  const latest = c.state().conversations.find(item => item.id === current.id);
  const handoff = await c.request(`${c.path}/conversations/${current.id}/owner`, { method: 'POST', cookie: user.cookie, body: { version: latest.version, owner: 'queue', reason: 'Transferência sintética.' } });
  assert.equal(handoff.status, 200);
  assert.equal((await c.queue(current, user, { runId: 'http-after-transfer', lastMessageId: current.messages.at(-1).id })).status, 409);
  const runs = (await c.runs(current.id, c.owner)).data.runs;
  assert.deepEqual(runs.map(run => [run.id, run.state, run.draft, run.stale]), [['http-stale', 'invalidated', null, undefined], ['http-caught-up', 'invalidated', null, undefined]]);
  assert.equal(c.calls.length, 2);
});

test('HTTP perfil do agente edita nome, descrição e instruções com revisão e invalida preparação em andamento', async t => {
  const pending = deferred(), c = await fixture(t, () => pending.promise), user = await c.member(), route = `${c.path}/agents/${c.agentId}`;
  const current = await c.claim(c.conversation(), user);
  assert.equal((await c.queue(current, user, { runId: 'http-profile' })).status, 202);
  const profile = { version: 1, name: 'Hermes Aurora', description: 'Atende pedidos da loja.', instructions: 'Assine como Equipe Aurora.\nConfirme o número do pedido.' };
  assert.equal((await c.request(route, { method: 'PATCH', cookie: user.cookie, body: profile })).status, 403);
  for (const invalid of [{ instructions: 'x'.repeat(4001) }, { instructions: 'Sino \u0007' }, { instructions: 7 }, { name: '' }, { name: 'x'.repeat(49) }, { description: 'x'.repeat(201) }, { toolPolicy: 'never' }])
    assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { ...profile, ...invalid } })).status, 400, JSON.stringify(invalid).slice(0, 40));
  assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { ...profile, version: 2 } })).status, 409);
  assert.equal(c.state().agents[0].version, 1); assert.equal(c.state().agents[0].instructions, undefined);
  const saved = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: profile });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data, { name: 'Hermes Aurora', description: 'Atende pedidos da loja.', instructions: profile.instructions, version: 2 });
  const agent = c.state().agents[0];
  assert.deepEqual([agent.name, agent.description, agent.instructions, agent.configured, agent.versions.at(-1).version], ['Hermes Aurora', 'Atende pedidos da loja.', profile.instructions, true, 1]);
  assert.equal((await c.waitRun(current.id, 'http-profile', user)).state, 'invalidated', 'Mudar as instruções invalida a preparação em andamento.');
  pending.resolve({ text: 'Rascunho com o perfil atual.' }); await settle();
  assert.equal((await c.queue(current, user, { runId: 'http-instructed' })).status, 202);
  const instructed = await c.waitRun(current.id, 'http-instructed', user); assert.equal(instructed.state, 'draft'); assert.equal(instructed.agentName, 'Hermes Aurora');
  const system = c.calls.at(-1).messages[0]; assert.equal(system.role, 'system'); assert.match(system.content, /Assine como Equipe Aurora\.\nConfirme o número do pedido\./);
  assert.equal(c.calls.at(-1).messages.slice(1).some(message => message.content.includes('Assine como Equipe Aurora')), false);
  const cleared = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 2, instructions: '' } });
  assert.deepEqual(cleared.data, { instructions: '', version: 3 }); assert.equal(Object.hasOwn(c.state().agents[0], 'instructions'), false);
  const token = 'synthetic-profile-token-' + randomBytes(8).toString('hex');
  const configured = await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version: 3, endpoint: serviceOrigin + '/v1/chat/completions', model: 'synthetic-model', token, instructions: 'Responda com cordialidade.' } });
  assert.equal(configured.status, 200); assert.equal(c.state().agents[0].instructions, 'Responda com cordialidade.'); assert.equal(c.state().agents[0].version, 4);
  for (let version = 4; version < 26; version++) assert.equal((await c.request(route, { method: 'PATCH', cookie: c.owner.cookie, body: { version, description: 'Revisão ' + version } })).status, 200);
  assert.equal(c.state().agents[0].versions.length, 20, 'O histórico guarda as 20 revisões mais recentes.'); assert.equal(c.state().agents[0].versions.at(-1).version, 25);
  assert.equal(JSON.stringify(c.state()).includes(token), false);
});

test('HTTP uso de IA e limite diário pertencem ao administrador da empresa, isolados e aplicados a novas execuções', async t => {
  const c = await fixture(t, async () => ({ text: 'Rascunho medido.', usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 } })), user = await c.member();
  const current = await c.claim(c.conversation(), user);
  assert.equal((await c.queue(current, user, { runId: 'http-usage-1' })).status, 202);
  assert.deepEqual((await c.waitRun(current.id, 'http-usage-1', user)).usage, { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 });
  const second = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Outra empresa de uso QA', segment: 'QA' } });
  c.app.store.db.prepare('INSERT INTO ai_usage VALUES (?,?,?,?,?,?)').run(second.data.id, c.app.runtime.usageDay(), c.agentId, 7, 7000, 700);
  const usage = await c.request(`${c.path}/agents/usage?days=7`, { cookie: c.owner.cookie });
  assert.equal(usage.status, 200); assert.equal(usage.data.days, 7); assert.equal(usage.data.limit, null);
  assert.deepEqual(usage.data.today, { runs: 1, promptTokens: 70, completionTokens: 30, totalTokens: 100, remaining: null, blocked: false });
  assert.deepEqual(usage.data.agents.map(agent => [agent.agentId, agent.agentName, agent.totalTokens]), [[c.agentId, 'Hermes QA', 100]]);
  assert.equal(JSON.stringify(usage.data).includes('7700'), false, 'O uso de outra empresa não aparece.');
  for (const days of ['0', '91', 'abc', '1.5', '']) assert.equal((await c.request(`${c.path}/agents/usage?days=${days}`, { cookie: c.owner.cookie })).status, 400, days);
  assert.equal((await c.request(`${c.path}/agents/usage`, { cookie: user.cookie })).status, 403);
  assert.equal((await c.request(`/api/tenants/${second.data.id}/agents/usage`, { cookie: user.cookie })).status, 403);
  assert.equal((await c.request(`${c.path}/agents/usage`)).status, 401);
  const limitRoute = `${c.path}/agents/usage/limit`;
  assert.equal((await c.request(limitRoute, { method: 'PUT', cookie: user.cookie, body: { version: 1, limit: 100 } })).status, 403);
  for (const body of [{ version: 1, limit: -5 }, { version: 1, limit: '100' }, { version: 1 }, { version: 1, limit: 100, extra: 1 }])
    assert.equal((await c.request(limitRoute, { method: 'PUT', cookie: c.owner.cookie, body })).status, 400, JSON.stringify(body));
  const limited = await c.request(limitRoute, { method: 'PUT', cookie: c.owner.cookie, body: { version: 1, limit: 100 } });
  assert.equal(limited.status, 200); assert.deepEqual(limited.data, { limit: 100, version: 2 });
  assert.equal((await c.request(limitRoute, { method: 'PUT', cookie: c.owner.cookie, body: { version: 1, limit: 500 } })).status, 409);
  const blocked = await c.queue(current, user, { runId: 'http-usage-2' });
  assert.equal(blocked.status, 429); assert.equal(blocked.data.error, 'O limite diário de IA desta empresa foi atingido.'); assert.equal(c.calls.length, 1);
  const report = (await c.request(`${c.path}/agents/usage`, { cookie: c.owner.cookie })).data;
  assert.deepEqual([report.limit, report.limitVersion, report.today.remaining, report.today.blocked], [100, 2, 0, true]);
  const other = (await c.request(`/api/tenants/${second.data.id}/agents/usage`, { cookie: c.owner.cookie })).data;
  assert.deepEqual([other.today.totalTokens, other.limit], [7700, null]);
  assert.equal((await c.request(limitRoute, { method: 'PUT', cookie: c.owner.cookie, body: { version: 2, limit: null } })).status, 200);
  assert.equal((await c.queue(current, user, { runId: 'http-usage-3' })).status, 202);
});


test('HTTP descoberta nativa exige dono, modelo catalogado e não afirma inferência', async t => {
  const c=await fixture(t), user=await c.member(), route=`${c.path}/agents/${c.agentId}`;
  const token='synthetic-native-health-key';
  assert.equal((await c.request(route,{method:'PATCH',cookie:c.owner.cookie,body:{version:1,endpoint:serviceOrigin+'/v1/chat/completions',model:'hermes-agent',token}})).status,200);
  const originalFetch=globalThis.fetch, requests=[];
  t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).origin,serviceOrigin);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    assert.equal(options.headers.authorization,'Bearer '+token);requests.push(new URL(url).pathname);
    return Response.json(new URL(url).pathname==='/health'?{status:'ok',platform:'hermes-agent',version:'0.21.5'}:{object:'list',data:[{object:'model',id:'hermes-agent'}]});
  };
  assert.equal((await c.request(route+'/test',{method:'POST',body:{}})).status,401);
  assert.equal((await c.request(route+'/test',{method:'POST',cookie:user.cookie,body:{}})).status,403);
  assert.equal(requests.length,0);
  const result=await c.request(route+'/test',{method:'POST',cookie:c.owner.cookie,body:{}});
  assert.equal(result.status,200);assert.equal(result.data.source,'catalog');assert.equal(result.data.model,'hermes-agent');
  assert.equal(result.data.reachable,true);assert.ok(result.data.checkedAt);assert.equal(result.data.inferenceConfirmed,undefined);
  assert.deepEqual(requests,['/health','/v1/models']);assert.equal(c.calls.length,0);
  assert.equal(c.state().agents[0].serviceCheckedAt,result.data.checkedAt);
  assert.equal(JSON.stringify(result.data).includes(token),false);
});

test('HTTP teste de serviço rejeita revisão alterada durante descoberta nativa', async t => {
  const c=await fixture(t), route=`${c.path}/agents/${c.agentId}`, entered=deferred(), release=deferred();
  assert.equal((await c.request(route,{method:'PATCH',cookie:c.owner.cookie,body:{version:1,endpoint:serviceOrigin+'/v1/chat/completions',model:'hermes-agent',token:'synthetic-native-cas-key'}})).status,200);
  const originalFetch=globalThis.fetch;t.after(()=>{release.resolve();globalThis.fetch=originalFetch;});
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.method,'GET');
    if(new URL(url).pathname==='/health'){entered.resolve();await release.promise;return Response.json({status:'ok',platform:'hermes-agent'});}
    return Response.json({object:'list',data:[{object:'model',id:'hermes-agent'}]});
  };
  const pending=c.request(route+'/test',{method:'POST',cookie:c.owner.cookie,body:{}});
  await entered.promise;
  c.app.store.mutate(c.actor,c.tenantId,'Edição concorrente sintética',state=>{state.agents[0].version++;});
  release.resolve();const result=await pending;
  assert.equal(result.status,409);assert.equal(c.state().agents[0].serviceCheckedAt,undefined);assert.equal(c.calls.length,0);
});

test('HTTP modelo legado divergente não recebe fallback nativo nem timestamp de sucesso', async t => {
  const c=await fixture(t),route=`${c.path}/agents/${c.agentId}`;
  assert.equal((await c.request(route,{method:'PATCH',cookie:c.owner.cookie,body:{version:1,endpoint:serviceOrigin+'/v1/chat/completions',model:'hermes-agent',token:'synthetic-native-negative-key'}})).status,200);
  const originalFetch=globalThis.fetch, requests=[];t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async(url)=>{requests.push(new URL(url).pathname);return Response.json({status:'ok',platform:'hermes-agent',model:'different-model'});};
  const result=await c.request(route+'/test',{method:'POST',cookie:c.owner.cookie,body:{}});
  assert.equal(result.status,502);assert.deepEqual(requests,['/health']);assert.equal(c.state().agents[0].serviceCheckedAt,undefined);
  assert.equal(c.calls.length,0);
});
