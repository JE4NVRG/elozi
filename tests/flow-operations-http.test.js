import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const denyExternal = async () => { throw new Error('External transport forbidden in fixture'); };
const timestamp = () => new Date().toISOString();
const conditionalGraph = () => ({
  nodes: [
    { id: 'start', type: 'start', config: {} },
    { id: 'condition', type: 'condition', config: { field: 'text', operator: 'contains', value: 'encaminhar' } },
    { id: 'handoff', type: 'handoff', config: { owner: 'human' } },
    { id: 'tag', type: 'tag', config: { tag: 'Mantido' } },
    { id: 'end', type: 'end', config: {} }
  ],
  edges: [
    { from: 'start', to: 'condition' },
    { from: 'condition', to: 'handoff', when: true },
    { from: 'condition', to: 'tag', when: false },
    { from: 'handoff', to: 'end' }, { from: 'tag', to: 'end' }
  ]
});
const departmentGraph = department => ({
  nodes: [
    { id: 'start', type: 'start', config: {} },
    { id: 'department', type: 'department', config: { department } },
    { id: 'end', type: 'end', config: {} }
  ],
  edges: [{ from: 'start', to: 'department' }, { from: 'department', to: 'end' }]
});

async function fixture(t) {
  const key = randomBytes(32);
  const app = createApp({
    databasePath: ':memory:', publicOrigin: '', serviceKey: key, agentOrigins: [],
    providerCall: async () => 'Rascunho sintético anterior ao fluxo',
    gatewayOptions: { authKey: key, socketFactory: denyExternal },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denyExternal },
    googleOptions: { clientId: '' },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: denyExternal }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '' } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] });
        } catch (error) { reject(error); }
      });
    });
    pending.on('error', reject); pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Gestor sintético', username: 'flow.owner', password: password() } });
  assert.equal(owner.status, 200);
  const ownerActor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const created = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Fluxos e atendimento QA', segment: 'QA' } });
  assert.equal(created.status, 201);
  const tenantId = created.data.id, path = `/api/tenants/${tenantId}`;
  const wa = 'fixture-wa', tg = 'fixture-tg', support = 'fixture-support', sales = 'fixture-sales', agentId = 'fixture-copilot';
  app.store.mutate(ownerActor, tenantId, 'Fixture: canais, departamentos e copiloto sintéticos', state => {
    state.channels = [
      { id: wa, name: 'WhatsApp sintético', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' },
      { id: tg, name: 'Telegram sintético', kind: 'telegram', transport: 'telegram-bot', state: 'connected' }
    ];
    state.departments = [
      { id: support, name: 'Suporte', active: true, distribution: 'manual', memberIds: [], version: 1 },
      { id: sales, name: 'Comercial', active: true, distribution: 'manual', memberIds: [], version: 1 }
    ];
    state.defaultDepartmentId = support;
    state.agents = [{ id: agentId, name: 'Copiloto sintético', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Fixture local' }];
  });
  let memberSequence = 0, conversationSequence = 0;
  const member = async (extra = {}) => {
    const username = 'flow.member.' + ++memberSequence, secret = password();
    const created = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { username, name: 'Atendente sintético ' + memberSequence, password: secret, role: 'operator', tenantIds: [tenantId], ...extra } });
    assert.equal(created.status, 201);
    app.store.mutate(ownerActor, tenantId, 'Fixture: vínculo de equipe ao departamento', state => {
      const permitted = extra.scopeRules?.[tenantId]?.departmentIds;
      for (const department of state.departments) if (!permitted || permitted.includes(department.id)) department.memberIds.push(created.data.id);
    });
    const signed = await request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
    assert.equal(signed.status, 200); return { ...created.data, cookie: signed.cookie };
  };
  const state = () => app.store.tenant(ownerActor, tenantId);
  const conversation = (extra = {}) => app.store.mutate(ownerActor, tenantId, 'Fixture: atendimento na fila', tenant => {
    const current = { id: 'fixture-conversation-' + ++conversationSequence, contact: 'Contato sintético', channelId: wa, departmentId: support, department: 'Suporte', conversationKind: 'direct', owner: 'queue', assignedUserId: null, assignedUserName: null, agentId: null, status: 'open', version: 1, unread: 1, tags: [], messages: [{ id: 'fixture-message-' + conversationSequence, kind: 'customer', text: 'Pedido sintético', createdAt: timestamp() }], updatedAt: timestamp(), ...extra };
    tenant.conversations.push(current); return current;
  });
  const currentConversation = id => state().conversations.find(item => item.id === id);
  const claim = async (current, user) => {
    const claimed = await request(`${path}/conversations/${current.id}/owner`, { method: 'POST', cookie: user.cookie, body: { version: current.version, owner: 'human' } });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.data)); assert.equal(claimed.data.assignedUserId, user.id); return claimed.data;
  };
  const flow = async (graph = conditionalGraph(), name = 'Fluxo sintético') => {
    const created = await request(path + '/flows', { method: 'POST', cookie: owner.cookie, body: { name, graph } });
    assert.equal(created.status, 201);
    const published = await request(`${path}/flows/${created.data.id}/publish`, { method: 'POST', cookie: owner.cookie, body: { version: created.data.version } });
    assert.equal(published.status, 200); return published.data;
  };
  const apply = (published, current, user, text = 'encaminhar') => request(`${path}/flows/${published.id}/simulate`, { method: 'POST', cookie: user.cookie, body: { flowVersion: published.publishedVersion, conversationId: current.id, conversationVersion: current.version, text, apply: true } });
  const auditCount = () => app.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(tenantId).n;
  const stable = () => ({ state: state(), auditCount: auditCount() });
  const serviceActor = { role: 'reseller', resellerId: ownerActor.resellerId, name: 'Gateway sintético' };
  const waEntry = { actor: serviceActor, tenantId, channelId: wa, generation: 1, matched: true, state: 'connected' };
  const tgEntry = { actor: serviceActor, tenantId, channelId: tg, state: 'connected', abort: new AbortController(), stopped: false };
  app.gateway.entries.set(wa, waEntry);
  app.telegram.entries.set(tg, tgEntry);
  return { app, request, owner, ownerActor, tenantId, path, wa, tg, support, sales, agentId, member, state, conversation, currentConversation, claim, flow, apply, stable, waEntry, tgEntry };
}

test('HTTP ramo não percorrido com handoff conserva o responsável identificado', async t => {
  const c = await fixture(t), operator = await c.member();
  const assigned = await c.claim(c.conversation(), operator), published = await c.flow();
  const assignments = c.currentConversation(assigned.id).attendantEvents.filter(event => event.type === 'assignment').length;
  const result = await c.apply(published, assigned, operator, 'continuar aqui');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.steps.map(step => step.nodeId), ['start', 'condition', 'tag', 'end']);
  const current = c.currentConversation(assigned.id);
  assert.equal(current.owner, 'human'); assert.equal(current.assignedUserId, operator.id); assert.equal(current.assignedUserName, operator.name);
  assert.equal(current.departmentId, c.support); assert.equal(current.version, assigned.version + 1);
  assert.deepEqual(current.tags, ['Mantido']);
  assert.equal(current.attendantEvents.filter(event => event.type === 'assignment').length, assignments);
});

test('HTTP handoff executado devolve à fila, registra autoria e invalida rascunho anterior', async t => {
  const c = await fixture(t), operator = await c.member();
  const assigned = await c.claim(c.conversation(), operator), published = await c.flow();
  const run = await c.request(`${c.path}/conversations/${assigned.id}/run`, { method: 'POST', cookie: operator.cookie, body: { version: assigned.version, agentId: c.agentId } });
  assert.equal(run.status, 202);
  const runs=await c.request(`${c.path}/conversations/${assigned.id}/runs`,{cookie:operator.cookie});
  assert.equal(runs.data.runs.find(item=>item.id===run.data.id).state,'draft');
  const applied = await c.apply(published, assigned, operator);
  assert.equal(applied.status, 200); assert.ok(applied.data.steps.some(step => step.nodeId === 'handoff'));
  const current = c.currentConversation(assigned.id), event = current.attendantEvents.at(-1);
  assert.equal(current.owner, 'queue'); assert.equal(current.assignedUserId, null); assert.equal(current.assignedUserName, null); assert.equal(current.agentId, null);
  assert.equal(event.type, 'assignment'); assert.equal(event.origin, 'flow'); assert.equal(event.actorId, operator.id);
  assert.deepEqual(event.from, { owner: 'human', assignedUserId: operator.id, departmentId: c.support });
  assert.deepEqual(event.to, { owner: 'queue', assignedUserId: null, departmentId: c.support });
  const fetched = await c.request(c.path, { cookie: operator.cookie });
  assert.equal(fetched.status, 200);
  const invalidated = fetched.data.runs.find(item => item.id === run.data.id);
  assert.equal(invalidated.state, 'invalidated'); assert.equal(invalidated.draft, null);
  assert.equal(c.state().runs.find(item => item.id === run.data.id).draft, null);
});

test('HTTP sem flows.read oculta grafo/rascunho e recusa previews de versão publicada e draft', async t => {
  const c = await fixture(t), marker = 'PRIVATE_FLOW_GRAPH_MARKER';
  const published = await c.flow(conditionalGraph(), marker);
  const editedGraph = conditionalGraph(); editedGraph.nodes.find(node => node.id === 'tag').config.tag = 'PRIVATE_DRAFT_MARKER';
  const edited = await c.request(`${c.path}/flows/${published.id}`, { method: 'PUT', cookie: c.owner.cookie, body: { version: published.version, graph: editedGraph } });
  assert.equal(edited.status, 200);
  const operator = await c.member({ permissions: ['inbox.read', 'inbox.reply', 'inbox.transfer', 'contacts.read'] });
  const assigned = await c.claim(c.conversation(), operator);
  const tenant = await c.request(c.path, { cookie: operator.cookie });
  assert.equal(tenant.status, 200); assert.deepEqual(tenant.data.flows, []);
  assert.equal(JSON.stringify(tenant.data).includes('PRIVATE_'), false);
  const before = c.stable();
  const list = await c.request(c.path + '/flows', { cookie: operator.cookie });
  assert.equal(list.status, 403); assert.equal(JSON.stringify(list.data).includes('PRIVATE_'), false);
  for (const body of [{ text: 'encaminhar' }, { flowVersion: published.publishedVersion, text: 'encaminhar' }, { version: edited.data.version, conversationId: assigned.id, conversationVersion: assigned.version, text: 'encaminhar' }, { flowVersion: published.publishedVersion, conversationId: assigned.id, conversationVersion: assigned.version, apply: true }]) {
    const denied = await c.request(`${c.path}/flows/${published.id}/simulate`, { method: 'POST', cookie: operator.cookie, body });
    assert.equal(denied.status, 403); assert.equal(JSON.stringify(denied.data).includes('PRIVATE_'), false);
  }
  assert.deepEqual(c.stable(), before);
});

test('HTTP transferência e rota para departamento inacessível recusam sem alterar estado/auditoria', async t => {
  const c = await fixture(t);
  const operator = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.wa], departmentIds: [c.support] } } });
  const assigned = await c.claim(c.conversation(), operator), published = await c.flow(departmentGraph(c.sales));
  const before = c.stable();
  const transfer = await c.request(`${c.path}/conversations/${assigned.id}/owner`, { method: 'POST', cookie: operator.cookie, body: { version: assigned.version, owner: 'queue', departmentId: c.sales } });
  assert.equal(transfer.status, 403); assert.deepEqual(c.stable(), before);
  const applied = await c.apply(published, assigned, operator);
  assert.equal(applied.status, 403); assert.deepEqual(c.stable(), before);
});

test('HTTP aplicar fluxo exige ser o responsável atual mesmo com permissão de transferência', async t => {
  const c = await fixture(t), assignedUser = await c.member(), other = await c.member();
  const assigned = await c.claim(c.conversation(), assignedUser), published = await c.flow();
  const before = c.stable(), denied = await c.apply(published, assigned, other);
  assert.equal(denied.status, 403); assert.deepEqual(c.stable(), before);
  assert.equal(c.currentConversation(assigned.id).assignedUserId, assignedUser.id);
});

const telegramUpdate = (updateId, chatId, messageId, { threadId, type = 'private', ...extra } = {}) => ({
  update_id: updateId,
  message: { message_id: messageId, date: 1_780_000_000, chat: { id: chatId, type, ...(type === 'private' ? { first_name: 'Contato sintético' } : { title: 'Grupo sintético' }) }, from: { id: 8001, first_name: 'Participante sintético' }, text: 'Mensagem sintética ' + messageId, ...(threadId ? { message_thread_id: threadId } : {}), ...extra }
});

test('Telegram migra tópicos legados e vincula novo tópico ao mesmo contato; sync é idempotente', async t => {
  const c = await fixture(t), oldId = -12001, newId = -10012001;
  c.conversation({ channelId: c.tg, conversationKind: 'group', remoteChatId: String(oldId), chatAliases: [String(oldId)], threadId: 7 });
  c.conversation({ channelId: c.tg, conversationKind: 'group', remoteChatId: String(oldId), chatAliases: [String(oldId)], threadId: 8 });
  assert.equal(c.state().contacts?.length || 0, 0);
  const backfill = await c.request(c.path + '/contacts/sync', { method: 'POST', cookie: c.owner.cookie, body: {} });
  assert.equal(backfill.status, 200); assert.equal(c.state().contacts.length, 1);
  const previousContactId = c.state().contacts[0].id;
  c.app.telegram.receive(c.tgEntry, telegramUpdate(1, oldId, 10, { type: 'group', text: undefined, migrate_to_chat_id: newId }));
  const migrated = c.state().conversations;
  assert.equal(migrated.length, 2); assert.ok(migrated.every(item => item.remoteChatId === String(newId) && item.contactId));
  assert.equal(new Set(migrated.map(item => item.contactId)).size, 1);
  c.app.telegram.receive(c.tgEntry, telegramUpdate(2, newId, 11, { type: 'supergroup', threadId: 9 }));
  c.app.telegram.receive(c.tgEntry, telegramUpdate(3, newId, 12, { type: 'supergroup', threadId: 7 }));
  const contactId = c.state().conversations[0].contactId;
  assert.equal(contactId, previousContactId);
  assert.equal(c.state().conversations.length, 3); assert.ok(c.state().conversations.every(item => item.contactId === contactId));
  assert.equal(c.state().contacts.length, 1); assert.equal(c.state().contacts[0].type, 'group');
  assert.deepEqual(new Set(c.state().contacts[0].identities.map(identity => identity.externalId)), new Set([String(oldId), String(newId)]));
  const sync = await c.request(c.path + '/contacts/sync', { method: 'POST', cookie: c.owner.cookie, body: {} });
  assert.equal(sync.status, 200);
  const synchronized = c.state();
  assert.equal((await c.request(c.path + '/contacts/sync', { method: 'POST', cookie: c.owner.cookie, body: {} })).status, 200);
  assert.deepEqual(c.state(), synchronized);
  const history = await c.request(`${c.path}/contacts/${contactId}/history`, { cookie: c.owner.cookie });
  assert.equal(history.status, 200); assert.deepEqual(new Set(history.data.conversations.map(item => item.id)), new Set(c.state().conversations.map(item => item.id)));
  const contacts = await c.request(c.path + '/contacts', { cookie: c.owner.cookie });
  assert.equal(contacts.status, 200); assert.equal(contacts.data.contacts.length, 1);
  assert.equal(JSON.stringify(contacts.data).includes(String(oldId)), false); assert.equal(JSON.stringify(contacts.data).includes(String(newId)), false);
});

for (const transport of ['whatsapp', 'telegram']) test(`${transport}: cliente novo reabre fechado na fila e replay não duplica`, async t => {
  const c = await fixture(t), operator = await c.member();
  const waMessage = (id, fromMe = false) => ({ key: { id, remoteJid: '5511988880011@s.whatsapp.net', fromMe }, pushName: 'Cliente sintético', message: { conversation: 'Entrada sintética ' + id }, messageTimestamp: 1_780_000_000 });
  const first = transport === 'whatsapp' ? waMessage('incoming-first') : telegramUpdate(1, 8101, 1);
  const receive = async message => transport === 'whatsapp' ? c.app.gateway.receive(c.waEntry, message) : c.app.telegram.receive(c.tgEntry, message);
  await receive(first);
  const initial = c.state().conversations[0], contactId = initial.contactId;
  assert.equal(initial.owner, 'queue'); assert.equal(initial.assignedUserId, null); assert.ok(contactId);
  const assigned = await c.claim(initial, operator);
  const closed = await c.request(`${c.path}/conversations/${assigned.id}/details`, { method: 'POST', cookie: operator.cookie, body: { version: assigned.version, status: 'closed', reason: 'Fixture encerrada' } });
  assert.equal(closed.status, 200); assert.equal(closed.data.status, 'closed');
  await receive(first);
  assert.equal(c.currentConversation(initial.id).status, 'closed'); assert.equal(c.currentConversation(initial.id).version, closed.data.version);
  if (transport === 'whatsapp') {
    await receive(waMessage('outgoing-echo', true));
    assert.equal(c.currentConversation(initial.id).status, 'closed');
  } else {
    await receive(telegramUpdate(2, 8101, 1));
    assert.equal(c.currentConversation(initial.id).status, 'closed'); assert.equal(c.currentConversation(initial.id).version, closed.data.version);
  }
  const beforeReopen = c.currentConversation(initial.id);
  const next = transport === 'whatsapp' ? waMessage('incoming-next') : telegramUpdate(3, 8101, 2);
  await receive(next);
  const reopened = c.currentConversation(initial.id);
  assert.equal(reopened.status, 'open'); assert.equal(reopened.owner, 'queue'); assert.equal(reopened.assignedUserId, null); assert.equal(reopened.assignedUserName, null); assert.equal(reopened.agentId, null);
  assert.equal(reopened.version, beforeReopen.version + 1); assert.equal(reopened.contactId, contactId);
  const events = reopened.attendantEvents.filter(event => event.type === 'reopened');
  assert.equal(events.length, 1); assert.equal(events[0].origin, transport); assert.equal(events[0].to.assignedUserId, null);
  await receive(transport === 'telegram' ? telegramUpdate(4, 8101, 2) : next);
  assert.deepEqual(c.currentConversation(initial.id), reopened);
  assert.equal(c.state().conversations.length, 1); assert.equal(c.state().contacts.length, 1);
  assert.equal(reopened.messages.filter(item => item.kind === 'customer').length, 2);
  const fetched = await c.request(c.path, { cookie: operator.cookie });
  assert.equal(fetched.status, 200); assert.equal(fetched.data.conversations[0].id, initial.id); assert.equal(fetched.data.conversations[0].owner, 'queue');
});
