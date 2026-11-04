// Connect a product: one idempotent call creates the agent, the identity scoped to the channel, the reply policy and the webhook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

async function fixture(t) {
  const key = Buffer.alloc(32, 67), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio de conexão de produto'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny },
    webhookOptions: { post: async () => ({ status: 200 }), pollMs: 60000 } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '' } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString() || 'null'), cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); } });
    });
    pending.on('error', reject); pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'product.owner', password: 'Senha-sintetica-' + randomUUID() } });
  const session = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant = (await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Produto sintético', segment: 'QA' } })).data;
  app.store.mutate(session, tenant.id, 'Canais sintéticos', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr', name: 'WhatsApp do produto', transport: 'baileys', state: 'connected' }, { id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }];
    state.agents = [];
  });
  const state = () => app.store.tenant(session, tenant.id);
  const connect = body => request('/api/platform/product-connections', { method: 'POST', cookie: owner.cookie, body: { tenantId: tenant.id, channelId: 'wa', agentName: 'Assistente do produto', ...body } });
  t.after(async () => {
    await app.serviceWebhooks.close(); await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); app.store.close();
  });
  return { app, request, owner, session, tenant, state, connect };
}

test('assistente de produto: agente, chave no canal, ritmo e webhook desligado numa chamada; repetir não duplica nada', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/platform/product-connections', { method: 'POST', body: {} })).status, 401);
  const first = await f.connect({ requestId: 'product-0001', kind: 'assistant', replyPolicy: { perHour: 200, perMinute: 15, notice: 'Muitas mensagens! Espera um pouco.' },
    webhook: { url: 'https://hooks.example.com/elozi' } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const body = first.data;
  assert.equal(body.replay, false); assert.match(body.token, /^elozi_svc_/); assert.equal(body.keyLost, false);
  assert.match(body.secret, /\S{32,}/); assert.equal(body.secretLost, false);
  assert.deepEqual([...body.principal.capabilities].sort(), ['conversation.manage', 'conversation.read', 'events.read', 'handoff.request', 'reply.send']);
  assert.deepEqual(body.principal.channelIds, ['wa']); assert.equal(body.principal.state, 'active');
  assert.equal(body.webhook.configured, true); assert.equal(body.webhook.enabled, false); assert.equal(body.webhook.url, 'https://hooks.example.com/elozi');
  assert.deepEqual(body.replyPolicy, { profile: 'assistant', perHour: 200, perMinute: 15, notice: 'Muitas mensagens! Espera um pouco.' });
  const agent = f.state().agents.find(item => item.id === body.agent.id);
  assert.deepEqual([agent.provider, agent.mode, agent.configured, agent.name], ['mcp', 'copilot', true, 'Assistente do produto']);
  assert.deepEqual(f.state().channels.find(item => item.id === 'wa').replyPolicy, body.replyPolicy);
  const again = await f.connect({ requestId: 'product-0001', kind: 'assistant', replyPolicy: { perHour: 200, perMinute: 15, notice: 'Muitas mensagens! Espera um pouco.' }, webhook: { url: 'https://hooks.example.com/elozi' } });
  assert.equal(again.status, 200); assert.equal(again.data.replay, true);
  assert.equal(again.data.token, ''); assert.equal(again.data.keyLost, true); assert.equal(again.data.secret, ''); assert.equal(again.data.secretLost, true);
  assert.equal(again.data.principal.id, body.principal.id);
  assert.equal(f.state().agents.length, 1); assert.equal(f.app.servicePrincipals.list(f.session, f.tenant.id).principals.length, 1);
  assert.equal((await f.connect({ requestId: 'product-0001', kind: 'attendance', channelId: 'site' })).status, 409);
  assert.equal(JSON.stringify(f.state().productConnections).includes('elozi_svc_'), false, 'the record keeps ids only');
});

test('validação antes de qualquer efeito; atendimento limpa a política; falha no meio retoma sem segundo agente', async t => {
  const f = await fixture(t);
  for (const bad of [{ kind: 'outro' }, { kind: 'assistant', webhook: { url: 'http://127.0.0.1/hook' } }, { kind: 'attendance', replyPolicy: { perHour: 10 } },
    { kind: 'assistant', capabilities: ['reply.send'] }, { kind: 'assistant', channelId: 'nope' }, { kind: 'assistant', replyPolicy: { perHour: 5 } }]) {
    const refused = await f.connect({ requestId: `bad-${randomUUID().slice(0, 8)}`, ...bad });
    assert.ok([400, 404].includes(refused.status), JSON.stringify(bad) + ' ' + refused.status);
  }
  assert.equal((f.state().agents || []).length, 0, 'nothing created by refused calls'); assert.equal(f.state().productConnections, undefined);
  f.app.store.mutate(f.session, f.tenant.id, 'Política anterior', state => { state.channels[0].replyPolicy = { profile: 'assistant', perHour: 50, perMinute: 5, notice: '' }; });
  // The webhook step fails once: the agent and the identity stay, and the retry finishes without creating them again.
  const configure = f.app.serviceWebhooks.configure.bind(f.app.serviceWebhooks);
  let failOnce = true;
  f.app.serviceWebhooks.configure = async (...args) => { if (failOnce) { failOnce = false; throw Object.assign(new Error('Falha sintética'), { status: 503 }); } return configure(...args); };
  const failed = await f.connect({ requestId: 'product-0002', kind: 'attendance', webhook: { url: 'https://hooks.example.com/fc', secret: 'segredo-do-produto-com-mais-de-32-caracteres' } });
  assert.equal(failed.status, 503);
  assert.equal(f.state().agents.length, 1); assert.equal(f.state().channels[0].replyPolicy, undefined, 'attendance clears the channel policy');
  const resumed = await f.connect({ requestId: 'product-0002', kind: 'attendance', webhook: { url: 'https://hooks.example.com/fc', secret: 'segredo-do-produto-com-mais-de-32-caracteres' } });
  assert.equal(resumed.status, 201, JSON.stringify(resumed.data));
  assert.equal(resumed.data.token, ''); assert.equal(resumed.data.keyLost, true, 'the first key never reached the screen');
  assert.equal(resumed.data.secret, ''); assert.equal(resumed.data.secretLost, false, 'the product provided its own secret');
  assert.equal(f.state().agents.length, 1); assert.equal(f.app.servicePrincipals.list(f.session, f.tenant.id).principals.length, 1);
  assert.deepEqual(resumed.data.replyPolicy, { profile: 'attendance' });
});
