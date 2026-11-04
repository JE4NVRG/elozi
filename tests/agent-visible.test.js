// Agent visible in the inbox: reply pace, connected-agent chips and pending items that wait for a connected agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { replyPace } from '../public/agent-pace.js';
import { inboxRowMarkup } from '../public/inbox-list-ui.js';
import { createApp } from '../src/server.js';

const at = Date.parse('2026-10-19T12:00:00.000Z');
const agentMessages = offsets => offsets.map(seconds => ({ kind: 'agent', createdAt: new Date(at - seconds * 1000).toISOString() }));

test('ritmo: equipe/QA só com a trava por minuto, assistente com minuto e hora, atendimento só a contagem', () => {
  const messages = [...agentMessages([5, 20, 50, 90, 1800, 4000]), { kind: 'customer', createdAt: new Date(at - 10000).toISOString() }];
  assert.deepEqual(replyPace({ messages, exempt: true, now: at }), { mode: 'team', minute: 3, hour: 5, perMinute: 60, perHour: null });
  assert.deepEqual(replyPace({ messages, policy: { profile: 'assistant', perHour: 120, perMinute: 12 }, now: at }), { mode: 'assistant', minute: 3, hour: 5, perMinute: 12, perHour: 120 });
  assert.deepEqual(replyPace({ messages, policy: null, now: at }), { mode: 'attendance', minute: 3, hour: 5, perMinute: null, perHour: null });
  assert.deepEqual(replyPace({ messages: [], now: at }).hour, 0);
});

test('lista: agente conectado aparece pelo nome, sem o alerta de "sem resposta"; equipe/QA ganha selo', () => {
  const item = { tenantId: 't1', tenantName: 'FamilyPoints', id: 'c1', conversationId: 'c1', contact: 'Jean', channelId: 'wa', channelName: 'WhatsApp', channelKind: 'whatsapp_qr',
    owner: 'agent', agentId: 'tuca', status: 'open', unread: 0, updatedAt: '2026-10-19T12:00:00Z', preview: { text: 'Oi' } };
  const row = (extra, agents) => String(inboxRowMarkup({ ...item, ...extra }, { workspaceId: 'w', tenants: [], agents }));
  const connected = row({}, () => [{ id: 'tuca', name: 'Tuca', provider: 'mcp', mode: 'copilot', configured: true }]);
  assert.match(connected, /✦ Tuca/); assert.equal(/Sem resposta automática/.test(connected), false);
  assert.match(row({ replyExempt: true }, () => [{ id: 'tuca', name: 'Tuca', provider: 'mcp' }]), /Equipe\/QA/);
  assert.match(row({}, () => [{ id: 'tuca', name: 'Hermes', provider: 'hermes', configured: true }]), /Sem resposta automática/, 'a Hermes copilot without autopilot still warns');
});

test('pendências: conversa de agente conectado com chave ativa espera o tempo do piloto antes de contar como parada', async t => {
  const key = Buffer.alloc(32, 71), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio do agente visível'); };
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
  t.after(async () => {
    await app.serviceWebhooks.close(); await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); app.store.close();
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'visible.owner', password: 'Senha-sintetica-' + randomUUID() } });
  const session = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant = (await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Produto sintético', segment: 'QA' } })).data;
  const recent = new Date(Date.now() - 60000).toISOString();
  app.store.mutate(session, tenant.id, 'Fixture do agente visível', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr', name: 'WhatsApp', transport: 'baileys', state: 'connected' }];
    state.agents = [{ id: 'tuca', name: 'Tuca', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.conversations = [{ id: 'c-agent', contact: 'Família', channelId: 'wa', conversationKind: 'direct', owner: 'agent', agentId: 'tuca', status: 'open', version: 1, unread: 1,
      messages: [{ id: 'm1', kind: 'customer', text: 'Quanto de pontos?', createdAt: recent }], updatedAt: recent }];
  });
  const parked = async () => (await request('/api/me/attention', { cookie: owner.cookie })).data.parked.filter(item => item.tenantId === tenant.id).map(item => item.conversationId);
  assert.deepEqual(await parked(), ['c-agent'], 'without an identity nobody answers: it waits for a person at once');
  const created = app.servicePrincipals.create(session, tenant.id, { name: 'Tuca', agentId: 'tuca', capabilities: ['conversation.read', 'reply.send'], channelIds: ['wa'], departmentIds: null,
    dailyRequests: 100, maxConcurrent: 1, ttlHours: 24 });
  assert.deepEqual(await parked(), [], 'the connected agent answers through its product: it waits like the autopilot');
  app.store.mutate(session, tenant.id, 'Mensagem antiga', state => { state.conversations[0].messages[0].createdAt = new Date(Date.now() - 3600000).toISOString(); });
  assert.deepEqual(await parked(), ['c-agent'], 'a stalled reply counts after the stall time');
  app.store.mutate(session, tenant.id, 'Mensagem recente', state => { state.conversations[0].messages[0].createdAt = recent; });
  app.servicePrincipals.revoke(session, tenant.id, created.principal.id, { revision: created.principal.revision });
  assert.deepEqual(await parked(), ['c-agent'], 'a revoked identity no longer answers');
});
