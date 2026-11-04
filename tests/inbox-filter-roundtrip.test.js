import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, formatHash, registerAlias } from '../public/router.js';
import { inboxRouteFilters, inboxFilterQuery } from '../public/inbox-route-filters.js';
import { inboxQuery } from '../public/consolidated-inbox-ui.js';

const scope = Object.freeze({ workspaceId: 'w-a', defaultLens: 'mine' });
const catalog = { workspaceId: 'w-a', tenants: [{ id: 'a' }, { id: 'b' }],
  channels: [{ tenantId: 'a', id: 'phone' }, { tenantId: 'b', id: 'phone' }],
  departments: [{ tenantId: 'a', id: 'support' }, { tenantId: 'b', id: 'support' }, { tenantId: 'a', id: 'unique' }],
  assignees: [{ tenantId: 'a', id: 'alice' }, { tenantId: 'b', id: 'bob' }] };
const snapshot = (hash, rows = catalog) => inboxRouteFilters(parseHash(hash), rows, scope);
const serialize = state => formatHash({ section: 'inbox', query: inboxFilterQuery(state) });
const denies = (hash, code, rows = catalog) => assert.throws(() => snapshot(hash, rows), { code });

test('advanced A -> B -> A survives real state/router/request round trips without widening', () => {
  const a = snapshot('#inbox?tenant=a&channel=phone&department=support&assignedUser=alice&status=closed&sort=oldest&lens=queue&kind=group&unread=1&q=case');
  const b = snapshot('#inbox?tenant=b&channel=phone&department=support&assignedUser=bob&status=pending&sort=unread&lens=all');
  const history = [serialize(a), serialize(b)], state = {};
  for (const index of [0, 1, 0]) {
    Object.assign(state, snapshot(history[index]));
    assert.deepEqual(state, index === 0 ? a : b);
    const request = new URL(inboxQuery(state), 'https://fixture.invalid').searchParams;
    assert.equal(request.get('tenantId'), index === 0 ? 'a' : 'b');
    assert.equal(request.get('channelId'), 'phone');
    assert.equal(request.get('departmentId'), 'support');
    assert.equal(request.get('assignedUserId'), index === 0 ? 'alice' : 'bob');
    assert.equal(request.get('status'), index === 0 ? 'closed' : 'pending');
    assert.equal(request.get('sort'), index === 0 ? 'oldest' : 'unread');
  }
});

test('legacy defaults emit no advanced fields; absent fields and clear reset coherently', () => {
  const legacy = snapshot('#inbox?lens=mine&tenant=a&q=case');
  assert.equal(serialize(legacy), '#inbox?lens=mine&tenant=a&q=case');
  const state = { ...snapshot('#inbox?tenant=a&department=support&assignedUser=alice&status=closed&sort=oldest') };
  Object.assign(state, snapshot('#inbox'));
  assert.deepEqual(state, snapshot('#inbox'));
  assert.deepEqual(inboxFilterQuery(state), { lens: 'mine' });
  assert.equal(state.department, 'all'); assert.equal(state.assignedUser, 'all');
  assert.equal(state.status, 'active'); assert.equal(state.sort, 'recent');
  assert.equal(snapshot('#inbox?department=unassigned', null).department, 'unassigned');
  assert.equal(serialize(snapshot('#inbox?department=unassigned', null)), '#inbox?lens=mine&department=unassigned');
});

test('every existing status/sort enum round trips; invented enums never become defaults', () => {
  for (const status of ['active', 'all', 'open', 'pending', 'closed']) {
    for (const sort of ['recent', 'oldest', 'unread']) {
      const state = snapshot(`#inbox?status=${status}&sort=${sort}`, null);
      assert.deepEqual(snapshot(serialize(state), null), state);
    }
  }
  for (const field of ['status', 'sort']) {
    assert.equal(parseHash(`#inbox?${field}=invented`), null);
    assert.throws(() => formatHash({ section: 'inbox', query: { [field]: 'invented' } }), TypeError);
    assert.throws(() => inboxRouteFilters({ section: 'inbox', query: { [field]: 'invented' } }, catalog, scope), { code: 'INBOX_ROUTE_QUERY' });
  }
});

test('new fields reject duplicates, controls, malformed encoding and empty values without sanitizing intent', () => {
  for (const [name, value] of [['status', 'open'], ['sort', 'oldest'], ['department', 'support'], ['assignedUser', 'alice']]) {
    for (const bad of [`${name}=${value}&${name}=${value}`, `${name}=`, `${name}=${value}%00`, `${name}=${value}%0A`, `${name}=${value}%0D`, `${name}=${value}%7F`, `${name}=${value}%C2%80`, `${name}=${value}%`, `${name}=${value}%E0%A4%A`]) {
      assert.equal(parseHash('#inbox?tenant=a&' + bad), null, bad);
    }
  }
  for (const name of ['department', 'assignedUser']) assert.equal(parseHash(`#inbox?${name}=all`), null);
  for (const name of ['status', 'sort', 'department', 'assignedUser']) {
    for (const value of ['', null, 1]) assert.throws(() => formatHash({ section: 'inbox', query: { [name]: value } }), TypeError);
  }
  registerAlias('filter-roundtrip', '#inbox?kind=group');
  assert.equal(parseHash('#filter-roundtrip?status=open&status=closed'), null);
  // The legacy tenant/channel gate remains the app caller's responsibility.
  assert.deepEqual(parseHash('#inbox?channel=bad%20value').query, {});
});

test('department IDs require a current authorized catalog and agree with tenant/channel', () => {
  denies('#inbox?department=unique', 'INBOX_ROUTE_CATALOG_UNAVAILABLE', null);
  denies('#inbox?department=unique', 'INBOX_ROUTE_CATALOG_UNAVAILABLE', { ...catalog, workspaceId: 'w-b' });
  denies('#inbox?department=unique', 'INBOX_ROUTE_CATALOG_UNAVAILABLE', { ...catalog, departments: null });
  denies('#inbox?department=support', 'INBOX_ROUTE_DEPARTMENT_AMBIGUOUS');
  assert.equal(snapshot('#inbox?department=unique').inboxCompany, 'a');
  denies('#inbox?tenant=b&department=unique', 'INBOX_ROUTE_DEPARTMENT');
  denies('#inbox?tenant=b&channel=phone&department=unique', 'INBOX_ROUTE_DEPARTMENT');
  denies('#inbox?tenant=a&department=unknown', 'INBOX_ROUTE_DEPARTMENT');
  denies('#inbox?department=unique', 'INBOX_ROUTE_DEPARTMENT', { ...catalog, departments: [{ tenantId: 'foreign', id: 'unique' }] });
  denies('#inbox?department=unique', 'INBOX_ROUTE_DEPARTMENT', { ...catalog, departments: [{ tenantId: 'a', id: 'unique', workspaceId: 'w-b' }] });
  denies('#inbox?department=unique&w=w-b', 'INBOX_ROUTE_WORKSPACE');
});

test('assignee catalog membership is scoped to resolved tenant, never boot users or items', () => {
  assert.equal(snapshot('#inbox?assignedUser=alice').inboxCompany, 'all');
  assert.equal(snapshot('#inbox?department=unique&assignedUser=alice').assignedUser, 'alice');
  denies('#inbox?tenant=b&assignedUser=alice', 'INBOX_ROUTE_ASSIGNEE');
  denies('#inbox?department=unique&assignedUser=bob', 'INBOX_ROUTE_ASSIGNEE');
  denies('#inbox?assignedUser=missing', 'INBOX_ROUTE_ASSIGNEE');
  denies('#inbox?assignedUser=alice', 'INBOX_ROUTE_CATALOG_UNAVAILABLE', { ...catalog, assignees: undefined, items: [{ assignedUserId: 'alice' }] });
  for (const row of [{ tenantId: 'foreign', id: 'alice' }, { tenantId: 'a', id: 'alice', workspaceId: 'w-b' }]) {
    denies('#inbox?assignedUser=alice', 'INBOX_ROUTE_ASSIGNEE', { ...catalog, assignees: [row] });
  }
});

test('serializer is pure, rejects malformed state and conflicting tenant pairs', () => {
  const state = Object.freeze(snapshot('#inbox?tenant=a&channel=phone&department=support&assignedUser=alice'));
  const before = JSON.stringify(state); serialize(state); assert.equal(JSON.stringify(state), before);
  for (const channel of ['phone', '[]', '["a"]', '["a","bad value"]', 'null']) {
    assert.throws(() => inboxFilterQuery({ ...state, channel }), { code: 'INBOX_ROUTE_ID' });
  }
  assert.throws(() => inboxFilterQuery({ ...state, department: '["b","support"]' }), { code: 'INBOX_ROUTE_TENANT' });
  assert.throws(() => inboxFilterQuery({ ...state, unread: '1' }), { code: 'INBOX_ROUTE_QUERY' });
  assert.throws(() => inboxRouteFilters({ section: 'inbox', query: { department: 'support\n' } }, catalog, scope), { code: 'INBOX_ROUTE_ID' });
  assert.equal(snapshot('#inbox/a/chat?status=closed'), null);
  assert.equal(snapshot('#overview'), null);
});
