// presence.typing / elozi_send_typing: "digitando…" of a connected agent through the channel adapter, with the private
// reply's authority, without message, quota, receipt or provider retries. createApp with fake WhatsApp/Telegram entries;
// no external network, provider or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { TelegramGateway } from '../src/telegram.js';
import { TYPING_MIN_INTERVAL_MS } from '../src/service-typing.js';

const origin = 'https://loja.example.test';
const JID = '5511987650000@s.whatsapp.net';
const TYPING = ['conversation.read', 'events.read', 'reply.send', 'conversation.manage', 'presence.typing'];
const status = expected => error => error.status === expected;

async function fixture(t) {
  const key = Buffer.alloc(32, 43), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio do digitando'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, clients = [];
  const { store, auth, webchat, servicePrincipals: principals, serviceApi: api } = app;
  const row = auth.insertUser({ username: 'typing.owner', name: 'Administração sintética' }, Buffer.alloc(16, 6), Buffer.alloc(64, 6), 'reseller', [], 'mep-demo');
  const admin = auth.session(row).actor, tenant = store.createTenant(admin, { name: 'Loja digitando', segment: 'Varejo' });
  const now = () => new Date().toISOString();
  store.mutate(admin, tenant.id, 'Fixture do digitando', state => {
    state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }, { id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', name: 'WhatsApp', state: 'connected' },
      { id: 'tg', kind: 'telegram', transport: 'telegram-bot', name: 'Telegram', state: 'connected' }];
    state.departments = [{ id: 'sac', name: 'SAC', active: true, memberIds: [], distribution: 'manual', cursor: 0, version: 1 }];
    state.agents = [{ id: 'ext', name: 'Agente externo', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'ext-2', name: 'Outro agente', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    const direct = (id, channelId, extra) => ({ id, contact: 'Cliente', channelId, departmentId: 'sac', owner: 'agent', agentId: 'ext', status: 'open', version: 1, conversationKind: 'direct', messages: [{ id: `${id}-1`, kind: 'customer', text: 'Oi', createdAt: now() }], ...extra });
    state.conversations = [direct('wa-own', 'wa', { remoteJid: JID }), direct('wa-other', 'wa', { remoteJid: '5511900000000@s.whatsapp.net', agentId: 'ext-2' }),
      direct('wa-queue', 'wa', { remoteJid: '5511911111111@s.whatsapp.net', owner: 'queue', agentId: undefined }), direct('tg-own', 'tg', { remoteChatId: '123456', threadId: 7 }),
      { id: 'wa-group', contact: 'Grupo', channelId: 'wa', departmentId: 'sac', owner: 'agent', agentId: 'ext', status: 'open', version: 1, conversationKind: 'group', remoteJid: '1203630@g.us', messages: [] }];
  });
  webchat.configure(admin, tenant.id, 'site', { version: 0, origins: [origin] });
  // Live provider connections, as the gateways keep them after a QR or bot login: only the typing calls are recorded.
  const calls = [];
  const socket = { sendPresenceUpdate: async (state, jid) => { calls.push(['presence', state, jid]); if (socket.fail) throw new Error('socket closed'); },
    presenceSubscribe: async jid => { calls.push(['subscribe', jid]); }, fail: false };
  app.gateway.entries.set('wa', { tenantId: tenant.id, channelId: 'wa', matched: true, state: 'connected', generation: 1, socket });
  app.telegram.entries.set('tg', { tenantId: tenant.id, channelId: 'tg', token: 'synthetic', state: 'connected', stopped: false });
  app.telegram.call = async (entry, method, payload) => { calls.push(['telegram', method, payload]); return true; };
  const principal = (agentId, capabilities = TYPING, extra = {}) => {
    const created = principals.create(admin, tenant.id, { name: `Serviço ${agentId}`, agentId, capabilities, channelIds: ['site', 'wa', 'tg'], departmentIds: ['sac', 'unassigned'], dailyRequests: 200, maxConcurrent: 3, ttlHours: 24, ...extra });
    return { ...created, actor: principals.authenticate('Bearer ' + created.token) };
  };
  const mcp = async token => {
    const client = new Client({ name: 'typing-synthetic-client', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/agent/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const conversation = id => store.getConversation(store.tenant(admin, tenant.id), id);
  const receipts = id => store.db.prepare('SELECT count(*) n FROM service_principal_receipts WHERE principal_id=?').get(id).n;
  const usage = id => store.db.prepare('SELECT coalesce(sum(requests),0) n FROM service_principal_usage WHERE principal_id=?').get(id).n;
  t.after(async () => {
    app.gateway.entries.delete('wa'); app.telegram.entries.delete('tg');
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); store.close();
  });
  return { app, store, api, admin, tenant, principal, mcp, calls, socket, conversation, receipts, usage, webchat };
}

test('MCP anuncia elozi_send_typing só com presence.typing e envia composing/paused pela presença do WhatsApp', async t => {
  const f = await fixture(t), owner = f.principal('ext'), plain = f.principal('ext', TYPING.filter(value => value !== 'presence.typing'));
  const client = await f.mcp(owner.token), tools = (await client.listTools()).tools, tool = tools.find(item => item.name === 'elozi_send_typing');
  assert.ok(tool, 'ferramenta anunciada com a concessão');
  assert.deepEqual(tool.inputSchema.required, ['requestId', 'conversationId', 'state']);
  assert.deepEqual(tool.inputSchema.properties.state.enum, ['composing', 'paused']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal((await (await f.mcp(plain.token)).listTools()).tools.some(item => item.name === 'elozi_send_typing'), false, 'sem concessão não aparece');
  const before = f.conversation('wa-own');
  const result = await client.callTool({ name: 'elozi_send_typing', arguments: { requestId: 'typing-0001', conversationId: 'wa-own', state: 'composing' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { requestId: 'typing-0001', conversationId: 'wa-own', channelId: 'wa', channelKind: 'whatsapp_qr', state: 'composing', supported: true, sent: true });
  assert.deepEqual(f.calls, [['subscribe', JID], ['presence', 'composing', JID]]);
  const paused = await client.callTool({ name: 'elozi_send_typing', arguments: { requestId: 'typing-0002', conversationId: 'wa-own', state: 'paused' } });
  assert.equal(paused.structuredContent.sent, true); assert.deepEqual(f.calls.at(-1), ['presence', 'paused', JID]);
  const after = f.conversation('wa-own');
  assert.equal(after.version, before.version, 'nenhuma versão nova'); assert.equal(after.messages.length, before.messages.length, 'nenhuma mensagem na linha do tempo');
  assert.equal(f.receipts(owner.principal.id), 0, 'sem recibo'); assert.equal(f.usage(owner.principal.id), 0, 'sem cota diária');
  // Without the grant the call is refused even if the client forces the name.
  const refused = await (await f.mcp(plain.token)).callTool({ name: 'elozi_send_typing', arguments: { requestId: 'typing-0003', conversationId: 'wa-own', state: 'composing' } });
  assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error.status, 403);
  const me = await client.callTool({ name: 'elozi_me', arguments: {} });
  assert.deepEqual(me.structuredContent.typing, { enabled: true, states: ['composing', 'paused'], minIntervalMs: TYPING_MIN_INTERVAL_MS, perHour: 1200, quotaFree: true, receipt: false });
});

test('autoridade é a da resposta privada: só a conversa do próprio agente, nunca fila, outro agente ou grupo', async t => {
  const f = await fixture(t), owner = f.principal('ext');
  for (const conversationId of ['wa-other', 'wa-queue', 'wa-group']) {
    await assert.rejects(f.api.sendTyping(owner.actor, { requestId: `typing-${conversationId}`, conversationId, state: 'composing' }), status(403), conversationId);
  }
  await assert.rejects(f.api.sendTyping(owner.actor, { requestId: 'typing-missing', conversationId: 'nao-existe', state: 'composing' }), status(404));
  await assert.rejects(f.api.sendTyping(owner.actor, { requestId: 'typing-bad-state', conversationId: 'wa-own', state: 'recording' }), status(400));
  await assert.rejects(f.api.sendTyping(owner.actor, { requestId: 'typing-extra', conversationId: 'wa-own', state: 'composing', text: 'x' }), status(400));
  // Channel outside the identity's scope.
  const narrow = f.principal('ext', TYPING, { channelIds: ['site'] });
  await assert.rejects(f.api.sendTyping(narrow.actor, { requestId: 'typing-scope', conversationId: 'wa-own', state: 'composing' }), status(403));
  // Conversation handed to the team: the agent loses the indicator with the reply.
  f.store.mutate(f.admin, f.tenant.id, 'Equipe assume', state => { const item = state.conversations.find(value => value.id === 'wa-own'); item.owner = 'human'; item.version++; });
  await assert.rejects(f.api.sendTyping(owner.actor, { requestId: 'typing-human', conversationId: 'wa-own', state: 'composing' }), status(403));
  assert.equal(f.calls.length, 0, 'nada chegou ao provedor');
});

test('ritmo: um composing a cada 4 s por conversa, replay pela requestId e limite por hora; nada consome a resposta', async t => {
  const f = await fixture(t), owner = f.principal('ext', TYPING, { dailyRequests: 2, maxConcurrent: 1 });
  let clock = Date.parse('2026-10-22T12:00:00Z'); f.api.principals.now = () => clock;
  const send = (requestId, state = 'composing') => f.api.sendTyping(owner.actor, { requestId, conversationId: 'wa-own', state });
  assert.equal((await send('pace-0001')).sent, true);
  const throttled = await send('pace-0002');
  assert.deepEqual([throttled.sent, throttled.reason, throttled.retryAfterMs], [false, 'throttled', TYPING_MIN_INTERVAL_MS]);
  assert.equal((await send('pace-0003', 'paused')).sent, true, 'paused tem ritmo próprio');
  const replay = await send('pace-0001');
  assert.equal(replay.replayed, true); assert.equal(replay.sent, true);
  await assert.rejects(send('pace-0001', 'paused'), status(409), 'mesma chave com outro pedido');
  clock += TYPING_MIN_INTERVAL_MS;
  assert.equal((await send('pace-0004')).sent, true);
  assert.equal(f.calls.filter(call => call[0] === 'presence').length, 3, 'replay e chamada contida não chegam ao provedor');
  f.api.typing.perHour = 4; clock += TYPING_MIN_INTERVAL_MS;
  assert.equal((await send('pace-0005')).sent, true);
  clock += TYPING_MIN_INTERVAL_MS;
  await assert.rejects(send('pace-0006'), error => error.status === 429 && error.retryAfter > 0);
  assert.equal(f.usage(owner.principal.id), 0); assert.equal(f.receipts(owner.principal.id), 0);
  // Quota of 2 requests and 1 concurrent execution remain whole for the real work.
  const read = f.api.read(owner.actor, 'wa-own', 'read-after-typing'); assert.equal(read.id ?? read.conversation?.id ?? 'wa-own', 'wa-own');
  assert.equal(f.usage(owner.principal.id), 1);
});

test('falha do provedor ou conexão caída devolve sent:false sem erro e sem segurar o ritmo', async t => {
  const f = await fixture(t), owner = f.principal('ext');
  f.socket.fail = true;
  const failed = await f.api.sendTyping(owner.actor, { requestId: 'fail-0001', conversationId: 'wa-own', state: 'composing' });
  assert.deepEqual([failed.supported, failed.sent, failed.reason], [true, false, 'provider']);
  f.socket.fail = false;
  assert.equal((await f.api.sendTyping(owner.actor, { requestId: 'fail-0002', conversationId: 'wa-own', state: 'composing' })).sent, true, 'falha não ocupa a janela de 4 s');
  f.app.gateway.entries.get('wa').state = 'reconnecting';
  const down = await f.api.sendTyping(owner.actor, { requestId: 'fail-0003', conversationId: 'wa-own', state: 'paused' });
  assert.deepEqual([down.supported, down.sent, down.reason], [true, false, 'disconnected']);
  f.app.gateway.entries.get('wa').state = 'connected';
  // A hanging provider is cut by the timeout, never blocking the agent.
  f.api.typing.timeoutMs = 30; f.socket.sendPresenceUpdate = () => new Promise(() => {});
  const slow = await f.api.sendTyping(owner.actor, { requestId: 'fail-0004', conversationId: 'wa-own', state: 'paused' });
  assert.deepEqual([slow.sent, slow.reason], [false, 'timeout']);
});

test('Telegram usa sendChatAction typing; webchat devolve supported:false; a resposta seguinte continua funcionando', async t => {
  const f = await fixture(t), owner = f.principal('ext');
  const tg = await f.api.sendTyping(owner.actor, { requestId: 'tg-typing-0001', conversationId: 'tg-own', state: 'composing' });
  assert.deepEqual([tg.supported, tg.sent, tg.channelKind], [true, true, 'telegram']);
  assert.deepEqual(f.calls, [['telegram', 'sendChatAction', { chat_id: '123456', action: 'typing', message_thread_id: 7 }]]);
  const stop = await f.api.sendTyping(owner.actor, { requestId: 'tg-typing-0002', conversationId: 'tg-own', state: 'paused' });
  assert.deepEqual([stop.supported, stop.sent, stop.reason], [true, false, 'expires']);
  // Webchat: no typing signal in the adapter, clean answer instead of an error; the reply then goes out normally.
  const challenge = f.webchat.challenge({ tenantId: f.tenant.id, channelId: 'site', origin });
  const session = f.webchat.openSession({ tenantId: f.tenant.id, channelId: 'site', origin, challenge: challenge.challenge, name: 'Visitante' });
  await f.webchat.receive({ token: session.token, text: 'Qual o prazo?', clientMessageId: 'typing-site-0001', origin });
  const site = f.store.tenant(f.admin, f.tenant.id).conversations.find(item => item.channelId === 'site');
  f.api.claimConversation(owner.actor, { requestId: 'claim-site-0001', conversationId: site.id, version: site.version });
  const web = await f.api.sendTyping(owner.actor, { requestId: 'web-0001', conversationId: site.id, state: 'composing' });
  assert.deepEqual([web.supported, web.sent, web.reason], [false, false, 'channel']);
  const reply = await f.api.sendReply(owner.actor, { requestId: 'reply-after-typing', conversationId: site.id, version: f.conversation(site.id).version, text: 'Chega amanhã.' });
  assert.equal(reply.receipt.state, 'confirmed');
});

test('digitação revalida autorização depois da inscrição de presença', async t => {
  const f = await fixture(t), owner = f.principal('ext');
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  f.socket.presenceSubscribe = async () => { entered(); await gate; };
  const pending = f.api.sendTyping(owner.actor, { requestId: 'typing-await-auth', conversationId: 'wa-own', state: 'composing' });
  await waiting;
  f.store.mutate(f.admin, f.tenant.id, 'Transferência sintética durante inscrição', state => { state.conversations.find(c => c.id === 'wa-own').owner = 'human'; });
  resume();
  await assert.rejects(pending, error => [403, 409].includes(error.status));
  assert.equal(f.calls.filter(call => call[0] === 'presence').length, 0);
});

test('digitação não envia presença tardia se a inscrição terminar depois do timeout', async t => {
  const f = await fixture(t), owner = f.principal('ext');
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  f.socket.presenceSubscribe = async () => { entered(); await gate; };
  f.api.typing.timeoutMs = 20;
  const pending = f.api.sendTyping(owner.actor, { requestId: 'typing-await-timeout', conversationId: 'wa-own', state: 'composing' });
  await waiting;
  const result = await pending;
  assert.equal(result.sent, false); assert.equal(result.reason, 'timeout');
  resume(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call[0] === 'presence').length, 0);
});

test('adaptadores: WhatsApp só envia chatstate a contato direto conectado; Telegram ignora outro transporte', async () => {
  const sent = [], socket = { sendPresenceUpdate: async (...args) => sent.push(args) };
  const gateway = { entries: new Map([['wa', { tenantId: 't1', matched: true, state: 'connected', generation: 1, socket }]]), closing: false, now: Date.now };
  const send = input => WhatsAppGateway.prototype.sendTyping.call(gateway, { tenantId: 't1', channel: { id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }, state: 'composing', ...input });
  assert.deepEqual(await send({ conversation: { remoteJid: '12345@lid' } }), { supported: true, sent: true });
  assert.deepEqual(await send({ conversation: { remoteJid: '1203630@g.us' } }), { supported: false, sent: false, reason: 'conversation' });
  assert.deepEqual(await send({ tenantId: 't2', conversation: { remoteJid: JID } }), { supported: true, sent: false, reason: 'disconnected' }, 'outra empresa nunca usa o socket');
  assert.deepEqual(await WhatsAppGateway.prototype.sendTyping.call(gateway, { tenantId: 't1', channel: { id: 'wa', kind: 'whatsapp_cloud', transport: 'meta' }, conversation: { remoteJid: JID }, state: 'composing' }), { supported: false, sent: false, reason: 'channel' });
  assert.deepEqual(sent, [['composing', '12345@lid']]);
  assert.deepEqual(await TelegramGateway.prototype.sendTyping.call({ entries: new Map() }, { tenantId: 't1', channel: { id: 'x', transport: 'telegram-user' }, conversation: {}, state: 'composing' }), { supported: false, sent: false, reason: 'channel' });
});
