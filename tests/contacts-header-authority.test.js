import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ContactService } from '../src/contacts.js';

const denied = error => error.status === 403;
const identity = (channelId, externalId, extra = {}) => ({ channelId, kind: 'person', externalId, ...extra });
const contact = (id, identities) => ({ id, name: id, type: 'person', identities, version: 1, phone: '', email: '', notes: '', tags: [], createdAt: '2026-10-24', updatedAt: '2026-10-24' });
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant(actor, id) {
    const header = store.readonlyTenantHeader(actor, id);
    assert.equal(Object.hasOwn(header, 'conversations'), false);
    return header;
  } });
  let sequence = 0;
  const user = (role, tenantIds = [], resellerId = 'mep-demo') => auth.actor(auth.insertUser({ username: 'contacts.header.' + ++sequence, name: 'Sintético' }, Buffer.alloc(16, sequence), Buffer.alloc(64, sequence), role, tenantIds, resellerId));
  const admin = user('reseller'), tenantId = store.createTenant(admin, { name: 'Agenda sintética', segment: 'QA' }).id;
  const edit = fn => store.mutate(admin, tenantId, 'Fixture sintética Contacts header', fn);
  edit(state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr' }, { id: 'tg', kind: 'telegram' }, { id: 'email', kind: 'email' }, { id: 'web', kind: 'webchat' }];
    state.departments = [{ id: 'support', name: 'Suporte' }, { id: 'private', name: 'Privado' }];
    state.contacts = [contact('wa-contact', [identity('wa', '5511987654321@s.whatsapp.net')]), contact('tg-contact', [identity('tg', '123')]), contact('email-contact', [identity('email', 'conversation:email-conversation')]), contact('verified-contact', [identity('web', 'visitor-verified', { verified: true })]), contact('unverified-contact', [identity('web', 'visitor-unverified', { verified: true })]), contact('private-contact', [identity('wa', '5511987654322@s.whatsapp.net')])];
    state.conversations = [
      { id: 'wa-conversation', contactId: 'wa-contact', channelId: 'wa', remoteJid: '5511987654321@s.whatsapp.net' },
      { id: 'tg-conversation', contactId: 'tg-contact', channelId: 'tg', remoteChatId: '123' },
      { id: 'email-conversation', contactId: 'email-contact', channelId: 'email', remoteEmail: 'private@example.test' },
      { id: 'web-conversation', contactId: 'verified-contact', channelId: 'web', webchatVisitor: { verified: true, externalId: 'visitor-verified', email: 'secret@example.test', arbitrary: 'PRIVATE_VISITOR' } },
      { id: 'unverified-conversation', contactId: 'unverified-contact', channelId: 'web', webchatVisitor: { verified: false, externalId: 'visitor-unverified' } },
      { id: 'private-conversation', contactId: 'private-contact', channelId: 'wa', remoteJid: '5511987654322@s.whatsapp.net', departmentId: 'private' }
    ].map(item => ({ version: 1, department: 'Suporte', messages: [{ text: 'PRIVATE_HISTORY' }], followUps: [{ text: 'PRIVATE_FOLLOWUP' }], ...item }));
  });
  const actor = user('operator', [tenantId]);
  const rule = value => store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(value === null ? null : JSON.stringify({ [tenantId]: value }), actor.userId);
  rule({ departmentIds: ['support'] });
  const service = new ContactService(store, auth);
  let scopedReads = [];
  const bounded = fn => {
    const originalTenant = store.tenant, source = store.serviceReadModel.source.get, scoped = store.readonlyConversationTenant;
    const forbidden = () => { throw new Error('Contacts listing must not open full tenant histories'); };
    store.tenant = store.serviceReadModel.source.get = forbidden;
    store.readonlyConversationTenant = function(actor, id, conversationId) { scopedReads.push(conversationId); return scoped.call(this, actor, id, conversationId); };
    try { return fn(); } finally { store.tenant = originalTenant; store.serviceReadModel.source.get = source; store.readonlyConversationTenant = scoped; }
  };
  const merge = () => {
    const preview = service.mergePreview(admin, tenantId, 'wa-contact', 'tg-contact');
    return service.merge(admin, tenantId, 'wa-contact', { targetId: 'tg-contact', sourceVersion: preview.sourceContact.version, targetVersion: preview.targetContact.version, revision: preview.revision });
  };
  return { store, auth, actor, admin, tenantId, service, edit, user, rule, bounded, merge, scopedReads };
}
const expected = ['wa-contact', 'tg-contact', 'email-contact', 'verified-contact'];

test('private visitor lookup is restricted to the current webchat conversation IDs', t => {
  const c = fixture(t), prepare = c.store.db.prepare.bind(c.store.db), calls = [];
  c.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes("json_extract(c.data,'$.webchatVisitor.verified')")) {
      assert.match(sql, /c\.id IN \(SELECT value FROM json_each\(\?\)\)/);
      const all = statement.all.bind(statement);
      statement.all = (...args) => { calls.push(args); return all(...args); };
    }
    return statement;
  };
  c.bounded(() => c.service.list(c.actor, c.tenantId));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], c.tenantId);
  assert.equal(calls[0][1], 'mep-demo');
  assert.deepEqual(JSON.parse(calls[0][2]).sort(), ['unverified-conversation', 'web-conversation']);
});
test('non-webchat agendas do not open the private visitor JSON projection', t => {
  const c = fixture(t);
  c.edit(state => {
    state.channels = state.channels.filter(channel => channel.kind !== 'webchat');
    state.conversations = state.conversations.filter(conversation => conversation.channelId !== 'web');
  });
  const prepare = c.store.db.prepare.bind(c.store.db);
  c.store.db.prepare = sql => {
    assert.equal(sql.includes("json_extract(c.data,'$.webchatVisitor.verified')"), false);
    return prepare(sql);
  };
  assert.deepEqual(c.bounded(() => c.service.list(c.actor, c.tenantId)).map(item => item.id), ['wa-contact', 'tg-contact', 'email-contact']);
});
test('webchat proof keeps strict boolean/string types and unverified conversation fallback', t => {
  const c = fixture(t);
  c.edit(state => {
    state.contacts.push(contact('fallback-contact', [identity('web', 'conversation:fallback-conversation')]));
    state.conversations.push({ id: 'fallback-conversation', channelId: 'web', departmentId: 'support', webchatVisitor: { verified: false, externalId: 'visitor-unverified' } });
  });
  assert.deepEqual(c.bounded(() => c.service.list(c.actor, c.tenantId)).map(item => item.id), [...expected, 'fallback-contact']);
  for (const proof of [{ verified: 1, externalId: 'visitor-verified' }, { verified: 'true', externalId: 'visitor-verified' }, { verified: true, externalId: { value: 'visitor-verified' } }, { verified: true, externalId: ['visitor-verified'] }]) {
    c.edit(state => { state.conversations.find(item => item.id === 'web-conversation').webchatVisitor = proof; });
    assert.equal(c.bounded(() => c.service.list(c.actor, c.tenantId)).some(item => item.id === 'verified-contact'), false);
  }
});

test('zero-conversation merge loses undo availability when a related conversation appears', t => {
  const c = fixture(t);
  c.edit(state => { state.conversations = state.conversations.filter(item => !['wa-conversation', 'tg-conversation'].includes(item.id)); });
  const merged = c.merge();
  assert.equal(c.bounded(() => c.service.list(c.admin, c.tenantId)).find(item => item.id === 'tg-contact').reversibleMergeId, merged.mergeId);
  assert.deepEqual(c.scopedReads, []);
  c.edit(state => { state.conversations.push({ id: 'later-related', channelId: 'wa', remoteJid: '5511987654321@s.whatsapp.net', departmentId: 'support', messages: [{ text: 'LATER_PRIVATE' }] }); });
  assert.equal(Object.hasOwn(c.bounded(() => c.service.list(c.admin, c.tenantId)).find(item => item.id === 'tg-contact'), 'reversibleMergeId'), false);
  assert.deepEqual(c.scopedReads, ['later-related']);
});

test('real history-free Auth callback preserves department identity matches and verified webchat without histories', t => {
  const c = fixture(t);
  c.bounded(() => {
    const result = c.service.list(c.actor, c.tenantId);
    assert.deepEqual(result.map(item => item.id), expected);
    assert.deepEqual(result.find(item => item.id === 'verified-contact').identities, [{ channelId: 'web', kind: 'person', label: 'Contato vinculado', verified: true, externalId: 'visitor-verified' }]);
    for (const secret of ['PRIVATE_HISTORY', 'PRIVATE_FOLLOWUP', 'PRIVATE_VISITOR', 'secret@example.test', '@s.whatsapp.net', 'private@example.test']) assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(c.scopedReads, []);
  });
});

test('snapshot repeats current department/channel/conversation routing before honoring since', t => {
  const c = fixture(t), first = c.bounded(() => c.service.snapshot(c.actor, c.tenantId));
  assert.deepEqual(first.contacts.map(item => item.id), expected);
  assert.equal(c.bounded(() => c.service.snapshot(c.actor, c.tenantId, {}, first.revision)).unchanged, true);
  c.rule({ departmentIds: ['support'], channelIds: ['wa'] });
  const restricted = c.bounded(() => c.service.snapshot(c.actor, c.tenantId, {}, first.revision));
  assert.equal(restricted.unchanged, false); assert.deepEqual(restricted.contacts.map(item => item.id), ['wa-contact']);
  c.edit(state => { state.conversations[0].departmentId = 'private'; });
  assert.deepEqual(c.bounded(() => c.service.list(c.actor, c.tenantId)), []);
  c.edit(state => { state.conversations[0].departmentId = 'support'; state.channels = state.channels.filter(channel => channel.id !== 'wa'); });
  assert.deepEqual(c.bounded(() => c.service.list(c.actor, c.tenantId)), []);
});

for (const mutation of ["permissions='[]'", "tenant_ids='[]',scope_rules=NULL", 'disabled_at=123']) {
  test(`stale actor cannot reuse agenda revision after ${mutation}`, t => {
    const c = fixture(t), first = c.bounded(() => c.service.snapshot(c.actor, c.tenantId));
    c.store.db.prepare(`UPDATE auth_users SET ${mutation} WHERE id=?`).run(c.actor.userId);
    assert.throws(() => c.bounded(() => c.service.snapshot(c.actor, c.tenantId, {}, first.revision)), denied);
  });
}

test('workspace spoof and colliding conversation/contact IDs never import foreign authority', t => {
  const c = fixture(t);
  c.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('contacts-foreign', '{"name":"Sintético estrangeiro"}');
  const foreign = c.user('reseller', [], 'contacts-foreign');
  const id = c.store.createTenant(foreign, { name: 'Outra agenda', segment: 'QA' }).id;
  c.store.mutate(foreign, id, 'Colisões sintéticas', state => { state.contacts = [contact('wa-contact', [identity('wa', '5511987654321@s.whatsapp.net')])]; state.channels = [{ id: 'wa', kind: 'whatsapp_qr' }]; state.departments = [{ id: 'support', name: 'Suporte' }]; state.conversations = [{ id: 'wa-conversation', channelId: 'wa', contactId: 'wa-contact', remoteJid: '5511987654321@s.whatsapp.net', departmentId: 'support' }]; });
  c.edit(state => { state.conversations[0].departmentId = 'private'; });
  assert.deepEqual(c.bounded(() => c.service.list(c.actor, c.tenantId)).map(item => item.id), expected.slice(1));
  assert.throws(() => c.bounded(() => c.service.list({ ...c.actor, resellerId: 'contacts-foreign' }, c.tenantId)), denied);
  assert.deepEqual(c.bounded(() => c.service.list(foreign, id)).map(item => item.id), ['wa-contact']);
});

for (const change of ['message', 'scoped-message', 'followUp', 'routing', 'new-related', 'permission']) {
  test(`merge availability uses full scoped fingerprints and rejects later ${change}`, t => {
    const c = fixture(t), merged = c.merge();
    c.bounded(() => {
      assert.equal(c.service.list(c.actor, c.tenantId).find(item => item.id === 'tg-contact').reversibleMergeId, merged.mergeId);
      assert.deepEqual([...new Set(c.scopedReads)].sort(), ['tg-conversation', 'wa-conversation']);
    });
    const first = c.bounded(() => c.service.snapshot(c.actor, c.tenantId));
    if (change === 'permission') c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['contacts.read']), c.actor.userId);
    else if (change === 'scoped-message') c.store.mutateConversation(c.admin, c.tenantId, 'wa-conversation', 'Mensagem sintética após fusão', conversation => { conversation.messages.push({ text: 'POST_MERGE_PRIVATE_SCOPED' }); });
    else c.edit(state => {
      const conversation = state.conversations[0];
      if (change === 'message') conversation.messages.push({ text: 'POST_MERGE_PRIVATE' });
      if (change === 'followUp') conversation.followUps.push({ text: 'POST_MERGE_FOLLOWUP' });
      if (change === 'routing') conversation.departmentId = 'private';
      if (change === 'new-related') state.conversations.push({ ...structuredClone(conversation), id: 'later-related' });
    });
    const current = c.bounded(() => c.service.snapshot(c.actor, c.tenantId, {}, first.revision));
    assert.equal(current.unchanged, false);
    assert.equal(Object.hasOwn(current.contacts.find(item => item.id === 'tg-contact'), 'reversibleMergeId'), false);
    assert.equal(JSON.stringify(current).includes('POST_MERGE'), false);
  });
}
