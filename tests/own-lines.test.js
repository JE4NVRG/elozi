// Own lines: two of our products talking through their paired WhatsApp lines never get agents on both sides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { OwnLines, OwnLinePairError, conversationPhones } from '../src/own-lines.js';
import { ServiceActivity } from '../src/service-activity.js';
import { createApp } from '../src/server.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Operação sintética' };
const FP = '5511991004662', FC = '5511991006828', PERSONAL = '5511991007047';
const jid = number => `${number}@s.whatsapp.net`;

function lines(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.exec('CREATE TABLE IF NOT EXISTS wa_number_bindings (number TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL)');
  const company = (name, channelId, number, session = admin) => {
    const tenant = store.createTenant(session, { name, segment: 'QA' });
    store.mutate(session, tenant.id, 'Linha sintética', state => {
      state.channels = [{ id: channelId, kind: 'whatsapp_qr', name, expectedNumber: number, transport: 'baileys', state: 'connected' }];
      state.conversations = [];
    });
    store.db.prepare('INSERT INTO wa_number_bindings VALUES (?,?,?)').run(number, channelId, tenant.id);
    return tenant.id;
  };
  const talk = (tenantId, channelId, contactNumber, extra = {}, session = admin) => {
    const id = `conv_${randomUUID()}`;
    store.mutate(session, tenantId, 'Conversa sintética', state => {
      state.conversations.push({ id, contact: 'Linha', channelId, remoteJid: jid(contactNumber), remoteAliases: [jid(contactNumber), '1234567890123@lid'], conversationKind: 'direct',
        owner: 'queue', agentId: null, status: 'open', version: 1, messages: [], updatedAt: new Date().toISOString(), ...extra });
    });
    return id;
  };
  const conversation = (tenantId, id, session = admin) => store.tenant(session, tenantId).conversations.find(item => item.id === id);
  const set = (tenantId, id, change, session = admin) => store.mutate(session, tenantId, 'Mudança sintética', state => { change(state.conversations.find(item => item.id === id)); });
  return { store, company, talk, conversation, set };
}

test('par de linhas próprias: só um lado com agente, nono dígito, grupos e outra operação ficam de fora', t => {
  const f = lines(t), records = [];
  const fp = f.company('FamilyPoints', 'fp-line', FP), fc = f.company('FullCommerce', 'fc-line', FC), personal = f.company('Jean pessoal', 'personal-line', PERSONAL);
  const own = new OwnLines(f.store.db, { onBlocked: entry => records.push(entry) });
  // FP talks to the FC line, and the FC side is the same pair seen from the other line (12-digit address without the ninth digit).
  const fpSide = f.talk(fp, 'fp-line', FC, { owner: 'agent', agentId: 'tuca' }), fcSide = f.talk(fc, 'fc-line', '551191004662');
  const pair = own.pair(fp, f.conversation(fp, fpSide));
  assert.deepEqual(pair.line, { tenantId: fc, channelId: 'fc-line', tail: '6828' });
  assert.equal(pair.mirror.id, fcSide); assert.equal(pair.mirror.owner, 'queue');
  assert.equal(own.agentOnOtherSide(fp, f.conversation(fp, fpSide)), false, 'FC side is in the queue');
  assert.equal(own.agentOnOtherSide(fc, f.conversation(fc, fcSide)), true, 'FP side is with Tuca');
  assert.throws(() => own.assertAgentAllowed(fc, f.conversation(fc, fcSide), { action: 'claim', principalId: 'p1' }), error => error instanceof OwnLinePairError && error.status === 409 && error.code === 'OWN_LINE_AGENT_PAIR');
  assert.deepEqual(records, [{ tenantId: fc, conversationId: fcSide, action: 'claim', principalId: 'p1' }]);
  // A closed mirror or a person on the other side frees this side.
  f.set(fp, fpSide, c => { c.status = 'closed'; });
  assert.equal(own.agentOnOtherSide(fc, f.conversation(fc, fcSide)), false);
  f.set(fp, fpSide, c => { c.status = 'open'; c.owner = 'human'; c.agentId = null; });
  assert.equal(own.agentOnOtherSide(fc, f.conversation(fc, fcSide)), false);
  // No mirror yet: the line is known, nothing blocks.
  const fresh = f.talk(personal, 'personal-line', FP);
  assert.equal(own.pair(personal, f.conversation(personal, fresh)).mirror, null);
  // Customers, groups and another workspace's lines are never compared.
  assert.equal(own.pair(fp, f.conversation(fp, f.talk(fp, 'fp-line', '5521988887777'))), null);
  assert.equal(own.pair(fp, { ...f.conversation(fp, fpSide), conversationKind: 'group' }), null);
  f.store.db.prepare("INSERT INTO resellers VALUES ('outra', '{\"name\":\"Outra operação\"}')").run();
  const outsider = { role: 'reseller', resellerId: 'outra', name: 'Outra operação' };
  const other = f.company('Cliente de outra revenda', 'other-line', '5531900001111', outsider);
  assert.equal(own.pair(fp, f.conversation(fp, f.talk(fp, 'fp-line', '5531900001111'))), null);
  assert.equal(own.pair(other, f.conversation(other, f.talk(other, 'other-line', FP, {}, outsider), outsider)), null);
  assert.deepEqual(conversationPhones({ remoteJid: jid(FC), remoteAliases: ['5511991006828:3@s.whatsapp.net', 'x@lid'] }), ['5511991006828']);
});

test('agente padrão não assume a conversa quando a outra linha própria já está com agente', async t => {
  const store = new Store(':memory:'), sockets = [];
  const fp = store.createTenant(admin, { name: 'FamilyPoints', segment: 'QA' }), fc = store.createTenant(admin, { name: 'FullCommerce', segment: 'QA' });
  store.mutate(admin, fc.id, 'Canal FC', state => {
    state.channels.push({ id: 'fc-line', kind: 'whatsapp_qr', name: 'FC', expectedNumber: FC, transport: 'baileys', state: 'disconnected', defaultAgentId: 'sellers' });
    state.agents = [{ id: 'sellers', name: 'Sellers', provider: 'mcp', mode: 'copilot', configured: true, version: 1 }];
  });
  store.mutate(admin, fp.id, 'Canal FP', state => {
    state.channels.push({ id: 'fp-line', kind: 'whatsapp_qr', name: 'FP', expectedNumber: FP, transport: 'baileys', state: 'connected' });
    state.conversations.push({ id: 'fp-side', contact: 'FC', channelId: 'fp-line', remoteJid: jid(FC), remoteAliases: [jid(FC)], conversationKind: 'direct', owner: 'agent', agentId: 'tuca',
      status: 'open', version: 1, messages: [], updatedAt: new Date().toISOString() });
  });
  const factory = config => { const socket = { config, ev: new EventEmitter(), user: { id: FC + ':1@s.whatsapp.net' }, end() {}, logout: async () => {}, sendMessage: async () => ({ key: { id: 'x' } }) }; sockets.push(socket); return socket; };
  const gateway = new WhatsAppGateway(store, { socketFactory: factory, authKey: randomBytes(32), reconnectDelay: 10 });
  store.db.prepare('INSERT OR IGNORE INTO wa_number_bindings VALUES (?,?,?)').run(FP, 'fp-line', fp.id);
  const activity = new ServiceActivity();
  gateway.operations = new Operations(store, new Auth(store.db));
  gateway.ownLines = new OwnLines(store.db, { onBlocked: entry => activity.record({ type: 'own-line', ...entry }) });
  t.after(async () => { await gateway.close(); store.close(); });
  await gateway.start(admin, fc.id, 'fc-line');
  sockets.at(-1).config.auth.creds.me = { id: FC + ':1@s.whatsapp.net' }; sockets.at(-1).ev.emit('creds.update', {});
  sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await new Promise(resolve => setImmediate(resolve));
  const entry = gateway.entries.get('fc-line');
  let seq = 0;
  const receive = from => gateway.receive(entry, { key: { id: `msg-${++seq}`, remoteJid: jid(from), fromMe: false }, pushName: 'Linha', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'Oi' } });
  const fcConversation = from => store.tenant(admin, fc.id).conversations.find(item => item.remoteJid === jid(from));
  await receive(FP);
  assert.deepEqual([fcConversation(FP).owner, fcConversation(FP).agentId], ['queue', null], 'Tuca answers on the FP side, so the FC side stays with the team');
  assert.deepEqual(activity.list().map(item => [item.type, item.action, item.tenantId]), [['own-line', 'default-agent', fc.id]]);
  // A customer (not an own line) still gets the default agent.
  await receive('5521988887777');
  assert.deepEqual([fcConversation('5521988887777').owner, fcConversation('5521988887777').agentId], ['agent', 'sellers']);
});

async function serviceFixture(t) {
  const key = Buffer.alloc(32, 61), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio das linhas próprias'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny },
    webhookOptions: { post: async () => ({ status: 200 }), pollMs: 60000 } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '', token } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString() || 'null'), cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); } });
    });
    pending.on('error', reject); pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner sintético', username: 'lines.owner', password: 'Senha-sintetica-' + randomUUID() } });
  const session = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const company = async (name, channelId, number, agentId) => {
    const tenant = (await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name, segment: 'QA' } })).data;
    app.store.mutate(session, tenant.id, 'Linha sintética', state => {
      state.channels = [{ id: channelId, kind: 'whatsapp_qr', name, expectedNumber: number, transport: 'baileys', state: 'connected' }];
      state.departments = []; state.conversations = [];
      state.agents = [{ id: agentId, name: `Agente ${name}`, provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    });
    app.store.db.prepare('INSERT INTO wa_number_bindings VALUES (?,?,?)').run(number, channelId, tenant.id);
    const created = app.servicePrincipals.create(session, tenant.id, { name: `Identidade ${name}`, agentId, capabilities: ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'],
      channelIds: [channelId], departmentIds: null, dailyRequests: 2000, maxConcurrent: 3, ttlHours: 24 });
    return { tenantId: tenant.id, channelId, token: created.token, actor: app.servicePrincipals.authenticate('Bearer ' + created.token) };
  };
  const talk = (side, contactNumber, extra = {}) => {
    const id = `conv_${randomUUID()}`;
    app.store.mutate(session, side.tenantId, 'Conversa sintética', state => {
      state.conversations.push({ id, contact: 'Linha própria', channelId: side.channelId, remoteJid: jid(contactNumber), remoteAliases: [jid(contactNumber)], conversationKind: 'direct',
        owner: 'queue', agentId: null, assignedUserId: null, status: 'open', version: 1, updatedAt: new Date().toISOString(),
        messages: [{ id: `m_${randomUUID()}`, kind: 'customer', text: 'Oi, tudo bem?', createdAt: new Date().toISOString() }], ...extra });
    });
    return id;
  };
  const conversation = (side, id) => app.store.getConversation(app.store.tenant(session, side.tenantId), id);
  t.after(async () => {
    await app.serviceWebhooks.close(); await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); app.store.close();
  });
  return { app, request, session, company, talk, conversation, owner };
}

test('API de serviço: assumir e responder recusam com 409 OWN_LINE_AGENT_PAIR quando a outra linha já está com agente', async t => {
  const f = await serviceFixture(t);
  const fp = await f.company('FamilyPoints', 'fp-line', FP, 'tuca'), fc = await f.company('FullCommerce', 'fc-line', FC, 'sellers');
  const fpSide = f.talk(fp, FC), fcSide = f.talk(fc, FP);
  // Both in the queue: the FP agent may take its side.
  const claimed = await f.request('/api/service/v1/conversation-claims', { method: 'POST', token: fp.token, body: { requestId: 'claim-fp-0001', conversationId: fpSide, version: f.conversation(fp, fpSide).version } });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data)); assert.equal(f.conversation(fp, fpSide).owner, 'agent');
  // Now the FC agent may not take the mirror side.
  const refused = await f.request('/api/service/v1/conversation-claims', { method: 'POST', token: fc.token, body: { requestId: 'claim-fc-0001', conversationId: fcSide, version: f.conversation(fc, fcSide).version } });
  assert.equal(refused.status, 409); assert.equal(refused.data.code, 'OWN_LINE_AGENT_PAIR'); assert.equal(f.conversation(fc, fcSide).owner, 'queue');
  // The read tells each agent where it stands.
  assert.deepEqual(f.app.serviceApi.read(fc.actor, fcSide).conversation.ownLine, { agentOnOtherSide: true });
  assert.deepEqual(f.app.serviceApi.read(fp.actor, fpSide).conversation.ownLine, { agentOnOtherSide: false });
  // Forced onto both sides (a person assigned it by hand): neither agent answers, before any receipt.
  f.app.store.mutate(f.session, fc.tenantId, 'Atribuição manual sintética', state => { const c = state.conversations.find(item => item.id === fcSide); c.owner = 'agent'; c.agentId = 'sellers'; c.version++; });
  for (const [side, id, token] of [[fc, fcSide, fc.token], [fp, fpSide, fp.token]]) {
    const reply = await f.request('/api/service/v1/replies', { method: 'POST', token, body: { requestId: `reply-${id.slice(5, 17)}`, conversationId: id, version: f.conversation(side, id).version, text: 'Olá!' } });
    assert.equal(reply.status, 409, JSON.stringify(reply.data)); assert.equal(reply.data.code, 'OWN_LINE_AGENT_PAIR');
  }
  const counts = f.app.serviceApi.activity.counts(fc.tenantId);
  assert.equal(counts.ownLineBlocks, 2, 'claim and reply refused on the FC side');
  assert.ok(f.app.serviceApi.activity.list().every(item => !('text' in item) && !('contact' in item)), 'activity never holds content');
});

test('Produtos conectados: só a administração vê, com finais de número, pares e eventos, sem número completo nem texto', async t => {
  const f = await serviceFixture(t);
  const fp = await f.company('FamilyPoints', 'fp-line', FP, 'tuca'), fc = await f.company('FullCommerce', 'fc-line', FC, 'sellers');
  f.app.store.mutate(f.session, fp.tenantId, 'Política sintética', state => { state.channels[0].replyPolicy = { profile: 'assistant', perHour: 120, perMinute: 12, notice: 'Aviso.' }; });
  const fpSide = f.talk(fp, FC, { owner: 'agent', agentId: 'tuca', replyExempt: true }), fcSide = f.talk(fc, FP);
  const refused = await f.request('/api/service/v1/conversation-claims', { method: 'POST', token: fc.token, body: { requestId: 'claim-fc-0002', conversationId: fcSide, version: f.conversation(fc, fcSide).version } });
  assert.equal(refused.status, 409);
  assert.equal((await f.request('/api/platform/connected-products')).status, 401);
  const read = await f.request('/api/platform/connected-products', { cookie: f.owner.cookie });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  const body = read.data, raw = JSON.stringify(body);
  assert.equal(body.ownLines, 2);
  const products = Object.fromEntries(body.products.map(product => [product.name, product]));
  assert.deepEqual(products.FamilyPoints.channels[0].replyPolicy, { profile: 'assistant', perHour: 120, perMinute: 12, notice: true });
  assert.equal(products.FamilyPoints.channels[0].tail, '4662'); assert.deepEqual(products.FamilyPoints.channels[0].automation, ['connected-agent']);
  assert.equal(products.FamilyPoints.qaConversations, 1); assert.equal(products.FullCommerce.sinceStart.ownLineBlocks, 1);
  assert.deepEqual(products.FullCommerce.agents.map(agent => [agent.name, agent.state, agent.webhook.configured]), [['Identidade FullCommerce', 'active', false]]);
  assert.equal(body.pairs.length, 1); assert.equal(body.pairs[0].state, 'one-agent');
  assert.deepEqual(body.pairs[0].sides.map(side => [side.company, side.owner, side.tail]).sort(), [['FamilyPoints', 'agent', '4662'], ['FullCommerce', 'queue', '6828']]);
  assert.deepEqual(body.events.map(event => [event.type, event.company, event.action]), [['own-line', 'FullCommerce', 'claim']]);
  for (const secret of [FP, FC, '551191004662', 'Oi, tudo bem?', 'Linha própria']) assert.equal(raw.includes(secret), false, `sem ${secret}`);
});
