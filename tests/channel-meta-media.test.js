import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { MediaService, MAX_MEDIA_BYTES } from '../src/media.js';
import { MetaGateway } from '../src/channel-meta.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { Outbox } from '../src/outbox.js';
import { MESSENGER_UPLOAD_MIMES } from '../src/meta-media.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', userId: 'synthetic-meta-owner', name: 'Synthetic operator' };
const appSecret = 'synthetic-meta-app-secret', resourceId = '123456789001', senderId = '987654321001';
const signedURL = 'https://scontent.xx.fbcdn.net/v/photo.png?oh=synthetic-private-cdn-signature';
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('Synthetic private Meta image')]);
const initialTime = Date.parse('2026-10-03T12:00:00.000Z');
const status = code => error => error.status === code;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function setup(t, kind = 'messenger', options = {}) {
  const store = new Store(':memory:'), authKey = randomBytes(32), tenant = store.createTenant(actor, { name: 'Meta media fixture', segment: 'RAM only' }), channelId = randomUUID();
  store.mutate(actor, tenant.id, 'Synthetic channel', state => state.channels.push({ id: channelId, kind, state: 'planned' }));
  const media = new MediaService(store, { directory: null, authKey, ...options.mediaOptions });
  let now = initialTime, authorized = true;
  const downloads = [], incoming = [], graph = [];
  const operations = {
    admin(input) { if (!authorized || input.supportGrantId) throw Object.assign(new Error('Synthetic denial'), { status: 403 }); },
    canReply(input, id, conversation) { if (!authorized || !input.userId || input.userId !== conversation.assignedUserId) throw Object.assign(new Error('Synthetic reply denial'), { status: 403 }); },
  };
  const gateway = new MetaGateway(store, { authKey, media, operations, now: () => now, onIncoming: (...args) => incoming.push(args),
    mediaDownloader: async input => { downloads.push(input); return options.download ? options.download(input) : { bytes: png, metadata: { kind: 'image', mime: 'image/png', name: 'Synthetic.png' } }; },
    fetchImpl: async (...args) => { graph.push(args); if (options.sendResponse) return options.sendResponse(...args); throw new Error('External Graph calls are forbidden in this fixture'); }, ...options.gatewayOptions });
  const gateways = [gateway];
  t.after(async () => { for (const item of gateways) await item.close(); await Promise.allSettled(gateways.flatMap(item => [...item.mediaTasks])); store.close(); });
  const configure = (extras = {}) => gateway.configure(actor, tenant.id, channelId, { version: channel().meta?.version || 0,
    resourceId, apiVersion: 'v23.0', enabled: true, accessToken: 'synthetic-meta-access-token', appSecret, verifyToken: 'synthetic-meta-verify-token', ...extras });
  const channel = () => store.tenant(actor, tenant.id).channels.find(item => item.id === channelId);
  const conversation = () => store.tenant(actor, tenant.id).conversations.find(item => item.channelId === channelId);
  const payload = (message = {}, event = {}) => ({ object: kind === 'messenger' ? 'page' : 'instagram', entry: [{ id: resourceId, messaging: [
    { sender: { id: senderId }, recipient: { id: resourceId }, timestamp: now,
      message: { mid: 'synthetic-media-mid', attachments: [{ type: 'image', payload: { url: signedURL } }], ...message }, ...event },
  ] }] });
  const webhook = async (body = payload(), key = appSecret, instance = gateway) => {
    const raw = Buffer.from(JSON.stringify(body)); return instance.receiveWebhook(tenant.id, channelId, raw, 'sha256=' + createHmac('sha256', key).update(raw).digest('hex'));
  };
  const settle = () => Promise.allSettled([...gateway.mediaTasks]);
  const file = () => conversation().messages[0].attachments[0];
  const context = () => ({ tenantId: tenant.id, channelId, conversationId: conversation().id });
  const claim = () => store.mutate(actor, tenant.id, 'Synthetic claim', state => { const item = state.conversations.find(item => item.id === conversation().id); item.owner = 'human'; item.assignedUserId = actor.userId; item.version++; });
  const edit = fn => store.mutate(actor, tenant.id, 'Synthetic change', fn);
  return { store, authKey, tenant, channelId, media, gateway, gateways, graph, downloads, incoming, configure, channel, conversation, payload, webhook, settle, file, context, claim, edit,
    revoke: () => { authorized = false; }, clock: value => { now = value; }, secrets: () => encryptedChannelSecrets(store.db, authKey) };
}

for (const kind of ['instagram', 'messenger']) {
  test(`${kind}: assinatura validada produz imagem privada cifrada sem expor URL ou assinatura CDN`, async t => {
    const c = setup(t, kind); await c.configure();
    const result = await c.webhook(); assert.equal(result.received, 1); await c.settle();
    const contact = c.store.tenant(actor, c.tenant.id).contacts.find(item => item.id === c.conversation().contactId);
    assert.ok(contact); assert.equal(contact.phone, ''); assert.equal(c.conversation().contactSyncStatus, 'linked');
    assert.deepEqual(contact.identities, [{ channelId: c.channelId, kind: 'person', externalId: 'conversation:' + c.conversation().id }]);
    const file = c.file(); assert.equal(file.status, 'ready'); assert.equal(file.preview, true); assert.equal(file.kind, 'image'); assert.equal(file.mime, 'image/png');
    assert.deepEqual(file.remoteReference, { kind, resourceId, messageId: 'synthetic-media-mid', index: 0 });
    assert.deepEqual((await c.media.read(file.id, c.context())).bytes, png);
    assert.equal(c.media.blobs.get(file.id).includes(png), false);
    const surfaces = [JSON.stringify(c.store.tenant(actor, c.tenant.id)), JSON.stringify(c.incoming), JSON.stringify(result),
      JSON.stringify(c.gateway.status(actor, c.tenant.id, c.channelId)), JSON.stringify(c.store.db.prepare('SELECT * FROM media_attachments').all()), JSON.stringify(c.store.db.prepare('SELECT * FROM meta_inbound_receipts').all())];
    for (const surface of surfaces) for (const value of [signedURL, 'synthetic-private-cdn-signature', appSecret, 'synthetic-meta-access-token']) assert.equal(surface.includes(value), false);
    assert.equal(c.downloads.length, 1); assert.equal(c.graph.length, 0); assert.equal(c.gateway.pending.size, 0);
  });

  test(`${kind}: HMAC/recurso/destinatário/empresa inválidos impedem download e placeholder`, async t => {
    const c = setup(t, kind); await c.configure();
    await assert.rejects(c.webhook(c.payload(), 'wrong-synthetic-secret'), status(403));
    const otherResource = c.payload(); otherResource.entry[0].id = '99999';
    await assert.rejects(c.webhook(otherResource), status(403));
    await assert.rejects(c.webhook(c.payload({}, { recipient: { id: '99999' } })), status(403));
    const raw = Buffer.from(JSON.stringify(c.payload()));
    await assert.rejects(c.gateway.receiveWebhook('wrong-tenant', c.channelId, raw, 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex')), status(404));
    assert.equal(c.downloads.length, 0); assert.equal(c.media.blobs.size, 0);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 0);
  });
}

test('receipt persistente impede download duplicado durante captura, após captura e em nova instância', async t => {
  const gate = deferred(), started = deferred(), c = setup(t, 'messenger', { download: async () => { started.resolve(); await gate.promise; return { bytes: png, metadata: { kind: 'image', mime: 'image/png' } }; } });
  await c.configure(); const body = c.payload(); await c.webhook(body); await started.promise;
  assert.equal((await c.webhook(body)).replayed, 1); assert.equal(c.downloads.length, 1);
  gate.resolve(); await c.settle(); assert.equal((await c.webhook(body)).replayed, 1);
  await c.gateway.close();
  const next = new MetaGateway(c.store, { authKey: c.authKey, media: c.media, operations: c.gateway.operations, now: () => initialTime,
    mediaDownloader: async () => { throw new Error('Replay must not request CDN'); }, fetchImpl: async () => { throw new Error('No Graph'); } }); c.gateways.push(next);
  assert.equal((await c.webhook(body, appSecret, next)).replayed, 1); assert.equal(next.mediaTasks.size, 0);
  assert.equal(c.downloads.length, 1); assert.equal(c.conversation().messages.length, 1); assert.equal(c.media.blobs.size, 1);
  const changed = structuredClone(body); changed.entry[0].messaging[0].message.attachments[0].payload.url += '&oh=changed';
  await assert.rejects(c.webhook(changed, appSecret, next), status(409)); assert.equal(c.downloads.length, 1);
});

test('batch inválido/projeção falha revertem recibo, placeholder e conversa antes de qualquer download', async t => {
  for (const mode of ['changed-mid', 'invalid-recipient', 'projection']) {
    const c = setup(t); await c.configure(); const body = c.payload();
    if (mode === 'projection') c.store.queuePostgres = () => { throw new Error('Synthetic projection failure'); };
    else { const event = structuredClone(body.entry[0].messaging[0]); if (mode === 'changed-mid') event.message.text = 'Changed body'; else event.recipient.id = '99999'; body.entry[0].messaging.push(event); }
    await assert.rejects(c.webhook(body));
    assert.equal(c.downloads.length, 0); assert.equal(c.conversation(), undefined);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM meta_inbound_receipts').get().n, 0);
    c.store.queuePostgres = () => {};
  }
});

test('referência indisponível preserva origem para tipo não suportado, URL arbitrária e segredo em query', async t => {
  const c = setup(t, 'instagram'); await c.configure();
  for (const [index, attachment] of [
    { type: 'file', payload: { url: signedURL } }, { type: 'image', payload: { url: 'http://127.0.0.1/private' } },
    { type: 'image', payload: { url: signedURL + '&access_token=synthetic-secret' } }, { type: 'image', payload: { url: 'https://evil.example/a.png' } },
  ].entries()) {
    await c.webhook(c.payload({ mid: `unsupported-${index}`, attachments: [attachment] }));
    const file = c.conversation().messages.at(-1).attachments[0]; assert.equal(file.status, 'unavailable'); assert.equal(file.reason, 'external_reference'); assert.equal(file.remoteReference.messageId, `unsupported-${index}`);
  }
  assert.equal(c.downloads.length, 0); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0);
  assert.equal(JSON.stringify(c.conversation()).includes('url'), false);
});

test('capacidades recebidas correspondem aos kinds realmente capturados e documento Messenger fica privado', async t => {
  for (const kind of ['instagram', 'messenger']) {
    const c = setup(t, kind, { download: async ({ kind: mediaKind }) => ({
      bytes: mediaKind === 'audio' ? Buffer.from('ID3synthetic audio') : mediaKind === 'video' ? Buffer.from('\x00\x00\x00\x18ftypmp42synthetic video', 'latin1') : Buffer.from('%PDF-1.7 synthetic file'),
      metadata: { kind: mediaKind, mime: mediaKind === 'audio' ? 'audio/mpeg' : mediaKind === 'video' ? 'video/mp4' : 'application/pdf' },
    }) }); await c.configure();
    const types = kind === 'messenger' ? ['audio', 'video', 'file'] : ['audio', 'video'];
    for (const type of types) { await c.webhook(c.payload({ mid: `typed-${type}`, attachments: [{ type, payload: { url: signedURL } }] })); await c.settle(); }
    assert.equal(c.downloads.length, types.length);
    for (const message of c.conversation().messages) { const file = message.attachments[0]; assert.equal(file.status, 'ready'); assert.equal(file.preview, file.kind !== 'document'); }
    const kinds = c.gateway.status(actor, c.tenant.id, c.channelId).inboundMediaKinds;
    assert.deepEqual(kinds, ['image', 'audio', 'video', ...(kind === 'messenger' ? ['document'] : [])]);
  }
});

test('quotas e tamanho declarado recusam captura preservando receipt sem bytes nem novo download no replay', async t => {
  for (const [mediaOptions, size, reason] of [[{ maxTenantBytes: 1 }, undefined, 'quota'], [{}, MAX_MEDIA_BYTES + 1, 'too_large']]) {
    const c = setup(t, 'messenger', { mediaOptions }); await c.configure(); const body = c.payload({ attachments: [{ type: 'image', payload: { url: signedURL, ...(size ? { size } : {}) } }] });
    await c.webhook(body); await c.settle(); assert.equal(c.file().status, 'unavailable'); assert.equal(c.file().reason, reason);
    assert.equal(c.downloads.length, 0); assert.equal(c.media.blobs.size, 0); assert.equal((await c.webhook(body)).replayed, 1);
  }
});

test('limite real de bytes e resposta MIME inválida tornam placeholder indisponível sem conteúdo parcial', async t => {
  for (const download of [
    async () => ({ bytes: Buffer.alloc(MAX_MEDIA_BYTES + 1), metadata: { kind: 'image', mime: 'image/png' } }),
    async () => ({ bytes: Buffer.from('Not PNG'), metadata: { kind: 'image', mime: 'image/png' } }),
    async () => { throw Object.assign(new Error(`Synthetic CDN 401 ${signedURL}`), { status: 401 }); },
  ]) {
    const c = setup(t, 'messenger', { download }); await c.configure(); const body = c.payload(); await c.webhook(body); await c.settle();
    assert.equal(c.file().status, 'unavailable'); assert.equal(c.file().preview, false); assert.equal(c.media.blobs.size, 0);
    assert.equal(JSON.stringify(c.conversation()).includes('synthetic-private-cdn-signature'), false);
    await c.webhook(body); assert.equal(c.downloads.length, 1);
  }
});

test('revogação/configuração/recurso/segredo durante download impedem publicação ready e conservam referência', async t => {
  for (const mode of ['disable', 'revision', 'resource', 'app-secret']) {
    const gate = deferred(), started = deferred(), c = setup(t, 'messenger', { download: async () => { started.resolve(); await gate.promise; return { bytes: png, metadata: { kind: 'image', mime: 'image/png' } }; } });
    await c.configure(); await c.webhook(); await started.promise;
    if (mode === 'app-secret') { const storage = c.secrets(), all = storage.get(c.channelId); storage.set(c.channelId, { ...all, meta: { ...all.meta, appSecret: 'synthetic-revoked-app-secret' } }); }
    else c.edit(state => { const channel = state.channels.find(item => item.id === c.channelId); if (mode === 'disable') channel.meta.enabled = false; else if (mode === 'revision') channel.meta.version++; else channel.meta.resourceId = '99999999'; });
    gate.resolve(); await c.settle(); assert.equal(c.media.blobs.size, 0, mode); assert.equal(c.file().status, 'unavailable', mode); assert.equal(c.file().preview, false);
    assert.equal(c.file().remoteReference.resourceId, resourceId);
    await assert.rejects(c.media.read(c.file().id, c.context()), status(404));
  }
});

test('revogação durante carregamento da chave cifrada é revalidada pelo MediaService integrado', async t => {
  const key = deferred(), started = deferred(), c = setup(t, 'instagram', { mediaOptions: { authKey: undefined, keyLoader: () => { started.resolve(); return key.promise; } } });
  await c.configure(); await c.webhook(); await started.promise;
  c.edit(state => { state.channels.find(item => item.id === c.channelId).meta.enabled = false; });
  key.resolve(randomBytes(32)); await c.settle(); assert.equal(c.media.blobs.size, 0); assert.equal(c.file().status, 'unavailable');
});

test('escopo cifrado impede leitura por outra empresa/canal/conversa e recebido não vira upload', async t => {
  const c = setup(t); await c.configure(); await c.webhook(); await c.settle(); const id = c.file().id;
  const other = c.store.createTenant(actor, { name: 'Other RAM company', segment: 'Synthetic' });
  for (const context of [{ ...c.context(), tenantId: other.id }, { ...c.context(), channelId: randomUUID() }, { ...c.context(), conversationId: randomUUID() }]) await assert.rejects(c.media.read(id, context), status(404));
  await assert.rejects(c.media.read(id, c.context(), { uploadOnly: true }), status(404));
  assert.equal(c.media.blobs.size, 1);
});

test('fila de captura limitada devolve busy e não redownload no replay', async t => {
  const gate = deferred(), started = deferred(), c = setup(t, 'messenger', { mediaOptions: { maxConcurrentCaptures: 1, maxQueuedCaptures: 0 }, download: async () => { started.resolve(); await gate.promise; return { bytes: png, metadata: { kind: 'image', mime: 'image/png' } }; } });
  await c.configure(); await c.webhook(); await started.promise;
  const other = c.payload({ mid: 'busy-mid' }); await c.webhook(other); await new Promise(resolve => setImmediate(resolve));
  const busy = c.conversation().messages.at(-1).attachments[0]; assert.equal(busy.status, 'unavailable'); assert.equal(busy.reason, 'busy');
  assert.equal((await c.webhook(other)).replayed, 1); assert.equal(c.downloads.length, 1);
  gate.resolve(); await c.settle(); assert.equal(c.file().status, 'ready');
});

test('fechar cancela captura ativa, revoga publicação e bloqueia entrada subsequente', async t => {
  const started = deferred(); let aborted = false;
  const c = setup(t, 'messenger', { download: ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('Synthetic transport cancelled')); }, { once: true }); started.resolve(); }) });
  await c.configure(); await c.webhook(); await started.promise; await c.gateway.close(); await c.settle();
  assert.equal(aborted, true); assert.equal(c.media.blobs.size, 0); assert.equal(c.file().status, 'unavailable'); assert.equal(c.gateway.mediaTasks.size, 0);
  await assert.rejects(c.webhook(), status(503));
});

for (const kind of ['instagram']) {
  test(`${kind}: saída privada sem contrato comprovado falha antes de chave/rede e não converte mídia em URL pública`, async t => {
    const c = setup(t, kind); await c.configure(); await c.webhook(); await c.settle(); c.claim();
    const upload = await c.media.upload(c.context(), { bytes: png, kind: 'image', mime: 'image/png' });
    c.gateway.secretLoader = async () => { throw new Error('Attachment rejection must occur before loading credentials'); };
    for (const [id, text] of [[upload.id, ''], [c.file().id, ''], [randomUUID(), ''], [upload.id, 'Caption']]) await assert.rejects(c.gateway.send(actor, c.tenant.id, c.conversation().id,
      { version: c.conversation().version, channelId: c.channelId, text, attachmentIds: [id] }), status(400));
    const capabilities = c.gateway.status(actor, c.tenant.id, c.channelId);
    assert.equal(capabilities.mediaSupported, false); assert.deepEqual(capabilities.mediaKinds, []); assert.equal(capabilities.mediaCaptionSupported, false);
    assert.equal(capabilities.inboundMediaSupported, true); assert.equal(capabilities.mediaMaxBytes, MAX_MEDIA_BYTES);
    assert.equal(c.graph.length, 0); assert.equal(c.conversation().messages.filter(item => item.kind === 'human').length, 0);
  });
}

const graphJSON = body => ({ ok: true, status: 200, json: async () => body });
const nativeReply = async url => graphJSON(url.endsWith('/message_attachments') ? { attachment_id: '112233445566' } : { recipient_id: senderId, message_id: 'private-outbound-mid' });
async function outbound(t, options = {}) {
  const c = setup(t, 'messenger', { sendResponse: nativeReply, ...options });
  await c.configure(); await c.webhook(c.payload({ attachments: [], text: 'Open reply window' })); c.claim();
  const upload = await c.media.upload(c.context(), { bytes: png, kind: 'image', mime: 'image/png', name: 'Private original.png' });
  const input = { version: c.conversation().version, channelId: c.channelId, text: '', attachmentIds: [upload.id], idempotencyKey: `private_${randomUUID().replaceAll('-', '')}` };
  const send = (settings) => c.gateway.send(actor, c.tenant.id, c.conversation().id, input, settings);
  const outbox = new Outbox(c.store, { authorize: c.gateway.operations.canReply.bind(c.gateway.operations) });
  const dispatch = (settings = {}) => outbox.dispatch(actor, c.tenant.id, c.conversation().id, input, () => send(settings), {
    reauthorize: settings.reauthorize || (() => {}), validate: () => { c.gateway.validateOutgoing('messenger', input); c.gateway.sendContext(actor, c.tenant.id, c.conversation().id, input); },
  });
  return { ...c, upload, input, send, outbox, dispatch };
}

test('Messenger upload privado multipart e Send attachment_id usam versão fixada, sem URL pública ou segredo nos DTOs', async t => {
  const c = await outbound(t), sent = await c.dispatch();
  assert.equal(c.graph.length, 2); const [[uploadURL, request], [sendURL, sendRequest]] = c.graph;
  assert.equal(uploadURL, `https://graph.facebook.com/v23.0/${resourceId}/message_attachments`);
  assert.equal(sendURL, `https://graph.facebook.com/v23.0/${resourceId}/messages`);
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error'); assert.equal(request.headers.Authorization, 'Bearer synthetic-meta-access-token');
  assert.equal(request.headers['Content-Type'], undefined); assert.ok(request.body instanceof FormData);
  assert.deepEqual([...request.body.keys()], ['message', 'filedata']);
  assert.deepEqual(JSON.parse(request.body.get('message')), { attachment: { type: 'image', payload: { is_reusable: true } } });
  const file = request.body.get('filedata'); assert.equal(file.type, 'image/png'); assert.equal(file.name, 'attachment.png'); assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.deepEqual(JSON.parse(sendRequest.body), { recipient: { id: senderId }, message: { attachment: { type: 'image', payload: { attachment_id: '112233445566' } } }, messaging_type: 'RESPONSE' });
  assert.equal(sent.messages.at(-1).delivery, 'sent'); assert.equal(sent.messages.at(-1).text, ''); assert.deepEqual(sent.messages.at(-1).attachments, [c.upload]);
  assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, 'confirmed'); assert.equal(c.outbox.list(actor, c.tenant.id)[0].attempts, 1);
  const surfaces = JSON.stringify([sent, c.gateway.status(actor, c.tenant.id, c.channelId), c.outbox.list(actor, c.tenant.id), c.store.db.prepare('SELECT payload FROM outbound_commands').all()]);
  for (const value of ['synthetic-meta-access-token', '112233445566', signedURL, png.toString('base64'), 'filedata']) assert.equal(surfaces.includes(value), false);
  const cap = c.gateway.status(actor, c.tenant.id, c.channelId); assert.equal(cap.mediaSupported, true); assert.deepEqual(cap.mediaKinds, ['image', 'audio', 'video', 'document']);
  assert.deepEqual(cap.mediaMimes, [...MESSENGER_UPLOAD_MIMES]); assert.equal(cap.mediaCaptionSupported, false); assert.equal(cap.voiceSupported, false); assert.equal(cap.mediaMaxBytes, MAX_MEDIA_BYTES);
});

test('Messenger envia cada tipo permitido em uma parte nativa e uma mensagem sem legenda', async t => {
  for (const [kind, mime, bytes, type] of [
    ['image', 'image/jpeg', Buffer.from([255, 216, 255, 224]), 'image'], ['audio', 'audio/mpeg', Buffer.from('ID3private audio'), 'audio'],
    ['audio', 'audio/mp4', Buffer.from('\x00\x00\x00\x18ftypM4A private audio', 'latin1'), 'audio'],
    ['video', 'video/mp4', Buffer.from('\x00\x00\x00\x18ftypmp42private video', 'latin1'), 'video'],
    ['document', 'application/pdf', Buffer.from('%PDF-1.7 private file'), 'file'], ['document', 'application/octet-stream', Buffer.from('Private binary'), 'file'],
  ]) {
    const c = await outbound(t), file = await c.media.upload(c.context(), { bytes, kind, mime, name: 'Private original' }); c.input.attachmentIds = [file.id];
    const result = await c.dispatch(); assert.equal(c.graph.length, 2, mime);
    assert.equal(JSON.parse(c.graph[0][1].body.get('message')).attachment.type, type);
    assert.equal(c.graph[0][1].body.get('filedata').type, mime); assert.deepEqual(Buffer.from(await c.graph[0][1].body.get('filedata').arrayBuffer()), bytes);
    assert.equal(JSON.parse(c.graph[1][1].body).message.attachment.type, type); assert.equal(result.messages.at(-1).attachments[0].mime, mime);
  }
});

test('Messenger confirma replay sem reler chave/bytes; identidade alterada e corpo diferente não herdam envio', async t => {
  const c = await outbound(t); await c.dispatch();
  c.gateway.secretLoader = async () => { throw new Error('Replay must not load credentials'); }; c.media.resolve = async () => { throw new Error('Replay must not read bytes'); };
  assert.equal((await c.dispatch()).messages.at(-1).delivery, 'sent'); assert.equal(c.graph.length, 2); assert.equal(c.outbox.list(actor, c.tenant.id)[0].attempts, 1);
  c.input.text = 'Changed caption'; await assert.rejects(c.dispatch(), status(409)); c.input.text = '';
  c.revoke(); await assert.rejects(c.dispatch(), status(403)); assert.equal(c.graph.length, 2);
});

test('Messenger escopo uploadOnly impede arquivos recebidos e outra empresa/canal/conversa antes da chave privada', async t => {
  const c = await outbound(t); let resolved = 0;
  const original = c.media.resolve.bind(c.media); c.media.resolve = (...args) => { resolved++; return original(...args); };
  await c.webhook(c.payload({ mid: 'received-private-file' })); await c.settle();
  const received = c.conversation().messages.find(item => item.attachments?.length).attachments[0];
  const other = c.store.createTenant(actor, { name: 'Other private company', segment: 'RAM' });
  const otherChannelId = randomUUID(), otherConversationId = randomUUID(), sameChannelConversationId = randomUUID();
  const copied = structuredClone(c.conversation());
  c.store.mutate(actor, other.id, 'Synthetic private scope', state => { state.channels.push({ id: c.channelId, kind: 'messenger' }); state.conversations.push({ ...copied, messages: [], id: c.conversation().id }); });
  c.edit(state => { state.channels.push({ id: otherChannelId, kind: 'messenger' }); state.conversations.push({ ...copied, messages: [], id: otherConversationId, channelId: otherChannelId }, { ...copied, messages: [], id: sameChannelConversationId }); });
  for (const scope of [{ ...c.context(), tenantId: other.id }, { ...c.context(), channelId: otherChannelId, conversationId: otherConversationId }, { ...c.context(), conversationId: sameChannelConversationId }]) {
    const file = await c.media.upload(scope, { bytes: png, mime: 'image/png' });
    c.input.attachmentIds = [file.id]; c.input.version = c.conversation().version; await assert.rejects(c.send(), status(404));
  }
  for (const id of [received.id, randomUUID()]) { c.input.attachmentIds = [id]; await assert.rejects(c.send(), status(404)); }
  assert.equal(resolved, 0); assert.equal(c.graph.length, 0);
});

test('Messenger tipos fora do subset, legenda, voz e metadados acima do limite recusados antes de bytes/rede', async t => {
  const c = await outbound(t); let resolved = 0, keys = 0;
  c.media.resolve = async () => { resolved++; throw new Error('No private read'); }; c.gateway.secretLoader = async () => { keys++; throw new Error('No credentials'); };
  c.input.text = 'Caption'; await assert.rejects(c.send(), status(400)); c.input.text = '';
  for (const change of [{ mime: 'image/gif' }, { mime: 'audio/ogg', kind: 'audio' }, { voice: true }, { size: MAX_MEDIA_BYTES + 1 }, { status: 'unavailable' }]) {
    c.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify({ ...c.upload, ...change }), c.upload.id);
    await assert.rejects(c.send(), status(change.size ? 413 : change.status ? 404 : 400));
  }
  assert.equal(resolved, 0); assert.equal(keys, 0); assert.equal(c.graph.length, 0);
});

test('Messenger revalida sessão/owner/config/recurso/destino/CAS/janela antes de ler bytes e após await privado', async t => {
  for (const mode of ['revoke', 'owner', 'revision', 'resource', 'recipient', 'conversation', 'window', 'credential', 'descriptor']) {
    const c = await outbound(t), gate = deferred(), started = deferred(); let read = 0;
    const resolve = c.media.resolve.bind(c.media); c.media.resolve = async (...args) => { read++; started.resolve(); await gate.promise; return resolve(...args); };
    const sending = c.send(); await started.promise;
    if (mode === 'revoke') c.revoke();
    else if (mode === 'window') c.clock(initialTime + 24 * 3600_000);
    else if (mode === 'credential') { const storage = c.secrets(), data = storage.get(c.channelId); storage.set(c.channelId, { ...data, meta: { ...data.meta, accessToken: 'synthetic-revoked-access-token' } }); }
    else if (mode === 'descriptor') c.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify({ ...c.upload, name: 'Changed file' }), c.upload.id);
    else c.edit(state => { const channel = state.channels.find(item => item.id === c.channelId), conv = state.conversations.find(item => item.id === c.conversation().id);
      if (mode === 'owner') conv.assignedUserId = 'another-owner'; else if (mode === 'revision') channel.meta.version++; else if (mode === 'resource') channel.meta.resourceId = '888888'; else if (mode === 'recipient') conv.remoteSocialId = '777777'; else conv.version++;
    });
    gate.resolve(); await assert.rejects(sending, status(['revoke', 'owner'].includes(mode) ? 403 : 409));
    assert.equal(read, 1); assert.equal(c.graph.length, 0, mode); assert.equal(c.conversation().messages.filter(item => item.kind === 'human').length, 0);
  }
  const c = await outbound(t); let read = 0; c.media.resolve = async () => { read++; throw new Error('No read'); };
  await assert.rejects(c.send({ reauthorize: () => false }), status(403)); assert.equal(read, 0);
});

test('Messenger carregamento da chave cifrada revalida revogação antes de retornar bytes', async t => {
  const c = await outbound(t), gate = deferred(), started = deferred(); const key = c.media.authKey; c.media.authKey = undefined;
  c.media.keyLoader = async () => { started.resolve(); await gate.promise; return key; };
  const sending = c.send(); await started.promise; c.revoke(); gate.resolve(); await assert.rejects(sending, status(403));
  assert.equal(c.graph.length, 0); assert.equal(c.conversation().messages.filter(item => item.kind === 'human').length, 0);
});

test('Messenger revalida política entre upload confirmado e Send e mantém falha definitiva sem disparar', async t => {
  for (const mode of ['revoke', 'owner', 'revision', 'resource', 'recipient', 'window', 'closed', 'body-await']) {
    let c; c = await outbound(t, { sendResponse: async url => {
      assert.ok(url.endsWith('/message_attachments'));
      const mutate = () => { if (mode === 'revoke') c.revoke(); else if (mode === 'window') c.clock(initialTime + 24 * 3600_000); else if (mode === 'closed') c.gateway.closed = true;
        else c.edit(state => { const channel = state.channels.find(item => item.id === c.channelId), conv = state.conversations.find(item => item.id === c.conversation().id);
          if (mode === 'owner') conv.assignedUserId = 'another-owner'; else if (mode === 'revision' || mode === 'body-await') channel.meta.version++; else if (mode === 'resource') channel.meta.resourceId = '888888'; else conv.remoteSocialId = '777777'; }); };
      if (mode !== 'body-await') mutate(); return { ok: true, status: 200, json: async () => { if (mode === 'body-await') mutate(); return { attachment_id: '112233445566' }; } };
    } });
    await assert.rejects(c.dispatch(), status(['revoke', 'owner'].includes(mode) ? 403 : mode === 'closed' ? 503 : 409));
    assert.equal(c.graph.length, 1, mode); assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, 'failed'); assert.equal(c.conversation().messages.at(-1).delivery, 'failed');
  }
});

test('Messenger upload 4xx falha; rede/5xx/ID malformado ficam incertos sem Send nem retry no outbox', async t => {
  for (const [response, expected, state] of [
    [async () => ({ ok: false, status: 401 }), 503, 'failed'], [async () => ({ ok: false, status: 500 }), 502, 'unknown'],
    [async () => { throw new Error('Synthetic transport contains private token'); }, 502, 'unknown'],
    ...[null, 1234, 'not-a-provider-id', '1'.repeat(41), '1122\n33'].map(attachment_id => [async () => graphJSON({ attachment_id }), 502, 'unknown']),
    [async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '100000' }), json: async () => { throw new Error('No oversized response read'); } }), 502, 'unknown'],
  ]) {
    const c = await outbound(t, { sendResponse: response }); await assert.rejects(c.dispatch(), error => error.status === expected && !error.message.includes('private token'));
    assert.equal(c.graph.length, 1); assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, state); assert.equal(c.conversation().messages.at(-1).delivery, state === 'failed' ? 'failed' : 'unconfirmed');
    await assert.rejects(c.dispatch(), status(409)); assert.equal(c.graph.length, 1); assert.equal(c.outbox.list(actor, c.tenant.id)[0].attempts, 1);
  }
});

test('Messenger Send incerto não repete upload/Send nem reutiliza arquivo com nova chave', async t => {
  const c = await outbound(t, { sendResponse: async url => { if (url.endsWith('/message_attachments')) return graphJSON({ attachment_id: '112233445566' }); throw new Error('Uncertain Send transport'); } });
  await assert.rejects(c.dispatch(), status(502)); assert.equal(c.graph.length, 2); assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, 'unknown');
  await assert.rejects(c.dispatch(), error => error.status === 409 && error.code === 'OUTBOUND_UNCONFIRMED');
  c.input.idempotencyKey = `changed_${randomUUID().replaceAll('-', '')}`; c.input.version = c.conversation().version; await assert.rejects(c.dispatch(), status(409)); assert.equal(c.graph.length, 2);
});

test('Messenger Send 4xx e confirmação com outro destino mantêm distinção failed/unknown após upload', async t => {
  for (const [response, code, state] of [[async () => ({ ok: false, status: 403 }), 503, 'failed'],
    [async () => graphJSON({ recipient_id: '777777', message_id: 'wrong-recipient-mid' }), 502, 'unknown']]) {
    const c = await outbound(t, { sendResponse: async url => url.endsWith('/message_attachments') ? graphJSON({ attachment_id: '112233445566' }) : response() });
    await assert.rejects(c.dispatch(), status(code)); assert.equal(c.graph.length, 2); assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, state);
    await assert.rejects(c.dispatch(), status(409)); assert.equal(c.graph.length, 2); assert.equal(c.outbox.list(actor, c.tenant.id)[0].attempts, 1);
  }
});

test('Messenger identidade de usuário/grant substituída após upload não herda autoridade de envio', async t => {
  for (const field of ['userId', 'supportGrantId', 'resellerId']) {
    const inputActor = { ...actor }; let c;
    c = await outbound(t, { sendResponse: async () => { inputActor[field] = 'another-identity'; return graphJSON({ attachment_id: '112233445566' }); } });
    await assert.rejects(c.gateway.send(inputActor, c.tenant.id, c.conversation().id, c.input), status(403)); assert.equal(c.graph.length, 1);
    assert.equal(c.conversation().messages.at(-1).delivery, 'failed');
  }
});

test('Messenger envio aceito seguido de revogação conserva delivery sent e outbox unknown, sem novo upload', async t => {
  let c; c = await outbound(t, { sendResponse: async url => {
    if (url.endsWith('/message_attachments')) return graphJSON({ attachment_id: '112233445566' });
    c.revoke(); return graphJSON({ recipient_id: senderId, message_id: 'accepted-before-revocation' });
  } });
  await assert.rejects(c.dispatch(), error => error.status === 502 && error.message.includes('Meta aceitou'));
  assert.equal(c.graph.length, 2); assert.equal(c.conversation().messages.at(-1).delivery, 'sent'); assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, 'unknown');
  await assert.rejects(c.dispatch(), status(403)); assert.equal(c.graph.length, 2);
});

test('Messenger congelamento do pedido e bytes mantém snapshot revisado enquanto credenciais aguardam', async t => {
  const c = await outbound(t), gate = deferred(), started = deferred(), storage = c.secrets(); c.gateway.secretLoader = async () => { started.resolve(); await gate.promise; return storage; };
  const sending = c.send(); await started.promise; c.input.channelId = 'changed-channel'; c.input.text = 'Changed caption'; c.input.attachmentIds[0] = randomUUID(); gate.resolve();
  const result = await sending; assert.equal(c.graph.length, 2); assert.equal(result.messages.at(-1).attachments[0].id, c.upload.id); assert.equal(result.messages.at(-1).text, '');
  assert.deepEqual(Buffer.from(await c.graph[0][1].body.get('filedata').arrayBuffer()), png);
});

test('Messenger encerramento aborta upload ativo, preserva estado e impede Send subsequente', async t => {
  const started = deferred(); let aborted = false;
  const c = await outbound(t, { sendResponse: (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('Transport cancelled')); }, { once: true }); started.resolve(); }) });
  const sending = c.dispatch(); await started.promise; await c.gateway.close(); await assert.rejects(sending, status(502));
  assert.equal(aborted, true); assert.equal(c.graph.length, 1); assert.equal(c.gateway.pending.size, 0); assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, 'unknown');
});

test('Messenger mídia tem deadline próprio limitado, aborta upload sem Send e não altera timeout de texto', async t => {
  const keepAlive = setTimeout(() => {}, 500); t.after(() => clearTimeout(keepAlive)); let aborted = false;
  const c = await outbound(t, { gatewayOptions: { timeoutMs: 60000, mediaTimeoutMs: 100 }, sendResponse: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('Synthetic deadline')); }, { once: true });
  }) });
  await assert.rejects(c.dispatch(), status(502)); assert.equal(aborted, true); assert.equal(c.graph.length, 1); assert.equal(c.gateway.pending.size, 0);
  assert.equal(c.gateway.timeoutMs, 60000); assert.equal(c.gateway.mediaTimeoutMs, 100); assert.equal(c.outbox.list(actor, c.tenant.id)[0].state, 'unknown');
  for (const mediaTimeoutMs of [99, 180001, NaN]) assert.throws(() => new MetaGateway(c.store, { mediaTimeoutMs }), /Configuração/);
  const defaults = setup(t); assert.equal(defaults.gateway.mediaTimeoutMs, 180000); assert.equal(defaults.gateway.timeoutMs, 15000);
});

test('Messenger quota do armazenamento privado não cria upload enviável nem chamada externa', async t => {
  const c = setup(t, 'messenger', { mediaOptions: { maxTenantBytes: 1 } }); await c.configure(); await c.webhook(c.payload({ attachments: [], text: 'Open window' })); c.claim();
  await assert.rejects(c.media.upload(c.context(), { bytes: png, kind: 'image', mime: 'image/png' }), status(413));
  assert.equal(c.media.blobs.size, 0); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0); assert.equal(c.graph.length, 0);
});

test('Messenger capability depende do serviço privado completo; captura isolada não habilita envio', async t => {
  const c = setup(t); c.gateway.media = { placeholder() {}, capture() {} }; assert.equal(c.gateway.mediaCapabilities('messenger').mediaSupported, false);
  assert.deepEqual(c.gateway.mediaCapabilities('messenger').mediaKinds, []); assert.deepEqual(c.gateway.mediaCapabilities('messenger').mediaMimes, []);
  c.gateway.media = null; assert.equal(c.gateway.mediaCapabilities('messenger').mediaSupported, false); assert.equal(c.gateway.mediaCapabilities('instagram').mediaSupported, false);
});

test('replyWindow é scoped e síncrono sem chave/canReply/owner e não revela IDs sociais', async t => {
  const c = setup(t); await c.configure(); await c.webhook(c.payload({ attachments: [], text: 'Window input' }));
  c.gateway.secretLoader = async () => { throw new Error('Window must not load keys'); }; c.revoke();
  const result = c.gateway.replyWindow(actor, c.tenant.id, c.conversation().id);
  assert.deepEqual(result, { open: true, expiresAt: new Date(initialTime + 24 * 3600_000).toISOString() }); assert.equal(result?.then, undefined);
  assert.equal(JSON.stringify(result).includes(senderId), false); assert.equal(JSON.stringify(result).includes(resourceId), false);
  await assert.rejects(async () => c.gateway.replyWindow({ ...actor, resellerId: 'another-reseller' }, c.tenant.id, c.conversation().id), status(404));
  c.clock(initialTime + 24 * 3600_000); assert.deepEqual(c.gateway.replyWindow(actor, c.tenant.id, c.conversation().id), { open: false, expiresAt: result.expiresAt });
  c.edit(state => { state.channels.find(item => item.id === c.channelId).meta.enabled = false; });
  assert.deepEqual(c.gateway.replyWindow(actor, c.tenant.id, c.conversation().id), { open: false, expiresAt: null });
});

test('validateSchedule reautoriza responsável e aceita somente texto e prazo estritamente dentro das 24h', async t => {
  const c = setup(t); await c.configure(); await c.webhook(c.payload({ attachments: [], text: 'Schedule input' })); c.claim();
  c.gateway.secretLoader = async () => { throw new Error('Schedule validation must not load keys'); };
  const input = { text: 'Resposta', dueAt: new Date(initialTime + 24 * 3600_000 - 1).toISOString() };
  assert.equal(c.gateway.validateSchedule(actor, c.tenant.id, c.conversation().id, input), true);
  assert.throws(() => c.gateway.validateSchedule(actor, c.tenant.id, c.conversation().id, { ...input, dueAt: new Date(initialTime + 24 * 3600_000).toISOString() }), status(409));
  for (const text of ['', 'a'.repeat(1001)]) assert.throws(() => c.gateway.validateSchedule(actor, c.tenant.id, c.conversation().id, { ...input, text }), status(400));
  assert.throws(() => c.gateway.validateSchedule(actor, c.tenant.id, c.conversation().id, { ...input, dueAt: 'invalid' }), status(409));
  c.edit(state => { state.conversations.find(item => item.id === c.conversation().id).owner = 'queue'; });
  assert.throws(() => c.gateway.validateSchedule(actor, c.tenant.id, c.conversation().id, input), status(409));
  c.claim(); c.revoke(); assert.throws(() => c.gateway.validateSchedule(actor, c.tenant.id, c.conversation().id, input), status(403));
  assert.equal(c.graph.length, 0);
});

test('janela não herda receipts de outro recurso/conversa e expiração posterior invalida schedule', async t => {
  const c = setup(t); await c.configure(); await c.webhook(c.payload({ attachments: [], text: 'Schedule input' })); c.claim();
  const conversationId = c.conversation().id;
  c.store.db.prepare('UPDATE meta_inbound_receipts SET resource_id=?').run('999999');
  assert.deepEqual(c.gateway.replyWindow(actor, c.tenant.id, conversationId), { open: false, expiresAt: null });
  assert.throws(() => c.gateway.validateSchedule(actor, c.tenant.id, conversationId, { text: 'Resposta', dueAt: new Date(initialTime + 1000).toISOString() }), status(409));
  c.store.db.prepare('UPDATE meta_inbound_receipts SET resource_id=?,conversation_id=?').run(resourceId, randomUUID());
  assert.equal(c.gateway.replyWindow(actor, c.tenant.id, conversationId).open, false);
  c.store.db.prepare('UPDATE meta_inbound_receipts SET conversation_id=?').run(conversationId);
  c.clock(initialTime + 24 * 3600_000);
  assert.throws(() => c.gateway.validateSchedule(actor, c.tenant.id, conversationId, { text: 'Resposta', dueAt: new Date(initialTime + 1000).toISOString() }), status(409));
});

test('janela fechada sem recibo ou receipt no futuro inválido; nenhum carregador de chave acionado', async t => {
  const c = setup(t); await c.configure(); await c.webhook(c.payload({ attachments: [], text: 'Window input' })); const conversationId = c.conversation().id;
  c.gateway.secretLoader = async () => { throw new Error('Window must not load keys'); };
  c.store.db.prepare('UPDATE meta_inbound_receipts SET source_timestamp=?').run(initialTime + 300_001);
  assert.deepEqual(c.gateway.replyWindow(actor, c.tenant.id, conversationId), { open: false, expiresAt: null });
  c.store.db.prepare('DELETE FROM meta_inbound_receipts').run();
  assert.deepEqual(c.gateway.replyWindow(actor, c.tenant.id, conversationId), { open: false, expiresAt: null });
});
