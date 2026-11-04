import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { forwardMessageContent, forwardingFingerprint, FORWARD_MEDIA_MAX_BYTES } from '../public/forwarding.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const documentBytes = Buffer.from('Documento privado sintético de encaminhamento.\n', 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function reached(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Barreira não alcançada: ' + label)), 2500); })]); }
  finally { clearTimeout(timer); }
}

// All state, blobs, cookies and identities are synthetic and confined to this
// in-memory app. Only loopback HTTP and fake native transports are exercised.
async function fixture(t, { sourceChannel = 'webchat', destinationChannel = 'wa2' } = {}) {
  const key = randomBytes(32), deliveries = [], telegramCalls = [], forbiddenCalls = [], releases = [];
  let uncertain = false, sequence = 0;
  const denied = async () => { forbiddenCalls.push('external'); throw new Error('External access forbidden in forwarding HTTP fixture'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: denied,
    mediaOptions: { directory: null, authKey: key }, gatewayOptions: { authKey: key, socketFactory: denied, downloadMediaImpl: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1);
      assert.ok(['sendMessage', 'sendPhoto', 'sendDocument', 'sendAudio', 'sendVoice', 'sendVideo'].includes(method));
      telegramCalls.push({ method, body: options.body });
      if (uncertain) throw new Error('Synthetic lost confirmation');
      return { ok: true, json: async () => ({ ok: true, result: { chat: { id: 123456 }, message_id: ++sequence } }) };
    } }, metaOptions: { authKey: key, fetchImpl: denied }, emailChannelOptions: { authKey: key, fetchImpl: denied },
    mcpFetchImpl: denied, googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const release of releases) release();
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
    assert.equal(forbiddenCalls.length, 0, 'No external provider, login, polling or media download may run');
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, headers: res.headers, bytes,
          data: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString()) : null,
          cookie: (res.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Forwarding HTTP fixture request timed out')));
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Admin encaminhamento QA', username: 'forward.owner', password: password() } });
  assert.equal(owner.status, 200);
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  owner.id = actor.userId;
  const createTenant = async name => {
    const result = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name, segment: 'QA sintético' } });
    assert.equal(result.status, 201); return result.data;
  };
  const tenant = await createTenant('Encaminhamento HTTP QA'), other = await createTenant('Outra empresa encaminhamento QA');
  const path = `/api/tenants/${tenant.id}`;
  let memberSequence = 0;
  const member = async (extra = {}) => {
    const username = 'forward.member.' + ++memberSequence, secret = password();
    const result = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Atendente encaminhamento QA ' + memberSequence,
      username, password: secret, role: 'operator', tenantIds: [tenant.id], permissions: ['inbox.read', 'inbox.reply', 'inbox.transfer'], ...extra } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const signed = await request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
    assert.equal(signed.status, 200); return { ...result.data, cookie: signed.cookie,
      login: () => request('/api/auth/login', { method: 'POST', body: { username, password: secret } }) };
  };
  const alice = await member();
  app.store.mutate(actor, tenant.id, 'Fixture RAM de encaminhamento', state => {
    state.channels = [{ id: 'wa', name: 'WhatsApp origem QA', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' },
      { id: 'wa2', name: 'WhatsApp destino QA', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' },
      { id: 'tg', name: 'Telegram QA', kind: 'telegram', transport: 'telegram-bot', state: 'connected' },
      { id: 'webchat', name: 'Webchat QA', kind: 'webchat', transport: 'elozi-webchat', state: 'connected' },
      { id: 'instagram', name: 'Instagram QA', kind: 'instagram', transport: 'meta-instagram', state: 'connected' }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true, memberIds: [alice.id], distribution: 'manual', version: 1 }];
    state.defaultDepartmentId = 'support';
    const common = { departmentId: 'support', department: 'Suporte', owner: 'human', assignedUserId: alice.id, assignedUserName: alice.name,
      agentId: null, status: 'open', tags: [], remoteJid: '5511900000000@s.whatsapp.net', remoteChatId: '123456',
      remoteAliases: ['PRIVATE_FORWARD_ALIAS'], chatAliases: ['PRIVATE_FORWARD_CHAT_ALIAS'] };
    state.conversations = [{ ...common, id: 'source', contact: 'Origem sintética', channelId: sourceChannel, version: 3,
      messages: [{ id: 'source-message', kind: 'customer', text: 'Texto recebido para encaminhar.', delivery: 'received',
        senderName: 'Cliente sintético', senderId: 'PRIVATE_FORWARD_SENDER', senderJid: 'PRIVATE_FORWARD_JID',
        createdAt: '2026-10-03T10:00:00.000Z' }] },
    { ...common, id: 'destination', contact: 'Destino sintético', channelId: destinationChannel, version: 7, messages: [] }];
  });
  const gatewayActor = { role: 'reseller', resellerId: actor.resellerId, name: 'Gateway RAM sintético' };
  for (const channelId of ['wa', 'wa2']) app.gateway.entries.set(channelId, { actor: gatewayActor, tenantId: tenant.id, channelId,
    matched: true, state: 'connected', generation: 1, socket: { user: { id: '5511999990000@s.whatsapp.net' }, end() {},
      sendMessage: async (jid, content, options) => {
        deliveries.push({ channelId, jid, content, options });
        if (uncertain) throw new Error('Synthetic confirmation lost');
        return { key: { id: options.messageId } };
      } } });
  app.telegram.entries.set('tg', { actor: gatewayActor, tenantId: tenant.id, channelId: 'tg', state: 'connected',
    token: '12345:synthetic_token_only', abort: new AbortController() });
  const state = () => app.store.tenant(actor, tenant.id);
  const current = id => app.store.getConversation(state(), id);
  const source = () => current('source'), destination = () => current('destination');
  const change = callback => app.store.mutate(actor, tenant.id, 'Fixture RAM: alteração concorrente', callback);
  const context = (user = alice, conversation = source()) => ({ active: true, canReply: true, workspaceId: actor.resellerId,
    tenantId: tenant.id, userId: user.id, conversationId: conversation.id, channels: state().channels,
    permissions: ['inbox.read', 'inbox.reply'] });
  const command = (overrides = {}, user = alice, conversation = source(), target = destination()) => ({
    messageId: conversation.messages[0].id, sourceVersion: conversation.version, sourceChannelId: conversation.channelId,
    fingerprint: forwardingFingerprint(forwardMessageContent(conversation.messages[0], conversation, context(user, conversation))),
    destinationId: target.id, destinationVersion: target.version, destinationChannelId: target.channelId, idempotencyKey: randomUUID(), ...overrides });
  const forward = (body = command(), user = alice, extra = {}) => request(`${path}/conversations/source/forward`, { method: 'POST', cookie: user.cookie, body, ...extra });
  const rows = () => app.store.db.prepare('SELECT * FROM outbound_commands ORDER BY created_at').all();
  const mediaRows = () => app.store.db.prepare('SELECT * FROM media_attachments ORDER BY created_at').all();
  const addMedia = async ({ bytes = png, mime = 'image/png', name = 'Foto privada.png', kind = 'image', text = 'Legenda original' } = {}) => {
    const original = source(), mediaContext = { tenantId: tenant.id, conversationId: original.id, channelId: original.channelId };
    const descriptor = { mime, name, kind, size: bytes.length }, pending = app.media.placeholder(mediaContext, descriptor);
    const metadata = await app.media.save(pending.id, mediaContext, bytes, descriptor);
    change(value => { value.conversations[0].messages[0].attachments = [metadata]; value.conversations[0].messages[0].text = text; });
    return metadata;
  };
  const barrier = (object, method, { after = false } = {}) => {
    const original = object[method].bind(object), entered = deferred(), resume = deferred(); let calls = 0;
    releases.push(resume.resolve);
    object[method] = async (...args) => {
      const first = ++calls === 1;
      if (after) {
        const value = await original(...args);
        if (first) { entered.resolve(); await resume.promise; }
        return value;
      }
      if (first) { entered.resolve(); await resume.promise; }
      return original(...args);
    };
    return { entered: () => reached(entered.promise, method), release: resume.resolve, calls: () => calls };
  };
  return { app, request, owner, actor, alice, tenant, other, path, member, state, current, source, destination, change,
    context, command, forward, rows, mediaRows, addMedia, barrier, deliveries, telegramCalls,
    providerCount: () => deliveries.length + telegramCalls.length, uncertain: value => { uncertain = value; } };
}

function assertPublicConversation(result) {
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.id, 'destination');
  assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_FORWARD_|remoteJid|remoteChatId|senderJid|forwardOrigin/);
}
function assertRejected(result, expected) {
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(result.status), `${result.status}: ${JSON.stringify(result.data)}`);
  assert.equal(typeof result.data?.error, 'string');
}
function assertNoDispatch(c, { mediaCount = 0, outboxCount = 0 } = {}) {
  assert.equal(c.providerCount(), 0); assert.equal(c.rows().length, outboxCount); assert.equal(c.mediaRows().length, mediaCount);
  assert.equal(c.destination().messages.filter(message => message.kind === 'human').length, 0);
}

test('HTTP encaminhamento deriva texto da origem no servidor, conserva origem e expõe só destino autorizado', async t => {
  const c = await fixture(t), before = structuredClone(c.source()), input = c.command();
  const result = await c.forward(input); assertPublicConversation(result);
  assert.equal(c.deliveries.length, 1); assert.deepEqual(c.deliveries[0].content, { text: before.messages[0].text });
  assert.deepEqual(c.source(), before); assert.equal(result.data.messages.at(-1).authorUserId, c.alice.id);
  assert.equal(result.data.messages.at(-1).delivery, 'sent');
  const [row] = c.rows(), payload = JSON.parse(row.payload);
  assert.equal(row.state, 'confirmed'); assert.equal(row.attempts, 1);
  assert.equal(payload.text, before.messages[0].text); assert.equal(typeof payload.forwardOrigin, 'object');
  assert.ok(JSON.stringify(payload.forwardOrigin).includes(c.alice.id)); assert.ok(JSON.stringify(payload.forwardOrigin).includes('source-message'));
});

test('HTTP encaminhamento permite origens nativas WhatsApp e Telegram além de Webchat', async t => {
  for (const sourceChannel of ['wa', 'tg', 'webchat']) await t.test(sourceChannel, async t => {
    const c = await fixture(t, { sourceChannel }); assertPublicConversation(await c.forward()); assert.equal(c.providerCount(), 1);
  });
});

test('HTTP encaminhamento copia imagem privada para o contexto do destino sem URL ou arquivo do cliente', async t => {
  const c = await fixture(t), original = await c.addMedia(), input = c.command(), before = structuredClone(c.source());
  const result = await c.forward(input); assertPublicConversation(result);
  const message = result.data.messages.at(-1), copied = message.attachments[0];
  assert.notEqual(copied.id, original.id); assert.equal(copied.name, original.name); assert.equal(copied.mime, 'image/png');
  assert.equal(copied.size, png.length); assert.equal(copied.status, 'ready'); assert.deepEqual(c.deliveries[0].content.image, png);
  assert.equal(c.deliveries[0].content.caption, 'Legenda original'); assert.deepEqual(c.source(), before);
  assert.equal(c.mediaRows().length, 2); assert.equal(c.app.media.blobs.size, 2);
  const read = await c.request(`${c.path}/conversations/destination/attachments/${copied.id}`, { cookie: c.alice.cookie });
  assert.equal(read.status, 200); assert.deepEqual(read.bytes, png); assert.match(read.headers['cache-control'], /(?:^|,\s*)no-store(?:,|$)/);
  assert.equal((await c.request(`${c.path}/conversations/destination/attachments/${original.id}`, { cookie: c.alice.cookie })).status, 404);
  assert.equal((await c.request(`${c.path}/conversations/source/attachments/${copied.id}`, { cookie: c.alice.cookie })).status, 404);
  assert.equal((await c.request(`${c.path}/conversations/destination/attachments/${copied.id}`)).status, 401);
  const payload = JSON.parse(c.rows()[0].payload); assert.deepEqual(payload.attachmentIds, [copied.id]);
  assert.ok(payload.forwardOrigin); assert.doesNotMatch(JSON.stringify(payload), /https?:\/\/|PRIVATE_FORWARD_/);
});

test('HTTP encaminhamento Telegram preserva bytes, MIME, nome e tópico do documento privado', async t => {
  const c = await fixture(t, { destinationChannel: 'tg' });
  c.change(state => { state.conversations[1].threadId = 77; });
  const original = await c.addMedia({ bytes: documentBytes, mime: 'text/plain', name: 'Relatório reservado.txt', kind: 'document' });
  const result = await c.forward(); assertPublicConversation(result);
  assert.equal(c.telegramCalls.length, 1); const call = c.telegramCalls[0];
  assert.equal(call.method, 'sendDocument'); assert.equal(call.body.get('chat_id'), '123456'); assert.equal(call.body.get('message_thread_id'), '77');
  assert.equal(call.body.get('caption'), 'Legenda original'); const sentFile = call.body.get('document');
  assert.equal(sentFile.name, original.name); assert.equal(sentFile.type, original.mime); assert.deepEqual(Buffer.from(await sentFile.arrayBuffer()), documentBytes);
});

test('HTTP encaminhamento rejeita notas, rascunhos e conteúdos privados antes de copiar ou registrar envio', async t => {
  const variants = [{ kind: 'note' }, { internal: true }, { private: true }, { draft: true }, { visibility: 'internal' },
    { kind: 'human', delivery: 'pending' }, { kind: 'human', delivery: 'unconfirmed' }, { kind: 'human', delivery: 'failed' }];
  for (const variant of variants) await t.test(JSON.stringify(variant), async t => {
    const c = await fixture(t), body = c.command(); c.change(state => Object.assign(state.conversations[0].messages[0], variant));
    assertRejected(await c.forward(body), 400); assertNoDispatch(c);
  });
});

test('HTTP encaminhamento exige mensagem única da origem e fingerprint do conteúdo atual', async t => {
  for (const variant of ['missing-message', 'duplicate-message', 'fingerprint', 'message-other-conversation']) await t.test(variant, async t => {
    const c = await fixture(t), body = c.command();
    if (variant === 'missing-message') body.messageId = 'forged-message';
    if (variant === 'duplicate-message') c.change(state => { state.conversations[0].messages.push({ ...state.conversations[0].messages[0] }); });
    if (variant === 'fingerprint') body.fingerprint = 'forged-fingerprint';
    if (variant === 'message-other-conversation') c.change(state => { state.conversations[0].messages[0].conversationId = 'destination'; });
    assertRejected(await c.forward(body), variant === 'fingerprint' ? 409 : 404); assertNoDispatch(c);
  });
});

test('HTTP encaminhamento não aceita texto, URL, attachmentIds, autoria ou escopo fornecidos pelo cliente', async t => {
  const c = await fixture(t);
  for (const field of ['text', 'caption', 'url', 'attachmentIds', 'attachment', 'actorUserId', 'tenantId', 'workspaceId', 'sourceId', 'replyToMessageId', 'forwardOrigin']) {
    const body = c.command({ [field]: field === 'attachmentIds' ? [randomUUID()] : 'forged-value' });
    assertRejected(await c.forward(body), 400);
  }
  assertNoDispatch(c);
});

test('HTTP encaminhamento valida identificadores, versões e todos os campos obrigatórios sem efeito parcial', async t => {
  const c = await fixture(t);
  for (const field of ['messageId', 'sourceVersion', 'sourceChannelId', 'fingerprint', 'destinationId', 'destinationVersion', 'destinationChannelId', 'idempotencyKey']) {
    const body = c.command(); delete body[field]; assertRejected(await c.forward(body), 400);
  }
  for (const extra of [{ sourceVersion: '3' }, { sourceVersion: 0 }, { sourceVersion: 3.5 }, { destinationVersion: '7' },
    { destinationVersion: -1 }, { messageId: null }, { fingerprint: {} }, { idempotencyKey: 'short' }]) assertRejected(await c.forward(c.command(extra)), 400);
  assertNoDispatch(c);
});

test('HTTP encaminhamento exige sessão, origem HTTP e workspace autorizado', async t => {
  const c = await fixture(t), body = c.command();
  assertRejected(await c.forward(body, { cookie: '' }), 401);
  assertRejected(await c.forward(body, c.alice, { headers: { Origin: 'https://foreign.example.test' } }), 403);
  assertRejected(await c.forward(body, c.alice, { headers: { 'X-Elozi-Workspace': 'foreign-workspace' } }), 403);
  const foreign = await c.request('/api/auth/register', { method: 'POST', body: { fiscalDocument: syntheticFiscalDocument(), name: 'Outro painel QA', email: 'forward-other@example.test', password: password(), company: 'Outro painel QA' } });
  assert.equal(foreign.status, 200); assertRejected(await c.forward(body, { cookie: foreign.cookie }), 404);
  assertNoDispatch(c);
});

test('HTTP encaminhamento exige permissão e escopo nos dois atendimentos, inclusive para proprietário válido', async t => {
  for (const variant of ['no-permission', 'source-scope', 'destination-scope', 'disabled', 'tenant-membership']) await t.test(variant, async t => {
    const c = await fixture(t, { sourceChannel: 'wa' });
    const extra = variant === 'no-permission' ? { permissions: ['inbox.read'] }
      : variant === 'source-scope' ? { scopeRules: { [c.tenant.id]: { channelIds: ['wa2'], departmentIds: ['support'] } } }
      : variant === 'destination-scope' ? { scopeRules: { [c.tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } } }
      : variant === 'tenant-membership' ? { tenantIds: [c.other.id] } : {};
    const user = await c.member(extra);
    c.change(state => { state.departments[0].memberIds.push(user.id); for (const item of state.conversations) item.assignedUserId = user.id; });
    const body = c.command({}, user);
    if (variant === 'disabled') assert.equal((await c.request(`/api/users/${user.id}/disable`, { method: 'POST', cookie: c.owner.cookie, body: {} })).status, 200);
    assertRejected(await c.forward(body, user), variant === 'disabled' ? 401 : 403); assertNoDispatch(c);
  });
});

test('HTTP encaminhamento requer o responsável humano da origem e do destino, não apenas colaboração', async t => {
  for (const target of ['source', 'destination']) for (const variant of ['queue', 'closed', 'other-owner', 'collaborator']) await t.test(target + ':' + variant, async t => {
    const c = await fixture(t), bob = await c.member(), body = c.command();
    c.change(state => {
      state.departments[0].memberIds.push(bob.id); const item = state.conversations.find(value => value.id === target);
      if (variant === 'queue') { item.owner = 'queue'; item.assignedUserId = null; }
      if (variant === 'closed') item.status = 'closed';
      if (['other-owner', 'collaborator'].includes(variant)) item.assignedUserId = bob.id;
      if (variant === 'collaborator') item.participants = [{ userId: c.alice.id }];
    });
    assertRejected(await c.forward(body), 409); assertNoDispatch(c);
  });
});

test('HTTP encaminhamento bloqueia versão/canal divergentes, próprio destino e cruzamento entre empresas', async t => {
  for (const variant of ['source-version', 'destination-version', 'source-channel', 'destination-channel', 'same-conversation', 'other-tenant']) await t.test(variant, async t => {
    const c = await fixture(t), body = c.command();
    if (variant === 'source-version') body.sourceVersion--;
    if (variant === 'destination-version') body.destinationVersion--;
    if (variant === 'source-channel') body.sourceChannelId = 'wa';
    if (variant === 'destination-channel') body.destinationChannelId = 'tg';
    if (variant === 'same-conversation') { body.destinationId = 'source'; body.destinationVersion = body.sourceVersion; body.destinationChannelId = body.sourceChannelId; }
    if (variant === 'other-tenant') {
      c.app.store.mutate(c.actor, c.other.id, 'Fixture RAM: destino em outra empresa', state => { state.conversations.push({ ...c.destination(), id: 'foreign-destination' }); });
      body.destinationId = 'foreign-destination';
    }
    assertRejected(await c.forward(body), variant === 'other-tenant' ? 404 : ['source-channel', 'destination-channel', 'same-conversation'].includes(variant) ? [400, 409] : 409);
    assertNoDispatch(c);
  });
});

test('HTTP encaminhamento bloqueia transportes sem capacidade e canais desconectados antes de criar outbox', async t => {
  for (const variant of ['source-capability', 'destination-capability', 'destination-disconnected', 'source-channel-removed', 'destination-session-removed']) await t.test(variant, async t => {
    const c = await fixture(t), body = c.command();
    c.change(state => {
      if (variant === 'source-capability') state.channels.find(item => item.id === body.sourceChannelId).transport = 'meta-instagram';
      if (variant === 'destination-capability') state.channels.find(item => item.id === body.destinationChannelId).transport = 'elozi-webchat';
      if (variant === 'destination-disconnected') state.channels.find(item => item.id === body.destinationChannelId).state = 'disconnected';
      if (variant === 'source-channel-removed') state.channels = state.channels.filter(item => item.id !== body.sourceChannelId);
    });
    if (variant === 'destination-session-removed') c.app.gateway.entries.delete('wa2');
    assertRejected(await c.forward(body), variant === 'source-channel-removed' ? 403 : [400, 409]); assertNoDispatch(c);
  });
});

test('HTTP encaminhamento lê mídia somente na origem registrada e bloqueia metadados fora da mensagem', async t => {
  for (const variant of ['foreign-file', 'wrong-message', 'unavailable', 'too-large']) await t.test(variant, async t => {
    const c = await fixture(t), original = await c.addMedia(), body = c.command();
    c.change(state => {
      const file = state.conversations[0].messages[0].attachments[0];
      if (variant === 'foreign-file') file.id = randomUUID();
      if (variant === 'wrong-message') file.messageId = 'different-message';
      if (variant === 'unavailable') file.status = 'unavailable';
      if (variant === 'too-large') file.size = FORWARD_MEDIA_MAX_BYTES + 1;
    });
    if (['foreign-file', 'unavailable', 'too-large'].includes(variant)) {
      const message = c.source().messages[0], content = { messageId: message.id, kind: message.kind, text: message.text,
        attachment: { ...message.attachments[0], messageId: message.id, voice: false } };
      body.fingerprint = forwardingFingerprint(content);
    }
    assertRejected(await c.forward(body), variant === 'unavailable' ? 409 : variant === 'too-large' ? 413 : 404);
    assertNoDispatch(c, { mediaCount: 1 }); assert.equal(c.app.media.metadata(original.id, { tenantId: c.tenant.id, conversationId: 'source', channelId: 'webchat' }).status, 'ready');
  });
});

test('HTTP encaminhamento respeita quota do destino sem apagar mídia da origem ou iniciar transporte', async t => {
  const c = await fixture(t); await c.addMedia(); c.app.media.maxTenantBytes = png.length;
  assertRejected(await c.forward(), 413); assertNoDispatch(c, { mediaCount: 1 }); assert.equal(c.app.media.blobs.size, 1);
});

test('HTTP retry confirmado retorna destino fresco com versões avançadas sem copiar ou enviar novamente', async t => {
  const c = await fixture(t); await c.addMedia(); const body = c.command(); assertPublicConversation(await c.forward(body));
  c.change(state => { state.conversations[0].version += 4; state.conversations[1].version += 5;
    state.conversations[1].messages.push({ id: 'fresh-destination-message', kind: 'customer', text: 'Chegou depois', delivery: 'received' }); });
  const retried = await c.forward(body); assertPublicConversation(retried);
  assert.equal(retried.data.version, c.destination().version); assert.ok(retried.data.messages.some(item => item.id === 'fresh-destination-message'));
  assert.equal(c.providerCount(), 1); assert.equal(c.mediaRows().length, 2); assert.equal(c.rows().length, 1); assert.equal(c.rows()[0].attempts, 1);
});

test('HTTP retry confirmado ainda reautoriza origem e destino e não devolve DTO depois de perder responsabilidade', async t => {
  for (const target of ['source', 'destination']) await t.test(target, async t => {
    const c = await fixture(t), body = c.command(); assertPublicConversation(await c.forward(body));
    c.change(state => { const item = state.conversations.find(value => value.id === target); item.owner = 'queue'; item.assignedUserId = null; item.version++; });
    assertRejected(await c.forward(body), 409); assert.equal(c.providerCount(), 1); assert.equal(c.rows().length, 1);
  });
});

test('HTTP recibo confirmado continua legível após desconexão do destino sem nova cópia ou transporte', async t => {
  const c = await fixture(t); await c.addMedia(); const body = c.command(); assertPublicConversation(await c.forward(body));
  c.change(state => { state.channels.find(item => item.id === 'wa2').state = 'disconnected'; });
  c.app.gateway.entries.get('wa2').state = 'disconnected';
  assertPublicConversation(await c.forward(body)); assert.equal(c.providerCount(), 1); assert.equal(c.mediaRows().length, 2);
  assert.equal(c.rows()[0].state, 'confirmed'); assert.equal(c.rows()[0].attempts, 1);
});

test('HTTP não devolve DTO após revogação durante confirmação do provedor e preserva o recibo confirmado', async t => {
  for (const variant of ['source-owner', 'permission']) await t.test(variant, async t => {
    const c = await fixture(t); await c.addMedia(); const body = c.command();
    const hold = c.barrier(c.app.gateway.entries.get('wa2').socket, 'sendMessage', { after: true });
    const sending = c.forward(body); await hold.entered(); assert.equal(c.providerCount(), 1);
    if (variant === 'permission') assert.equal((await c.request(`/api/users/${c.alice.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { permissions: ['inbox.read'] } })).status, 200);
    else c.change(state => { state.conversations[0].owner = 'queue'; state.conversations[0].assignedUserId = null; state.conversations[0].version++; });
    hold.release(); assertRejected(await sending, variant === 'permission' ? [401, 403] : 409);
    assert.equal(c.rows()[0].state, 'confirmed'); assert.equal(c.rows()[0].attempts, 1);
    assert.equal(c.mediaRows().length, 2); assert.equal(c.providerCount(), 1);
    if (variant === 'permission') {
      assert.equal((await c.request(`/api/users/${c.alice.id}`, { method: 'PATCH', cookie: c.owner.cookie,
        body: { permissions: ['inbox.read', 'inbox.reply', 'inbox.transfer'] } })).status, 200);
      const signed = await c.alice.login(); assert.equal(signed.status, 200); c.alice.cookie = signed.cookie;
    }
    c.change(state => { for (const item of state.conversations) { item.owner = 'human'; item.assignedUserId = c.alice.id; item.version++; } });
    assertPublicConversation(await c.forward(body)); assert.equal(c.providerCount(), 1); assert.equal(c.mediaRows().length, 2);
    assert.equal(c.rows().length, 1); assert.equal(c.rows()[0].attempts, 1);
  });
});

test('HTTP chave idempotente não pode ser reutilizada com outra origem, destino, ator, fingerprint ou versões', async t => {
  for (const variant of ['source', 'destination', 'actor', 'fingerprint', 'source-version', 'destination-version']) await t.test(variant, async t => {
    const c = await fixture(t), body = c.command(); assertPublicConversation(await c.forward(body));
    let endpoint = `${c.path}/conversations/source/forward`, user = c.alice, changed = { ...body };
    if (variant === 'source') {
      c.change(state => { state.conversations.push({ ...state.conversations[0], id: 'another-source' }); }); endpoint = `${c.path}/conversations/another-source/forward`;
    }
    if (variant === 'destination') {
      c.change(state => { state.conversations.push({ ...state.conversations[1], id: 'another-destination', version: body.destinationVersion, messages: [] }); }); changed.destinationId = 'another-destination';
    }
    if (variant === 'actor') {
      user = await c.member(); c.change(state => { state.departments[0].memberIds.push(user.id); for (const item of state.conversations) item.assignedUserId = user.id; });
    }
    if (variant === 'fingerprint') { c.change(state => { state.conversations[0].messages[0].text = 'Outra mensagem válida'; }); changed.fingerprint = c.command().fingerprint; }
    if (variant === 'source-version') changed.sourceVersion++;
    if (variant === 'destination-version') changed.destinationVersion++;
    assertRejected(await c.request(endpoint, { method: 'POST', cookie: user.cookie, body: changed }), 409);
    assert.equal(c.providerCount(), 1); assert.equal(c.rows().length, 1);
  });
});

test('HTTP chamadas concorrentes com a mesma chave produzem só uma cópia, uma outbox e um envio', async t => {
  const c = await fixture(t); await c.addMedia(); const body = c.command(), hold = c.barrier(c.app.media, 'upload', { after: true });
  const first = c.forward(body); await hold.entered();
  assertRejected(await c.forward(body), 409); assert.equal(hold.calls(), 1); assert.equal(c.providerCount(), 0);
  hold.release(); assertPublicConversation(await first); assertPublicConversation(await c.forward(body));
  assert.equal(hold.calls(), 1); assert.equal(c.mediaRows().length, 2); assert.equal(c.rows().length, 1); assert.equal(c.providerCount(), 1);
});

test('HTTP recusa de outra chave do mesmo ator mantém a trava da cópia que continua em andamento', async t => {
  const c = await fixture(t); await c.addMedia(); const body = c.command(), hold = c.barrier(c.app.media, 'read', { after: true });
  const first = c.forward(body); await hold.entered();
  assertRejected(await c.forward(c.command()), 429);
  assertRejected(await c.forward(c.command()), 429);
  assert.equal(hold.calls(), 1); assertNoDispatch(c, { mediaCount: 1 });
  hold.release(); assertPublicConversation(await first); assert.equal(c.providerCount(), 1);
});

test('HTTP revalida origem após await de leitura e não copia ou envia depois de revogação', async t => {
  for (const variant of ['source-owner', 'destination-owner', 'permission', 'source-content']) await t.test(variant, async t => {
    const c = await fixture(t); await c.addMedia(); const body = c.command(), read = c.barrier(c.app.media, 'read', { after: true });
    let uploads = 0; const originalUpload = c.app.media.upload.bind(c.app.media);
    c.app.media.upload = async (...args) => { uploads++; return originalUpload(...args); };
    const sending = c.forward(body); await read.entered();
    if (variant === 'permission') assert.equal((await c.request(`/api/users/${c.alice.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { permissions: ['inbox.read'] } })).status, 200);
    else c.change(state => {
      if (variant === 'source-content') state.conversations[0].messages[0].text = 'Origem mudou durante leitura';
      else { const item = state.conversations[variant === 'source-owner' ? 0 : 1]; item.owner = 'queue'; item.assignedUserId = null; item.version++; }
    });
    read.release(); assertRejected(await sending, variant === 'permission' ? 401 : 409);
    assert.equal(uploads, 0); assertNoDispatch(c, { mediaCount: 1 });
  });
});

test('HTTP revalida após a cópia privada e não registra outbox quando a origem perde autorização', async t => {
  const c = await fixture(t); await c.addMedia(); const body = c.command(), copy = c.barrier(c.app.media, 'upload', { after: true });
  const sending = c.forward(body); await copy.entered();
  c.change(state => { state.conversations[0].owner = 'queue'; state.conversations[0].assignedUserId = null; state.conversations[0].version++; });
  copy.release(); assertRejected(await sending, 409); assert.equal(c.providerCount(), 0); assert.equal(c.rows().length, 0);
  assert.equal(c.destination().messages.length, 0); assert.equal(c.source().messages[0].attachments[0].status, 'ready');
});

test('HTTP falha ao conferir referência da cópia não mascara revogação nem retém trava ou bytes em claro', async t => {
  const c = await fixture(t), originalFile = await c.addMedia(), body = c.command();
  let plainBytes, failedQueries = 0;
  const originalRead = c.app.media.read.bind(c.app.media), originalPrepare = c.app.store.db.prepare.bind(c.app.store.db);
  c.app.media.read = async (...args) => { const value = await originalRead(...args); if (args[0] === originalFile.id) plainBytes = value.bytes; return value; };
  const copy = c.barrier(c.app.media, 'upload', { after: true }), sending = c.forward(body); await copy.entered();
  c.app.store.db.prepare = sql => {
    if (sql.startsWith('SELECT 1 FROM outbound_commands WHERE tenant_id=? AND EXISTS') && failedQueries++ === 0) throw new Error('Synthetic reference query unavailable');
    return originalPrepare(sql);
  };
  c.change(state => { state.conversations[0].owner = 'queue'; state.conversations[0].assignedUserId = null; state.conversations[0].version++; });
  copy.release(); assertRejected(await sending, 409); assert.equal(failedQueries, 1);
  assert.ok(plainBytes.every(byte => byte === 0)); assert.equal(c.providerCount(), 0); assert.equal(c.rows().length, 0);
  c.app.store.db.prepare = originalPrepare;
  c.change(state => { state.conversations[0].owner = 'human'; state.conversations[0].assignedUserId = c.alice.id; state.conversations[0].version++; });
  assertPublicConversation(await c.forward(c.command({ idempotencyKey: body.idempotencyKey })));
  assert.equal(c.providerCount(), 1); assert.equal(copy.calls(), 2);
});

test('HTTP beforeSend revalida origem, permissões e fingerprint depois de copiar e registrar, antes do provedor', async t => {
  for (const variant of ['source-owner', 'permission', 'source-content']) await t.test(variant, async t => {
    const c = await fixture(t); await c.addMedia(); const body = c.command(), hold = c.barrier(c.app.outbox, 'beforeSend');
    const sending = c.forward(body); await hold.entered(); assert.equal(c.rows().length, 1); assert.equal(c.mediaRows().length, 2);
    if (variant === 'permission') assert.equal((await c.request(`/api/users/${c.alice.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { permissions: ['inbox.read'] } })).status, 200);
    else c.change(state => {
      if (variant === 'source-content') state.conversations[0].messages[0].text = 'Mensagem alterada antes do transporte';
      else { state.conversations[0].owner = 'queue'; state.conversations[0].assignedUserId = null; state.conversations[0].version++; }
    });
    hold.release(); assertRejected(await sending, variant === 'permission' ? 401 : 409);
    assert.equal(c.providerCount(), 0); assert.equal(c.destination().messages.filter(message => message.kind === 'human').length, 0); assert.equal(c.rows()[0].state, 'failed');
  });
});

test('HTTP retry pendente reaproveita arquivo privado e payload confiável sem segunda cópia', async t => {
  const c = await fixture(t); await c.addMedia(); const body = c.command();
  let copies = 0; const originalUpload = c.app.media.upload.bind(c.app.media);
  c.app.media.upload = async (...args) => { copies++; return originalUpload(...args); };
  c.app.outbox.beforeSend = async () => { throw new Error('Synthetic persistence temporarily unavailable'); };
  assertRejected(await c.forward(body), 503); assert.equal(c.rows()[0].state, 'pending'); assert.equal(c.rows()[0].attempts, 0);
  const savedPayload = JSON.parse(c.rows()[0].payload), savedAttachment = savedPayload.attachmentIds[0];
  assert.equal(copies, 1); assert.equal(c.providerCount(), 0);
  c.app.outbox.beforeSend = async () => {};
  const result = await c.forward(body); assertPublicConversation(result);
  assert.equal(copies, 1); assert.equal(c.mediaRows().length, 2); assert.equal(c.providerCount(), 1);
  assert.deepEqual(JSON.parse(c.rows()[0].payload), savedPayload); assert.equal(result.data.messages.at(-1).attachments[0].id, savedAttachment);
});

test('HTTP retry pendente mantém CAS da origem e do destino depois de falha antes do envio', async t => {
  for (const target of ['source', 'destination']) await t.test(target, async t => {
    const c = await fixture(t); await c.addMedia(); const body = c.command();
    c.app.outbox.beforeSend = async () => { throw new Error('Synthetic pending persistence'); };
    assertRejected(await c.forward(body), 503); c.app.outbox.beforeSend = async () => {};
    c.change(state => { state.conversations.find(value => value.id === target).version++; });
    assertRejected(await c.forward(body), 409); assert.equal(c.providerCount(), 0); assert.equal(c.mediaRows().length, 2); assert.equal(c.rows().length, 1);
  });
});

test('HTTP envio incerto preserva origem e não repete transporte ou cópia ao reenviar a mesma chave', async t => {
  const c = await fixture(t); await c.addMedia(); const body = c.command(); c.uncertain(true);
  assertRejected(await c.forward(body), 502); assert.equal(c.rows()[0].state, 'unknown'); assert.equal(c.rows()[0].attempts, 1);
  assert.equal(c.destination().messages.at(-1).delivery, 'unconfirmed'); c.uncertain(false);
  assertRejected(await c.forward(body), 409); assertRejected(await c.forward(body), 409);
  assert.equal(c.providerCount(), 1); assert.equal(c.mediaRows().length, 2); assert.equal(c.rows().length, 1); assert.equal(c.rows()[0].attempts, 1);
});
