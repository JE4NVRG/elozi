import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { MAX_MEDIA_BYTES } from '../src/media.js';

const host = 'elozi.je4ndev.com', teamOrigin = `https://${host}`, visitorOrigin = 'https://widget-fixture.example.test';
const customHost = 'webchat-media.example.com', revision = 'd'.repeat(40);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const ogg = Buffer.from('OggS-synthetic-voice-only');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const barrier = () => ({ entered: deferred(), release: deferred() });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function frame(input = {}, bytes = png) {
  const header = Buffer.from(JSON.stringify({ clientMessageId: randomUUID(), name: 'imagem-qa.png', mime: 'image/png', voice: false, ...input }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, bytes]);
}

async function fixture(t, { sessionTtlMs = 60000 } = {}) {
  const key = randomBytes(32), calls = { external: [], normalizer: [], captures: [], keys: 0, saves: 0, hooks: 0, routes: 0 }, control = { now: Date.now() };
  const deny = async () => { calls.external.push(true); throw new Error('Transporte externo proibido neste ensaio em RAM.'); };
  let app, userSequence = 0;
  app = createApp({ databasePath: ':memory:', publicOrigin: teamOrigin, serviceKey: key, releaseRevision: revision, allowRegistration: false,
    providerCall: deny, mcpFetchImpl: deny, googleOptions: { clientId: '' }, gatewayOptions: { authKey: key, socketFactory: deny, downloadMediaImpl: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny },
    emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny, mediaDownloader: deny }, webchatOptions: { now: () => control.now, sessionTtlMs },
    mediaOptions: { directory: null, authKey: key, keyLoader: async () => { const gate = control.keyGate; calls.keys++; gate?.onKey?.(calls.keys); if (gate) { gate.entered.resolve(); await gate.release.promise; } return key; } },
    voiceNormalizer: async (bytes, input) => { calls.normalizer.push({ mime: input.mime, hash: digest(bytes) }); const gate = control.voiceGate; if (gate) { gate.entered.resolve(); await gate.release.promise; } return { bytes: Buffer.from(control.voiceBytes || ogg), mime: control.voiceMime || 'audio/ogg', name: control.voiceName || 'voz-qa.ogg' }; },
    domainOptions: { canonicalHost: host,
      resolver: { resolveTxt: async name => { const binding = JSON.parse(app.store.db.prepare('SELECT data FROM resellers WHERE id=?').get('mep-demo').data).workspaceDomain; return [[`elozi-verification=${binding.challenge}`]]; }, resolveCname: async () => [host] },
      inspectDeployment: async name => ({ host: name, httpsOrigin: `https://${name}`, tlsValid: true, proxyVerified: true, certificateExpiresAt: new Date(Date.now() + 3600000).toISOString(), sourceRevision: revision }) }
  });
  const capture = app.media.capture.bind(app.media), save = app.media.save.bind(app.media), incoming = app.webchat.onIncoming, route = app.operations.routeIncoming.bind(app.operations);
  app.media.capture = (...args) => { calls.captures.push(args[0]); return capture(...args); };
  app.media.save = (...args) => { calls.saves++; control.keyGate?.onSave?.(calls.saves); return save(...args); };
  app.webchat.onIncoming = (...args) => { calls.hooks++; return incoming?.(...args); };
  app.operations.routeIncoming = (...args) => { calls.routes++; return route(...args); };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    control.keyGate?.release.resolve(); control.voiceGate?.release.resolve(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.gateway.close(), app.telegram.close(), app.webchat.close(), app.meta.close(), app.emailChannel.close(), app.email.close(), app.bridge.close()]);
    app.store.close(); assert.deepEqual(calls.external, [], 'Nenhum provedor real foi acionado.');
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const pending = (path, { method = 'GET', cookie = '', body, raw, requestOrigin = teamOrigin, requestHost = host, headers = {} } = {}) => {
    const outgoing = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body))); let req;
    const promise = new Promise((resolve, reject) => {
      req = httpRequest(base + path, { method, headers: { Host: requestHost, Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json', ...(outgoing ? { 'Content-Length': outgoing.length } : {}), ...headers } }, response => {
        const chunks = []; response.on('error', reject); response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
          try { const bytes = Buffer.concat(chunks), text = bytes.toString(); resolve({ status: response.statusCode, headers: response.headers, bytes, text,
            data: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : undefined }); } catch (error) { reject(error); }
        });
      }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('A requisição em loopback excedeu o prazo do fixture.')));
    });
    t.after(() => req.destroy()); return { req, promise, end: () => req.end(outgoing) };
  };
  const request = (path, options) => { const value = pending(path, options); value.end(); return value.promise; };
  const member = (tenantIds = [], role = 'operator', workspace = 'mep-demo', platformAdmin = false) => {
    const name = 'Pessoa webchat RAM ' + ++userSequence;
    const row = app.auth.insertUser({ username: 'webchat.media.http.' + userSequence, name }, randomBytes(16), randomBytes(64), role, tenantIds, workspace, { platformAdmin });
    const session = app.auth.session(row); return { id: row.id, actor: session.actor, cookie: 'mep_session=' + session.token };
  };
  const owner = member([], 'reseller', 'mep-demo', true);
  app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('webchat-other', JSON.stringify({ name: 'Outro workspace RAM', accountKind: 'business', brand: { name: 'QA' } }));
  const other = member([], 'reseller', 'webchat-other');
  const tenant = app.store.createTenant(owner.actor, { name: 'Webchat mídia A', segment: 'QA' }), foreign = app.store.createTenant(other.actor, { name: 'Webchat mídia B', segment: 'QA' });
  for (const [actor, target, ids] of [[owner.actor, tenant, ['web-a', 'web-sibling']], [other.actor, foreign, ['web-b']]]) app.store.mutate(actor, target.id, 'Fixture: webchat em RAM', state => {
    state.channels = ids.map(id => ({ id, kind: 'webchat', transport: 'elozi-webchat', name: id, state: 'disconnected' })); state.conversations = []; state.departments = [];
  });
  const operator = member([tenant.id]);
  const publicPath = (tid = tenant.id, cid = 'web-a') => `/api/public/webchat/${tid}/${cid}`;
  const configPath = (tid = tenant.id, cid = 'web-a') => `/api/tenants/${tid}/channels/${cid}/configuration`;
  const configure = async (input = {}, tid = tenant.id, cid = 'web-a', actor = owner) => {
    const channel = app.store.tenant(actor.actor, tid).channels.find(item => item.id === cid);
    return request(configPath(tid, cid), { method: 'POST', cookie: actor.cookie, body: { version: channel.webchat?.version || 0, enabled: true, origins: [visitorOrigin], ...input } });
  };
  for (const [tid, cid, actor] of [[tenant.id, 'web-a', owner], [tenant.id, 'web-sibling', owner], [foreign.id, 'web-b', other]]) {
    const configured = await configure({}, tid, cid, actor); assert.equal(configured.status, 200, configured.data?.error);
  }
  const openVisitor = async (tid = tenant.id, cid = 'web-a', options = {}) => {
    const challenge = await request(publicPath(tid, cid) + '/challenge', { method: 'POST', requestOrigin: visitorOrigin, body: {}, ...options }); assert.equal(challenge.status, 200, challenge.data?.error);
    const session = await request(publicPath(tid, cid) + '/session', { method: 'POST', requestOrigin: visitorOrigin, body: { challenge: challenge.data.challenge, name: 'Visitante sintético' }, ...options }); assert.equal(session.status, 200, session.data?.error);
    return { token: session.data.token, tid, cid, challenge: challenge.data, opened: session.data, requestHost: options.requestHost || host };
  };
  const receiveOptions = (visitor, extra = {}) => ({ method: 'POST', requestOrigin: visitorOrigin, requestHost: visitor.requestHost, headers: { Authorization: `Bearer ${visitor.token}`, 'Content-Type': 'application/octet-stream' }, ...extra });
  const receive = (visitor, input, bytes = png, extra = {}) => request(publicPath(visitor.tid, visitor.cid) + '/media', receiveOptions(visitor, { raw: frame(input, bytes), ...extra }));
  const history = (visitor, extra = {}) => request(publicPath(visitor.tid, visitor.cid) + '/history', { method: 'POST', requestOrigin: visitorOrigin, requestHost: visitor.requestHost, body: { token: visitor.token }, ...extra });
  const download = (visitor, attachmentId, extra = {}) => request(publicPath(visitor.tid, visitor.cid) + '/media/' + attachmentId,
    { method: 'POST', requestOrigin: visitorOrigin, requestHost: visitor.requestHost, body: { token: visitor.token }, ...extra });
  const state = (tid = tenant.id, actor = owner) => app.store.tenant(actor.actor, tid);
  const current = visitor => { const row = app.store.db.prepare('SELECT conversation_id FROM webchat_sessions WHERE token_hash=?').get(digest(visitor.token)); return state(visitor.tid, visitor.tid === foreign.id ? other : owner).conversations.find(item => item.id === row?.conversation_id); };
  const claim = async visitor => { const value = current(visitor); const result = await request(`/api/tenants/${visitor.tid}/conversations/${value.id}/owner`, { method: 'POST', cookie: operator.cookie, body: { version: value.version, owner: 'human' } }); assert.equal(result.status, 200, result.data?.error); return result.data; };
  const teamUpload = (visitor, bytes = png, extra = {}) => { const value = current(visitor); return request(`/api/tenants/${visitor.tid}/conversations/${value.id}/attachments`, { method: 'POST', cookie: operator.cookie, raw: bytes,
    headers: { 'Content-Type': 'image/png', 'X-Elozi-Filename': 'resposta-qa.png', 'X-Elozi-Conversation-Version': value.version }, ...extra }); };
  const totals = () => ({ conversations: app.store.db.prepare('SELECT data FROM tenants WHERE id IN (?,?)').all(tenant.id, foreign.id).reduce((n, row) => n + JSON.parse(row.data).conversations.length, 0),
    media: app.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, blobs: app.media.blobs.size, receipts: app.store.db.prepare('SELECT count(*) AS n FROM webchat_inbound_receipts').get().n,
    outbox: app.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n });
  const bindHost = async () => {
    let status = app.domains.status(owner.actor, 'mep-demo'); status = app.domains.register(owner.actor, 'mep-demo', { version: status.version, host: customHost });
    status = await app.domains.verify(owner.actor, 'mep-demo', { version: status.version }); status = await app.domains.confirmDeployment(owner.actor, 'mep-demo', { version: status.version });
    assert.equal(status.binding.active, true); return status;
  };
  const revokeHost = () => app.domains.disable(owner.actor, 'mep-demo', { version: app.domains.status(owner.actor, 'mep-demo').version });
  const watchRequest = path => { const entered = deferred(); const listener = req => { if (req.url === path) { app.server.off('request', listener); entered.resolve(); } }; app.server.on('request', listener); t.after(() => app.server.off('request', listener)); return entered; };
  return { app, control, calls, owner, other, operator, tenant, foreign, base, request, pending, publicPath, configPath, configure,
    openVisitor, receiveOptions, receive, history, download, state, current, claim, teamUpload, totals, bindHost, revokeHost, watchRequest };
}

function privateDTO(result, tokens = []) {
  for (const value of [...tokens, 'token_hash', 'remoteSessionId', 'assignedUserId', 'authorUserId', 'ciphertext', 'reauthorize']) assert.equal(result.text.includes(value), false, 'O DTO público não contém identidade privada ou segredo.');
}

function noNewData(f) { assert.deepEqual(f.totals(), { conversations: 0, media: 0, blobs: 0, receipts: 0, outbox: 0 }); }

test('HTTP primeiro arquivo abre fila; equipe assume e responde com anexo privado visível somente após confirmação', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), receipt = await f.receive(visitor, { text: 'Legenda do visitante' });
  assert.equal(receipt.status, 200, receipt.data?.error); assert.equal(receipt.data.replayed, false); privateDTO(receipt, [visitor.token]);
  const queued = f.current(visitor); assert.equal(queued.owner, 'queue'); assert.equal(queued.messages.length, 1); assert.equal(queued.messages[0].attachments[0].status, 'ready');
  const first = await f.history(visitor); assert.equal(first.status, 200); assert.equal(first.data.mediaSupported, true); privateDTO(first, [visitor.token]);
  const incoming = first.data.messages[0].attachments[0], firstFile = await f.download(visitor, incoming.id); assert.equal(firstFile.status, 200); assert.deepEqual(firstFile.bytes, png);
  assert.equal(firstFile.headers['x-content-type-options'], 'nosniff'); assert.match(firstFile.headers['cache-control'], /no-store/);
  await f.claim(visitor);
  const uploaded = await f.teamUpload(visitor); assert.equal(uploaded.status, 201, uploaded.data?.error);
  assert.equal((await f.download(visitor, uploaded.data.id)).status, 404, 'Rascunho da equipe ainda não pertence ao histórico público.');
  const value = f.current(visitor), sent = await f.request(`/api/tenants/${visitor.tid}/conversations/${value.id}/messages`, { method: 'POST', cookie: f.operator.cookie,
    body: { version: value.version, channelId: visitor.cid, text: 'Legenda da equipe', attachmentIds: [uploaded.data.id], idempotencyKey: randomUUID() } });
  assert.equal(sent.status, 200, sent.data?.error); assert.equal(sent.data.messages.at(-1).delivery, 'sent');
  const note = await f.request(`/api/tenants/${visitor.tid}/conversations/${value.id}/notes`, { method: 'POST', cookie: f.operator.cookie,
    body: { version: f.current(visitor).version, commandId: randomUUID(), text: 'NOTA_PRIVADA_WEBCHAT_QA' } }); assert.equal(note.status, 200, note.data?.error);
  const history = await f.history(visitor); assert.equal(history.status, 200); assert.deepEqual(history.data.messages.map(item => item.text), ['Legenda do visitante', 'Legenda da equipe']);
  assert.equal(history.text.includes('NOTA_PRIVADA_WEBCHAT_QA'), false); privateDTO(history, [visitor.token]);
  assert.deepEqual((await f.download(visitor, uploaded.data.id)).bytes, png); assert.equal(f.totals().outbox, 1);
  for (const blob of f.app.media.blobs.values()) { assert.notDeepEqual(blob, png); assert.equal(blob.length, png.length + 28); }
  assert.equal(JSON.stringify(f.app.store.db.prepare('SELECT * FROM media_attachments').all()).includes(png.toString('base64')), false);
});

test('HTTP mídia exige token de visitante no corpo/header apropriado, origem e canal exatos; nunca aceita token em URL', async t => {
  const f = await fixture(t), own = await f.openVisitor(), another = await f.openVisitor(), sibling = await f.openVisitor(f.tenant.id, 'web-sibling'), foreign = await f.openVisitor(f.foreign.id, 'web-b');
  assert.equal((await f.receive(own)).status, 200); const file = f.current(own).messages[0].attachments[0], before = f.totals();
  for (const visitor of [another, sibling, foreign]) {
    const denied = await f.download(visitor, file.id); assert.ok([403, 404].includes(denied.status)); assert.notDeepEqual(denied.bytes, png); privateDTO(denied, [own.token]);
  }
  for (const visitor of [{ ...own, cid: 'web-sibling' }, { ...own, tid: f.foreign.id, cid: 'web-b' }]) assert.equal((await f.receive(visitor)).status, 403);
  const path = f.publicPath() + '/media';
  for (const [authorization, expected] of [['', 401], ['Bearer malformed', 401], [`Bearer ${f.operator.cookie.split('=')[1]}`, 403]]) {
    const denied = await f.request(path, { ...f.receiveOptions(own), raw: frame(), headers: { 'Content-Type': 'application/octet-stream', Authorization: authorization } }); assert.equal(denied.status, expected);
  }
  assert.equal((await f.request(path + '?token=' + own.token, { method: 'POST', requestOrigin: visitorOrigin, raw: frame(), headers: { 'Content-Type': 'application/octet-stream' } })).status, 400);
  const originDenied = await f.receive(own, {}, png, { requestOrigin: 'https://unlisted.example.test' }); assert.equal(originDenied.status, 403); assert.equal(originDenied.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.request(f.publicPath() + '/messages', { method: 'POST', requestOrigin: visitorOrigin,
    body: { token: own.token, clientMessageId: randomUUID(), text: 'Texto', attachment: { bytes: [1, 2], mime: 'image/png' } } })).status, 400);
  assert.deepEqual(f.totals(), before);
});

test('HTTP CORS permite POST de mídia com Authorization e recusa origem estrangeira sem abrir sessão', async t => {
  const f = await fixture(t), path = f.publicPath() + '/media';
  const accepted = await f.request(path, { method: 'OPTIONS', requestOrigin: visitorOrigin, headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type, Authorization' } });
  assert.equal(accepted.status, 204); assert.equal(accepted.headers['access-control-allow-origin'], visitorOrigin); assert.equal(accepted.headers.vary, 'Origin');
  assert.match(accepted.headers['access-control-allow-methods'], /POST/); assert.match(accepted.headers['access-control-allow-headers'], /Authorization/i); assert.equal(accepted.headers['access-control-allow-credentials'], undefined);
  const denied = await f.request(path, { method: 'OPTIONS', requestOrigin: 'https://unlisted.example.test' }); assert.equal(denied.status, 403); assert.equal(denied.headers['access-control-allow-origin'], undefined);
  noNewData(f); assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM webchat_sessions').get().n, 0);
});

test('HTTP upload concorrente é limitado; replay pronto e payloads conflitantes conservam uma captura e recibo', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), gate = barrier(), input = { clientMessageId: randomUUID(), text: 'Conteúdo idempotente' };
  f.app.media.authKey = undefined; f.control.keyGate = gate;
  const first = f.receive(visitor, input); await Promise.race([gate.entered.promise, first.then(() => assert.fail('A captura deveria aguardar a chave.'))]);
  const duplicate = await f.receive(visitor, input); assert.equal(duplicate.status, 429);
  const changed = Buffer.from(png); changed[11] = 1; assert.equal((await f.receive(visitor, input, changed)).status, 429);
  assert.equal(f.current(visitor).messages.length, 1); assert.equal(f.totals().media, 1); assert.equal(f.totals().receipts, 1);
  gate.release.resolve(); const a = await first; assert.equal(a.status, 200, a.data?.error); assert.equal(a.data.replayed, false);
  assert.equal(new Set(f.calls.captures).size, 1); assert.equal(f.calls.saves, 1); assert.equal(f.calls.hooks, 1); assert.equal(f.calls.routes, 1);
  const before = f.totals(), replay = await f.receive(visitor, input); assert.equal(replay.status, 200); assert.equal(replay.data.messageId, a.data.messageId); assert.deepEqual(f.totals(), before);
  assert.equal(replay.data.replayed, true);
  for (const result of [await f.receive(visitor, input, changed), await f.receive(visitor, { ...input, text: 'Outra legenda' }), await f.receive(visitor, { ...input, name: 'outro-nome.png' })]) {
    assert.equal(result.status, 409); assert.deepEqual(f.totals(), before);
  }
  assert.equal(f.calls.saves, 1); assert.equal(f.calls.hooks, 1); assert.equal(f.calls.routes, 1); assert.equal(f.current(visitor).messages[0].attachments[0].status, 'ready');
});

test('HTTP quatro uploads em andamento limitam o quinto antes do corpo e liberam os slots ao concluir', async t => {
  const f = await fixture(t), visitors = [];
  for (let i = 0; i < 5; i++) visitors.push(await f.openVisitor());
  const gate = barrier(), allSaving = deferred(); gate.onSave = count => { if (count === 4) allSaving.resolve(); }; f.app.media.authKey = undefined; f.control.keyGate = gate;
  const uploads = visitors.slice(0, 4).map(visitor => f.receive(visitor));
  await Promise.race([allSaving.promise, ...uploads.map(upload => upload.then(() => assert.fail('As quatro capturas deveriam aguardar a chave.')))]);
  const fifth = visitors[4], bytes = frame(), blocked = f.pending(f.publicPath() + '/media', f.receiveOptions(fifth,
    { headers: { Authorization: `Bearer ${fifth.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length } }));
  blocked.req.flushHeaders(); assert.equal((await blocked.promise).status, 429); blocked.req.destroy();
  assert.deepEqual(f.totals(), { conversations: 4, media: 4, blobs: 0, receipts: 4, outbox: 0 });
  gate.release.resolve(); for (const result of await Promise.all(uploads)) assert.equal(result.status, 200, result.data?.error);
  assert.equal((await f.receive(fifth)).status, 200); assert.deepEqual(f.totals(), { conversations: 5, media: 5, blobs: 5, receipts: 5, outbox: 0 });
  assert.equal(f.calls.saves, 5); assert.equal(f.calls.hooks, 5); assert.equal(f.calls.routes, 5);
});

test('HTTP frame valida limites de metadados, legenda e voz antes de receber bytes de arquivo', async t => {
  const f = await fixture(t), visitor = await f.openVisitor();
  for (const [label, overrides] of [['caption', { text: 'a'.repeat(1025) }], ['voice', { voice: true }], ['mime', { mime: 'image/png\r\nInjected: true' }],
    ['fields', { token: visitor.token }], ['id', { clientMessageId: 'short' }]]) await t.test(label, async () => {
    const bytes = frame(overrides), length = bytes.readUInt32BE(0), pending = f.pending(f.publicPath() + '/media', f.receiveOptions(visitor,
      { headers: { Authorization: `Bearer ${visitor.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length } }));
    pending.req.write(bytes.subarray(0, 4 + length)); const denied = await pending.promise;
    assert.equal(denied.status, 400, denied.data?.error); pending.req.destroy(); noNewData(f);
  });
  for (const [length, expected] of [[0, 400], [8193, 413]]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(length); const pending = f.pending(f.publicPath() + '/media', f.receiveOptions(visitor,
      { headers: { Authorization: `Bearer ${visitor.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': 8196 + png.length } }));
    pending.req.write(prefix); assert.equal((await pending.promise).status, expected); pending.req.destroy(); noNewData(f);
  }
  const invalidUTF8 = Buffer.from([0, 0, 0, 1, 255]), invalid = f.pending(f.publicPath() + '/media', f.receiveOptions(visitor,
    { headers: { Authorization: `Bearer ${visitor.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': invalidUTF8.length + png.length } }));
  invalid.req.write(invalidUTF8); assert.equal((await invalid.promise).status, 400); invalid.req.destroy(); noNewData(f);
});

test('HTTP comprimento declarado limita frame e arquivo antes do corpo; assinatura falsa e arquivo vazio não persistem', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), path = f.publicPath() + '/media';
  const entire = f.pending(path, f.receiveOptions(visitor, { headers: { Authorization: `Bearer ${visitor.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': MAX_MEDIA_BYTES + 8197 } }));
  entire.req.flushHeaders(); assert.equal((await entire.promise).status, 413); entire.req.destroy(); noNewData(f);
  const bytes = frame(), headerLength = bytes.readUInt32BE(0), file = f.pending(path, f.receiveOptions(visitor,
    { headers: { Authorization: `Bearer ${visitor.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': MAX_MEDIA_BYTES + 4 + headerLength + 1 } }));
  file.req.write(bytes.subarray(0, 4 + headerLength)); assert.equal((await file.promise).status, 413); file.req.destroy(); noNewData(f);
  assert.equal((await f.receive(visitor, {}, Buffer.from('this-is-not-png'))).status, 400); noNewData(f);
  assert.equal((await f.receive(visitor, {}, Buffer.alloc(0))).status, 400); noNewData(f);
  const accepted = await f.receive(visitor, { text: 'a'.repeat(1024) }); assert.equal(accepted.status, 200, accepted.data?.error); assert.equal(f.current(visitor).messages[0].text.length, 1024);
});

test('HTTP documento ativo fica download octet-stream e nome sanitizado não injeta headers', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), bytes = Buffer.from('<svg onload="alert(1)"></svg>');
  const received = await f.receive(visitor, { name: '../../<arquivo>\r\nX-Injected: yes.svg', mime: 'image/svg+xml' }, bytes); assert.equal(received.status, 200, received.data?.error);
  const history = await f.history(visitor), item = history.data.messages[0].attachments[0];
  assert.equal(item.preview, false); assert.equal(item.kind, 'document'); assert.equal(item.mime, 'application/octet-stream'); assert.equal(/[<>\r\n]/.test(item.name), false);
  const downloaded = await f.download(visitor, item.id); assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, bytes);
  assert.equal(downloaded.headers['content-type'], 'application/octet-stream'); assert.match(downloaded.headers['content-disposition'], /^attachment;/);
  assert.equal(downloaded.headers['x-injected'], undefined); assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
});

test('HTTP revogação durante corpo parcial não cria conversa, recibo ou arquivo', async t => {
  for (const mode of ['disabled', 'revision', 'expired', 'revoked', 'domain']) await t.test(mode, async child => {
    const f = await fixture(child); if (mode === 'domain') await f.bindHost();
    const visitor = await f.openVisitor(undefined, undefined, mode === 'domain' ? { requestHost: customHost } : {}), bytes = frame();
    const path = f.publicPath() + '/media', entered = f.watchRequest(path), pending = f.pending(path, f.receiveOptions(visitor,
      { headers: { Authorization: `Bearer ${visitor.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length } }));
    pending.req.write(bytes.subarray(0, bytes.length - 2));
    await Promise.race([entered.promise, pending.promise.then(() => assert.fail('O frame parcial não deveria encerrar o ingresso.'))]);
    if (mode === 'disabled') assert.equal((await f.configure({ enabled: false })).status, 200);
    if (mode === 'revision') assert.equal((await f.configure({ origins: [visitorOrigin] })).status, 200);
    if (mode === 'expired') f.control.now += 60000;
    if (mode === 'revoked') f.app.store.db.prepare('DELETE FROM webchat_sessions WHERE token_hash=?').run(digest(visitor.token));
    if (mode === 'domain') f.revokeHost();
    pending.req.end(bytes.subarray(bytes.length - 2)); const denied = await pending.promise; assert.equal(denied.status, 403, denied.data?.error);
    noNewData(f); assert.equal(f.calls.saves, 0); assert.equal(f.calls.hooks, 0); assert.equal(f.calls.routes, 0);
  });
});

test('HTTP voz normalizada usa bytes privados e revogação durante normalizer antecede ingresso', async t => {
  const source = Buffer.from([26, 69, 223, 163, 1, 2, 3, 4]);
  const f = await fixture(t), visitor = await f.openVisitor();
  const accepted = await f.receive(visitor, { mime: 'audio/webm', name: 'gravacao.webm', voice: true }, source); assert.equal(accepted.status, 200, accepted.data?.error);
  const item = (await f.history(visitor)).data.messages[0].attachments[0]; assert.equal(item.kind, 'audio'); assert.equal(item.mime, 'audio/ogg'); assert.deepEqual((await f.download(visitor, item.id)).bytes, ogg);
  assert.equal(f.calls.normalizer.length, 1); assert.equal(f.calls.normalizer[0].hash, digest(source));
  const revoked = await fixture(t), otherVisitor = await revoked.openVisitor(), gate = barrier(); revoked.control.voiceGate = gate;
  const pending = revoked.receive(otherVisitor, { mime: 'audio/webm', name: 'gravacao.webm', voice: true }, source);
  await Promise.race([gate.entered.promise, pending.then(() => assert.fail('O normalizer deveria aguardar.'))]);
  assert.equal((await revoked.configure({ enabled: false })).status, 200); gate.release.resolve(); assert.equal((await pending).status, 403);
  noNewData(revoked); assert.equal(revoked.calls.normalizer.length, 1); assert.equal(revoked.calls.saves, 0);
});

test('HTTP replay de voz usa frame original apesar de normalizador produzir outro codec, nome ou bytes', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), source = Buffer.from([26, 69, 223, 163, 1, 2, 3, 4]);
  const input = { clientMessageId: randomUUID(), mime: 'audio/webm', name: 'original.webm', voice: true };
  const first = await f.receive(visitor, input, source); assert.equal(first.status, 200, first.data?.error);
  const before = f.totals(), id = f.current(visitor).messages[0].attachments[0].id;
  f.control.voiceBytes = Buffer.from('RIFF0000WAVE-new-normalized-bytes'); f.control.voiceMime = 'audio/wav'; f.control.voiceName = 'normalizacao-repetida.wav';
  const replay = await f.receive(visitor, input, source); assert.equal(replay.status, 200, replay.data?.error); assert.equal(replay.data.replayed, true); assert.equal(replay.data.messageId, first.data.messageId);
  assert.deepEqual(f.totals(), before); assert.equal(f.calls.normalizer.length, 2); assert.equal(f.calls.saves, 1); assert.equal(f.calls.hooks, 1); assert.equal(f.calls.routes, 1);
  assert.deepEqual((await f.download(visitor, id)).bytes, ogg);
  const changed = Buffer.from(source); changed[7] = 5; assert.equal((await f.receive(visitor, input, changed)).status, 409); assert.deepEqual(f.totals(), before);
});

test('HTTP revogação durante chave da captura conserva recibo vinculado indisponível e nenhum blob', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), gate = barrier(); f.app.media.authKey = undefined; f.control.keyGate = gate;
  const pending = f.receive(visitor); await Promise.race([gate.entered.promise, pending.then(() => assert.fail('A captura deveria aguardar a chave.'))]);
  assert.equal((await f.configure({ enabled: false })).status, 200); gate.release.resolve(); assert.equal((await pending).status, 403);
  const value = f.current(visitor), rows = f.app.store.db.prepare('SELECT * FROM media_attachments').all();
  assert.equal(value.messages.length, 1); assert.equal(rows.length, 1); assert.equal(f.totals().receipts, 1); assert.equal(f.totals().blobs, 0); assert.equal(f.totals().outbox, 0);
  assert.equal(JSON.parse(rows[0].metadata).status, 'unavailable'); assert.equal(value.messages[0].attachments[0].id, rows[0].id); assert.equal(value.messages[0].attachments[0].status, 'unavailable');
});

test('HTTP download revalida sessão/domínio após chave e preserva blobs existentes na recusa', async t => {
  for (const mode of ['channel', 'domain']) await t.test(mode, async child => {
    const f = await fixture(child); if (mode === 'domain') await f.bindHost();
    const visitor = await f.openVisitor(undefined, undefined, mode === 'domain' ? { requestHost: customHost } : {}); assert.equal((await f.receive(visitor)).status, 200);
    const id = f.current(visitor).messages[0].attachments[0].id, before = f.totals(), gate = barrier(); f.app.media.authKey = undefined; f.control.keyGate = gate;
    const pending = f.download(visitor, id); await Promise.race([gate.entered.promise, pending.then(() => assert.fail('O download deveria aguardar a chave.'))]);
    if (mode === 'channel') assert.equal((await f.configure({ enabled: false })).status, 200); else f.revokeHost();
    gate.release.resolve(); const denied = await pending; assert.equal(denied.status, 403, denied.data?.error); assert.notDeepEqual(denied.bytes, png); assert.deepEqual(f.totals(), before);
  });
});

test('HTTP quatro downloads aguardando chave recusam o quinto e liberam os slots após a leitura', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(); assert.equal((await f.receive(visitor)).status, 200);
  const id = f.current(visitor).messages[0].attachments[0].id, before = f.totals(), gate = barrier(), allKeys = deferred();
  gate.onKey = count => { if (count === 4) allKeys.resolve(); }; f.app.media.authKey = undefined; f.control.keyGate = gate;
  const downloads = Array.from({ length: 4 }, () => f.download(visitor, id));
  await Promise.race([allKeys.promise, ...downloads.map(download => download.then(() => assert.fail('As quatro leituras deveriam aguardar a chave.')))]);
  const blocked = await f.download(visitor, id); assert.equal(blocked.status, 429); assert.equal(f.calls.keys, 4); assert.deepEqual(f.totals(), before);
  gate.release.resolve(); for (const result of await Promise.all(downloads)) { assert.equal(result.status, 200); assert.deepEqual(result.bytes, png); }
  const next = await f.download(visitor, id); assert.equal(next.status, 200); assert.deepEqual(next.bytes, png); assert.deepEqual(f.totals(), before);
});

test('HTTP cliente abortado conserva slot enquanto chave pendente e libera somente após encerrar a leitura', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(); assert.equal((await f.receive(visitor)).status, 200);
  const id = f.current(visitor).messages[0].attachments[0].id, path = f.publicPath() + '/media/' + id, before = f.totals();
  const gate = barrier(), allKeys = deferred(), allClosed = deferred(); let closed = 0;
  gate.onKey = count => { if (count === 4) allKeys.resolve(); }; f.app.media.authKey = undefined; f.control.keyGate = gate;
  const onRequest = (req, res) => { if (req.url === path) res.once('close', () => { if (++closed === 4) allClosed.resolve(); }); };
  f.app.server.on('request', onRequest); t.after(() => f.app.server.off('request', onRequest));
  const downloads = Array.from({ length: 4 }, () => f.pending(path, { method: 'POST', requestOrigin: visitorOrigin, body: { token: visitor.token } }));
  for (const item of downloads) item.end();
  await Promise.race([allKeys.promise, ...downloads.map(item => item.promise.then(() => assert.fail('As quatro leituras deveriam aguardar a chave.')))]);
  const rejected = downloads.map(item => assert.rejects(item.promise));
  for (const item of downloads) item.req.destroy(new Error('Aborto sintético do download'));
  await Promise.all(rejected); await allClosed.promise; f.app.server.off('request', onRequest);
  const blocked = await f.download(visitor, id); assert.equal(blocked.status, 429); assert.equal(f.calls.keys, 4); assert.deepEqual(f.totals(), before);
  gate.release.resolve(); await new Promise(resolve => setImmediate(resolve));
  const next = await f.download(visitor, id); assert.equal(next.status, 200); assert.deepEqual(next.bytes, png); assert.deepEqual(f.totals(), before);
});

test('HTTP domínio da revenda limita ingresso/download ao workspace vinculado, mesmo com sessão visitante válida', async t => {
  const f = await fixture(t); await f.bindHost(); const own = await f.openVisitor(undefined, undefined, { requestHost: customHost }), foreign = await f.openVisitor(f.foreign.id, 'web-b');
  assert.equal((await f.receive(own)).status, 200); assert.equal((await f.receive(foreign)).status, 200);
  const ownFile = f.current(own).messages[0].attachments[0].id, foreignFile = f.current(foreign).messages[0].attachments[0].id, before = f.totals();
  const deniedReceive = await f.receive({ ...foreign, requestHost: customHost }); assert.equal(deniedReceive.status, 403); assert.equal(deniedReceive.headers['access-control-allow-origin'], undefined);
  const deniedDownload = await f.download({ ...foreign, requestHost: customHost }, foreignFile); assert.equal(deniedDownload.status, 403); assert.equal(deniedDownload.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.download(own, ownFile)).status, 200); assert.deepEqual(f.totals(), before);
});

test('HTTP arquivo privado em nota/rascunho ou ID de outra sessão não passa pelo download público', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), another = await f.openVisitor();
  assert.equal((await f.receive(visitor)).status, 200); assert.equal((await f.receive(another)).status, 200); await f.claim(visitor);
  const upload = await f.teamUpload(visitor); assert.equal(upload.status, 201); const value = f.current(visitor), privateId = upload.data.id, foreignId = f.current(another).messages[0].attachments[0].id;
  f.app.store.mutate(f.owner.actor, f.tenant.id, 'Fixture: vínculo privado', state => {
    const conversation = state.conversations.find(item => item.id === value.id);
    conversation.messages.push({ id: randomUUID(), kind: 'note', text: 'PRIVATE_MEDIA_NOTE_QA', attachments: [upload.data] },
      { id: randomUUID(), kind: 'human', text: 'PRIVATE_UNCONFIRMED_QA', delivery: 'unconfirmed', attachments: [upload.data] });
  });
  assert.equal((await f.download(visitor, privateId)).status, 404); assert.equal((await f.download(visitor, foreignId)).status, 404);
  const history = await f.history(visitor); assert.equal(history.data.messages.length, 1); assert.equal(history.text.includes('PRIVATE_MEDIA_NOTE_QA'), false); assert.equal(history.text.includes(privateId), false); assert.equal(history.text.includes(foreignId), false);
  f.app.store.mutate(f.owner.actor, f.tenant.id, 'Fixture: ID cruzado não pode ler blob', state => {
    state.conversations.find(item => item.id === value.id).messages.push({ id: randomUUID(), kind: 'customer', text: 'Referência inválida', attachments: [{ id: foreignId }] });
  });
  const denied = await f.download(visitor, foreignId); assert.equal(denied.status, 404); assert.notDeepEqual(denied.bytes, png);
});

test('HTTP limite de mensagens mantém captura bounded e replay válido não cria novo arquivo', async t => {
  const f = await fixture(t), visitor = await f.openVisitor(), input = { clientMessageId: randomUUID() };
  assert.equal((await f.receive(visitor, input)).status, 200);
  for (let i = 1; i < 20; i++) assert.equal((await f.receive(visitor)).status, 200);
  const before = f.totals(); assert.equal((await f.receive(visitor)).status, 429); assert.deepEqual(f.totals(), before);
  const replay = await f.receive(visitor, input); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.deepEqual(f.totals(), before);
  assert.equal(f.calls.saves, 20); assert.equal(f.calls.hooks, 20); assert.equal(f.calls.routes, 20); assert.equal(f.totals().outbox, 0);
});

test('HTTP limite de polling é por visitante autenticado: esgotar A não bloqueia B no mesmo IP/canal', async t => {
  const f = await fixture(t), a = await f.openVisitor(), b = await f.openVisitor();
  for (let i = 0; i < 120; i++) { const result = await f.history(a); assert.equal(result.status, 200, `Polling A ${i}: ${result.data?.error}`); }
  assert.equal((await f.history(a)).status, 429); assert.equal((await f.history(b)).status, 200);
  noNewData(f); assert.equal(f.calls.hooks, 0); assert.equal(f.calls.routes, 0); assert.equal(f.calls.saves, 0);
});
