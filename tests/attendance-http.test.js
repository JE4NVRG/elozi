import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const noteCommand = extra => ({ version: 1, text: 'Nota privada da equipe sintética.', commandId: 'http-note-one', ...extra });

async function fixture(t) {
  const key = randomBytes(32), externalCalls = [];
  const denied = async (...args) => { externalCalls.push(args); throw new Error('External transport forbidden in attendance HTTP fixture'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: denied,
    gatewayOptions: { authKey: key, socketFactory: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denied },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', cookie = '', body, workspace } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie,
      ...(workspace === undefined ? {} : { 'X-Elozi-Workspace': workspace }) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()),
          cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); }
      });
    });
    pending.setTimeout(2000, () => pending.destroy(new Error('Attendance HTTP fixture request timed out')));
    pending.on('error', reject); pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Admin atendimento QA', username: 'attendance.owner', password: password() } });
  assert.equal(owner.status, 200);
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const createTenant = async name => {
    const response = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name, segment: 'QA sintético' } });
    assert.equal(response.status, 201); return response.data;
  };
  const tenant = await createTenant('Atendimento HTTP QA'), other = await createTenant('Outra empresa HTTP QA');
  const path = `/api/tenants/${tenant.id}`, conversationPath = `${path}/conversations/conv`;
  let sequence = 0;
  const member = async (extra = {}) => {
    const n = ++sequence, username = `attendance.member.${n}`, secret = password();
    const created = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: {
      name: `Atendente HTTP QA ${n}`, username, password: secret, role: 'operator', tenantIds: [tenant.id],
      permissions: ['inbox.read', 'inbox.reply', 'inbox.transfer'], ...extra } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const signed = await request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
    assert.equal(signed.status, 200); return { ...created.data, cookie: signed.cookie };
  };
  const alice = await member();
  app.store.mutate(actor, tenant.id, 'Fixture HTTP sintética de atendimento', state => {
    state.channels = [{ id: 'wa', name: 'WhatsApp QA', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' },
      { id: 'tg', name: 'Telegram QA', kind: 'telegram', transport: 'telegram-bot', state: 'connected' }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'Comercial', active: true }];
    state.conversations = [{ id: 'conv', contact: 'Contato sintético HTTP', channelId: 'wa', departmentId: 'support', department: 'Suporte',
      owner: 'human', assignedUserId: alice.id, assignedUserName: alice.name, agentId: null, status: 'open', version: 1, unread: 3,
      tags: ['QA'], updatedAt: '2026-10-02T11:00:00.000Z', remoteJid: 'PRIVATE_HTTP_REMOTE_JID', remoteAliases: ['PRIVATE_HTTP_REMOTE_ALIAS'],
      remoteChatId: 'PRIVATE_HTTP_CHAT_ID', chatAliases: ['PRIVATE_HTTP_CHAT_ALIAS'],
      messages: [{ id: 'customer', kind: 'customer', text: 'Mensagem pública sintética.', createdAt: '2026-10-02T11:00:00.000Z', delivery: 'received',
        senderId: 'PRIVATE_HTTP_SENDER_ID', senderJid: 'PRIVATE_HTTP_SENDER_JID', senderJidAlt: 'PRIVATE_HTTP_SENDER_ALT' }] }];
  });
  // Trap any accidental native dispatch even though the fixture opens no channel session.
  app.gateway.send = denied; app.gateway.syncReadToDevice = denied; app.gateway.syncDeviceReadState = denied; app.telegram.send = denied;
  const current = () => app.store.getConversation(app.store.tenant(actor, tenant.id), 'conv');
  const change = callback => app.store.mutate(actor, tenant.id, 'Fixture: mudança HTTP concorrente', state => callback(state.conversations[0]));
  const auditCount = () => app.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(tenant.id).n;
  const outboxCount = () => app.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n;
  const post = (operation, body, user = alice, extra = {}) => request(`${conversationPath}/${operation}`, { method: 'POST', cookie: user.cookie, body, ...extra });
  return { app, actor, owner, tenant, other, path, conversationPath, alice, member, request, post, current, change, auditCount, outboxCount, externalCalls };
}

function assertSafeConversation(conversation) {
  for (const key of ['remoteJid', 'remoteAliases', 'remoteChatId', 'chatAliases']) assert.equal(Object.hasOwn(conversation, key), false, key);
  for (const message of conversation.messages) {
    for (const key of ['senderId', 'senderJid', 'senderJidAlt']) assert.equal(Object.hasOwn(message, key), false, key);
  }
  assert.equal(JSON.stringify(conversation).includes('PRIVATE_HTTP_'), false);
}

test('HTTP nota interna persiste autoria segura e replay confirma a única nota após nova revisão', async t => {
  const c = await fixture(t), before = c.current(), input = noteCommand({ text: '  Nota privada\nSegunda linha.  ' });
  const saved = await c.post('notes', input);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assertSafeConversation(saved.data);
  const note = saved.data.messages.at(-1);
  assert.equal(note.kind, 'internal'); assert.equal(note.text, 'Nota privada\nSegunda linha.');
  assert.equal(note.userId, c.alice.id); assert.equal(note.authorName, c.alice.name);
  assert.match(note.id, /^[0-9a-f-]{36}$/); assert.ok(Number.isFinite(Date.parse(note.createdAt)));
  assert.equal(saved.data.version, 2); assert.equal(saved.data.unread, before.unread);
  assert.equal(note.delivery, undefined); assert.equal(note.externalId, undefined); assert.equal(note.attachments, undefined);
  assert.deepEqual(c.current().messages[0], before.messages[0]);
  const read = await c.post('read-state', { version: 2, unread: false });
  assert.equal(read.status, 200); assert.equal(read.data.version, 3);
  const audit = c.auditCount(), state = c.current();
  const replay = await c.post('notes', input);
  assert.equal(replay.status, 200); assert.equal(replay.data.version, state.version);
  assertSafeConversation(replay.data); assert.deepEqual(replay.data.messages.at(-1), note);
  assert.equal(replay.data.messages.filter(message => message.kind === 'internal').length, 1);
  assert.deepEqual(c.current(), state); assert.equal(c.auditCount(), audit);
  for (const conflicting of [noteCommand({ text: 'Outra nota.' }), noteCommand({ version: 3 })]) {
    assert.equal((await c.post('notes', conflicting)).status, 409);
  }
  assert.equal((await c.post('notes', noteCommand({ commandId: 'http-note-stale' }))).status, 409);
  assert.deepEqual(c.current(), state); assert.equal(c.auditCount(), audit);
  assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

test('HTTP nota só pode ser criada pelo responsável humano atual inclusive após replay e encerramento', async t => {
  const c = await fixture(t), bob = await c.member(), before = c.current();
  assert.equal((await c.post('notes', noteCommand(), bob)).status, 409);
  assert.equal((await c.post('notes', noteCommand(), c.owner)).status, 409);
  assert.deepEqual(c.current(), before);
  const saved = await c.post('notes', noteCommand()); assert.equal(saved.status, 200);
  c.change(conversation => { conversation.assignedUserId = bob.id; conversation.assignedUserName = bob.name; conversation.version++; });
  assert.equal((await c.post('notes', noteCommand())).status, 409);
  assert.equal((await c.post('notes', noteCommand(), bob)).status, 409);
  assert.equal((await c.post('notes', noteCommand({ version: 3, commandId: 'http-note-bob' }), bob)).status, 200);
  c.change(conversation => { conversation.status = 'closed'; conversation.version++; });
  const closed = c.current(), audit = c.auditCount();
  assert.equal((await c.post('notes', noteCommand({ version: closed.version, commandId: 'http-note-closed' }), bob)).status, 409);
  assert.equal((await c.post('notes', noteCommand({ version: 3, commandId: 'http-note-bob' }), bob)).status, 409);
  assert.deepEqual(c.current(), closed); assert.equal(c.auditCount(), audit);
  c.change(conversation => { conversation.status = 'open'; conversation.owner = 'agent'; conversation.version++; });
  assert.equal((await c.post('notes', noteCommand({ version: c.current().version, commandId: 'http-note-agent' }), bob)).status, 409);
  assert.equal(c.current().messages.filter(message => message.kind === 'internal').length, 2);
  assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

test('HTTP notas e leitura respeitam sessão, empresa, permissão e escopo atual de canal e departamento', async t => {
  const c = await fixture(t), reader = await c.member({ permissions: ['inbox.read'] });
  const denied = await c.member({ permissions: [] });
  const outsider = await c.member({ tenantIds: [c.other.id] });
  const restricted = await c.member({ scopeRules: { [c.tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } } });
  const before = c.current(), audit = c.auditCount();
  for (const operation of ['notes', 'read-state']) {
    const input = operation === 'notes' ? noteCommand() : { version: 1, unread: false };
    assert.equal((await c.request(`${c.conversationPath}/${operation}`, { method: 'POST', body: input })).status, 401);
    assert.equal((await c.post(operation, input, denied)).status, 403);
    assert.equal((await c.post(operation, input, outsider)).status, 403);
    assert.equal((await c.post(operation, input, c.alice, { workspace: 'foreign-workspace' })).status, 403);
    assert.equal((await c.request(`/api/tenants/${c.other.id}/conversations/conv/${operation}`, { method: 'POST', cookie: c.alice.cookie, body: input })).status, 403);
    assert.equal((await c.request(`/api/tenants/${c.other.id}/conversations/conv/${operation}`, { method: 'POST', cookie: c.owner.cookie, body: input })).status, 404);
  }
  assert.equal((await c.post('notes', noteCommand(), reader)).status, 403);
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audit);
  for (const patch of [{ channelId: 'tg' }, { departmentId: 'sales' }]) {
    c.change(conversation => Object.assign(conversation, { channelId: 'wa', departmentId: 'support', assignedUserId: restricted.id }, patch));
    const state = c.current();
    assert.equal((await c.post('notes', noteCommand(), restricted)).status, 403);
    assert.equal((await c.post('read-state', { version: 1, unread: false }, restricted)).status, 403);
    assert.deepEqual(c.current(), state);
  }
  c.change(conversation => Object.assign(conversation, { channelId: 'wa', departmentId: 'support', assignedUserId: c.alice.id }));
  const accepted = await c.post('notes', noteCommand()); assert.equal(accepted.status, 200);
  c.app.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.alice.id);
  assert.equal((await c.post('notes', noteCommand())).status, 403);
  assert.equal(c.current().messages.filter(message => message.kind === 'internal').length, 1);
  assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

test('HTTP read-state usa CAS e booleano explícito sem emitir mensagens nem recibos nativos', async t => {
  const c = await fixture(t), reader = await c.member({ permissions: ['inbox.read'] }), before = c.current();
  const retained = await c.post('read-state', { version: 1, unread: true }, reader);
  assert.equal(retained.status, 200); assert.equal(retained.data.unread, 3); assert.equal(retained.data.version, 2);
  assertSafeConversation(retained.data);
  const read = await c.post('read-state', { version: 2, unread: false }, reader);
  assert.equal(read.status, 200); assert.equal(read.data.unread, 0); assert.equal(read.data.version, 3);
  const marked = await c.post('read-state', { version: 3, unread: true }, reader);
  assert.equal(marked.status, 200); assert.equal(marked.data.unread, 1); assert.equal(marked.data.version, 4);
  const state = c.current(), audit = c.auditCount();
  assert.deepEqual(state.messages, before.messages); assert.equal(state.assignedUserId, c.alice.id);
  assert.equal((await c.post('read-state', { version: 3, unread: false }, reader)).status, 409);
  for (const input of [null, [], { version: 4 }, { version: 4, unread: 'false' }, { version: 4, unread: 0 },
    { version: 0, unread: false }, { version: 4, unread: false, sendReceipt: true }]) {
    assert.equal((await c.post('read-state', input, reader)).status, 400, JSON.stringify(input));
  }
  assert.deepEqual(c.current(), state); assert.equal(c.auditCount(), audit);
  c.change(conversation => { conversation.channelId = 'tg'; conversation.status = 'closed'; conversation.version++; });
  const closed = await c.post('read-state', { version: 5, unread: false }, reader);
  assert.equal(closed.status, 200); assert.equal(closed.data.unread, 0); assert.equal(closed.data.version, 6);
  assertSafeConversation(closed.data); assert.deepEqual(c.current().messages, before.messages);
  assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

test('HTTP leitura nativa é opt-in do responsável e repetição CAS não repete o WhatsApp', async t => {
  const c = await fixture(t), calls = [];
  c.app.gateway.syncReadToDevice = async (actor, tenantId, cid, input, { reauthorize }) => {
    reauthorize(); calls.push({ userId: actor.userId, tenantId, cid, input });
    assert.equal(c.current().unread, 0); assert.equal(c.current().version, 2);
    return { state: 'synced', reason: 'PRIVATE_PROVIDER_DETAIL' };
  };
  const saved = await c.post('read-state', { version: 1, unread: false, syncDevice: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assertSafeConversation(saved.data);
  assert.deepEqual(saved.data.readSync, { state: 'synced' });
  assert.deepEqual(calls, [{ userId: c.alice.id, tenantId: c.tenant.id, cid: 'conv', input: { version: 2, channelId: 'wa' } }]);
  assert.equal((await c.post('read-state', { version: 1, unread: false, syncDevice: true })).status, 409);
  assert.equal(calls.length, 1); assert.equal(c.current().owner, 'human'); assert.equal(c.outboxCount(), 0);
});

test('HTTP não permite sincronização de observador, agente ou canal errado e valida antes da leitura local', async t => {
  const c = await fixture(t), reader = await c.member({ permissions: ['inbox.read'] });
  for (const user of [reader, c.owner]) {
    const before = c.current();
    assert.equal((await c.post('read-state', { version: 1, unread: false, syncDevice: true }, user)).status, 409);
    assert.deepEqual(c.current(), before);
  }
  for (const input of [{ version: 1, unread: true, syncDevice: true }, { version: 1, unread: false, syncDevice: 'true' },
    { version: 1, unread: false, syncDevice: true, arbitraryKey: 'forged' }]) {
    const before = c.current(); assert.equal((await c.post('read-state', input)).status, 400); assert.deepEqual(c.current(), before);
  }
  c.change(conversation => { conversation.channelId = 'tg'; });
  const before = c.current();
  assert.equal((await c.post('read-state', { version: 1, unread: false, syncDevice: true })).status, 400);
  assert.deepEqual(c.current(), before); assert.equal(c.externalCalls.length, 0);
});

test('HTTP falha parcial de leitura conserva estado atual e não retorna captura anterior à mensagem nova', async t => {
  const c = await fixture(t), original = c.current().messages;
  c.app.gateway.syncReadToDevice = async () => {
    c.change(conversation => { conversation.unread = 1; conversation.version++; conversation.messages.push({ id: 'new', kind: 'customer', text: 'Nova mensagem sintética.', createdAt: new Date().toISOString() }); });
    throw new Error('PRIVATE_PROVIDER_DETAIL');
  };
  const saved = await c.post('read-state', { version: 1, unread: false, syncDevice: true });
  assert.equal(saved.status, 200); assertSafeConversation(saved.data);
  assert.deepEqual(saved.data.readSync, { state: 'pending' }); assert.equal(saved.data.unread, 1); assert.equal(saved.data.version, 3);
  assert.deepEqual(saved.data.messages.slice(0, original.length).map(message => message.id), original.map(message => message.id));
  assert.equal(saved.data.messages.at(-1).id, 'new'); assert.equal(JSON.stringify(saved.data).includes('PRIVATE_PROVIDER_DETAIL'), false);
  assert.equal(c.current().assignedUserId, c.alice.id); assert.equal(c.current().status, 'open'); assert.equal(c.outboxCount(), 0);
});

test('HTTP atualizar leituras do aparelho é operação administrativa do canal, sem aceitar keys do cliente', async t => {
  const c = await fixture(t), calls = [], path = `${c.path}/channels/wa/read-state-sync`, before = c.current();
  c.app.gateway.syncDeviceReadState = async (actor, tenantId, channelId, { reauthorize }) => {
    reauthorize(); calls.push({ userId: actor.userId, tenantId, channelId });
    return { channelId, state: 'synced', updatedConversations: 2 };
  };
  for (const user of [undefined, c.alice]) {
    const response = await c.request(path, { method: 'POST', cookie: user?.cookie, body: {} });
    assert.equal(response.status, user ? 403 : 401);
  }
  for (const body of [null, [], { keys: ['forged'] }, { regular_low: null }]) assert.equal((await c.request(path, { method: 'POST', cookie: c.owner.cookie, body })).status, 400);
  assert.equal(calls.length, 0);
  const response = await c.request(path, { method: 'POST', cookie: c.owner.cookie, body: {} });
  assert.equal(response.status, 200); assert.deepEqual(response.data, { channelId: 'wa', state: 'synced', updatedConversations: 2 });
  assert.equal(calls.length, 1); assert.equal(calls[0].tenantId, c.tenant.id); assert.equal(calls[0].channelId, 'wa');
  assert.deepEqual(c.current(), before); assert.equal(c.outboxCount(), 0);
});

test('HTTP notas rejeitam autoria e campos de envio injetados sem alteração parcial', async t => {
  const c = await fixture(t), before = c.current(), audit = c.auditCount();
  const invalid = [null, [], noteCommand({ version: 0 }), noteCommand({ version: 1.5 }), noteCommand({ text: ' \n ' }),
    noteCommand({ text: 'x'.repeat(2001) }), noteCommand({ text: 'Nota\u0000inválida' }), noteCommand({ commandId: ' bad key ' }),
    noteCommand({ userId: c.actor.userId }), noteCommand({ authorName: 'Autor forjado' }), noteCommand({ channelId: 'tg' }),
    noteCommand({ attachmentIds: ['foreign-file'] }), noteCommand({ replyToMessageId: 'customer' }), noteCommand({ transport: 'telegram' })];
  for (const input of invalid) assert.equal((await c.post('notes', input)).status, 400, JSON.stringify(input));
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audit);
  const response = await c.post('notes', noteCommand({ text: 'x'.repeat(2000) }));
  assert.equal(response.status, 200); assert.equal(response.data.messages.at(-1).text.length, 2000);
  assertSafeConversation(response.data); assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

function assertSafeSchedule(schedule) {
  for (const key of ['tenantId', 'conversationId', 'resellerId', 'channelId', 'channelKind', 'channelTransport', 'departmentId',
    'commandId', 'commandVersion', 'idempotencyKey', 'claimVersion', 'claimedAt', 'attempts']) {
    assert.equal(Object.hasOwn(schedule, key), false, key);
  }
}

test('HTTP agendamento cria lista e cancela com CAS e replay sem duplicar nem alterar notas', async t => {
  const c = await fixture(t), noted = await c.post('notes', noteCommand());
  assert.equal(noted.status, 200);
  const messages = c.current().messages, dueAt = new Date(Date.now() + 120000).toISOString();
  const input = { version: 2, text: 'Mensagem HTTP para envio futuro.', dueAt, commandId: 'http-scheduled-one' };
  const created = await c.post('scheduled', input);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assertSafeSchedule(created.data); assert.match(created.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.data.text, input.text); assert.equal(created.data.dueAt, dueAt);
  assert.equal(created.data.state, 'pending'); assert.equal(created.data.version, 3);
  assert.equal(created.data.userId, c.alice.id); assert.equal(created.data.authorName, c.alice.name);
  assert.ok(Number.isFinite(Date.parse(created.data.createdAt)));
  const listed = await c.request(`${c.conversationPath}/scheduled`, { cookie: c.alice.cookie });
  assert.equal(listed.status, 200); assert.deepEqual(listed.data.schedules, [created.data]);
  assert.deepEqual(c.current().messages, messages); assert.equal(c.current().unread, 3);
  const changed = await c.post('read-state', { version: 3, unread: false }); assert.equal(changed.status, 200);
  const beforeReplay = c.current(), audit = c.auditCount();
  const replay = await c.post('scheduled', input);
  assert.equal(replay.status, 200); assert.deepEqual(replay.data, { ...created.data, version: 4 });
  assert.equal(c.current().scheduledMessages.length, 1); assert.deepEqual(c.current(), beforeReplay);
  assert.equal(c.auditCount(), audit);
  for (const conflicting of [{ ...input, text: 'Outra mensagem.' }, { ...input, version: 4 },
    { ...input, dueAt: new Date(Date.parse(dueAt) + 60000).toISOString() }, { ...input, commandId: 'http-scheduled-stale' }]) {
    assert.equal((await c.post('scheduled', conflicting)).status, 409);
  }
  assert.deepEqual(c.current(), beforeReplay); assert.equal(c.auditCount(), audit);
  const cancelled = await c.post('scheduled/cancel', { id: created.data.id, version: 4 });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.state, 'cancelled'); assert.equal(cancelled.data.version, 5);
  assertSafeSchedule(cancelled.data); assert.ok(Number.isFinite(Date.parse(cancelled.data.cancelledAt)));
  assert.deepEqual(c.current().messages, messages);
  const afterCancel = c.current(), cancelledAudit = c.auditCount();
  assert.equal((await c.post('scheduled/cancel', { id: created.data.id, version: 4 })).status, 409);
  assert.equal((await c.post('scheduled/cancel', { id: created.data.id, version: 5 })).status, 409);
  const confirmed = await c.post('scheduled', input);
  assert.equal(confirmed.status, 200); assert.deepEqual(confirmed.data, cancelled.data);
  assert.deepEqual(c.current(), afterCancel); assert.equal(c.auditCount(), cancelledAudit);
  const finalList = await c.request(`${c.conversationPath}/scheduled`, { cookie: c.alice.cookie });
  assert.equal(finalList.status, 200); assert.deepEqual(finalList.data.schedules, [cancelled.data]);
  assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

test('HTTP agendamento protege criação listagem e cancelamento por empresa pessoa permissão e escopo', async t => {
  const c = await fixture(t), bob = await c.member(), reader = await c.member({ permissions: ['inbox.read'] });
  const denied = await c.member({ permissions: [] }), outsider = await c.member({ tenantIds: [c.other.id] });
  const restricted = await c.member({ scopeRules: { [c.tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } } });
  const input = { version: 1, text: 'Agendamento HTTP escopado.', dueAt: new Date(Date.now() + 120000).toISOString(), commandId: 'http-scheduled-scope' };
  const created = await c.post('scheduled', input); assert.equal(created.status, 200);
  const cancellation = { id: created.data.id, version: 2 }, state = c.current(), audit = c.auditCount();
  for (const operation of ['list', 'create', 'cancel']) {
    const suffix = operation === 'cancel' ? '/scheduled/cancel' : '/scheduled', method = operation === 'list' ? 'GET' : 'POST';
    const body = operation === 'list' ? undefined : operation === 'create' ? input : cancellation;
    assert.equal((await c.request(c.conversationPath + suffix, { method, body })).status, 401);
    for (const user of [denied, outsider]) assert.equal((await c.request(c.conversationPath + suffix, { method, body, cookie: user.cookie })).status, 403);
    assert.equal((await c.request(`/api/tenants/${c.other.id}/conversations/conv${suffix}`, { method, body, cookie: c.alice.cookie })).status, 403);
    assert.equal((await c.request(`/api/tenants/${c.other.id}/conversations/conv${suffix}`, { method, body, cookie: c.owner.cookie })).status, 404);
    assert.equal((await c.request(c.conversationPath + suffix, { method, body, cookie: c.alice.cookie, workspace: 'foreign-workspace' })).status, 403);
  }
  const readable = await c.request(`${c.conversationPath}/scheduled`, { cookie: reader.cookie });
  assert.equal(readable.status, 200); assert.deepEqual(readable.data.schedules, [created.data]);
  for (const user of [bob, c.owner]) {
    assert.equal((await c.post('scheduled', { ...input, version: 2, commandId: 'http-scheduled-unauthorized' }, user)).status, 409);
    assert.equal((await c.post('scheduled/cancel', cancellation, user)).status, 409);
  }
  assert.equal((await c.post('scheduled', input, reader)).status, 403);
  assert.equal((await c.post('scheduled/cancel', cancellation, reader)).status, 403);
  assert.equal((await c.post('scheduled/cancel', { ...cancellation, id: 'foreign-schedule' })).status, 404);
  assert.deepEqual(c.current(), state); assert.equal(c.auditCount(), audit);
  c.app.store.mutate(c.actor, c.tenant.id, 'Fixture de outra conversa para isolamento de agenda', tenant => {
    tenant.conversations.push({ ...state, id: 'second', messages: [], scheduledMessages: [], version: 1 });
  });
  assert.equal((await c.request(`${c.path}/conversations/second/scheduled/cancel`, {
    method: 'POST', cookie: c.alice.cookie, body: { id: created.data.id, version: 1 } })).status, 404);
  for (const patch of [{ channelId: 'tg' }, { departmentId: 'sales' }]) {
    c.change(conversation => Object.assign(conversation, { channelId: 'wa', departmentId: 'support', assignedUserId: restricted.id }, patch));
    const scopedState = c.current();
    assert.equal((await c.request(`${c.conversationPath}/scheduled`, { cookie: restricted.cookie })).status, 403);
    assert.equal((await c.post('scheduled', input, restricted)).status, 403);
    assert.equal((await c.post('scheduled/cancel', cancellation, restricted)).status, 403);
    assert.deepEqual(c.current(), scopedState);
  }
  c.change(conversation => Object.assign(conversation, { channelId: 'wa', departmentId: 'support', assignedUserId: c.alice.id }));
  c.app.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify([]), c.alice.id);
  assert.equal((await c.request(`${c.conversationPath}/scheduled`, { cookie: c.alice.cookie })).status, 403);
  assert.equal((await c.post('scheduled', input)).status, 403);
  assert.equal((await c.post('scheduled/cancel', cancellation)).status, 403);
  assert.equal(c.current().scheduledMessages[0].state, 'pending');
  assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

test('HTTP agendamento retorna DTO autorizado e omite scheduledMessages bruto de tenant bootstrap e leitura', async t => {
  const c = await fixture(t), marker = 'SCHEDULED_HTTP_BODY_PRIVATE_CANARY';
  c.change(conversation => { conversation.channelId = 'tg'; });
  const created = await c.post('scheduled', { version: 1, text: marker, dueAt: new Date(Date.now() + 120000).toISOString(), commandId: 'http-scheduled-private' });
  assert.equal(created.status, 200); assertSafeSchedule(created.data);
  const noted = await c.post('notes', noteCommand({ version: 2 }));
  assert.equal(noted.status, 200); assert.equal(Object.hasOwn(noted.data, 'scheduledMessages'), false);
  assert.equal(noted.data.messages.at(-1).kind, 'internal');
  for (const user of [c.owner, c.alice]) {
    const tenant = await c.request(c.path, { cookie: user.cookie });
    assert.equal(tenant.status, 200); assertSafeConversation(tenant.data.conversations[0]);
    for (const conversation of tenant.data.conversations) assert.equal(Object.hasOwn(conversation, 'scheduledMessages'), false);
    assert.equal(JSON.stringify(tenant.data).includes(marker), false);
    const bootstrap = await c.request('/api/bootstrap', { cookie: user.cookie });
    assert.equal(bootstrap.status, 200); assert.equal(JSON.stringify(bootstrap.data).includes('scheduledMessages'), false);
    assert.equal(JSON.stringify(bootstrap.data).includes(marker), false);
    const visible = await c.request(`${c.conversationPath}/scheduled`, { cookie: user.cookie });
    assert.equal(visible.status, 200); assert.equal(visible.data.schedules.length, 1);
    assert.equal(visible.data.schedules[0].text, marker); assert.equal(visible.data.schedules[0].version, 3);
    assertSafeSchedule(visible.data.schedules[0]);
  }
  const read = await c.post('read-state', { version: 3, unread: false });
  assert.equal(read.status, 200); assert.equal(Object.hasOwn(read.data, 'scheduledMessages'), false);
  assert.equal(JSON.stringify(read.data).includes(marker), false);
  assert.equal(c.current().scheduledMessages.length, 1); assert.equal(c.current().scheduledMessages[0].state, 'pending');
  assert.equal(c.current().messages.filter(message => message.kind === 'internal').length, 1);
  assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
});

test('scheduler HTTP aguarda conexão viva da empresa antes de criar comando externo', async t => {
  const c = await fixture(t);
  await c.post('scheduled', { version: 1, text: 'Mensagem futura sintética.', dueAt: new Date(Date.now() + 120000).toISOString(), commandId: 'http-scheduled-offline' });
  c.change(conversation => { conversation.scheduledMessages[0].dueAt = new Date(Date.now() - 1000).toISOString(); });
  const before = c.current(), audit = c.auditCount();
  for (const entry of [null, { tenantId: c.tenant.id, state: 'connecting' }, { tenantId: c.other.id, state: 'connected' }]) {
    if (entry) c.app.gateway.entries.set('wa', entry); else c.app.gateway.entries.delete('wa');
    await c.app.scheduled.tick();
    assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audit);
    assert.equal(c.outboxCount(), 0); assert.equal(c.externalCalls.length, 0);
  }
  c.app.gateway.entries.delete('wa');
});
