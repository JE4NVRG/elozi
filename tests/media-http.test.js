import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { MAX_MEDIA_BYTES } from '../src/media.js';

const secret = () => 'Synthetic-' + randomBytes(12).toString('hex');
const denied = async () => { throw new Error('External access forbidden in media fixture'); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

async function fixture(t, options = {}) {
  const key = randomBytes(32), deliveries = [], calls = [];
  let uncertain = false, telegramSequence = 0;
  const app = createApp({ databasePath: ':memory:', serviceKey: key, publicOrigin: '',
    ...options, providerCall: denied, mediaOptions: { directory: null, authKey: key },
    gatewayOptions: { authKey: key, socketFactory: denied, downloadMediaImpl: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1);
      assert.ok(method.startsWith('send'), 'Only the fake send transport may be called');
      calls.push({ method, body: options.body });
      if (uncertain) throw new Error('Synthetic acceptance without confirmation');
      return { ok: true, json: async () => ({ ok: true, result: { chat: { id: -123456 }, message_id: ++telegramSequence } }) };
    } }, googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const pending = (path, { method = 'GET', body, cookie = '', headers = {} } = {}) => {
    let req;
    const promise = new Promise((resolve, reject) => {
      req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          const bytes = Buffer.concat(chunks), json = response.headers['content-type']?.startsWith('application/json');
          try { resolve({ status: response.statusCode, headers: response.headers, bytes, data: json ? JSON.parse(bytes.toString()) : null,
            cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); }
        });
      }); req.on('error', reject);
    });
    return { req, promise, end: () => req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)) };
  };
  const request = (path, options) => { const item = pending(path, options); item.end(); return item.promise; };
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Gestor QA mídia', username: 'media.owner', password: secret() } });
  assert.equal(owner.status, 200);
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  owner.id = actor.userId;
  const created = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Mídia sintética', segment: 'QA' } });
  assert.equal(created.status, 201);
  const tenantId = created.data.id, path = `/api/tenants/${tenantId}`, wa = 'media-wa', tg = 'media-tg', support = 'media-support';
  app.store.mutate(actor, tenantId, 'Fixture sintética de mídia', tenant => {
    tenant.channels = [{ id: wa, kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }, { id: tg, kind: 'telegram', transport: 'telegram-bot', state: 'connected' }];
    tenant.departments = [{ id: support, name: 'Suporte', active: true, memberIds: [], distribution: 'manual', version: 1 }]; tenant.defaultDepartmentId = support;
  });
  const gatewayActor = { role: 'reseller', resellerId: actor.resellerId, name: 'Gateway sintético' };
  const waEntry = { actor: gatewayActor, tenantId, channelId: wa, matched: true, state: 'connected', generation: 1,
    socket: { user: { id: '5511999990000@s.whatsapp.net' }, end() {}, sendMessage: async (jid, content, options) => {
      deliveries.push({ jid, content, options }); if (uncertain) throw new Error('Synthetic confirmation lost'); return { key: { id: options.messageId } };
    } } };
  app.gateway.entries.set(wa, waEntry);
  app.telegram.entries.set(tg, { actor: gatewayActor, tenantId, channelId: tg, state: 'connected', token: '12345:synthetic_token_only', abort: new AbortController() });
  let conversationSequence = 0, memberSequence = 0;
  const state = () => app.store.tenant(actor, tenantId);
  const conversation = (overrides = {}) => app.store.mutate(actor, tenantId, 'Fixture: conversa de mídia', tenant => {
    const value = { id: 'media-conversation-' + ++conversationSequence, channelId: wa, contact: 'Contato sintético', remoteJid: '5511900000000@s.whatsapp.net',
      departmentId: support, department: 'Suporte', owner: 'queue', assignedUserId: null, agentId: null, status: 'open', version: 1, tags: [], messages: [], ...overrides };
    tenant.conversations.push(value); return value;
  });
  const current = id => state().conversations.find(value => value.id === id);
  const member = async (overrides = {}) => {
    const username = 'media.member.' + ++memberSequence, password = secret();
    const result = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Atendente de mídia', username, password, role: 'operator', tenantIds: [tenantId], ...overrides } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    app.store.mutate(actor, tenantId, 'Fixture: membro de departamento', tenant => { tenant.departments[0].memberIds.push(result.data.id); });
    const signed = await request('/api/auth/login', { method: 'POST', body: { username, password } }); assert.equal(signed.status, 200);
    return { ...result.data, cookie: signed.cookie };
  };
  const claim = async (value, user = owner) => {
    const result = await request(`${path}/conversations/${value.id}/owner`, { method: 'POST', cookie: user.cookie, body: { version: value.version, owner: 'human' } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  };
  const attachmentPath = value => `${path}/conversations/${value.id}/attachments`;
  const upload = (value, body = png, headers = {}, user = owner) => request(attachmentPath(value), { method: 'POST', cookie: user.cookie, body,
    headers: { 'Content-Type': 'image/png', 'X-Elozi-Filename': encodeURIComponent('imagem.png'), 'X-Elozi-Conversation-Version': value.version, ...headers } });
  const send = (value, attachment, overrides = {}, user = owner) => request(`${path}/conversations/${value.id}/messages`, { method: 'POST', cookie: user.cookie,
    body: { version: value.version, channelId: value.channelId, text: 'Legenda sintética', attachmentIds: [attachment.id], idempotencyKey: randomUUID(), ...overrides } });
  return { app, request, pending, base, actor, owner, tenantId, path, wa, tg, support, waEntry, state, current, conversation, claim, member, attachmentPath, upload, send, deliveries, calls, uncertain: value => { uncertain = value; } };
}

test('HTTP anexo fica privado até o envio, mantém origem/autoria e repete confirmação sem novo disparo', async t => {
  const c = await fixture(t), conversation = await c.claim(c.conversation());
  const uploaded = await c.upload(conversation); assert.equal(uploaded.status, 201); assert.equal(uploaded.data.preview, true);
  assert.equal((await c.request(`${c.attachmentPath(conversation)}/${uploaded.data.id}`, { cookie: c.owner.cookie })).status, 404);
  const key = randomUUID(), sent = await c.send(conversation, uploaded.data, { idempotencyKey: key });
  assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(c.deliveries.length, 1);
  assert.deepEqual(c.deliveries[0].content.image, png); assert.equal(c.deliveries[0].content.caption, 'Legenda sintética');
  const message = sent.data.messages.find(item => item.attachments?.[0].id === uploaded.data.id);
  assert.equal(message.authorUserId, c.owner.id); assert.equal(message.delivery, 'sent');
  assert.equal(sent.data.remoteJid, undefined);
  const downloaded = await c.request(`${c.attachmentPath(conversation)}/${uploaded.data.id}`, { cookie: c.owner.cookie });
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, png); assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
  assert.match(downloaded.headers['content-disposition'], /^inline;/);
  assert.match(downloaded.headers['content-security-policy'], /media-src 'self' blob:/);
  assert.doesNotMatch(downloaded.headers['content-security-policy'], /media-src[^;]*https:/);
  assert.equal((await c.send(conversation, uploaded.data, { idempotencyKey: key })).status, 200); assert.equal(c.deliveries.length, 1);
  assert.equal((await c.send(c.current(conversation.id), uploaded.data)).status, 409); assert.equal(c.deliveries.length, 1);
});

test('HTTP Telegram envia documento no tópico original e conteúdo ativo sempre baixa como arquivo', async t => {
  const c = await fixture(t), conversation = await c.claim(c.conversation({ channelId: c.tg, remoteChatId: '-123456', threadId: 77 }));
  const payload = Buffer.from('<svg onload="alert(1)"></svg>');
  const uploaded = await c.upload(conversation, payload, { 'Content-Type': 'image/svg+xml', 'X-Elozi-Filename': encodeURIComponent('../Relatório<bad>.svg') });
  assert.equal(uploaded.status, 201); assert.equal(uploaded.data.kind, 'document'); assert.equal(uploaded.data.mime, 'application/octet-stream');
  assert.equal(uploaded.data.name, 'Relatóriobad.svg'); assert.equal(uploaded.data.preview, false);
  const sent = await c.send(conversation, uploaded.data); assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].method, 'sendDocument');
  assert.equal(c.calls[0].body.get('chat_id'), '-123456'); assert.equal(c.calls[0].body.get('message_thread_id'), '77');
  assert.deepEqual(Buffer.from(await c.calls[0].body.get('document').arrayBuffer()), payload);
  const read = await c.request(`${c.attachmentPath(conversation)}/${uploaded.data.id}`, { cookie: c.owner.cookie });
  assert.equal(read.status, 200); assert.match(read.headers['content-disposition'], /^attachment;/); assert.equal(read.headers['content-type'], 'application/octet-stream');
  assert.equal((await c.send(c.current(conversation.id), uploaded.data, { attachmentIds: [uploaded.data.id, randomUUID()] })).status, 400);
  assert.equal(c.calls.length, 1);
});

test('HTTP upload exige sessão, origem, responsável, CAS, formato e tamanho antes de armazenar', async t => {
  const c = await fixture(t), queued = c.conversation();
  assert.equal((await c.upload(queued)).status, 409);
  const conversation = await c.claim(queued);
  assert.equal((await c.upload(conversation, png, { Origin: 'https://foreign.example.test' })).status, 403);
  assert.equal((await c.upload(conversation, png, {}, { cookie: '' })).status, 401);
  assert.equal((await c.upload({ ...conversation, version: 1 })).status, 409);
  assert.equal((await c.upload(conversation, Buffer.from('not png'))).status, 400);
  assert.equal((await c.upload(conversation, Buffer.alloc(0))).status, 400);
  assert.equal((await c.upload(conversation, png, { 'X-Elozi-Filename': '%' })).status, 400);
  assert.equal((await c.upload(conversation, Buffer.alloc(0), { 'Content-Length': MAX_MEDIA_BYTES + 1 })).status, 413);
  assert.equal(c.app.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0);
  assert.equal(c.deliveries.length, 0);
});

test('HTTP anexo não atravessa conversa, canal, empresa ou escopo de leitura', async t => {
  const c = await fixture(t), conversation = await c.claim(c.conversation());
  const file = await c.upload(conversation); assert.equal(file.status, 201);
  assert.equal((await c.send(conversation, file.data, { channelId: c.tg })).status, 400);
  assert.equal((await c.send(conversation, file.data)).status, 200);
  const other = await c.claim(c.conversation({ channelId: c.tg, remoteChatId: '-123456' }));
  assert.equal((await c.request(`${c.attachmentPath(other)}/${file.data.id}`, { cookie: c.owner.cookie })).status, 404);
  assert.equal((await c.send(other, file.data)).status, 404);
  const scoped = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.tg], departmentIds: [c.support] } } });
  assert.equal((await c.request(`${c.attachmentPath(conversation)}/${file.data.id}`, { cookie: scoped.cookie })).status, 403);
  const foreign = await c.request('/api/auth/register', { method: 'POST', body: { fiscalDocument: syntheticFiscalDocument(), name: 'Outra revenda QA', email: 'media-other@example.test', password: secret(), company: 'Outra revenda' } });
  assert.equal(foreign.status, 200);
  assert.equal((await c.request(`${c.attachmentPath(conversation)}/${file.data.id}`, { cookie: foreign.cookie })).status, 404);
  assert.equal((await c.request(`${c.attachmentPath(conversation)}/${file.data.id}`, { cookie: c.owner.cookie, headers: { 'X-Elozi-Workspace': 'foreign-workspace' } })).status, 403);
  assert.equal(c.deliveries.length, 1); assert.equal(c.calls.length, 0);
});

test('HTTP revalida cookie e CAS quando o corpo binário chega depois de uma alteração', async t => {
  for (const change of ['revoke', 'version']) await t.test(change, async t => {
    const c = await fixture(t), user = await c.member(), conversation = await c.claim(c.conversation(), user), arrived = deferred();
    c.app.server.once('request', req => { assert.equal(req.url, c.attachmentPath(conversation)); req.once('data', arrived.resolve); });
    const upload = c.pending(c.attachmentPath(conversation), { method: 'POST', cookie: user.cookie,
      headers: { 'Content-Type': 'image/png', 'X-Elozi-Conversation-Version': conversation.version, 'X-Elozi-Filename': 'race.png' } });
    upload.req.write(png.subarray(0, 8)); await arrived.promise;
    if (change === 'revoke') assert.equal((await c.request(`/api/users/${user.id}/disable`, { method: 'POST', cookie: c.owner.cookie, body: {} })).status, 200);
    else assert.equal((await c.request(`${c.path}/conversations/${conversation.id}/owner`, { method: 'POST', cookie: c.owner.cookie,
      body: { version: conversation.version, owner: 'queue' } })).status, 200);
    upload.req.end(png.subarray(8)); assert.equal((await upload.promise).status, change === 'revoke' ? 401 : 409);
    assert.equal(c.app.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0); assert.equal(c.deliveries.length, 0);
  });
});

test('HTTP descarta upload salvo após revogação e bloqueia download após await de leitura', async t => {
  const c = await fixture(t), user = await c.member(), conversation = await c.claim(c.conversation(), user), media = c.app.gateway.media;
  const originalUpload = media.upload.bind(media), saved = deferred(), resume = deferred();
  media.upload = async (...args) => { const result = await originalUpload(...args); saved.resolve(); await resume.promise; return result; };
  const uploading = c.upload(conversation, png, {}, user); await saved.promise;
  assert.equal((await c.request(`/api/users/${user.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { permissions: ['inbox.read'] } })).status, 200);
  resume.resolve(); assert.equal((await uploading).status, 401); assert.equal(media.blobs.size, 0);
  assert.equal(c.app.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0);
  media.upload = originalUpload;
  const owned = await c.claim(c.current(conversation.id)), file = await c.upload(owned); assert.equal((await c.send(owned, file.data)).status, 200);
  const reader = await c.member({ permissions: ['inbox.read'] }), originalRead = media.read.bind(media), read = deferred(), release = deferred();
  media.read = async (...args) => { const value = await originalRead(...args); read.resolve(); await release.promise; return value; };
  const download = c.request(`${c.attachmentPath(owned)}/${file.data.id}`, { cookie: reader.cookie }); await read.promise;
  assert.equal((await c.request(`/api/users/${reader.id}/disable`, { method: 'POST', cookie: c.owner.cookie, body: {} })).status, 200);
  release.resolve(); const deniedRead = await download; assert.equal(deniedRead.status, 401); assert.equal(typeof deniedRead.data.error, 'string');
  assert.notDeepEqual(deniedRead.bytes, png);
});

test('HTTP entrada expõe placeholder e resultado local, sem URLs, chaves ou remetente privado', async t => {
  const c = await fixture(t), started = deferred(), release = deferred();
  c.app.gateway.downloadMedia = async () => { started.resolve(); await release.promise; return png; };
  const incoming = { key: { id: 'incoming-media', remoteJid: '5511900000001@s.whatsapp.net' }, pushName: 'Contato de mídia sintético',
    message: { imageMessage: { caption: 'Foto sintética', mimetype: 'image/png', fileLength: png.length, url: 'https://provider.example.test/private', mediaKey: randomBytes(32) } } };
  await c.app.gateway.receive(c.waEntry, incoming); await started.promise;
  const snapshot = await c.request(c.path, { cookie: c.owner.cookie }), conversation = snapshot.data.conversations.find(item => item.messages.some(message => message.externalId === 'incoming-media'));
  const attachment = conversation.messages.find(message => message.externalId === 'incoming-media').attachments[0]; assert.equal(attachment.status, 'pending');
  const publicState = JSON.stringify(snapshot.data); assert.doesNotMatch(publicState, /provider\.example|mediaKey|remoteJid|s\.whatsapp\.net/);
  assert.equal((await c.request(`${c.attachmentPath(conversation)}/${attachment.id}`, { cookie: c.owner.cookie })).status, 404);
  const capture = [...c.app.gateway.mediaTasks]; release.resolve(); await Promise.all(capture);
  const ready = c.current(conversation.id).messages.find(message => message.externalId === 'incoming-media').attachments[0]; assert.equal(ready.status, 'ready');
  assert.deepEqual((await c.request(`${c.attachmentPath(conversation)}/${ready.id}`, { cookie: c.owner.cookie })).bytes, png);
  c.app.gateway.downloadMedia = denied;
  await c.app.gateway.receive(c.waEntry, { ...incoming, key: { ...incoming.key, id: 'unavailable-media' } }); await Promise.all([...c.app.gateway.mediaTasks]);
  const unavailable = c.current(conversation.id).messages.find(message => message.externalId === 'unavailable-media').attachments[0]; assert.equal(unavailable.status, 'unavailable');
  assert.equal((await c.request(`${c.attachmentPath(conversation)}/${unavailable.id}`, { cookie: c.owner.cookie })).status, 404);
  assert.equal(c.deliveries.length, 0);
});

test('HTTP envio incerto de arquivo não repete transporte pelo comando nem por outro identificador', async t => {
  const c = await fixture(t), conversation = await c.claim(c.conversation()), file = await c.upload(conversation), key = randomUUID();
  c.uncertain(true); assert.equal((await c.send(conversation, file.data, { idempotencyKey: key })).status, 502);
  const current = c.current(conversation.id); assert.equal(current.messages.at(-1).delivery, 'unconfirmed');
  assert.equal((await c.send(conversation, file.data, { idempotencyKey: key })).status, 409);
  assert.equal((await c.send(current, file.data)).status, 409); assert.equal(c.deliveries.length, 1);
  const outbox = await c.request(c.path + '/outbox', { cookie: c.owner.cookie }); assert.equal(outbox.status, 200); assert.equal(outbox.data.commands[0].state, 'unknown');
});

test('HTTP limita uploads a quatro globais e um por pessoa, liberando slot após corpo inválido', async t => {
  const c = await fixture(t), users = [c.owner];
  for (let i = 0; i < 4; i++) users.push(await c.member());
  const conversations = [];
  for (const user of users) conversations.push(await c.claim(c.conversation(), user));
  const inFlight = [];
  try {
    for (let i = 0; i < 4; i++) {
      const observed = deferred(), conversation = conversations[i];
      c.app.server.once('request', req => { assert.equal(req.url, c.attachmentPath(conversation)); observed.resolve(); });
      const upload = c.pending(c.attachmentPath(conversation), { method: 'POST', cookie: users[i].cookie,
        headers: { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked', 'X-Elozi-Conversation-Version': conversation.version, 'X-Elozi-Filename': 'concurrent.png' } });
      inFlight.push(upload); upload.req.flushHeaders(); await observed.promise;
      if (i === 0) assert.equal((await c.upload(conversation, png, {}, users[i])).status, 429, 'A second body cannot occupy the same person slot');
    }
    assert.equal((await c.upload(conversations[4], png, {}, users[4])).status, 429, 'A fifth distinct person cannot bypass the global limit');
    assert.equal(c.app.media.blobs.size, 0);
    inFlight[0].req.end(); assert.equal((await inFlight[0].promise).status, 400);
    const released = await c.upload(conversations[4], png, {}, users[4]); assert.equal(released.status, 201, 'An invalid body must release the global slot');
    const samePerson = await c.upload(conversations[0], png, {}, users[0]); assert.equal(samePerson.status, 201, 'An invalid body must release the person slot');
    for (const upload of inFlight.slice(1)) upload.req.end(png);
    for (const upload of inFlight.slice(1)) assert.equal((await upload.promise).status, 201);
    assert.equal(c.deliveries.length, 0); assert.equal(c.calls.length, 0);
  } finally {
    for (const upload of inFlight) if (!upload.req.writableEnded) upload.req.end();
    await Promise.allSettled(inFlight.map(upload => upload.promise));
  }
});

test('HTTP canal sandbox rejeita anexos sem produzir mensagem ou consumir arquivo', async t => {
  const c = await fixture(t), real = await c.claim(c.conversation()), file = await c.upload(real); assert.equal(file.status, 201);
  c.app.store.mutate(c.actor, c.tenantId, 'Fixture: canal sem transporte externo', tenant => { tenant.channels.push({ id: 'media-sandbox', kind: 'instagram', state: 'planned' }); });
  const conversation = await c.claim(c.conversation({ channelId: 'media-sandbox' }));
  const before = c.current(conversation.id), result = await c.send(conversation, file.data);
  assert.equal(result.status, 400); assert.match(result.data.error, /WhatsApp e Telegram/);
  assert.deepEqual(c.current(conversation.id), before); assert.equal(c.app.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n, 0);
  assert.equal(c.app.media.metadata(file.data.id, { tenantId: c.tenantId, conversationId: real.id, channelId: real.channelId }).status, 'ready');
  assert.equal((await c.upload(conversation)).status, 400); assert.equal(c.deliveries.length, 0); assert.equal(c.calls.length, 0);
});


test('HTTP gravação é normalizada antes de cifrar e enviar como voz, sem campos extras',async t=>{
 const opus=Buffer.concat([Buffer.from('OggS'),Buffer.from([0,2]),Buffer.alloc(20),Buffer.from([1,19]),Buffer.from('OpusHead'),Buffer.from([1,1]),Buffer.alloc(8),Buffer.from([0])]);
 let conversions=0;
 const c=await fixture(t,{voiceNormalizer:async (bytes,{mime})=>{assert.equal(mime,'audio/webm');assert.ok(bytes.subarray(0,4).equals(Buffer.from([26,69,223,163])));conversions++;return {bytes:Buffer.from(opus),mime:'audio/ogg',name:'Mensagem de voz.ogg',kind:'audio'};}});
 const conversation=await c.claim(c.conversation());
 const upload=await c.upload(conversation,Buffer.from([26,69,223,163,0]),{'Content-Type':'audio/webm','X-Elozi-Voice':'1'});
 assert.equal(upload.status,201,JSON.stringify(upload.data));assert.equal(conversions,1);assert.equal(upload.data.mime,'audio/ogg');assert.equal(upload.data.voice,undefined);
 const sent=await c.send(conversation,upload.data,{text:''});assert.equal(sent.status,200,JSON.stringify(sent.data));assert.equal(c.deliveries[0].content.ptt,true);assert.deepEqual(c.deliveries[0].content.audio,opus);
});

test('HTTP gravação rejeita header inválido sem ocupar slots de upload',async t=>{
 const c=await fixture(t),conversation=await c.claim(c.conversation());
 for(let i=0;i<5;i++)assert.equal((await c.upload(conversation,png,{'X-Elozi-Voice':'true'})).status,400);
 assert.equal((await c.upload(conversation)).status,201);
});

test('HTTP revalida responsável após conversão e não grava anexo após transferência',async t=>{
 let change;
 const c=await fixture(t,{voiceNormalizer:async()=>{change();return {bytes:Buffer.from(png),mime:'image/png',name:'fixture.png',kind:'image'};}});
 const conversation=await c.claim(c.conversation());
 change=()=>c.app.store.mutate({role:'reseller',resellerId:c.app.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(c.tenantId).reseller_id,name:'Fixture'},c.tenantId,'Transferência concorrente',tenant=>{const item=tenant.conversations.find(item=>item.id===conversation.id);item.assignedUserId=null;item.owner='queue';item.version++;});
 const before=c.app.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n;
 const upload=await c.upload(conversation,png,{'Content-Type':'audio/webm','X-Elozi-Voice':'1'});
 assert.equal(upload.status,409);assert.equal(c.app.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n,before);assert.equal(c.deliveries.length,0);
});
