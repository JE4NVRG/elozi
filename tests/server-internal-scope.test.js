import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';

// Internal MCP lookups (elozi_contact_profile, elozi_conversation_history, ...) revalidate the run initiator on every call:
// the run must be executing a tool on this conversation, a service principal must still hold conversation.read and own the
// run, and the support assistant may read only its own current job. These negative cases guard each condition directly.
const TENANT = 'internal-scope-tenant';
const message = (id, text) => ({ id, kind: 'customer', text, createdAt: '2026-10-05T10:00:00Z' });
const conversation = (id, channelId, extra = {}) => ({ id, channelId, contact: 'Cliente sintético', contactId: 'contact-1', owner: 'queue', status: 'closed', version: 1,
  updatedAt: '2026-10-05T10:00:00Z', messages: [message('m-' + id, 'Mensagem sintética ' + id)], ...extra });

async function fixture(t) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido na fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const write = data => app.store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(data), TENANT);
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(TENANT, 'mep-demo', JSON.stringify({ name: 'Escopo interno', channels: [], departments: [], conversations: [] }));
  const person = (username, role, tenantIds, { permissions = null, scopeRules = null } = {}) => {
    const row = app.auth.insertUser({ name: 'Pessoa ' + username, username }, Buffer.alloc(16, 3), Buffer.alloc(64, 4), role, tenantIds);
    app.store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions && JSON.stringify(permissions), scopeRules && JSON.stringify(scopeRules), row.id);
    const { token } = app.auth.session(app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    return app.auth.workspaceActor(app.auth.authenticate(token));
  };
  const owner = person('owner.scope', 'reseller', []);
  const operator = person('operator.scope', 'operator', [TENANT], { permissions: ['inbox.read', 'inbox.reply', 'contacts.read'], scopeRules: { [TENANT]: { channelIds: ['ch-1'] } } });
  const previous = [...Array.from({ length: 30 }, (_, index) => conversation('prev-1-' + index, 'ch-1')), ...Array.from({ length: 10 }, (_, index) => conversation('prev-2-' + index, 'ch-2'))];
  const run = (id, conversationId, extra = {}) => ({ id, conversationId, agentId: 'agent-1', state: 'tool_running', actorUserId: null, serviceId: null, ...extra });
  write({ name: 'Escopo interno', departments: [],
    channels: [{ id: 'ch-1', name: 'WhatsApp sintético', kind: 'whatsapp_qr' }, { id: 'ch-2', name: 'Telegram sintético', kind: 'telegram' }],
    agents: [{ id: 'agent-1', name: 'Hermes', provider: 'hermes', mode: 'copilot', version: 1 }],
    contacts: [{ id: 'contact-1', name: 'Cliente sintético', tags: ['vip'], identities: [{ channelId: 'ch-1' }, { channelId: 'ch-2' }] }],
    conversations: [conversation('main', 'ch-1', { owner: 'human', status: 'open', assignedUserId: operator.userId, assignedUserName: 'Pessoa operator.scope' }), conversation('other', 'ch-1', { status: 'open', contactId: 'contact-2' }), ...previous],
    runs: [run('run-human', 'main', { actorUserId: operator.userId }), run('run-waiting', 'main', { state: 'waiting_approval', actorUserId: operator.userId }),
      run('run-other', 'other', { actorUserId: operator.userId }),
      run('run-svc-read', 'main', { serviceId: 'svc-read' }), run('run-svc-draft', 'main', { serviceId: 'svc-draft' }), run('run-svc-waiting', 'main', { serviceId: 'svc-read', state: 'waiting_approval' }),
      run('support_job-1', 'main'), run('support_job-2', 'main', { serviceId: 'svc-read' }), run('support_job-3', 'main', { actorUserId: operator.userId })] });
  const principal = (id, capabilities) => app.store.db.prepare('INSERT INTO service_principals (id,reseller_id,tenant_id,agent_id,name,capabilities,channel_ids,department_ids,daily_requests,daily_budget_micros,max_concurrent,estimated_request_micros,expires_at,revision,key_revision,token_hash,active,revoked_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'mep-demo', TENANT, 'agent-1', 'Serviço ' + id, JSON.stringify(capabilities), null, null, 100, 0, 1, 0, Date.now() + 3600000, 1, 1, 'hash-' + id, 1, null, owner.userId, Date.now(), Date.now());
  principal('svc-read', ['conversation.read', 'reply.draft']); principal('svc-draft', ['reply.draft']);
  const service = serviceId => ({ kind: 'service', role: 'operator', id: serviceId, serviceId, principalId: serviceId, resellerId: 'mep-demo', tenantIds: [TENANT], name: 'Serviço sintético' });
  const support = supportAssistantId => ({ kind: 'service', role: 'operator', resellerId: 'mep-demo', tenantIds: [TENANT], name: 'Assistente virtual Elozi', supportAssistantId });
  // runCurrent has its own suites; here it is pinned so each check of the internal scope is exercised on its own.
  let serviceCurrent = true, supportCurrent = true;
  app.servicePrincipals.runCurrent = () => serviceCurrent; app.centralSupport.runCurrent = () => supportCurrent;
  const lookup = (actor, runId, { tool = 'elozi_conversation_history', conversationId = 'main' } = {}) => app.mcp.internalContext(actor, TENANT, conversationId, { tool, arguments: {}, runId, agentId: 'agent-1' });
  const status = code => error => error?.status === code;
  return { app, owner, operator, service, support, lookup, status, setService: value => { serviceCurrent = value; }, setSupport: value => { supportCurrent = value; } };
}

test('consulta interna exige execução em tool_running no mesmo atendimento', async t => {
  const c = await fixture(t);
  assert.ok(Array.isArray(c.lookup(c.operator, 'run-human').history.messages));
  for (const [runId, conversationId] of [['run-waiting', 'main'], ['run-other', 'main'], ['run-human', 'other'], ['run-inexistente', 'main'], [null, 'main'], [42, 'main']]) {
    assert.throws(() => c.lookup(c.operator, runId, { conversationId }), c.status(409), String(runId) + ' em ' + conversationId);
  }
  assert.throws(() => c.lookup(c.service('svc-read'), 'run-svc-waiting'), c.status(409), 'serviço também precisa da ferramenta em execução');
  assert.throws(() => c.lookup(c.support('support_job-1'), 'support_job-1', { conversationId: 'other' }), c.status(409), 'suporte fora do atendimento da execução');
});

test('serviço precisa da própria execução, de conversation.read e de autorização atual', async t => {
  const c = await fixture(t);
  const allowed = c.lookup(c.service('svc-read'), 'run-svc-read', { tool: 'elozi_contact_profile' });
  assert.equal(allowed.contact.linkedContact, true); assert.deepEqual(allowed.contact.tags, [], 'serviço não vê o cadastro do contato');
  assert.throws(() => c.lookup(c.service('svc-draft'), 'run-svc-draft'), c.status(403), 'sem conversation.read não lê histórico');
  assert.throws(() => c.lookup(c.service('svc-draft'), 'run-svc-draft', { tool: 'elozi_contact_profile' }), c.status(403), 'sem conversation.read não lê perfil');
  assert.throws(() => c.lookup(c.service('svc-read'), 'run-svc-draft'), c.status(403), 'execução de outro serviço');
  assert.throws(() => c.lookup(c.service('svc-read'), 'run-human'), c.status(403), 'execução de uma pessoa');
  assert.throws(() => c.lookup(c.service('svc-inexistente'), 'run-svc-read'), c.status(403), 'principal removido');
  c.setService(false);
  assert.throws(() => c.lookup(c.service('svc-read'), 'run-svc-read'), c.status(403), 'principal revogado ou fora do escopo atual');
  c.setService(true);
  c.app.store.db.prepare('UPDATE service_principals SET capabilities=? WHERE id=?').run(JSON.stringify(['reply.draft']), 'svc-read');
  assert.throws(() => c.lookup(c.service('svc-read'), 'run-svc-read'), c.status(403), 'perda de conversation.read vale na próxima consulta');
});

test('suporte automático lê somente o próprio job atual, sem pessoa ou serviço na execução', async t => {
  const c = await fixture(t);
  const allowed = c.lookup(c.support('support_job-1'), 'support_job-1', { tool: 'elozi_contact_profile' });
  assert.equal(allowed.contact.previousConversations, 30, 'somente atendimentos do mesmo canal e departamento');
  assert.deepEqual(allowed.contact.tags, []);
  assert.throws(() => c.lookup(c.support('support_job-2'), 'support_job-1'), c.status(403), 'job de outra execução');
  assert.throws(() => c.lookup(c.support(null), 'support_job-1'), c.status(403), 'sem job identificado');
  assert.throws(() => c.lookup(c.support('support_job-2'), 'support_job-2'), c.status(403), 'execução com serviço');
  assert.throws(() => c.lookup(c.support('support_job-3'), 'support_job-3'), c.status(403), 'execução com pessoa');
  c.setSupport(false);
  assert.throws(() => c.lookup(c.support('support_job-1'), 'support_job-1'), c.status(403), 'job encerrado ou fora do escopo atual');
});

test('perfil do contato para a pessoa responsável usa um retrato de permissão, não uma leitura da empresa por atendimento', async t => {
  const c = await fixture(t);
  let reads = 0;
  const tenant = c.app.store.tenant.bind(c.app.store);
  c.app.store.tenant = (...args) => { reads++; return tenant(...args); };
  const profile = c.lookup(c.operator, 'run-human', { tool: 'elozi_contact_profile' }).contact;
  assert.equal(profile.previousConversations, 30, 'atendimentos do canal fora do escopo não são contados');
  assert.deepEqual(profile.tags, ['vip'], 'contacts.read mostra o cadastro');
  // 40 earlier attendances of the same contact: the previous per-item check read the company document 40+ times.
  assert.ok(reads <= 10, `leituras da empresa: ${reads}`);
  assert.throws(() => c.lookup(c.owner, 'run-human', { tool: 'elozi_contact_profile' }), error => [403, 409].includes(error?.status), 'somente o responsável');
});
