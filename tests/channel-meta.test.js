import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { MetaGateway } from '../src/channel-meta.js';
import { Outbox } from '../src/outbox.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', userId: 'meta-fixture-user', name: 'Administrador sintético' };
const appSecret = 'synthetic-meta-app-secret';
const accessToken = 'synthetic-meta-access-token';
const verifyToken = 'synthetic-meta-verify-token';
const resourceId = '123456789001';
const senderId = '987654321001';
const status = code => error => error.status === code;

test('guard de sessão false recusa configuração, entrada de credencial e envio sem herdar autoridade', async t => {
  const c = setup(t); let keys = 0;
  const original = c.gateway.secrets.bind(c.gateway); c.gateway.secrets = (...args) => { keys++; return original(...args); };
  await assert.rejects(c.configure({}, { reauthorize: () => false }), status(403)); assert.equal(keys, 0);
  await c.configure(); await c.webhook(); c.claim(); const before = keys;
  await assert.rejects(c.send({}, { reauthorize: () => false }), status(403)); assert.equal(keys, before); assert.equal(c.calls.length, 0);
});

function setup(t, kind = 'messenger', options = {}) {
  const store = new Store(':memory:'), authKey = randomBytes(32), tenant = store.createTenant(actor, { name: 'Meta QA', segment: 'Fixture RAM' }), channelId = `meta-${kind}-fixture`;
  store.mutate(actor, tenant.id, 'Fixture canal Meta', state => { state.channels.push({ id: channelId, kind, state: 'planned' }); });
  let now = Date.parse('2026-10-03T12:00:00.000Z'), authorized = true;
  const calls = [], incoming = [], routed = [];
  const operations = {
    admin(input) { if (!authorized || input.role !== 'reseller' || input.supportGrantId || input.kind === 'service') throw Object.assign(new Error('Synthetic authorization denial'), { status: 403 }); },
    canReply(input, id, conversation) { if (!authorized || !input.userId || (conversation.assignedUserId && input.userId !== conversation.assignedUserId)) throw Object.assign(new Error('Synthetic reply denial'), { status: 403 }); },
    routeIncoming(id, conversationId) { routed.push([id, conversationId]); },
  };
  const gateway = new MetaGateway(store, { authKey, operations, now: () => now, onIncoming: (...args) => incoming.push(args),
    fetchImpl: async (url, input) => { calls.push({ url, input }); if (options.sendResponse) return options.sendResponse(url, input); return { ok: true, status: 200, json: async () => ({ recipient_id: senderId, message_id: 'outbound-fixture-mid' }) }; }, ...options });
  t.after(async () => { await gateway.close(); store.close(); });
  const payload = (extras = {}) => ({ object: kind === 'messenger' ? 'page' : 'instagram', entry: [{ id: resourceId, messaging: [{ sender: { id: senderId }, recipient: { id: resourceId },
    timestamp: now, message: { mid: 'inbound-fixture-mid', text: 'Mensagem sintética recebida' }, ...extras }] }] });
  const webhook = (body = payload(), signatureKey = appSecret) => { const raw = Buffer.from(JSON.stringify(body)); return gateway.receiveWebhook(tenant.id, channelId, raw, 'sha256=' + createHmac('sha256', signatureKey).update(raw).digest('hex')); };
  const configure = (extras = {}, settings) => gateway.configure(actor, tenant.id, channelId, { version: 0, apiVersion: 'v23.0', resourceId, enabled: true, accessToken, appSecret, verifyToken, ...extras }, settings);
  const channel = () => store.tenant(actor, tenant.id).channels.find(channel => channel.id === channelId);
  const conversation = () => store.tenant(actor, tenant.id).conversations.find(conversation => conversation.channelId === channelId && conversation.socialResourceId === resourceId);
  const claim = () => store.mutate(actor, tenant.id, 'Fixture responsável', state => { const c = state.conversations.find(c => c.id === conversation().id); c.owner = 'human'; c.assignedUserId = actor.userId; c.version++; });
  const send = (extras = {}, settings) => gateway.send(actor, tenant.id, conversation().id, { channelId, version: conversation().version, text: 'Resposta sintética', ...extras }, settings);
  return { store, tenant, channelId, gateway, calls, incoming, routed, payload, webhook, configure, channel, conversation, claim, send,
    revoke: () => { authorized = false; }, clock: value => { now = value; }, secrets: () => encryptedChannelSecrets(store.db, authKey) };
}

for (const kind of ['messenger', 'instagram']) {
  test(`${kind}: configuração cifra os três segredos e exige versão API explícita`, async t => {
    const c = setup(t, kind), configured = await c.configure();
    assert.equal(configured.state, 'configured');
    assert.equal(configured.version, 1);
    assert.equal(configured.lastWebhookAt, null);
    assert.equal(c.calls.length, 0);
    assert.equal(c.channel().transport, `meta-${kind}`);
    const publicData = JSON.stringify(c.store.tenant(actor, c.tenant.id));
    for (const secret of [appSecret, accessToken, verifyToken]) assert.equal(publicData.includes(secret), false);
    const blob = c.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get(c.channelId).payload;
    assert.equal(Buffer.from(blob).includes(Buffer.from(appSecret)), false);
    assert.equal(c.secrets().get(c.channelId).meta.accessToken, accessToken);
    assert.equal(await c.gateway.verifyWebhook(c.tenant.id, c.channelId, { 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': '12345' }), '12345');
    await assert.rejects(c.gateway.verifyWebhook(c.tenant.id, c.channelId, { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': '12345' }), status(403));
  });

  test(`${kind}: entrada HMAC, dedupe durável, ID social e retorno real de mensagem`, async t => {
    const c = setup(t, kind); await c.configure();
    const body = c.payload();
    assert.deepEqual(await c.webhook(body), { accepted: true, received: 1, replayed: 0 });
    const current = c.conversation();
    assert.equal(current.remoteSocialId, senderId);
    assert.equal(current.socialResourceId, resourceId);
    assert.equal(current.socialKind, kind);
    assert.equal(current.owner, 'queue');
    assert.equal(current.messages[0].externalId, `${kind}:${resourceId}:${senderId}:inbound-fixture-mid`);
    assert.equal(current.messages[0].delivery, 'received');
    assert.equal(c.incoming.length, 1);
    assert.equal(c.routed.length, 1);
    const revision = current.version;
    assert.deepEqual(await c.webhook(body), { accepted: true, received: 0, replayed: 1 });
    assert.equal(c.conversation().version, revision);
    assert.equal(c.conversation().messages.length, 1);
    assert.equal(c.incoming.length, 1);
    const altered = structuredClone(body); altered.entry[0].messaging[0].message.text = 'Outro conteúdo';
    await assert.rejects(c.webhook(altered), status(409));
    assert.equal(c.conversation().messages.length, 1);
    c.claim();
    const sent = await c.send();
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].url, `https://${kind === 'messenger' ? 'graph.facebook.com' : 'graph.instagram.com'}/v23.0/${resourceId}/messages`);
    assert.equal(c.calls[0].input.redirect, 'error');
    assert.equal(c.calls[0].input.headers.Authorization, `Bearer ${accessToken}`);
    assert.deepEqual(JSON.parse(c.calls[0].input.body), { recipient: { id: senderId }, message: { text: 'Resposta sintética' }, ...(kind === 'messenger' ? { messaging_type: 'RESPONSE' } : {}) });
    assert.equal(sent.messages.at(-1).delivery, 'sent');
    assert.equal(sent.messages.at(-1).externalId, `${kind}:${resourceId}:${senderId}:outbound-fixture-mid`);
  });

  test(`${kind}: incoming links CRM once and preserves archived edited fields without interpreting Meta ID as phone`, async t => {
    const c = setup(t, kind); await c.configure(); await c.webhook();
    const state = () => c.store.tenant(actor, c.tenant.id), original = (state().contacts || []).find(item => item.id === c.conversation().contactId);
    assert.ok(original, 'O contato deve ser vinculado na transação Meta.');
    assert.equal(original.phone, ''); assert.equal(original.email, ''); assert.equal(original.version, 1); assert.equal(c.conversation().contactSyncStatus, 'linked');
    assert.deepEqual(original.identities, [{ channelId: c.channelId, kind: 'person', externalId: 'conversation:' + c.conversation().id }]);
    c.store.mutate(actor, c.tenant.id, 'Fixture: CRM editado e arquivado', tenant => {
      const contact = tenant.contacts.find(item => item.id === original.id);
      Object.assign(contact, { name: 'Nome editado pela equipe', email: 'edited@example.test', phone: '11 99999-1111', notes: 'Anotações preservadas', tags: ['CRM QA'], archivedAt: '2026-10-03T11:59:00.000Z', version: 7 });
    });
    const saved = structuredClone(state().contacts[0]);
    await c.webhook(c.payload({ message: { mid: 'next-contact-meta-mid', text: 'Entrada nova' } }));
    assert.equal(c.conversation().contactId, original.id); assert.deepEqual(state().contacts[0], saved);
    const beforeReplay = JSON.stringify(state());
    assert.equal((await c.webhook()).replayed, 1); assert.equal(JSON.stringify(state()), beforeReplay);
    assert.equal(state().contacts.length, 1); assert.equal(c.calls.length, 0);
  });

  test(`${kind}: channel/tenant/sender isolation does not merge CRM contacts with the same displayed name`, async t => {
    const c = setup(t, kind); await c.configure(); await c.webhook();
    await c.webhook(c.payload({ sender: { id: '5511999991111' }, message: { mid: 'other-sender-mid', text: 'Outro remetente' } }));
    const other = c.store.createTenant(actor, { name: 'Meta outro CRM RAM', segment: 'QA' });
    for (const [tenantId, channelId, resource] of [[c.tenant.id, 'meta-second-contact-channel', '223456789001'], [other.id, 'meta-other-contact-channel', '323456789001']]) {
      c.store.mutate(actor, tenantId, 'Fixture: canal Meta separado', tenant => tenant.channels.push({ id: channelId, kind, state: 'planned' }));
      await c.gateway.configure(actor, tenantId, channelId, { version: 0, apiVersion: 'v23.0', resourceId: resource, enabled: true, accessToken, appSecret, verifyToken });
      const body = c.payload(); body.entry[0].id = resource; body.entry[0].messaging[0].recipient.id = resource;
      const raw = Buffer.from(JSON.stringify(body)); await c.gateway.receiveWebhook(tenantId, channelId, raw, 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex'));
    }
    const same = c.store.tenant(actor, c.tenant.id), foreign = c.store.tenant(actor, other.id), contacts = [...same.contacts, ...foreign.contacts];
    assert.equal(same.contacts.length, 3); assert.equal(foreign.contacts.length, 1); assert.equal(new Set(contacts.map(item => item.id)).size, 4);
    for (const contact of contacts) { assert.equal(contact.phone, ''); assert.equal(contact.email, ''); }
    for (const conversation of same.conversations) assert.ok(same.contacts.find(item => item.id === conversation.contactId && item.identities.some(identity => identity.channelId === conversation.channelId && identity.externalId === 'conversation:' + conversation.id)));
    assert.equal(c.calls.length, 0);
  });

  test(`${kind}: full CRM retains incoming message/receipt and links next non-replayed event once capacity returns`, async t => {
    const c = setup(t, kind); await c.configure();
    c.store.mutate(actor, c.tenant.id, 'Fixture: CRM cheio em RAM', state => { state.contacts = Array.from({ length: 10000 }, (_, n) => ({ id: 'meta-capacity-' + n, name: 'Contato sintético ' + n, type: 'person', identities: [], version: 1, email: '', phone: '', notes: '', tags: [] })); });
    const contactsBefore = JSON.stringify(c.store.tenant(actor, c.tenant.id).contacts);
    assert.equal((await c.webhook()).received, 1); const current = c.conversation();
    assert.equal(current.contactId, undefined); assert.equal(current.contactSyncStatus, 'capacity'); assert.equal(current.messages.length, 1);
    assert.equal(JSON.stringify(c.store.tenant(actor, c.tenant.id).contacts), contactsBefore); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 1);
    c.store.mutate(actor, c.tenant.id, 'Fixture: vaga sintética', state => state.contacts.pop());
    assert.equal((await c.webhook()).replayed, 1); assert.equal(c.conversation().contactId, undefined);
    await c.webhook(c.payload({ message: { mid: 'meta-after-capacity', text: 'Nova entrada com vaga' } }));
    const state = c.store.tenant(actor, c.tenant.id), linked = c.conversation();
    assert.equal(linked.id, current.id); assert.equal(linked.messages.length, 2); assert.equal(linked.contactSyncStatus, 'linked');
    assert.equal(state.contacts.length, 10000); assert.ok(state.contacts.find(item => item.id === linked.contactId)); assert.equal(c.calls.length, 0);
  });
}

test('Meta ingress revoked during encrypted loader cannot create CRM identity/conversation/receipt', async t => {
  for (const change of ['configuration', 'credentials']) {
    const c = setup(t); await c.configure();
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    c.gateway.secretLoader = async () => { entered(); await waiting; return c.secrets(); };
    const pending = c.webhook(); await started;
    if (change === 'configuration') c.store.mutate(actor, c.tenant.id, 'Fixture: configuração revogada', tenant => { const channel = tenant.channels.find(item => item.id === c.channelId); channel.meta.enabled = false; channel.meta.version++; });
    else { const stored = c.secrets().get(c.channelId); c.secrets().set(c.channelId, { ...stored, meta: { ...stored.meta, appSecret: null } }); }
    release(); await assert.rejects(pending, status(change === 'configuration' ? 409 : 403));
    const state = c.store.tenant(actor, c.tenant.id);
    assert.deepEqual(state.contacts || [], []); assert.deepEqual(state.conversations, []); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 0);
    assert.equal(c.calls.length, 0); assert.equal(c.incoming.length, 0); assert.equal(c.routed.length, 0);
  }
});

test('assinatura aplica aos bytes originais, não JSON reserializado ou SHA1', async t => {
  const c = setup(t); await c.configure();
  const raw = Buffer.from(JSON.stringify(c.payload(), null, 2));
  const signed = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
  await assert.rejects(c.gateway.receiveWebhook(c.tenant.id, c.channelId, Buffer.from(JSON.stringify(JSON.parse(raw))), signed), status(403));
  await assert.rejects(c.gateway.receiveWebhook(c.tenant.id, c.channelId, raw, 'sha1=' + '0'.repeat(40)), status(403));
  await assert.rejects(c.webhook(c.payload(), 'wrong-app-secret'), status(403));
  await c.gateway.receiveWebhook(c.tenant.id, c.channelId, raw, signed);
  assert.equal(c.conversation().messages.length, 1);
});

test('recurso, destinatário, empresa e tipo de objeto são segregados', async t => {
  const c = setup(t); await c.configure();
  const wrongResource = c.payload(); wrongResource.entry[0].id = '999999';
  const wrongRecipient = c.payload({ recipient: { id: '999999' } });
  const wrongObject = c.payload(); wrongObject.object = 'instagram';
  await assert.rejects(c.webhook(wrongResource), status(403));
  await assert.rejects(c.webhook(wrongRecipient), status(403));
  await assert.rejects(c.webhook(wrongObject), status(400));
  const raw = Buffer.from(JSON.stringify(c.payload())), signature = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
  await assert.rejects(c.gateway.receiveWebhook('wrong-tenant', c.channelId, raw, signature), status(404));
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 0);
});

test('vínculo único do recurso impede configurar o mesmo Page em outro canal/empresa', async t => {
  const c = setup(t); await c.configure();
  const other = c.store.createTenant(actor, { name: 'Outra empresa QA', segment: 'Fixture' });
  c.store.mutate(actor, other.id, 'Fixture', state => state.channels.push({ id: 'another-meta-channel', kind: 'messenger' }));
  await assert.rejects(c.gateway.configure(actor, other.id, 'another-meta-channel', { version: 0, resourceId, apiVersion: 'v23.0', enabled: true, accessToken, appSecret, verifyToken }), status(409));
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_channel_bindings').get().n, 1);
  assert.equal(c.secrets().get('another-meta-channel'), null);
});

test('echo, sistema e mensagem unsupported não abrem atendimentos ou janela de resposta', async t => {
  const c = setup(t); await c.configure();
  await c.webhook(c.payload({ message: { mid: 'echo-mid', text: 'Eco', is_echo: true } }));
  await c.webhook(c.payload({ message: null, delivery: { mids: ['outgoing-mid'] } }));
  await c.webhook(c.payload({ message: { mid: 'unsupported-mid', is_unsupported: true } }));
  assert.equal(c.conversation(), undefined);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 0);
});

test('mídia de entrada guarda referência escopada sem carregar URL arbitrária', async t => {
  const c = setup(t, 'instagram'); await c.configure();
  await c.webhook(c.payload({ message: { mid: 'media-mid', attachments: [{ type: 'image', payload: { url: 'http://127.0.0.1/private?access_token=untrusted' } }] } }));
  const attachment = c.conversation().messages[0].attachments[0];
  assert.deepEqual(attachment.remoteReference, { kind: 'instagram', resourceId, messageId: 'media-mid', index: 0 });
  assert.equal(attachment.status, 'unavailable');
  assert.equal(attachment.preview, false);
  assert.equal(JSON.stringify(c.store.tenant(actor, c.tenant.id)).includes('127.0.0.1'), false);
  assert.equal(c.calls.length, 0);
});

test('batch com ID repetido e conteúdo alterado reverte recibos e mensagens', async t => {
  const c = setup(t); await c.configure();
  const body = c.payload(), altered = structuredClone(body.entry[0].messaging[0]); altered.message.text = 'Mensagem alterada no lote';
  body.entry[0].messaging.push(altered);
  await assert.rejects(c.webhook(body), status(409));
  assert.equal(c.conversation(), undefined);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 0);
  assert.equal(c.channel().state, 'configured');
});

test('janela de resposta exige receipt persistente, fonte recente e expira em 24 horas', async t => {
  const c = setup(t), initial = Date.parse('2026-10-03T12:00:00.000Z'); await c.configure(); await c.webhook(); c.claim();
  c.clock(initial + 24 * 3600_000 - 1); await c.send();
  c.clock(initial + 24 * 3600_000); await assert.rejects(c.send(), status(409));
  const second = c.payload({ message: { mid: 'second-inbound-mid', text: 'Nova mensagem' } });
  await c.webhook(second); await c.send();
  assert.equal(c.calls.length, 2);
  c.store.db.prepare('DELETE FROM meta_inbound_receipts WHERE tenant_id=?').run(c.tenant.id);
  await assert.rejects(c.send(), status(409));
  assert.equal(c.calls.length, 2);
});

test('novo evento antigo/futuro, texto excessivo, corpo e lote acima dos limites falham', async t => {
  const c = setup(t, 'messenger', { maxEventAgeMs: 60_000, maxEvents: 1, maxBodyBytes: 2048 }); await c.configure();
  await assert.rejects(c.webhook(c.payload({ timestamp: Date.parse('2026-10-03T11:58:00.000Z') })), status(400));
  await assert.rejects(c.webhook(c.payload({ timestamp: Date.parse('2026-10-03T13:00:00.000Z') })), status(400));
  await assert.rejects(c.webhook(c.payload({ message: { mid: 'oversized-mid', text: 'a'.repeat(5000) } })), status(413));
  const batch = c.payload(); batch.entry[0].messaging.push(structuredClone(batch.entry[0].messaging[0]));
  await assert.rejects(c.webhook(batch), status(413));
  await assert.rejects(c.gateway.receiveWebhook(c.tenant.id, c.channelId, {}, 'sha256=' + '0'.repeat(64)), status(413));
  assert.equal(c.conversation(), undefined);
});

test('fechamento reabre em fila com roster e grant de suporte anteriores removidos', async t => {
  const c = setup(t); await c.configure(); await c.webhook(); c.claim();
  c.store.mutate(actor, c.tenant.id, 'Fixture encerrada', tenant => { const conv = tenant.conversations.find(conv => conv.id === c.conversation().id); conv.status = 'closed'; conv.assignedSupportGrantId = 'old-support'; conv.participants = [{ userId: 'old-participant' }]; });
  await c.webhook(c.payload({ message: { mid: 'reopened-mid', text: 'Nova entrada' } }));
  assert.equal(c.conversation().owner, 'queue');
  assert.equal(c.conversation().assignedUserId, null);
  assert.equal(c.conversation().assignedSupportGrantId, undefined);
  assert.equal(c.incoming.at(-1)[3].reopened, true);
});

test('configure exige administração e CAS; recurso/API inválidos e segredos ausentes não persistem', async t => {
  const c = setup(t);
  for (const extras of [{ apiVersion: 'latest' }, { apiVersion: undefined }, { resourceId: 'page/path' }, { accessToken: '' }, { appSecret: '' }, { verifyToken: '' }, { enabled: 'true' }, { grant: 'forged' }]) await assert.rejects(c.configure(extras), status(400));
  await c.configure();
  await assert.rejects(c.configure(), status(409));
  await assert.rejects(c.gateway.configure({ ...actor, role: 'operator' }, c.tenant.id, c.channelId, { version: 1, enabled: false }), status(403));
  await c.gateway.configure(actor, c.tenant.id, c.channelId, { version: 1, enabled: false });
  await assert.rejects(c.webhook(), status(409));
  assert.equal(c.secrets().get(c.channelId).meta.appSecret, appSecret);
});

test('configuração e credencial revogadas enquanto loader cifrado aguarda são revalidadas', async t => {
  const c = setup(t); await c.configure(); await c.webhook(); c.claim();
  let release;
  const pause = new Promise(resolve => { release = resolve; });
  c.gateway.secretLoader = async () => { await pause; return c.secrets(); };
  const pendingSend = c.send({}, { reauthorize: () => { if (c.channel().meta.enabled === false) throw Object.assign(new Error('Synthetic revoke'), { status: 403 }); } });
  c.store.mutate(actor, c.tenant.id, 'Fixture desativada', tenant => { const channel = tenant.channels.find(channel => channel.id === c.channelId); channel.meta.enabled = false; channel.meta.version++; });
  release(); await assert.rejects(pendingSend, status(403));
  assert.equal(c.calls.length, 0);
  assert.equal(c.conversation().messages.filter(message => message.kind === 'human').length, 0);
});

test('sessão e atribuição modificadas durante await impedem envio antes da rede', async t => {
  for (const mode of ['actor', 'assignment', 'reply']) {
    const c = setup(t); await c.configure(); await c.webhook(); c.claim();
    let calls = 0;
    c.gateway.secretLoader = async () => { if (mode === 'assignment') c.store.mutate(actor, c.tenant.id, 'Fixture atribuição', tenant => { const conv = tenant.conversations.find(conv => conv.id === c.conversation().id); conv.owner = 'queue'; }); return c.secrets(); };
    const currentActor = { ...actor };
    await assert.rejects(c.gateway.send(currentActor, c.tenant.id, c.conversation().id, { channelId: c.channelId, version: c.conversation().version, text: 'Resposta' }, {
      reauthorize: () => { if (++calls === 2) { if (mode === 'actor') currentActor.userId = 'other-user'; if (mode === 'reply') c.revoke(); } },
    }), error => [403, 409].includes(error.status));
    assert.equal(c.calls.length, 0);
  }
});

test('texto, canal, versão, anexos e referências forjadas são recusados', async t => {
  const c = setup(t); await c.configure(); await c.webhook(); c.claim();
  for (const extras of [{ text: 'a'.repeat(1001) }, { channelId: 'other-channel' }, { version: 1 }, { attachmentIds: ['synthetic-media'] }, { replyToMessageId: c.conversation().messages[0].id }]) await assert.rejects(c.send(extras), error => [400, 409].includes(error.status));
  assert.equal(c.calls.length, 0);
});

test('4xx é falha definitiva; rede/5xx/confirmação malformada ficam incertas sem retry', async t => {
  for (const [mode, sendResponse, expectedStatus, delivery] of [
    ['4xx', async () => ({ ok: false, status: 403, json: async () => ({ error: { message: accessToken } }) }), 503, 'failed'],
    ['5xx', async () => ({ ok: false, status: 500 }), 502, 'unconfirmed'],
    ['network', async () => { throw new Error(`Synthetic transport ${accessToken}`); }, 502, 'unconfirmed'],
    ['invalid-confirmation', async () => ({ ok: true, status: 200, json: async () => ({ message_id: 'mid', recipient_id: 'wrong' }) }), 502, 'unconfirmed'],
  ]) {
    const c = setup(t, 'messenger', { sendResponse }); await c.configure(); await c.webhook(); c.claim();
    await assert.rejects(c.send(), error => error.status === expectedStatus && !error.message.includes(accessToken), mode);
    assert.equal(c.conversation().messages.at(-1).delivery, delivery);
    assert.equal(c.calls.length, 1);
  }
});

test('Outbox mantém replay e separa falha definitiva de envio desconhecido', async t => {
  for (const definitive of [true, false]) {
    const c = setup(t, 'messenger', { sendResponse: async () => ({ ok: false, status: definitive ? 400 : 500 }) }); await c.configure(); await c.webhook(); c.claim();
    const outbox = new Outbox(c.store, { authorize: c.gateway.operations.canReply }), conv = c.conversation();
    const input = { channelId: c.channelId, version: conv.version, text: 'Resposta', idempotencyKey: 'meta-fixture-idempotency-key' };
    await assert.rejects(outbox.dispatch(actor, c.tenant.id, conv.id, input, () => c.gateway.send(actor, c.tenant.id, conv.id, input)), status(definitive ? 503 : 502));
    assert.equal(c.store.db.prepare('SELECT state FROM outbound_commands').get().state, definitive ? 'failed' : 'unknown');
    await assert.rejects(outbox.dispatch(actor, c.tenant.id, conv.id, input, () => c.gateway.send(actor, c.tenant.id, conv.id, input)), status(409));
    assert.equal(c.calls.length, 1);
  }
});

test('close bloqueia webhook e envio pendentes e aborta transporte em voo', async t => {
  let aborted = false;
  const c = setup(t, 'messenger', { sendResponse: async (url, input) => new Promise((resolve, reject) => input.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Synthetic abort')); }, { once: true })) });
  await c.configure(); await c.webhook(); c.claim();
  const pending = c.send();
  await new Promise(resolve => setImmediate(resolve));
  await c.gateway.close();
  await assert.rejects(pending, status(502));
  assert.equal(aborted, true);
  assert.equal(c.conversation().messages.at(-1).delivery, 'unconfirmed');
  await assert.rejects(c.webhook(), status(503));
  await assert.rejects(c.send(), status(503));
});

test('dedupe persiste após reiniciar instância e receipt acompanha rollback de projeção', async t => {
  const c = setup(t); await c.configure(); const payload = c.payload(); await c.webhook(payload);
  const contactsBefore = JSON.stringify(c.store.tenant(actor, c.tenant.id).contacts);
  await c.gateway.close();
  const next = new MetaGateway(c.store, { authKey: c.gateway.authKey, operations: c.gateway.operations, now: () => Date.parse('2026-10-03T12:00:00.000Z'), fetchImpl: async () => { throw new Error('No network'); } });
  t.after(() => next.close());
  const raw = Buffer.from(JSON.stringify(payload)), signature = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
  assert.equal((await next.receiveWebhook(c.tenant.id, c.channelId, raw, signature)).replayed, 1);
  const another = c.payload({ sender: { id: '777777770001' }, message: { mid: 'projection-failed-mid', text: 'Nova mensagem' } }), newRaw = Buffer.from(JSON.stringify(another));
  const previousQueue = c.store.queuePostgres;
  c.store.queuePostgres = () => { throw new Error('Synthetic projection failure'); };
  await assert.rejects(next.receiveWebhook(c.tenant.id, c.channelId, newRaw, 'sha256=' + createHmac('sha256', appSecret).update(newRaw).digest('hex')));
  c.store.queuePostgres = previousQueue;
  assert.equal(c.conversation().messages.length, 1);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 1);
  assert.equal(c.store.tenant(actor, c.tenant.id).conversations.length, 1); assert.equal(JSON.stringify(c.store.tenant(actor, c.tenant.id).contacts), contactsBefore);
});

test('revogação durante chamada Meta conserva entrega aceita sem devolver conversa ao ator', async t => {
  const c = setup(t, 'messenger', { sendResponse: async () => { c.revoke(); return { ok: true, status: 200, json: async () => ({ recipient_id: senderId, message_id: 'accepted-before-revoke' }) }; } });
  await c.configure(); await c.webhook(); c.claim();
  await assert.rejects(c.send(), error => error.status === 502 && error.message.includes('Meta aceitou'));
  assert.equal(c.conversation().messages.at(-1).delivery, 'sent');
  assert.equal(c.conversation().messages.at(-1).providerMessageId, 'accepted-before-revoke');
  assert.equal(c.calls.length, 1);
});

test('corpo de confirmação acima do limite mantém envio incerto', async t => {
  const c = setup(t, 'messenger', { sendResponse: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '100000' }), json: async () => { throw new Error('Should not read oversized confirmation'); } }) });
  await c.configure(); await c.webhook(); c.claim();
  await assert.rejects(c.send(), status(502));
  assert.equal(c.conversation().messages.at(-1).delivery, 'unconfirmed');
  assert.equal(c.calls.length, 1);
});
