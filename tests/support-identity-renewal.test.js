import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { WebchatIdentity } from '../src/webchat-identity.js';
import { WebchatGateway } from '../src/channel-webchat.js';
import { KnowledgeBase } from '../src/knowledge.js';
import { AgentMemory } from '../src/agent-memory.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { SupportAssistant } from '../src/support-assistant.js';

const origin = 'https://support-identity.example.test';
const channelId = 'identity-support';
const agentId = 'identity-support-agent';
const question = 'Como configurar o acesso da Elozi pelo canal de webchat?';
const usefulReply = 'Abra Configurações e escolha o canal de webchat para configurar o acesso da Elozi.';
const originalContext = { accountName: 'Conta sintética', product: 'Elozi', pagePath: '/settings' };
const reorderedContext = { pagePath: '/settings', product: 'Elozi', accountName: 'Conta sintética' };
const ownFact = 'PRIVATE-SYNTHETIC-OWN-CONTACT-FACT';
const testOptions = { timeout: 10000 };
const code = expected => error => error.code === expected;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const store = new Store(':memory:');
  let clock = Date.now(), assistant, acceptIncoming = false, authorized = true;
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const owner = auth.insertUser({ username: 'support-renewal-reviewer', name: 'Revisor sintético' },
    Buffer.alloc(16, 19), Buffer.alloc(64, 19), 'reseller', [], 'mep-demo');
  const admin = auth.actor(owner), authority = { reauthorize: () => auth.actor(owner) };
  const tenant = store.createTenant(admin, { name: 'Suporte renovação RAM', segment: 'QA' });
  const otherTenant = store.createTenant(admin, { name: 'Outra empresa renovação RAM', segment: 'QA' });
  const providerEntered = deferred(), providerRelease = deferred(), events = [], sent = [], pending = [];
  const scopes = [{ resellerId: admin.resellerId, tenantId: tenant.id, channelId,
    origins: [origin], products: ['Elozi'] }];
  for (const [tenantId, channels] of [[tenant.id, [channelId, 'other-support-channel']],
    [otherTenant.id, ['foreign-support-channel']]]) {
    store.mutate(admin, tenantId, 'Fixture sintética de identidade e suporte', state => {
      state.channels = channels.map(id => ({ id, kind: 'webchat', state: 'planned' }));
      state.agents = [agentId, 'other-support-agent'].map(id => ({ id, name: 'Suporte sintético',
        provider: 'hermes', configured: true, mode: 'copilot', version: 1,
        description: 'Ajude a configurar o acesso à Elozi.', tools: [] }));
    });
  }
  const gateway = new WebchatGateway(store, {
    operations: new Operations(store, auth, { now: () => clock }), now: () => clock,
    onIncoming: (entry, cid, mid) => acceptIncoming ? assistant.receive(entry, cid, mid) : null
  });
  const secrets = encryptedChannelSecrets(store.db, Buffer.alloc(32, 29));
  const identity = new WebchatIdentity(store, {
    secrets, channelContext: input => gateway.identityContext(input), now: () => clock
  });
  gateway.identity = identity;
  const keys = new Map();
  for (const [tenantId, id] of [[tenant.id, channelId], [tenant.id, 'other-support-channel'],
    [otherTenant.id, 'foreign-support-channel']]) {
    gateway.configure(admin, tenantId, id, { version: 0, origins: [origin] });
    identity.configure(admin, tenantId, id, { version: 0, enabled: true, issuer: origin,
      externalIdPrefix: 'synthetic-support', scope: 'account-user' }, authority);
    keys.set(id, identity.createKey(admin, tenantId, id, { version: 1 }, authority));
  }
  const knowledge = new KnowledgeBase(store);
  let source = knowledge.create(admin, tenant.id, { title: 'Configurar Elozi webchat',
    content: 'Para configurar o acesso da Elozi, abra Configurações e escolha o canal de webchat.' });
  source = knowledge.publish(admin, tenant.id, source.id, { version: source.version });
  knowledge.setGrants(admin, tenant.id, agentId, { version: 1,
    grants: [{ sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash }] });
  const memory = new AgentMemory(store, {
    access: actor => actor.userId === admin.userId && actor.resellerId === admin.resellerId,
    resolveActor: run => run.actorUserId === admin.userId ? admin : null
  });
  const runtime = new AgentRuntime(store, {
    knowledge, memory, timeoutMs: 5000, clock: () => new Date(clock),
    validateInitiator: run => run.id.startsWith('support_') ? assistant.runCurrent(run) : true,
    validateSupportIdentity: run => gateway.verifiedConversationCurrent(run.tenantId, run.conversationId),
    providerCall: async context => {
      events.push(context);
      providerEntered.resolve();
      return providerRelease.promise;
    }
  });
  assistant = new SupportAssistant(store, {
    runtime, knowledge, scopes, now: () => clock, timeoutMs: 5000,
    authorize: () => authorized,
    authorizeAdmin: actor => actor.userId === admin.userId,
    sendReply: async input => {
      input.reauthorize();
      sent.push(input);
      return { confirmed: true };
    }
  });
  assistant.configure(admin, tenant.id, channelId,
    { version: 0, enabled: true, autoReply: true, agentId });
  store.mutate(admin, tenant.id, 'Instrução privada sintética do suporte', state => {
    const channel = state.channels.find(item => item.id === channelId);
    channel.webchat.assistantInstructions = 'Você atende a Elozi usando as fontes e memórias revisadas do contato identificado.';
    channel.centralSupportScope = { origins: [origin], productIds: ['elozi'] };
  });
  t.after(async () => {
    providerRelease.resolve(usefulReply);
    await Promise.allSettled(pending);
    assistant.close(); await gateway.close(); store.close();
  });
  const state = (id = tenant.id) => store.tenant(admin, id);
  const context = (extra = {}) => ({ tenantId: tenant.id, channelId, origin, ...extra });
  const token = (patch = {}, { channel = channelId, key = keys.get(channel) } = {}) => {
    const instant = Math.floor(clock / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: key.kid })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ v: 2, accountId: 'account-a', sub: 'user-a', iss: origin,
      aud: 'elozi:webchat:' + channel, email: 'same@example.test', email_verified: true,
      name: 'Pessoa sintética', locale: 'pt-BR', iat: instant - 1, exp: instant + 599,
      jti: randomUUID(), ctx: originalContext, ...patch })).toString('base64url');
    return `${header}.${body}.${createHmac('sha256', key.secret).update(`${header}.${body}`).digest('base64url')}`;
  };
  const open = (patch = {}, extra = {}) => {
    const input = context(extra), challenge = gateway.challenge(input);
    return gateway.openSession({ ...input, challenge: challenge.challenge,
      identityToken: token(patch, { channel: input.channelId }), name: 'Formulário ignorado' });
  };
  const renew = (session, patch = {}) => gateway.renewIdentity({ token: session.token,
    ...context(), identityToken: token(patch) });
  const conversationFor = (session, tenantId = tenant.id, channel = channelId) =>
    state(tenantId).conversations.find(item => item.channelId === channel &&
      item.webchatVisitor?.externalId === session.contact.externalId);
  const privateCounts = () => Object.fromEntries(['webchat_sessions', 'webchat_visitor_profiles',
    'webchat_identity_jti', 'webchat_identity_sessions'].map(table =>
    [table, store.db.prepare('SELECT count(*) n FROM ' + table).get().n]));
  const proof = conversation => store.db.prepare(
    'SELECT session_id,origin,issuer,external_id,kid,identity_version,verified_at,expires_at,revoked_at FROM webchat_identity_sessions WHERE session_id=?'
  ).get(conversation.remoteSessionId);
  const snapshot = conversation => memory.supportSnapshot(state(), state().agents.find(item => item.id === agentId),
    conversation, { authorize: () => true });
  const seedReviewed = async (session, content, { tenantId = tenant.id, channel = channelId, agent = agentId } = {}) => {
    assert.equal(acceptIncoming, false);
    await gateway.receive({ token: session.token, origin, text: 'Acesso Elozi sintético anterior.', clientMessageId: randomUUID() });
    const conversation = conversationFor(session, tenantId, channel);
    assert.ok(conversation);
    store.mutate(admin, tenantId, 'Revisor sintético assume o atendimento', value => {
      const own = value.conversations.find(item => item.id === conversation.id);
      own.owner = 'human'; own.assignedUserId = admin.userId; own.version++;
    });
    const record = memory.create(admin, tenantId, conversation.id, { agentId: agent, scope: 'contact',
      title: 'Fato revisado sintético', content, expiresAt: null, reviewed: true,
      conversationVersion: state(tenantId).conversations.find(item => item.id === conversation.id).version });
    store.mutate(admin, tenantId, 'Conversa sintética volta à fila', value => {
      const own = value.conversations.find(item => item.id === conversation.id);
      own.owner = 'queue'; own.assignedUserId = null; own.version++;
    });
    return record;
  };
  const session = open(), record = await seedReviewed(session, ownFact);
  const jobs = () => state().supportAssistantJobs || [];
  const conversation = () => conversationFor(session);
  const run = () => state().runs.find(item => item.conversationId === conversation().id);
  const begin = async () => {
    acceptIncoming = true;
    await gateway.receive({ token: session.token, origin, text: question, clientMessageId: randomUUID() });
    const draining = assistant.drain(); pending.push(draining);
    const entered = await Promise.race([providerEntered.promise.then(() => true), draining.then(() => false)]);
    assert.equal(entered, true, 'o caso deve alcançar o provider mock com identidade e memória válidas');
    assert.equal(events.length, 1);
    assert.equal(events[0].singleInference, true, 'as instruções de canal devem ativar o fluxo que fixa a identidade');
    assert.ok(run().supportMemorySnapshot, 'o caso deve exercitar a memória privada de suporte');
    assert.deepEqual(run().supportMemorySnapshot.pins.map(pin => pin.id), [record.id]);
    return { draining };
  };
  const finish = async draining => { providerRelease.resolve(usefulReply); await draining; await assistant.drain(); };
  return { store, admin, authority, tenant, otherTenant, gateway, identity, keys, memory, runtime, assistant,
    state, context, token, open, renew, session, record, seedReviewed, snapshot, proof, privateCounts,
    jobs, conversation, run, begin, finish, events, sent, advance: ms => { clock += ms; }, now: () => clock,
    revokeAuthority: () => { authorized = false; } };
}

function assertDiscarded(c) {
  assert.equal(c.events.length, 1);
  assert.equal(c.sent.length, 0);
  assert.notEqual(c.jobs()[0].state, 'completed');
  assert.ok(['invalidated', 'failed', 'cancelled'].includes(c.run().state), c.run().state);
  assert.equal(c.run().draft, null);
  assert.equal(c.state().conversations.some(item => item.messages.some(message => message.text === usefulReply)), false);
}

test('renovar a mesma identidade v2 e reordenar ctx durante o provider conclui uma única resposta útil', testOptions, async t => {
  const c = await fixture(t), beforeVisitor = structuredClone(c.conversation().webchatVisitor);
  const { draining } = await c.begin(), beforeProof = c.proof(c.conversation());
  const beforeMemory = c.snapshot(c.conversation()), contactId = c.conversation().contactId;
  c.advance(2000);
  c.renew(c.session, { ctx: reorderedContext });
  assert.deepEqual(c.conversation().webchatVisitor, beforeVisitor);
  assert.equal(c.conversation().contactId, contactId);
  assert.equal(c.gateway.verifiedConversationCurrent(c.tenant.id, c.conversation().id), true);
  const afterProof = c.proof(c.conversation());
  assert.ok(afterProof.verified_at > beforeProof.verified_at);
  assert.ok(afterProof.expires_at > beforeProof.expires_at);
  assert.deepEqual(c.snapshot(c.conversation()), beforeMemory, 'renovação válida não muda o binding da memória revisada');
  await c.finish(draining);
  assert.equal(c.events.length, 1);
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].text, usefulReply);
  assert.equal(c.sent[0].conversationId, c.conversation().id);
  assert.equal(c.jobs()[0].state, 'completed');
  assert.equal(c.conversation().supportAssistantHandoff?.active ?? false, false);
});

for (const [field, patch] of [
  ['nome', { name: 'Outro nome sintético' }],
  ['email', { email: 'changed@example.test' }],
  ['valor de ctx', { ctx: { ...originalContext, pagePath: '/billing' } }]
]) test(`renovação com mudança real de ${field} descarta o resultado pendente`, testOptions, async t => {
  const c = await fixture(t), { draining } = await c.begin();
  c.advance(2000); c.renew(c.session, patch);
  assert.equal(c.gateway.verifiedConversationCurrent(c.tenant.id, c.conversation().id), true);
  await c.finish(draining); assertDiscarded(c);
});

for (const [field, patch] of [['usuário', { sub: 'user-b' }], ['conta', { accountId: 'account-b' }]]) {
  test(`JWT v2 não renova para outro ${field} nem consome a credencial recusada`, testOptions, async t => {
    const c = await fixture(t), { draining } = await c.begin(), before = c.privateCounts();
    const visitor = structuredClone(c.conversation().webchatVisitor), cid = c.conversation().id;
    const jwt = c.token(patch);
    assert.throws(() => c.gateway.renewIdentity({ token: c.session.token, ...c.context(), identityToken: jwt }), code('identity_account_changed'));
    assert.deepEqual(c.privateCounts(), before);
    assert.deepEqual(c.conversation().webchatVisitor, visitor);
    const challenge = c.gateway.challenge(c.context());
    const other = c.gateway.openSession({ ...c.context(), challenge: challenge.challenge, identityToken: jwt });
    assert.notEqual(other.contact.externalId, c.session.contact.externalId);
    assert.deepEqual(c.gateway.history({ token: other.token, ...c.context() }).messages, []);
    await c.finish(draining);
    assert.equal(c.sent.length, 1, 'a tentativa recusada não derruba o resultado ainda válido da identidade original');
    assert.equal(c.sent[0].conversationId, cid);
    assert.equal(c.jobs()[0].state, 'completed');
  });
}

for (const [field, value] of [['userId', 'user-b'], ['accountId', 'account-b']]) {
  test(`troca efetiva indevida de visitor.${field} durante o provider nunca usa a resposta antiga`, testOptions, async t => {
    const c = await fixture(t), { draining } = await c.begin();
    const conversationId = c.conversation().id;
    c.store.mutate(c.admin, c.tenant.id, 'Fixture de binding alterado durante a inferência', state => {
      state.conversations.find(item => item.id === conversationId).webchatVisitor[field] = value;
    });
    await c.finish(draining); assertDiscarded(c);
  });
}

const liveFences = {
  'prova expirada': c => c.store.db.prepare('UPDATE webchat_identity_sessions SET expires_at=? WHERE session_id=?')
    .run(c.now() - 1, c.conversation().remoteSessionId),
  'prova revogada': c => c.store.db.prepare('UPDATE webchat_identity_sessions SET revoked_at=? WHERE session_id=?')
    .run(c.now(), c.conversation().remoteSessionId),
  logout: c => c.gateway.logout({ token: c.session.token, ...c.context() }),
  'origem da prova alterada': c => c.store.db.prepare('UPDATE webchat_identity_sessions SET origin=? WHERE session_id=?')
    .run('https://denied.example.test', c.conversation().remoteSessionId),
  'origem removida do canal': c => {
    const channel = c.state().channels.find(item => item.id === channelId);
    c.gateway.configure(c.admin, c.tenant.id, channelId,
      { version: channel.webchat.version, origins: ['https://replacement.example.test'] });
  },
  'chave revogada': c => {
    const current = c.identity.status(c.admin, c.tenant.id, channelId, {}, c.authority);
    c.identity.revokeKey(c.admin, c.tenant.id, channelId,
      { version: current.version, kid: c.keys.get(channelId).kid }, c.authority);
  },
  'versão de identidade alterada': c => c.store.mutate(c.admin, c.tenant.id, 'Fixture de versão de identidade alterada', state => {
    state.channels.find(item => item.id === channelId).webchat.identity.identityVersion++;
  }),
  'configuração de suporte alterada': c => c.store.mutate(c.admin, c.tenant.id, 'Fixture de configuração de suporte alterada', state => {
    state.channels.find(item => item.id === channelId).supportAssistant.version++;
  }),
  'instruções de canal alteradas': c => c.store.mutate(c.admin, c.tenant.id, 'Fixture de instrução alterada', state => {
    state.channels.find(item => item.id === channelId).webchat.assistantInstructions = 'Outra orientação revisada do canal.';
  }),
  'escopo revogado': c => c.assistant.replaceScopes([]),
  'autoridade revogada': c => c.revokeAuthority()
};

for (const [fence, change] of Object.entries(liveFences)) {
  test(`${fence} enquanto o provider aguarda impede envio e descarta o rascunho`, testOptions, async t => {
    const c = await fixture(t), { draining } = await c.begin();
    change(c);
    await c.finish(draining); assertDiscarded(c);
  });
}

test('renovação mantém só memória revisada do binding próprio sem texto privado nos pins ou no tenant', testOptions, async t => {
  const c = await fixture(t), foreignFacts = [
    'PRIVATE-SYNTHETIC-OTHER-ACCOUNT', 'PRIVATE-SYNTHETIC-OTHER-USER',
    'PRIVATE-SYNTHETIC-OTHER-CHANNEL', 'PRIVATE-SYNTHETIC-OTHER-TENANT', 'PRIVATE-SYNTHETIC-OTHER-AGENT'
  ];
  await c.seedReviewed(c.open({ accountId: 'account-b' }), foreignFacts[0]);
  await c.seedReviewed(c.open({ sub: 'user-b' }), foreignFacts[1]);
  await c.seedReviewed(c.open({}, { channelId: 'other-support-channel' }), foreignFacts[2], { channel: 'other-support-channel' });
  await c.seedReviewed(c.open({}, { tenantId: c.otherTenant.id, channelId: 'foreign-support-channel' }),
    foreignFacts[3], { tenantId: c.otherTenant.id, channel: 'foreign-support-channel' });
  await c.seedReviewed(c.session, foreignFacts[4], { agent: 'other-support-agent' });
  const snapshot = c.snapshot(c.conversation());
  assert.deepEqual(snapshot.pins.map(pin => pin.id), [c.record.id]);
  assert.deepEqual(snapshot.references.map(reference => reference.content), [ownFact]);
  const { draining } = await c.begin();
  c.advance(2000); c.renew(c.session, { ctx: reorderedContext });
  await c.finish(draining);
  const providerText = JSON.stringify(c.events[0].messages);
  assert.ok(providerText.includes(ownFact));
  for (const secret of foreignFacts) assert.equal(providerText.includes(secret), false, secret);
  const saved = JSON.stringify(c.run().supportMemorySnapshot);
  for (const value of [ownFact, ...foreignFacts, c.session.contact.externalId, 'same@example.test']) {
    assert.equal(saved.includes(value), false, 'pins e binding não persistem texto privado ou identificador externo');
  }
  const tenantJson = JSON.stringify(c.state());
  for (const secret of [ownFact, ...foreignFacts]) assert.equal(tenantJson.includes(secret), false, secret);
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].conversationId, c.conversation().id);
  assert.equal(c.jobs()[0].state, 'completed');
});
