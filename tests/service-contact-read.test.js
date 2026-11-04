// contact.read: an explicit grant adds the WhatsApp phone (E.164) to the conversation read of a product backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

test('contact.read: telefone E.164 só com a concessão, só em conversa direta de WhatsApp; eventos seguem sem telefone', async t => {
  const key = Buffer.alloc(32, 73), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio do telefone do contato'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny },
    webhookOptions: { post: async () => ({ status: 200 }), pollMs: 60000 } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '', token } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
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
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'contact.owner', password: 'Senha-sintetica-' + randomUUID() } });
  const session = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant = (await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Produto sintético', segment: 'QA' } })).data;
  app.store.mutate(session, tenant.id, 'Fixture do telefone', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr', name: 'WhatsApp', transport: 'baileys', state: 'connected' }, { id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }];
    state.agents = [{ id: 'fc', name: 'Agente do produto', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.conversations = [
      // A legacy 12-digit Brazilian JID (before the ninth digit) and its LID alias.
      { id: 'wa-legacy', contact: 'Jean', channelId: 'wa', conversationKind: 'direct', remoteJid: '551191007047@s.whatsapp.net', remoteAliases: ['551191007047@s.whatsapp.net', '1234567890@lid'],
        owner: 'queue', status: 'open', version: 1, messages: [{ id: 'm1', kind: 'customer', text: 'VINCULAR 123456', createdAt: new Date().toISOString() }] },
      { id: 'web-1', contact: 'Visitante', channelId: 'site', conversationKind: 'direct', owner: 'queue', status: 'open', version: 1, messages: [] }
    ];
  });
  const identity = capabilities => app.servicePrincipals.create(session, tenant.id, { name: `Produto ${capabilities.length}`, agentId: 'fc', capabilities, channelIds: null, departmentIds: null,
    dailyRequests: 100, maxConcurrent: 1, ttlHours: 24 }).token;
  assert.throws(() => identity(['contact.read']), error => error.status === 400, 'contact.read requires conversation.read');
  const plain = identity(['conversation.read']), granted = identity(['conversation.read', 'contact.read']);
  const read = (token, id) => request(`/api/service/v1/conversations/${id}`, { token });
  const without = await read(plain, 'wa-legacy');
  assert.equal(without.status, 200); assert.equal('contactPhone' in without.data.conversation, false);
  const withPhone = await read(granted, 'wa-legacy');
  assert.equal(withPhone.data.conversation.contactPhone, '+5511991007047', 'E.164 with the ninth digit');
  assert.equal('contactPhone' in (await read(granted, 'web-1')).data.conversation, false, 'only WhatsApp conversations');
  // MCP read goes through the same method.
  const actor = app.servicePrincipals.authenticate('Bearer ' + granted);
  assert.equal(app.serviceApi.read(actor, 'wa-legacy').conversation.contactPhone, '+5511991007047');
  assert.ok(app.servicePrincipals.list(session, tenant.id).capabilities.includes('contact.read'), 'the panel lists the capability');
});
