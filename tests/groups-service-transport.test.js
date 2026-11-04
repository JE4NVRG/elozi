import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
import { MediaService } from '../src/media.js';
import { ServicePrincipals, serviceGroupContext } from '../src/service-principals.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { TelegramGateway } from '../src/telegram.js';

const status = expected => error => error.status === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const assignment = c => ({ owner: c.owner, assignedUserId: c.assignedUserId, assignedSupportGrantId: c.assignedSupportGrantId, participants: c.participants, agentId: c.agentId });

function fixture(t, { transport = 'whatsapp', owner = 'queue', beforeSend = async () => {} } = {}) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'transport-service-admin', name: 'Administrador sintético' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Transporte de serviço RAM', segment: 'QA' });
  const channelId = `channel-${transport}`, conversationId = `group-${transport}`, groupId = transport === 'whatsapp' ? '123-456@g.us' : '-1234';
  store.mutate(admin, tenant.id, 'Fixture de transporte', state => {
    state.agents = [{ id: 'service-agent', name: 'Agente sintético', provider: 'mcp', mode: 'copilot', configured: true, version: 1 }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }];
    state.channels = [{ id: channelId, name: 'Conexão sintética', kind: transport === 'whatsapp' ? 'whatsapp_qr' : 'telegram', transport: transport === 'whatsapp' ? 'baileys' : 'telegram-bot', state: 'connected', ...(transport === 'whatsapp' ? { allowedGroups: [groupId] } : { telegramGroups: { version: 1, mode: 'selected', groupIds: [groupId], known: [{ id: groupId, joined: true, canSend: true }] } }) }];
    state.conversations = [{ id: conversationId, channelId, departmentId: 'support', conversationKind: 'group', ...(transport === 'whatsapp' ? { remoteJid: groupId } : { remoteChatId: groupId }), version: 1, status: 'open', owner,
      assignedUserId: owner === 'human' ? 'existing-human' : null, assignedSupportGrantId: owner === 'human' ? 'existing-support' : null,
      participants: [{ userId: 'existing-participant', name: 'Participante humano' }], agentId: 'existing-agent', unread: 1,
      messages: [{ id: 'original-message', kind: 'customer', text: 'Pergunta sintética anterior', externalId: transport === 'whatsapp' ? 'synthetic-incoming' : `${groupId}:1`, createdAt: '2026-10-05T12:00:00.000Z' }] }];
    state.contacts = [];
  });
  const operations = new Operations(store, auth), principals = new ServicePrincipals(store, auth), counts = { provider: 0, media: 0, authority: 0 }, requests = [];
  const createPrincipal = name => principals.create(admin, tenant.id, { name, agentId: 'service-agent', capabilities: ['conversation.read', 'reply.send', 'message.schedule'], channelIds: [channelId], departmentIds: ['support'], dailyRequests: 100, maxConcurrent: 2, ttlHours: 24 });
  const created = createPrincipal('Serviço sintético A'), bearer = principals.authenticate(`Bearer ${created.token}`);
  const current = () => store.getConversation(store.tenant(admin, tenant.id), conversationId);
  const context = actor => ({ workspaceId: actor.workspaceId, tenantId: tenant.id, agentId: actor.agentId, conversationId, channelId, departmentId: 'support', ...serviceGroupContext(store.tenant(admin, tenant.id), current()) });
  const internal = (actor = bearer, capability = 'reply.send') => principals.executionActor(actor, capability, context(actor));
  const service = internal();
  const authorize = (actor, id, conversation) => {
    counts.authority++;
    assert.equal(id, tenant.id); assert.equal(conversation.id, conversationId);
    principals.authorizeInternalActor(actor, actor.serviceCapability, context(actor));
    return true;
  };
  operations.authorizeServiceReply = authorize;
  const media = new MediaService(store, { directory: null, authKey: randomBytes(32), keyLoader: () => assert.fail('Nenhuma chave local deve ser carregada nesta fixture RAM.') });
  const resolve = media.resolve.bind(media);
  let mediaGate = async () => {}, providerError = null;
  media.resolve = async (...args) => { counts.media++; await mediaGate(); return resolve(...args); };
  const provider = (method, peer, payload) => {
    counts.provider++; requests.push({ method, peer, payload });
    if (providerError) throw providerError;
    return transport === 'whatsapp' ? { key: { id: 'synthetic-provider-ack' } } : { message_id: 900, chat: { id: Number(peer) } };
  };
  let gateway;
  if (transport === 'whatsapp') {
    gateway = new WhatsAppGateway(store, { authKey: randomBytes(32), socketFactory: () => assert.fail('Nenhum socket real deve iniciar.'), fetchImpl: () => assert.fail('Nenhuma rede externa é permitida.') });
    gateway.entries.set(channelId, { tenantId: tenant.id, channelId, generation: 1, matched: true, state: 'connected', socket: { user: { id: '5511999900000:1@s.whatsapp.net' }, sendMessage: async (peer, payload) => provider('sendMessage', peer, payload), end() {} } });
  } else {
    gateway = new TelegramGateway(store, { authKey: randomBytes(32), polling: false, fetchImpl: () => assert.fail('Nenhuma rede externa é permitida.') });
    gateway.entries.set(channelId, { tenantId: tenant.id, channelId, state: 'connected', stopped: false, abort: new AbortController() });
    gateway.call = async (entry, method, payload) => { assert.equal(entry.channelId, channelId); return provider(method, payload instanceof FormData ? payload.get('chat_id') : payload.chat_id, payload); };
  }
  gateway.operations = operations; gateway.media = media;
  t.after(async () => { await gateway.close(); store.close(); });
  const reauthorize = actor => authorize(actor, tenant.id, current());
  const outbox = new Outbox(store, { beforeSend, authorize: (actor, id, conversation) => operations.canReply(actor, id, conversation) });
  const input = extra => ({ version: current().version, channelId, text: 'Resposta sintética do serviço', attachmentIds: [], idempotencyKey: randomUUID(), ...extra });
  const policy = (actor, body) => {
    if (transport === 'telegram') return gateway.validateOutgoing(actor, tenant.id, conversationId, body);
    return serviceGroupContext(store.tenant(admin, tenant.id), current());
  };
  const send = (actor, body) => gateway.send(actor, tenant.id, conversationId, body, { reauthorize: () => reauthorize(actor) });
  const dispatch = (body, actor = service, options = {}) => outbox.dispatch(actor, tenant.id, conversationId, body, () => send(actor, body), { reauthorize: () => reauthorize(actor), validate: () => policy(actor, body), ...options });
  const commands = () => store.db.prepare('SELECT * FROM outbound_commands WHERE tenant_id=? ORDER BY created_at,id').all(tenant.id).map(row => ({ ...row }));
  const deselect = () => store.mutate(admin, tenant.id, 'Fixture remove seleção', state => { const channel = state.channels[0]; if (transport === 'whatsapp') channel.allowedGroups = []; else { channel.telegramGroups.groupIds = []; channel.telegramGroups.version++; } });
  const revoke = () => principals.revoke(admin, tenant.id, created.principal.id, { revision: created.principal.revision });
  const upload = () => media.upload({ tenantId: tenant.id, conversationId, channelId }, { bytes: Buffer.from([255, 216, 255, 1]), name: 'imagem-sintetica.jpg', mime: 'image/jpeg' });
  return { store, admin, tenant, channelId, conversationId, groupId, operations, principals, created, bearer, service, gateway, outbox, media, counts, requests, current, context, internal, createPrincipal, authorize, input, send, dispatch, commands, deselect, revoke, upload,
    blockMedia: gate => { mediaGate = gate; }, failProvider: error => { providerError = error; } };
}

test('Operations recusa serviço sem decisão true ou prova emitida, sem usar atribuição humana', async t => {
  const f = fixture(t, { owner: 'human' }), before = structuredClone(f.current());
  for (const callback of [undefined, () => false, () => undefined, () => ({ allowed: true })]) {
    f.operations.authorizeServiceReply = callback;
    assert.throws(() => f.operations.canReply(f.service, f.tenant.id, f.current()), status(403));
  }
  f.operations.authorizeServiceReply = () => Promise.reject(new Error('Recusa assíncrona sintética'));
  assert.throws(() => f.operations.canReply(f.service, f.tenant.id, f.current()), TypeError);
  await new Promise(resolve => setImmediate(resolve));
  f.operations.authorizeServiceReply = () => true;
  assert.throws(() => f.operations.canReply({ ...f.service, userId: f.admin.userId }, f.tenant.id, f.current()), status(403));
  f.operations.authorizeServiceReply = f.authorize;
  assert.throws(() => f.operations.canReply({ ...f.service }, f.tenant.id, f.current()), status(403));
  assert.equal(f.operations.canReply(f.service, f.tenant.id, f.current()), true);
  assert.deepEqual(f.current(), before); assert.equal(f.counts.provider, 0);
});

test('Outbox exige true explícito para serviço; tags incompletas não pulam ownership', async t => {
  const f = fixture(t), before = structuredClone(f.current()), body = f.input();
  for (const authorize of [undefined, () => false, () => ({ allowed: true })]) {
    const outbox = new Outbox(f.store, { ...(authorize ? { authorize } : {}) });
    await assert.rejects(outbox.dispatch(f.service, f.tenant.id, f.conversationId, body, () => assert.fail('Serviço recusado não deve disparar.')), status(403));
  }
  const permissive = new Outbox(f.store, { authorize: () => true });
  const incomplete = { role: 'operator', resellerId: f.admin.resellerId, tenantIds: [f.tenant.id], kind: 'service' };
  await assert.rejects(permissive.dispatch(incomplete, f.tenant.id, f.conversationId, body, () => assert.fail('Tag sem serviceId não permite envio.')), status(409));
  await assert.rejects(permissive.dispatch({ ...f.service, userId: f.admin.userId }, f.tenant.id, f.conversationId, body, () => assert.fail('Identidade híbrida não pula ownership.')), status(409));
  assert.deepEqual(f.commands(), []); assert.deepEqual(f.current(), before); assert.equal(f.counts.provider, 0);
});

for (const transport of ['whatsapp', 'telegram']) {
  test(`${transport}: gateway recusa serviço sem Operations ou sem prova, antes de mensagem/provedor`, async t => {
    const f = fixture(t, { transport }), before = structuredClone(f.current()), body = f.input();
    f.gateway.operations = null;
    await assert.rejects(f.send(f.service, body), status(403));
    f.gateway.operations = f.operations; f.operations.authorizeServiceReply = undefined;
    await assert.rejects(f.send(f.service, body), status(403));
    f.operations.authorizeServiceReply = f.authorize;
    await assert.rejects(f.gateway.send({ ...f.service }, f.tenant.id, f.conversationId, body), status(403));
    assert.deepEqual(f.current(), before); assert.deepEqual(f.commands(), []); assert.equal(f.counts.media, 0); assert.equal(f.counts.provider, 0);
  });

  test(`${transport}: serviço responde sem tomar atribuição; replay mantém autoria e um disparo`, async t => {
    for (const owner of ['queue', 'human', 'agent']) {
      await t.test(owner, async t => {
        const f = fixture(t, { transport, owner }), before = structuredClone(f.current()), body = f.input();
        await f.dispatch(body);
        const current = structuredClone(f.current()), command = f.commands()[0], message = current.messages.at(-1), payload = JSON.parse(command.payload);
        assert.deepEqual(assignment(current), assignment(before)); assert.deepEqual(current.messages[0], before.messages[0]);
        assert.equal(message.kind, 'agent'); assert.equal(message.authorUserId, null); assert.equal(message.authorServiceId, f.service.serviceId);
        assert.equal(message.agentId, f.service.agentId); assert.equal(message.serviceCommandId, body.idempotencyKey); assert.equal(message.delivery, 'sent');
        assert.equal(payload.serviceId, f.service.serviceId); assert.equal(payload.serviceCapability, 'reply.send');
        assert.equal(JSON.stringify({ payload, message }).includes(f.created.token), false);
        assert.equal(command.state, 'confirmed'); assert.equal(command.attempts, 1); assert.equal(f.counts.provider, 1); assert.equal(f.requests[0].peer, f.groupId);
        assert.deepEqual(await f.dispatch(body), current); assert.deepEqual(f.commands(), [command]); assert.equal(f.counts.provider, 1); assert.equal(f.current().messages.length, 2);
        f.revoke(); await assert.rejects(f.dispatch(body), status(401));
        assert.deepEqual(f.current(), current); assert.deepEqual(f.commands(), [command]); assert.equal(f.counts.provider, 1);
      });
    }
  });

  test(`${transport}: replay fica ligado ao serviço/capacidade; pending conserva command antes de confirmar`, async t => {
    const f = fixture(t, { transport, beforeSend: async () => { throw new Error('Gate RAM indisponível'); } }), body = f.input();
    await assert.rejects(f.dispatch(body), status(503));
    const pending = f.commands()[0]; assert.equal(pending.state, 'pending'); assert.equal(pending.attempts, 0); assert.equal(f.counts.provider, 0);
    const second = f.createPrincipal('Serviço sintético B'), other = f.internal(f.principals.authenticate(`Bearer ${second.token}`)), scheduled = f.internal(f.bearer, 'message.schedule');
    for (const actor of [other, scheduled]) await assert.rejects(f.dispatch(body, actor), status(403));
    assert.deepEqual(f.commands(), [pending]); assert.equal(f.current().messages.length, 1);
    f.outbox.beforeSend = async () => {}; await f.dispatch(body);
    const confirmed = f.commands()[0]; assert.equal(confirmed.id, pending.id); assert.equal(confirmed.payload, pending.payload); assert.equal(confirmed.state, 'confirmed'); assert.equal(confirmed.attempts, 1);
    for (const actor of [other, scheduled]) await assert.rejects(f.dispatch(body, actor), status(403));
    await assert.rejects(f.dispatch({ ...body, text: 'Conteúdo alterado' }), status(409));
    assert.deepEqual(f.commands(), [confirmed]); assert.equal(f.counts.provider, 1); assert.equal(f.current().messages.length, 2);
  });

  test(`${transport}: seleção é obrigatória, inclusive depois do gate antes do provedor`, async t => {
    const entered = deferred(), resume = deferred(); let gates = 0;
    const f = fixture(t, { transport, beforeSend: async () => { if (++gates === 2) { entered.resolve(); await resume.promise; } } }), before = structuredClone(f.current());
    const sending = f.dispatch(f.input()); await entered.promise; f.deselect(); resume.resolve();
    await assert.rejects(sending, status(403));
    assert.deepEqual(f.current(), before); assert.equal(f.counts.provider, 0); assert.equal(f.counts.media, 0); assert.equal(f.commands()[0].state, 'failed');
    await assert.rejects(f.dispatch(f.input()), status(403)); assert.equal(f.commands().length, 1);
  });

  test(`${transport}: revogação ou desseleção durante mídia não cria pending nem chama provedor`, async t => {
    for (const change of ['revoke', 'deselect']) {
      await t.test(change, async t => {
        const f = fixture(t, { transport }), file = await f.upload(), entered = deferred(), resume = deferred(), before = structuredClone(f.current());
        f.blockMedia(async () => { entered.resolve(); await resume.promise; });
        const body = f.input({ attachmentIds: [file.id], text: 'Legenda sintética' }), sending = f.dispatch(body);
        await entered.promise; f[change](); resume.resolve(); await assert.rejects(sending, status(change === 'revoke' ? 401 : 403));
        assert.equal(f.counts.media, 1); assert.equal(f.counts.provider, 0); assert.deepEqual(f.current(), before);
        assert.equal(f.commands().length, 1); assert.equal(f.commands()[0].state, 'failed');
        assert.equal(f.media.metadata(file.id, { tenantId: f.tenant.id, conversationId: f.conversationId, channelId: f.channelId }).status, 'ready');
      });
    }
  });

  test(`${transport}: resultado desconhecido conserva mensagem/intenção e recusa retry cego`, async t => {
    const f = fixture(t, { transport, owner: 'agent' }), body = f.input(), before = assignment(f.current());
    f.failProvider(new Error('Resposta sintética perdida depois do disparo'));
    await assert.rejects(f.dispatch(body), error => error.status === 502 && error.code === 'OUTBOUND_UNCONFIRMED');
    const current = structuredClone(f.current()), command = f.commands()[0];
    assert.equal(command.state, 'unknown'); assert.equal(command.attempts, 1); assert.equal(current.messages.length, 2);
    assert.equal(current.messages.at(-1).delivery, 'unconfirmed'); assert.equal(current.messages.at(-1).kind, 'agent');
    assert.equal(current.messages.at(-1).authorServiceId, f.service.serviceId); assert.equal(current.messages.at(-1).serviceCommandId, body.idempotencyKey); assert.deepEqual(assignment(current), before);
    await assert.rejects(f.dispatch(body), error => error.status === 409 && error.code === 'OUTBOUND_UNCONFIRMED');
    assert.deepEqual(f.commands(), [command]); assert.deepEqual(f.current(), current); assert.equal(f.counts.provider, 1);
  });
}
