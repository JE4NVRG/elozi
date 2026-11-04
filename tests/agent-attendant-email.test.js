// Agent as attendant over a transport that checks authority again after recording the message (e-mail: before and after
// the provider call). Autopilot and an external MCP agent answer once through createApp with a synthetic MepMail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';

const relaySecret = 'synthetic-relay-secret-' + 'z'.repeat(32), apiKey = 'ms_' + 'synthetic'.repeat(5);
const QUESTION = 'Qual é o prazo de entrega para as capitais?', ANSWER = 'Os pedidos são entregues em até cinco dias úteis nas capitais.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 5000, label = 'condição') {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Tempo esgotado: ${label}`); await sleep(10); }
}

async function fixture(t, { fetchImpl } = {}) {
  const key = Buffer.alloc(32, 57), external = [], sent = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio de e-mail'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, mcpFetchImpl: deny, providerCall: async () => ANSWER,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, metaOptions: { fetchImpl: deny },
    emailChannelOptions: { getDeliveryConfiguration: async () => ({ apiKey, from: 'Loja <loja@example.test>' }),
      fetchImpl: fetchImpl || (async (url, input) => { sent.push(JSON.parse(input.body)); return { ok: true, status: 200, json: async () => ({ id: `provider-${sent.length}` }) }; }) } });
  const { store, auth, knowledge, emailChannel, operations } = app;
  const row = auth.insertUser({ username: 'attendant.email.owner', name: 'Administração sintética' }, Buffer.alloc(16, 9), Buffer.alloc(64, 9), 'reseller', [], 'mep-demo');
  const admin = auth.session(row).actor, tenant = store.createTenant(admin, { name: 'Loja por e-mail', segment: 'Varejo' });
  store.mutate(admin, tenant.id, 'Fixture do canal de e-mail', state => {
    state.channels = [{ id: 'mail', kind: 'email', name: 'E-mail', state: 'planned' }];
    state.agents = [{ id: 'hermes-1', name: 'Hermes', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Atenda clientes.', tools: [],
      autopilot: { enabled: true, channelIds: ['mail'], maxRepliesPerHour: 6, requireKnowledge: true } },
    { id: 'ext', name: 'Agente externo', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
  });
  await emailChannel.configure(admin, tenant.id, 'mail', { address: 'loja@example.test', ingressSecret: relaySecret, version: 0 });
  let source = knowledge.create(admin, tenant.id, { title: 'Entregas', content: 'Prazo de entrega: os pedidos são entregues em até cinco dias úteis nas capitais.' });
  source = knowledge.publish(admin, tenant.id, source.id, { version: source.version });
  knowledge.setGrants(admin, tenant.id, 'hermes-1', { version: 1, grants: [{ sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash }] });
  let sequence = 0;
  const receive = (text = QUESTION, from = 'cliente@example.test') => {
    const rawBody = Buffer.from(JSON.stringify({ id: `email-message-${String(++sequence).padStart(4, '0')}`, from, to: 'loja@example.test', subject: 'Dúvida', text }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    return emailChannel.receiveWebhook({ tenantId: tenant.id, channelId: 'mail', rawBody, timestamp, signature: createHmac('sha256', relaySecret).update(`${timestamp}.`).update(rawBody).digest('hex') });
  };
  const conversation = () => store.tenant(admin, tenant.id).conversations[0], jobs = () => store.tenant(admin, tenant.id).agentAutopilotJobs || [];
  const assign = agentId => operations.assign(admin, tenant.id, conversation().id, { version: conversation().version, owner: 'agent', agentId });
  t.after(async () => {
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.events.close(); assert.equal(external.length, 0, 'nenhuma rede externa'); store.close();
  });
  return { app, store, admin, tenant, receive, conversation, jobs, assign, sent };
}

test('piloto automático responde por e-mail uma vez; as conferências depois do registro e do provedor aceitam a própria mensagem', async t => {
  const f = await fixture(t);
  await f.receive(); f.assign('hermes-1');
  await until(() => ['sent', 'unknown', 'handoff', 'failed', 'cancelled'].includes(f.jobs()[0]?.state), 5000, 'tarefa encerrada');
  const [job] = f.jobs(), agent = f.conversation().messages.filter(message => message.kind === 'agent');
  assert.equal(job.state, 'sent', `${job.state}/${job.reason}`);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, ANSWER); assert.deepEqual(f.sent[0].to, ['cliente@example.test']);
  assert.equal(agent.length, 1); assert.equal(agent[0].delivery, 'sent'); assert.equal(agent[0].autopilotJobId, job.id); assert.equal(agent[0].agentId, 'hermes-1');
  assert.equal(f.conversation().owner, 'agent');
});

test('agente externo responde por e-mail na conversa própria; uma pessoa que assume antes do provedor impede o envio', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const f = await fixture(t, { fetchImpl: async (url, input) => { calls.push(JSON.parse(input.body)); entered(); await gate; return { ok: true, status: 200, json: async () => ({ id: `provider-${calls.length}` }) }; } });
  const created = f.app.servicePrincipals.create(f.admin, f.tenant.id, { name: 'Atendente externo', agentId: 'ext', capabilities: ['conversation.read', 'reply.send', 'conversation.manage'], ttlHours: 24 });
  const actor = f.app.servicePrincipals.authenticate('Bearer ' + created.token);
  await f.receive('Vocês entregam no sábado?'); f.assign('ext');
  const pending = f.app.serviceApi.sendReply(actor, { requestId: 'email_reply_0001', conversationId: f.conversation().id, version: f.conversation().version, text: 'Entregamos de segunda a sábado.' });
  await started; release();
  const result = await pending;
  assert.equal(result.receipt.state, 'confirmed', JSON.stringify(result));
  const agent = f.conversation().messages.filter(message => message.kind === 'agent');
  assert.equal(calls.length, 1); assert.equal(agent.length, 1); assert.equal(agent[0].authorServiceId, created.principal.id); assert.equal(agent[0].delivery, 'sent');
  // A person takes over: the next reply never reaches the provider.
  f.app.operations.assign(f.admin, f.tenant.id, f.conversation().id, { version: f.conversation().version, owner: 'human', assignedUserId: f.admin.userId });
  await assert.rejects(f.app.serviceApi.sendReply(actor, { requestId: 'email_reply_0002', conversationId: f.conversation().id, version: f.conversation().version, text: 'Mais alguma dúvida?' }), error => error.status === 403);
  assert.equal(calls.length, 1);
});
