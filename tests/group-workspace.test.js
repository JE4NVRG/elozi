import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { GroupWorkspace, selectedGroup } from '../src/group-workspace.js';

const status = expected => error => error.status === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const humanMessage = (id, senderId, senderName, more = {}) => ({ id, kind: 'customer', senderId, senderName, text: 'Conteúdo privado não integra DTO de contexto', createdAt: '2026-10-05T10:00:00Z', ...more });
function fixture(t, options = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); let user = 0;
  const addUser = ({ role = 'operator', tenantIds = [], permissions = ['inbox.read'], scopeRules = null } = {}) => {
    const row = auth.insertUser({ username: 'synthetic-group-' + ++user, name: 'Pessoa ' + user }, Buffer.alloc(16, user), Buffer.alloc(64, user), role, tenantIds, 'mep-demo');
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  };
  const admin = addUser({ role: 'reseller' }), a = store.createTenant(admin, { name: 'Grupos A', segment: 'QA' }), b = store.createTenant(admin, { name: 'Grupos B', segment: 'QA' });
  const jid = '12000001@g.us';
  for (const tenant of [a, b]) store.mutate(admin, tenant.id, 'Grupos sintéticos', state => {
    state.departments = [{ id: 'sales', name: 'Vendas', active: true, memberIds: [] }, { id: 'support', name: 'Suporte', active: true, memberIds: [] }];
    state.channels = [{ id: 'wa', name: 'WhatsApp', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', allowedGroups: [jid], whatsappGroupsVersion: 1 }, { id: 'tg', name: 'Telegram', kind: 'telegram', transport: 'telegram-bot', state: 'connected', telegramGroups: { mode: 'selected', version: 1, groupIds: ['-11'], known: [{ id: '-11', joined: true, type: 'supergroup', sendPermissions: { text: false, photos: false } }] } }];
    state.conversations = [
      { id: 'wa-group', conversationKind: 'group', channelId: 'wa', remoteJid: jid, contact: 'WhatsApp QA', departmentId: 'sales', status: 'open', version: 2, unread: 1, messages: [humanMessage('w1', null, 'Ana', { senderJid: '55110001@s.whatsapp.net' })] },
      { id: 'tg-group', conversationKind: 'group', channelId: 'tg', remoteChatId: '-11', threadId: 17, contact: 'Telegram QA', departmentId: 'support', status: 'open', version: 3, unread: 2, messages: [humanMessage('t1', '10', 'Ana'), humanMessage('t2', '20', 'Bruno'), { id: 'private', kind: 'internal', senderId: '99', senderName: 'Nota privada', text: 'Token que nunca deve sair' }] },
      { id: 'unselected', conversationKind: 'group', channelId: 'wa', remoteJid: '12000002@g.us', contact: 'Pessoal', version: 1, messages: [] },
      { id: 'direct', conversationKind: 'direct', channelId: 'wa', remoteJid: '55110001@s.whatsapp.net', version: 1, messages: [] }
    ];
  });
  const operator = addUser({ tenantIds: [a.id, b.id], scopeRules: { [a.id]: { channelIds: ['tg'], departmentIds: ['support'] }, [b.id]: { channelIds: ['wa'], departmentIds: ['sales'] } } });
  const operations = new Operations(store, auth), calls = [];
  const gateway = { entries: new Map(), closing: false }, telegram = { entries: new Map(), closing: false, call: async (_entry, method, input) => { calls.push({ method, input }); return method === 'getChat' ? { id: -11, type: 'supergroup', title: 'Título vivo', description: 'Contexto do grupo', is_forum: true, invite_link: 'https://private.invalid/invite', token: 'private-provider-token' } : 8; } };
  gateway.entries.set('wa', { tenantId: a.id, channelId: 'wa', state: 'connected', generation: 1, matched: true, groupCache: new Map(), socket: { groupMetadata: async peer => { calls.push({ method: 'groupMetadata', peer }); return { id: peer, subject: 'Grupo vivo', desc: 'Descrição', size: 2, participants: [{ id: '55110001@s.whatsapp.net', name: 'Ana', admin: 'admin' }, { id: '55110002@lid', name: 'Bruno' }] }; } } });
  telegram.entries.set('tg', { tenantId: a.id, channelId: 'tg', state: 'connected', stopped: false });
  const authorize = (actor, tenantId, conversation) => {
    auth.currentActor(actor);
    operations.permission(actor, 'inbox.read', { tenantId, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' });
  };
  const workspace = new GroupWorkspace(store, { gateway, telegram, authorize, now: () => Date.parse('2026-10-05T11:00:00Z'), ...options });
  const mutate = fn => store.mutate(admin, a.id, 'Mutação sintética', fn);
  return { store, auth, operations, admin, operator, a, b, jid, gateway, telegram, workspace, calls, mutate, authorize };
}

test('diretório agrupa somente conversas selecionadas sob ACL por empresa/canal/departamento, sem conteúdo', t => {
  const f = fixture(t), before = f.store.tenant(f.admin, f.a.id);
  const a = f.workspace.directory(f.operator, f.a.id), b = f.workspace.directory(f.operator, f.b.id);
  assert.deepEqual(a.groups.map(group => group.conversationId), ['tg-group']); assert.deepEqual(b.groups.map(group => group.conversationId), ['wa-group']);
  assert.deepEqual(Object.keys(a.groups[0]).sort(), ['aiAllowed', 'channelId', 'channelName', 'conversationId', 'historyCount', 'lastMessageAt', 'state', 'title', 'transport', 'unread', 'version']);
  assert.equal(a.groups[0].aiAllowed, true); assert.equal(b.groups[0].aiAllowed, true);
  assert.equal(a.groups[0].historyCount, 2); assert.equal(a.groups[0].lastMessageAt, '2026-10-05T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(a), /Conteúdo|Token|remoteChatId|senderId|messages/); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.tenant(f.admin, f.a.id), before);
  f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), f.operator.userId);
  assert.deepEqual(f.workspace.directory(f.operator, f.a.id).groups, []);
});

test('diretório humano distingue IA disponível no bot e indisponível na conta pessoal selecionada', t => {
  const f = fixture(t);
  assert.equal(f.workspace.directory(f.admin, f.a.id).groups.every(group => group.aiAllowed === true), true);
  f.mutate(state => { const channel = state.channels.find(item => item.id === 'tg'); channel.kind = 'telegram_user'; channel.transport = 'telegram-user'; channel.telegramUser = { selectedPeerIds: ['-11'] }; });
  const groups = f.workspace.directory(f.operator, f.a.id).groups;
  assert.deepEqual(groups.map(group => group.conversationId), ['tg-group']);
  assert.equal(groups[0].aiAllowed, false); assert.equal(groups[0].historyCount, 2);
  assert.doesNotMatch(JSON.stringify(groups), /Conteúdo|Token|remoteChatId|senderId|messages/);
});

test('seleção de ingresso inclui legado TG e aliases autorizados, mas exclui conflito/saída e permissão não muda leitura', () => {
  const conversation = { channelId: 'tg', remoteChatId: '-11', chatAliases: ['-10'] }, channel = { id: 'tg', transport: 'telegram-bot' };
  assert.equal(selectedGroup(channel, conversation), true);
  channel.telegramGroups = { mode: 'selected', groupIds: ['-12'], known: [{ id: '-12', aliases: ['-11'], joined: true, sendPermissions: { text: false } }] };
  assert.equal(selectedGroup(channel, conversation), true);
  channel.telegramGroups.migrationConflicts = [{ fromGroupId: '-10', toGroupId: '-99' }]; assert.equal(selectedGroup(channel, conversation), false);
  delete channel.telegramGroups.migrationConflicts; channel.telegramGroups.known[0].joined = false; assert.equal(selectedGroup(channel, conversation), false);
  channel.telegramGroups.known[0].joined = true; channel.telegramGroups.groupIds = []; assert.equal(selectedGroup(channel, conversation), false);
});

test('contexto WhatsApp consulta somente grupo habilitado, limita membros e sanitiza DTO sem mutar store', async t => {
  const f = fixture(t, { maxParticipants: 2 }), before = f.store.tenant(f.admin, f.a.id);
  f.gateway.entries.get('wa').socket.groupMetadata = async peer => {
    f.calls.push(peer); return { id: peer, subject: 'Grupo\nQA https://private.invalid', desc: 'Descrição https://private.invalid/invite', inviteCode: 'secret-invite', size: 200, participants: Array.from({ length: 100 }, (_, i) => ({ id: `${55110000 + i}@s.whatsapp.net`, name: 'Membro ' + i, admin: i ? null : 'superadmin', phoneNumber: 'private', token: 'secret-member' })) };
  };
  const result = await f.workspace.context(f.admin, f.a.id, 'wa-group');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0], f.jid); assert.equal(result.group.source, 'provider'); assert.equal(result.group.availability, 'available');
  assert.equal(result.participants.items.length, 2); assert.equal(result.participants.total, 200); assert.equal(result.participants.complete, false); assert.equal(result.participants.truncated, true); assert.equal(result.participants.items[0].role, 'owner');
  assert.equal(result.topic, null); assert.doesNotMatch(JSON.stringify(result), /https:|secret-|phoneNumber|inviteCode|remoteJid|Conteúdo/);
  assert.deepEqual(f.store.tenant(f.admin, f.a.id), before);
  await assert.rejects(f.workspace.context(f.operator, f.a.id, 'wa-group'), status(403));
  await assert.rejects(f.workspace.context(f.admin, f.a.id, 'unselected'), status(409));
  await assert.rejects(f.workspace.context(f.admin, f.a.id, 'direct'), status(400));
  assert.equal(f.calls.length, 1);
});

test('WhatsApp metadata cache explicitly differs from live provider and does not claim a fetched roster timestamp', async t => {
  const f = fixture(t), entry = f.gateway.entries.get('wa');
  entry.groupCache.set(f.jid, { id: f.jid, subject: 'Título do cache', participants: [{ id: '55110001@s.whatsapp.net' }], size: 4 });
  entry.socket.groupMetadata = () => assert.fail('Cache existente não deve disparar consulta');
  const result = await f.workspace.context(f.admin, f.a.id, 'wa-group');
  assert.equal(result.group.source, 'cache'); assert.equal(result.group.observedAt, null); assert.equal(result.participants.source, 'cache'); assert.equal(result.participants.complete, false);
});

test('Telegram consulta getChat/contagem, topic só observado e autores conhecidos nunca viram roster completo', async t => {
  const f = fixture(t), result = await f.workspace.context(f.operator, f.a.id, 'tg-group');
  assert.deepEqual(f.calls.map(call => call.method), ['getChat', 'getChatMemberCount']); assert.ok(f.calls.every(call => call.input.chat_id === '-11'));
  assert.equal(result.group.type, 'supergroup'); assert.equal(result.group.forum, true); assert.equal(result.group.source, 'provider');
  assert.deepEqual(result.topic, { id: 17, title: null, source: 'observed' });
  assert.equal(result.participants.total, 8); assert.equal(result.participants.source, 'observed'); assert.equal(result.participants.complete, false);
  assert.equal(result.participants.truncated, true);
  assert.deepEqual(result.participants.items.map(member => member.name), ['Bruno', 'Ana']); assert.ok(result.participants.items.every(member => member.role === 'unknown'));
  assert.doesNotMatch(JSON.stringify(result), /private-provider|private.invalid|Nota privada|Token|invite_link/);
});

test('desconexão, provider falho ou resposta de outro grupo preservam somente contexto observado', async t => {
  const f = fixture(t);
  f.gateway.entries.get('wa').state = 'disconnected';
  const offline = await f.workspace.context(f.admin, f.a.id, 'wa-group');
  assert.equal(offline.group.availability, 'unavailable'); assert.equal(offline.group.source, 'observed'); assert.equal(offline.participants.items.length, 1); assert.equal(f.calls.length, 0);
  f.telegram.call = async () => { throw Error('secret provider detail'); };
  const failed = await f.workspace.context(f.operator, f.a.id, 'tg-group'); assert.equal(failed.group.availability, 'unavailable'); assert.equal(failed.participants.total, null); assert.doesNotMatch(JSON.stringify(failed), /secret provider/);
  f.telegram.call = async () => ({ id: -99, type: 'supergroup', title: 'Outro grupo secreto' });
  const mismatched = await f.workspace.context(f.operator, f.a.id, 'tg-group'); assert.equal(mismatched.group.availability, 'unavailable'); assert.notEqual(mismatched.group.title, 'Outro grupo secreto');
});

test('mesmos IDs em duas empresas não usam entry ou cache da empresa estrangeira', async t => {
  const f = fixture(t);
  f.store.mutate(f.admin, f.b.id, 'Título sintético B', state => { state.conversations.find(item => item.id === 'wa-group').contact = 'Grupo exclusivo B'; });
  f.gateway.entries.get('wa').groupCache.set(f.jid, { id: f.jid, subject: 'Metadados privados A', participants: [{ id: '55119999@s.whatsapp.net', name: 'Pessoa privada A' }] });
  const result = await f.workspace.context(f.operator, f.b.id, 'wa-group');
  assert.equal(result.title, 'Grupo exclusivo B'); assert.equal(result.group.title, 'Grupo exclusivo B'); assert.equal(result.group.availability, 'unavailable');
  assert.equal(result.participants.source, 'observed'); assert.doesNotMatch(JSON.stringify(result), /Metadados privados A|Pessoa privada A|55119999/); assert.equal(f.calls.length, 0);
});

test('revogação fresca durante metadata assíncrona nega retorno e não efetua consulta seguinte', async t => {
  const f = fixture(t), waiting = deferred(); let started;
  const began = new Promise(resolve => { started = resolve; });
  f.telegram.call = async (_entry, method) => { f.calls.push(method); started(); return waiting.promise; };
  const request = f.workspace.context(f.operator, f.a.id, 'tg-group'); await began;
  f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), f.operator.userId);
  waiting.resolve({ id: -11, type: 'supergroup', title: 'Dados não autorizados' });
  await assert.rejects(request, status(403)); assert.deepEqual(f.calls, ['getChat']); assert.equal(f.workspace.pending, 0);
});

test('reauthorize fresco que expira suporte durante contagem nega o DTO após o último await', async t => {
  const f = fixture(t), actor = { ...f.operator }, waiting = deferred(); let checks = 0, revoked = false, started;
  const began = new Promise(resolve => { started = resolve; });
  f.telegram.call = async (_entry, method) => { if (method === 'getChat') return { id: -11, type: 'supergroup' }; started(); return waiting.promise; };
  const request = f.workspace.context(actor, f.a.id, 'tg-group', { reauthorize: () => { checks++; return !revoked; } });
  await began; revoked = true; waiting.resolve(20);
  await assert.rejects(request, status(403)); assert.ok(checks >= 3); assert.equal(f.workspace.pending, 0);
});

test('deseleção, troca da conexão e migração durante await não retornam metadados de contexto antigo', async t => {
  for (const mutation of ['deselect', 'connection', 'migration', 'revision']) {
    const f = fixture(t), waiting = deferred(); let started; const began = new Promise(resolve => { started = resolve; });
    f.gateway.entries.get('wa').socket.groupMetadata = async () => { started(); return waiting.promise; };
    const request = f.workspace.context(f.admin, f.a.id, 'wa-group'); await began;
    if (mutation === 'connection') f.gateway.entries.set('wa', { ...f.gateway.entries.get('wa'), generation: 2 });
    else f.mutate(state => { if (mutation === 'deselect') state.channels[0].allowedGroups = []; else if (mutation === 'migration') state.conversations[0].remoteJid = '12000002@g.us'; else state.channels[0].whatsappGroupsVersion++; });
    waiting.resolve({ id: f.jid, subject: 'Título antigo', participants: [] }); await assert.rejects(request, status(409)); assert.equal(f.workspace.pending, 0);
  }
});

test('serviços, ausência de usuário, callbacks assíncronos e alteração de identidade falham fechados', async t => {
  const f = fixture(t);
  for (const actor of [{ ...f.admin, kind: 'service' }, { ...f.admin, userId: null }]) { assert.throws(() => f.workspace.directory(actor, f.a.id), status(403)); await assert.rejects(f.workspace.context(actor, f.a.id, 'wa-group'), status(403)); }
  const asyncAuth = new GroupWorkspace(f.store, { gateway: f.gateway, authorize: async () => true });
  assert.throws(() => asyncAuth.directory(f.admin, f.a.id), status(500));
  await assert.rejects(f.workspace.context(f.admin, f.a.id, 'wa-group', { reauthorize: async () => { throw Error('synthetic rejection'); } }), status(500));
  const changed = { ...f.admin }; await assert.rejects(f.workspace.context(changed, f.a.id, 'wa-group', { reauthorize: () => { changed.userId = f.operator.userId; } }), status(403));
  assert.equal(f.calls.length, 0);
});

test('concorrência e deadline de leitura são limitados; metadados tardios não contaminam pedido posterior', async t => {
  const f = fixture(t, { timeoutMs: 15, maxPending: 1 }), waiting = deferred(); let started; const began = new Promise(resolve => { started = resolve; });
  f.gateway.entries.get('wa').socket.groupMetadata = async () => { started(); return waiting.promise; };
  const request = f.workspace.context(f.admin, f.a.id, 'wa-group'); await began;
  const limited = await f.workspace.context(f.operator, f.a.id, 'tg-group'); assert.equal(limited.group.availability, 'unavailable'); assert.equal(f.calls.length, 0);
  const expired = await request; assert.equal(expired.group.availability, 'unavailable'); assert.equal(f.workspace.pending, 0);
  waiting.resolve({ id: f.jid, subject: 'Provider tardio', participants: [] });
  const fresh = await f.workspace.context(f.operator, f.a.id, 'tg-group'); assert.equal(fresh.group.title, 'Título vivo'); assert.equal(fresh.group.source, 'provider');
});
