import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { TelegramGateway } from '../src/telegram.js';
import { createApp } from '../src/server.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Teste' };
const token = '123456789:' + 'a'.repeat(35); // Fixture sintética, nunca usada na rede.
const message = (updateId, chatId, content, extra = {}) => ({ update_id: updateId, message: { message_id: updateId, date: 1750000000, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private', title: 'Grupo QA', first_name: 'Jean QA' }, from: { id: 81, first_name: 'Ana' }, text: content, ...extra } });
function setup(t, { polling = false, handler, now } = {}) {
  const store = new Store(':memory:'), key = randomBytes(32), calls = [];
  const tenant = store.createTenant(admin, { name: 'Telegram QA', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture', state => state.channels.push({ id: 'tg', kind: 'telegram', transport: 'telegram-bot', name: 'Bot QA', state: 'disconnected', label: 'Pendente' }));
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1), payload = JSON.parse(options.body);
    calls.push({ method, payload });
    let result = handler ? await handler(method, payload, options) : undefined;
    result ??= method === 'getMe' ? { ok: true, result: { id: 123456789, is_bot: true, username: 'qa_bot', can_read_all_group_messages: false } } : method === 'getWebhookInfo' ? { ok: true, result: { url: '' } } : { ok: true, result: { message_id: 99, chat: { id: Number(payload.chat_id) } } };
    return { ok: result.ok, status: result.error_code || 200, json: async () => result };
  };
  const gateway = new TelegramGateway(store, { fetchImpl, authKey: key, polling, retryDelay: 10, ...(now ? { now } : {}) });
  t.after(async () => { await gateway.close(); store.close(); });
  return { store, key, tenant, calls, gateway, fetchImpl };
}
const current = c => c.store.tenant(admin, c.tenant.id).conversations;
async function connect(c) { await c.gateway.start(admin, c.tenant.id, 'tg', token); return c.gateway.entries.get('tg'); }
function takeOverFixture(context, conversationId) {
  context.store.mutate(admin, context.tenant.id, 'Fixture: assumir atendimento humano', tenant => {
    const conversation = tenant.conversations.find(item => item.id === conversationId);
    assert.equal(conversation.owner, 'queue');
    conversation.owner = 'human'; conversation.agentId = null; conversation.version++;
  });
  return current(context).find(item => item.id === conversationId);
}

test('Telegram confirma offset sem perder entrada na capacidade CRM e retenta vínculo só na próxima mensagem', async t => {
  const c = setup(t), entry = await connect(c);
  c.store.mutate(admin, c.tenant.id, 'Fixture: capacidade CRM', state => { state.contacts = Array.from({length:10000}, (_, index) => ({id:'capacity-' + index, name:'Fixture', type:'person', identities:[], version:1})); });
  await c.gateway.receive(entry, message(1, 81, 'Mensagem com agenda cheia'));
  let state = c.store.tenant(admin, c.tenant.id), conversation = state.conversations.find(item => item.remoteChatId === '81');
  assert.equal(conversation.messages.length, 1); assert.equal(conversation.contactId, undefined); assert.equal(conversation.contactSyncStatus, 'capacity'); assert.equal(state.contacts.length, 10000);
  assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg').next_offset, 2);
  const original = JSON.stringify(conversation);
  await c.gateway.receive(entry, message(1, 81, 'Replay com agenda cheia'));
  assert.equal(JSON.stringify(c.store.tenant(admin, c.tenant.id).conversations.find(item => item.id === conversation.id)), original);
  c.store.mutate(admin, c.tenant.id, 'Fixture: liberar vaga sintética', tenant => { tenant.contacts.pop(); });
  await c.gateway.receive(entry, message(2, 81, 'Nova mensagem com vaga'));
  state = c.store.tenant(admin, c.tenant.id); conversation = state.conversations.find(item => item.remoteChatId === '81');
  assert.equal(conversation.messages.length, 2); assert.equal(conversation.contactSyncStatus, 'linked'); assert.ok(conversation.contactId); assert.equal(state.contacts.length, 10000);
  assert.deepEqual(state.contacts.find(item => item.id === conversation.contactId).identities, [{channelId:'tg', kind:'person', externalId:'81'}]);
  assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg').next_offset, 3);
});

test('Telegram valida identidade, preserva token cifrado e retoma sem cadastrado novamente', async t => {
  const c = setup(t), entry = await connect(c);
  assert.equal(c.gateway.status(admin, c.tenant.id, 'tg').groupReadMode, 'mentions');
  assert.equal(JSON.stringify(c.store.tenant(admin, c.tenant.id)).includes(token), false);
  assert.equal(Buffer.from(c.store.db.prepare('SELECT payload FROM channel_secrets').get().payload).includes(Buffer.from(token)), false);
  assert.equal(entry.botId, '123456789');
  await c.gateway.close();
  const restored = new TelegramGateway(c.store, { fetchImpl: c.fetchImpl, authKey: c.key, polling: false });
  try { await restored.restore(); assert.equal(restored.connectedCount(), 1); }
  finally { await restored.close(); }
});

test('Telegram preserva webhook existente e recusa bot reservado em outra empresa', async t => {
  const c = setup(t, { handler: method => method === 'getWebhookInfo' ? { ok: true, result: { url: 'https://fixture.invalid/webhook' } } : undefined });
  await assert.rejects(c.gateway.start(admin, c.tenant.id, 'tg', token), /webhook ativo/);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM telegram_bindings').get().n, 0);
  assert.equal(c.calls.some(call => call.method === 'deleteWebhook'), false);
  const d = setup(t); await connect(d);
  const other = d.store.createTenant(admin, { name: 'Outra', segment: 'QA' });
  d.store.mutate(admin, other.id, 'Fixture', state => state.channels.push({ id: 'tg-other', kind: 'telegram', transport: 'telegram-bot', state: 'disconnected', label: '' }));
  await assert.rejects(d.gateway.start(admin, other.id, 'tg-other', token), /outra conexão/);
});

test('Telegram deduplica replay e mantém autores e tópicos separados no grupo', async t => {
  const c = setup(t), entry = await connect(c);
  c.gateway.receive(entry, message(1, -10011, 'Olá', { message_thread_id: 7 }));
  c.gateway.receive(entry, message(1, -10011, 'Replay', { message_thread_id: 7 }));
  c.gateway.receive(entry, message(2, -10011, 'Outro participante', { message_thread_id: 7, from: { id: 82, first_name: 'Bruno' } }));
  c.gateway.receive(entry, message(3, -10011, 'Outro tópico', { message_thread_id: 8 }));
  c.gateway.receive(entry, message(4, 81, 'Privado'));
  assert.equal(current(c).length, 3);
  let group = current(c).find(item => item.threadId === 7);
  assert.equal(group.conversationKind, 'group'); assert.equal(group.messages.length, 2);
  assert.deepEqual(group.messages.map(item => item.senderName), ['Ana', 'Bruno']);
  assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets').get().next_offset, 5);
  group = takeOverFixture(c, group.id);
  await c.gateway.send(admin, c.tenant.id, group.id, { channelId: 'tg', version: group.version, text: 'Resposta' });
  const sent = c.calls.find(call => call.method === 'sendMessage');
  assert.equal(sent.payload.chat_id, '-10011'); assert.equal(sent.payload.message_thread_id, 7);
  assert.equal(current(c).find(item => item.id === group.id).messages.at(-1).delivery, 'sent');
});

test('Telegram migra grupo para supergrupo sem dividir histórico ou destino', async t => {
  const c = setup(t), entry = await connect(c);
  c.gateway.receive(entry, message(1, -11, 'Antes'));
  c.gateway.receive(entry, message(2, -11, undefined, { migrate_to_chat_id: -10022 }));
  c.gateway.receive(entry, message(3, -10022, 'Depois'));
  let [conversation] = current(c);
  assert.equal(current(c).length, 1); assert.equal(conversation.remoteChatId, '-10022');
  assert.equal(conversation.messages.length, 2);
  conversation = takeOverFixture(c, conversation.id);
  await c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'tg', version: conversation.version, text: 'Destino novo' });
  assert.equal(c.calls.at(-1).payload.chat_id, '-10022');
});

test('Migração Telegram conserva grupo pendente e offset com CRM cheio, sem perder próxima entrada', async t => {
  const c = setup(t), entry = await connect(c);
  c.store.mutate(admin, c.tenant.id, 'Fixture: agenda cheia', tenant => { tenant.contacts = Array.from({length:10000}, (_, index) => ({id:'full-' + index,name:'Fixture',type:'person',identities:[],version:1})); });
  await c.gateway.receive(entry, message(1, -11, 'Antes da migração'));
  let conversation = current(c)[0]; const id = conversation.id;
  assert.equal(conversation.contactSyncStatus, 'capacity'); assert.equal(conversation.contactId, undefined);
  await c.gateway.receive(entry, message(2, -11, undefined, {migrate_to_chat_id:-10022}));
  conversation = current(c)[0]; assert.equal(current(c).length, 1); assert.equal(conversation.id,id); assert.equal(conversation.remoteChatId,'-10022'); assert.equal(conversation.messages.length,1); assert.equal(conversation.contactSyncStatus,'capacity');
  assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg').next_offset,3);
  await c.gateway.receive(entry, message(3, -10022, 'Depois da migração')); conversation=current(c)[0];
  assert.equal(conversation.id,id); assert.equal(conversation.messages.length,2); assert.equal(conversation.contactId,undefined);
  c.store.mutate(admin,c.tenant.id,'Fixture: vaga sintética',tenant=>{tenant.contacts.pop();});
  await c.gateway.receive(entry,message(4,-10022,'Entrada com vaga')); conversation=current(c)[0];
  const tenant=c.store.tenant(admin,c.tenant.id), contact=tenant.contacts.find(item=>item.id===conversation.contactId);
  assert.equal(conversation.contactSyncStatus,'linked'); assert.equal(conversation.messages.length,3); assert.equal(contact.type,'group'); assert.deepEqual(contact.identities,[{channelId:'tg',kind:'group',externalId:'-10022'}]); assert.equal(tenant.contacts.length,10000);
  const before=JSON.stringify(conversation); await c.gateway.receive(entry,message(4,-10022,'Replay')); assert.equal(JSON.stringify(current(c)[0]),before);
  assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg').next_offset,5);
});

test('Telegram não envia por canal errado ou versão obsoleta e não repete timeout', async t => {
  const c = setup(t, { handler: method => { if (method === 'sendMessage') throw new Error('Timeout fixture'); } });
  const entry = await connect(c); c.gateway.receive(entry, message(1, 81, 'Privado'));
  let conversation = takeOverFixture(c, current(c)[0].id); const version = conversation.version;
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'errado', version, text: 'Inválido' }), /canal de origem/);
  c.store.mutate(admin, c.tenant.id, 'Tomada', tenant => { const item = tenant.conversations[0]; item.owner = 'human'; item.version++; });
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'tg', version, text: 'Obsoleto' }), /conversa mudou/);
  conversation = current(c)[0];
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'tg', version: conversation.version, text: 'Uma tentativa' }), /sem confirmação/);
  assert.equal(current(c)[0].messages.at(-1).delivery, 'unconfirmed');
  assert.equal(c.calls.filter(call => call.method === 'sendMessage').length, 1);
});

test('Telegram polling confirma offset só após persistir mensagem e cancela ao encerrar', async t => {
  let polls = 0;
  const c = setup(t, { polling: true, handler: (method, payload, options) => {
    if (method !== 'getUpdates') return;
    if (++polls === 1) return { ok: true, result: [message(9, 81, 'Recebida pelo poller')] };
    assert.equal(payload.offset, 10);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Abort fixture')), { once: true }));
  } });
  await connect(c);
  for (let i = 0; i < 20 && polls < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, 2); assert.equal(current(c)[0].messages.length, 1);
  await c.gateway.close();
});

test('Telegram recupera migração informada no erro sem repetir envio automaticamente', async t => {
  const c = setup(t, { handler: method => method === 'sendMessage' ? { ok: false, error_code: 400, parameters: { migrate_to_chat_id: -10099 } } : undefined });
  const entry = await connect(c); c.gateway.receive(entry, message(1, -11, 'Antes'));
  const conversation = takeOverFixture(c, current(c)[0].id);
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'tg', version: conversation.version, text: 'Tentativa' }), /Destino atualizado/);
  assert.equal(current(c)[0].remoteChatId, '-10099'); assert.equal(current(c)[0].messages.at(-1).delivery, 'failed');
  assert.equal(c.calls.filter(call => call.method === 'sendMessage').length, 1);
});

test('Telegram API oculta credenciais e IDs internos e bloqueia conexão de operador', async t => {
  const c = setup(t), app = createApp({ allowDemo: true, databasePath: ':memory:', telegramOptions: { fetchImpl: c.fetchImpl, authKey: c.key, polling: false } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all([app.gateway.close(), app.telegram.close()]); await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reseller' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], headers = { 'Content-Type': 'application/json', Cookie: cookie };
  const response = await fetch(base + '/api/tenants/playtech-demo/channels', { method: 'POST', headers, body: JSON.stringify({ name: 'Telegram real QA', kind: 'telegram', real: true }) });
  const channel = await response.json(); assert.equal(response.status, 201);
  const path = `/api/tenants/playtech-demo/channels/${channel.id}/connect`;
  const connected = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ token }) });
  assert.equal(connected.status, 200); assert.equal(JSON.stringify(await connected.json()).includes(token), false);
  app.telegram.receive(app.telegram.entries.get(channel.id), message(1, -10011, 'Grupo QA'));
  const data = await (await fetch(base + '/api/tenants/playtech-demo', { headers })).json();
  const group = data.conversations.find(item => item.channelId === channel.id);
  assert.equal(group.remoteChatId, undefined); assert.equal(group.messages[0].senderId, undefined); assert.equal(group.messages[0].senderName, 'Ana');
  const operatorLogin = await fetch(base + '/api/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'operator' }) });
  const operatorCookie = operatorLogin.headers.get('set-cookie').split(';')[0];
  const denied = await fetch(base + path, { method: 'POST', headers: { ...headers, Cookie: operatorCookie }, body: JSON.stringify({ token }) });
  assert.equal(denied.status, 403);
});

const hang = options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Abort fixture')), { once: true }));

test('Telegram registra figurinha, local, contato e enquete como texto legível em vez de descartar', async t => {
  const c = setup(t), entry = await connect(c);
  const cases = [
    [{ sticker: { file_id: 'sticker-fixture', emoji: '😀', is_animated: false } }, '[Figurinha] 😀'],
    [{ location: { latitude: -23.55052, longitude: -46.633308 } }, '[Localização] (-23.550520, -46.633308)'],
    [{ location: { latitude: -22.9, longitude: -43.2, live_period: 900 } }, '[Localização em tempo real] (-22.900000, -43.200000)'],
    [{ venue: { location: { latitude: -23.5, longitude: -46.6 }, title: 'Padaria Fixture', address: 'Rua Sintética, 100' }, location: { latitude: -23.5, longitude: -46.6 } }, '[Localização] Padaria Fixture · Rua Sintética, 100 (-23.500000, -46.600000)'],
    [{ contact: { phone_number: '+5511977776666', first_name: 'Maria', last_name: 'Fixture' } }, '[Contato] Maria Fixture · +5511977776666'],
    [{ poll: { id: 'poll-fixture', question: 'Melhor horário?', options: [{ text: 'Manhã', voter_count: 0 }, { text: 'Tarde', voter_count: 0 }] } }, '[Enquete] Melhor horário? · Manhã / Tarde']
  ];
  for (const [index, [extra]] of cases.entries()) await c.gateway.receive(entry, message(index + 1, 81, undefined, extra));
  const [conversation] = current(c);
  assert.deepEqual(conversation.messages.map(item => item.text), cases.map(item => item[1]));
  assert.ok(conversation.messages.every(item => item.kind === 'customer' && !item.attachments));
  assert.equal(conversation.unread, cases.length);
  assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg').next_offset, cases.length + 1);
});

// Bot API: após uma semana sem updates, o próximo update_id é sorteado; o offset salvo confirmaria e descartaria os novos.
test('Telegram sem atividade há uma semana pede updates sem offset e aceita update_id sorteado menor', async t => {
  const NOW = Date.parse('2026-10-06T12:00:00Z'), payloads = [];
  let polls = 0;
  const c = setup(t, { polling: true, now: () => NOW, handler: (method, payload, options) => {
    if (method !== 'getUpdates') return;
    payloads.push(payload);
    return ++polls === 1 ? { ok: true, result: [message(42, 81, 'Depois de uma semana sem atualizações')] } : hang(options);
  } });
  c.store.db.prepare('INSERT INTO telegram_offsets VALUES (?,?)').run('tg', 500);
  c.store.db.prepare('INSERT INTO telegram_offset_activity VALUES (?,?)').run('tg', NOW - 7 * 86400_000);
  await connect(c);
  for (let i = 0; i < 50 && polls < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, 2); assert.equal(Object.hasOwn(payloads[0], 'offset'), false); assert.equal(payloads[1].offset, 43);
  assert.equal(current(c)[0].messages[0].text, 'Depois de uma semana sem atualizações');
  assert.equal(c.store.db.prepare('SELECT active_at FROM telegram_offset_activity WHERE channel_id=?').get('tg').active_at, NOW);
  const recent = [];
  const d = setup(t, { polling: true, now: () => NOW, handler: (method, payload, options) => { if (method !== 'getUpdates') return; recent.push(payload); return hang(options); } });
  d.store.db.prepare('INSERT INTO telegram_offsets VALUES (?,?)').run('tg', 500);
  d.store.db.prepare('INSERT INTO telegram_offset_activity VALUES (?,?)').run('tg', NOW - 86400_000);
  await connect(d);
  for (let i = 0; i < 50 && !recent.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(recent[0].offset, 500);
});

test('Telegram fora do ar grava a transição de reconexão uma vez, sem regravar a empresa a cada tentativa', async t => {
  let polls = 0;
  const c = setup(t, { polling: true, handler: (method, payload, options) => {
    if (method !== 'getUpdates') return;
    if (++polls <= 4) throw new Error('Rede indisponível fixture');
    return polls === 5 ? { ok: true, result: [] } : hang(options);
  } });
  await connect(c);
  const deadline = Date.now() + 2000;
  while (polls < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const audits = action => c.store.db.prepare('SELECT count(*) AS n FROM audit WHERE action=?').get(action).n;
  assert.equal(polls, 6); assert.equal(audits('Telegram: reconnecting'), 1); assert.equal(audits('Telegram: connected'), 1);
  assert.equal(c.gateway.status(admin, c.tenant.id, 'tg').state, 'connected');
});
