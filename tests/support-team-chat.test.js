import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { SupportAccess } from '../src/support-access.js';
import { TeamChat } from '../src/team-chat.js';
import { Outbox } from '../src/outbox.js';

const denied = error => error.status === 403 && /Saia do contexto de suporte temporário/.test(error.message);
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close()); const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); new Outbox(store);
  let sequence = 0;
  const human = (role, workspace = 'mep-demo', tenants = []) => { const n = ++sequence; return auth.actor(auth.insertUser({ username: 'support.team.' + n, name: 'Pessoa sintética ' + n }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenants, workspace)); };
  const admin = human('reseller'), target = store.createTenant(admin, { name: 'Empresa suporte QA', segment: 'Teste' });
  store.mutate(admin, target.id, 'Fixture grant', tenant => { tenant.channels = [{ id: 'allowed', name: 'Canal autorizado', kind: 'whatsapp_qr' }, { id: 'private', name: 'Canal fora do grant', kind: 'telegram' }]; tenant.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'private', name: 'Departamento fora do grant', active: true }]; });
  const oldPerson = human('operator', 'mep-demo', [target.id]), chat = new TeamChat(store, auth);
  const targetRoom = chat.createRoom(admin, target.id, { name: 'Sala privada anterior', memberIds: [oldPerson.userId] });
  const oldMessage = chat.send(oldPerson, target.id, targetRoom.id, { version: 1, text: 'Mensagem privada anterior ao suporte', requestId: 'synthetic_old_message_001' });
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('support-home', JSON.stringify({ ...store.reseller(admin), name: 'Workspace próprio do suporte QA' }));
  // Preserve the old private membership after this synthetic person moves home.
  store.db.prepare('UPDATE auth_users SET reseller_id=?,role=?,tenant_ids=? WHERE id=?').run('support-home', 'reseller', '[]', oldPerson.userId);
  const person = auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(oldPerson.userId));
  const home = store.createTenant(person, { name: 'Empresa própria do suporte QA', segment: 'Teste' }), homeRoom = chat.createRoom(person, home.id, { name: 'Equipe própria', memberIds: [] });
  chat.send(person, home.id, homeRoom.id, { version: 1, text: 'Mensagem do workspace próprio', requestId: 'synthetic_home_message_001' });
  const session = auth.session(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(person.userId));
  const support = new SupportAccess(store, auth), grant = support.create(admin, { requestId: 'synthetic_support_request', supportUserId: person.userId, tenantIds: [target.id], permissions: ['inbox.read', 'inbox.reply'], scopeRules: { [target.id]: { channelIds: ['allowed'], departmentIds: ['support'] } }, reason: 'Suporte de atendimento sintético', ttlMinutes: 60 });
  const delegated = auth.workspaceActor(person, admin.resellerId, grant.id);
  const snapshot = () => JSON.stringify(Object.fromEntries(['team_chat_rooms', 'team_chat_members', 'team_chat_messages', 'team_chat_audit'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const noExternal = () => { assert.equal(store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0); assert.equal(store.db.prepare('SELECT count(*) n FROM team_chat_members WHERE reseller_id=? AND tenant_id=? AND room_id=? AND user_id=?').get(admin.resellerId, target.id, targetRoom.id, person.userId).n, 1); };
  return { store, auth, admin, target, person, home, chat, homeRoom, targetRoom, oldMessage, session, support, grant, delegated, snapshot, noExternal };
}

test('grant real permite atendimento delimitado mas bloqueia salas privadas históricas do mesmo humano', t => {
  const f = fixture(t), before = f.snapshot(); assert.equal(f.delegated.role, 'operator'); assert.equal(f.delegated.userId, f.person.userId);
  assert.equal(f.auth.can(f.delegated, 'inbox.read', { tenantId: f.target.id, channelId: 'allowed', departmentId: 'support' }), true); assert.equal(f.auth.can(f.delegated, 'inbox.read', { tenantId: f.target.id, channelId: 'private', departmentId: 'private' }), false);
  for (const operation of [() => f.chat.listRooms(f.delegated, f.target.id), () => f.chat.getRoom(f.delegated, f.target.id, f.targetRoom.id), () => f.chat.messages(f.delegated, f.target.id, f.targetRoom.id), () => f.chat.markRead(f.delegated, f.target.id, f.targetRoom.id, { sequence: 1 }), () => f.chat.send(f.delegated, f.target.id, f.targetRoom.id, { version: 1, text: 'Mensagem privada anterior ao suporte', requestId: 'synthetic_old_message_001' }), () => f.chat.send(f.delegated, f.target.id, f.targetRoom.id, { version: 1, text: 'Novo envio não permitido', requestId: 'synthetic_new_message_001' })]) assert.throws(operation, denied);
  assert.equal(f.snapshot(), before); f.noExternal();
});

test('suporte não consulta diretório, cria salas ou projeta administração por flags forjadas', t => {
  const f = fixture(t), before = f.snapshot(), actor = { ...f.delegated, role: 'reseller', platformAdmin: true, permissions: null };
  for (const operation of [() => f.chat.directory(actor, f.target.id), () => f.chat.createRoom(actor, f.target.id, { name: 'Sala não permitida', memberIds: [] }), () => f.chat.updateMembers(actor, f.target.id, f.targetRoom.id, { version: 1, action: 'remove', userId: f.person.userId })]) assert.throws(operation, denied);
  assert.equal(f.snapshot(), before); assert.equal(f.chat.getRoom(f.admin, f.target.id, f.targetRoom.id).members.find(member => member.id === f.person.userId).eligible, false); f.noExternal();
});

test('scope recusa o marcador de suporte antes de currentActor/admin e preserva a sessão própria', t => {
  const f = fixture(t); let projections = 0; const currentActor = f.auth.currentActor.bind(f.auth), admin = f.auth.admin.bind(f.auth);
  f.auth.currentActor = (...args) => { projections++; return currentActor(...args); }; f.auth.admin = (...args) => { projections++; return admin(...args); };
  assert.throws(() => f.chat.scope(f.delegated, f.target.id), denied); assert.throws(() => f.chat.scope(f.delegated, f.target.id, { admin: true }), denied); assert.equal(projections, 0);
  const authenticated = f.auth.authenticate(f.session.token); assert.equal(authenticated.resellerId, 'support-home'); assert.equal(authenticated.role, 'reseller'); assert.equal(authenticated.supportGrantId, undefined);
  assert.equal(f.chat.getRoom(authenticated, f.home.id, f.homeRoom.id).canManage, true); f.noExternal();
});

test('enquanto em suporte, nem trocar só workspace revive acesso à equipe; saída normal conserva home', t => {
  const f = fixture(t), before = f.snapshot(); assert.throws(() => f.chat.getRoom({ ...f.delegated, resellerId: f.person.resellerId }, f.home.id, f.homeRoom.id), denied); assert.equal(f.snapshot(), before);
  assert.equal(f.chat.listRooms(f.person, f.home.id).rooms[0].id, f.homeRoom.id); assert.equal(f.chat.messages(f.person, f.home.id, f.homeRoom.id).messages[0].text, 'Mensagem do workspace próprio');
  const sent = f.chat.send(f.person, f.home.id, f.homeRoom.id, { version: 1, text: 'Conversa interna pelo acesso próprio', requestId: 'synthetic_home_message_002' }); assert.equal(sent.author.id, f.person.userId); assert.equal(sent.sequence, 2); assert.equal(f.chat.markRead(f.person, f.home.id, f.homeRoom.id, { sequence: 2 }).readSequence, 2);
  assert.throws(() => f.chat.listRooms({ ...f.person, resellerId: f.admin.resellerId }, f.target.id), error => error.status === 403); f.noExternal();
});

test('revogar suporte não apaga membros, mensagens, direitos próprios ou sessão e não revive salas antigas', t => {
  const f = fixture(t), before = f.snapshot(), revoked = f.support.revoke(f.admin, f.grant.id, { version: 1, reason: 'Suporte sintético encerrado' }); assert.equal(revoked.state, 'revoked'); assert.equal(revoked.version, 2);
  assert.throws(() => f.auth.resolveActor(f.delegated), error => error.status === 403); assert.throws(() => f.chat.messages(f.delegated, f.target.id, f.targetRoom.id), denied); assert.equal(f.snapshot(), before);
  const own = f.auth.authenticate(f.session.token); assert.equal(own.resellerId, 'support-home'); assert.equal(f.chat.getRoom(own, f.home.id, f.homeRoom.id).canManage, true); assert.equal(f.chat.messages(own, f.home.id, f.homeRoom.id).messages.length, 1); assert.deepEqual(f.support.available(own), []);
  assert.equal(f.chat.messages(f.admin, f.target.id, f.targetRoom.id).messages[0].id, f.oldMessage.id); f.noExternal();
});
