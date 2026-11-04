import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { proto } from '@whiskeysockets/baileys';
import { createApp } from '../src/server.js';

const groupId = '120000000001@g.us', otherGroup = '120000000002@g.us';
const seconds = Math.floor(Date.now() / 1000) - 600;
const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;
const anchorId = 'PRIVATE_NATIVE_HTTP_ANCHOR', providerPrefix = 'PRIVATE_PROVIDER_SESSION_HTTP_';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitGate = (gate, pending) => Promise.race([gate.promise, pending.then(result => assert.fail(`A resposta HTTP ${result.status} chegou antes do await do provedor.`))]);
const raw = (id, timestamp = seconds - 120, extra = {}) => ({
  key: { remoteJid: groupId, id, fromMe: false, participant: '5511999990001@s.whatsapp.net' },
  messageTimestamp: timestamp, pushName: 'Pessoa sintética', message: { conversation: `Histórico ${id}` }, ...extra
});

function publicProjection(dto, sessionToken) {
  assert.deepEqual(Object.keys(dto).sort(), ['anchor', 'channelId', 'conversationId', 'job', 'state', 'tenantId', 'version']);
  assert.deepEqual(Object.keys(dto.anchor), ['available']);
  if (dto.job) {
    assert.deepEqual(Object.keys(dto.job).sort(), ['commandId', 'counters', 'createdAt', 'id', 'requestedLimit', 'state', 'updatedAt']);
    assert.deepEqual(Object.keys(dto.job.counters).sort(), ['duplicates', 'excluded', 'imported', 'requested']);
  }
  const text = JSON.stringify(dto);
  for (const secret of [anchorId, providerPrefix, sessionToken]) assert.equal(text.includes(secret), false, 'A projeção HTTP não contém coordenadas privadas.');
  for (const field of ['providerSession', 'peerDataRequestSessionId', 'cursor', 'requestId', 'timestampSeconds', 'historyCursors', 'remoteJid']) {
    assert.equal(text.includes(`"${field}"`), false, `O DTO não publica ${field}.`);
  }
}

async function fixture(t, { anchor = true } = {}) {
  const key = randomBytes(32), calls = { external: 0, history: [], sends: 0, automation: 0 }, gates = [];
  const deny = async () => { calls.external++; throw Error('Transporte externo proibido na fixture HTTP em RAM.'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, publicOrigin: '', allowRegistration: false,
    providerCall: deny, mcpFetchImpl: deny, googleOptions: { clientId: '' },
    gatewayOptions: { authKey: key, socketFactory: deny, downloadMediaImpl: deny, fetchImpl: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    emailOptions: { key, apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny },
    metaOptions: { fetchImpl: deny, mediaDownloader: deny }, mediaOptions: { directory: null, authKey: key }
  });
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    app.groupHistoryImporter.close(); app.groupSummaries.close();
    await app.scheduled.waitIdle();
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await app.centralSupport.close();
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.bridge.close()]);
    app.store.close(); assert.equal(calls.external, 0); assert.equal(calls.sends, 0); assert.equal(calls.automation, 0);
  });
  let sequence = 0;
  const person = (role, tenantIds = [], permissions = null) => {
    const row = app.auth.insertUser({ username: 'history.http.' + ++sequence, name: 'Pessoa HTTP ' + sequence },
      randomBytes(16), randomBytes(64), role, tenantIds, 'mep-demo');
    if (permissions !== null) app.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(permissions), row.id);
    const fresh = app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id), session = app.auth.session(fresh);
    return { id: row.id, actor: session.actor, token: session.token, cookie: 'mep_session=' + session.token };
  };
  const admin = person('reseller'), secondSession = app.auth.session(app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(admin.id));
  const tenant = app.store.createTenant(admin.actor, { name: 'Histórico HTTP RAM', segment: 'Sintético' });
  const reader = person('operator', [tenant.id], ['inbox.read']), operator = person('operator', [tenant.id], ['inbox.read', 'inbox.reply']);
  const channelId = 'wa-history-http', conversationId = 'history-group';
  app.store.mutate(admin.actor, tenant.id, 'Fixture histórica HTTP em RAM', state => {
    state.channels = [{ id: channelId, name: 'QR sintético', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', enabled: true,
      expectedNumber: '5511999990000', allowedGroups: [groupId, otherGroup], groupNames: { [groupId]: 'Grupo escolhido', [otherGroup]: 'Grupo de controle' } }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }];
    state.agents = [{ id: 'http-agent', name: 'Agente sintético', provider: 'hermes', configured: true, mode: 'copilot', version: 1 }];
    state.contacts = [{ id: 'contact-preserved', name: 'Contato anterior' }];
    state.runs = [{ id: 'run-preserved', status: 'completed' }];
    state.automation = { version: 1, bindings: [], sla: {} };
    state.conversations = [{ id: conversationId, contact: 'Grupo escolhido', conversationKind: 'group', remoteJid: groupId, channelId,
      version: 4, owner: 'human', assignedUserId: operator.id, assignedUserName: 'Pessoa responsável anterior', status: 'closed', unread: 3,
      departmentId: 'support', tags: ['Preservada'], participants: [{ userId: operator.id }], agentId: null,
      updatedAt: new Date((seconds - 1) * 1000).toISOString(), messages: [
        { id: 'local-existing', externalId: 'EXISTING', kind: 'customer', text: 'Mensagem anterior intacta', createdAt: new Date((seconds - 100) * 1000).toISOString() },
        { id: 'private-note', kind: 'internal', text: 'Nota privada preservada', createdAt: new Date((seconds - 99) * 1000).toISOString() },
        { id: 'local-recent', externalId: 'RECENT', kind: 'human', text: 'Envio anterior preservado', authorUserId: operator.id, createdAt: new Date((seconds - 1) * 1000).toISOString() }
      ] }, { id: 'other-group', contact: 'Grupo de controle', conversationKind: 'group', remoteJid: otherGroup, channelId,
        departmentId: 'support', version: 1, owner: 'queue', status: 'open', unread: 0, messages: [] }];
  });
  const entry = { tenantId: tenant.id, channelId, expectedNumber: '5511999990000', actor: app.gateway.actor('mep-demo'), generation: 1,
    state: 'connected', matched: true, groupCache: new Map(), historyCursors: new Map(), socket: {
      end() {}, sendMessage: async () => { calls.sends++; return { key: { id: 'NEVER_SEND_HISTORY' } }; },
      fetchMessageHistory: async (count, cursor, timestamp) => {
        const id = providerPrefix + (calls.history.length + 1); calls.history.push({ id, count, key: structuredClone(cursor), timestamp }); return id;
      }
    } };
  app.gateway.entries.set(channelId, entry);
  if (anchor) app.gateway.rememberHistoryCursor(entry, raw(anchorId, seconds));
  app.gateway.rememberHistoryCursor(entry, raw('PRIVATE_SECOND_ANCHOR', seconds, { key: { remoteJid: otherGroup, id: 'PRIVATE_SECOND_ANCHOR', fromMe: false } }));
  const onIncoming = app.automation.onIncoming.bind(app.automation);
  app.automation.onIncoming = (...args) => { calls.automation++; return onIncoming(...args); };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, path = `/api/tenants/${tenant.id}/conversations/${conversationId}/group-history-import`;
  const request = (options = {}, route = path) => {
    const { method = 'GET', cookie = admin.cookie, body, token, headers = {} } = options;
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString(), json = response.headers['content-type']?.includes('application/json');
            resolve({ status: response.statusCode, data: json ? JSON.parse(text) : text, headers: response.headers });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(Error('A fixture histórica HTTP excedeu o prazo.')));
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const current = () => app.store.getConversation(app.store.tenant(admin.actor, tenant.id), conversationId);
  const state = () => app.store.tenant(admin.actor, tenant.id);
  const snapshot = () => ({ conversation: structuredClone(current()), contacts: structuredClone(state().contacts), channels: structuredClone(state().channels),
    otherConversations: structuredClone(state().conversations.filter(c => c.id !== conversationId)), runs: structuredClone(state().runs), automation: structuredClone(state().automation),
    outbox: app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,
    receipts: app.store.db.prepare('SELECT channel_id,remote_jid,message_id FROM wa_seen ORDER BY channel_id,remote_jid,message_id').all(),
    imports: app.store.db.prepare("SELECT count(*) n FROM audit WHERE action='WhatsApp: histórico importado pelo administrador'").get().n });
  const input = (extra = {}) => ({ version: current().version, limit: 50, commandId: randomUUID(), ...extra });
  const start = (body = input(), options = {}) => request({ method: 'POST', body, ...options });
  const change = fn => app.store.mutate(admin.actor, tenant.id, 'Alteração sintética de seleção', fn);
  const event = (messages, extra = {}) => ({ syncType: ON_DEMAND, peerDataRequestSessionId: calls.history.at(-1)?.id, messages, ...extra });
  const hold = () => {
    const gate = { entered: deferred(), release: deferred() }; gates.push(gate);
    entry.socket.fetchMessageHistory = async (count, cursor, timestamp) => {
      const id = providerPrefix + (calls.history.length + 1); calls.history.push({ id, count, key: structuredClone(cursor), timestamp });
      gate.entered.resolve(); await gate.release.promise; return id;
    };
    return gate;
  };
  const revoke = async mode => {
    if (mode === 'logout') assert.equal((await request({ method: 'POST' }, '/api/auth/logout')).status, 200);
    if (mode === 'acl') app.store.db.prepare('UPDATE auth_users SET role=?,tenant_ids=?,permissions=? WHERE id=?').run('operator', JSON.stringify([tenant.id]), JSON.stringify(['inbox.read']), admin.id);
    if (mode === 'selection') change(value => { value.channels[0].allowedGroups = []; });
  };
  const service = () => app.servicePrincipals.create(admin.actor, tenant.id, { name: 'Serviço sintético RAM', agentId: 'http-agent',
    capabilities: ['conversation.read'], channelIds: [channelId], departmentIds: ['support'], dailyRequests: 2, maxConcurrent: 1, ttlHours: 1 });
  return { app, admin, reader, operator, secondCookie: 'mep_session=' + secondSession.token, tenant, channelId, entry, calls, path,
    request, current, state, snapshot, input, start, change, event, hold, revoke, service };
}

test('HTTP importação exige administrador humano; leitura da caixa, responsabilidade e bearer de serviço não concedem importação', async t => {
  const f = await fixture(t), before = f.snapshot(), service = f.service();
  for (const method of ['GET', 'POST']) {
    for (const [options, expected] of [[{ cookie: '' }, 401], [{ cookie: f.reader.cookie }, 403], [{ cookie: f.operator.cookie }, 403], [{ cookie: '', token: service.token }, 401]]) {
      const result = await f.request({ method, ...(method === 'POST' ? { body: f.input() } : {}), ...options });
      assert.equal(result.status, expected); assert.equal(result.data.job, undefined); assert.equal(result.data.anchor, undefined);
    }
  }
  const ready = await f.request(); assert.equal(ready.status, 200); assert.equal(ready.data.state, 'idle'); assert.equal(ready.data.anchor.available, true);
  publicProjection(ready.data, f.admin.token); assert.equal(f.calls.history.length, 0); assert.deepEqual(f.snapshot(), before);
});

test('HTTP assets de importação estão registrados e consulta aceita somente commandId único', async t => {
  const f = await fixture(t), before = f.snapshot(), commandId = randomUUID();
  // group-history-import.css was emptied by P7 and removed in P10 (FRONTEND-V2 §8.1): the panel styles live in
  // screen-channels.css and the old path is no longer served.
  assert.equal((await f.request({ cookie: '' }, '/group-history-import.css')).status, 404);
  for (const [asset, mime, content] of [['/group-history-import-ui.js', /javascript/, /createGroupHistoryImportUI/], ['/screen-channels.css', /css/, /\.group-history-import-panel \{/]]) {
    const result = await f.request({ cookie: '' }, asset); assert.equal(result.status, 200); assert.match(result.headers['content-type'], mime); assert.match(String(result.data), content);
  }
  const valid = await f.request({}, f.path + '?commandId=' + commandId); assert.equal(valid.status, 200); publicProjection(valid.data, f.admin.token);
  for (const query of ['cursor=RAW_NATIVE_CURSOR', 'providerSession=RAW_PROVIDER_SESSION', 'limit=50', 'tenantId=another', 'commandId=bad', `commandId=${commandId}&commandId=${commandId}`]) {
    const result = await f.request({}, f.path + '?' + query); assert.equal(result.status, 400); assert.equal(result.data.job, undefined);
  }
  assert.equal((await f.request({ method: 'POST', body: f.input() }, f.path + '?commandId=' + commandId)).status, 400);
  assert.equal(f.calls.history.length, 0); assert.deepEqual(f.snapshot(), before);
});

test('HTTP POST rejeita coordenadas nativas e grupo/canal/empresa fornecidos pelo cliente antes de pedir histórico', async t => {
  const f = await fixture(t), before = f.snapshot();
  for (const extra of [{ cursor: { key: { remoteJid: groupId, id: anchorId, fromMe: false }, timestampSeconds: seconds } },
    { providerSession: providerPrefix + 'FORGED' }, { peerDataRequestSessionId: 'FORGED' }, { groupId: otherGroup }, { channelId: 'foreign-channel' }, { tenantId: 'foreign-tenant' }]) {
    assert.equal((await f.start(f.input(extra))).status, 400);
  }
  assert.equal(f.calls.history.length, 0); assert.equal(f.app.groupHistoryImporter.jobs.size, 0); assert.deepEqual(f.snapshot(), before);
});

test('HTTP sem âncora nativa informa need_anchor e não reconstrói cursor de externalId/data de mensagem local', async t => {
  const f = await fixture(t, { anchor: false }), before = f.snapshot();
  assert.ok(f.current().messages.some(message => message.externalId && message.createdAt));
  const read = await f.request(); assert.equal(read.status, 200); assert.equal(read.data.state, 'need_anchor'); assert.equal(read.data.anchor.available, false);
  publicProjection(read.data, f.admin.token); assert.equal((await f.start()).status, 409);
  assert.equal(f.calls.history.length, 0); assert.equal(f.app.groupHistoryImporter.jobs.size, 0); assert.deepEqual(f.snapshot(), before);
});

test('HTTP POST→chunks ON_DEMAND correlacionados→GET importa cronologicamente sem owner/unread/envio/automação e replay não duplica', async t => {
  const f = await fixture(t), before = f.snapshot(), schema = f.app.store.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all(), input = f.input();
  const started = await f.start(input); assert.equal(started.status, 202, started.data.error); assert.equal(started.data.state, 'pending');
  publicProjection(started.data, f.admin.token); assert.equal(f.calls.history.length, 1);
  assert.equal(f.calls.history[0].count, 50); assert.equal(f.calls.history[0].key.id, anchorId); assert.equal(f.calls.history[0].timestamp, seconds);
  assert.deepEqual(f.snapshot(), before);
  const uncorrelated = f.event([raw('UNRELATED')], { peerDataRequestSessionId: providerPrefix + 'OTHER' });
  assert.equal(await f.app.groupHistoryImporter.receive(f.entry, uncorrelated), false);
  assert.equal(await f.app.groupHistoryImporter.receive(f.entry, f.event([raw('FULL_SYNC')], { syncType: proto.HistorySync.HistorySyncType.FULL })), false);
  assert.deepEqual(f.snapshot(), before);
  const finalChunk = f.event([raw('OWN_OLD', seconds - 80, { key: { remoteJid: groupId, id: 'OWN_OLD', fromMe: true } }), raw('EXISTING', seconds - 100)], { chunkOrder: 1, progress: 100 });
  const pending = await f.app.groupHistoryImporter.receive(f.entry, finalChunk); assert.equal(pending.state, 'pending'); assert.equal(pending.job.counters.imported, 0);
  await f.app.groupHistoryImporter.receive(f.entry, finalChunk); assert.deepEqual(f.snapshot(), before);
  const firstChunk = f.event([raw('EARLIEST', seconds - 140), raw('WRONG_GROUP', seconds - 150, { key: { remoteJid: otherGroup, id: 'WRONG_GROUP', fromMe: false } })], { chunkOrder: 0, progress: 50 });
  const completed = await f.app.groupHistoryImporter.receive(f.entry, firstChunk); assert.equal(completed.state, 'completed');
  const status = await f.request({}, f.path + '?commandId=' + input.commandId); assert.equal(status.status, 200); assert.equal(status.data.job.id, started.data.job.id);
  publicProjection(status.data, f.admin.token); assert.equal(status.data.state, 'completed');
  assert.deepEqual(status.data.job.counters, { imported: 2, duplicates: 1, excluded: 1, requested: 50 });
  const after = f.snapshot(); assert.equal(after.conversation.version, before.conversation.version + 1);
  assert.deepEqual({ ...after.conversation, messages: before.conversation.messages, version: before.conversation.version }, before.conversation);
  assert.deepEqual(after.conversation.messages.filter(message => !message.imported), before.conversation.messages);
  assert.deepEqual(after.conversation.messages.map(message => message.externalId || message.id), ['EARLIEST', 'EXISTING', 'private-note', 'OWN_OLD', 'RECENT']);
  const own = after.conversation.messages.find(message => message.externalId === 'OWN_OLD'); assert.equal(own.kind, 'human'); assert.equal(own.delivery, 'sent'); assert.equal(own.authorUserId, undefined);
  for (const field of ['contacts', 'channels', 'otherConversations', 'runs', 'automation', 'outbox']) assert.deepEqual(after[field], before[field]);
  assert.equal(after.imports, before.imports + 1); assert.equal(after.receipts.length, before.receipts.length + 2);
  assert.deepEqual(f.app.store.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all(), schema);
  const replay = await f.start(input); assert.equal(replay.status, 202); assert.equal(replay.data.job.id, started.data.job.id); assert.equal(replay.data.state, 'completed');
  assert.equal(f.calls.history.length, 1); assert.equal(await f.app.groupHistoryImporter.receive(f.entry, firstChunk), false); assert.deepEqual(f.snapshot(), after);
  assert.equal((await f.request({}, `/api/tenants/${f.tenant.id}/conversations/other-group/group-history-import?commandId=${input.commandId}`)).status, 403);
});

for (const mode of ['logout', 'acl', 'selection']) {
  test(`HTTP revalida ${mode} durante await do provedor antes de confirmar POST e bloqueia resposta nativa tardia`, async t => {
    const f = await fixture(t), before = f.snapshot(), gate = f.hold(), pending = f.start();
    await waitGate(gate.entered, pending); await f.revoke(mode); gate.release.resolve();
    const result = await pending; assert.equal(result.status, mode === 'logout' ? 401 : 403); assert.equal(result.data.job, undefined);
    assert.equal(await f.app.groupHistoryImporter.receive(f.entry, f.event([raw('LATE_AFTER_AWAIT')])), false);
    const after = f.snapshot(); assert.deepEqual(after.conversation, before.conversation); assert.deepEqual(after.receipts, before.receipts); assert.equal(after.imports, before.imports); assert.equal(after.outbox, before.outbox);
    assert.equal([...f.app.groupHistoryImporter.jobs.values()][0].state, 'cancelled');
  });
  test(`HTTP POST202 não retém autoridade: ${mode} antes do ON_DEMAND cancela importação sem escrita`, async t => {
    const f = await fixture(t), before = f.snapshot(), input = f.input(), started = await f.start(input);
    assert.equal(started.status, 202); publicProjection(started.data, f.admin.token); await f.revoke(mode);
    assert.equal(await f.app.groupHistoryImporter.receive(f.entry, f.event([raw('LATE_AFTER_POST')])), false);
    assert.equal(f.app.groupHistoryImporter.jobs.get(started.data.job.id).state, 'cancelled');
    const after = f.snapshot(); assert.deepEqual(after.conversation, before.conversation); assert.deepEqual(after.receipts, before.receipts); assert.equal(after.imports, before.imports); assert.equal(after.outbox, before.outbox);
    if (mode === 'logout') {
      assert.equal((await f.request()).status, 401);
      const read = await f.request({ cookie: f.secondCookie }, f.path + '?commandId=' + input.commandId);
      assert.equal(read.status, 200); assert.equal(read.data.state, 'cancelled'); publicProjection(read.data, f.admin.token);
    } else assert.equal((await f.request({}, f.path + '?commandId=' + input.commandId)).status, 403);
  });
}

test('HTTP job revalida sessão também dentro do commit de receive e reverte receipts/audit/mensagens', async t => {
  const f = await fixture(t), before = f.snapshot(), started = await f.start(); assert.equal(started.status, 202);
  const mutate = f.app.store.mutate.bind(f.app.store);
  f.app.store.mutate = (actor, id, action, update) => {
    if (action === 'WhatsApp: histórico importado pelo administrador') f.app.auth.logout(f.admin.token);
    return mutate(actor, id, action, update);
  };
  await assert.rejects(f.app.groupHistoryImporter.receive(f.entry, f.event([raw('REVOKED_AT_COMMIT')])), error => error.status === 401);
  assert.equal(f.app.groupHistoryImporter.jobs.get(started.data.job.id).state, 'cancelled'); assert.deepEqual(f.snapshot(), before);
});
