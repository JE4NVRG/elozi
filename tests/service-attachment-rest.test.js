import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { ServiceAttachmentReads } from '../src/service-attachment-media.js';

const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.from('SYNTHETIC-PRIVATE-REST-VOICE')]);

async function fixture(t) {
  const key = Buffer.alloc(32, 43), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio REST de anexos'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, { store, auth, media, servicePrincipals: principals, serviceApi: api } = app;
  const row = auth.insertUser({ username: 'rest.media.owner', name: 'Administração sintética' }, Buffer.alloc(16, 5), Buffer.alloc(64, 5), 'reseller', [], 'mep-demo');
  const admin = auth.session(row).actor, tenant = store.createTenant(admin, { name: 'Loja REST', segment: 'Varejo' });
  const channelId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID();
  store.mutate(admin, tenant.id, 'Fixture REST de anexos', state => {
    state.channels = [{ id: channelId, kind: 'whatsapp_qr', name: 'WhatsApp', state: 'planned' }];
    state.departments = [];
    state.agents = [{ id: 'ext', name: 'Agente externo', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.conversations = [{ id: conversationId, contact: 'Cliente', channelId, departmentId: null, owner: 'agent', agentId: 'ext', assignedUserId: null, status: 'open', version: 1, conversationKind: 'direct',
      messages: [{ id: messageId, kind: 'customer', text: '', createdAt: new Date().toISOString(), attachments: [] }] }];
  });
  const context = { tenantId: tenant.id, channelId, conversationId };
  const pending = media.placeholder(context, { kind: 'audio', name: 'nota.ogg', mime: 'audio/ogg', size: ogg.length });
  const attachment = await media.save(pending.id, context, ogg, pending);
  store.mutate(admin, tenant.id, 'Anexo sintético recebido', state => { const c = state.conversations[0]; c.messages[0].attachments = [attachment]; c.version++; });
  const created = principals.create(admin, tenant.id, { name: 'Serviço REST', agentId: 'ext', capabilities: ['conversation.read', 'reply.send'], channelIds: [channelId], departmentIds: null, dailyRequests: 50, maxConcurrent: 2, ttlHours: 24 });
  const enable = () => { api.attachmentReads = new ServiceAttachmentReads(api, { readAttachment: (id, ctx) => media.read(id, ctx), privateMediaPolicy: [{ tenantId: tenant.id, principalId: created.principal.id, channelId, mimeTypes: ['audio/ogg'] }] }); };
  const current = () => store.getConversation(store.tenant(admin, tenant.id), conversationId);
  const input = requestId => ({ requestId, conversationId, version: current().version, messageId, attachmentId: attachment.id });
  const post = async (body, token = created.token) => {
    const response = await fetch(base + '/api/service/v1/attachment-reads', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json().catch(() => null) };
  };
  return { app, store, admin, tenant, api, created, enable, input, post, current, external, attachment };
}

test('REST attachment-reads entrega o áudio autorizado com no-store e o mesmo contrato do MCP', async t => {
  const f = await fixture(t);
  const disabled = await f.post(f.input('rest_read_disabled'));
  assert.equal(disabled.status, 403, 'without the private media policy no bytes are served');
  f.enable();
  const result = await f.post(f.input('rest_read_voice_0001'));
  assert.equal(result.status, 200); assert.equal(result.cache, 'private, no-store');
  assert.equal(result.data.status, 'attachment_ready'); assert.equal(result.data.attachment.mime, 'audio/ogg');
  assert.deepEqual(Buffer.from(result.data.attachment.data, 'base64'), ogg);
  assert.equal(result.data.attachment.sha256, createHash('sha256').update(ogg).digest('hex'));
  const replay = await f.post(f.input('rest_read_voice_0001'));
  assert.equal(replay.status, 200); assert.equal(replay.data.attachment.sha256, result.data.attachment.sha256);
  assert.equal(f.api.me(f.app.servicePrincipals.authenticate('Bearer ' + f.created.token)).principal.usage.requests, 1, 'replay of the same requestId is free');
  const receipts = JSON.stringify(f.store.db.prepare('SELECT result FROM service_principal_receipts').all());
  assert.equal(receipts.includes(ogg.toString('base64')), false); assert.equal(f.external.length, 0);
});

test('REST attachment-reads recusa campos extras, versão antiga, bearer inválido e conversa assumida por pessoa', async t => {
  const f = await fixture(t); f.enable();
  assert.equal((await f.post({ ...f.input('rest_read_extra_01'), tenantId: f.tenant.id })).status, 400);
  assert.equal((await f.post({ ...f.input('rest_read_stale_01'), version: 1 })).status, 409);
  assert.equal((await f.post(f.input('rest_read_token_01'), 'elozi_svc_invalid')).status, 401);
  f.store.mutate(f.admin, f.tenant.id, 'Pessoa assume', state => { const c = state.conversations[0]; c.owner = 'human'; c.assignedUserId = f.admin.userId; c.version++; });
  const taken = await f.post(f.input('rest_read_human_01'));
  assert.equal(taken.status, 403); assert.equal(JSON.stringify(taken.data).includes(ogg.toString('base64')), false);
});

test('REST attachment-reads descarta os bytes quando a autoridade muda entre a leitura e a entrega', async t => {
  const f = await fixture(t); f.enable();
  const original = f.api.readAttachment.bind(f.api); let captured;
  f.api.readAttachment = async (...args) => { captured = await original(...args); f.store.mutate(f.admin, f.tenant.id, 'Pessoa assume na entrega', state => { const c = state.conversations[0]; c.owner = 'human'; c.assignedUserId = f.admin.userId; c.version++; }); return captured; };
  const result = await f.post(f.input('rest_read_race_0001'));
  assert.ok([403, 409].includes(result.status)); assert.equal(captured.attachment.data, '');
  assert.equal(JSON.stringify(result.data).includes(ogg.toString('base64')), false);
});
