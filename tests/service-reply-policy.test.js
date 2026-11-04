// Channel reply policy (attendance/assistant), team/QA conversations and the limit notice, through the real HTTP app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { channelReplyPolicy } from '../src/service-reply-limits.js';

const origin = 'https://loja.example.test';
const status = expected => error => error.status === expected;

async function fixture(t) {
  const key = Buffer.alloc(32, 59), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio da política de respostas'); };
  let now = Date.parse('2026-10-19T12:00:00.000Z');
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny },
    webhookOptions: { post: async () => ({ status: 200 }), pollMs: 60000 }, webchatOptions: { now: () => now } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '', token } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString() || 'null'), cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); } });
    });
    pending.on('error', reject); pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'policy.owner', password: 'Senha-sintetica-' + randomUUID() } });
  const admin = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant = (await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Produto sintético', segment: 'QA' } })).data;
  app.store.mutate(admin, tenant.id, 'Fixture da política', state => {
    state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }];
    state.departments = [];
    state.agents = [{ id: 'assistant', name: 'Assistente do produto', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
  });
  app.webchat.configure(admin, tenant.id, 'site', { version: 0, origins: [origin] });
  const created = app.servicePrincipals.create(admin, tenant.id, { name: 'Assistente', agentId: 'assistant', capabilities: ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'], channelIds: ['site'], departmentIds: null, dailyRequests: 2000, maxConcurrent: 3, ttlHours: 24 });
  const actor = app.servicePrincipals.authenticate('Bearer ' + created.token);
  const conversation = id => app.store.getConversation(app.store.tenant(admin, tenant.id), id);
  let counter = 0;
  const owned = async () => {
    const challenge = app.webchat.challenge({ tenantId: tenant.id, channelId: 'site', origin });
    const session = app.webchat.openSession({ tenantId: tenant.id, channelId: 'site', origin, challenge: challenge.challenge, name: 'Usuário final' });
    await app.webchat.receive({ token: session.token, text: 'Quero saber meu saldo de pontos', clientMessageId: `policy-visitor-msg-${String(++counter).padStart(4, '0')}`, origin });
    const id = app.store.tenant(admin, tenant.id).conversations.find(item => item.remoteSessionId && !item.messages.some(message => message.kind === 'agent'))?.id;
    app.serviceApi.claimConversation(actor, { requestId: `claim_${id}`.slice(0, 120), conversationId: id, version: conversation(id).version });
    return id;
  };
  let replies = 0;
  const reply = (id, via = 'api') => {
    const body = { requestId: `reply_${String(++replies).padStart(6, '0')}`, conversationId: id, version: conversation(id).version, text: `Resposta ${replies}` };
    return via === 'rest' ? request('/api/service/v1/replies', { method: 'POST', token: created.token, body }) : app.serviceApi.sendReply(actor, body);
  };
  // The guardrail reads message timestamps: shift the server clock used by the principals between replies.
  app.servicePrincipals.now = () => now;
  const advance = ms => { now += ms; };
  const policy = body => request(`/api/tenants/${tenant.id}/channels/site/reply-policy`, { method: 'POST', cookie: owner.cookie, body });
  const exemption = (id, exempt, cookie = owner.cookie) => request(`/api/tenants/${tenant.id}/conversations/${id}/reply-exemption`, { method: 'POST', cookie, body: { exempt } });
  t.after(async () => {
    await app.serviceWebhooks.close(); await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); app.store.close();
  });
  return { app, admin, tenant, actor, created, conversation, owned, reply, policy, exemption, advance, request, owner };
}

test('validação da política: atendimento limpa, assistente exige limites coerentes e aviso curto', () => {
  assert.equal(channelReplyPolicy({ profile: 'attendance' }), null);
  assert.deepEqual({ ...channelReplyPolicy({ profile: 'assistant' }) }, { profile: 'assistant', perHour: 120, perMinute: 12, notice: '' });
  for (const value of [{ profile: 'outro' }, { profile: 'attendance', perHour: 10 }, { profile: 'assistant', perHour: 5 }, { profile: 'assistant', perHour: 1001 },
    { profile: 'assistant', perMinute: 0 }, { profile: 'assistant', perMinute: 61 }, { profile: 'assistant', perHour: 10, perMinute: 11 }, { profile: 'assistant', notice: 'x'.repeat(281) }, { profile: 'assistant', extra: 1 }])
    assert.throws(() => channelReplyPolicy(value), status(400), JSON.stringify(value));
});

test('perfil assistente: rajada por minuto e limite por hora com retryAfter, aviso único por janela e contrato do 429', async t => {
  const f = await fixture(t);
  const set = await f.policy({ profile: 'assistant', perHour: 8, perMinute: 3, notice: 'Recebi sua mensagem. Já te respondo em instantes.' });
  assert.equal(set.status, 200, JSON.stringify(set.data)); assert.deepEqual(set.data.replyPolicy, { profile: 'assistant', perHour: 8, perMinute: 3, notice: 'Recebi sua mensagem. Já te respondo em instantes.' });
  const id = await f.owned();
  for (let index = 0; index < 3; index++) assert.equal((await f.reply(id)).result.state, 'confirmed');
  const burst = await f.reply(id, 'rest');
  assert.equal(burst.status, 429); assert.equal(burst.data.code, 'SERVICE_REPLY_RATE_LIMIT'); assert.equal(burst.data.admissionRejected, true);
  assert.deepEqual(burst.data.limit, { window: 'minute', max: 3 }); assert.ok(Number.isSafeInteger(burst.data.retryAfter) && burst.data.retryAfter >= 1 && burst.data.retryAfter <= 61, String(burst.data.retryAfter));
  assert.equal(burst.data.noticeSent, true); assert.equal(burst.headers['retry-after'], String(burst.data.retryAfter));
  const notices = () => f.conversation(id).messages.filter(message => message.text === 'Recebi sua mensagem. Já te respondo em instantes.').length;
  assert.equal(notices(), 1);
  const again = await f.reply(id, 'rest');
  assert.equal(again.status, 429); assert.equal(again.data.noticeSent, false, 'one notice per window'); assert.equal(notices(), 1);
  // Next minutes: 3 replies + 1 notice so far; the hourly limit (8) takes over after four more replies.
  f.advance(61000); for (let index = 0; index < 3; index++) assert.equal((await f.reply(id)).result.state, 'confirmed');
  f.advance(61000); assert.equal((await f.reply(id)).result.state, 'confirmed');
  await assert.rejects(f.reply(id), error => error.status === 429 && error.rateLimit.window === 'hour' && error.rateLimit.max === 8 && error.retryAfter > 60);
  const me = f.app.serviceApi.me(f.actor).replyRateLimits;
  assert.deepEqual(me.channelPolicies, [{ channelId: 'site', profile: 'assistant', perHour: 8, perMinute: 3, notice: true }]); assert.equal(me.teamLoopGuardPerMinute, 60);
  assert.equal((await f.policy({ profile: 'attendance' })).data.replyPolicy.profile, 'attendance');
  assert.equal(f.app.serviceApi.me(f.actor).replyRateLimits.channelPolicies.length, 0);
});

test('conversa de equipe/QA ignora o limite por hora e mantém só a trava anti-loop; só o administrador marca', async t => {
  const f = await fixture(t);
  const id = await f.owned();
  assert.equal((await f.exemption(id, true, '')).status, 401);
  const marked = await f.exemption(id, true);
  assert.equal(marked.status, 200, JSON.stringify(marked.data)); assert.equal(f.conversation(id).replyExempt, true);
  for (let index = 0; index < 20; index++) { assert.equal((await f.reply(id)).result.state, 'confirmed'); f.advance(1000); }
  assert.ok(f.conversation(id).messages.filter(message => message.kind === 'agent').length >= 20, 'above the default 6/h');
  f.app.store.mutate(f.admin, f.tenant.id, 'Rajada sintética de laço', state => {
    const c = state.conversations.find(item => item.id === id), at = new Date(Date.parse('2026-10-19T12:00:00.000Z') + 20000).toISOString();
    for (let index = 0; index < 60; index++) c.messages.push({ id: `loop-${index}`, kind: 'agent', text: 'Laço', authorServiceId: f.created.principal.id, createdAt: at });
  });
  await assert.rejects(f.reply(id), error => error.status === 429 && error.rateLimit.window === 'minute' && error.rateLimit.max === 60 && error.noticeSent === false);
  assert.equal((await f.exemption(id, false)).data.replyExempt, false); assert.equal(f.conversation(id).replyExempt, undefined);
});
