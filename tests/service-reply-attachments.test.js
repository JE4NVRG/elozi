// Files sent by a connected agent with reply.send (REST), hand-over between connected agents and the 300/h private
// ceiling. createApp with the webchat transport as the synthetic channel; no external network, provider or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server.js';
import { outboundServiceAttachment } from '../src/service-attachment-media.js';
import { privateServiceReplyLimits } from '../src/service-reply-limits.js';

const origin = 'https://loja.example.test';
const status = expected => error => error.status === expected;
const ATTENDANT = ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'];
const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC-SHIPPING-LABEL\n%%EOF');
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('SYNTHETIC-LISTING-PREVIEW')]);
const file = (bytes, mime, name = 'etiqueta.pdf') => ({ mime, name, data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') });

async function fixture(t) {
  const key = Buffer.alloc(32, 47), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio de anexos do agente'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { store, auth, webchat, servicePrincipals: principals, serviceApi: api } = app;
  const admin = auth.session(auth.insertUser({ username: 'files.owner', name: 'Administração sintética' }, Buffer.alloc(16, 7), Buffer.alloc(64, 7), 'reseller', [], 'mep-demo')).actor;
  const tenant = store.createTenant(admin, { name: 'Loja dos anexos', segment: 'Varejo' });
  store.mutate(admin, tenant.id, 'Fixture de anexos do agente', state => {
    state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }];
    state.departments = [];
    state.agents = [{ id: 'sellers', name: 'Agente dos sellers', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'admin', name: 'Agente admin', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'hermes-1', name: 'Hermes', provider: 'hermes', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'pending', name: 'Agente não configurado', provider: 'mcp', mode: 'copilot', configured: false, version: 1, tools: [] }];
  });
  webchat.configure(admin, tenant.id, 'site', { version: 0, origins: [origin] });
  const principal = agentId => { const created = principals.create(admin, tenant.id, { name: `Serviço ${agentId}`, agentId, capabilities: ATTENDANT, channelIds: ['site'], departmentIds: null, dailyRequests: 200, maxConcurrent: 3, ttlHours: 24 }); return { ...created, actor: principals.authenticate('Bearer ' + created.token) }; };
  let messages = 0;
  const conversation = id => store.getConversation(store.tenant(admin, tenant.id), id);
  const owned = async owner => {
    const challenge = webchat.challenge({ tenantId: tenant.id, channelId: 'site', origin });
    const session = webchat.openSession({ tenantId: tenant.id, channelId: 'site', origin, challenge: challenge.challenge, name: 'Visitante' });
    await webchat.receive({ token: session.token, text: 'Preciso da etiqueta do pedido', clientMessageId: `reply-files-message-${String(++messages).padStart(4, '0')}`, origin });
    const id = store.tenant(admin, tenant.id).conversations.find(item => item.remoteSessionId)?.id;
    api.claimConversation(owner.actor, { requestId: `claim_${id}`.slice(0, 120), conversationId: id, version: conversation(id).version });
    return { id, session };
  };
  const rest = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    .then(async response => ({ status: response.status, data: await response.json().catch(() => null) }));
  const commands = () => store.db.prepare('SELECT idempotency_key AS key,state,payload FROM outbound_commands WHERE tenant_id=?').all(tenant.id).map(row => ({ key: row.key, state: row.state, attachmentIds: JSON.parse(row.payload).attachmentIds || [] }));
  const uploads = () => store.db.prepare("SELECT id FROM media_attachments WHERE tenant_id=? AND purpose='upload'").all(tenant.id).map(row => row.id);
  t.after(async () => {
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); store.close();
  });
  return { app, store, api, admin, tenant, principal, conversation, owned, rest, commands, uploads, webchat };
}

test('anexo de saída: campos exatos, base64, sha256, formato e limite são conferidos antes de qualquer envio', () => {
  const ok = outboundServiceAttachment(file(pdf, 'application/pdf'));
  assert.equal(ok.mime, 'application/pdf'); assert.equal(ok.size, pdf.length); assert.deepEqual(ok.bytes, pdf);
  assert.equal(outboundServiceAttachment(file(png, 'image/png', '../../previa.png')).name, 'previa.png');
  for (const [value, code] of [[{ ...file(pdf, 'application/pdf'), extra: 1 }, 400], [{ ...file(pdf, 'application/pdf'), mime: 'audio/ogg' }, 415],
    [{ ...file(pdf, 'application/pdf'), mime: 'text/html' }, 415], [{ ...file(pdf, 'application/pdf'), sha256: 'a'.repeat(64) }, 400],
    [{ ...file(pdf, 'application/pdf'), data: 'não é base64' }, 400], [{ ...file(pdf, 'application/pdf'), name: '' }, 400],
    [file(Buffer.from('NOT-A-PDF-CONTENT'), 'application/pdf'), 415], [file(pdf, 'image/png'), 415],
    // Oversized content is refused by its encoded length, before decoding.
    [file(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)]), 'application/pdf'), 400]]) assert.throws(() => outboundServiceAttachment(value), status(code));
});

test('resposta com PDF pelo REST: upload privado, outbox único, legenda opcional, replay sem reenvio e recibo sem bytes', async t => {
  const f = await fixture(t), p = f.principal('sellers'), { id } = await f.owned(p);
  const body = { requestId: 'reply_label_0001', conversationId: id, version: f.conversation(id).version, attachment: file(pdf, 'application/pdf') };
  const sent = await f.rest('/api/service/v1/replies', body, p.token);
  assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(sent.data.result.state, 'confirmed');
  const message = f.conversation(id).messages.find(item => item.id === sent.data.result.messageId);
  assert.equal(message.kind, 'agent'); assert.equal(message.authorServiceId, p.principal.id); assert.equal(message.text, '');
  assert.equal(message.attachments.length, 1); assert.equal(message.attachments[0].mime, 'application/pdf'); assert.equal(message.attachments[0].name, 'etiqueta.pdf');
  const read = await f.app.media.read(message.attachments[0].id, { tenantId: f.tenant.id, conversationId: id, channelId: 'site' });
  assert.deepEqual(Buffer.from(read.bytes), pdf, 'the visitor receives exactly the uploaded file');
  assert.deepEqual(f.commands().map(item => ({ state: item.state, files: item.attachmentIds.length })), [{ state: 'confirmed', files: 1 }]);
  const replay = await f.rest('/api/service/v1/replies', body, p.token);
  assert.equal(replay.data.receipt.id, sent.data.receipt.id); assert.equal(f.commands().length, 1); assert.equal(f.uploads().length, 1, 'replay never uploads again');
  const conflict = await f.rest('/api/service/v1/replies', { ...body, attachment: file(png, 'image/png', 'previa.png') }, p.token);
  assert.equal(conflict.status, 409, 'same requestId with another file');
  const receipts = JSON.stringify(f.store.db.prepare('SELECT result,payload_hash FROM service_principal_receipts').all());
  assert.equal(receipts.includes(pdf.toString('base64')), false); assert.equal(receipts.includes('SYNTHETIC-SHIPPING-LABEL'), false);
  const captioned = await f.rest('/api/service/v1/replies', { requestId: 'reply_preview_01', conversationId: id, version: f.conversation(id).version, text: 'Prévia do anúncio', attachment: file(png, 'image/png', 'previa.png') }, p.token);
  assert.equal(captioned.status, 200, JSON.stringify(captioned.data));
  const preview = f.conversation(id).messages.find(item => item.id === captioned.data.result.messageId);
  assert.equal(preview.text, 'Prévia do anúncio'); assert.equal(preview.attachments[0].kind, 'image');
});

test('anexo recusado pelo canal ou pelas guardas não deixa upload nem comando; a mesma conversa segue com texto', async t => {
  const f = await fixture(t), p = f.principal('sellers'), { id } = await f.owned(p);
  f.store.mutate(f.admin, f.tenant.id, 'Arquivos desligados no widget', state => { state.channels[0].webchat.widget = { ...(state.channels[0].webchat.widget || {}), attachmentsEnabled: false }; });
  await assert.rejects(f.api.sendReply(p.actor, { requestId: 'reply_nofiles_01', conversationId: id, version: f.conversation(id).version, attachment: file(pdf, 'application/pdf') }), error => [400, 403].includes(error.status));
  assert.deepEqual(f.uploads(), [], 'refused file is discarded'); assert.equal(f.commands().length, 0);
  const receipt = f.store.db.prepare("SELECT state FROM service_principal_receipts WHERE request_id='reply_nofiles_01'").get();
  assert.equal(receipt.state, 'failed', 'nothing was dispatched');
  await assert.rejects(f.api.sendReply(p.actor, { requestId: 'reply_badfile_01', conversationId: id, version: f.conversation(id).version, attachment: file(Buffer.from('NOT-A-PDF'), 'application/pdf') }), status(415));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM service_principal_receipts WHERE request_id='reply_badfile_01'").get().n, 0, 'invalid file is refused before reserving');
  const text = await f.api.sendReply(p.actor, { requestId: 'reply_text_00001', conversationId: id, version: f.conversation(id).version, text: 'Segue o link da etiqueta no FullCommerce.' });
  assert.equal(text.result.state, 'confirmed');
  await assert.rejects(f.api.sendReply(p.actor, { requestId: 'reply_empty_0001', conversationId: id, version: f.conversation(id).version, text: '   ' }), status(400));
});

test('repasse direto entre agentes conectados da mesma empresa, sem fila humana; o novo dono responde', async t => {
  const f = await fixture(t), sellers = f.principal('sellers'), admin = f.principal('admin'), { id } = await f.owned(sellers);
  const input = { requestId: 'handover_admin_01', conversationId: id, version: f.conversation(id).version, agentId: 'admin', reason: 'Código de vínculo do administrador.' };
  const moved = await f.rest('/api/service/v1/agent-handovers', input, sellers.token);
  assert.equal(moved.status, 200, JSON.stringify(moved.data)); assert.deepEqual([moved.data.result.owner, moved.data.result.agentId], ['agent', 'admin']);
  assert.equal(f.conversation(id).owner, 'agent'); assert.equal(f.conversation(id).agentId, 'admin'); assert.equal(f.conversation(id).assignedUserId, null);
  assert.match(f.conversation(id).messages.at(-1).text, /Motivo: Código de vínculo do administrador\./);
  assert.equal((await f.rest('/api/service/v1/agent-handovers', input, sellers.token)).data.receipt.id, moved.data.receipt.id, 'replay');
  await assert.rejects(f.api.sendReply(sellers.actor, { requestId: 'reply_after_move', conversationId: id, version: f.conversation(id).version, text: 'Não posso mais responder.' }), status(403));
  const answered = await f.api.sendReply(admin.actor, { requestId: 'reply_admin_0001', conversationId: id, version: f.conversation(id).version, text: 'Olá, Jean.' });
  assert.equal(answered.result.state, 'confirmed');
  // The new owner cannot hand over to itself, to Hermes, to an unconfigured adapter or to an unknown agent.
  for (const agentId of ['admin', 'hermes-1', 'pending', 'nao-existe'])
    assert.throws(() => f.api.handOverConversation(admin.actor, { requestId: `handover_${agentId}`.replace(/\W/g, '_'), conversationId: id, version: f.conversation(id).version, agentId }), status(409), agentId);
  assert.throws(() => f.api.handOverConversation(sellers.actor, { requestId: 'handover_notown1', conversationId: id, version: f.conversation(id).version, agentId: 'sellers' }), status(409), 'not own');
  assert.throws(() => f.api.handOverConversation(admin.actor, { requestId: 'handover_extra01', conversationId: id, version: f.conversation(id).version, agentId: 'sellers', tenantId: 'x' }), status(400));
});

test('teto privado de respostas aceita até 300/h por tupla e recusa acima disso', async t => {
  const f = await fixture(t), p = f.principal('sellers');
  const valid = { tenantId: f.tenant.id, principalId: p.principal.id, channelId: 'site', replyLimitPerHour: 300 };
  assert.equal(privateServiceReplyLimits(f.store, [valid])[0].replyLimitPerHour, 300);
  assert.throws(() => privateServiceReplyLimits(f.store, [{ ...valid, replyLimitPerHour: 301 }]), TypeError);
});
