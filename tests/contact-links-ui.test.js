import * as i18n from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createContactLinksUI } from '../public/contact-links-ui.js';
import { clientRecordMarkup } from '../public/workspace-ui.js';
import { excerpt } from './helpers/app-source.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const decode = value => value.replace(/&(quot|amp|lt|gt|#39);/g, (_, key) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" }[key]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const record = (id, extra = {}) => ({ id, name: 'Cadastro próprio ' + id, type: 'person', phone: '', email: '', notes: 'Notas conservadas',
  tags: ['Próprio'], identities: [], version: 1, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', ...extra });
const revisionA = 'a'.repeat(64), revisionB = 'b'.repeat(64);
class FormDataAdapter {
  constructor(form) { this.form = form; }
  get(name) { const field = this.form.fields.get(name); return field?.type === 'checkbox' && !field.checked ? null : field?.value ?? null; }
  getAll(name) { const value = this.get(name); return value === null ? [] : [value]; }
  has(name) { return this.get(name) !== null; }
  *[Symbol.iterator]() { for (const name of this.form.fields.keys()) if (this.has(name)) yield [name, this.get(name)]; }
}
function fixture(t, { respond, contacts, extraContext = {}, conversation: initialConversation = {} } = {}) {
  const previous = { document: globalThis.document, FormData: globalThis.FormData };
  const context = { workspaceId: 'workspace-a', tenantId: 'tenant-a', userId: 'user-a', authorityKey: 'authority-a',
    view: 'contacts', sequence: 1, refreshSequence: 1, canRead: true, canWrite: true, canTransfer: true, ...extraContext };
  const conversation = { id: 'conversation-a', channelId: 'channel-a', version: 3, status: 'open', owner: 'human', conversationKind: 'direct',
    contactId: null, messages: [{ id: 'own-message', text: 'Mensagem própria intacta', kind: 'customer' }], ...initialConversation };
  const source = record('source-a', { name: 'Origem <própria>', version: 2 }), target = record('target-a', { version: 4 });
  const candidates = contacts || [source, target, record('group', { type: 'group' }), record('archived', { archivedAt: '2026-10-03T00:00:00Z' })];
  const calls = [], mounted = [], errors = [], appliedContacts = [], applied = [], closeHandlers = [], documentHandlers = new Map();
  let currentForm = null;
  const modal = { open: false, firstElementChild: null, closes: 0, isConnected: true,
    // Native dialog.close changes open before its queued close event; its form remains attached.
    close() { this.open = false; this.closes++; for (const handler of closeHandlers) handler(); },
    addEventListener(name, handler) { if (name === 'close') closeHandlers.push(handler); },
    querySelector(selector) { return currentForm?.matches(selector) ? currentForm : null; },
    querySelectorAll() { return currentForm ? [currentForm] : []; } };
  function mount(title, description, type, markup, submitLabel) {
    if (currentForm) currentForm.isConnected = false;
    const fields = new Map();
    for (const [, attrs] of markup.matchAll(/<input\b([^>]*)>/g)) {
      const name = attrs.match(/\bname="([^"]+)"/)?.[1];
      if (name) fields.set(name, { name, value: decode(attrs.match(/\bvalue="([^"]*)"/)?.[1] || (attrs.includes('checkbox') ? 'on' : '')),
        type: attrs.match(/\btype="([^"]+)"/)?.[1] || 'text', checked: /\bchecked\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs) });
    }
    for (const [, attrs, body] of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = attrs.match(/\bname="([^"]+)"/)?.[1]; if (!name) continue;
      const options = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([, attrs, label]) => ({ value: decode(attrs.match(/\bvalue="([^"]*)"/)?.[1] || ''), label, selected: /\bselected\b/.test(attrs) }));
      fields.set(name, { name, value: options.find(option => option.selected)?.value || options[0]?.value || '', type: 'select', options, disabled: false });
    }
    const submit = { disabled: false, isConnected: true }, feedback = { textContent: '' }, count = { textContent: markup.match(/data-contact-link-count[^>]*>([^<]+)/)?.[1] || '' };
    const form = { dataset: { dialogForm: type }, isConnected: true, fields, feedback, submit,
      matches(selector) { return selector === '[data-dialog-form]' || selector === '[data-dialog-form="' + type + '"]' || selector.split(',').some(part => part.trim() === '[data-dialog-form="' + type + '"]'); },
      querySelector(selector) { return selector === '[data-contact-link-count]' ? count : selector.includes('error') || selector.includes('[role="alert"]') ? feedback : selector.includes('submit') ? submit
        : fields.get(selector.match(/\[name="?([^"\]]+)"?\]/)?.[1]) || null; },
      querySelectorAll(selector) { return selector.includes('button') ? [submit] : [...fields.values()]; },
      elements: { namedItem: name => fields.get(name) || null },
      closest(selector) { return selector === '#modal' ? modal : null; },
      contains(node) { return node === submit || node === feedback || [...fields.values()].includes(node); } };
    for (const field of fields.values()) {
      field.closest = selector => selector === '[data-dialog-form="contact-link-select"]' && type === 'contact-link-select' ? form : null;
      if (field.type === 'select') Object.defineProperty(field, 'innerHTML', { set(value) {
        field.options = [...value.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([, attrs, label]) => ({ value: decode(attrs.match(/\bvalue="([^"]*)"/)?.[1] || ''), label, selected: /\bselected\b/.test(attrs) }));
        field.value = field.options.find(option => option.selected)?.value || field.options[0]?.value || '';
      } });
    }
    currentForm = form; modal.open = true; modal.firstElementChild = { title, description, type, markup, form };
    mounted.push({ title, description, type, markup, submitLabel, form }); return form;
  }
  const merged = { sourceContact: { ...source, version: 3, archivedAt: '2026-10-03T00:01:00Z', mergedIntoId: target.id },
    targetContact: { ...target, version: 5 }, mergeId: 'merge-own-a', conversationCount: 2,
    links: [{ conversationId: 'conversation-a', contactId: target.id, version: 4, contactSyncStatus: 'linked' }, { conversationId: 'conversation-own-b', contactId: target.id, version: 2 }] };
  const normal = (path, options = {}) => {
    if (path.endsWith('/contacts?archived=false')) return { contacts: structuredClone(candidates) };
    if (path.includes('/contact-preview?')) return { contact: structuredClone(target), conversationId: conversation.id, channelId: conversation.channelId, version: conversation.version, kind: conversation.conversationKind === 'group' ? 'group' : 'person' };
    if (path.includes('/merge-undo-preview?')) return { sourceContact: structuredClone(merged.sourceContact), targetContact: structuredClone(merged.targetContact), revision: revisionB, conversationCount: 2 };
    if (path.includes('/merge-preview?')) return { sourceContact: structuredClone(source), targetContact: structuredClone(target), revision: revisionA, conversationCount: 2 };
    if (options.method === 'POST' && path.endsWith('/contact')) return { contact: { ...target, version: 5 }, conversationId: conversation.id, version: 4 };
    if (options.method === 'POST' && path.endsWith('/merge')) return structuredClone(merged);
    if (options.method === 'POST' && path.endsWith('/merge-undo')) return { sourceContact: { ...source, version: 4 }, targetContact: { ...target, version: 6 }, mergeId: merged.mergeId, conversationCount: 2,
      links: [{ conversationId: 'conversation-a', contactId: source.id, version: 5, contactSyncStatus: 'linked' }, { conversationId: 'conversation-own-b', contactId: target.id, version: 3 }] };
    if (path.endsWith('/contacts/' + target.id)) return { ...target, reversibleMergeId: merged.mergeId };
    throw Error('Unexpected RAM request: ' + path);
  };
  globalThis.document = { querySelector: selector => selector === '#modal' ? modal : null, addEventListener(name, handler) { documentHandlers.set(name, handler); } };
  globalThis.FormData = FormDataAdapter; t.after(() => Object.assign(globalThis, previous));
  const ui = createContactLinksUI({ getContext: () => ({ ...context }), getConversation: () => conversation, escape,
    getModal: () => modal, formModal: mount,
    request: async (path, options = {}) => { calls.push({ path, options, body: options.body ? JSON.parse(options.body) : null }); return respond ? respond(path, options, normal) : normal(path, options); },
    applyContacts: contacts => appliedContacts.push(structuredClone(contacts)), onApplied: result => applied.push(structuredClone(result)), onError: message => errors.push(message) });
  return { ui, context, conversation, source, target, candidates, calls, mounted, modal, errors, appliedContacts, applied, merged, mount, normal,
    get form() { return currentForm; }, closeWithoutEvent() { modal.open = false; modal.closes++; }, dispatchClose() { for (const handler of closeHandlers) handler(); },
    field(name, value) { const item = currentForm.fields.get(name); assert.ok(item, 'Real modal field: ' + name); if (item.type === 'checkbox') item.checked = value; else item.value = value; },
    input(name, value) { const field = currentForm.fields.get(name); field.value = value; return documentHandlers.get('input')({ target: field }); },
    replaceModal() { return mount('Outro editor', 'Rascunho próprio preservado', 'other', '<input name="query" value="rascunho não salvo"/>', 'Salvar'); } };
}
async function review(f, action = 'contact-merge') {
  if (action === 'contact-associate') f.context.view = 'inbox';
  await f.ui.action(action, action === 'contact-associate' ? f.conversation.id : f.source.id);
  assert.equal(f.form.dataset.dialogForm, 'contact-link-select'); f.field('targetId', f.target.id); await f.ui.submit(f.form);
  assert.equal(f.form.dataset.dialogForm, 'contact-link-confirm');
}
const posts = f => f.calls.filter(call => call.options.method === 'POST');

test('association uses one scoped public preview and explicit confirmation, not messages or a tenant refresh', async t => {
  const f = fixture(t), messages = structuredClone(f.conversation.messages); await review(f, 'contact-associate');
  assert.equal(posts(f).length, 0); assert.ok(f.calls.some(call => call.path === '/api/tenants/tenant-a/conversations/conversation-a/contact-preview?contactId=target-a'));
  await assert.rejects(f.ui.submit(f.form)); assert.equal(posts(f).length, 0); f.field('confirmed', true); await f.ui.submit(f.form);
  assert.equal(posts(f).length, 1); assert.equal(posts(f)[0].path, '/api/tenants/tenant-a/conversations/conversation-a/contact');
  assert.deepEqual(posts(f)[0].body, { contactId: f.target.id, version: 3, contactVersion: 4 });
  assert.equal(posts(f)[0].options.headers['X-Elozi-Workspace'], 'workspace-a');
  assert.equal(f.applied.length, 1); assert.equal(f.appliedContacts.length, 1); assert.deepEqual(f.conversation.messages, messages);
  assert.equal(f.calls.some(call => /\/messages|\/owner|\/bootstrap$|\/api\/tenants\/tenant-a$/.test(call.path)), false);
});

test('merge picker excludes source/archived/groups and posts reviewed versions only after checkbox confirmation', async t => {
  const f = fixture(t); await f.ui.action('contact-merge', f.source.id);
  const choices = f.form.fields.get('targetId').options.map(option => option.value);
  assert.ok(choices.includes(f.target.id)); for (const id of [f.source.id, 'archived', 'group']) assert.equal(choices.includes(id), false);
  f.field('targetId', f.target.id); await f.ui.submit(f.form); assert.equal(posts(f).length, 0);
  assert.match(f.mounted.at(-1).markup, /Origem &lt;própria&gt;/); assert.doesNotMatch(f.mounted.at(-1).markup, /Origem <própria>/);
  f.field('confirmed', true); await f.ui.submit(f.form);
  assert.equal(posts(f).length, 1); assert.equal(posts(f)[0].path, '/api/tenants/tenant-a/contacts/source-a/merge');
  assert.deepEqual(posts(f)[0].body, { targetId: f.target.id, sourceVersion: 2, targetVersion: 4, revision: revisionA });
  assert.equal(f.applied.length, 1); assert.deepEqual(f.appliedContacts[0].map(c => c.id).sort(), [f.source.id, f.target.id].sort());
});

for (const [permission, action] of [['canRead', 'contact-associate'], ['canWrite', 'contact-associate'], ['canTransfer', 'contact-associate'], ['canRead', 'contact-merge'], ['canWrite', 'contact-merge']]) {
  test(permission + ' false prevents ' + action + ' requests, candidates and modal', async t => {
    const f = fixture(t, { extraContext: { [permission]: false } }); await assert.rejects(f.ui.action(action, action === 'contact-associate' ? f.conversation.id : f.source.id));
    assert.equal(f.calls.length, 0); assert.equal(f.mounted.length, 0); assert.equal(f.applied.length, 0);
  });
}

test('already linked or wrong selected conversation cannot start association', async t => {
  const f = fixture(t, { conversation: { contactId: 'existing' }, extraContext: { view: 'inbox' } }); await assert.rejects(f.ui.action('contact-associate', f.conversation.id));
  assert.equal(f.calls.length, 0); f.conversation.contactId = null; await assert.rejects(f.ui.action('contact-associate', 'another-conversation'));
  assert.equal(f.calls.length, 0); assert.equal(f.mounted.length, 0);
});

for (const [field, value] of Object.entries({ workspaceId: 'workspace-b', tenantId: 'tenant-b', userId: 'user-b', authorityKey: 'authority-b', view: 'channels', sequence: 2, refreshSequence: 2 })) {
  test('candidate response delayed after ' + field + ' cannot open a stale picker', async t => {
    const waiting = deferred(), f = fixture(t, { respond: () => waiting.promise }), pending = f.ui.action('contact-merge', 'source-a');
    f.context[field] = value; waiting.resolve({ contacts: f.candidates }); await pending;
    assert.equal(f.mounted.length, 0); assert.equal(f.applied.length, 0);
  });
  test('confirmation stale after ' + field + ' never posts', async t => {
    const f = fixture(t); await review(f); const form = f.form; f.field('confirmed', true); f.context[field] = value;
    await assert.rejects(f.ui.submit(form)); assert.equal(posts(f).length, 0); assert.equal(f.applied.length, 0);
  });
}

for (const invalidate of ['reset', 'close', 'replaced']) {
  test(invalidate + ' during preview prevents replacing the new modal', async t => {
    const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => path.includes('/merge-preview?') ? waiting.promise : normal(path, options) });
    await f.ui.action('contact-merge', f.source.id); f.field('targetId', f.target.id); const oldForm = f.form, pending = f.ui.submit(oldForm);
    if (invalidate === 'reset') f.ui.reset(); if (invalidate === 'close') f.modal.close();
    const newForm = invalidate === 'replaced' ? f.replaceModal() : null;
    waiting.resolve({ sourceContact: f.source, targetContact: f.target, revision: revisionA, conversationCount: 2 }); await pending;
    assert.equal(f.mounted.some(m => m.type === 'contact-link-confirm'), false); if (newForm) assert.strictEqual(f.form, newForm);
    assert.equal(f.applied.length, 0); assert.equal(posts(f).length, 0);
  });
  test(invalidate + ' during mutation prevents closing/applying to another modal or context', async t => {
    const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => options.method === 'POST' ? waiting.promise : normal(path, options) });
    await review(f); f.field('confirmed', true); const pending = f.ui.submit(f.form);
    if (invalidate === 'reset') f.ui.reset(); if (invalidate === 'close') f.modal.close();
    const newForm = invalidate === 'replaced' ? f.replaceModal() : null, closes = f.modal.closes;
    waiting.resolve(f.merged); await pending; assert.equal(posts(f).length, 1); assert.equal(f.applied.length, 0); assert.equal(f.appliedContacts.length, 0);
    assert.equal(f.modal.closes, closes); if (newForm) assert.strictEqual(f.form, newForm);
  });
}

test('one pending confirmation cannot emit two merge requests', async t => {
  const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => options.method === 'POST' ? waiting.promise : normal(path, options) });
  await review(f); f.field('confirmed', true); const first = f.ui.submit(f.form); await f.ui.submit(f.form);
  assert.equal(posts(f).length, 1); waiting.resolve(f.merged); await first; assert.equal(f.applied.length, 1);
});

test('409 keeps the confirmation/choice and blocks another POST until explicit preview refresh', async t => {
  let rejected = false, previews = 0;
  const f = fixture(t, { respond: (path, options, normal) => {
    if (path.includes('/merge-preview?')) { previews++; return { ...normal(path, options), revision: previews > 1 ? revisionB : revisionA, targetContact: previews > 1 ? { ...normal(path, options).targetContact, version: 5 } : normal(path, options).targetContact }; }
    if (options.method === 'POST' && !rejected) { rejected = true; throw Object.assign(new Error('Revisão mudou em RAM'), { status: 409 }); }
    const result = normal(path, options);
    return options.method === 'POST' ? { ...result, targetContact: { ...result.targetContact, version: 6 } } : result;
  } });
  await review(f); f.field('confirmed', true); const original = f.form; await assert.rejects(f.ui.submit(original), error => error.status === 409);
  assert.strictEqual(f.form, original); assert.equal(original.fields.get('confirmed').checked, true); assert.equal(posts(f).length, 1); assert.equal(f.applied.length, 0);
  await assert.rejects(f.ui.submit(original)); assert.equal(posts(f).length, 1);
  await f.ui.action('contact-link-refresh'); assert.equal(previews, 2); assert.equal(posts(f).length, 1);
  f.field('confirmed', true); await f.ui.submit(f.form); assert.equal(posts(f).length, 2); assert.equal(posts(f)[1].body.revision, revisionB); assert.equal(posts(f)[1].body.targetVersion, 5);
});

test('a target not in the current picker cannot be reviewed or posted', async t => {
  const f = fixture(t); await f.ui.action('contact-merge', f.source.id); f.field('targetId', 'forged-target'); await assert.rejects(f.ui.submit(f.form));
  assert.equal(f.calls.filter(call => call.path.includes('/merge-preview?')).length, 0); assert.equal(posts(f).length, 0); assert.equal(f.applied.length, 0);
});

test('picker shows at most50 scoped options and real input listener searches beyond the first page without a request', async t => {
  const contacts = [record('source-a', { version: 2 }), ...Array.from({ length: 71 }, (_, i) => record('candidate-' + i)),
    record('last-own', { name: 'Érica final', phone: '11911112222', email: 'own@example.test', tags: ['ÚLTIMA'] }), record('wrong-kind', { type: 'group' }), record('archived', { archivedAt: '2026-10-03' })];
  const f = fixture(t, { contacts }); await f.ui.action('contact-merge', 'source-a'); const select = f.form.fields.get('targetId');
  assert.equal(select.options.filter(option => option.value).length, 50); assert.equal(select.options.some(option => option.value === 'last-own'), false);
  for (const query of ['ERICA', '11911112222', 'own@example.test', 'ultima']) {
    f.input('query', query); assert.deepEqual(select.options.filter(option => option.value).map(option => option.value), ['last-own']);
  }
  f.input('query', 'não existe'); assert.equal(select.options.filter(option => option.value).length, 0); assert.equal(select.value, '');
  assert.equal(f.calls.length, 1); assert.equal(posts(f).length, 0); assert.equal(f.form.querySelector('[data-contact-link-count]').textContent.startsWith('0 cadastros'), true);
});

test('group association offers only active group targets, not person/company/source or archived contacts', async t => {
  const f = fixture(t, { extraContext: { view: 'inbox' }, conversation: { conversationKind: 'group' } });
  await f.ui.action('contact-associate', f.conversation.id); const options = f.form.fields.get('targetId').options.filter(o => o.value);
  assert.deepEqual(options.map(o => o.value), ['group']); assert.equal(posts(f).length, 0);
});

test('undo uses a fresh reversibleMergeId lookup and its own preview/confirmation before posting', async t => {
  const f = fixture(t); await review(f); f.field('confirmed', true); await f.ui.submit(f.form); const priorPosts = posts(f).length;
  await f.ui.action('contact-undo-merge', f.target.id); assert.equal(f.form.dataset.dialogForm, 'contact-link-confirm');
  assert.ok(f.calls.some(call => call.path === '/api/tenants/tenant-a/contacts/target-a'));
  assert.ok(f.calls.some(call => call.path === '/api/tenants/tenant-a/contacts/target-a/merge-undo-preview?mergeId=merge-own-a'));
  assert.equal(posts(f).length, priorPosts); f.field('confirmed', true); await f.ui.submit(f.form);
  assert.equal(posts(f).length, priorPosts + 1); assert.equal(posts(f).at(-1).path, '/api/tenants/tenant-a/contacts/target-a/merge-undo');
  assert.deepEqual(posts(f).at(-1).body, { mergeId: f.merged.mergeId, revision: revisionB });
  assert.equal(f.applied.at(-1).operation, 'undo'); assert.equal(f.appliedContacts.at(-1).length, 2);
});

for (const response of [record('another-target', { reversibleMergeId: 'own' }), record('target-a'), record('target-a', { reversibleMergeId: '' }), null]) {
  test('undo rejects an unavailable or inconsistent fresh destination without calling preview or mutation: ' + String(response?.id || 'null') + '/' + String(response?.reversibleMergeId), async t => {
    const f = fixture(t, { respond: () => response }); await assert.rejects(f.ui.action('contact-undo-merge', f.target.id));
    assert.equal(f.calls.length, 1); assert.equal(posts(f).length, 0); assert.equal(f.applied.length, 0);
  });
}

for (const permission of ['canRead', 'canWrite', 'canTransfer']) {
  test('permission ' + permission + ' revoked while preview awaits prevents confirmation', async t => {
    const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => path.includes('/merge-preview?') ? waiting.promise : normal(path, options) });
    await f.ui.action('contact-merge', f.source.id); f.field('targetId', f.target.id); const pending = f.ui.submit(f.form); f.context[permission] = false;
    waiting.resolve({ sourceContact: f.source, targetContact: f.target, revision: revisionA, conversationCount: 2 }); await pending;
    assert.equal(f.mounted.filter(m => m.type === 'contact-link-confirm').length, 0); assert.equal(f.applied.length, 0);
  });
}

for (const phase of ['preview', 'mutation']) {
  test('replacing only the FORM inside the same modal content during ' + phase + ' never replaces/applies/closes the new editor', async t => {
    const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => phase === 'preview' && path.includes('/merge-preview?') || phase === 'mutation' && options.method === 'POST' ? waiting.promise : normal(path, options) });
    if (phase === 'preview') { await f.ui.action('contact-merge', f.source.id); f.field('targetId', f.target.id); } else { await review(f); f.field('confirmed', true); }
    const old = f.form, wrapper = f.modal.firstElementChild, pending = f.ui.submit(old), newForm = f.replaceModal();
    f.modal.firstElementChild = wrapper; wrapper.form = newForm; const mounts = f.mounted.length;
    waiting.resolve(phase === 'preview' ? { sourceContact: f.source, targetContact: f.target, revision: revisionA, conversationCount: 2 } : f.merged); await pending;
    assert.strictEqual(f.form, newForm); assert.equal(f.mounted.length, mounts); assert.equal(f.modal.closes, 0);
    assert.equal(newForm.fields.get('query').value, 'rascunho não salvo'); assert.equal(f.applied.length, 0); assert.equal(f.appliedContacts.length, 0);
  });
}

test('reset explicitly invalidates A→B→A context and discards its old candidate response', async t => {
  const waiting = deferred(), f = fixture(t, { respond: () => waiting.promise }), pending = f.ui.action('contact-merge', f.source.id);
  f.context.view = 'inbox'; f.ui.reset(); f.context.view = 'contacts'; waiting.resolve({ contacts: f.candidates }); await pending;
  assert.equal(f.mounted.length, 0); assert.equal(f.applied.length, 0);
});

test('association response delayed after Inbox selection changes never opens confirmation for the old conversation', async t => {
  const waiting = deferred(), f = fixture(t, { extraContext: { view: 'inbox' }, respond: (path, options, normal) => path.includes('/contact-preview?') ? waiting.promise : normal(path, options) });
  await f.ui.action('contact-associate', f.conversation.id); f.field('targetId', f.target.id); const pending = f.ui.submit(f.form);
  f.conversation.id = 'another-selection'; waiting.resolve({ contact: f.target, conversationId: 'conversation-a', channelId: 'channel-a', version: 3, kind: 'person' }); await pending;
  assert.equal(f.mounted.filter(m => m.type === 'contact-link-confirm').length, 0); assert.equal(posts(f).length, 0);
});

for (const [name, mutate] of [
  ['wrong contact', p => { p.contact.id = 'other'; }], ['wrong conversation', p => { p.conversationId = 'other'; }],
  ['wrong channel', p => { p.channelId = 'other'; }], ['invalid version', p => { p.version = 0; }],
  ['invalid contact revision', p => { p.contact.version = 0; }], ['wrong kind', p => { p.kind = 'group'; }],
  ['archived contact', p => { p.contact.archivedAt = '2026-10-03'; }], ['merged contact', p => { p.contact.mergedIntoId = 'other'; }]
]) {
  test('association rejects ' + name + ' in the real server preview before confirmation', async t => {
    const f = fixture(t, { respond: (path, options, normal) => { const p = normal(path, options); if (path.includes('/contact-preview?')) mutate(p); return p; } });
    f.context.view = 'inbox'; await f.ui.action('contact-associate', f.conversation.id); f.field('targetId', f.target.id); await assert.rejects(f.ui.submit(f.form));
    assert.equal(f.mounted.filter(m => m.type === 'contact-link-confirm').length, 0); assert.equal(posts(f).length, 0);
  });
}

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function appFixture(t, { associated = true, status, links } = {}) {
  const f = fixture(t, { extraContext: { view: 'inbox' }, conversation: { contactId: associated ? 'source-a' : null, contactSyncStatus: 'capacity' } });
  const state = { workspaceId: f.context.workspaceId, view: 'inbox', conversation: f.conversation.id, refreshSequence: 1, inboxSelectionSequence: 1,
    tenant: { id: f.context.tenantId, conversations: [f.conversation] }, contacts: [f.source, f.target],
    boot: { session: { userId: f.context.userId } } };
  const effects = [], footer = { innerHTML: 'Versão 3' }, draft = { value: 'Resposta própria ainda não enviada', selectionStart: 7, selectionEnd: 18 },
    note = { value: 'Nota privada em edição' }, player = { currentTime: 17, paused: false }, messages = { scrollTop: 92 }, nodes = new Map();
  let client;
  const document = { activeElement: draft, createElement(type) {
    assert.equal(type, 'template'); let html = '';
    return { set innerHTML(value) { html = value; }, content: { get firstElementChild() { return node(html); } } };
  } };
  function node(html) {
    const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => ({ dataset: Object.fromEntries([...attrs.matchAll(/data-(action|id)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)])),
      focus() { document.activeElement = this; } })), notes = html.includes('class="client-notes"') ? { open: false } : null;
    return { outerHTML: html, isConnected: true, querySelector: selector => selector === '.client-notes' ? notes : null, querySelectorAll: () => buttons,
      contains: item => buttons.includes(item), replaceWith(fresh) { this.isConnected = false; client = fresh; nodes.set('.context-client-record', fresh); },
      remove() { this.isConnected = false; client = null; nodes.delete('.context-client-record'); } };
  }
  client = node(clientRecordMarkup(f.conversation, { contacts: state.contacts, canRead: true, canWrite: true, canTransfer: true, escape, icon: () => '' }));
  client.querySelector('.client-notes') && (client.querySelector('.client-notes').open = true);
  for (const [selector, value] of [['.context-client-record', client], ['.context-version', footer], ['#modal', f.modal], ['#message-text', draft], ['#internal-note', note], ['#messages', messages], ['.message-player', player]]) nodes.set(selector, value);
  const api = async (path, options = {}) => {
    f.calls.push({ path, options, body: options.body ? JSON.parse(options.body) : null }); const result = f.normal(path, options);
    if (options.method === 'POST' && path.endsWith('/contact') && status !== undefined) result.contactSyncStatus = status;
    if (options.method === 'POST' && links) result.links = links;
    return result;
  };
  const captureLine = appSource.split('\n').find(line => line.startsWith('function captureAttendance()'));
  assert.ok(captureLine);
  const globals = { ...i18n, state, document, createContactLinksUI, clientRecordMarkup, escape, icon: () => '', api,
    currentConversation: () => state.tenant.conversations.find(c => c.id === state.conversation), hasPermission: () => true,
    inboxContactAuthority: () => f.context.authorityKey, formModal: f.mount, $: selector => nodes.get(selector) || null,
    contactRefresh: { reset() { effects.push('refresh-reset'); } }, memoryUI: { reset() {} }, toast: message => effects.push(['toast', message]),
    avatarUI: { bind() { effects.push('avatar-bind'); } }, workspaceUI: { views: { contacts: () => assert.fail('No directory rerender during inbox operation.') } },
    attendanceContext: () => ({ workspaceId: state.workspaceId, tenantId: state.tenant.id }), tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail,
    render: () => assert.fail('No full chat render.'), refresh: () => assert.fail('No bootstrap/tenant refresh.'), mediaUI: { reset: () => assert.fail('No draft/media reset.'), bindPlayers: () => assert.fail('No player restart.') } };
  const real = runInNewContext([
    excerpt('contact-link-result-refresh'),
    excerpt('contacts-page'), captureLine,
    '({contactLinksUI,applyContactLinkResult,captureAttendance})'
  ].join('\n'), globals);
  return { ...f, ui: real.contactLinksUI, state, effects, footer, draft, note, player, messages, nodes, captureAttendance: real.captureAttendance,
    get form() { return f.form; }, get client() { return client; } };
}

test('served integration merges and immediately undoes the selected link/CAS, preserving chat drafts, notes and playing media', async t => {
  const f = appFixture(t), conversation = f.conversation, messages = f.conversation.messages, priorDraft = f.draft, priorPlayer = f.player;
  await review(f); f.field('confirmed', true); await f.ui.submit(f.form);
  assert.equal(conversation.contactId, 'target-a'); assert.equal(conversation.version, 4); assert.equal(conversation.contactSyncStatus, 'linked');
  assert.match(f.footer.innerHTML, /Versão 4/); assert.equal(f.captureAttendance().version, 4); assert.match(f.client.outerHTML, /Cadastro próprio target-a/);
  assert.equal(f.client.querySelector('.client-notes').open, true);
  await f.ui.action('contact-undo-merge', 'target-a'); f.field('confirmed', true); await f.ui.submit(f.form);
  assert.equal(conversation.contactId, 'source-a'); assert.equal(conversation.version, 5); assert.equal(f.captureAttendance().version, 5);
  assert.match(f.footer.innerHTML, /Versão 5/); assert.match(f.client.outerHTML, /Origem &lt;própria&gt;/); assert.equal(f.client.querySelector('.client-notes').open, true);
  assert.strictEqual(f.conversation.messages, messages); assert.strictEqual(f.draft, priorDraft); assert.strictEqual(f.nodes.get('.message-player'), priorPlayer);
  assert.equal(f.draft.value, 'Resposta própria ainda não enviada'); assert.equal(f.draft.selectionStart, 7); assert.equal(f.draft.selectionEnd, 18);
  assert.equal(f.note.value, 'Nota privada em edição'); assert.equal(f.player.currentTime, 17); assert.equal(f.player.paused, false); assert.equal(f.messages.scrollTop, 92);
  assert.equal(f.calls.some(call => /\/messages|\/owner|\/bootstrap$/.test(call.path)), false); assert.equal(posts(f).length, 2);
});

for (const status of [undefined, 'linked']) {
  test('served association applies exact response CAS and ' + String(status) + ' sync status without inferring a capacity marker', async t => {
    const f = appFixture(t, { associated: false, status }); await review(f, 'contact-associate'); f.field('confirmed', true); await f.ui.submit(f.form);
    assert.equal(f.conversation.contactId, 'target-a'); assert.equal(f.conversation.version, 4); assert.equal(f.captureAttendance().version, 4);
    assert.equal(f.conversation.contactSyncStatus, status); assert.match(f.client.outerHTML, /Cadastro próprio target-a/); assert.equal(f.player.currentTime, 17);
    assert.equal(f.draft.value, 'Resposta própria ainda não enviada'); assert.equal(f.calls.length, 3); assert.equal(posts(f).length, 1);
  });
}

test('served integration never overwrites selected conversation linkage/CAS from another returned conversation', async t => {
  const f = appFixture(t, { links: [{ conversationId: 'conversation-own-b', contactId: 'target-a', version: 9 }] });
  await review(f); f.field('confirmed', true); await f.ui.submit(f.form);
  assert.equal(f.conversation.contactId, 'source-a'); assert.equal(f.conversation.version, 3); assert.equal(f.captureAttendance().version, 3);
  assert.equal(f.conversation.contactSyncStatus, 'capacity'); assert.equal(f.footer.innerHTML, 'Versão 3'); assert.equal(f.player.currentTime, 17);
});

for (const [name, mutate] of [
  ['wrong source', p => { p.sourceContact.id = 'other'; }], ['wrong destination', p => { p.targetContact.id = 'other'; }],
  ['same source/destination', p => { p.targetContact.id = p.sourceContact.id; }], ['bad revision', p => { p.revision = 'not-a-revision'; }],
  ['negative count', p => { p.conversationCount = -1; }], ['wrong group kind', p => { p.targetContact.type = 'group'; }],
  ['invalid target version', p => { p.targetContact.version = 0; }]
]) {
  test('merge rejects ' + name + ' in preview without mutating', async t => {
    const f = fixture(t, { respond: (path, options, normal) => { const p = normal(path, options); if (path.includes('/merge-preview?')) mutate(p); return p; } });
    await f.ui.action('contact-merge', f.source.id); f.field('targetId', f.target.id); await assert.rejects(f.ui.submit(f.form));
    assert.equal(f.mounted.filter(m => m.type === 'contact-link-confirm').length, 0); assert.equal(posts(f).length, 0);
  });
}

for (const [name, mutate] of [
  ['wrong source', p => { p.sourceContact.id = 'other'; }], ['wrong destination', p => { p.targetContact.id = 'other'; }],
  ['no new source version', p => { p.sourceContact.version = 2; }], ['no new target version', p => { p.targetContact.version = 4; }],
  ['different count', p => { p.conversationCount = 3; }], ['missing mergeId', p => { delete p.mergeId; }],
  ['missing source archive', p => { delete p.sourceContact.archivedAt; }], ['wrong mergedIntoId', p => { p.sourceContact.mergedIntoId = 'other'; }]
]) {
  test('merge incoherent receipt ' + name + ' never applies or automatically repeats a possibly committed mutation', async t => {
    const f = fixture(t, { respond: (path, options, normal) => { const p = normal(path, options); if (options.method === 'POST') mutate(p); return p; } });
    await review(f); f.field('confirmed', true); const form = f.form; await assert.rejects(f.ui.submit(form));
    assert.equal(f.applied.length, 0); assert.equal(f.appliedContacts.length, 0); assert.equal(f.modal.closes, 0);
    await assert.rejects(f.ui.submit(form)); assert.equal(posts(f).length, 1);
  });
}

for (const error of [new TypeError('Resposta perdida'), Object.assign(new Error('Temporário'), { status: 503 })]) {
  test('uncertain mutation ' + error.name + ' preserves confirmation and requires reconciliation, not replay', async t => {
    const f = fixture(t, { respond: (path, options, normal) => { if (options.method === 'POST') throw error; return normal(path, options); } });
    await review(f); f.field('confirmed', true); const form = f.form; await assert.rejects(f.ui.submit(form));
    assert.strictEqual(f.form, form); assert.equal(form.fields.get('confirmed').checked, true); assert.equal(f.applied.length, 0);
    await assert.rejects(f.ui.submit(form)); assert.equal(posts(f).length, 1);
  });
}

for (const phase of ['preview', 'mutation']) {
  test('dialog closes before its queued close event during ' + phase + '; an earlier response cannot reopen or apply', async t => {
    const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => phase === 'preview' && path.includes('/merge-preview?') || phase === 'mutation' && options.method === 'POST' ? waiting.promise : normal(path, options) });
    if (phase === 'preview') { await f.ui.action('contact-merge', f.source.id); f.field('targetId', f.target.id); }
    else { await review(f); f.field('confirmed', true); }
    const form = f.form, mounts = f.mounted.length, pending = f.ui.submit(form); f.closeWithoutEvent();
    assert.equal(form.isConnected, true, 'Closing a native dialog does not detach its form.');
    waiting.resolve(phase === 'preview' ? { sourceContact: f.source, targetContact: f.target, revision: revisionA, conversationCount: 2 } : f.merged); await pending;
    assert.equal(f.modal.open, false); assert.equal(f.mounted.length, mounts); assert.equal(f.applied.length, 0); assert.equal(f.appliedContacts.length, 0);
    f.dispatchClose(); await assert.rejects(f.ui.submit(form));
  });
}

for (const eventPhase of ['before candidate response', 'after new picker opened']) {
  test('queued close event from an older dialog does not invalidate a new operation ' + eventPhase, async t => {
    let delayed = false; const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => delayed && path.endsWith('/contacts?archived=false') ? waiting.promise : normal(path, options) });
    await review(f); f.closeWithoutEvent(); delayed = true; const pending = f.ui.action('contact-merge', f.source.id);
    if (eventPhase === 'before candidate response') f.dispatchClose();
    waiting.resolve({ contacts: f.candidates }); await pending;
    assert.equal(f.form.dataset.dialogForm, 'contact-link-select'); assert.equal(f.modal.open, true);
    if (eventPhase === 'after new picker opened') f.dispatchClose();
    f.field('targetId', f.target.id); await f.ui.submit(f.form); assert.equal(f.form.dataset.dialogForm, 'contact-link-confirm');
    f.field('confirmed', true); await f.ui.submit(f.form); assert.equal(posts(f).length, 1); assert.equal(f.applied.length, 1);
  });
}

for (const [name, mutate] of [
  ['different conversation', p => { p.conversationId = 'other'; }], ['different contact', p => { p.contact.id = 'other'; }],
  ['older conversation version', p => { p.version = 2; }], ['malformed contact version', p => { p.contact.version = 0; }]
]) {
  test('association incoherent receipt ' + name + ' never applies or repeats its mutation', async t => {
    const f = fixture(t, { respond: (path, options, normal) => { const p = normal(path, options); if (options.method === 'POST') mutate(p); return p; } });
    await review(f, 'contact-associate'); f.field('confirmed', true); const form = f.form;
    await assert.rejects(f.ui.submit(form)); assert.equal(f.applied.length, 0); assert.equal(f.appliedContacts.length, 0); assert.equal(f.modal.open, true);
    await assert.rejects(f.ui.submit(form)); assert.equal(posts(f).length, 1);
  });
}

test('undo 409 preserves its chosen merge and requires a fresh reviewed revision before another POST', async t => {
  let first = true, previews = 0;
  const f = fixture(t, { respond: (path, options, normal) => {
    if (path.includes('/merge-undo-preview?')) { previews++; return { ...normal(path, options), revision: previews === 1 ? revisionA : revisionB }; }
    if (options.method === 'POST' && first) { first = false; throw Object.assign(new Error('A união mudou.'), { status: 409 }); }
    return normal(path, options);
  } });
  await f.ui.action('contact-undo-merge', f.target.id); f.field('confirmed', true); const form = f.form;
  await assert.rejects(f.ui.submit(form), error => error.status === 409); assert.strictEqual(f.form, form); assert.equal(form.fields.get('confirmed').checked, true);
  await assert.rejects(f.ui.submit(form)); assert.equal(posts(f).length, 1); await f.ui.action('contact-link-refresh');
  assert.equal(f.form.fields.get('confirmed').checked, false); f.field('confirmed', true); await f.ui.submit(f.form);
  assert.equal(posts(f).length, 2); assert.deepEqual(posts(f).at(-1).body, { mergeId: 'merge-own-a', revision: revisionB }); assert.equal(f.applied.length, 1);
});

for (const response of [{ contacts: null }, { contacts: [null] }, { contacts: [record('bad', { version: '1' })] }]) {
  test('invalid candidate DTO rejects without replacing an existing unrelated editor: ' + JSON.stringify(response), async t => {
    const f = fixture(t, { respond: () => response }), editor = f.replaceModal();
    await assert.rejects(f.ui.action('contact-merge', f.source.id)); assert.strictEqual(f.form, editor); assert.equal(f.modal.open, true);
    assert.equal(editor.fields.get('query').value, 'rascunho não salvo'); assert.equal(posts(f).length, 0); assert.equal(f.applied.length, 0);
  });
}

for (const phase of ['candidates', 'preview', 'undo lookup']) for (const invalidate of ['context', 'modal']) {
  test('rejected ' + phase + ' GET after ' + invalidate + ' changed stays silent and preserves the new editor', async t => {
    const waiting = deferred(), f = fixture(t, { respond: (path, options, normal) => phase === 'candidates' && path.endsWith('/contacts?archived=false') || phase === 'preview' && path.includes('/merge-preview?') || phase === 'undo lookup' && path.endsWith('/contacts/target-a') ? waiting.promise : normal(path, options) });
    let pending;
    if (phase === 'preview') { await f.ui.action('contact-merge', f.source.id); f.field('targetId', f.target.id); pending = f.ui.submit(f.form); }
    else pending = f.ui.action(phase === 'candidates' ? 'contact-merge' : 'contact-undo-merge', phase === 'candidates' ? f.source.id : f.target.id);
    if (invalidate === 'context') f.context.tenantId = 'tenant-b'; const editor = invalidate === 'modal' ? f.replaceModal() : f.form, mounts = f.mounted.length, wasOpen = f.modal.open;
    waiting.reject(Object.assign(new Error('Acesso do pedido antigo mudou.'), { status: 403 })); await assert.doesNotReject(pending);
    assert.strictEqual(f.form, editor); assert.equal(f.mounted.length, mounts); assert.equal(f.modal.open, wasOpen);
    if (invalidate === 'modal') assert.equal(editor.fields.get('query').value, 'rascunho não salvo');
    assert.equal(f.applied.length, 0); assert.equal(f.appliedContacts.length, 0); assert.equal(posts(f).length, 0);
  });
}

for (const [name, mutate] of [
  ['absent links', p => { delete p.links; }], ['non-array links', p => { p.links = {}; }],
  ['duplicate conversation', p => { p.links.push({ ...p.links[0] }); }],
  ['invalid CAS', p => { p.links[0].version = 0; }], ['empty conversation', p => { p.links[0].conversationId = ''; }],
  ['invalid status', p => { p.links[0].contactSyncStatus = 'forged'; }]
]) {
  test('merge rejects ' + name + ' before applying a receipt or replaying its mutation', async t => {
    const f = fixture(t, { respond: (path, options, normal) => { const p = normal(path, options); if (options.method === 'POST') mutate(p); return p; } });
    await review(f); f.field('confirmed', true); const form = f.form; await assert.rejects(f.ui.submit(form));
    assert.equal(f.applied.length, 0); assert.equal(f.appliedContacts.length, 0); assert.equal(f.modal.open, true);
    await assert.rejects(f.ui.submit(form)); assert.equal(posts(f).length, 1);
  });
}
