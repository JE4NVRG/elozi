import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const refresh = app.slice(app.indexOf('async function refresh('), app.indexOf('function focusViewContent()', app.indexOf('async function refresh(')));
const panelsStart = app.indexOf('async function loadViewPanels()');
const panels = app.slice(panelsStart, app.indexOf('/*@anchor:inbox-contact-authority*/', panelsStart));
const noop = () => {};
function harness(view, overrides = {}) {
  const calls = [], rendered = [], errors = [];
  const tenant = { id: 't', conversations: [], channels: [], agents: [] };
  const boot = { session: { role: 'reseller', userId: 'u', resellerId: 'w' }, tenants: [{ id: 't' }] };
  const state = { view, boot, workspaceId: 'w', tenant, conversation: null };
  const api = async path => {
    calls.push(path);
    if (path === '/api/bootstrap') return boot;
    if (path === '/api/tenants/t') return tenant;
    if (path === '/api/auth/me') return { user: { id: 'u', locale: 'pt-BR' } };
    if (path === '/api/auth/sessions') return { sessions: [] };
    if (path.endsWith('/contacts?archived=true')) return { contacts: [] };
    if (path.endsWith('/assignees')) return { assignees: [] };
    if (path.endsWith('/mcp/servers')) return { servers: [] };
    if (path === '/api/users/invitations') return { invitations: [] };
    return [];
  };
  const load = name => async () => { calls.push(name); };
  const context = {
    state, api, t: text => text, setLocale: noop,
    localStorage: { getItem: () => null, setItem: noop },
    selectedInboxRef: () => null, attendanceContext: () => ({ userId: 'u', workspaceId: 'w', authorityKey: 'a' }),
    contactLinksUI: { reset: noop }, contactRefresh: { reset: noop }, memoryUI: { reset: noop },
    mediaUI: { reset: noop, forgetTenant: noop, retainConversations: noop }, noteDrafts: { reset: noop }, repliesUI: { reset: noop },
    consolidatedInbox: { sync: noop, retainConversations: noop, data: { offset: 0 } },
    refreshInboxList: load('inbox-list'), $: () => null,
    automationUI: { refresh: load('automation-read') }, knowledgeUI: { load: load('knowledge-read') },
    servicePrincipalsUI: { load: load('services-read') }, supportUI: { load: load('support-read') },
    platformUsersUI: { load: load('platform-users-read') }, connectedProductsUI: { load: load('products-read') },
    billingUI: { load: load('billing-read') }, accountsUI: { load: load('accounts-read') },
    render: () => rendered.push(state.view), toast: error => errors.push(error), ...overrides
  };
  runInNewContext(panels + '\n' + refresh + '\nglobalThis.runRefresh=refresh;globalThis.runPanels=loadViewPanels;', context);
  return { context, state, calls, rendered, errors };
}

for (const view of ['overview', 'inbox', 'channels', 'agents']) {
  test(`authenticated ${view} refresh does not fetch unrelated automation or knowledge`, async () => {
    const h = harness(view);
    assert.equal(await h.context.runRefresh(undefined, { skipInboxList: true, skipOverviewPanels: true }), true);
    assert.equal(h.calls.includes('automation-read'), false);
    assert.equal(h.calls.includes('knowledge-read'), false);
    assert.ok(h.calls.includes('/api/bootstrap'));
    assert.ok(h.calls.includes('/api/auth/me'));
    assert.ok(h.calls.includes('/api/tenants/t'));
    assert.equal(h.state.account.user.id, 'u');
  });
}
for (const view of ['automation', 'knowledge']) {
  test(`initial ${view} route loads its own page before refresh completes`, async () => {
    const h = harness(view);
    assert.equal(await h.context.runRefresh(), true);
    assert.equal(h.calls.filter(c => c === `${view}-read`).length, 1);
    assert.equal(h.calls.includes(`${view === 'knowledge' ? 'automation' : 'knowledge'}-read`), false);
  });
  test(`${view} navigation uses the real panel loader`, async () => {
    const h = harness(view);
    await h.context.runPanels();
    assert.deepEqual(h.calls, [`${view}-read`]);
    assert.deepEqual(h.rendered, [view]);
    for (const [name, end] of [['navigate', '// Screen change'], ['applyRoute', 'async function startRoute']]) {
      const found = app.match(new RegExp(`(?:async )?function ${name}\\(`));
      assert.ok(found, `${name} binding exists`);
      const finish = app.indexOf(end, found.index);
      assert.ok(finish > found.index, `${name} boundary exists`);
      const part = app.slice(found.index, finish);
      assert.ok(part.includes("'automation','knowledge'"));
      assert.ok(part.includes('loadNavigatedPanels(view)'));
    }
  });
}
test('a delayed page read cannot repaint another route', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness('knowledge', { knowledgeUI: { load: () => pending } });
  const loading = h.context.runPanels();
  h.state.view = 'inbox';
  release();
  await loading;
  assert.deepEqual(h.rendered, []);
});
test('a delayed page read cannot repaint another workspace', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness('automation', { automationUI: { refresh: () => pending } });
  const loading = h.context.runPanels();
  h.state.workspaceId = 'other';
  release();
  await loading;
  assert.deepEqual(h.rendered, []);
});
test('failed page loads remain visible errors rather than silently loaded pages', async () => {
  const h = harness('knowledge', { knowledgeUI: { load: async () => { throw Error('read failed'); } } });
  await h.context.runPanels();
  assert.deepEqual(h.errors, ['read failed']);
  assert.deepEqual(h.rendered, []);
});

for (const [name, change] of [
  ['person', state => { state.boot.session.userId = 'other'; }],
  ['permissions', state => { state.boot.session.permissions = []; }],
  ['refresh sequence', state => { state.refreshSequence = (state.refreshSequence || 0) + 1; }],
  ['route epoch', state => { state.inboxRouteEpoch = (state.inboxRouteEpoch || 0) + 1; }]
]) test(`a delayed page read cannot repaint after changed ${name}`, async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness('knowledge', { knowledgeUI: { load: () => pending } });
  const loading = h.context.runPanels(); change(h.state); release(); await loading;
  assert.deepEqual(h.rendered, []);
});
test('an older panel load cannot repaint after the same route is reopened (ABA)', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const h = harness('knowledge', { knowledgeUI: { load: () => ++reads === 1 ? pending : Promise.resolve() } });
  const older = h.context.runPanels(); h.state.view = 'inbox'; h.state.view = 'knowledge';
  await h.context.runPanels(); assert.deepEqual(h.rendered, ['knowledge']);
  release(); await older; assert.deepEqual(h.rendered, ['knowledge']);
});
test('a rejected stale page load cannot toast into a new authority', async () => {
  let reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const h = harness('automation', { automationUI: { refresh: () => pending } });
  const loading = h.context.runPanels(); h.state.boot.session.userId = 'other';
  reject(Error('old private error')); await loading;
  assert.deepEqual(h.errors, []); assert.deepEqual(h.rendered, []);
});

test('an unrelated same-authority render does not starve the current page loader', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness('knowledge', { knowledgeUI: { load: () => pending } });
  const loading = h.context.runPanels();
  // render() advances the scoped-runs DOM epoch, not authorization or navigation.
  h.state.scopedRunsEpoch = (h.state.scopedRunsEpoch || 0) + 1;
  release();
  await loading;
  assert.deepEqual(h.rendered, ['knowledge']);
});
for (const field of ['workspace', 'person']) test(`support metadata cannot commit after ${field} changes`, async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness('support', { api: () => pending });
  h.state.supportTenants = [{ id: 'preserved' }];
  const loading = h.context.runPanels();
  if (field === 'workspace') h.state.workspaceId = 'other';
  else h.state.boot.session.userId = 'other';
  release({ id: 'old-authority-company' });
  await loading;
  assert.deepEqual(h.state.supportTenants, [{ id: 'preserved' }]);
  assert.equal(h.calls.includes('support-read'), false);
  assert.deepEqual(h.rendered, []);
});
test('current support metadata still commits and loads the actual support module', async () => {
  const h = harness('support', { api: async () => ({ id: 'current-company' }) });
  await h.context.runPanels();
  assert.equal(h.state.supportTenants[0].id, 'current-company');
  assert.equal(h.calls.includes('support-read'), true);
  assert.deepEqual(h.rendered, ['support']);
});
test('a stale bootstrap cannot start either page loader', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const boot = { session: { role: 'reseller', userId: 'u', resellerId: 'w' }, tenants: [{ id: 't' }] };
  const h = harness('knowledge', { api: () => pending });
  const loading = h.context.runRefresh();
  h.state.workspaceId = 'other';
  release(boot);
  assert.equal(await loading, false);
  assert.deepEqual(h.calls, []);
  assert.equal(h.state.workspaceId, 'other');
});
