import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, formatHash } from '../public/router.js';
import { inboxQuery } from '../public/consolidated-inbox-ui.js';
import { inboxRouteFilters } from '../public/inbox-route-filters.js';

const scope = Object.freeze({ workspaceId: 'w-a', defaultLens: 'mine' });
const catalog = Object.freeze({ workspaceId: 'w-a', tenants: [{ id: 'a' }, { id: 'b' }], channels: [
  { tenantId: 'a', id: 'personal' }, { tenantId: 'a', id: 'sales' }, { tenantId: 'b', id: 'sales' }
] });
const snapshot = hash => inboxRouteFilters(parseHash(hash), catalog, scope);
const denied = (hash, code, rows = catalog) => assert.throws(() => inboxRouteFilters(parseHash(hash), rows, scope), error => error.code === code);

test('parsed channel route uses exact tenant/channel pair consumed by real request builder', () => {
  const next = snapshot('#inbox?tenant=a&channel=sales&lens=queue&kind=group&unread=1&q=Jean&w=w-a');
  assert.deepEqual(next, { inboxCompany: 'a', channel: '["a","sales"]', filter: 'queue', kind: 'group',
    unread: true, search: 'Jean', assignedUser: 'all', status: 'active', department: 'all', sort: 'recent', kindFromLink: true, inboxContactFocus: null });
  const query = new URL(inboxQuery(next), 'https://fixture.invalid').searchParams;
  assert.equal(query.get('tenantId'), 'a'); assert.equal(query.get('channelId'), 'sales');
  assert.equal(query.get('tab'), 'queue'); assert.equal(query.get('unread'), 'true');
});

test('absent URL fields clear every prior filter, including advanced unencoded fields', () => {
  const state = { ...snapshot('#inbox?tenant=a&channel=personal&unread=1&q=Jean&kind=group'), assignedUser: 'old', department: 'old', status: 'closed', sort: 'old', inboxContactFocus: {} };
  Object.assign(state, snapshot('#inbox?tenant=b'));
  assert.deepEqual(state, { inboxCompany: 'b', assignedUser: 'all', filter: 'mine', search: '', channel: 'all', status: 'active', unread: false, department: 'all', kind: 'all', sort: 'recent', kindFromLink: false, inboxContactFocus: null });
  assert.equal(snapshot('#inbox').inboxCompany, 'all');
});

test('back / forward / reload snapshots are deterministic, with real router round trips', () => {
  const hashes = ['#inbox?tenant=a&channel=personal&unread=1&q=Jean', '#inbox?tenant=b', '#inbox'];
  const expected = hashes.map(snapshot); const state = {};
  for (const index of [0, 1, 2, 1, 0, 1, 2]) {
    Object.assign(state, snapshot(formatHash(parseHash(hashes[index]))));
    assert.deepEqual(state, expected[index]);
  }
});

test('channel alone only infers a unique authorized tenant; duplicate ids across tenants denied', () => {
  assert.equal(snapshot('#inbox?channel=personal').inboxCompany, 'a');
  denied('#inbox?channel=sales', 'INBOX_ROUTE_CHANNEL_AMBIGUOUS');
  assert.equal(snapshot('#inbox?tenant=b&channel=sales').channel, '["b","sales"]');
});

test('unknown or unauthorized channel and mismatched pair never return a broadened snapshot', () => {
  denied('#inbox?tenant=a&channel=unknown', 'INBOX_ROUTE_CHANNEL');
  denied('#inbox?tenant=b&channel=personal', 'INBOX_ROUTE_CHANNEL');
  denied('#inbox?tenant=foreign&channel=personal', 'INBOX_ROUTE_TENANT');
  denied('#inbox?tenant=foreign', 'INBOX_ROUTE_TENANT');
  denied('#inbox?channel=hidden', 'INBOX_ROUTE_CHANNEL', { ...catalog, channels: [{ tenantId: 'foreign', id: 'hidden' }] });
});

test('missing or stale catalogs fail explicitly, never implicitly use current tenant', () => {
  denied('#inbox?channel=personal', 'INBOX_ROUTE_CATALOG_UNAVAILABLE', null);
  denied('#inbox?tenant=a', 'INBOX_ROUTE_CATALOG_UNAVAILABLE', { ...catalog, workspaceId: 'w-b' });
  denied('#inbox?channel=personal', 'INBOX_ROUTE_CATALOG_UNAVAILABLE', { ...catalog, channels: null });
  assert.equal(inboxRouteFilters(parseHash('#inbox'), null, scope).filter, 'mine');
});

test('cross workspace is rejected before selecting a channel; row workspace cannot authorize it', () => {
  denied('#inbox?tenant=a&channel=personal&w=w-b', 'INBOX_ROUTE_WORKSPACE');
  denied('#inbox?channel=personal', 'INBOX_ROUTE_CHANNEL', { ...catalog, channels: [{ tenantId: 'a', id: 'personal', workspaceId: 'w-b' }] });
});

test('conversation and non-inbox routes are untouched; explicit lens overrides role default', () => {
  assert.equal(snapshot('#inbox/a/chat?run=r'), null); assert.equal(snapshot('#overview'), null);
  for (const defaultLens of ['mine', 'all']) {
    assert.equal(inboxRouteFilters(parseHash('#inbox'), catalog, { ...scope, defaultLens }).filter, defaultLens);
    assert.equal(inboxRouteFilters(parseHash('#inbox?lens=queue'), catalog, { ...scope, defaultLens }).filter, 'queue');
  }
});

test('constructed invalid route objects throw; parser-sanitized invalid parameters cannot be recovered', () => {
  assert.throws(() => inboxRouteFilters({ section: 'inbox', query: { channel: 'bad value' } }, catalog, scope), { code: 'INBOX_ROUTE_ID' });
  assert.throws(() => inboxRouteFilters({ section: 'inbox', query: { unread: '0' } }, catalog, scope), { code: 'INBOX_ROUTE_QUERY' });
  assert.deepEqual(parseHash('#inbox?channel=bad%20value').query, {}); // Raw-intent validation belongs at the app boundary.
  assert.throws(() => inboxRouteFilters(parseHash('#inbox'), catalog, { workspaceId: 'w-a' }), { code: 'INBOX_ROUTE_DEFAULT_LENS' });
});

test('frozen input remains unchanged, duplicate catalog rows do not create false ambiguity', () => {
  const rows = structuredClone(catalog); rows.channels.push({ tenantId: 'a', id: 'personal' });
  for (const row of [...rows.channels, ...rows.tenants]) Object.freeze(row);
  Object.freeze(rows.channels); Object.freeze(rows.tenants); Object.freeze(rows);
  const route = parseHash('#inbox?tenant=a&channel=personal'); Object.freeze(route.query); Object.freeze(route);
  const before = JSON.stringify({ rows, route, scope });
  assert.equal(inboxRouteFilters(route, rows, scope).channel, '["a","personal"]');
  assert.equal(JSON.stringify({ rows, route, scope }), before);
});
