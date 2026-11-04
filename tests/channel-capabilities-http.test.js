import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const origin = 'https://capabilities-fixture.example.test';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const appSecret = 'synthetic-http-capabilities-app-secret';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { delayedMediaKey = false, metaSender = false } = {}) {
  const key = randomBytes(32), calls = { external: [], telegram: [], meta: [], upload: 0 }, gates = [];
  let clock = Date.now(), sequence = 0;
  const deny = async () => { calls.external.push(true); throw new Error('Rede externa proibida neste ensaio em RAM.'); };
  const keyGate = { entered: deferred(), release: deferred() }; gates.push(keyGate);
  const app = createApp({ databasePath: ':memory:', publicOrigin: origin, allowRegistration: false, serviceKey: key,
    providerCall: deny, mcpFetchImpl: deny, googleOptions: { clientId: '' },
    gatewayOptions: { authKey: key, socketFactory: deny, downloadMediaImpl: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: async (url, input) => {
      const method = new URL(url).pathname.split('/').at(-1), payload = input.body instanceof FormData ? Object.fromEntries(input.body) : JSON.parse(input.body);
      calls.telegram.push({ method, payload });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.telegram.length, chat: { id: Number(payload.chat_id) } } }) };
    } },
    metaOptions: { now: () => clock, fetchImpl: metaSender ? async (url, options) => {
      const target=new URL(url);assert.equal(target.hostname,'graph.facebook.com');assert.equal(target.search,'');assert.equal(options.redirect,'error');
      if(target.pathname.endsWith('/message_attachments')){assert.ok(options.body instanceof FormData);const payload=JSON.parse(options.body.get('message'));const bytes=Buffer.from(await options.body.get('filedata').arrayBuffer());calls.meta.push({method:'upload',payload,bytes});return new Response(JSON.stringify({attachment_id:'345678901234567'}),{status:200,headers:{'Content-Type':'application/json'}});}
      assert.ok(target.pathname.endsWith('/messages'));const payload=JSON.parse(options.body);calls.meta.push({method:'send',payload});return new Response(JSON.stringify({message_id:'m_meta_http_1',recipient_id:'987654321001'}),{status:200,headers:{'Content-Type':'application/json'}});
    } : deny, mediaDownloader: deny },
    scheduledOptions: { now: () => clock },
    mediaOptions: { directory: null, authKey: delayedMediaKey ? undefined : key, keyLoader: async () => { keyGate.entered.resolve(); await keyGate.release.promise; return key; } },
    emailOptions: { key, apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }
  });
  const upload = app.media.upload.bind(app.media); app.media.upload = (...args) => { calls.upload++; return upload(...args); };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    await app.scheduled.waitIdle(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.bridge.close()]);
    app.store.close(); assert.deepEqual(calls.external, [], 'Nenhum provedor, download ou transporte externo foi acionado.');
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const pending = (path, { method = 'GET', cookie = '', body, raw, headers = {}, requestOrigin = origin } = {}) => {
    const bytes = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    let req;
    const promise = new Promise((resolve, reject) => {
      req = httpRequest(base + path, { method, headers: { Host: new URL(origin).hostname, Origin: requestOrigin, Cookie: cookie,
        'Content-Type': 'application/json', ...(bytes ? { 'Content-Length': bytes.length } : {}), ...headers } }, response => {
        const chunks = []; response.on('error', reject); response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), headers: response.headers }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(3000, () => req.destroy(new Error('A rota aguardou bytes que deveriam ter sido recusados.')));
      req.on('error', reject);
    });
    return { req, promise, end: () => req.end(bytes) };
  };
  const request = (path, options) => { const value = pending(path, options); value.end(); return value.promise; };
  const member = (role, tenantIds = [], workspace = 'mep-demo', platformAdmin = false) => {
    const name = 'Pessoa sintética HTTP ' + ++sequence;
    const row = app.auth.insertUser({ username: 'capabilities.http.' + sequence, name }, randomBytes(16), randomBytes(64), role, tenantIds, workspace, { platformAdmin });
    const session = app.auth.session(row); return { id: row.id, actor: session.actor, cookie: 'mep_session=' + session.token };
  };
  const admin = member('reseller', [], 'mep-demo', true), tenant = app.store.createTenant(admin.actor, { name: 'Capacidades A em RAM', segment: 'QA' });
  app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('capabilities-other', JSON.stringify({ name: 'Workspace B sintético', brand: { name: 'QA B' } }));
  const other = member('reseller', [], 'capabilities-other'), foreign = app.store.createTenant(other.actor, { name: 'Capacidades B em RAM', segment: 'QA' });
  const operator = member('operator', [tenant.id]);
  const setup = (actor, id, tg) => app.store.mutate(actor, id, 'Fixture: diretório sintético de grupos', state => {
    state.channels = [{ id: tg, name: 'Bot QA', kind: 'telegram', transport: 'telegram-bot', state: 'connected',
      telegramGroups: { version: 1, mode: 'selected', groupIds: ['-11'], known: [
        { id: '-11', name: 'Diretório reservado A', type: 'group', joined: true, canSend: true, memberStatus: 'member', aliases: ['-111'] },
        { id: '-12', name: 'Diretório reservado B', type: 'supergroup', joined: true, canSend: true, memberStatus: 'member', aliases: [] }
      ] } }];
    state.conversations = []; state.departments = [];
  });
  setup(admin.actor, tenant.id, 'tg-a'); setup(other.actor, foreign.id, 'tg-b');
  app.store.mutate(admin.actor, tenant.id, 'Fixture: canais adicionais', state => state.channels.push(
    { id: 'wa-a', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' },
    ...['instagram', 'messenger'].map(kind => ({ id: kind + '-a', kind, transport: 'meta-' + kind, state: 'disconnected' }))
  ));
  app.telegram.entries.set('tg-a', { tenantId: tenant.id, channelId: 'tg-a', actor: { role: 'reseller', resellerId: 'mep-demo', name: 'Gateway QA' },
    state: 'connected', token: '123456789:' + 'a'.repeat(35), abort: new AbortController(), stopped: false });
  const path = `/api/tenants/${tenant.id}`, groupsPath = path + '/channels/tg-a/telegram/groups';
  const state = () => app.store.tenant(admin.actor, tenant.id);
  const current = cid => state().conversations.find(item => item.id === cid);
  const conversation = (chatId = '80', channelId = 'tg-a') => app.store.mutate(admin.actor, tenant.id, 'Fixture: atendimento sintético', data => {
    const value = { id: 'capabilities-conversation-' + ++sequence, channelId, contact: 'Contato sintético', status: 'open', owner: 'human',
      assignedUserId: operator.id, assignedUserName: operator.actor.name, departmentId: 'unassigned', version: 1, remoteChatId: chatId,
      conversationKind: chatId.startsWith('-') ? 'group' : 'direct', messages: [], tags: [] };
    data.conversations.push(value); return value;
  });
  const attachmentPath = value => `${path}/conversations/${value.id}/attachments`;
  const attachmentHeaders = (value, extra = {}) => ({ 'Content-Type': 'image/png', 'X-Elozi-Filename': 'sintetico.png', 'X-Elozi-Conversation-Version': current(value.id).version, ...extra });
  const attach = (value, options = {}) => request(attachmentPath(value), { method: 'POST', cookie: operator.cookie, raw: png, headers: attachmentHeaders(value), ...options });
  const schedule = (value, extra = {}) => request(`${path}/conversations/${value.id}/scheduled`, { method: 'POST', cookie: operator.cookie,
    body: { version: current(value.id).version, text: 'Texto sintético agendado', dueAt: new Date(clock + 60000).toISOString(), commandId: randomUUID(), ...extra } });
  const choose = (groupIds, version = state().channels[0].telegramGroups.version, extra = {}) => request(groupsPath, { method: 'POST', cookie: admin.cookie, body: { version, mode: 'selected', groupIds }, ...extra });
  const totals = () => ({ media: app.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, blobs: app.media.blobs.size,
    outbox: app.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n });
  const metaConversation = async kind => {
    const channelId = kind + '-a', resourceId = kind === 'instagram' ? '123456789001' : '123456789002', senderId = '987654321001';
    const configured = await request(`${path}/channels/${channelId}/configuration`, { method: 'POST', cookie: admin.cookie,
      body: { version: 0, enabled: true, resourceId, apiVersion: 'v23.0', accessToken: 'synthetic-capabilities-meta-token', appSecret, verifyToken: 'synthetic-capabilities-meta-verify' } });
    assert.equal(configured.status, 200, configured.data.error);
    const raw = Buffer.from(JSON.stringify({ object: kind === 'instagram' ? 'instagram' : 'page', entry: [{ id: resourceId,
      messaging: [{ sender: { id: senderId }, recipient: { id: resourceId }, timestamp: clock, message: { mid: 'capabilities-meta-' + kind, text: 'Entrada sintética assinada' } }] }] }));
    const incoming = await request(`/api/webhooks/meta/${tenant.id}/${channelId}`, { method: 'POST', raw,
      headers: { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') } });
    assert.equal(incoming.status, 200, incoming.data.error);
    const value = state().conversations.find(item => item.channelId === channelId);
    const taken = await request(`${path}/conversations/${value.id}/owner`, { method: 'POST', cookie: operator.cookie, body: { version: value.version, owner: 'human' } });
    assert.equal(taken.status, 200, taken.data.error); return taken.data;
  };
  assert.equal((await request('/api/auth/me', { cookie: admin.cookie })).status, 200);
  const restrict = permissions => app.store.mutate(admin.actor, tenant.id, 'Fixture: permissões por método', data => {const group=data.channels.find(c=>c.id==='tg-a').telegramGroups.known.find(g=>g.id==='-11');Object.assign(group,{memberStatus:'restricted',joined:true,sendPermissions:permissions});});
  return { app, calls, admin, operator, other, tenant, foreign, path, groupsPath, request, pending, state, current, conversation,
    attachmentPath, attachmentHeaders, attach, schedule, choose, totals, metaConversation, keyGate, restrict, advance: ms => { clock += ms; }, time: () => clock };
}

test('HTTP Telegram permite foto e legenda sem texto, sem criar outbox para texto/agendamento proibidos', async t => {
  const f=await fixture(t), group=f.conversation('-11'), direct=f.conversation();
  f.restrict({text:false,photos:true,audios:false,documents:false,videos:false,voiceNotes:false});
  const loaded=await f.request(f.path,{cookie:f.operator.cookie});assert.equal(loaded.status,200);
  const dto=loaded.data.conversations.find(c=>c.id===group.id);assert.equal(dto.channelAvailability.group.canSend,true);assert.equal(dto.channelAvailability.group.sendPermissions.text,false);assert.equal(dto.remoteChatId,undefined);
  const post=(value,body)=>f.request(`${f.path}/conversations/${value.id}/messages`,{method:'POST',cookie:f.operator.cookie,body:{channelId:value.channelId,version:f.current(value.id).version,idempotencyKey:randomUUID(),...body}});
  const before=JSON.stringify(f.current(group.id));assert.equal((await post(group,{text:'Texto proibido'})).status,409);assert.equal((await f.schedule(group)).status,409);
  assert.equal(JSON.stringify(f.current(group.id)),before);assert.deepEqual(f.totals(),{media:0,blobs:0,outbox:0});
  const uploaded=await f.attach(group);assert.equal(uploaded.status,201,uploaded.data.error);
  const sent=await post(group,{text:'Legenda da foto',attachmentIds:[uploaded.data.id]});assert.equal(sent.status,200,sent.data.error);
  assert.equal(f.calls.telegram[0].method,'sendPhoto');assert.equal(f.calls.telegram[0].payload.caption,'Legenda da foto');assert.equal(f.current(group.id).messages.length,1);
  assert.equal((await post(direct,{text:'Mensagem direta permitida'})).status,200);assert.deepEqual(f.totals(),{media:1,blobs:1,outbox:2});
});

test('HTTP revogação só de fotos durante upload preserva texto e impede criar mídia', async t => {
  const f=await fixture(t), group=f.conversation('-11'), entered=deferred();
  f.restrict({text:true,photos:true,audios:false,documents:false,videos:false,voiceNotes:false});
  const onRequest=req=>{if(req.url===f.attachmentPath(group))entered.resolve();};f.app.server.on('request',onRequest);t.after(()=>f.app.server.off('request',onRequest));
  const pending=f.pending(f.attachmentPath(group),{method:'POST',cookie:f.operator.cookie,headers:f.attachmentHeaders(group,{'Content-Length':png.length})});t.after(()=>pending.req.destroy());pending.req.write(png.subarray(0,4));
  await Promise.race([entered.promise,pending.promise.then(()=>assert.fail('Upload respondeu antes do corpo parcial.'))]);
  f.restrict({text:true,photos:false,audios:false,documents:false,videos:false,voiceNotes:false});pending.req.end(png.subarray(4));
  const denied=await pending.promise;assert.equal(denied.status,409,denied.data.error);assert.equal(f.calls.upload,0);assert.deepEqual(f.totals(),{media:0,blobs:0,outbox:0});
  const loaded=await f.request(f.path,{cookie:f.operator.cookie});assert.equal(loaded.data.conversations.find(c=>c.id===group.id).channelAvailability.group.canSend,true);
});

test('HTTP agendamento Telegram revalida restrição textual mesmo quando fotos continuam permitidas', async t => {
  const f=await fixture(t), group=f.conversation('-11'), direct=f.conversation();
  assert.equal((await f.schedule(group)).status,200);assert.equal((await f.schedule(direct)).status,200);
  f.restrict({text:false,photos:true,audios:false,documents:false,videos:false,voiceNotes:false});f.advance(60000);
  const result=await f.app.scheduled.tick();assert.equal(result.blocked,1);assert.equal(result.sent,1);
  assert.equal(f.current(group.id).scheduledMessages[0].reasonCode,'channel_policy_changed');assert.equal(f.current(direct.id).scheduledMessages[0].state,'sent');
  assert.deepEqual(f.calls.telegram.map(c=>[c.method,c.payload.chat_id]),[['sendMessage','80']]);assert.equal(f.totals().outbox,1);
});

test('HTTP Telegram usa documento para foto grande, inclusive em upload sem tamanho declarado', async t => {
  const f=await fixture(t), group=f.conversation('-11');
  f.restrict({text:false,photos:false,audios:false,documents:true,videos:false,voiceNotes:false});
  const bytes=Buffer.alloc(10_000_001);png.copy(bytes);t.after(()=>bytes.fill(0));
  const known=await f.attach(group,{raw:bytes});assert.equal(known.status,201,known.data.error);
  const pending=f.pending(f.attachmentPath(group),{method:'POST',cookie:f.operator.cookie,headers:f.attachmentHeaders(group,{'Transfer-Encoding':'chunked'})});t.after(()=>pending.req.destroy());
  pending.req.write(bytes.subarray(0,16));pending.req.end(bytes.subarray(16));
  const unknown=await pending.promise;assert.equal(unknown.status,201,unknown.data.error);
  for(const upload of [known,unknown]){
    const sent=await f.request(`${f.path}/conversations/${group.id}/messages`,{method:'POST',cookie:f.operator.cookie,body:{channelId:group.channelId,version:f.current(group.id).version,text:'',attachmentIds:[upload.data.id],idempotencyKey:randomUUID()}});
    assert.equal(sent.status,200,sent.data.error);
  }
  assert.deepEqual(f.calls.telegram.map(c=>c.method),['sendDocument','sendDocument']);assert.deepEqual(f.totals(),{media:2,blobs:2,outbox:2});
});

test('HTTP Messenger envia upload privado por attachment_id e replay não repete as duas etapas', async t => {
  const f=await fixture(t,{metaSender:true}),value=await f.metaConversation('messenger'),other=f.conversation();
  const uploaded=await f.attach(value);assert.equal(uploaded.status,201,uploaded.data.error);
  const denied=await f.request(`${f.path}/conversations/${other.id}/messages`,{method:'POST',cookie:f.operator.cookie,body:{channelId:other.channelId,version:f.current(other.id).version,text:'',attachmentIds:[uploaded.data.id],idempotencyKey:randomUUID()}});
  assert.equal(denied.status,404);assert.deepEqual(f.calls.meta,[]);assert.equal(f.totals().outbox,0);
  const body={channelId:value.channelId,version:f.current(value.id).version,text:'',attachmentIds:[uploaded.data.id],idempotencyKey:randomUUID()};
  const send=()=>f.request(`${f.path}/conversations/${value.id}/messages`,{method:'POST',cookie:f.operator.cookie,body});
  const sent=await send();assert.equal(sent.status,200,sent.data.error);assert.deepEqual(f.calls.meta.map(c=>c.method),['upload','send']);assert.deepEqual(f.calls.meta[0].bytes,png);
  const payload=f.calls.meta[1].payload;assert.equal(payload.recipient.id,'987654321001');assert.equal(payload.messaging_type,'RESPONSE');assert.equal(payload.message.attachment.type,'image');assert.equal(payload.message.attachment.payload.attachment_id,'345678901234567');assert.equal(payload.message.attachment.payload.url,undefined);
  assert.equal((await send()).status,200);assert.equal(f.calls.meta.length,2);assert.equal(f.totals().outbox,1);assert.equal(f.current(value.id).messages.filter(m=>m.kind==='human').length,1);
  assert.equal(f.app.store.db.prepare('SELECT state FROM outbound_commands').get().state,'confirmed');
});

test('HTTP operador recebe capacidades e disponibilidade sem diretório nem IDs privados de grupos', async t => {
  const f = await fixture(t), allowed = f.conversation('-11'), excluded = f.conversation('-12'), direct = f.conversation();
  const meta = await f.metaConversation('messenger');
  const result = await f.request('/api/bootstrap', { cookie: f.operator.cookie }); assert.equal(result.status, 200, result.data.error);
  assert.deepEqual(result.data.tenants.map(item => item.id), [f.tenant.id]);
  const loaded = await f.request(f.path, { cookie: f.operator.cookie }); assert.equal(loaded.status, 200, loaded.data.error);
  const tenant = loaded.data, tg = tenant.channels.find(item => item.id === 'tg-a');
  assert.equal(tg.telegramGroups, undefined); assert.equal(tg.groupSelectionMode, 'selected'); assert.equal(tg.selectedGroups, 1);
  for (const privateValue of ['Diretório reservado A', 'Diretório reservado B', '"-11"', '"-12"', '"-111"']) {
    assert.equal(JSON.stringify(result.data).includes(privateValue), false, privateValue);
    assert.equal(JSON.stringify(tenant).includes(privateValue), false, privateValue);
  }
  for (const id of ['wa-a', 'tg-a']) { const caps = tenant.channels.find(item => item.id === id).capabilities; assert.deepEqual(caps.uploadKinds, ['image', 'audio', 'video', 'document']); assert.equal(caps.voice, true); }
  for (const id of ['instagram-a', 'messenger-a']) { const caps = tenant.channels.find(item => item.id === id).capabilities; assert.deepEqual(caps.uploadKinds, id==='messenger-a'?['image','audio','video','document']:[]); assert.equal(caps.voice, false); assert.equal(caps.maxTextLength, 1000); assert.equal(caps.maxTextBytes, 4000); }
  for (const [value, canSend] of [[allowed, true], [excluded, false]]) {
    const dto = tenant.conversations.find(item => item.id === value.id); assert.equal(dto.channelAvailability.group.canSend, canSend); assert.equal(dto.remoteChatId, undefined);
  }
  const directDTO = tenant.conversations.find(item => item.id === direct.id); assert.equal(directDTO.channelAvailability?.group, undefined); assert.equal(directDTO.remoteChatId, undefined);
  const availability = tenant.conversations.find(item => item.id === meta.id).channelAvailability.replyWindow;
  assert.equal(availability.open, true); assert.equal(availability.expiresAt, new Date(f.time() + 24 * 3600000).toISOString());
  const configuration = await f.request(f.path + '/channels/messenger-a/configuration', { cookie: f.admin.cookie });
  assert.equal(configuration.status, 200); assert.equal(configuration.data.inboundMediaSupported, true); assert.equal(configuration.data.mediaSupported, true); assert.deepEqual(configuration.data.capabilities.uploadKinds, ['image','audio','video','document']);
});

test('HTTP diretório/seleção de grupos exige administração fresca, empresa e CAS; origem estrangeira é recusada', async t => {
  const f = await fixture(t), read = await f.request(f.groupsPath, { cookie: f.admin.cookie });
  assert.equal(read.status, 200); assert.deepEqual(read.data.groups.map(item => item.id), ['-11', '-12']);
  const before = JSON.stringify(f.state().channels[0].telegramGroups);
  for (const options of [{ cookie: f.operator.cookie }, { cookie: f.other.cookie }, { cookie: '' }]) {
    const denied = await f.request(f.groupsPath, options); assert.ok([401, 403, 404].includes(denied.status)); assert.equal(denied.data.groups, undefined); assert.equal(denied.data.groupIds, undefined);
  }
  for (const extra of [{ cookie: f.operator.cookie }, { cookie: f.other.cookie }, { requestOrigin: 'https://foreign.example.test' }]) {
    const denied = await f.choose([], 1, extra); assert.ok([403, 404].includes(denied.status)); assert.equal(JSON.stringify(f.state().channels[0].telegramGroups), before);
  }
  assert.equal((await f.choose(['-99'])).status, 400); assert.equal(JSON.stringify(f.state().channels[0].telegramGroups), before);
  const accepted = await f.choose(['-12']); assert.equal(accepted.status, 200); assert.equal(accepted.data.version, 2); assert.deepEqual(accepted.data.groupIds, ['-12']);
  assert.equal((await f.choose(['-11'], 1)).status, 409); assert.deepEqual(f.state().channels[0].telegramGroups.groupIds, ['-12']);
  const foreign = await f.request(`/api/tenants/${f.foreign.id}/channels/tg-b/telegram/groups`, { cookie: f.admin.cookie });
  assert.equal(foreign.status, 404); assert.equal(foreign.data.groups, undefined);
  f.app.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), f.admin.id);
  assert.equal((await f.choose([], 2)).status, 401); assert.deepEqual(f.state().channels[0].telegramGroups.groupIds, ['-12']);
});

test('HTTP grupo excluído recusa upload antes do corpo e agendamento sem reservar mídia; chat direto continua', async t => {
  const f = await fixture(t), excluded = f.conversation('-12'), direct = f.conversation();
  const pending = f.pending(f.attachmentPath(excluded), { method: 'POST', cookie: f.operator.cookie, headers: f.attachmentHeaders(excluded, { 'Content-Length': png.length }) });
  t.after(() => pending.req.destroy()); pending.req.flushHeaders();
  const denied = await pending.promise; assert.equal(denied.status, 409, denied.data.error); pending.req.destroy();
  const scheduled = await f.schedule(excluded); assert.equal(scheduled.status, 409, scheduled.data.error);
  assert.equal(f.current(excluded.id).scheduledMessages, undefined); assert.equal(f.calls.upload, 0); assert.deepEqual(f.totals(), { media: 0, blobs: 0, outbox: 0 });
  const uploaded = await f.attach(direct); assert.equal(uploaded.status, 201, uploaded.data.error); assert.equal(uploaded.data.status, 'ready');
  assert.equal((await f.schedule(direct)).status, 200); assert.equal(f.calls.upload, 1); assert.deepEqual(f.calls.telegram, []); assert.equal(f.totals().outbox, 0);
});

test('HTTP seleção revogada após agendar bloqueia claim sem outbox e mantém envio direto funcional', async t => {
  const f = await fixture(t), group = f.conversation('-11'), direct = f.conversation();
  assert.equal((await f.schedule(group)).status, 200); assert.equal((await f.schedule(direct)).status, 200);
  assert.equal((await f.choose([])).status, 200); f.advance(60000);
  const result = await f.app.scheduled.tick(); assert.equal(result.blocked, 1); assert.equal(result.sent, 1);
  const blocked = f.current(group.id).scheduledMessages[0]; assert.equal(blocked.state, 'blocked'); assert.equal(blocked.reasonCode, 'channel_policy_changed');
  assert.equal(f.current(direct.id).scheduledMessages[0].state, 'sent'); assert.deepEqual(f.calls.telegram.map(call => [call.method, call.payload.chat_id]), [['sendMessage', '80']]);
  assert.deepEqual(f.totals(), { media: 0, blobs: 0, outbox: 1 });
  const commands = f.app.store.db.prepare('SELECT conversation_id FROM outbound_commands').all(); assert.deepEqual(commands.map(item => item.conversation_id), [direct.id]);
});

test('HTTP Instagram e formato Messenger indisponíveis são recusados antes do corpo sem ocupar upload', async t => {
  const f = await fixture(t), direct = f.conversation();
  for (const kind of ['instagram', 'messenger']) {
    const value = await f.metaConversation(kind), pending = f.pending(f.attachmentPath(value), { method: 'POST', cookie: f.operator.cookie,
      headers: f.attachmentHeaders(value, { 'Content-Length': png.length, 'Content-Type':kind==='messenger'?'audio/ogg':'image/png' }) });
    t.after(() => pending.req.destroy()); pending.req.flushHeaders();
    const denied = await pending.promise; assert.equal(denied.status, 400, denied.data.error); pending.req.destroy();
    assert.equal(f.calls.upload, 0); assert.deepEqual(f.totals(), { media: 0, blobs: 0, outbox: 0 });
  }
  const accepted = await f.attach(direct); assert.equal(accepted.status, 201, accepted.data.error); assert.equal(f.calls.upload, 1); assert.deepEqual(f.totals(), { media: 1, blobs: 1, outbox: 0 });
});

test('HTTP Meta limita texto Unicode e horário à janela real de ingresso; expiração bloqueia claim sem enviar', async t => {
  const f = await fixture(t), value = await f.metaConversation('messenger'), before = JSON.stringify(f.current(value.id));
  const tooLong = await f.schedule(value, { text: '😀'.repeat(1001) }); assert.equal(tooLong.status, 400); assert.equal(JSON.stringify(f.current(value.id)), before);
  const outside = await f.schedule(value, { dueAt: new Date(f.time() + 24 * 3600000).toISOString() }); assert.equal(outside.status, 409); assert.equal(JSON.stringify(f.current(value.id)), before);
  const accepted = await f.schedule(value, { text: '😀'.repeat(1000) }); assert.equal(accepted.status, 200, accepted.data.error);
  f.advance(24 * 3600000); const expired = await f.schedule(value); assert.equal(expired.status, 409);
  const result = await f.app.scheduled.tick(); assert.equal(result.blocked, 1); assert.equal(f.current(value.id).scheduledMessages[0].reasonCode, 'channel_policy_changed');
  const tenant = await f.request(f.path, { cookie: f.operator.cookie }); assert.equal(tenant.status, 200); assert.equal(tenant.data.conversations.find(item => item.id === value.id).channelAvailability.replyWindow.open, false);
  assert.deepEqual(f.totals(), { media: 0, blobs: 0, outbox: 0 }); assert.equal(f.calls.upload, 0); assert.deepEqual(f.calls.telegram, []);
});

test('HTTP seleção revogada durante leitura do corpo é revalidada antes de criar mídia', async t => {
  const f = await fixture(t), value = f.conversation('-11'), entered = deferred();
  const onRequest = req => { if (req.url === f.attachmentPath(value)) entered.resolve(); }; f.app.server.on('request', onRequest); t.after(() => f.app.server.off('request', onRequest));
  const pending = f.pending(f.attachmentPath(value), { method: 'POST', cookie: f.operator.cookie, headers: f.attachmentHeaders(value, { 'Content-Length': png.length }) });
  t.after(() => pending.req.destroy()); pending.req.write(png.subarray(0, 4));
  await Promise.race([entered.promise, pending.promise.then(() => assert.fail('O upload respondeu antes da leitura parcial.'))]);
  assert.equal((await f.choose([])).status, 200); pending.req.end(png.subarray(4));
  const denied = await pending.promise; assert.equal(denied.status, 409, denied.data.error); assert.equal(f.calls.upload, 0); assert.deepEqual(f.totals(), { media: 0, blobs: 0, outbox: 0 });
});

test('HTTP sessão revogada durante obtenção da chave não deixa registro ou blob de upload', async t => {
  const f = await fixture(t, { delayedMediaKey: true }), value = f.conversation(), pending = f.attach(value);
  await Promise.race([f.keyGate.entered.promise, pending.then(() => assert.fail('O upload respondeu antes de obter a chave.'))]);
  f.app.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), f.operator.id); f.keyGate.release.resolve();
  const denied = await pending; assert.equal(denied.status, 401, denied.data.error); assert.equal(f.calls.upload, 1); assert.deepEqual(f.totals(), { media: 0, blobs: 0, outbox: 0 });
  assert.deepEqual(f.calls.telegram, []);
});
