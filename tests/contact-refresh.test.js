import * as i18n from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import { createContactRefresh } from '../public/contact-refresh.js';
import { createWorkspaceUI, clientRecordMarkup } from '../public/workspace-ui.js';
import { excerpt } from './helpers/app-source.js';
import { createJsonRead } from '../public/json-read.js';
import { createDataSource } from '../public/data-source.js';
import { sessionExpired } from '../public/session-guard.js';
// A 401 goes through session-guard.js (FRONTEND-V2 §8.1, P1 commit 1f): the real sessionExpired runs with the fixture's location.
const withSessionGuard = globals => Object.assign(globals, { sessionExpired: options => sessionExpired({ ...options, location: globals.location }) });
import { parseHash } from '../public/router.js';
import { inboxRouteFilters } from '../public/inbox-route-filters.js';
import { defaultLens, INBOX_PAGE } from '../public/inbox-list-ui.js';
import { viewForRoute, hashForView, conversationHash } from '../public/nav-config.js';

const revisionA = 'a'.repeat(64), revisionB = 'b'.repeat(64);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const contact = (id = 'contact-a', extra = {}) => ({
  id, name: 'Contato próprio ' + id, type: 'person', email: '', phone: '', notes: '',
  tags: [], identities: [], version: 1, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', ...extra
});
const changed = (contacts = [contact()], revision = revisionA) => ({ revision, unchanged: false, contacts });
function fixture(extra = {}) {
  const context = { userId: 'user-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', supportGrantId: null,
    authorityKey: 'authority-a', refreshSequence: 1, view: 'contacts', paused: false, canRead: true, ...extra };
  const calls = [], accepted = [], denied = [];
  let records = [contact('last-authorized')];
  const ui = createContactRefresh({
    getContext: () => ({ ...context }),
    request: (path, options) => {
      const operation = deferred(); calls.push({ path, options, ...operation });
      // The fake transport deliberately ignores abort to exercise late-response guards.
      return operation.promise;
    },
    onContacts: contacts => { records = contacts; accepted.push(contacts); },
    onDenied: error => { records = []; denied.push(error); }
  });
  const accept = async (contacts = [contact()], revision = revisionA) => {
    const promise = ui.refresh(); calls.at(-1).resolve(changed(contacts, revision));
    assert.equal(await promise, true); return promise;
  };
  return { context, ui, calls, accepted, denied, accept, get records() { return records; } };
}

test('real controller requests only the captured tenant/workspace/grant and accepts a fresh public agenda', async () => {
  const f = fixture({ tenantId: 'tenant/a b', workspaceId: 'workspace-b', supportGrantId: 'grant-own' });
  const promise = f.ui.refresh();
  assert.equal(f.calls[0].path, '/api/tenants/tenant%2Fa%20b/contacts?archived=true&snapshot=true');
  assert.deepEqual(f.calls[0].options.headers, { 'X-Elozi-Workspace': 'workspace-b', 'X-Elozi-Support-Grant': 'grant-own' });
  assert.equal(f.calls[0].options.signal.aborted, false);
  const rows = [contact('own-live')]; f.calls[0].resolve(changed(rows));
  assert.equal(await promise, true); assert.strictEqual(f.records, rows); assert.equal(f.denied.length, 0);
});

test('one in-flight request is deduplicated and unchanged requires the exact previous authorized revision', async () => {
  const f = fixture(); const first = f.ui.refresh(), duplicate = f.ui.refresh();
  assert.strictEqual(duplicate, first); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(changed()); assert.equal(await first, true);
  const second = f.ui.refresh();
  assert.ok(f.calls[1].path.endsWith('&since=' + revisionA));
  f.calls[1].resolve({ revision: revisionA, unchanged: true });
  assert.equal(await second, true); assert.equal(f.accepted.length, 1);
});

test('force replaces and aborts pending work, and obsolete finally cannot release the new pending slot', async () => {
  const f = fixture(), first = f.ui.refresh(), second = f.ui.refresh({ force: true });
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.signal.aborted, true);
  f.calls[0].resolve(changed([contact('stale')])); assert.equal(await first, false);
  assert.strictEqual(f.ui.refresh(), second); assert.equal(f.calls.length, 2);
  f.calls[1].resolve(changed([contact('fresh')], revisionB)); assert.equal(await second, true);
  assert.equal(f.records[0].id, 'fresh'); assert.equal(f.accepted.length, 1);
});

for (const [field, value] of Object.entries({ userId: 'user-b', workspaceId: 'workspace-b', tenantId: 'tenant-b',
  supportGrantId: 'grant-b', authorityKey: 'authority-b', refreshSequence: 2, view: 'inbox' })) {
  test('late response is discarded after changing ' + field, async () => {
    const f = fixture(), before = f.records, promise = f.ui.refresh();
    f.context[field] = value; f.calls[0].resolve(changed([contact('stale')]));
    assert.equal(await promise, false); assert.strictEqual(f.records, before); assert.equal(f.accepted.length, 0);
  });
}

for (const [field, value] of Object.entries({ userId: 'user-b', workspaceId: 'workspace-b', tenantId: 'tenant-b',
  supportGrantId: 'grant-b', authorityKey: 'authority-b', refreshSequence: 2 })) {
  test('cached since never crosses ' + field, async () => {
    const f = fixture(); await f.accept(); f.context[field] = value;
    const promise = f.ui.refresh(); assert.ok(!f.calls[1].path.includes('&since='));
    f.calls[1].resolve(changed([contact('new-authorized')], revisionB)); assert.equal(await promise, true);
    const next = f.ui.refresh(); assert.ok(f.calls[2].path.endsWith('&since=' + revisionB));
    f.calls[2].resolve({ revision: revisionB, unchanged: true }); assert.equal(await next, true);
  });
}

test('contacts to inbox shares the cached authorized agenda but invalidates the outstanding view response', async () => {
  const f = fixture(); await f.accept(); const stale = f.ui.refresh();
  f.context.view = 'inbox'; const current = f.ui.refresh();
  assert.equal(f.calls[1].options.signal.aborted, true); assert.ok(f.calls[2].path.endsWith('&since=' + revisionA));
  f.calls[2].resolve(changed([contact('inbox-fresh')], revisionB)); assert.equal(await current, true);
  f.calls[1].resolve(changed([contact('contacts-stale')])); assert.equal(await stale, false);
  assert.equal(f.records[0].id, 'inbox-fresh');
});

test('observed ABA scope switch never admits the first A response or B revision into restored A', async () => {
  const f = fixture(); const oldA = f.ui.refresh();
  f.context.tenantId = 'tenant-b'; const b = f.ui.refresh();
  f.context.tenantId = 'tenant-a'; const newA = f.ui.refresh();
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.calls[1].options.signal.aborted, true);
  assert.ok(f.calls.every(c => !c.path.includes('&since=')));
  f.calls[2].resolve(changed([contact('new-a')], revisionB)); assert.equal(await newA, true);
  f.calls[1].resolve(changed([contact('stale-b')])); f.calls[0].resolve(changed([contact('stale-a')]));
  assert.equal(await b, false); assert.equal(await oldA, false); assert.equal(f.records[0].id, 'new-a');
});

test('ABA view reset and refresh sequence invalidation discard a transport response that ignored abort', async () => {
  const f = fixture(), old = f.ui.refresh(); f.context.view = 'overview'; f.ui.reset();
  f.context.view = 'contacts'; f.context.refreshSequence++; const next = f.ui.refresh();
  assert.equal(f.calls[0].options.signal.aborted, true);
  f.calls[0].resolve(changed([contact('old-view')])); assert.equal(await old, false);
  f.calls[1].resolve(changed([contact('current-view')])); assert.equal(await next, true);
  assert.equal(f.records[0].id, 'current-view');
});

for (const [label, extra] of [
  ['no user', { userId: '' }], ['no workspace', { workspaceId: '' }], ['no tenant', { tenantId: '' }],
  ['unrelated view', { view: 'channels' }], ['modal paused', { paused: true }], ['read permission denied', { canRead: false }]
]) {
  test(label + ' prevents even a forced refresh request', async () => {
    const f = fixture(extra); assert.equal(await f.ui.refresh(), false); assert.equal(await f.ui.refresh({ force: true }), false);
    assert.equal(f.calls.length, 0); assert.equal(f.accepted.length, 0); assert.equal(f.denied.length, 0);
  });
}

for (const [label, extra] of [['modal opened', { paused: true }], ['permission revoked', { canRead: false }],
  ['logout', { userId: '' }], ['unrelated view', { view: 'channels' }]]) {
  test(label + ' while awaiting prevents applying the response', async () => {
    const f = fixture(), previous = f.records, promise = f.ui.refresh(); Object.assign(f.context, extra);
    f.calls[0].resolve(changed([contact('must-not-apply')]));
    assert.equal(await promise, false); assert.strictEqual(f.records, previous); assert.equal(f.accepted.length, 0);
  });
}

test('reset/logout aborts pending work, clears since and denial, and ignores late success', async () => {
  const f = fixture(); await f.accept(); const pending = f.ui.refresh();
  f.ui.reset(); assert.equal(f.calls[1].options.signal.aborted, true); f.context.userId = '';
  f.calls[1].resolve(changed([contact('logout-stale')], revisionB)); assert.equal(await pending, false);
  assert.equal(await f.ui.refresh(), false); f.context.userId = 'user-a';
  const after = f.ui.refresh(); assert.ok(!f.calls[2].path.includes('&since='));
  f.calls[2].resolve(changed([contact('new-session')])); assert.equal(await after, true);
});

for (const status of [403, 404]) {
  test('current HTTP ' + status + ' clears authorized records and suppresses repeated polling until explicit review/reset', async () => {
    const f = fixture(); await f.accept(); const denied = f.ui.refresh();
    f.calls[1].reject(Object.assign(new Error('Negado em RAM'), { status })); assert.equal(await denied, false);
    assert.deepEqual(f.records, []); assert.equal(f.denied.length, 1);
    for (let i = 0; i < 3; i++) assert.equal(await f.ui.refresh(), false);
    assert.equal(f.calls.length, 2);
    const review = f.ui.refresh({ force: true }); assert.ok(!f.calls[2].path.includes('&since='));
    f.calls[2].resolve(changed([contact('review-authorized')], revisionB)); assert.equal(await review, true);
    const again = f.ui.refresh(); f.calls[3].resolve({ revision: revisionB, unchanged: true }); assert.equal(await again, true);
  });
  test('obsolete HTTP ' + status + ' does not clear records from a newer authority', async () => {
    const f = fixture(), old = f.ui.refresh(); f.context.authorityKey = 'authority-b'; const next = f.ui.refresh();
    f.calls[1].resolve(changed([contact('current-authorized')], revisionB)); assert.equal(await next, true);
    f.calls[0].reject(Object.assign(new Error('Negação antiga'), { status })); assert.equal(await old, false);
    assert.equal(f.records[0].id, 'current-authorized'); assert.equal(f.denied.length, 0);
  });
}

test('reset clears the denied scope and a changed grant also allows fresh authorization without old since', async () => {
  const f = fixture(), pending = f.ui.refresh(); f.calls[0].reject(Object.assign(new Error('Negado'), { status: 403 }));
  assert.equal(await pending, false); f.ui.reset(); const fresh = f.ui.refresh();
  assert.ok(!f.calls[1].path.includes('&since=')); f.calls[1].reject(Object.assign(new Error('Ainda negado'), { status: 403 }));
  assert.equal(await fresh, false); f.context.supportGrantId = 'new-grant'; const changedScope = f.ui.refresh();
  f.calls[2].resolve(changed()); assert.equal(await changedScope, true);
});

for (const error of [new TypeError('Resposta perdida'), Object.assign(new Error('Temporário'), { status: 500 }),
  Object.assign(new Error('Limitado'), { status: 429 }), Object.assign(new Error('Cancelado'), { name: 'AbortError' })]) {
  test(error.name + '/' + (error.status || 'network') + ' preserves records and the last revision for a later poll', async () => {
    const f = fixture(); await f.accept(); const previous = f.records, pending = f.ui.refresh(); f.calls[1].reject(error);
    assert.equal(await pending, false); assert.strictEqual(f.records, previous); assert.equal(f.denied.length, 0);
    const retry = f.ui.refresh(); assert.ok(f.calls[2].path.endsWith('&since=' + revisionA));
    f.calls[2].resolve({ revision: revisionA, unchanged: true }); assert.equal(await retry, true);
  });
}

for (const [label, response] of [
  ['missing DTO', null], ['short revision', { revision: 'abc', unchanged: false, contacts: [] }],
  ['uppercase revision', { revision: 'A'.repeat(64), unchanged: false, contacts: [] }],
  ['missing unchanged', { revision: revisionB, contacts: [] }],
  ['string unchanged', { revision: revisionB, unchanged: 'false', contacts: [] }],
  ['non-array contacts', { revision: revisionB, unchanged: false, contacts: {} }],
  ['null contact row', { revision: revisionB, unchanged: false, contacts: [null] }],
  ['primitive contact row', { revision: revisionB, unchanged: false, contacts: ['invalid'] }]
]) {
  test(label + ' cannot replace records or poison the previously authorized revision', async () => {
    const f = fixture(); await f.accept(); const previous = f.records, pending = f.ui.refresh(); f.calls[1].resolve(response);
    assert.equal(await pending, false); assert.strictEqual(f.records, previous); assert.equal(f.accepted.length, 1);
    const retry = f.ui.refresh(); assert.ok(f.calls[2].path.endsWith('&since=' + revisionA));
    f.calls[2].resolve({ revision: revisionA, unchanged: true }); assert.equal(await retry, true);
  });
}

test('unchanged cannot establish a revision when no prior snapshot exists', async () => {
  const f = fixture(), first = f.ui.refresh(); f.calls[0].resolve({ revision: revisionA, unchanged: true });
  assert.equal(await first, false); assert.equal(f.accepted.length, 0);
  const retry = f.ui.refresh(); assert.ok(!f.calls[1].path.includes('&since='));
  f.calls[1].resolve(changed([], revisionB)); assert.equal(await retry, true); assert.deepEqual(f.records, []);
});

test('unchanged with a different revision is rejected while preserving the prior snapshot', async () => {
  const f = fixture(); await f.accept(); const previous = f.records, pending = f.ui.refresh();
  f.calls[1].resolve({ revision: revisionB, unchanged: true }); assert.equal(await pending, false); assert.strictEqual(f.records, previous);
  const retry = f.ui.refresh(); assert.ok(f.calls[2].path.endsWith('&since=' + revisionA));
  f.calls[2].resolve({ revision: revisionA, unchanged: true }); assert.equal(await retry, true);
});

// The served handlers and DOM patches execute unchanged; only the RAM transport
// and the small DOM surface they use are adapted below.
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const authoritySource = appSource.split('\n').find(line => line.startsWith('const inboxContactAuthority='));
// The three 5 s timers of app.js are tasks of live.js since P1 commit 1f (anchor live-tasks); the fixture records them.
const intervalSource = excerpt('live-tasks');
assert.ok(authoritySource && intervalSource);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decode = value => value.replace(/&(quot|amp|lt|gt|#39);/g, (_, key) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" }[key]));
const settle = () => new Promise(resolve => setImmediate(resolve));
function appFixture(t, { view = 'contacts' } = {}) {
  const previousDocument = globalThis.document;
  const state = { view, workspaceId: 'workspace-a', tenant: { id: 'tenant-a', channels: [], departments: [], agents: [],
    conversations: [{ id: 'conversation-a', contactId: 'row-0', version: 2, messages: [], owner: 'human', status: 'open' }] },
    conversation: 'conversation-a', refreshSequence: 1, supportGrantId: null, busy: false, inboxSelecting: false,
    contacts: Array.from({ length: 105 }, (_, i) => contact('row-' + i, { notes: 'Notas originais' })), contactSearch: 'Contato', contactPage: 1, showArchived: true,
    boot: { csrfToken: 'synthetic-authority', session: { userId: 'user-a', role: 'operator', permissions: ['contacts.read', 'contacts.write', 'inbox.read'], scopeRules: {} }, tenants: [{ id: 'tenant-a' }] },
    renderedInboxRef: { workspaceId: 'workspace-a', tenantId: 'tenant-a', conversationId: 'conversation-a' }, noteIntent: { id: 'private-note-intent' }, sendIntent: null };
  const calls = [], effects = [], intervals = [], handlers = new Map();
  const document = { activeElement: null, addEventListener() {}, querySelector: selector => elements.get(selector) || null,
    createElement: type => { assert.equal(type, 'template'); return template(); } };
  let client = null;
  function element(html = '') {
    const node = { isConnected: true, buttons: [], notes: null, replacements: 0, removed: false,
      get innerHTML() { return this.html; }, set innerHTML(value) {
        this.html = value;
        this.buttons = [...value.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/g)].map(([, attributes]) => {
          const dataset = Object.fromEntries([...attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(([, name, val]) => [name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), decode(val)]));
          return { dataset, disabled: /\sdisabled(?:\s|$)/.test(attributes), focus(options) { document.activeElement = this; this.focusOptions = options; } };
        });
        this.notes = value.includes('class="client-notes"') ? { open: false } : null;
      },
      get outerHTML() { return this.html; },
      querySelector: function(selector) { return selector === '.client-notes' ? this.notes : null; },
      querySelectorAll: function() { return this.buttons; }, contains: function(target) { return this.buttons.includes(target); },
      replaceWith(fresh) { this.isConnected = false; this.replacements++; client = fresh; elements.set('.context-client-record', fresh); },
      remove() { this.isConnected = false; this.removed = true; client = null; elements.delete('.context-client-record'); }
    }; node.innerHTML = html; return node;
  }
  function template() {
    let html = '';
    return { get innerHTML() { return html; }, set innerHTML(value) { html = value; }, content: {
      querySelector(selector) {
        const match = selector === 'tbody' ? html.match(/<tbody>([\s\S]*?)<\/tbody>/)
          : selector === '[data-contact-pagination]' ? html.match(/<nav\b[^>]*data-contact-pagination[^>]*>([\s\S]*?)<\/nav>/) : null;
        return match ? element(match[1]) : null;
      }, get firstElementChild() { return element(html); }
    } };
  }
  const tbody = element(), pagination = element(), search = { dataset: {}, value: 'Contato', selectionStart: 2, selectionEnd: 5 },
    archived = { dataset: {}, checked: true }, message = { dataset: {}, value: 'Rascunho próprio de mensagem' }, note = { dataset: {}, value: 'Rascunho privado de nota' }, player = { currentTime: 17, paused: false };
  const panel = { querySelector(selector) { return selector === 'tbody' ? tbody : selector === '[data-contact-pagination]' ? pagination
    : pagination.buttons.find(button => selector === '[data-contact-direction="' + button.dataset.contactDirection + '"]') || null; },
    querySelectorAll() { return tbody.buttons; } };
  const modal = { open: false, kind: 'other', closeCount: 0, draft: { name: 'Nome não salvo', notes: 'Notas não salvas' },
    close() { this.open = false; this.closeCount++; }, addEventListener() {},
    querySelector(selector) { return (this.kind === 'contact' && selector.includes('[data-dialog-form="contact"]') ||
      this.kind === 'contact-open' && selector.includes('[data-dialog-form="contact-open"]') || this.kind === 'history' && selector.includes('.contact-history')) ? this.draft : null; } };
  const elements = new Map([['.crm-panel', panel], ['#contact-search', search], ['#contacts-archived', archived], ['#modal', modal],
    ['#message-text', message], ['#internal-note-text', note], ['#messages', { player }], ['#main-content', { scrollTo() {} }]]);
  globalThis.document = document; t.after(() => { globalThis.document = previousDocument; });
  const permission = name => state.boot.session.permissions.includes(name);
  const workspaceUI = createWorkspaceUI({ state, escape, icon: () => '', badge: text => escape(text), button: () => '', avatarMarkup: () => '',
    contactAvatar: () => '', pageHeading: () => '', hasPermission: permission, api: () => assert.fail('No workspace mutation'),
    tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail, render: () => assert.fail('No full CRM render'), toast() {}, navigate() {} });
  const currentConversation = () => state.tenant?.conversations.find(c => c.id === state.conversation);
  const mountContacts = () => { const fresh = template(); fresh.innerHTML = workspaceUI.views.contacts(); tbody.innerHTML = fresh.content.querySelector('tbody').innerHTML; pagination.innerHTML = fresh.content.querySelector('[data-contact-pagination]').innerHTML; };
  const mountClient = () => { client = element(clientRecordMarkup(currentConversation(), { contacts: state.contacts, canRead: permission('contacts.read'), canWrite: permission('contacts.write'), escape, icon: () => '' })); elements.set('.context-client-record', client); };
  // The real directory establishes its scope before a person navigates to page2.
  mountContacts(); state.contactPage = 1; mountContacts(); mountClient(); document.activeElement = search;
  const resetTool = name => ({ reset() { effects.push(name + '-reset'); } });
  const globals = { ...i18n, state, document, createContactRefresh, workspaceUI, clientRecordMarkup, currentConversation, escape, icon: () => '', hasPermission: permission,
    inboxRouteFilters, defaultLens, INBOX_PAGE, URLSearchParams, clearTimeout,
    channelVisitorTestUI: { ...resetTool('visitor'), syncContext() {} },
    $: selector => elements.get(selector) || null, AbortController, contactLinksUI: resetTool('contact-links'), platformUsersUI: resetTool('platform-users'), commercialUsageUI: { reset() {} }, groupsWorkspaceUI: resetTool('groups-workspace'), memoryUI: { ...resetTool('memory'), syncContext() {} },
    api: (path, options) => { const waiting = deferred(); calls.push({ path, options, ...waiting }); return waiting.promise; },
    avatarUI: { bind() { effects.push('avatars-bind'); } },
    mediaUI: { sending: false, forgetTenant(id) { effects.push(['media-forget', id]); }, retainConversations() {}, bindPlayers() { effects.push('players-bind'); }, hydrate() {} },
    voiceRecorder: { busy: false, ...resetTool('voice') }, participantsUI: { busy: false, opened: false, ...resetTool('participants') },
    repliesUI: { ...resetTool('replies'), retainConversations() {}, syncContext() {}, updateQuoteComposer() {} },
    consolidatedInbox: { data: { counts: { active: 0 } }, cancelLoad() {}, setLimit() {}, forgetTenant(id) { effects.push(['inbox-forget', id]); }, retainConversations() {} },
    noteDrafts: resetTool('notes'), conversationTools: { opened: false, ...resetTool('tools') }, forwarding: resetTool('forwarding'),
    inboxTimeline: { ...resetTool('timeline'), update() { return { added: false, nearBottom: true }; } }, contactImportUI: resetTool('imports'),
    syncAttendanceTools() {}, canReplyTo: () => true, updateAttendanceAccess() {}, updateAttendanceSummary() {}, updateConversationTools() {},
    updateInboxList() {}, renderConversationRuns() {}, refreshMessageAttachments() {}, activeRunStates: new Set(),markConversationRead:async()=>false,
    // Scoped run loading is exercised independently in scoped-runs-ui.test; this fixture owns only agenda/detail lifecycle.
    captureScopedRuns:()=>({}),currentScopedRuns:()=>true,readScopedRuns:async()=>[],scopedRunsAligned:()=>true,refreshScopedConversationRuns:async()=>false,
    tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail,
    toast(message, failure) { effects.push(['toast', message, failure]); }, render() { effects.push('full-render'); },
    blockPendingSend: () => Boolean(state.sendIntent), teamChatUI: resetTool('team-chat'), refreshInboxList: async () => effects.push('inbox-list'), loadViewPanels() {}, loadNavigatedPanels() {},
    // Focus and platform directory ownership have separate tests; retain their navigation side effects without altering CRM drafts.
    focusViewContent() { effects.push('view-focus'); },
    location: { hash: '#' + view }, window: { scrollTo() {}, addEventListener(name, callback) { handlers.set(name, callback); } },
    // Route grammar and canonical hashes are the real modules (router.js/nav-config.js).
    parseHash, viewForRoute, hashForView, conversationHash, history: { state: null, replaceState() { effects.push('history-replace'); } },
    views: { contacts: true, inbox: true, channels: true, overview: true }, attention: { refresh: async () => {} }, live: null,
    createLive({ tasks }) {
      assert.deepEqual(Array.from(tasks, task => [task.name, task.every]), [['inbox', 5000], ['contacts', 5000], ['team-chat', 5000]], 'os três timers de 5 s viram tarefas');
      return { start() { for (const task of tasks) if (task.name === 'contacts') intervals.push({ callback: task.run, delay: task.every }); } };
    }
  };
  const executable = [authoritySource,
    excerpt('contact-refresh'),
    excerpt('contacts-page'),
    excerpt('navigate'),
    excerpt('drop-inbox-detail'),
    excerpt('inbox-polling'), excerpt('route-sync'), intervalSource,
    '({contactRefresh,updateContactsPage,updateClientRecord,navigate,pollInbox})'].join('\n');
  globals.dataSource = createDataSource({ request: (path, options) => globals.api(path, options) });
  const real = runInNewContext(executable, globals);
  return { ...real, state, calls, effects, intervals, modal, panel, tbody, pagination, search, archived, message, note, player, document, globals, mountContacts, mountClient,
    get client() { return client; }, hash(view) { globals.location.hash = '#' + view; handlers.get('hashchange')(); } };
}

test('real refresh patches only agenda rows/pagination and preserves search/page/filter/drafts and focus', async t => {
  const f = appFixture(t), oldClient = f.client, noteIntent = f.state.noteIntent, pending = { id: 'pending-own' }; f.state.sendIntent = pending;
  const request = f.contactRefresh.refresh(); f.calls[0].resolve(changed([...f.state.contacts, contact('incoming')]));
  assert.equal(await request, true); assert.equal(f.state.contacts.length, 106); assert.match(f.pagination.innerHTML, /106 contatos/);
  assert.equal(f.state.contactSearch, 'Contato'); assert.equal(f.state.contactPage, 1); assert.equal(f.state.showArchived, true);
  assert.equal(f.search.value, 'Contato'); assert.equal(f.search.selectionStart, 2); assert.equal(f.search.selectionEnd, 5); assert.strictEqual(f.document.activeElement, f.search);
  assert.equal(f.archived.checked, true); assert.equal(f.message.value, 'Rascunho próprio de mensagem'); assert.equal(f.note.value, 'Rascunho privado de nota');
  assert.strictEqual(f.state.noteIntent, noteIntent); assert.strictEqual(f.state.sendIntent, pending); assert.strictEqual(f.client, oldClient);
  assert.equal(f.effects.includes('full-render'), false); assert.equal(f.player.currentTime, 17);
});

test('real partial agenda patch restores surviving row action and pagination focus; disappearing pages clamp safely', t => {
  const f = appFixture(t), rowButton = f.tbody.buttons.find(button => button.dataset.action === 'contact-history');
  f.document.activeElement = rowButton; f.state.contacts.push(contact('new-row')); f.updateContactsPage();
  assert.notStrictEqual(f.document.activeElement, rowButton); assert.deepEqual(f.document.activeElement.dataset, rowButton.dataset);
  assert.equal(f.document.activeElement.focusOptions.preventScroll, true);
  f.document.activeElement = f.pagination.buttons.find(button => button.dataset.contactDirection === 'previous');
  f.updateContactsPage(); assert.equal(f.document.activeElement.dataset.contactDirection, 'previous');
  f.state.contactPage = 2; f.state.contacts = f.state.contacts.slice(0, 51); f.updateContactsPage(); assert.equal(f.state.contactPage, 1);
  assert.match(f.pagination.innerHTML, /51–51 de 51 contatos/); assert.equal(f.effects.includes('full-render'), false);
});

test('real inbox client patch preserves expanded notes/action focus and never recreates composer/player/modal', async t => {
  const f = appFixture(t, { view: 'inbox' }), old = f.client; old.notes.open = true;
  const action = old.buttons.find(button => button.dataset.action === 'edit-contact'); f.document.activeElement = action;
  const draft = f.modal.draft, request = f.contactRefresh.refresh();
  f.calls[0].resolve(changed([contact('row-0', { name: 'Cadastro atualizado', notes: 'Novas notas', tags: ['Novo'] })]));
  assert.equal(await request, true); assert.notStrictEqual(f.client, old); assert.match(f.client.outerHTML, /Cadastro atualizado|Novas notas|Novo/);
  assert.equal(f.client.notes.open, true); assert.notStrictEqual(f.document.activeElement, action); assert.deepEqual(f.document.activeElement.dataset, action.dataset);
  assert.strictEqual(f.modal.draft, draft); assert.equal(f.message.value, 'Rascunho próprio de mensagem'); assert.equal(f.note.value, 'Rascunho privado de nota');
  assert.equal(f.player.currentTime, 17); assert.equal(f.effects.includes('full-render'), false);
});

for (const [label, pause] of [['busy', f => { f.state.busy = true; }], ['selecting', f => { f.state.inboxSelecting = true; }],
  ['sending', f => { f.globals.mediaUI.sending = true; }], ['voice', f => { f.globals.voiceRecorder.busy = true; }], ['modal', f => { f.modal.open = true; }]]) {
  test('real context pauses periodic and forced refresh while ' + label, async t => {
    const f = appFixture(t); pause(f); assert.equal(await f.intervals[0].callback(), false); assert.equal(await f.contactRefresh.refresh({ force: true }), false);
    assert.equal(f.calls.length, 0); assert.equal(f.state.contacts.length, 105);
  });
}

test('real independent5s contact poll runs in Inbox without a selected conversation', async t => {
  const f = appFixture(t, { view: 'inbox' }); f.state.conversation = null; assert.equal(f.intervals[0].delay, 5000);
  const request = f.intervals[0].callback(); assert.match(f.calls[0].path, /\/contacts\?archived=true&snapshot=true$/);
  f.calls[0].resolve(changed([contact('new-without-selection')])); assert.equal(await request, true);
  assert.equal(f.state.contacts[0].id, 'new-without-selection'); assert.equal(f.effects.includes('full-render'), false);
});

for (const entry of ['navigate', 'hash']) {
  test('real ' + entry + ' opens Contacts with a fresh forced snapshot and aborts an earlier view request', async t => {
    const f = appFixture(t, { view: 'inbox' }), prior = f.contactRefresh.refresh();
    if (entry === 'navigate') f.navigate('contacts'); else f.hash('contacts');
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state.view, 'contacts');
    assert.equal(f.effects.filter(effect=>effect==='groups-workspace-reset').length,1);
    f.calls[0].resolve(changed([contact('old')])); assert.equal(await prior, false);
    f.calls[1].resolve(changed([contact('new')])); await settle(); assert.equal(f.state.contacts[0].id, 'new');
  });
  test('real ' + entry + ' cancels Inbox→Channels→Inbox ABA before any tick/response, even when paused', async t => {
    const f = appFixture(t, { view: 'inbox' }), prior = f.contactRefresh.refresh(), contacts = f.state.contacts;
    f.state.busy = true; if (entry === 'navigate') { f.navigate('channels'); f.navigate('inbox'); } else { f.hash('channels'); f.hash('inbox'); }
    assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state.view, 'inbox');
    assert.equal(f.effects.filter(effect=>effect==='groups-workspace-reset').length,2);
    f.calls[0].resolve(changed([contact('aba-stale')])); assert.equal(await prior, false); assert.strictEqual(f.state.contacts, contacts);
  });
}

for (const kind of ['contact', 'contact-open', 'history', 'other']) {
  test('real denial clears agenda and closes only authorized contact modal: ' + kind, async t => {
    const f = appFixture(t), pending = f.contactRefresh.refresh(), draft = f.modal.draft;
    f.modal.kind = kind; f.modal.open = true; f.calls[0].reject(Object.assign(new Error('Access changed'), { status: 403 }));
    assert.equal(await pending, false); assert.equal(f.state.contacts.length, 0); assert.equal(f.state.contactPage, 0);
    assert.equal(f.modal.closeCount, kind === 'other' ? 0 : 1); assert.strictEqual(f.modal.draft, draft);
    f.modal.open = false; assert.equal(await f.intervals[0].callback(), false); assert.equal(f.calls.length, 1);
  });
}

for (const change of ['workspace', 'tenant', 'authority', 'sequence', 'view']) {
  test('real pollInbox late403 after ' + change + ' cannot discard the newer draft or authorized records', async t => {
    const f = appFixture(t, { view: 'inbox' }), polling = f.pollInbox(); await settle();
    assert.equal(f.calls[0].path, '/api/tenants/tenant-a'); const contacts = f.state.contacts, oldIntent = f.state.noteIntent;
    if (change === 'workspace') f.state.workspaceId = 'workspace-b'; if (change === 'tenant') f.state.tenant = { ...f.state.tenant, id: 'tenant-b' };
    if (change === 'authority') f.state.boot.csrfToken = 'new-authority'; if (change === 'sequence') f.state.refreshSequence++; if (change === 'view') f.state.view = 'contacts';
    f.message.value = 'Rascunho da seleção nova'; f.calls[0].reject(Object.assign(new Error('Obsolete denial'), { status: 403 })); await polling;
    assert.strictEqual(f.state.contacts, contacts); assert.strictEqual(f.state.noteIntent, oldIntent); assert.equal(f.state.conversation, 'conversation-a');
    assert.equal(f.message.value, 'Rascunho da seleção nova'); assert.equal(f.effects.some(effect => Array.isArray(effect) && effect[0] === 'inbox-forget'), false);
    assert.equal(f.effects.includes('full-render'), false);
  });
}

test('real current pollInbox404 discards only its own revoked context and invalidates the pending contact request', async t => {
  const f = appFixture(t, { view: 'inbox' }), contacts = f.contactRefresh.refresh(), polling = f.pollInbox(); await settle();
  f.calls[1].reject(Object.assign(new Error('Current denial'), { status: 404 })); await polling;
  assert.equal(f.state.conversation, null); assert.equal(f.state.contacts.length, 0); assert.equal(f.calls[0].options.signal.aborted, true);
  f.calls[0].resolve(changed([contact('revoked')])); assert.equal(await contacts, false); assert.equal(f.state.contacts.length, 0);
  assert.ok(f.effects.some(effect => Array.isArray(effect) && effect[0] === 'inbox-forget' && effect[1] === 'tenant-a'));
});

test('agenda arriving before fresh conversation linkage still updates the client record on detail poll and unchanged snapshot', async t => {
  const f = appFixture(t, { view: 'inbox' }); delete f.state.tenant.conversations[0].contactId; f.mountClient();
  assert.match(f.client.outerHTML, /ainda não tem um cadastro/);
  const detail = f.pollInbox(); await settle(); const agenda = f.contactRefresh.refresh();
  f.calls[1].resolve(changed([contact('linked-after-detail', { name: 'Vínculo recebido antes do detalhe', notes: 'Nota CRM' })]));
  assert.equal(await agenda, true); assert.match(f.client.outerHTML, /ainda não tem um cadastro/);
  f.calls[0].resolve({ ...f.state.tenant, conversations: [{ ...f.state.tenant.conversations[0], contactId: 'linked-after-detail', version: 3 }] }); await detail;
  assert.match(f.client.outerHTML, /Vínculo recebido antes do detalhe/); const record = f.client;
  const unchanged = f.contactRefresh.refresh(); f.calls[2].resolve({ revision: revisionA, unchanged: true }); assert.equal(await unchanged, true);
  assert.strictEqual(f.client, record); assert.equal(f.message.value, 'Rascunho próprio de mensagem'); assert.equal(f.note.value, 'Rascunho privado de nota');
  assert.equal(f.player.currentTime, 17); assert.equal(f.effects.includes('full-render'), false);
});

for (const transport of ['api', 'media-download']) {
  test('real ' + transport + '401 aborts agenda before redirect and cannot apply a late contact result', async t => {
    const f = appFixture(t), pending = f.contactRefresh.refresh(), before = f.state.contacts, redirects = [];
    f.state.sendIntent = { id: 'pending-own' }; f.modal.open = true;
    const globals = { ...i18n, state: f.state, contactLinksUI: { reset() {} }, contactRefresh: f.contactRefresh, memoryUI: { reset() {} }, escape, icon: () => '',
      channelVisitorTestUI: { reset() { f.effects.push('expiry-visitor-reset'); }, syncContext() {} },
      mediaUI: { reset() { f.effects.push('expiry-media-reset'); } },
      createMediaUI: options => ({ download: options.download, reset() { f.effects.push('expiry-media-reset'); } }),
      fetch: async () => new Response(JSON.stringify({ error: 'Sessão inválida ou expirada. Entre novamente.' }), { status: 401 }),
      location: { assign(path) { assert.ok(f.effects.includes('expiry-visitor-reset'), 'API e mídia invalidam o visitante antes de redirecionar'); assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state.sendIntent, null); redirects.push(path); } } };
    globals.readJsonResponse = createJsonRead({ fetch: (...args) => globals.fetch(...args) });
    const request = transport === 'api'
      ? runInNewContext(excerpt('api') + '\napi', withSessionGuard(globals))
      : runInNewContext(excerpt('media-ui') + '\nmediaUI.download', withSessionGuard(globals));
    await assert.rejects(request(transport === 'api' ? '/api/auth/me' : '/own-private-attachment'), /Entre/);
    assert.deepEqual(redirects, ['/login?reason=session-expired']); assert.ok(f.effects.includes('expiry-media-reset'));
    assert.equal(f.effects.filter(effect => effect === 'expiry-visitor-reset').length, 1);
    f.calls[0].resolve(changed([contact('expired-response')])); assert.equal(await pending, false); assert.strictEqual(f.state.contacts, before);
  });
}
