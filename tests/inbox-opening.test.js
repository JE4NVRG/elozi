import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import { createDataSource } from '../public/data-source.js';
import { createLiveRegistry } from '../public/live.js';
import { createConsolidatedInboxUI, inboxIdentity } from '../public/consolidated-inbox-ui.js';
import { createDraftsStore } from '../public/drafts-store.js';
import { createInboxTimeline, earlierMarkup } from '../public/inbox-live.js';
import { createDocument, FakeEvent } from './helpers/inbox-dom.js';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import { excerpt } from './helpers/app-source.js';

const savedDocument = globalThis.document;
test.afterEach(() => { globalThis.document = savedDocument; });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const message = (company, index) => ({ id: `${company}-message-${index}`, kind: 'customer', text: 'Own synthetic history', createdAt: new Date(Date.parse('2026-10-08T10:00:00Z') + index * 1000).toISOString(), attachments: [] });
const conversation = (company, id, count = 80) => ({ id, contact: `${company} ${id}`, version: 7, status: 'open', owner: 'human', assignedUserId: 'human-a', channelId: `${company}-channel`, unread: 0, messages: Array.from({ length: count }, (_, index) => message(`${company}-${id}`, index)) });

function fixture(t, { intercept, holdAux = true, readReceipt = async () => true } = {}) {
  const tenants = Object.fromEntries(['company-a', 'company-b'].map(id => [id, { id, name: id, channels: [{ id: `${id}-channel`, transport: 'telegram-user', kind: 'telegram_user', capabilities: { aiAllowed: false } }], agents: [], runs: [], conversations: ['case-a', 'case-b', 'case-c'].map(cid => conversation(id, cid)) }]));
  const state = { workspaceId: 'workspace-a', tenant: structuredClone(tenants['company-a']), conversation: 'case-a', view: 'inbox', inboxSelectionSequence: 0, busy: false, boot: { csrfToken: 'synthetic-csrf', session: { userId: 'human-a', role: 'reseller', permissions: null }, tenants: [{ id: 'company-a' }, { id: 'company-b' }] }, contacts: [{ id: 'prior-company-a-contact' }], flows: [{ id: 'prior-company-a-flow' }], assignees: [{ id: 'prior-company-a-assignee' }], metrics: { company: 'company-a' }, mcpServers: [{ id: 'prior-company-a-mcp' }], mcpLoaded: true, overviewLoaded: { contacts: true, assignees: true } };
  const document = createDocument('<textarea id="message-text"></textarea><textarea id="internal-note-text"></textarea><main id="chat-content"></main>'); globalThis.document = document;
  const field = document.querySelector('#message-text'); field.value = 'Original own draft A'; document.querySelector('#internal-note-text').value = 'Original own note A';
  const calls = [], aux = [], renders = [], notices = [], notes = [], clientPatches = [],readCalls=[],coverageUpdates=[];
  const authority = () => JSON.stringify([state.workspaceId, state.supportGrantId || null, state.boot.session.userId, state.boot.csrfToken, state.boot.session.role, state.boot.session.permissions, state.boot.session.scopeRules, state.boot.tenants.map(item => item.id)]);
  const ref = () => state.tenant && state.conversation ? { workspaceId: state.workspaceId, tenantId: state.tenant.id, conversationId: state.conversation } : null;
  const active = () => state.tenant?.conversations.find(item => item.id === state.conversation);
  function response(path) {
    const url = new URL(path, 'https://synthetic.invalid'), [, company, cid] = /\/api\/tenants\/([^/]+)(?:\/conversations\/([^/]+))?/.exec(url.pathname) || [];
    const tenant = tenants[company];
    if (cid) {
      const c = tenant.conversations.find(item => item.id === cid), before = url.searchParams.get('before'), end = before ? c.messages.findIndex(item => item.id === before) : c.messages.length, start = Math.max(0, end - 60), messages = c.messages.slice(start, end);
      const page = { version: c.version, messages, hasMore: start > 0, cursor: { before: messages[0]?.id || null, after: c.messages.at(-1)?.id || null } };
      return before ? page : { ...page, conversation: { ...c, messages: undefined }, messageCount: c.messages.length, runs: [] };
    }
    if (url.searchParams.get('summary') === '1') return { ...tenant, conversations: tenant.conversations.map(({ messages, ...c }) => ({ ...c, messageCount: messages.length })) };
    if (url.pathname === `/api/tenants/${company}`) assert.fail('opening must not request a full tenant');
    if (url.pathname.endsWith('/contacts')) return { contacts: [{ id: `${company}-fresh-contact` }] };
    if (url.pathname.endsWith('/flows')) return { flows: [{ id: `${company}-fresh-flow` }] };
    if (url.pathname.endsWith('/assignees')) return { assignees: [{ id: `${company}-fresh-assignee` }] };
    if (url.pathname.endsWith('/metrics')) return { company };
    if (url.pathname.endsWith('/mcp/servers')) return { servers: [{ id: `${company}-fresh-mcp` }] };
    assert.fail(`unexpected synthetic request ${path}`);
  }
  const request = async (path, options = {}) => {
    const call = { path, options, afterRender: renders.length > 0 }; calls.push(call);
    const fallback = () => structuredClone(response(path));
    if (intercept) { const override = intercept(path, options, fallback); if (override !== undefined) return override; }
    if (holdAux && /\/(?:contacts(?:\?|$)|flows$|assignees$|metrics$|mcp\/servers$)/.test(path)) { const wait = deferred(); aux.push({ ...wait, path, fallback }); return wait.promise; }
    return fallback();
  };
  const registry = createLiveRegistry(); registry.context = () => ({ workspaceId: state.workspaceId, features: ['tenant-summary', 'conversation-delta'] });
  const dataSource = createDataSource({ request, registry });
  const consolidatedInbox = createConsolidatedInboxUI({ request, dataSource, context: () => ({ workspaceId: state.workspaceId, userId: state.boot.session.userId, authorityKey: authority() }), draftsStore: options => createDraftsStore({ ...options, storage: null }) });
  const inboxTimeline = createInboxTimeline({ renderMessage: item => `<article data-message-id="${item.id}"><p>${item.text}</p></article>`, timers: { setTimeout: () => 0, clearTimeout() {} } });
  const reset = { reset() {} }, refresh = { ...reset, refresh: async () => {}, load: async () => {} };
  let opening;
  const render = () => {
    const c = active(); renders.push({ company: state.tenant?.id, heading: c?.contact || null });
    document.querySelector('#chat-content').innerHTML = c ? `<div id="messages" tabindex="0">${inboxTimeline.markup(c.messages, `${state.tenant.id}:${c.id}`)}</div>` : '';
    field.value = c ? consolidatedInbox.getDraft(ref()) : '';
    if (c) { const node = document.querySelector('#messages'); inboxTimeline.bind(node, c.messages); opening.syncRemoteInboxEarlier(node); inboxTimeline.pin(node); }
  };
  opening = runInNewContext(excerpt('drop-inbox-detail') + '\n' + excerpt('select-inbox-conversation') + '\n({selectInboxConversation,showInboxEarlier,installInboxPagination,syncRemoteInboxEarlier,remoteInboxEarlierMarkup,inboxMessagePages})', {
    ...i18n, state, document, AbortController, api:request, inboxIdentity, dataSource, consolidatedInbox, inboxTimeline, earlierMarkup, inboxContactAuthority: authority, currentConversation: active, selectedInboxRef: ref,
    markConversationRead:c=>{readCalls.push({conversation:c,view:state.view,tenantId:state.tenant.id,busy:state.busy,rendered:renders.length>0});return readReceipt(c);},
    $: selector => document.querySelector(selector), hasPermission: permission => state.boot.session.permissions === null || state.boot.session.permissions.includes(permission), blockPendingSend: () => Boolean(state.sendIntent), flowDraftGuard: { confirm: async () => true },
    mediaUI: { draft: '', sending: false, ...reset, retainConversations() {}, forgetTenant() {}, syncContext: () => true, bindPlayers() {}, hydrate() {} }, voiceRecorder: { ...reset, busy: false }, participantsUI: reset,
    noteDrafts: { ...reset, key: 'company-a:case-a', save: value => { notes.push(value); return true; } },
    contactLinksUI: reset, contactRefresh: refresh, memoryUI: reset, repliesUI: reset, conversationTools: { ...reset, opened:true }, updateConversationTools:resultsOnly=>coverageUpdates.push({resultsOnly,loaded:active()?.messages.length}), forwarding: reset, contactImportUI: reset, automationUI: refresh, mcpUI: reset, knowledgeUI: refresh, brandDrafts: reset, avatarUI: { ...reset, bind() {} },
    attendanceContext: () => ({ userId: state.boot.session.userId, workspaceId: state.workspaceId, authorityKey: authority() }), resetScreens() {}, updateVoiceControls() {}, render, refreshInboxList: async () => {},
    currentRouteHash: () => `#inbox/${state.tenant?.id}/${state.conversation}`, location: { hash: '#inbox/company-a/case-a' }, history: { replaceState() {} }, toast: (...args) => notices.push(args),
    updateClientRecord: () => clientPatches.push({ company: state.tenant.id, contacts: state.contacts.map(item => item.id) }), tenantApi: tail => `/api/tenants/${state.tenant.id}/${tail}`, refreshMessageAttachments() {}, Promise, JSON
  });
  opening.installInboxPagination(inboxTimeline);
  t.after(() => { state.inboxOpeningController?.abort(); state.inboxHistoryController?.abort(); });
  return { ...opening, state, document, field, calls, aux, renders, notices, notes, clientPatches, readCalls, coverageUpdates, tenants, consolidatedInbox, inboxTimeline, response, ref, active, settleAux: () => { for (const item of aux) item.resolve(item.fallback()); } };
}

test('same-company content appears before all five deferred auxiliary GETs, with only the detail as its barrier', async t => {
  const f = fixture(t); let settled = false;
  const pending = f.selectInboxConversation('company-a', 'case-b').then(value => { settled = true; return value; }); await tick();
  assert.equal(settled, true); const c = await pending; assert.equal(c.id, 'case-b'); assert.equal(f.renders.length, 1); assert.equal(f.aux.length, 5);
  assert.equal(f.calls[0].path, '/api/tenants/company-a/conversations/case-b?limit=60'); assert.equal(f.calls.some(item => /summary=1/.test(item.path)), false); assert.ok(f.aux.every(item => f.calls.find(call => call.path === item.path).afterRender));
  assert.equal(c.messages.length, 80, 'already authorized older messages are preserved'); assert.equal(f.document.querySelector('#messages').querySelectorAll('article').length, 60);
  const contacts = f.aux.find(item => item.path.includes('/contacts')); contacts.resolve(contacts.fallback()); await tick();
  assert.equal(f.state.contacts[0].id, 'company-a-fresh-contact'); assert.equal(f.renders.length, 1, 'sidebar hydration must not redraw the conversation');
});

test('cross-company opening waits for its authorized summary and detail, then renders while auxiliaries remain pending', async t => {
  const summary = deferred(); const f = fixture(t, { intercept: path => path === '/api/tenants/company-b?summary=1' ? summary.promise : undefined });
  const pending = f.selectInboxConversation('company-b', 'case-b'); await tick(); assert.equal(f.renders.length, 0); assert.equal(f.state.tenant.id, 'company-a');
  assert.ok(f.calls.some(item => item.path === '/api/tenants/company-b/conversations/case-b?limit=60')); summary.resolve(f.response('/api/tenants/company-b?summary=1')); await pending;
  assert.equal(f.renders.at(-1).heading, 'company-b case-b'); assert.equal(f.aux.length, 5); assert.equal(f.state.contacts.length, 0); assert.equal(f.state.mcpServers.length, 0); assert.equal(f.state.flows.length, 0);
  assert.equal(f.active().messages.length, 60); assert.ok(f.document.querySelector('[data-inbox-remote-earlier]')); assert.equal(f.state.tenant.channels[0].capabilities.aiAllowed, false);
});

test('a newer primary revision discards the cached prefix and reloads earlier history from that revision', async t => {
  const f = fixture(t), cached = f.state.tenant.conversations.find(item => item.id === 'case-b'), fresh = f.tenants['company-a'].conversations.find(item => item.id === 'case-b');
  cached.messages[0].text = 'Own obsolete synthetic text'; fresh.version = 8; fresh.messages[0].text = 'Own revised synthetic text';
  await f.selectInboxConversation('company-a', 'case-b');
  assert.equal(f.active().version, 8); assert.equal(f.active().messages.length, 60); assert.ok(f.document.querySelector('[data-inbox-remote-earlier]'));
  assert.ok(f.active().messages.every(item => item.text !== 'Own obsolete synthetic text'));
  await f.showInboxEarlier(); assert.equal(f.active().messages.length, 80); assert.equal(f.active().messages[0].text, 'Own revised synthetic text');
});

test('opening from Contacts hydrates only after navigating to the selected inbox conversation', async t => {
  const f = fixture(t); f.state.view = 'contacts';
  await f.selectInboxConversation('company-b', 'case-b', { fromContact: true, isCurrent: () => f.state.view === 'contacts' });
  assert.equal(f.state.view, 'inbox'); assert.equal(f.state.tenant.id, 'company-b'); assert.equal(f.aux.length, 5);
  f.settleAux(); await tick(); assert.equal(f.state.contacts[0].id, 'company-b-fresh-contact'); assert.equal(f.renders.length, 1);
  assert.equal(f.readCalls.length,1);assert.equal(f.readCalls[0].conversation,f.active());assert.equal(f.readCalls[0].view,'inbox');assert.equal(f.readCalls[0].busy,false);assert.equal(f.readCalls[0].rendered,true);
});

test('direct deep-link selection returns the rendered detail while its native read confirmation remains pending',async t=>{
  const receipt=deferred(),f=fixture(t,{readReceipt:()=>receipt.promise});
  let settled=false;const pending=f.selectInboxConversation('company-a','case-b').then(c=>{settled=true;return c;});await tick();
  assert.equal(settled,true,'o POST de leitura não é barreira para abrir o atendimento');const selected=await pending;
  assert.equal(selected,f.active());assert.equal(f.readCalls.length,1);assert.equal(f.readCalls[0].conversation,selected);assert.equal(f.readCalls[0].rendered,true);assert.equal(f.aux.length,5);
  receipt.resolve(true);await tick();
});

test('selecting the current conversation invokes its opening read hook without another detail fetch',async t=>{
  const f=fixture(t);const selected=await f.selectInboxConversation('company-a','case-a');
  assert.equal(selected,f.active());assert.equal(f.calls.length,0);assert.equal(f.readCalls.length,1);assert.equal(f.readCalls[0].conversation,selected);
});

test('auxiliary responses arriving after a changed authority or route cannot update the current sidebar', async t => {
  const f = fixture(t); await f.selectInboxConversation('company-a', 'case-b'); f.state.boot.csrfToken = 'different-synthetic-csrf'; f.state.view = 'contacts';
  f.settleAux(); await tick(); assert.equal(f.state.contacts[0].id, 'prior-company-a-contact'); assert.equal(f.state.mcpServers[0].id, 'prior-company-a-mcp'); assert.equal(f.clientPatches.length, 0);
});

test('late auxiliary results never mix companies that share a conversation id', async t => {
  const f = fixture(t); await f.selectInboxConversation('company-a', 'case-b'); const first = [...f.aux];
  await f.selectInboxConversation('company-b', 'case-b'); for (const item of first) item.resolve(item.fallback()); await tick();
  assert.equal(f.state.contacts.length, 0); assert.equal(f.state.mcpServers.length, 0); assert.equal(f.clientPatches.length, 0);
  f.settleAux(); await tick(); assert.equal(f.state.contacts[0].id, 'company-b-fresh-contact'); assert.equal(f.state.mcpServers[0].id, 'company-b-fresh-mcp'); assert.equal(f.renders.length, 2);
});

test('a newer click aborts the older opening and its late response cannot replace the current chat', async t => {
  const wait = deferred(); const f = fixture(t, { intercept: path => path.includes('/conversations/case-b?') ? wait.promise : undefined });
  const old = f.selectInboxConversation('company-a', 'case-b'); await tick(); await f.selectInboxConversation('company-a', 'case-c');
  assert.equal(f.calls[0].options.signal.aborted, true); wait.resolve(f.response('/api/tenants/company-a/conversations/case-b?limit=60')); assert.equal(await old, undefined);
  assert.equal(f.state.conversation, 'case-c'); assert.equal(f.renders.length, 1); assert.equal(f.state.busy, false); assert.equal(f.state.inboxSelecting, false);
  assert.equal(f.readCalls.length,1);assert.equal(f.readCalls[0].conversation.id,'case-c');
});

for (const [name, mutate] of [['workspace', f => { f.state.workspaceId = 'workspace-b'; }], ['person', f => { f.state.boot.session.userId = 'other-person'; }], ['support', f => { f.state.supportGrantId = 'other-support'; }], ['permissions', f => { f.state.boot.session.permissions = []; }], ['csrf', f => { f.state.boot.csrfToken = 'different-synthetic-csrf'; }], ['route', f => { f.state.view = 'contacts'; }]]) test(`opening and auxiliaries ignore a changed ${name} before painting`, async t => {
  const wait = deferred(); const f = fixture(t, { intercept: path => path.includes('/conversations/case-b?') ? wait.promise : undefined });
  const pending = f.selectInboxConversation('company-a', 'case-b'); await tick(); mutate(f); wait.resolve(f.response('/api/tenants/company-a/conversations/case-b?limit=60')); await pending;
  assert.equal(f.renders.length, 0); assert.equal(f.state.conversation, 'case-a'); assert.equal(f.aux.length, 0);
  assert.equal(f.readCalls.length,0);
});

test('draft and internal note edited during the primary request remain owned by the previous conversation', async t => {
  const wait = deferred(); const f = fixture(t, { intercept: path => path.includes('/conversations/case-b?') ? wait.promise : undefined });
  const original = f.ref(), pending = f.selectInboxConversation('company-a', 'case-b'); await tick(); f.field.value = 'Final own edit A'; f.document.querySelector('#internal-note-text').value = 'Final own note A';
  wait.resolve(f.response('/api/tenants/company-a/conversations/case-b?limit=60')); await pending;
  assert.equal(f.consolidatedInbox.getDraft(original), 'Final own edit A'); assert.equal(f.field.value, ''); assert.equal(f.notes.at(-1), 'Final own note A');
  f.field.value = 'Own draft B'; await f.selectInboxConversation('company-a', 'case-a'); assert.equal(f.field.value, 'Final own edit A'); assert.equal(f.consolidatedInbox.getDraft({ ...original, conversationId: 'case-b' }), 'Own draft B');
});

test('failed auxiliary requests do not discard authorized content or force a full render', async t => {
  const f = fixture(t); await f.selectInboxConversation('company-a', 'case-b'); for (const item of f.aux) item.reject(Object.assign(new Error('Synthetic unavailable'), { status: 503 })); await tick();
  assert.equal(f.renders.length, 1); assert.equal(f.state.conversation, 'case-b'); assert.equal(f.state.contacts.length, 0); assert.equal(f.state.overviewLoaded.contacts, false); assert.equal(f.notices.length, 0);
});

test('403 from the primary detail drops unauthorized content instead of opening the cached copy', async t => {
  const f = fixture(t, { intercept: path => path.includes('/conversations/case-b?') ? Promise.reject(Object.assign(new Error('Synthetic forbidden'), { status: 403 })) : undefined });
  await f.selectInboxConversation('company-a', 'case-b'); assert.equal(f.state.conversation, null); assert.equal(f.state.tenant.conversations.length, 0); assert.equal(f.renders.at(-1).heading, null); assert.equal(f.aux.length, 0);
  assert.equal(f.readCalls.length,0);
});

test('a scoped primary DTO for a different conversation is refused before cache, sidebar or render', async t => {
  const f = fixture(t, { intercept: (path, options, fallback) => { if (!path.includes('/conversations/case-b?')) return; const result = fallback(); result.conversation.id = 'case-c'; return result; } });
  await f.selectInboxConversation('company-a', 'case-b'); assert.equal(f.state.conversation, 'case-a'); assert.equal(f.renders.length, 0); assert.equal(f.inboxMessagePages.size, 0); assert.equal(f.aux.length, 0);
});

test('previous history is fetched by cursor only on demand, preserving existing nodes and the scroll anchor', async t => {
  const wait = deferred(); const f = fixture(t, { intercept: path => path.includes('before=') ? wait.promise : undefined }); await f.selectInboxConversation('company-b', 'case-b');
  const timeline = f.document.querySelector('#messages'), existing = timeline.querySelectorAll('article')[1]; timeline.scrollTop = 100; timeline.dispatchEvent(new FakeEvent('scroll'));
  const top = timeline.scrollTop, height = timeline.scrollHeight, pending = f.showInboxEarlier(); await tick(); await f.showInboxEarlier();
  const older = f.calls.filter(item => item.path.includes('before=')); assert.equal(older.length, 1); assert.ok(older[0].path.includes('before=company-b-case-b-message-20')); assert.equal(timeline.querySelector('[data-inbox-remote-earlier] button').disabled, true);
  wait.resolve(f.response(older[0].path)); await pending;
  assert.equal(f.active().messages.length, 80); assert.equal(timeline.querySelectorAll('article').length, 80); assert.ok(timeline.querySelector(`[data-message-id="${existing.dataset.messageId}"]`) === existing, 'existing message node stays mounted');
  assert.equal(timeline.scrollTop, top + timeline.scrollHeight - height); assert.ok(timeline.querySelector('[data-inbox-remote-earlier]') === null, 'remote-history control is removed once complete'); assert.equal(f.renders.length, 1);
});

test('history coverage refresh preserves a composer focused while the earlier page was pending', async t => {
  const wait = deferred(); const f = fixture(t, { intercept: path => path.includes('before=') ? wait.promise : undefined });
  await f.selectInboxConversation('company-b', 'case-b');
  const timeline=f.document.querySelector('#messages');timeline.querySelector('[data-action="inbox:earlier"]').focus();
  const pending=f.showInboxEarlier();await tick();f.field.value='Preserved own draft';f.field.focus();
  const old=f.calls.find(call=>call.path.includes('before='));wait.resolve(f.response(old.path));await pending;
  assert.strictEqual(f.document.activeElement,f.field);assert.equal(f.field.value,'Preserved own draft');
  assert.deepEqual(f.coverageUpdates.at(-1),{resultsOnly:true,loaded:80});
});

test('late previous-history response cannot alter the selected company or conversation', async t => {
  const wait = deferred(); const f = fixture(t, { intercept: path => path.includes('before=') ? wait.promise : undefined }); await f.selectInboxConversation('company-b', 'case-b');
  const pending = f.showInboxEarlier(); await tick(); const oldRequest = f.calls.find(item => item.path.includes('before=')); await f.selectInboxConversation('company-a', 'case-c'); wait.resolve(f.response(oldRequest.path)); await pending;
  assert.equal(oldRequest.options.signal.aborted, true); assert.equal(f.state.tenant.id, 'company-a'); assert.equal(f.state.conversation, 'case-c'); assert.equal(f.active().messages.length, 60); assert.ok(f.active().messages.every(item => item.id.startsWith('company-a-case-c')));
});
