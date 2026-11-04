import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { TeamChat } from '../src/team-chat.js';
import { Outbox } from '../src/outbox.js';
import { createLocalBackup, validateBackup } from '../src/backup.js';

const status = code => error => error.status === code;
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  let count = 0;
  const user = ({ role = 'operator', tenantIds = [], resellerId = 'mep-demo', permissions = null, name } = {}) => {
    const n = ++count;
    const row = auth.insertUser({ username: 'team.synthetic.' + n, name: name ?? 'Pessoa sintética ' + n }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, resellerId);
    store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(permissions === null ? null : JSON.stringify(permissions), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  };
  const admin = user({ role: 'reseller' }), otherAdmin = user({ role: 'reseller' });
  const tenant = store.createTenant(admin, { name: 'Equipe sintética', segment: 'QA' }), second = store.createTenant(admin, { name: 'Segunda equipe', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture: atendimento sintético', state => {
    state.channels = [{ id: 'same-channel', name: 'Canal sintético', kind: 'whatsapp_qr' }, { id: 'hidden-channel', kind: 'telegram' }];
    state.departments = [{ id: 'same-department', name: 'Depto sintético' }];
    state.conversations = [{ id: 'same-conversation', contact: 'Contato sintético', channelId: 'same-channel', departmentId: 'same-department', version: 1, messages: [{ text: 'Segredo de cliente que não pode entrar no chat.' }] }];
  });
  const alice = user({ tenantIds: [tenant.id], permissions: [] }), bob = user({ tenantIds: [tenant.id] }), outsider = user({ tenantIds: [tenant.id] });
  const chat = new TeamChat(store, auth); new Outbox(store);
  const room = members => chat.createRoom(admin, tenant.id, { name: 'Sala sintética', memberIds: members ?? [alice.userId, bob.userId] });
  const send = (r, actor = bob, extra = {}) => chat.send(actor, tenant.id, r.id, { version: r.version, text: 'Texto sintético privado', requestId: randomUUID(), ...extra });
  const auditCount = () => store.db.prepare('SELECT count(*) AS n FROM team_chat_audit').get().n;
  return { store, auth, admin, otherAdmin, tenant, second, alice, bob, outsider, chat, user, room, send, auditCount };
}

test('foto de perfil atual é raster autorizado por sala/empresa; revogado/retirado/valor não confiável não expõe foto', t => {
  const c = fixture(t); c.store.db.prepare('UPDATE auth_users SET avatar=? WHERE id=?').run(photo, c.bob.userId);
  const room = c.room(); assert.equal(room.members.find(person => person.id === c.bob.userId).avatar, photo);
  assert.equal(c.chat.directory(c.admin, c.tenant.id).users.find(person => person.id === c.bob.userId).avatar, photo);
  const sent = c.send(room, { ...c.bob, avatar: 'https://forged.test/private.png' }); assert.deepEqual(sent.author, { id: c.bob.userId, name: c.bob.name });
  c.store.db.prepare('UPDATE auth_users SET avatar=? WHERE id=?').run('data:image/svg+xml;base64,PHN2Zz4=', c.bob.userId);
  assert.equal(c.chat.getRoom(c.admin, c.tenant.id, room.id).members.find(person => person.id === c.bob.userId).avatar, null);
  c.store.db.prepare('UPDATE auth_users SET avatar=?,disabled_at=? WHERE id=?').run(photo, new Date().toISOString(), c.bob.userId);
  const disabled = c.chat.getRoom(c.admin, c.tenant.id, room.id).members.find(person => person.id === c.bob.userId); assert.equal(disabled.eligible, false); assert.equal(disabled.avatar, null);
  assert.equal(c.chat.directory(c.admin, c.tenant.id).users.some(person => person.id === c.bob.userId), false);
  assert.throws(() => c.chat.getRoom(c.bob, c.tenant.id, room.id), status(403)); assert.throws(() => c.chat.getRoom(c.admin, c.second.id, room.id), status(404));
  c.store.db.prepare('UPDATE auth_users SET disabled_at=NULL,tenant_ids=? WHERE id=?').run(JSON.stringify([c.second.id]), c.bob.userId);
  assert.equal(c.chat.getRoom(c.admin, c.tenant.id, room.id).members.find(person => person.id === c.bob.userId).avatar, null);
  c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 1, action: 'remove', userId: c.bob.userId });
  assert.equal(c.chat.getRoom(c.admin, c.tenant.id, room.id).members.some(person => person.id === c.bob.userId), false);
  assert.deepEqual(c.chat.messages(c.admin, c.tenant.id, room.id).messages[0].author, { id: c.bob.userId, name: c.bob.name });
});

test('chat interno humano usa namespace próprio; diretório independe da inbox e gestão revalida papel persistido', t => {
  const c = fixture(t), room = c.room();
  assert.equal(room.version, 1); assert.equal(room.canManage, true); assert.equal(room.memberCount, 3);
  assert.equal(room.members.some(member => member.id === c.admin.userId), true);
  assert.equal(c.chat.getRoom(c.alice, c.tenant.id, room.id).canManage, false);
  assert.equal(c.chat.directory(c.admin, c.tenant.id).users.some(user => user.id === c.alice.userId), true);
  assert.throws(() => c.chat.directory({ ...c.alice, role: 'reseller' }, c.tenant.id), status(403));
  assert.throws(() => c.chat.createRoom({ ...c.alice, role: 'reseller' }, c.tenant.id, { name: 'Forjada', memberIds: [] }), status(403));
  assert.throws(() => c.chat.updateMembers({ ...c.alice, role: 'reseller' }, c.tenant.id, room.id, { version: 1, action: 'add', userId: c.outsider.userId }), status(403));
  const message = c.send(room, { ...c.alice, name: 'Nome forjado', role: 'reseller' });
  assert.deepEqual(message.author, { id: c.alice.userId, name: c.alice.name });
  assert.equal(c.chat.getRoom(c.alice, c.tenant.id, room.id).version, 1);
});

test('administrador sem membership não vê salas ou mensagens, não envia, não marca leitura nem altera membros', t => {
  const c = fixture(t), room = c.room(); c.send(room);
  assert.deepEqual(c.chat.listRooms(c.otherAdmin, c.tenant.id).rooms, []);
  for (const actor of [c.otherAdmin, c.outsider]) {
    assert.throws(() => c.chat.getRoom(actor, c.tenant.id, room.id), status(403));
    assert.throws(() => c.chat.messages(actor, c.tenant.id, room.id), status(403));
    assert.throws(() => c.send(room, actor), status(403));
    assert.throws(() => c.chat.markRead(actor, c.tenant.id, room.id, { sequence: 1 }), status(403));
  }
  assert.throws(() => c.chat.updateMembers(c.otherAdmin, c.tenant.id, room.id, { version: 1, action: 'add', userId: c.outsider.userId }), status(403));
});

test('CAS de membros tem um vencedor, noop não audita e criador pode ser removido por outro administrador', t => {
  const c = fixture(t), room = c.room();
  const added = c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 1, action: 'add', userId: c.otherAdmin.userId });
  assert.equal(added.version, 2); const audits = c.auditCount();
  assert.throws(() => c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 1, action: 'remove', userId: c.bob.userId }), status(409));
  assert.equal(c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 2, action: 'add', userId: c.otherAdmin.userId }).version, 2);
  assert.equal(c.auditCount(), audits);
  assert.throws(() => c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 2, action: 'remove', userId: c.admin.userId }), status(409));
  const removed = c.chat.updateMembers(c.otherAdmin, c.tenant.id, room.id, { version: 2, action: 'remove', userId: c.admin.userId });
  assert.equal(removed.version, 3); assert.equal(removed.members.some(member => member.id === c.admin.userId), false);
  assert.throws(() => c.chat.getRoom(c.admin, c.tenant.id, room.id), status(403));
  assert.throws(() => c.chat.updateMembers(c.otherAdmin, c.tenant.id, room.id, { version: 3, action: 'remove', userId: c.otherAdmin.userId }), status(409));
});

test('idempotência é por sala+autor, conflito muda payload, replay não exige CAS antigo mas exige membership atual', t => {
  const c = fixture(t), room = c.room(), requestId = randomUUID();
  const first = c.send(room, c.bob, { requestId }), audits = c.auditCount();
  assert.deepEqual(c.send(room, c.bob, { requestId }), first); assert.equal(c.auditCount(), audits);
  assert.throws(() => c.send(room, c.bob, { requestId, text: 'Conteúdo diferente' }), status(409));
  assert.equal(c.send(room, c.alice, { requestId }).sequence, 2);
  const other = c.room(); assert.equal(c.send(other, c.bob, { requestId }).sequence, 1);
  const updated = c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 1, action: 'add', userId: c.outsider.userId });
  assert.deepEqual(c.send(room, c.bob, { requestId }), first);
  assert.throws(() => c.send(room), status(409));
  c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: updated.version, action: 'remove', userId: c.bob.userId });
  assert.throws(() => c.send(room, c.bob, { requestId }), status(403));
  assert.throws(() => c.chat.messages(c.bob, c.tenant.id, room.id), status(403));
});

test('revogar empresa ou desabilitar humano corta lookup/lista/leitura/envio/replay imediatamente', t => {
  const c = fixture(t), room = c.room(), requestId = randomUUID(); c.send(room, c.bob, { requestId });
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=? WHERE id=?').run(JSON.stringify([c.second.id]), c.bob.userId);
  for (const read of [() => c.chat.listRooms(c.bob, c.tenant.id), () => c.chat.getRoom(c.bob, c.tenant.id, room.id), () => c.chat.messages(c.bob, c.tenant.id, room.id), () => c.send(room, c.bob, { requestId }), () => c.chat.markRead(c.bob, c.tenant.id, room.id, { sequence: 1 })]) assert.throws(read, status(403));
  assert.equal(c.chat.getRoom(c.admin, c.tenant.id, room.id).members.find(member => member.id === c.bob.userId).eligible, false);
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=?,disabled_at=1 WHERE id=?').run(JSON.stringify([c.tenant.id]), c.bob.userId);
  assert.throws(() => c.send(room, c.bob, { requestId }), status(403));
  assert.equal(c.chat.directory(c.admin, c.tenant.id).users.some(user => user.id === c.bob.userId), false);
});

test('lifecycle releaseUser retira membership duravelmente mesmo disabled/regrant e não atribui outro admin', t => {
  const c = fixture(t), room = c.room(), other = c.room(), requestId = randomUUID(); c.send(room, c.bob, { requestId });
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=? WHERE id=?').run(JSON.stringify([c.second.id]), c.bob.userId);
  assert.throws(() => c.chat.releaseUser({ ...c.alice, role: 'reseller' }, c.bob.userId), status(403));
  const released = c.chat.releaseUser(c.admin, c.bob.userId);
  assert.equal(released.length, 2); assert.equal(released.every(item => item.version === 2 && item.tenantId === c.tenant.id), true);
  const audits = c.auditCount(); assert.deepEqual(c.chat.releaseUser(c.admin, c.bob.userId), []); assert.equal(c.auditCount(), audits);
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=? WHERE id=?').run(JSON.stringify([c.tenant.id]), c.bob.userId);
  assert.throws(() => c.send(room, c.bob, { requestId }), status(403)); assert.deepEqual(c.chat.listRooms(c.bob, c.tenant.id).rooms, []);
  c.store.db.prepare('UPDATE auth_users SET disabled_at=1 WHERE id=?').run(c.admin.userId);
  const disabledCreator = c.chat.releaseUser(c.otherAdmin, c.admin.userId); assert.equal(disabledCreator.length, 2);
  assert.equal(c.chat.getRoom(c.alice, c.tenant.id, other.id).members.some(member => member.id === c.admin.userId), false);
  assert.throws(() => c.chat.getRoom(c.otherAdmin, c.tenant.id, room.id), status(403));
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n, 0);
});

test('releaseUser se limita ao workspace do administrador e mudança de papel invalida sessões de gestão', t => {
  const c = fixture(t), room = c.room([c.otherAdmin.userId]);
  const resellerId = 'reseller_' + randomUUID(), tenantId = 'tenant_' + randomUUID();
  c.store.provisionReseller({ resellerId, tenantId, name: 'Workspace isolado' }); const foreignAdmin = c.user({ role: 'reseller', resellerId });
  const foreignRoom = c.chat.createRoom(foreignAdmin, tenantId, { name: 'Sala isolada', memberIds: [] });
  assert.deepEqual(c.chat.releaseUser(c.admin, foreignAdmin.userId), []); assert.equal(c.chat.getRoom(foreignAdmin, tenantId, foreignRoom.id).version, 1);
  c.store.db.prepare("UPDATE auth_users SET role='operator',tenant_ids=? WHERE id=?").run(JSON.stringify([c.tenant.id]), c.otherAdmin.userId);
  assert.throws(() => c.chat.releaseUser(c.otherAdmin, c.admin.userId), status(403));
  c.chat.releaseUser(c.admin, c.otherAdmin.userId);
  c.store.db.prepare("UPDATE auth_users SET role='reseller',tenant_ids='[]' WHERE id=?").run(c.otherAdmin.userId);
  assert.throws(() => c.chat.getRoom(c.otherAdmin, c.tenant.id, room.id), status(403));
});

test('releaseUser filtra empresas revogadas, preserva salas mantidas e [] não altera CAS/audit', t => {
  const c = fixture(t), member = c.user({ tenantIds: [c.tenant.id, c.second.id] });
  const revoked = c.room([member.userId]), kept = c.chat.createRoom(c.admin, c.second.id, { name: 'Sala mantida', memberIds: [member.userId] });
  const keptMessage = c.chat.send(member, c.second.id, kept.id, { version: 1, text: 'Permanece privado', requestId: randomUUID() });
  const audits = c.auditCount();
  assert.deepEqual(c.chat.releaseUser(c.admin, member.userId, { tenantIds: [] }), []); assert.equal(c.auditCount(), audits);
  assert.equal(c.chat.getRoom(member, c.tenant.id, revoked.id).version, 1);
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=? WHERE id=?').run(JSON.stringify([c.second.id]), member.userId);
  const released = c.chat.releaseUser(c.admin, member.userId, { tenantIds: [c.tenant.id, c.tenant.id] });
  assert.deepEqual(released, [{ tenantId: c.tenant.id, roomId: revoked.id, version: 2 }]); assert.equal(c.auditCount(), audits + 1);
  assert.equal(c.chat.getRoom(member, c.second.id, kept.id).version, 1);
  assert.deepEqual(c.chat.messages(member, c.second.id, kept.id).messages, [keptMessage]);
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=? WHERE id=?').run(JSON.stringify([c.tenant.id, c.second.id]), member.userId);
  assert.throws(() => c.chat.getRoom(member, c.tenant.id, revoked.id), status(403));
  assert.equal(c.chat.getRoom(member, c.second.id, kept.id).members.some(person => person.id === member.userId), true);
  assert.deepEqual(c.chat.releaseUser(c.admin, member.userId, { tenantIds: ['missing-company'] }), []);
  assert.throws(() => c.chat.releaseUser({ ...member, role: 'reseller' }, member.userId, { tenantIds: [] }), status(403));
  for (const options of [{ tenantIds: null }, { tenantIds: 'company' }, { tenantIds: [''] }, { tenantIds: [' padded '] }, { tenantIds: ['x'.repeat(121)] }, { tenantIds: [], role: 'reseller' }]) assert.throws(() => c.chat.releaseUser(c.admin, member.userId, options), status(400));
  assert.deepEqual(c.chat.releaseUser(c.admin, member.userId), [{ tenantId: c.second.id, roomId: kept.id, version: 2 }]);
});

test('colisão de room/message/request IDs não une escopos e FKs rejeitam empresa de outra revenda', t => {
  const c = fixture(t), first = c.room(), id = first.id;
  const resellerId = 'reseller_' + randomUUID(), tenantId = 'tenant_' + randomUUID();
  c.store.provisionReseller({ resellerId, tenantId, name: 'Revenda isolada' }); const foreignAdmin = c.user({ role: 'reseller', resellerId });
  const date = new Date().toISOString();
  c.store.db.prepare('INSERT INTO team_chat_rooms VALUES (?,?,?,?,1,?,?,?,?,0)').run('mep-demo', c.second.id, id, 'Mesmo ID empresa B', date, date, c.admin.userId, c.admin.name);
  c.store.db.prepare('INSERT INTO team_chat_members VALUES (?,?,?,?,?,?,0)').run('mep-demo', c.second.id, id, c.admin.userId, date, c.admin.userId);
  c.store.db.prepare('INSERT INTO team_chat_rooms VALUES (?,?,?,?,1,?,?,?,?,0)').run(resellerId, tenantId, id, 'Mesmo ID revenda B', date, date, foreignAdmin.userId, foreignAdmin.name);
  c.store.db.prepare('INSERT INTO team_chat_members VALUES (?,?,?,?,?,?,0)').run(resellerId, tenantId, id, foreignAdmin.userId, date, foreignAdmin.userId);
  const requestId = randomUUID(), one = c.send(first, c.admin, { requestId });
  const two = c.chat.send(c.admin, c.second.id, id, { version: 1, text: 'Empresa B', requestId });
  const three = c.chat.send(foreignAdmin, tenantId, id, { version: 1, text: 'Revenda B', requestId });
  c.store.db.prepare('UPDATE team_chat_messages SET id=? WHERE reseller_id=? AND tenant_id=? AND room_id=?').run(one.id, 'mep-demo', c.second.id, id);
  c.store.db.prepare('UPDATE team_chat_messages SET id=? WHERE reseller_id=? AND tenant_id=? AND room_id=?').run(one.id, resellerId, tenantId, id);
  assert.equal(one.sequence, 1); assert.equal(two.sequence, 1); assert.equal(three.sequence, 1);
  assert.equal(c.chat.messages(c.admin, c.tenant.id, id).messages[0].text, one.text);
  assert.equal(c.chat.messages(c.admin, c.second.id, id).messages[0].text, 'Empresa B');
  assert.equal(c.chat.messages(foreignAdmin, tenantId, id).messages[0].text, 'Revenda B');
  assert.equal(c.chat.messages(c.admin, c.second.id, id).messages[0].id, one.id);
  assert.equal(c.chat.messages(foreignAdmin, tenantId, id).messages[0].id, one.id);
  assert.throws(() => c.chat.getRoom(c.admin, tenantId, id), status(404));
  assert.throws(() => c.chat.getRoom({ ...c.admin, resellerId }, tenantId, id), status(403));
  assert.throws(() => c.chat.createRoom(c.admin, c.tenant.id, { name: 'Fuga', memberIds: [foreignAdmin.userId] }), status(400));
  assert.throws(() => c.store.db.prepare('INSERT INTO team_chat_rooms VALUES (?,?,?,?,1,?,?,?,?,0)').run(resellerId, c.tenant.id, 'bad-scope', 'Proibida', date, date, foreignAdmin.userId, foreignAdmin.name), /FOREIGN KEY/);
});

test('admin da plataforma segue grant persistido de workspace e sua retirada bloqueia replay', t => {
  const c = fixture(t), resellerId = 'reseller_' + randomUUID(), tenantId = 'tenant_' + randomUUID();
  c.store.provisionReseller({ resellerId, tenantId, name: 'Workspace sintético' });
  c.store.db.prepare('UPDATE auth_users SET platform_admin=1 WHERE id=?').run(c.admin.userId);
  c.store.db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,?)').run(c.admin.userId, resellerId, Date.now());
  const scoped = { ...c.admin, resellerId }, room = c.chat.createRoom(scoped, tenantId, { name: 'Sala plataforma', memberIds: [] }), requestId = randomUUID();
  c.chat.send(scoped, tenantId, room.id, { version: 1, text: 'Privado', requestId });
  c.store.db.prepare('DELETE FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').run(c.admin.userId, resellerId);
  assert.throws(() => c.chat.send(scoped, tenantId, room.id, { version: 1, text: 'Privado', requestId }), status(403));
});

test('paginação usa sequência ascendente, limites, before/after exclusivos e cursor de leitura monotônico', t => {
  const c = fixture(t), room = c.room();
  for (let index = 0; index < 105; index++) c.send(room, index % 2 ? c.alice : c.bob);
  const initial = c.chat.messages(c.bob, c.tenant.id, room.id);
  assert.equal(initial.messages.length, 50); assert.equal(initial.messages[0].sequence, 56); assert.equal(initial.messages.at(-1).sequence, 105); assert.equal(initial.hasMore, true);
  const older = c.chat.messages(c.bob, c.tenant.id, room.id, { before: initial.before });
  assert.equal(older.messages[0].sequence, 6); assert.equal(older.messages.at(-1).sequence, 55);
  const after = c.chat.messages(c.bob, c.tenant.id, room.id, { after: 100, limit: 100 });
  assert.deepEqual(after.messages.map(message => message.sequence), [101, 102, 103, 104, 105]); assert.equal(after.hasMore, false);
  assert.equal(c.chat.getRoom(c.bob, c.tenant.id, room.id).unreadCount, 52);
  const read = c.chat.markRead(c.bob, c.tenant.id, room.id, { sequence: 100 }); assert.equal(read.unreadCount, 2);
  const audits = c.auditCount(); assert.equal(c.chat.markRead(c.bob, c.tenant.id, room.id, { sequence: 50 }).readSequence, 100); assert.equal(c.auditCount(), audits);
  assert.throws(() => c.chat.markRead(c.bob, c.tenant.id, room.id, { sequence: 106 }), status(400));
  for (const options of [{ before: 1, after: 0 }, { before: 0 }, { after: -1 }, { limit: 101 }, { limit: 0 }, { after: '1' }]) assert.throws(() => c.chat.messages(c.bob, c.tenant.id, room.id, options), status(400));
});

test('referência guarda só ID e exige inbox.read atual por canal/departamento sem ampliar acesso da sala', t => {
  const c = fixture(t), room = c.room(), requestId = randomUUID();
  assert.throws(() => c.send(room, c.alice, { conversationId: 'same-conversation' }), status(403));
  assert.throws(() => c.send(room, c.bob, { conversationId: 'missing-conversation' }), status(403));
  const sent = c.send(room, c.bob, { conversationId: 'same-conversation', requestId });
  assert.deepEqual(sent.reference, { conversationId: 'same-conversation', contact: 'Contato sintético', channelId: 'same-channel', departmentId: 'same-department' });
  c.store.mutate(c.admin, c.second.id, 'Fixture: referência colidindo', state => {
    state.channels = [{ id: 'same-channel', kind: 'whatsapp_qr' }]; state.departments = [{ id: 'same-department' }];
    state.conversations = [{ id: 'same-conversation', contact: 'Outro contato protegido', channelId: 'same-channel', departmentId: 'same-department', messages: [] }];
  });
  const secondRoom = c.chat.createRoom(c.admin, c.second.id, { name: 'Referência empresa B', memberIds: [] });
  assert.equal(c.chat.send(c.admin, c.second.id, secondRoom.id, { version: 1, text: 'Referência B', requestId: randomUUID(), conversationId: 'same-conversation' }).reference.contact, 'Outro contato protegido');
  assert.equal(c.chat.messages(c.bob, c.tenant.id, room.id).messages[0].reference.contact, 'Contato sintético');
  assert.deepEqual(c.chat.messages(c.alice, c.tenant.id, room.id).messages[0].reference, { unavailable: true });
  assert.equal(c.chat.messages(c.bob, c.tenant.id, room.id).messages[0].reference.conversationId, 'same-conversation');
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { channelIds: ['hidden-channel'] } }), c.bob.userId);
  assert.deepEqual(c.chat.messages(c.bob, c.tenant.id, room.id).messages[0].reference, { unavailable: true });
  assert.deepEqual(c.send(room, c.bob, { conversationId: 'same-conversation', requestId }).reference, { unavailable: true });
  assert.throws(() => c.send(room, c.bob, { conversationId: 'same-conversation' }), status(403));
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { departmentIds: ['unassigned'] } }), c.bob.userId);
  assert.deepEqual(c.chat.messages(c.bob, c.tenant.id, room.id).messages[0].reference, { unavailable: true });
  c.store.db.prepare('UPDATE auth_users SET scope_rules=NULL WHERE id=?').run(c.bob.userId);
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: retirada referência', state => { state.conversations = []; });
  assert.deepEqual(c.chat.messages(c.bob, c.tenant.id, room.id).messages[0].reference, { unavailable: true });
  const stored = c.store.db.prepare('SELECT conversation_id,text FROM team_chat_messages WHERE tenant_id=?').get(c.tenant.id); assert.equal(stored.conversation_id, 'same-conversation');
  assert.equal(JSON.stringify(stored).includes('Segredo de cliente'), false);
});

test('mensagem, sequência e audit são atômicos; falha de audit ou leitura não deixa escrita parcial', t => {
  const c = fixture(t), room = c.room(), requestId = randomUUID(), audits = c.auditCount();
  c.store.db.exec("CREATE TRIGGER team_chat_test_abort BEFORE INSERT ON team_chat_audit WHEN NEW.action='message-created' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  assert.throws(() => c.send(room, c.bob, { requestId }), /fixture audit failure/);
  assert.equal(c.chat.getRoom(c.bob, c.tenant.id, room.id).lastSequence, 0); assert.equal(c.chat.messages(c.bob, c.tenant.id, room.id).messages.length, 0); assert.equal(c.auditCount(), audits);
  c.store.db.exec('DROP TRIGGER team_chat_test_abort'); assert.equal(c.send(room, c.bob, { requestId }).sequence, 1);
  c.store.db.exec("CREATE TRIGGER team_chat_test_abort BEFORE INSERT ON team_chat_audit WHEN NEW.action='read-advanced' BEGIN SELECT RAISE(ABORT,'fixture cursor failure'); END");
  assert.throws(() => c.chat.markRead(c.alice, c.tenant.id, room.id, { sequence: 1 }), /fixture cursor failure/);
  assert.equal(c.chat.getRoom(c.alice, c.tenant.id, room.id).readSequence, 0);
});

test('limites de 30 membros/100 salas e campos fechados evitam falsa autoria, mídia ou payload excessivo', t => {
  const c = fixture(t), people = Array.from({ length: 30 }, () => c.user({ tenantIds: [c.tenant.id] }));
  assert.throws(() => c.room(people.map(person => person.userId)), status(409));
  const room = c.room(people.slice(0, 29).map(person => person.userId)); assert.equal(room.memberCount, 30);
  assert.throws(() => c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 1, action: 'add', userId: people[29].userId }), status(409));
  for (let index = 1; index < 100; index++) c.room([]);
  assert.throws(() => c.room([]), status(409));
  const invalid = [ { name: 'x'.repeat(81) }, { name: '' }, { name: 'Bom', memberIds: ['fake-person'] }, { name: 'Bom', author: 'Outro' } ];
  for (const input of invalid) assert.throws(() => c.chat.createRoom(c.admin, c.second.id, input), status(400));
  for (const extra of [{ text: 'x'.repeat(4001) }, { text: ' ' }, { requestId: 'short' }, { requestId: 'x'.repeat(101) }, { requestId: 'invalid request id' }, { media: {} }, { author: c.admin.userId }, { version: 0 }, { createdAt: 'forged' }]) assert.throws(() => c.send(room, c.admin, extra), status(400));
});

test('chat não altera tenant JSON, auditoria global, outbox, projeção PG nem permissões/MCP', t => {
  const c = fixture(t), original = c.store.db.prepare('SELECT data FROM tenants ORDER BY id').all(), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const users = c.store.db.prepare('SELECT id,permissions,scope_rules,tenant_ids FROM auth_users ORDER BY id').all();
  let projection = 0; c.store.queuePostgres = () => { projection++; };
  const room = c.room(); c.send(room); c.chat.markRead(c.alice, c.tenant.id, room.id, { sequence: 1 }); c.chat.updateMembers(c.admin, c.tenant.id, room.id, { version: 1, action: 'remove', userId: c.bob.userId });
  assert.deepEqual(c.store.db.prepare('SELECT data FROM tenants ORDER BY id').all(), original);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
  assert.deepEqual(c.store.db.prepare('SELECT id,permissions,scope_rules,tenant_ids FROM auth_users ORDER BY id').all(), users);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n, 0); assert.equal(projection, 0);
  const audit = c.store.db.prepare('SELECT metadata FROM team_chat_audit').all(); assert.equal(JSON.stringify(audit).includes('Texto sintético privado'), false);
  assert.deepEqual(c.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('backup SQLite cifrado existente inclui tabelas privadas, restaura FKs e conserva mensagens/cursor/idempotência', async t => {
  const c = fixture(t), room = c.room(), requestId = randomUUID(), message = c.send(room, c.bob, { requestId });
  c.chat.markRead(c.alice, c.tenant.id, room.id, { sequence: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'mepchat-team-chat-test-'));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir())); assert.equal(basename(directory).startsWith('mepchat-team-chat-test-'), true);
    await rm(directory, { recursive: true, force: true });
  });
  const key = randomBytes(32), backup = await createLocalBackup(c.store.db, { destination: join(directory, 'encrypted'), key });
  const expected = ['team_chat_rooms', 'team_chat_members', 'team_chat_messages', 'team_chat_audit'];
  assert.equal(expected.every(table => backup.verification.tables.includes(table)), true);
  assert.equal(backup.verification.restoreVerified, true);
  assert.equal((await validateBackup(backup.file, { key })).foreignKeys, 'ok');
  assert.equal((await readFile(backup.file)).includes(Buffer.from(message.text)), false);
  const snapshot = join(directory, 'restore.sqlite'); c.store.db.prepare('VACUUM INTO ?').run(snapshot);
  const restored = new Store(snapshot);
  try {
    const auth = new Auth(restored.db, { validateTenant: (actor, id) => restored.tenant(actor, id) }), chat = new TeamChat(restored, auth);
    assert.equal(chat.getRoom(c.alice, c.tenant.id, room.id).readSequence, 1);
    assert.deepEqual(chat.messages(c.bob, c.tenant.id, room.id).messages[0], message);
    assert.deepEqual(chat.send(c.bob, c.tenant.id, room.id, { version: 1, text: message.text, requestId }), message);
    assert.equal(chat.send(c.bob, c.tenant.id, room.id, { version: 1, text: 'Após restore', requestId: randomUUID() }).sequence, 2);
    assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { restored.close(); }
});
