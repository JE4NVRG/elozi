import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { SUPPORT_PRODUCTS } from '../src/central-support.js';

const origin = 'https://elozi.example.test';
const status = expected => error => error.status === expected;
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const key = Buffer.alloc(32, 11), external = [], providerCalls = [];
  const deny = async () => { external.push(true); throw new Error('External network forbidden in central-support RAM fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, publicOrigin: origin,
    webchatOptions:{supportImmediate:options.supportImmediate === true},
    providerCall: async input => { providerCalls.push(input); return options.providerCall ? options.providerCall(input) : 'Abra Configurações e escolha o canal de webchat para configurar o acesso.'; }, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny },
    emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  const { store, auth, knowledge, webchat, centralSupport: central, runtime, operations } = app;
  let sequence = 0;
  const member = (role = 'reseller', resellerId = 'mep-demo', tenantIds = [], platformAdmin = false) => {
    const row = auth.insertUser({ username: 'central.support.fixture.' + ++sequence, name: 'Pessoa sintética ' + sequence }, Buffer.alloc(16, sequence), Buffer.alloc(64, sequence), role, tenantIds, resellerId, { platformAdmin });
    const session = auth.session(row); return { actor: session.actor, cookie: 'mep_session=' + session.token };
  };
  const owner = member('reseller', 'mep-demo', [], true), tenant = store.createTenant(owner.actor, { name: 'Central própria RAM', segment: 'Suporte' });
  const reseller = member(), operator = member('operator', 'mep-demo', [tenant.id]);
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('customer-workspace', JSON.stringify({ name: 'Cliente sintético', accountKind: 'reseller' }));
  const customer = member('reseller', 'customer-workspace'), customerTenant = store.createTenant(customer.actor, { name: 'Empresa cliente RAM', segment: 'Cliente' });
  store.mutate(owner.actor, tenant.id, 'Fixture sintética da central', state => {
    state.channels = [{ id: 'own-webchat', kind: 'webchat', name: 'Site próprio', state: 'planned' }, { id: 'own-wa', kind: 'whatsapp_qr', state: 'planned' }];
    state.agents = [{ id: 'support-hermes', name: 'Hermes Suporte', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Ajude com acesso aos produtos próprios.', tools: [] }];
  });
  webchat.configure(owner.actor, tenant.id, 'own-webchat', { version: 0, origins: [origin] });
  let source = knowledge.create(owner.actor, tenant.id, { title: 'Acesso Elozi', category: 'Suporte', content: 'Para configurar o acesso à Elozi, abra Configurações e escolha o canal de webchat. A equipe humana pode continuar o atendimento de suporte.' });
  source = knowledge.publish(owner.actor, tenant.id, source.id, { version: source.version });
  knowledge.setGrants(owner.actor, tenant.id, 'support-hermes', { version: 1, grants: [{ sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash }] });
  const input = extra => ({ version: 0, enabled: true, autoReply: false, agentId: 'support-hermes', productIds: ['elozi'], ...extra });
  const configure = extra => central.configure(owner.actor, tenant.id, 'own-webchat', input(extra));
  const open = (value = origin) => {
    const challenge = webchat.challenge({ tenantId: tenant.id, channelId: 'own-webchat', origin: value });
    return webchat.openSession({ tenantId: tenant.id, channelId: 'own-webchat', origin: value, challenge: challenge.challenge, name: 'Visitante sintético' });
  };
  const receive = (visitor, text = 'Como configurar meu acesso?', key = 'central-message-0001', value = origin) => webchat.receive({ token: visitor.token, text, clientMessageId: key, origin: value });
  const state = () => store.tenant(owner.actor, tenant.id), conversation = () => state().conversations[0], jobs = () => state().supportAssistantJobs || [];
  const request = (path, { method = 'GET', cookie, body } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method,
      headers: { 'Content-Type': 'application/json', Host: 'elozi.example.test', ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
    });
    pending.setTimeout(5000, () => pending.destroy(new Error('Loopback fixture exceeded deadline'))); pending.on('error', reject);
    pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  t.after(async () => {
    await central.close(); await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'no real inference or external transport was used'); store.close();
  });
  return { app, store, auth, knowledge, webchat, central, runtime, operations, owner, reseller, operator, customer, tenant, customerTenant, source,
    input, configure, open, receive, state, conversation, jobs, request, providerCalls, member };
}

test('administrador atual do workspace registra seus produtos; operador e workspace distinto são recusados', t => {
  const f = fixture(t);
  for (const actor of [f.operator.actor, { ...f.operator.actor, role: 'reseller', platformAdmin: true }, { role: 'reseller', resellerId: 'mep-demo', platformAdmin: true }, { ...f.reseller.actor, supportGrantId: 'delegated' }]) {
    assert.throws(() => f.central.configure(actor, f.tenant.id, 'own-webchat', f.input()), status(403));
    assert.throws(() => f.central.catalog(actor, f.tenant.id), status(403));
  }
  assert.throws(() => f.central.catalog(f.customer.actor, f.tenant.id), status(404));
  assert.equal(f.state().channels[0].centralSupportScope, undefined);
  const configured = f.central.configure(f.reseller.actor, f.tenant.id, 'own-webchat', f.input()); assert.equal(configured.enabled, true); assert.equal(configured.autoReply, false);
  const saved = f.state().channels[0].centralSupportScope;
  assert.equal(saved.configuredBy, f.reseller.actor.userId); assert.deepEqual(saved.productIds, ['elozi']); assert.deepEqual(saved.origins, [origin]);
  assert.deepEqual(f.central.catalog(f.owner.actor, f.tenant.id).products, SUPPORT_PRODUCTS);
});

test('revogação do administrador do workspace é observada, mesmo com ator de sessão antigo', t => {
  const f = fixture(t); f.configure();
  f.store.db.prepare("UPDATE auth_users SET role='operator',platform_admin=0 WHERE id=?").run(f.owner.actor.userId);
  assert.throws(() => f.central.catalog(f.owner.actor, f.tenant.id), status(403));
  assert.throws(() => f.configure({ version: 1, enabled: false }), status(403));
  assert.equal(f.state().channels[0].supportAssistant.enabled, true);
});

test('cadastro rejeitado não deixa registro parcial nem muda a revisão do assistente', t => {
  const f = fixture(t), before = f.state().channels[0];
  for (const invalid of [{ productIds: ['third-party'] }, { productIds: ['elozi', 'elozi'] }, { productIds: [] }, { autoReply: 'true' },
    { enabled: false, autoReply: false, agentId: '' }, { enabled: false, autoReply: false, agentId: 'with space' }, { version: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => f.configure(invalid), status(400)); assert.deepEqual(f.state().channels[0], before);
  }
  assert.throws(() => f.central.configure(f.owner.actor, f.tenant.id, 'own-webchat', f.input(), { reauthorize: () => false }), status(403));
  assert.deepEqual(f.state().channels[0], before);
  assert.throws(() => f.central.configure(f.owner.actor, f.tenant.id, 'own-webchat', f.input(), { reauthorize: async () => true }), status(500));
  assert.deepEqual(f.state().channels[0], before);
});

test('produtos registrados usam origens exatas já autorizadas; visitante não pode definir o escopo', async t => {
  const f = fixture(t); f.configure({ autoReply: true, productIds: ['urlpivot', 'elozi'] });
  assert.deepEqual(f.central.assistant.scopes[0].products, ['Elozi', 'URLPivot']);
  assert.throws(() => f.webchat.challenge({ tenantId: f.tenant.id, channelId: 'own-webchat', origin: 'https://other.example.test' }), status(403));
  await assert.rejects(f.webchat.receive({ token: f.open().token, origin, text: 'Como configurar acesso?', clientMessageId: 'central-message-0001', productIds: ['elozi'] }), status(400));
  assert.equal(f.jobs().length, 0); assert.equal(f.providerCalls.length, 0);
});

test('conexão WhatsApp e registro sem webchat ativo não criam escopo de suporte', t => {
  const f = fixture(t);
  assert.throws(() => f.central.configure(f.owner.actor, f.tenant.id, 'own-wa', f.input()), status(409));
  f.store.mutate(f.customer.actor, f.customerTenant.id, 'Registro cliente sintético indevido', state => {
    state.channels = [{ id: 'customer-webchat', kind: 'webchat', transport: 'elozi-webchat', centralSupportScope: { productIds: ['elozi'], origins: [origin] } }];
  });
  f.central.reload(); assert.equal(f.central.scopes().some(scope => scope.tenantId === f.customerTenant.id), false);
  assert.equal(f.central.receive({ tenantId: f.customerTenant.id, channelId: 'customer-webchat', actor: f.customer.actor }, 'conversation', 'message'), null);
});

test('resposta automática explícita envia agent uma vez com runtime e gateway reais, sem impersonar pessoa', async t => {
  const f = fixture(t); f.configure({ autoReply: true }); const visitor = f.open(); await f.receive(visitor);
  await f.central.drain(); await f.central.drain(); await f.receive(visitor);
  const messages = f.conversation().messages, sent = messages.filter(message => message.kind === 'agent');
  assert.equal(f.providerCalls.length, 1); assert.equal(sent.length, 1); assert.equal(sent[0].delivery, 'sent'); assert.equal(sent[0].agentId, 'support-hermes');
  assert.equal(sent[0].authorUserId, undefined); assert.equal(messages.filter(message => message.kind === 'human').length, 0);
  assert.equal(f.conversation().owner, 'queue'); assert.equal(f.jobs()[0].state, 'completed'); assert.equal(f.conversation().version, 3);
  const history = f.webchat.history({ token: visitor.token, origin }); assert.equal(history.messages.filter(message => message.kind === 'agent').length, 1);
  assert.equal(JSON.stringify(history).includes('supportAssistant'), false); assert.equal(JSON.stringify(history).includes('scope'), false);
});

test('copiloto sem resposta automática mantém rascunho, sem disponibilizar mensagem ao visitante', async t => {
  const f = fixture(t); f.configure(); const visitor = f.open(); await f.receive(visitor); await f.central.drain();
  assert.equal(f.providerCalls.length, 1); assert.equal(f.jobs()[0].state, 'draft'); assert.equal(f.conversation().messages.length, 1);
  assert.equal(f.webchat.history({ token: visitor.token, origin }).messages.length, 1); assert.equal(f.state().runs[0].mode, 'copilot');
});

test('handoff opt-in central usa prova privada e gateway real com confirmação idempotente', async t => {
  const f = fixture(t); f.webchat.widgetConfiguration(f.owner.actor, f.tenant.id, 'own-webchat', { version: 0,
    widget: { displayName: 'Suporte sintético', handoffMessage: { 'pt-BR': 'A equipe humana continuará por aqui.', en: 'The human team will continue here.' } } });
  f.configure({ autoReply: true }); let calls = 0;
  f.central.assistant.onHandoff = async input => {
    calls++; assert.equal(f.central.authorizeHandoff(input), true);
    assert.equal(f.central.authorizeHandoff({ ...input, actor: { ...input.actor } }), false);
    assert.throws(() => f.webchat.publishHandoff({ ...input, actor: { ...input.actor } }), status(403));
    const receipt = f.webchat.publishHandoff(input);
    assert.deepEqual(f.webchat.publishHandoff(input), receipt);
    return receipt;
  };
  const visitor = f.open(); await f.receive(visitor, 'Quero falar com Jean.');
  await f.central.drain(); await f.central.drain();
  assert.equal(calls, 1); assert.equal(f.providerCalls.length, 0); assert.equal(f.jobs()[0].handoffNotification.state, 'confirmed');
  const messages = f.webchat.history({ token: visitor.token, origin }).messages;
  assert.equal(messages.filter(message => message.kind === 'agent').length, 1);
  assert.equal(messages.at(-1).text, 'A equipe humana continuará por aqui.');
  const publicState = f.central.publicState(f.tenant.id, 'own-webchat', f.conversation().id);
  assert.deepEqual({ typing: publicState.typing, state: publicState.state, handoffReason: publicState.handoffReason }, { typing: false, state: 'handoff', handoffReason: 'visitor_requested_human' });
  assert.equal(JSON.stringify(messages).includes('idempotencyKey'), false);
});

test('handoffs expirados não ocupam capacidade antes da confirmação do visitante atual', async t => {
  const f = fixture(t); f.webchat.widgetConfiguration(f.owner.actor, f.tenant.id, 'own-webchat', { version: 0,
    widget: { displayName: 'Suporte sintético', handoffMessage: { 'pt-BR': 'A equipe humana continuará por aqui.', en: 'The human team will continue here.' } } });
  f.configure({ autoReply: true }); assert.equal(f.central.assistant.concurrency, 2);
  const published = [], onHandoff = f.central.assistant.onHandoff;
  f.central.assistant.onHandoff = async input => {
    assert.equal(f.central.authorizeHandoff(input), true);
    assert.equal(f.central.authorizeHandoff({ ...input, actor: { ...input.actor } }), false);
    published.push(input.jobId); return onHandoff(input);
  };
  for (let index = 0; index < 3; index++) await f.receive(f.open(), 'Quero falar com Jean.', 'central-handoff-capacity-' + index);
  const jobs = f.jobs(); assert.equal(jobs.length, 3);
  for (const job of jobs.slice(0, 2)) f.store.db.prepare('UPDATE webchat_sessions SET expires_at=? WHERE conversation_id=?').run(0, job.conversationId);
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.central.drain();
    assert.deepEqual(published, [jobs[2].id]);
    assert.deepEqual(f.jobs().map(job => job.handoffNotification?.state || null), [null, null, 'confirmed']);
  }
  for (const job of f.jobs()) {
    const conversation = f.state().conversations.find(item => item.id === job.conversationId);
    assert.equal(conversation.supportAssistantHandoff.active, true);
    assert.equal(conversation.messages.filter(message => message.kind === 'agent').length, job.id === jobs[2].id ? 1 : 0);
  }
  assert.equal(f.providerCalls.length, 0);
});

for (const changed of ['session', 'origin']) test(`confirmação revalida ${changed} revogada após seleção antes do despacho`, async t => {
  const f = fixture(t); f.webchat.widgetConfiguration(f.owner.actor, f.tenant.id, 'own-webchat', { version: 0,
    widget: { displayName: 'Suporte sintético', handoffMessage: { 'pt-BR': 'A equipe humana continuará por aqui.', en: 'The human team will continue here.' } } });
  f.configure({ autoReply: true }); await f.receive(f.open(), 'Quero falar com Jean.');
  let selected = 0, published = 0;
  const notify = f.central.assistant._notifyHandoff.bind(f.central.assistant), onHandoff = f.central.assistant.onHandoff;
  f.central.assistant.onHandoff = async input => { published++; return onHandoff(input); };
  f.central.assistant._notifyHandoff = (scope, job) => {
    selected++;
    assert.equal(f.central.assistant._notificationContext(scope, job).conversation.supportAssistantHandoff.active, true);
    if (changed === 'session') f.store.db.prepare('UPDATE webchat_sessions SET expires_at=? WHERE conversation_id=?').run(0, job.conversationId);
    else f.webchat.configure(f.owner.actor, f.tenant.id, 'own-webchat', { version: 1, origins: ['https://new.elozi.example.test'] });
    return notify(scope, job);
  };
  await f.central.drain(); await f.central.drain();
  assert.equal(selected, 1); assert.equal(published, 0);
  assert.equal(f.jobs()[0].handoffNotification, undefined);
  assert.equal(f.jobs()[0].state, 'handoff'); assert.equal(f.conversation().supportAssistantHandoff.active, true);
  assert.equal(f.conversation().messages.filter(message => message.kind === 'agent').length, 0);
  assert.equal(f.providerCalls.length, 0);
});

test('canal configurado inicia preparação sem esperar o próximo polling e sem bloquear recebimento', async t => {
  const gate=deferred(), f=fixture(t,{supportImmediate:true,providerCall:()=>gate.promise});
  t.after(()=>gate.resolve('Abra Configurações e escolha o canal de webchat para configurar o acesso.'));
  f.webchat.widgetConfiguration(f.owner.actor,f.tenant.id,'own-webchat',{version:0,widget:{assistantInstructions:'Responda brevemente usando apenas conhecimento revisado.'}});
  f.configure({autoReply:true}); const received=await f.receive(f.open());
  assert.ok(received.messageId); await settle(); assert.equal(f.providerCalls.length,1);
  assert.equal(f.conversation().messages.filter(m=>m.kind==='agent').length,0);
  assert.equal(f.central.publicState(f.tenant.id,'own-webchat',f.conversation().id).typing,true);
  gate.resolve('Abra Configurações e escolha o canal de webchat para configurar o acesso.');
  await Promise.all([...f.central.assistant.pendingTasks]);
  assert.equal(f.conversation().messages.filter(m=>m.kind==='agent').length,1);
});

test('resposta válida após 35 s usa o prazo do runtime e é enviada uma única vez', async t => {
  const gate = deferred(), f = fixture(t, { providerCall: () => gate.promise });
  t.after(() => gate.resolve('Abra Configurações e escolha o canal de webchat para configurar o acesso.'));
  f.configure({ autoReply: true }); await f.receive(f.open());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const draining = f.central.drain(); await settle();
  assert.equal(f.providerCalls.length, 1);
  t.mock.timers.tick(40000); await settle();
  assert.equal(f.providerCalls[0].signal.aborted, false);
  assert.equal(f.jobs()[0].state, 'running');
  gate.resolve('Abra Configurações e escolha o canal de webchat para configurar o acesso.');
  await draining; await f.central.drain();
  assert.equal(f.jobs()[0].state, 'completed');
  assert.equal(f.providerCalls.length, 1);
  assert.equal(f.conversation().messages.filter(message => message.kind === 'agent').length, 1);
});

test('instrução própria do canal entra no runtime interno e não modifica o agente compartilhado', async t => {
  const f = fixture(t), instructions = 'Você atende o MepMail. Use somente fontes revisadas. Não invente acesso administrativo.';
  f.webchat.widgetConfiguration(f.owner.actor, f.tenant.id, 'own-webchat', { version: 0, widget: { assistantInstructions: instructions } });
  const before = structuredClone(f.state().agents[0]); f.configure({ autoReply: true }); await f.receive(f.open()); await f.central.drain();
  assert.equal(f.providerCalls.length, 1); assert.match(f.providerCalls[0].messages[0].content, /Você atende o MepMail/);
  assert.deepEqual(f.state().agents[0], before); assert.equal(f.jobs()[0].state, 'completed');
  assert.equal(JSON.stringify(f.jobs()).includes(instructions), false); assert.equal(JSON.stringify(f.webchat.publicAccess(f.tenant.id, 'own-webchat', origin)).includes(instructions), false);
});

for (const changed of [false, true]) test(`memória revisada entra no suporte verificado e revalida antes do envio: changed=${changed}`, async t => {
  const gate = deferred(), f = fixture(t, { providerCall: changed ? () => gate.promise : undefined });
  await f.app.loadIntegrations(); // Initialize only the RAM custody with the fixture's synthetic serviceKey.
  f.webchat.widgetConfiguration(f.owner.actor, f.tenant.id, 'own-webchat', { version: 0, widget: { assistantInstructions: 'Você atende suporte próprio com fatos revisados.' } });
  const authority = { reauthorize: () => f.owner.actor };
  f.webchat.identity.configure(f.owner.actor, f.tenant.id, 'own-webchat', { version: 0, enabled: true, issuer: origin, externalIdPrefix: 'mepmail' }, authority);
  const key = f.webchat.identity.createKey(f.owner.actor, f.tenant.id, 'own-webchat', { version: 1 }, authority);
  const verified = () => {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: key.kid })).toString('base64url');
    const now = Math.floor(Date.now() / 1000), claims = { iss: origin, aud: 'elozi:webchat:own-webchat', sub: 'synthetic-product-user',
      email: 'synthetic@example.test', email_verified: true, name: 'Visitante verificado sintético', locale: 'pt-BR', iat: now - 1, exp: now + 599, jti: randomUUID() };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url'), identityToken = head + '.' + body + '.' + createHmac('sha256', key.secret).update(head + '.' + body).digest('base64url');
    const challenge = f.webchat.challenge({ tenantId: f.tenant.id, channelId: 'own-webchat', origin });
    return f.webchat.openSession({ tenantId: f.tenant.id, channelId: 'own-webchat', origin, challenge: challenge.challenge, identityToken });
  };
  f.configure({ autoReply: true }); await f.receive(verified(), 'Como configurar meu acesso?', 'support-memory-origin');
  let historical = f.conversation();
  f.operations.assign(f.owner.actor, f.tenant.id, historical.id, { version: historical.version, owner: 'human', assignedUserId: f.owner.actor.userId });
  historical = f.state().conversations.find(item => item.id === historical.id);
  const content = 'SYNTHETIC-REVIEWED-SUPPORT-FACT', record = f.app.memory.create(f.owner.actor, f.tenant.id, historical.id, {
    agentId: 'support-hermes', scope: 'contact', title: 'Preferência confirmada', content, reviewed: true, expiresAt: null, conversationVersion: historical.version });
  const visitor = verified(); await f.receive(visitor, 'Como configurar meu acesso?', 'support-memory-current');
  const cid = f.state().conversations.find(item => item.id !== historical.id).id;
  const pending = f.central.drain(); await settle(); assert.equal(f.providerCalls.length, 1);
  assert.equal(f.providerCalls[0].messages.some(message => message.content.includes(content)), true);
  if (changed) {
    f.app.memory.update(f.owner.actor, f.tenant.id, historical.id, record.id, { version: record.version,
      conversationVersion: historical.version, title: record.title, content: 'Fato substituído pela revisão humana.', expiresAt: null, reviewed: true });
    gate.resolve('Abra Configurações e escolha o canal de webchat para configurar o acesso.');
  }
  await pending;
  const current = f.state().conversations.find(item => item.id === cid), job = f.jobs().find(item => item.conversationId === cid);
  assert.equal(current.messages.filter(item => item.kind === 'agent').length, changed ? 0 : 1);
  assert.equal(job.state, changed ? 'handoff' : 'completed');
  assert.equal(JSON.stringify(f.runtime._visibleRun(f.state(), f.state().runs.find(item => item.id === job.runId), f.owner.actor)).includes(content), false);
});

test('actor interno forjado por cópia não obtém prova privada nem escreve resposta', async t => {
  const f = fixture(t); f.configure({ autoReply: true }); const send = f.central.assistant.sendReply; let rejected = false;
  f.central.assistant.sendReply = async input => {
    assert.throws(() => f.webchat.sendAssistant({ ...input, actor: { ...input.actor } }), status(403)); rejected = true;
    return send(input);
  };
  await f.receive(f.open()); await f.central.drain(); assert.equal(rejected, true); assert.equal(f.jobs()[0].state, 'completed');
  assert.equal(f.conversation().messages.filter(message => message.kind === 'agent').length, 1);
});

test('humano assume durante preparação e cancela o envio, preservando responsável real', async t => {
  const gate = deferred(), f = fixture(t, { providerCall: () => gate.promise }); f.configure({ autoReply: true }); await f.receive(f.open());
  const pending = f.central.drain(); await settle(); const c = f.conversation();
  f.operations.assign(f.owner.actor, f.tenant.id, c.id, { version: c.version, owner: 'human', assignedUserId: f.operator.actor.userId });
  gate.resolve('Abra Configurações para configurar seu acesso.'); await pending;
  assert.equal(f.conversation().assignedUserId, f.operator.actor.userId); assert.equal(f.conversation().owner, 'human');
  assert.equal(f.conversation().messages.filter(message => message.kind === 'agent').length, 0); assert.equal(f.providerCalls.length, 1);
});

test('pedido explícito de humano pausa preparação posterior sem trocar atribuição de quem já atende', async t => {
  const f = fixture(t); f.configure({ autoReply: true }); const visitor = f.open(); await f.receive(visitor, 'Quero falar com um atendente humano.');
  await f.central.drain(); await f.receive(visitor, 'Como configurar meu acesso?', 'central-message-0002'); await f.central.drain();
  assert.equal(f.providerCalls.length, 0); assert.equal(f.conversation().supportAssistantHandoff.active, true); assert.ok(f.jobs().every(job => job.state === 'handoff'));
});

test('sessão que expira durante IA impede commit no gateway real', async t => {
  const gate = deferred(), f = fixture(t, { providerCall: () => gate.promise }); f.configure({ autoReply: true }); await f.receive(f.open());
  const pending = f.central.drain(); await settle();
  f.store.db.prepare('UPDATE webchat_sessions SET expires_at=? WHERE conversation_id=?').run(Date.now() - 1, f.conversation().id);
  gate.resolve('Abra Configurações para configurar o acesso.'); await pending;
  assert.equal(f.conversation().messages.filter(message => message.kind === 'agent').length, 0); assert.equal(f.providerCalls.length, 1);
});

test('revogar conhecimento ou origem após preparação impede resposta tardia', async t => {
  for (const changed of ['knowledge', 'origin']) {
    const gate = deferred(), f = fixture(t, { providerCall: () => gate.promise }); f.configure({ autoReply: true }); await f.receive(f.open());
    const pending = f.central.drain(); await settle();
    if (changed === 'knowledge') f.knowledge.unpublish(f.owner.actor, f.tenant.id, f.source.id, { version: f.source.version });
    else f.webchat.configure(f.owner.actor, f.tenant.id, 'own-webchat', { version: 1, enabled: true, origins: ['https://new.elozi.example.test'] });
    gate.resolve('Abra Configurações para configurar o acesso.'); await pending;
    assert.equal(f.conversation().messages.filter(message => message.kind === 'agent').length, 0); assert.equal(f.providerCalls.length, 1);
  }
});

test('configuração usa CAS, não altera seleção já aceita e invalida o job da revisão substituída', async t => {
  const gate = deferred(), f = fixture(t, { providerCall: () => gate.promise }); f.configure({ autoReply: true }); await f.receive(f.open());
  const pending = f.central.drain(); await settle();
  assert.throws(() => f.configure({ autoReply: true, productIds: ['mepmail'] }), error => [400, 409].includes(error.status));
  assert.deepEqual(f.state().channels[0].centralSupportScope.productIds, ['elozi']);
  f.configure({ version: 1, autoReply: true, productIds: ['elozi', 'mepmail'] }); gate.resolve('Abra Configurações para configurar o acesso.'); await pending;
  assert.equal(f.jobs()[0].state, 'skipped'); assert.equal(f.conversation().messages.filter(message => message.kind === 'agent').length, 0);
  assert.equal(f.state().channels[0].supportAssistant.version, 2);
});

test('HTTP catálogo/configuração exige admin do workspace e DTO comum preserva metadados privados', async t => {
  const f = fixture(t); await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const path = `/api/tenants/${f.tenant.id}`, catalog = path + '/support-assistant/catalog', config = path + '/channels/own-webchat/support-assistant';
  for (const session of [f.operator]) {
    assert.equal((await f.request(catalog, { cookie: session.cookie })).status, 403);
    assert.equal((await f.request(config, { method: 'PATCH', cookie: session.cookie, body: f.input() })).status, 403);
  }
  assert.equal((await f.request(catalog, { cookie: f.reseller.cookie })).status, 200);
  assert.equal((await f.request(catalog, { cookie: f.customer.cookie })).status, 404);
  assert.equal((await f.request(catalog)).status, 401);
  const configured = await f.request(config, { method: 'PATCH', cookie: f.owner.cookie, body: f.input({ autoReply: true }) }); assert.equal(configured.status, 200, configured.data.error);
  const visitor = f.open(); await f.receive(visitor); await f.central.drain();
  const dto = await f.request(path, { cookie: f.operator.cookie }); assert.equal(dto.status, 200, dto.data.error);
  const serialized = JSON.stringify(dto.data);
  for (const internal of ['supportAssistantJobs', 'centralSupportScope', 'supportAssistantJobId', 'supportAssistantHandoff', '"supportAssistant"']) assert.equal(serialized.includes(internal), false, internal + ' must remain private');
  const result = await f.request(catalog, { cookie: f.owner.cookie }); assert.equal(result.status, 200); assert.equal(result.data.channels[0].assistant.jobs.length, 1);
  assert.equal(result.data.channels[0].integration.source, origin + '/widget.js');
});
