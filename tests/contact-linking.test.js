import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ContactService, publicContact, syncConversationContact } from '../src/contacts.js';
import { mkdtemp, rm, rmdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { createLocalBackup, validateBackup } from '../src/backup.js';
import { PostgresBridge } from '../src/postgres-bridge.js';

const status = code => error => error.status === code;
const permissions = ['contacts.read', 'contacts.write', 'inbox.read', 'inbox.transfer'];

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  let sequence = 0;
  const user = ({ role = 'operator', tenantIds = [], scopeRules = null } = {}) => {
    const n = ++sequence, row = auth.insertUser({ username: 'linking-ram-' + n, name: 'Pessoa RAM ' + n },
      Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, 'mep-demo');
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?')
      .run(JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  };
  const admin = user({ role: 'reseller' }), tenantId = store.createTenant(admin, { name: 'Fusão RAM', segment: 'QA' }).id;
  const otherTenantId = store.createTenant(admin, { name: 'Outra empresa RAM', segment: 'QA' }).id;
  const operator = user({ tenantIds: [tenantId], scopeRules: { [tenantId]: {
    channelIds: ['wa-source', 'wa-target', 'web'], departmentIds: ['support', 'sales']
  } } });
  const service = new ContactService(store, auth);
  const edit = fn => store.mutate(admin, tenantId, 'Fixture RAM de contatos', fn);
  let sourceId, targetId;
  edit(state => {
    state.channels = [
      { id: 'wa-source', kind: 'whatsapp_qr', transport: 'baileys' },
      { id: 'wa-target', kind: 'whatsapp_qr', transport: 'baileys' },
      { id: 'web', kind: 'webchat', transport: 'elozi-webchat' }
    ];
    state.departments = [{ id: 'support', name: 'Suporte' }, { id: 'sales', name: 'Comercial' }];
    state.contacts = []; state.conversations = [];
    for (const [id, channelId, departmentId, remoteJid, name] of [
      ['source-conversation', 'wa-source', 'support', '5511987654321@s.whatsapp.net', 'Fonte RAM'],
      ['target-conversation', 'wa-target', 'sales', '5511987656789@s.whatsapp.net', 'Destino RAM']
    ]) {
      const conversation = { id, channelId, departmentId, remoteJid, contact: name, conversationKind: 'direct',
        version: 1, owner: 'human', assignedUserId: operator.userId, status: 'open',
        messages: [{ id: id + '-message', kind: 'customer', text: 'MENSAGEM PRIVADA SOMENTE RAM', attachments: [{ id: 'attachment-' + id }] }] };
      state.conversations.push(conversation);
      const contact = syncConversationContact(state, conversation, state.channels.find(channel => channel.id === channelId));
      if (id.startsWith('source')) {
        sourceId = contact.id; Object.assign(contact, { email: 'source@example.test', notes: 'Nota da fonte', tags: ['Fonte', 'Comum'], privateExtra: 'PRIVATE EXTRA RAM' });
      } else {
        targetId = contact.id; Object.assign(contact, { notes: 'Nota do destino', tags: ['Destino', 'Comum'] });
      }
    }
    state.conversations.push({ id: 'unlinked', channelId: 'web', departmentId: 'support', contact: 'Legado sem vínculo',
      conversationKind: 'direct', version: 1, status: 'closed', owner: 'queue', messages: [] });
  });
  new Outbox(store);
  store.db.prepare('INSERT INTO outbound_commands VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('ram-outbox', tenantId,
    'source-conversation', 'wa-source', 1, 'ram-key', 'hash', '{"text":"PRIVADO RAM"}', 'confirmed', 1, 'before', 'before');
  const state = () => store.tenant(admin, tenantId);
  const preview = (actor = operator) => service.mergePreview(actor, tenantId, sourceId, targetId);
  const merge = (value = preview(), actor = operator) => service.merge(actor, tenantId, sourceId, {
    targetId, sourceVersion: value.sourceContact.version, targetVersion: value.targetContact.version, revision: value.revision
  });
  const undo = (merged, actor = operator) => {
    const value = service.mergeUndoPreview(actor, tenantId, targetId, merged.mergeId);
    return service.mergeUndo(actor, tenantId, targetId, { mergeId: merged.mergeId, revision: value.revision });
  };
  const scope = rules => store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [tenantId]: rules }), operator.userId);
  const setPermissions = value => store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(value), operator.userId);
  const raw = id => state().contacts.find(contact => contact.id === id);
  const outbox = () => store.db.prepare('SELECT * FROM outbound_commands').all();
  const journals = () => service.mergeJournals(admin, tenantId);
  return { store, auth, admin, operator, tenantId, otherTenantId, service, sourceId, targetId, edit, state, preview, merge, undo, scope, setPermissions, raw, outbox, journals };
}

function rejectedWithoutWrite(f, code, call) {
  const before = JSON.stringify(f.state()), outbox = f.outbox(), journals = f.journals();
  const audits = f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.throws(call, status(code));
  assert.equal(JSON.stringify(f.state()), before); assert.deepEqual(f.outbox(), outbox);
  assert.deepEqual(f.journals(), journals);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
}

test('association preview is narrow, authoritative and read-only; both CAS are honored while legacy body remains valid', t => {
  const f = fixture(t), destination = f.service.create(f.admin, f.tenantId, { name: 'Cadastro manual RAM' });
  const before = JSON.stringify(f.state()), preview = f.service.associationPreview(f.admin, f.tenantId, 'unlinked', destination.id);
  assert.deepEqual(Object.keys(preview).sort(), ['channelId', 'contact', 'conversationId', 'kind', 'version']);
  assert.equal(preview.kind, 'person'); assert.equal(preview.version, 1); assert.equal(preview.contact.version, 1);
  assert.equal(JSON.stringify(f.state()), before); assert.equal(JSON.stringify(preview).includes('externalId'), false);
  f.service.update(f.admin, f.tenantId, destination.id, { version: 1, notes: 'Edição concorrente' });
  rejectedWithoutWrite(f, 409, () => f.service.associateConversation(f.admin, f.tenantId, 'unlinked', { contactId: destination.id, version: 1, contactVersion: 1 }));
  const linked = f.service.associateConversation(f.admin, f.tenantId, 'unlinked', { contactId: destination.id, version: 1, contactVersion: 2 });
  assert.equal(linked.version, 2); assert.equal(linked.contact.version, 3);
  assert.equal(f.service.associateConversation(f.admin, f.tenantId, 'unlinked', { contactId: destination.id, version: 2 }).version, 2);
  rejectedWithoutWrite(f, 409, () => f.service.associateConversation(f.admin, f.tenantId, 'unlinked', { contactId: destination.id, version: 1, contactVersion: 3 }));
});

test('association rejects readless actors, occupied identities, archives and another tenant without writing', t => {
  const f = fixture(t);
  rejectedWithoutWrite(f, 409, () => f.service.associationPreview(f.operator, f.tenantId, 'source-conversation', f.targetId));
  rejectedWithoutWrite(f, 403, () => f.service.associateConversation({ ...f.operator, tenantIds: [f.otherTenantId] }, f.tenantId, 'unlinked', { contactId: f.targetId, version: 1 }));
  f.setPermissions(['inbox.read', 'inbox.transfer']);
  rejectedWithoutWrite(f, 403, () => f.service.associationPreview(f.operator, f.tenantId, 'source-conversation', f.sourceId));
  rejectedWithoutWrite(f, 403, () => f.service.associateConversation(f.operator, f.tenantId, 'source-conversation', { contactId: f.sourceId, version: 1 }));
  f.service.archive(f.admin, f.tenantId, f.sourceId, { version: 1 });
  rejectedWithoutWrite(f, 409, () => f.service.associationPreview(f.admin, f.tenantId, 'source-conversation', f.sourceId));
});

test('preview is private and stable; merge keeps destination fields, source originals and all delivery/history fields', t => {
  const f = fixture(t), before = f.state(), outbox = f.outbox(), preview = f.preview();
  assert.match(preview.revision, /^[a-f0-9]{64}$/); assert.equal(preview.conversationCount, 1);
  assert.deepEqual(f.preview(), preview); assert.equal(JSON.stringify(f.state()), JSON.stringify(before));
  assert.equal(JSON.stringify(preview).includes('externalId'), false); assert.equal(JSON.stringify(preview).includes('MENSAGEM'), false);
  const merged = f.merge(preview), state = f.state(), source = f.raw(f.sourceId), target = f.raw(f.targetId);
  assert.equal(merged.sourceContact.mergedIntoId, f.targetId); assert.ok(merged.sourceContact.archivedAt);
  assert.equal(merged.targetContact.reversibleMergeId, merged.mergeId); assert.equal(merged.conversationCount, 1);
  assert.deepEqual(merged.links, [
    { conversationId: 'source-conversation', contactId: f.targetId, version: 2 },
    { conversationId: 'target-conversation', contactId: f.targetId, version: 1 }
  ]);
  for (const key of ['name', 'type', 'email', 'phone', 'notes', 'tags', 'privateExtra', 'createdAt']) assert.deepEqual(source[key], before.contacts.find(item => item.id === f.sourceId)[key]);
  assert.deepEqual(source.identities, []); assert.equal(source.version, 2);
  assert.equal(target.name, 'Destino RAM'); assert.equal(target.phone, before.contacts.find(item => item.id === f.targetId).phone);
  assert.equal(target.email, 'source@example.test'); assert.equal(target.notes, 'Nota do destino\n\nNota da fonte');
  assert.deepEqual(target.tags, ['Destino', 'Comum', 'Fonte']); assert.equal(target.identities.length, 2); assert.equal(target.version, 2);
  for (const c of before.conversations) {
    const after = state.conversations.find(item => item.id === c.id);
    for (const key of Object.keys(c).filter(key => !['contactId', 'version', 'updatedAt'].includes(key))) assert.deepEqual(after[key], c[key], key);
    assert.equal(after.version, c.version + (c.id === 'source-conversation' ? 1 : 0));
  }
  assert.deepEqual(f.outbox(), outbox);
  const journal = f.journals()[0]; assert.equal(journal.id, merged.mergeId); assert.equal(Object.hasOwn(state, 'contactMerges'), false);
  assert.equal(JSON.stringify(journal).includes('MENSAGEM PRIVADA'), false); assert.equal(JSON.stringify(journal).includes('attachments'), false);
  assert.deepEqual(journal.before.source.identities, before.contacts.find(item => item.id === f.sourceId).identities);
  assert.equal(Object.hasOwn(publicContact(target), 'reversibleMergeId'), false, 'Recibo persistido não concede reversibilidade.');
  assert.equal(JSON.stringify(merged).includes('privateExtra'), false); assert.equal(JSON.stringify(merged).includes('contactMerges'), false);
});

test('undo restores fields, identities and links exactly, advances CAS, keeps journal and does not touch outbox', t => {
  const f = fixture(t), before = f.state(), outbox = f.outbox(), merged = f.merge(), result = f.undo(merged);
  assert.equal(result.conversationCount, 1); assert.equal(result.sourceContact.version, 3); assert.equal(result.targetContact.version, 3);
  assert.equal(Object.hasOwn(result.sourceContact, 'mergedIntoId'), false); assert.equal(Object.hasOwn(result.sourceContact, 'archivedAt'), false);
  assert.equal(Object.hasOwn(result.targetContact, 'reversibleMergeId'), false);
  assert.deepEqual(result.links, [
    { conversationId: 'source-conversation', contactId: f.sourceId, version: 3 },
    { conversationId: 'target-conversation', contactId: f.targetId, version: 1 }
  ]);
  for (const original of before.contacts) {
    const after = f.raw(original.id), { version, updatedAt, ...fields } = after;
    const { version: ignoredVersion, updatedAt: ignoredTime, ...originalFields } = original;
    assert.deepEqual(fields, originalFields); assert.equal(version, 3);
  }
  for (const original of before.conversations) {
    const after = f.state().conversations.find(item => item.id === original.id);
    const { version, updatedAt, ...fields } = after, { version: oldVersion, updatedAt: oldTime, ...originalFields } = original;
    assert.deepEqual(fields, originalFields); assert.equal(version, oldVersion + (original.id === 'source-conversation' ? 2 : 0));
  }
  assert.ok(f.journals()[0].undoneAt); assert.deepEqual(f.outbox(), outbox);
  rejectedWithoutWrite(f, 409, () => f.undo(merged));
});

for (const change of ['source-contact', 'target-contact', 'source-message', 'target-message', 'new-conversation', 'department']) {
  test(`stale merge preview rejects ${change} without overwriting concurrent state`, t => {
    const f = fixture(t), preview = f.preview();
    f.edit(state => {
      if (change.endsWith('contact')) { state.contacts.find(item => item.id === (change.startsWith('source') ? f.sourceId : f.targetId)).notes += ' concorrente'; return; }
      const conversation = state.conversations.find(item => item.id === (change.startsWith('target') ? 'target-conversation' : 'source-conversation'));
      if (change === 'new-conversation') { const fresh = structuredClone(conversation); fresh.id = 'new-source'; state.conversations.push(fresh); }
      else if (change === 'department') conversation.departmentId = 'sales';
      else conversation.messages.push({ id: 'later', text: 'Uma entrada posterior sem bump sintético' });
    });
    rejectedWithoutWrite(f, 409, () => f.merge(preview));
  });
}

for (const restriction of ['channel', 'department', 'permission', 'disabled', 'membership']) {
  test(`ACL is checked again after preview and for undo: ${restriction}`, t => {
    const f = fixture(t), preview = f.preview();
    const revoke = () => {
      if (restriction === 'channel') f.scope({ channelIds: ['wa-source'], departmentIds: ['support', 'sales'] });
      if (restriction === 'department') f.scope({ channelIds: ['wa-source', 'wa-target'], departmentIds: ['support'] });
      if (restriction === 'permission') f.setPermissions(['contacts.read', 'contacts.write', 'inbox.read']);
      if (restriction === 'disabled') f.store.db.prepare('UPDATE auth_users SET disabled_at=1 WHERE id=?').run(f.operator.userId);
      if (restriction === 'membership') f.store.db.prepare('UPDATE auth_users SET tenant_ids=?,scope_rules=NULL WHERE id=?').run(JSON.stringify([f.otherTenantId]), f.operator.userId);
    };
    revoke(); rejectedWithoutWrite(f, 403, () => f.merge(preview));
    const merged = f.merge(f.preview(f.admin), f.admin);
    rejectedWithoutWrite(f, 403, () => f.service.mergeUndoPreview(f.operator, f.tenantId, f.targetId, merged.mergeId));
    assert.equal(Object.hasOwn(f.service.get(f.admin, f.tenantId, f.targetId), 'reversibleMergeId'), true, 'Administrador atual mantém direito próprio de desfazer.');
  });
}

for (const change of ['contact-edit', 'later-message', 'link-change', 'new-linked-conversation']) {
  test(`undo refuses ${change}; fields and later history remain untouched`, t => {
    const f = fixture(t), merged = f.merge(), preview = f.service.mergeUndoPreview(f.operator, f.tenantId, f.targetId, merged.mergeId);
    f.edit(state => {
      const conversation = state.conversations.find(item => item.id === 'source-conversation');
      if (change === 'contact-edit') state.contacts.find(item => item.id === f.targetId).notes += ' editada';
      if (change === 'later-message') conversation.messages.push({ id: 'later', kind: 'customer', text: 'NOVA MENSAGEM RAM' });
      if (change === 'link-change') conversation.contactId = f.sourceId;
      if (change === 'new-linked-conversation') { const c = structuredClone(conversation); c.id = 'new-linked'; state.conversations.push(c); }
    });
    const actor = change === 'link-change' ? f.admin : f.operator;
    const currentPreview = change === 'link-change'
      ? { revision: 'a'.repeat(64) } : preview;
    rejectedWithoutWrite(f, 409, () => f.service.mergeUndo(actor, f.tenantId, f.targetId, { mergeId: merged.mergeId, revision: currentPreview.revision }));
    assert.equal(Object.hasOwn(f.service.get(f.admin, f.tenantId, f.targetId), 'reversibleMergeId'), false);
  });
}

test('same contact, incompatible kinds, archives, invalid versions/revisions and foreign contacts fail closed', t => {
  const f = fixture(t);
  rejectedWithoutWrite(f, 400, () => f.service.mergePreview(f.admin, f.tenantId, f.sourceId, f.sourceId));
  const group = f.service.create(f.admin, f.tenantId, { name: 'Grupo RAM', type: 'group' });
  rejectedWithoutWrite(f, 409, () => f.service.mergePreview(f.admin, f.tenantId, f.sourceId, group.id));
  rejectedWithoutWrite(f, 404, () => f.service.mergePreview(f.admin, f.otherTenantId, f.sourceId, f.targetId));
  const preview = f.preview();
  rejectedWithoutWrite(f, 409, () => f.service.merge(f.operator, f.tenantId, f.sourceId, { targetId: f.targetId, sourceVersion: 2, targetVersion: 1, revision: preview.revision }));
  rejectedWithoutWrite(f, 400, () => f.service.merge(f.operator, f.tenantId, f.sourceId, { targetId: f.targetId, sourceVersion: 1, targetVersion: 1, revision: 'bad' }));
  f.service.archive(f.admin, f.tenantId, f.sourceId, { version: 1 });
  rejectedWithoutWrite(f, 409, () => f.preview());
});

test('third identity owner is rejected; duplicate identities within the pair are moved once', t => {
  const f = fixture(t), duplicate = f.service.create(f.admin, f.tenantId, { name: 'Terceiro RAM' });
  f.edit(state => state.contacts.find(item => item.id === duplicate.id).identities.push(structuredClone(state.contacts.find(item => item.id === f.sourceId).identities[0])));
  rejectedWithoutWrite(f, 409, () => f.preview());
  f.edit(state => {
    state.contacts.find(item => item.id === duplicate.id).identities = [];
    state.contacts.find(item => item.id === f.targetId).identities.push(structuredClone(state.contacts.find(item => item.id === f.sourceId).identities[0]));
  });
  const merged = f.merge(f.preview(f.admin), f.admin); assert.equal(merged.targetContact.identities.length, 2);
});

test('notes/tags overflow is rejected without truncating; equal notes are not duplicated', t => {
  const f = fixture(t);
  f.edit(state => { state.contacts.find(item => item.id === f.sourceId).notes = 'x'.repeat(1500); state.contacts.find(item => item.id === f.targetId).notes = 'y'.repeat(501); });
  rejectedWithoutWrite(f, 409, () => f.preview());
  f.edit(state => { for (const contact of state.contacts) contact.notes = 'Nota igual'; state.contacts.find(item => item.id === f.sourceId).tags = Array.from({ length: 20 }, (_, i) => 'Tag' + i); });
  rejectedWithoutWrite(f, 409, () => f.preview());
  f.edit(state => { state.contacts.find(item => item.id === f.targetId).tags = ['Tag0']; });
  assert.equal(f.merge().targetContact.notes, 'Nota igual');
});

test('merged sources cannot reactivate; new third phone/identity prevents undo without deleting the source', t => {
  const f = fixture(t), merged = f.merge();
  rejectedWithoutWrite(f, 409, () => f.service.reactivate(f.admin, f.tenantId, f.sourceId, { version: 2 }));
  const third = f.service.create(f.admin, f.tenantId, { name: 'Novo telefone RAM', phone: f.raw(f.sourceId).phone });
  rejectedWithoutWrite(f, 409, () => f.undo(merged));
  f.service.archive(f.admin, f.tenantId, third.id, { version: 1 });
  const originalIdentity = f.journals()[0].before.source.identities[0];
  f.edit(state => state.contacts.find(item => item.id === third.id).identities.push(structuredClone(originalIdentity)));
  rejectedWithoutWrite(f, 409, () => f.undo(merged));
  assert.ok(f.raw(f.sourceId));
});

test('journal has bounded retention with no automatic pruning; failed merge rolls back all changes', t => {
  const f = fixture(t), preview = f.preview();
  const insert = f.store.db.prepare('INSERT INTO contact_merge_journals VALUES (?,?,?,?)');
  for (let i = 0; i < 100; i++) insert.run('retained-' + i, f.tenantId, f.admin.resellerId, JSON.stringify({ id: 'retained-' + i, targetId: 'historical', undoneAt: 'retained' }));
  rejectedWithoutWrite(f, 409, () => f.merge(preview));
  f.store.db.prepare('DELETE FROM contact_merge_journals WHERE tenant_id=? AND reseller_id=?').run(f.tenantId, f.admin.resellerId);
  insert.run('retained-big', f.tenantId, f.admin.resellerId, JSON.stringify({ id: 'retained-big', targetId: 'historical', undoneAt: 'retained', before: { marker: 'x'.repeat(2 * 1024 * 1024) } }));
  rejectedWithoutWrite(f, 409, () => f.merge(preview));
});

test('merge and undo include every legacy source binding and keep topic/channel/status and message data intact', t => {
  const f = fixture(t);
  f.edit(state => {
    const legacy = structuredClone(state.conversations.find(conversation => conversation.id === 'source-conversation'));
    legacy.id = 'source-legacy'; delete legacy.contactId; delete legacy.contactSyncStatus;
    legacy.threadId = '17'; legacy.status = 'closed'; legacy.owner = 'queue'; legacy.version = 7;
    state.conversations.push(legacy);
  });
  const before = f.state(), merged = f.merge(); assert.equal(merged.conversationCount, 2); assert.equal(merged.links.length, 3);
  const legacyReceipt = merged.links.find(link => link.conversationId === 'source-legacy');
  assert.deepEqual(legacyReceipt, { conversationId: 'source-legacy', contactId: f.targetId, version: 8 });
  const restored = f.undo(merged); assert.equal(restored.conversationCount, 2);
  assert.deepEqual(restored.links.find(link => link.conversationId === 'source-legacy'), { conversationId: 'source-legacy', contactId: null, version: 9 });
  const original = before.conversations.find(item => item.id === 'source-legacy'), current = f.state().conversations.find(item => item.id === original.id);
  for (const key of Object.keys(original).filter(key => !['version', 'updatedAt'].includes(key))) assert.deepEqual(current[key], original[key]);
  assert.equal(Object.hasOwn(current, 'contactId'), false); assert.equal(Object.hasOwn(current, 'contactSyncStatus'), false);
});

test('person/company destination preference fills empty phone; historical duplicate pair can be recovered without introducing a third duplicate', t => {
  const f = fixture(t);
  f.edit(state => { const target = state.contacts.find(contact => contact.id === f.targetId); target.phone = ''; target.type = 'company'; });
  const merged = f.merge(); assert.equal(merged.targetContact.phone, f.raw(f.sourceId).phone); assert.equal(merged.targetContact.type, 'company');
  const undone = f.undo(merged); assert.equal(undone.targetContact.phone, ''); assert.equal(undone.targetContact.type, 'company');
  f.edit(state => { state.contacts.find(contact => contact.id === f.targetId).phone = state.contacts.find(contact => contact.id === f.sourceId).phone; });
  const historical = f.merge();
  assert.equal(f.undo(historical).sourceContact.phone, f.raw(f.targetId).phone);
});

test('incoming identity after merge resolves to the destination and cannot revive the archived source', t => {
  const f = fixture(t), merged = f.merge();
  f.edit(state => {
    const incoming = structuredClone(state.conversations.find(conversation => conversation.id === 'source-conversation'));
    incoming.id = 'later-incoming'; delete incoming.contactId; incoming.version = 1;
    state.conversations.push(incoming);
    const contact = syncConversationContact(state, incoming, state.channels.find(channel => channel.id === incoming.channelId));
    assert.equal(contact.id, f.targetId); assert.equal(contact.version, 2);
  });
  assert.equal(f.state().contacts.length, 2); assert.ok(f.raw(f.sourceId).archivedAt);
  assert.equal(f.state().conversations.find(conversation => conversation.id === 'later-incoming').contactId, f.targetId);
  rejectedWithoutWrite(f, 409, () => f.undo(merged));
});

test('group-to-group merge preserves topics and never gives an individual phone to a group', t => {
  const f = fixture(t);
  f.edit(state => {
    for (const [index, contact] of state.contacts.entries()) {
      contact.type = 'group'; contact.phone = ''; contact.identities[0].kind = 'group'; contact.identities[0].externalId = `12036300${index}@g.us`;
      const conversation = state.conversations.find(item => item.contactId === contact.id);
      conversation.remoteJid = contact.identities[0].externalId; conversation.conversationKind = 'group'; conversation.threadId = String(index + 1);
    }
  });
  const before = f.state(), merged = f.merge(); assert.equal(merged.targetContact.type, 'group'); assert.equal(merged.targetContact.phone, '');
  assert.ok(merged.targetContact.identities.every(identity => identity.kind === 'group'));
  f.undo(merged);
  for (const original of before.conversations) {
    const current = f.state().conversations.find(item => item.id === original.id);
    assert.equal(current.threadId, original.threadId); assert.deepEqual(current.messages, original.messages);
  }
});

test('private journal is tenant/reseller scoped and never appears in PostgreSQL spool or the rollback034 tenant spread', async t => {
  const f = fixture(t), bridge = new PostgresBridge(f.store, { enabled: true, transport: { sync: async () => assert.fail('Somente spool local sintético.'), close: async () => {} } });
  const merged = f.merge(), tenant = f.state();
  const spool = f.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(f.tenantId).payload;
  assert.equal(Object.hasOwn(tenant, 'contactMerges'), false); assert.equal(spool.includes(merged.mergeId), false);
  assert.equal(Object.hasOwn(JSON.parse(spool), 'contactMerges'), false);
  // Same tenant spread and contacts omission used by published 0.34
  // (4b2ee41:server.js filteredTenant), before it knew any merge journal key.
  const rollbackDTO = { ...tenant, contacts: undefined, automation: undefined, mcpServers: undefined, knowledgeSources: undefined };
  assert.equal(JSON.stringify(rollbackDTO).includes(merged.mergeId), false);
  assert.equal(JSON.stringify(rollbackDTO).includes('PRIVATE EXTRA RAM'), false);
  assert.deepEqual(f.service.mergeJournals(f.admin, f.otherTenantId), []);
  assert.deepEqual(f.service.mergeJournals({ ...f.admin, resellerId: 'unrelated-workspace' }, f.tenantId), []);
  assert.throws(() => f.service.mergeUndoPreview(f.admin, f.otherTenantId, f.targetId, merged.mergeId), status(404));
  f.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('linking-foreign', '{"name":"Workspace estrangeiro RAM"}');
  const row = f.auth.insertUser({ username: 'foreign-linking', name: 'Admin estrangeiro RAM' }, Buffer.alloc(16, 4), Buffer.alloc(64, 4), 'reseller', [], 'linking-foreign');
  const foreign = f.auth.actor(row), foreignTenant = f.store.createTenant(foreign, { name: 'Unidade estrangeira RAM', segment: 'QA' }).id;
  f.store.mutate(foreign, foreignTenant, 'Fixture: IDs locais iguais em outro workspace', state => { state.contacts = structuredClone(tenant.contacts); });
  assert.throws(() => f.service.mergeUndoPreview(foreign, foreignTenant, f.targetId, merged.mergeId), status(404));
  assert.throws(() => f.service.mergeUndo(foreign, foreignTenant, f.targetId, { mergeId: merged.mergeId, revision: 'a'.repeat(64) }), status(404));
  assert.equal(f.journals()[0].undoneAt, undefined);
  assert.throws(() => f.store.db.prepare('INSERT INTO contact_merge_journals VALUES (?,?,?,?)').run('invalid-fk', 'missing-tenant', 'mep-demo', '{}'), /FOREIGN KEY/);
  await bridge.close();
});

test('agenda loads its scoped journals once, and a partial contact reader receives no reversible ID', t => {
  const f = fixture(t), merged = f.merge();
  f.edit(state => {
    for (let n = 0; n < 500; n++) state.contacts.push({ id: 'manual-list-' + n, name: 'Manual RAM ' + n, type: 'person', phone: '', email: '', notes: '', tags: [], identities: [], version: 1 });
  });
  let reads = 0; const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { if (sql.startsWith('SELECT data FROM contact_merge_journals')) reads++; return prepare(sql); };
  const list = f.service.list(f.admin, f.tenantId, { includeArchived: true });
  assert.equal(list.length, 502); assert.equal(reads, 1); assert.equal(list.find(contact => contact.id === f.targetId).reversibleMergeId, merged.mergeId);
  f.store.db.prepare = prepare;
  f.scope({ channelIds: ['wa-target'], departmentIds: ['sales'] });
  assert.equal(Object.hasOwn(f.service.get(f.operator, f.tenantId, f.targetId), 'reversibleMergeId'), false);
  rejectedWithoutWrite(f, 403, () => f.service.mergeUndoPreview(f.operator, f.tenantId, f.targetId, merged.mergeId));
});

test('encrypted synthetic backup and its real SQLite restore preserve the private journal and recovery', async t => {
  const f = fixture(t), merged = f.merge(), directory = await mkdtemp(join(tmpdir(), 'elozi-contact-recovery-')), key = randomBytes(32);
  let restoredStore;
  t.after(async () => {
    restoredStore?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('elozi-contact-recovery-'));
    await rm(directory, { recursive: true, force: true });
  });
  const backup = await createLocalBackup(f.store.db, { destination: directory, key, mediaDirectory: null });
  const checked = await validateBackup(backup.file, { key });
  assert.equal(checked.restoreVerified, true); assert.equal(checked.foreignKeys, 'ok'); assert.ok(checked.tables.includes('contact_merge_journals'));
  const bytes = await readFile(backup.file), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(10, 22));
  decipher.setAAD(bytes.subarray(0, 10)); decipher.setAuthTag(bytes.subarray(22, 38));
  const restoredPath = join(directory, 'restored-synthetic.sqlite'), plain = Buffer.concat([decipher.update(bytes.subarray(38)), decipher.final()]);
  try { await writeFile(restoredPath, plain, { flag: 'wx' }); } finally { plain.fill(0); }
  restoredStore = new Store(restoredPath);
  const auth = new Auth(restoredStore.db, { validateTenant: (actor, id) => restoredStore.tenant(actor, id) }), service = new ContactService(restoredStore, auth);
  const preview = service.mergeUndoPreview(f.operator, f.tenantId, f.targetId, merged.mergeId);
  const restored = service.mergeUndo(f.operator, f.tenantId, f.targetId, { mergeId: merged.mergeId, revision: preview.revision });
  assert.equal(restored.sourceContact.mergedIntoId, undefined); assert.equal(restored.targetContact.reversibleMergeId, undefined);
  assert.ok(service.mergeJournals(f.admin, f.tenantId)[0].undoneAt);
  assert.equal(f.journals()[0].undoneAt, undefined, 'Restaurar teste não altera a fonte sintética do backup.');
  assert.deepEqual(restoredStore.tenant(f.admin, f.tenantId).conversations[0].messages, f.state().conversations[0].messages);
});

test('SQLite restart preserves the private merge journal and undo with new CAS across two reopenings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-contact-linking-')), path = join(directory, 'synthetic.sqlite');
  let store;
  t.after(async () => {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
    await rmdir(directory);
  });
  const open = () => {
    store = new Store(path);
    const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
    return { auth, service: new ContactService(store, auth) };
  };
  let { auth, service } = open();
  const row = auth.insertUser({ username: 'durable-merge-ram', name: 'Durabilidade sintética' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo');
  const actor = auth.actor(row), tenantId = store.createTenant(actor, { name: 'SQLite descartável QA', segment: 'QA' }).id;
  const source = service.create(actor, tenantId, { name: 'Fonte persistida', notes: 'Original fonte' });
  const target = service.create(actor, tenantId, { name: 'Destino persistido', notes: 'Original destino' });
  store.mutate(actor, tenantId, 'Fixture: vínculo persistido', state => {
    state.channels = [{ id: 'web-persistent', kind: 'webchat', transport: 'elozi-webchat' }];
    const conversation = { id: 'persistent-conversation', channelId: 'web-persistent', contactId: source.id, contact: source.name,
      version: 1, status: 'open', owner: 'queue', messages: [{ id: 'persistent-message', text: 'Mensagens nunca vão ao journal' }] };
    state.conversations.push(conversation); syncConversationContact(state, conversation, state.channels[0]);
  });
  const before = store.tenant(actor, tenantId), preview = service.mergePreview(actor, tenantId, source.id, target.id);
  const merged = service.merge(actor, tenantId, source.id, { targetId: target.id, sourceVersion: preview.sourceContact.version,
    targetVersion: preview.targetContact.version, revision: preview.revision });
  store.close(); store = null;
  ({ auth, service } = open());
  assert.equal(service.get(actor, tenantId, target.id).reversibleMergeId, merged.mergeId);
  const undoPreview = service.mergeUndoPreview(actor, tenantId, target.id, merged.mergeId);
  const restored = service.mergeUndo(actor, tenantId, target.id, { mergeId: merged.mergeId, revision: undoPreview.revision });
  assert.equal(restored.sourceContact.version, merged.sourceContact.version + 1);
  store.close(); store = null;
  ({ auth, service } = open());
  const state = store.tenant(actor, tenantId);
  const journal = service.mergeJournals(actor, tenantId)[0]; assert.ok(journal.undoneAt); assert.equal(journal.id, merged.mergeId);
  assert.deepEqual(state.conversations[0].messages, before.conversations[0].messages);
  assert.equal(state.conversations[0].contactId, source.id); assert.equal(state.conversations[0].version, 3);
  for (const original of before.contacts) {
    const value = state.contacts.find(contact => contact.id === original.id);
    for (const key of Object.keys(original).filter(key => !['version', 'updatedAt'].includes(key))) assert.deepEqual(value[key], original[key]);
  }
  assert.equal(Object.hasOwn(service.get(actor, tenantId, target.id), 'reversibleMergeId'), false);
});
