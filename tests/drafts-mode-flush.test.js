import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftsStore, rememberComposerRoute } from '../public/drafts-store.js';
import { createInternalNoteDrafts } from '../public/attendance-ui.js';

// Separate reply and note forms must never cross. Generic note callers without
// persistenceKey remain memory-only. The served app opts in with a public scope
// stamp; actual reload/TTL/revocation regressions are in internal-note-persistence.test.js.
function sessionFixture(t) {
  const map = new Map();
  const storage = {
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
  const originals = new Map(['sessionStorage', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { get() { assert.fail('must not access localStorage'); }, configurable: true });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return storage;
}
const ref = { tenantId: 't1', conversationId: 'c1' };
const context = { userId: 'u1', workspaceId: 'w1', tenantId: 't1', authorityKey: 'authority1', conversationId: 'c1', active: true, allowedIds: ['c1'] };
const replyStore = (workspaceId = 'w1') => createDraftsStore({ userId: 'u1', workspaceId, now: () => 1000 });
function documentWithForms(reply, note, hash = '#inbox/t1/c1?w=w1') {
  return {
    getElementById: id => ({ 'message-text': reply, 'internal-note-text': note })[id] ?? null,
    defaultView: { location: { hash } }
  };
}

test('active note form does not turn the separate reply textarea into a note draft', t => {
  sessionFixture(t);
  const notes = createInternalNoteDrafts();
  notes.sync(context);
  notes.save('Synthetic private note'); // app.js internal-note-text input handler.
  const doc = documentWithForms(
    { value: 'Synthetic customer reply', disabled: false },
    { value: notes.value, disabled: false }
  );
  assert.equal(replyStore().flush(doc), true);
  assert.deepEqual(replyStore().entry(ref), { text: 'Synthetic customer reply', mode: 'reply', updatedAt: 1000 });
  assert.equal(notes.value, 'Synthetic private note');
});

test('legacy opt-out: note without persistenceKey stays memory-only while reply survives', t => {
  const session = sessionFixture(t);
  const before = createInternalNoteDrafts();
  before.sync(context);
  assert.equal(before.save('Synthetic unsent internal note'), true);
  const doc = documentWithForms({ value: 'Synthetic unsent reply', disabled: false }, { value: before.value, disabled: false });
  assert.equal(replyStore().flush(doc), true);
  const reloadedNotes = createInternalNoteDrafts();
  reloadedNotes.sync(context);
  assert.equal(reloadedNotes.value, '', 'known loss: new note store has no sessionStorage hydration');
  assert.deepEqual(replyStore().entry(ref), { text: 'Synthetic unsent reply', mode: 'reply', updatedAt: 1000 });
  assert.equal(session.length, 1, 'only the separate reply draft persisted');
  assert.equal(before.value, 'Synthetic unsent internal note', 'old instance still holds the note in memory');
});

test('hashchange flush binds the separate reply to the old route and never captures note content', t => {
  sessionFixture(t);
  const doc = documentWithForms({ value: 'Reply for c1', disabled: false }, { value: 'Private note for c1', disabled: false });
  doc.defaultView.location.hash = '#inbox/t1/c2?w=w1';
  assert.equal(rememberComposerRoute('https://example.test/app#inbox/t1/c1?w=w1', doc), true);
  assert.equal(replyStore().flush(doc), true);
  const reloaded = replyStore();
  assert.deepEqual(reloaded.entry(ref), { text: 'Reply for c1', mode: 'reply', updatedAt: 1000 });
  assert.equal(reloaded.entry({ tenantId: 't1', conversationId: 'c2' }), null);
});

test('disabled reply field cannot persist the enabled internal note via the reply lifecycle flush', t => {
  const session = sessionFixture(t);
  const doc = documentWithForms({ value: 'Disabled reply', disabled: true }, { value: 'Enabled private note', disabled: false });
  assert.equal(replyStore().flush(doc), false);
  assert.equal(session.length, 0);
});

test('reply flush rejects a foreign workspace without reading the independent note field', t => {
  const session = sessionFixture(t);
  const doc = documentWithForms({ value: 'Reply fixture', disabled: false }, { get value() { assert.fail('must not read private note through reply flush'); } }, '#inbox/t1/c1?w=w2');
  assert.equal(replyStore().flush(doc), false);
  assert.equal(session.length, 0);
});

test('internal-note memory stays isolated across tenants and is cleared on authority, user, or workspace changes', t => {
  sessionFixture(t);
  for (const change of [{ authorityKey: 'authority2' }, { userId: 'u2' }, { workspaceId: 'w2' }]) {
    const notes = createInternalNoteDrafts();
    notes.sync(context); notes.save('Private note A');
    notes.sync({ ...context, tenantId: 't2' });
    assert.equal(notes.value, '');
    notes.save('Private note B');
    notes.sync(context); assert.equal(notes.value, 'Private note A');
    notes.sync({ ...context, ...change });
    assert.equal(notes.value, ''); assert.equal(notes.count, 0);
  }
});