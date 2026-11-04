import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations, clearConversationParticipants } from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
import { createAttendanceService } from '../src/attendance.js';

const status = code => error => error.status === code;
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  let userCount = 0, conversationCount = 0;
  const user = ({ role = 'operator', tenantIds = [], resellerId = 'mep-demo', permissions = null } = {}) => {
    const n = ++userCount, row = auth.insertUser({ username: 'participants.synthetic.' + n, name: 'Pessoa sintética ' + n }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, resellerId);
    store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(permissions === null ? null : JSON.stringify(permissions), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  };
  const admin = user({ role: 'reseller' }), tenant = store.createTenant(admin, { name: 'Equipe sintética', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture: canais', state => { state.channels = [{ id: 'wa', kind: 'whatsapp_qr' }, { id: 'tg', kind: 'telegram' }]; state.agents = [{ id: 'copilot', name: 'Copiloto sintético', mode: 'copilot', configured: true }]; });
  const operations = new Operations(store, auth, { now: () => Date.parse('2026-10-02T13:00:00Z') });
  new Outbox(store, { authorize: (actor, id, conversation) => operations.canReply(actor, id, conversation) });
  const alice = user({ tenantIds: [tenant.id] }), bob = user({ tenantIds: [tenant.id] }), carol = user({ tenantIds: [tenant.id] });
  const observer = user({ tenantIds: [tenant.id], permissions: ['inbox.read'] });
  const department = operations.create(admin, tenant.id, { name: 'Suporte sintético', memberIds: [alice.userId, bob.userId, carol.userId] });
  const conversation = (extra = {}) => {
    const c = { id: 'participants-conversation-' + ++conversationCount, contact: 'Contato sintético', channelId: 'wa', departmentId: department.id, department: department.name,
      status: 'open', owner: 'human', assignedUserId: alice.userId, assignedUserName: alice.name, version: 1, messages: [], ...extra };
    store.mutate(admin, tenant.id, 'Fixture: conversa', state => state.conversations.push(c)); return c;
  };
  const get = id => operations.conversation(store.tenant(admin, tenant.id), id);
  const add = (c, target = bob, actor = alice, extra = {}) => operations.updateParticipants(actor, tenant.id, c.id, { version: c.version, action: 'add', userId: target.userId, ...extra });
  const mutate = (id, fn) => store.mutate(admin, tenant.id, 'Fixture: mudança concorrente', state => fn(operations.conversation(state, id), state));
  const auditCount = () => store.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
  const noOutbox = () => assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbound_commands').get().count, 0);
  const authorize = (actor, id, c, permission) => auth.can(actor, permission, { tenantId: id, channelId: c.channelId, departmentId: c.departmentId || 'unassigned' });
  const attendance = createAttendanceService(store, { authorize, requireReply: (actor, id, c) => operations.canReply(actor, id, c) });
  return { store, auth, operations, admin, tenant, alice, bob, carol, observer, department, user, conversation, get, add, mutate, auditCount, noOutbox, attendance, authorize };
}

test('participantes preservam responsável, registram autoria/CAS e não criam grants, mensagem ou outbox', t => {
  const c = fixture(t), original = c.conversation(), added = c.add(original, c.bob, c.alice, { reason: 'Apoio técnico' });
  assert.equal(added.version, 2); assert.equal(added.assignedUserId, c.alice.userId); assert.deepEqual(added.messages, []);
  assert.deepEqual(added.participants, [{ userId: c.bob.userId, name: c.bob.name, addedAt: '2026-10-02T13:00:00.000Z', addedByUserId: c.alice.userId }]);
  assert.equal(added.attendantEvents[0].type, 'participant-added'); assert.equal(added.attendantEvents[0].actorId, c.alice.userId); assert.equal(added.attendantEvents[0].reason, 'Apoio técnico');
  assert.equal(added.attendantEvents[0].from.participants.length, 0); assert.equal(added.attendantEvents[0].to.participants[0].userId, c.bob.userId);
  const roster = c.operations.participants(c.alice, c.tenant.id, original.id);
  assert.deepEqual(roster.responsible, { id: c.alice.userId, name: c.alice.name }); assert.equal(roster.canManage, true);
  assert.equal(roster.participants[0].eligible, true); assert.equal(roster.eligible.some(person => [c.alice.userId, c.bob.userId].includes(person.id)), false);
  assert.deepEqual(c.operations.attendanceAccess(c.bob, c.tenant.id, added), { canReply: true, canManageParticipants: false });
  assert.deepEqual(c.operations.attendanceAccess(c.observer, c.tenant.id, added), { canReply: false, canManageParticipants: false });
  const observed = c.operations.participants(c.observer, c.tenant.id, original.id); assert.equal(observed.canManage, false); assert.deepEqual(observed.eligible, []);
  const audits = c.auditCount(); assert.equal(c.add(added).version, 2); assert.equal(c.auditCount(), audits);
  assert.equal(c.operations.updateParticipants(c.alice, c.tenant.id, original.id, { version: 2, action: 'remove', userId: c.carol.userId }).version, 2); assert.equal(c.auditCount(), audits);
  const removed = c.operations.updateParticipants(c.alice, c.tenant.id, original.id, { version: 2, action: 'remove', userId: c.bob.userId, reason: 'Apoio concluído' });
  assert.equal(removed.version, 3); assert.deepEqual(removed.participants, []); assert.equal(removed.attendantEvents.at(-1).type, 'participant-removed'); c.noOutbox();
});

test('gestão exige responsável ou papel persistido de administrador; CAS impede dois vencedores', t => {
  const c = fixture(t), original = c.conversation();
  for (const actor of [c.bob, { ...c.bob, role: 'reseller' }, c.observer]) assert.throws(() => c.add(original, c.carol, actor), status(403));
  const added = c.add(original); assert.throws(() => c.add(original, c.carol, c.admin), status(409));
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read', 'inbox.reply']), c.alice.userId);
  assert.throws(() => c.operations.updateParticipants(c.alice, c.tenant.id, original.id, { version: added.version, action: 'remove', userId: c.bob.userId }), status(403));
  assert.throws(() => c.operations.assign(c.alice, c.tenant.id, original.id, { version: added.version, owner: 'human' }), status(403), 'Self-assumir não pode contornar gestão e retirar colaboradores');
  assert.equal(c.get(original.id).participants.length, 1);
  const managed = c.add(added, c.carol, c.admin); assert.equal(managed.participants.length, 2);
  assert.throws(() => c.add(managed, c.alice, c.admin), status(400));
  assert.throws(() => c.operations.updateParticipants(c.admin, c.tenant.id, original.id, { version: managed.version, action: 'add', userId: c.bob.userId, participants: [] }), status(400));
});

test('admissão exige pessoa atual do canal/departamento/empresa e limita vinte adicionais', t => {
  const c = fixture(t), original = c.conversation(), other = c.store.createTenant(c.admin, { name: 'Empresa alheia', segment: 'QA' });
  const foreign = c.user({ tenantIds: [other.id] }), inactive = c.user({ tenantIds: [c.tenant.id] }); c.auth.disableUser(c.admin, inactive.userId);
  const hidden = c.user({ tenantIds: [c.tenant.id] });
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { channelIds: ['tg'] } }), hidden.userId);
  for (const target of [foreign, inactive, hidden, c.observer, c.alice, { userId: 'nonexistent-person' }]) assert.throws(() => c.add(original, target), status(400));
  const additional = Array.from({ length: 21 }, () => c.user({ tenantIds: [c.tenant.id] }));
  c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, memberIds: [c.alice.userId, ...additional.map(person => person.userId)] });
  let current = original;
  for (const person of additional.slice(0, 20)) current = c.add(current, person);
  assert.equal(current.participants.length, 20); assert.throws(() => c.add(current, additional[20]), status(409)); c.noOutbox();
});

test('canReply ignora snapshot forjado e revê remoção, escopo, estado e elegibilidade de departamento', t => {
  const c = fixture(t), original = c.conversation();
  assert.throws(() => c.operations.canReply(c.bob, c.tenant.id, { ...original, assignedUserId: c.bob.userId, participants: [{ userId: c.bob.userId }] }), status(409));
  const added = c.add(original); assert.equal(c.operations.canReply(c.bob, c.tenant.id, added), true);
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.bob.userId);
  assert.throws(() => c.operations.canReply(c.bob, c.tenant.id, added), status(403));
  const managerView = c.operations.participants(c.alice, c.tenant.id, original.id); assert.equal(managerView.participants[0].eligible, false);
  assert.deepEqual(c.operations.participants(c.observer, c.tenant.id, original.id).participants, []);
  c.store.db.prepare('UPDATE auth_users SET permissions=NULL,scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { channelIds: ['tg'] } }), c.bob.userId);
  assert.throws(() => c.operations.canReply(c.bob, c.tenant.id, added), status(403));
  c.store.db.prepare('UPDATE auth_users SET scope_rules=NULL WHERE id=?').run(c.bob.userId);
  c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, memberIds: [c.alice.userId, c.carol.userId] });
  assert.throws(() => c.operations.canReply(c.bob, c.tenant.id, added), status(409));
  const removed = c.operations.updateParticipants(c.alice, c.tenant.id, original.id, { version: added.version, action: 'remove', userId: c.bob.userId });
  assert.deepEqual(removed.participants, []); assert.throws(() => c.operations.canReply(c.bob, c.tenant.id, added), status(409));
  c.mutate(original.id, stored => { stored.status = 'closed'; });
  assert.throws(() => c.operations.canReply(c.alice, c.tenant.id, original), status(409));
  assert.deepEqual(c.operations.attendanceAccess(c.alice, c.tenant.id, original), { canReply: false, canManageParticipants: false });
  c.noOutbox();
});

test('mudanças de responsável/fila/agente e self-assumir autorizados limpam roster e auditam retirada', t => {
  const c = fixture(t);
  for (const target of [{ owner: 'human' }, { owner: 'human', assignedUserId: c.carol.userId }, { owner: 'queue' }, { owner: 'agent', agentId: 'copilot' }]) {
    const original = c.conversation(), added = c.add(original);
    const assigned = c.operations.assign(c.alice, c.tenant.id, original.id, { version: added.version, ...target });
    assert.deepEqual(assigned.participants, []); assert.equal(assigned.version, 3);
    assert.equal(assigned.attendantEvents.some(event => event.type === 'participant-removed'), true);
    const event = assigned.attendantEvents.at(-1); assert.equal(event.type, 'assignment'); assert.equal(event.from.participants[0].userId, c.bob.userId); assert.deepEqual(event.to.participants, []);
    assert.throws(() => c.operations.canReply(c.bob, c.tenant.id, added), status(409));
  }
  c.noOutbox();
});

test('releaseUser remove participações abertas/fechadas sem devolver atendimento de outro responsável', t => {
  const c = fixture(t), owned = c.add(c.conversation()), assisting = c.add(c.conversation({ assignedUserId: c.bob.userId, assignedUserName: c.bob.name }), c.alice, c.bob);
  const closed = c.add(c.conversation({ assignedUserId: c.bob.userId, assignedUserName: c.bob.name }), c.alice, c.bob); c.mutate(closed.id, stored => { stored.status = 'closed'; });
  const untouched = c.conversation({ assignedUserId: c.carol.userId, assignedUserName: c.carol.name });
  c.auth.disableUser(c.admin, c.alice.userId);
  assert.throws(() => c.operations.canReply(c.alice, c.tenant.id, assisting), status(403));
  const released = c.operations.releaseUser(c.admin, c.alice.userId);
  assert.deepEqual(released.map(item => item.conversationId).sort(), [owned.id, assisting.id, closed.id].sort());
  assert.equal(c.get(owned.id).owner, 'queue'); assert.equal(c.get(owned.id).assignedUserId, null);
  for (const id of [assisting.id, closed.id]) { const stored = c.get(id); assert.equal(stored.assignedUserId, c.bob.userId); assert.deepEqual(stored.participants, []); assert.equal(stored.attendantEvents.at(-1).type, 'participant-removed'); assert.equal(stored.version, 3); }
  assert.equal(c.get(closed.id).status, 'closed'); assert.equal(c.get(untouched.id).version, 1); assert.deepEqual(c.operations.releaseUser(c.admin, c.alice.userId), []); c.noOutbox();
});

test('nota de participante e replay usam requireReply atual; removal/revoke bloqueiam recibo antigo', t => {
  const c = fixture(t), added = c.add(c.conversation()), command = { version: added.version, text: 'Nota interna sintética', commandId: 'participant-note' };
  const noted = c.attendance.addNote(c.bob, c.tenant.id, added.id, command); assert.equal(noted.version, 3); assert.equal(noted.messages[0].userId, c.bob.userId);
  const audits = c.auditCount(); assert.equal(c.attendance.addNote(c.bob, c.tenant.id, added.id, command).version, 3); assert.equal(c.auditCount(), audits);
  c.operations.updateParticipants(c.alice, c.tenant.id, added.id, { version: 3, action: 'remove', userId: c.bob.userId });
  assert.throws(() => c.attendance.addNote(c.bob, c.tenant.id, added.id, command), status(409));
  const second = c.add(c.conversation()), secondCommand = { version: second.version, text: 'Nota privada para revogação', commandId: 'participant-note-revoked' };
  c.attendance.addNote(c.bob, c.tenant.id, second.id, secondCommand);
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.bob.userId);
  assert.throws(() => c.attendance.addNote(c.bob, c.tenant.id, second.id, secondCommand), status(403));
  const fallback = createAttendanceService(c.store, { authorize: c.authorize });
  c.store.db.prepare('UPDATE auth_users SET permissions=NULL WHERE id=?').run(c.bob.userId);
  assert.throws(() => fallback.addNote(c.bob, c.tenant.id, second.id, { version: 3, text: 'Notas fixture antigas', commandId: 'fallback' }), status(409)); c.noOutbox();
});

test('isolamento, grants atuais, callback síncrono e erros inesperados não são escondidos por DTO', t => {
  const c = fixture(t), original = c.conversation(), other = c.store.createTenant(c.admin, { name: 'Outro tenant sintético', segment: 'QA' });
  c.store.mutate(c.admin, other.id, 'Fixture: colisão', state => { state.channels = [{ id: 'wa', kind: 'whatsapp_qr' }]; state.conversations = [{ ...original, participants: [{ userId: c.bob.userId }] }]; });
  assert.throws(() => c.operations.canReply(c.bob, other.id, original), status(403));
  const restricted = c.user({ tenantIds: [c.tenant.id] }); c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { channelIds: ['tg'] } }), restricted.userId);
  assert.throws(() => c.operations.attendanceAccess(restricted, c.tenant.id, original), status(403));
  assert.throws(() => c.operations.participants(restricted, c.tenant.id, original.id), status(403));
  const internal = { role: 'reseller', resellerId: 'mep-demo' }; assert.equal(c.operations.canReply(internal, c.tenant.id, original), true);
  const bad = createAttendanceService(c.store, { authorize: c.authorize, requireReply: () => Promise.resolve(true) });
  assert.throws(() => bad.addNote(c.alice, c.tenant.id, original.id, { version: 1, text: 'Callback assíncrono recusado', commandId: 'bad-callback' }), /síncrona/);
  c.operations.canReply = () => { throw Error('Erro inesperado sintético'); };
  assert.throws(() => c.operations.attendanceAccess(c.alice, c.tenant.id, original), /Erro inesperado/); c.noOutbox();
});

test('helper de lifecycle limpa uma vez, audita cada membro e deixa versão/transporte para o caller', t => {
  const c = fixture(t), first = c.add(c.conversation()), second = c.add(first, c.carol), originalVersion = second.version;
  const removed = clearConversationParticipants(second, c.admin, { reason: 'Atendimento encerrado', origin: 'gateway', createdAt: '2026-10-02T14:00:00Z' });
  assert.deepEqual(removed.map(item => item.userId), [c.bob.userId, c.carol.userId]); assert.deepEqual(second.participants, []);
  assert.equal(second.version, originalVersion); assert.deepEqual(second.messages, []);
  const events = second.attendantEvents.filter(event => event.type === 'participant-removed'); assert.equal(events.length, 2);
  assert.equal(events.every(event => event.from.participants.length === 2 && event.to.participants.length === 0 && event.reason === 'Atendimento encerrado' && event.origin === 'gateway' && event.createdAt === '2026-10-02T14:00:00Z'), true);
  assert.deepEqual(c.operations.clearParticipants(second, c.admin), []); assert.equal(second.attendantEvents.filter(event => event.type === 'participant-removed').length, 2); c.noOutbox();
});

test('snapshot de 200 conversas com 7501 contatos lê tenant/ator/roster uma vez sem assignees ou cache global', t => {
  const c = fixture(t), added = c.add(c.conversation()), ids = Array.from({ length: 200 }, (_, index) => 'snapshot-conversation-' + index);
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: escala do DTO', state => {
    state.contacts = Array.from({ length: 7501 }, (_, index) => ({ id: 'snapshot-contact-' + index, name: 'Contato sintético ' + index, identities: [], version: 1 }));
    state.conversations = ids.map(id => ({ ...added, id }));
  });
  const expected = { participants: c.operations.participants(c.alice, c.tenant.id, ids[0]).participants, attendance: c.operations.attendanceAccess(c.alice, c.tenant.id, { id: ids[0] }) };
  let tenantReads = 0, actorReads = 0, rosterQueries = 0;
  const originalTenant = c.store.tenant.bind(c.store), originalActor = c.auth.currentActor.bind(c.auth), originalPrepare = c.auth.db.prepare.bind(c.auth.db);
  c.store.tenant = (...args) => { tenantReads++; return originalTenant(...args); };
  c.auth.currentActor = (...args) => { actorReads++; return originalActor(...args); };
  c.auth.db.prepare = sql => { if (sql.includes('WHERE id IN (SELECT value FROM json_each(?)')) rosterQueries++; return originalPrepare(sql); };
  c.auth.can = c.auth.assignees = () => { throw Error('DTO em lote não deve resolver equipe nem reler tenant por permissão'); };
  const snapshots = c.operations.attendanceSnapshots(c.alice, c.tenant.id, ids.map(id => ({ id, owner: 'agent', participants: [] })));
  assert.equal(snapshots.size, 200); assert.deepEqual(snapshots.get(ids[0]), expected);
  assert.deepEqual({ tenantReads, actorReads, rosterQueries }, { tenantReads: 1, actorReads: 1, rosterQueries: 1 });
  assert.equal([...snapshots.values()].every(value => !Object.hasOwn(value, 'eligible') && value.participants[0].userId === c.bob.userId), true);
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.bob.userId);
  const revoked = c.operations.attendanceSnapshots(c.alice, c.tenant.id, ids);
  assert.equal(revoked.get(ids[0]).participants[0].eligible, false);
  assert.deepEqual({ tenantReads, actorReads, rosterQueries }, { tenantReads: 2, actorReads: 2, rosterQueries: 2 });
});

test('DTO em lote preserva escopos, elegibilidade, owner real e revogação atuais entre chamadas', t => {
  const c = fixture(t), added = c.add(c.conversation());
  for (const actor of [c.alice, c.bob, c.observer, c.admin]) {
    const expected = { participants: c.operations.participants(actor, c.tenant.id, added.id).participants, attendance: c.operations.attendanceAccess(actor, c.tenant.id, added) };
    assert.deepEqual(c.operations.attendanceSnapshots(actor, c.tenant.id, [{ ...added, assignedUserId: actor.userId }]).get(added.id), expected);
  }
  c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, memberIds: [c.alice.userId, c.carol.userId] });
  assert.deepEqual(c.operations.attendanceSnapshots(c.bob, c.tenant.id, [added]).get(added.id), { participants: [], attendance: { canReply: false, canManageParticipants: false } });
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { channelIds: ['tg'] } }), c.bob.userId);
  assert.throws(() => c.operations.attendanceSnapshots(c.bob, c.tenant.id, [added]), status(403));
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.alice.userId);
  const readOnly = c.operations.attendanceSnapshots(c.alice, c.tenant.id, [added]).get(added.id); assert.deepEqual(readOnly.attendance, { canReply: false, canManageParticipants: false });
  assert.deepEqual(readOnly.participants, []);
  c.auth.disableUser(c.admin, c.alice.userId); assert.throws(() => c.operations.attendanceSnapshots(c.alice, c.tenant.id, [added]), status(403));
  assert.throws(() => c.operations.attendanceSnapshots(c.admin, c.tenant.id, [{ id: 'unknown' }]), status(404));
});
