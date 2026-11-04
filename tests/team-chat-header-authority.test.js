import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { TeamChat } from '../src/team-chat.js';

const denied = error => error.status === 403;
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let headers = 0, nextUser = 0;
  const auth = new Auth(store.db, { validateTenant(actor, id) {
    headers++;
    const header = store.readonlyTenantHeader(actor, id);
    assert.equal(Object.hasOwn(header, 'conversations'), false);
    return header;
  } });
  function user(role, tenantIds = [], resellerId = 'mep-demo') {
    const n = ++nextUser;
    return auth.actor(auth.insertUser({ username: 'header.synthetic.' + n, name: 'Pessoa sintética ' + n }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, resellerId));
  }
  const admin = user('reseller'), tenant = store.createTenant(admin, { name: 'Referências sintéticas', segment: 'QA' });
  const seed = (actor, id, contact = 'Contato sintético') => store.mutate(actor, id, 'Fixture sintética de referência', state => {
    state.channels = [{ id: 'allowed-channel', kind: 'telegram' }, { id: 'hidden-channel', kind: 'telegram' }];
    state.departments = [{ id: 'allowed-dept', name: 'Permitido' }, { id: 'hidden-dept', name: 'Privado' }];
    state.conversations = [{ id: 'reference', contact, channelId: 'allowed-channel', departmentId: 'allowed-dept', version: 1,
      messages: [{ text: 'HISTÓRICO PRIVADO SINTÉTICO' }], followUps: [{ text: 'FOLLOWUP PRIVADO SINTÉTICO' }] }];
  });
  seed(admin, tenant.id);
  const operator = user('operator', [tenant.id]), chat = new TeamChat(store, auth);
  const room = chat.createRoom(admin, tenant.id, { name: 'Sala sintética', memberIds: [operator.userId] });
  const input = extra => ({ version: room.version, text: 'Mensagem interna sintética', requestId: randomUUID(), conversationId: 'reference', ...extra });
  const send = (body = input(), actor = operator) => chat.send(actor, tenant.id, room.id, body);
  const messages = () => chat.messages(operator, tenant.id, room.id).messages;
  const rule = value => store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(value === null ? null : JSON.stringify({ [tenant.id]: value }), operator.userId);
  // Exercise actual callers, forbidding full history and unbounded summary reads.
  const bounded = fn => {
    const originalTenant = store.tenant, source = store.serviceReadModel.source.get, all = store.serviceReadModel.all.all, serviceTenant = store.serviceTenant;
    const forbidden = () => { throw new Error('Full tenant/history/unbounded summaries forbidden'); };
    store.tenant = store.serviceReadModel.source.get = store.serviceReadModel.all.all = forbidden;
    store.serviceTenant = function(workspaceId, tenantId, options) {
      assert.equal(workspaceId, admin.resellerId); assert.equal(tenantId, tenant.id);
      assert.deepEqual(options, { conversationId: 'reference' });
      const summary = serviceTenant.call(this, workspaceId, tenantId, options);
      for (const conversation of summary.conversations) {
        assert.equal(Object.hasOwn(conversation, 'messages'), false);
        assert.equal(Object.hasOwn(conversation, 'followUps'), false);
      }
      return summary;
    };
    try { return fn(); } finally { store.tenant = originalTenant; store.serviceReadModel.source.get = source; store.serviceReadModel.all.all = all; store.serviceTenant = serviceTenant; }
  };
  return { store, auth, admin, tenant, operator, chat, room, seed, user, input, send, messages, rule, bounded, headers: () => headers };
}
const expected = { conversationId: 'reference', contact: 'Contato sintético', channelId: 'allowed-channel', departmentId: 'allowed-dept' };

test('header-only Auth supports authorized send, replay and page without histories/private followUps', t => {
  const c = fixture(t), body = c.input();
  c.bounded(() => {
    assert.equal(c.auth.can(c.operator, 'inbox.read', { tenantId: c.tenant.id, channelId: 'allowed-channel', departmentId: 'allowed-dept' }), true);
    assert.deepEqual(c.send(body).reference, expected);
    assert.deepEqual(c.send(body).reference, expected);
    assert.deepEqual(c.messages()[0].reference, expected);
    assert.equal(c.messages().length, 1);
    assert.equal(JSON.stringify(c.messages()).includes('PRIVADO SINTÉTICO'), false);
  });
  assert.ok(c.headers() > 0);
});

test('ordinary messages and permission checks do not request any conversation summary', t => {
  const c = fixture(t);
  c.store.serviceTenant = () => { throw new Error('No reference: no summary read'); };
  c.bounded(() => {
    assert.equal(c.auth.can(c.operator, 'inbox.read', { tenantId: c.tenant.id }), true);
    c.send(c.input({ conversationId: null }));
    assert.equal(c.messages()[0].reference, undefined);
  });
});

for (const [name, rule] of [['channel', { channelIds: ['hidden-channel'] }], ['department', { departmentIds: ['hidden-dept'] }]]) {
  test(`current ${name} restriction denies new references and redacts history/replay for stale actor`, t => {
    const c = fixture(t), body = c.input(); c.bounded(() => assert.deepEqual(c.send(body).reference, expected));
    c.rule(rule);
    c.bounded(() => {
      assert.throws(() => c.send(), denied);
      assert.deepEqual(c.send(body).reference, { unavailable: true });
      assert.deepEqual(c.messages()[0].reference, { unavailable: true });
    });
  });
}

for (const field of ['channels', 'departments', 'conversations']) {
  test(`deleted ${field} invalidates a previously authorized reference with warmed header`, t => {
    const c = fixture(t), body = c.input(); c.bounded(() => c.send(body));
    c.store.mutate(c.admin, c.tenant.id, 'Retirada sintética', state => { state[field] = []; });
    c.bounded(() => {
      assert.throws(() => c.send(), denied);
      assert.deepEqual(c.messages()[0].reference, { unavailable: true });
      assert.deepEqual(c.send(body).reference, { unavailable: true });
    });
  });
}

test('fresh conversation routing replaces old metadata before checking channel/department authority', t => {
  const c = fixture(t), body = c.input(); c.rule({ channelIds: ['allowed-channel'], departmentIds: ['allowed-dept'] });
  c.bounded(() => c.send(body));
  for (const change of [{ channelId: 'hidden-channel', departmentId: 'allowed-dept' }, { channelId: 'allowed-channel', departmentId: 'hidden-dept' }]) {
    c.store.mutate(c.admin, c.tenant.id, 'Reatribuição sintética', state => Object.assign(state.conversations[0], change));
    c.bounded(() => { assert.throws(() => c.send(), denied); assert.deepEqual(c.messages()[0].reference, { unavailable: true }); });
  }
});

test('current operator permissions, tenant membership and disabled state override stale actor', t => {
  const c = fixture(t); c.bounded(() => c.send());
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run('[]', c.operator.userId);
  c.bounded(() => { assert.throws(() => c.send(), denied); assert.deepEqual(c.messages()[0].reference, { unavailable: true }); });
  c.store.db.prepare('UPDATE auth_users SET permissions=NULL,tenant_ids=? WHERE id=?').run('[]', c.operator.userId);
  assert.throws(() => c.send(), denied); assert.throws(() => c.messages(), denied);
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=?,disabled_at=? WHERE id=?').run(JSON.stringify([c.tenant.id]), new Date().toISOString(), c.operator.userId);
  assert.throws(() => c.send(), denied); assert.throws(() => c.messages(), denied);
});

test('cross-workspace IDs and colliding conversation IDs cannot grant or substitute a reference', t => {
  const c = fixture(t);
  c.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('foreign-synthetic', JSON.stringify({ name: 'Workspace sintético externo' }));
  const foreignAdmin = c.user('reseller', [], 'foreign-synthetic'), foreignTenant = c.store.createTenant(foreignAdmin, { name: 'Empresa externa sintética', segment: 'QA' });
  c.seed(foreignAdmin, foreignTenant.id, 'Contato externo privado');
  c.bounded(() => assert.deepEqual(c.send().reference, expected));
  assert.throws(() => c.chat.send({ ...c.operator, resellerId: 'foreign-synthetic' }, c.tenant.id, c.room.id, c.input()), error => [403, 404].includes(error.status));
  c.store.mutate(c.admin, c.tenant.id, 'Remoção local sintética', state => { state.conversations = []; });
  c.bounded(() => { assert.throws(() => c.send(), denied); assert.deepEqual(c.messages()[0].reference, { unavailable: true }); });
});
