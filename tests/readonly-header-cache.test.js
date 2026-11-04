import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadonlyHeaderCache } from '../src/readonly-header-cache.js';

const raw = label => JSON.stringify({ name: label, contacts: [{ identities: [{ channelId: 'wa', externalId: 'synthetic@lid' }], unknown: { labels: ['private'] } }],
  channels: [{ allowedGroups: ['123@g.us'], telegramGroups: { mode: 'selected', groupIds: ['-123'] } }], departments: [{ memberIds: ['operator'], unknown: { enabled: true } }] });
const read = (cache, tenant, header = raw(tenant), workspace = 'workspace') => cache.read(workspace, tenant, header);

test('cached headers preserve unknown JSON fields and freeze every nested object and array without mutation poisoning', () => {
  const cache = new ReadonlyHeaderCache(), input = raw('synthetic'), value = read(cache, 'tenant', input);
  assert.deepEqual(value, JSON.parse(input));
  for (const nested of [value, value.contacts, value.contacts[0], value.contacts[0].identities, value.contacts[0].identities[0], value.contacts[0].unknown,
    value.contacts[0].unknown.labels, value.channels[0].allowedGroups, value.channels[0].telegramGroups.groupIds, value.departments[0].memberIds, value.departments[0].unknown]) assert.ok(Object.isFrozen(nested));
  assert.throws(() => { value.contacts[0].identities[0].externalId = 'poison'; }, TypeError);
  assert.throws(() => value.channels[0].allowedGroups.push('forged@g.us'), TypeError);
  assert.throws(() => value.departments[0].memberIds.splice(0, 1), TypeError);
  assert.throws(() => { value.contacts[0].unknown.labels[0] = 'poison'; }, TypeError);
  assert.strictEqual(read(cache, 'tenant', input), value); assert.deepEqual(value, JSON.parse(input));
  assert.equal(cache.size, 1); assert.equal(cache.bytes, Buffer.byteLength(input, 'utf8'));
});

test('only an exact raw string and unambiguous workspace/tenant tuple reuse a parsed header', () => {
  const cache = new ReadonlyHeaderCache(), input = raw('same'), parse = JSON.parse; let parses = 0, first, second;
  JSON.parse = (...args) => { parses++; return parse(...args); };
  try { first = read(cache, 'tenant', input); second = read(cache, 'tenant', input); }
  finally { JSON.parse = parse; }
  assert.equal(parses, 1); assert.strictEqual(second, first);
  const spaced = ' ' + input, replacement = read(cache, 'tenant', spaced);
  assert.notStrictEqual(replacement, first); assert.deepEqual(replacement, first); assert.equal(cache.size, 1); assert.equal(cache.bytes, Buffer.byteLength(spaced));
  const a = read(cache, 'b:c', input, 'a'), b = read(cache, 'c', input, 'a:b');
  assert.notStrictEqual(a, b); assert.strictEqual(read(cache, 'b:c', input, 'a'), a); assert.strictEqual(read(cache, 'c', input, 'a:b'), b);
  assert.notStrictEqual(read(cache, 'tenant', input, 'other-workspace'), first);
});

test('a new raw version replaces the sole prior entry, including when parsing fails', () => {
  const cache = new ReadonlyHeaderCache(), first = read(cache, 'tenant'), nextRaw = raw('changed-without-app-version'), next = read(cache, 'tenant', nextRaw);
  assert.notStrictEqual(next, first); assert.equal(cache.size, 1); assert.equal(cache.bytes, Buffer.byteLength(nextRaw));
  assert.throws(() => read(cache, 'tenant', '{'), SyntaxError);
  assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
  const restored = read(cache, 'tenant'); assert.notStrictEqual(restored, first); assert.deepEqual(restored, first);
  assert.equal(cache.size, 1);
});

test('LRU hits refresh recency and the entry limit evicts the oldest distinct scope', () => {
  const cache = new ReadonlyHeaderCache({ maxEntries: 2 }), a = read(cache, 'a'), b = read(cache, 'b');
  assert.strictEqual(read(cache, 'a'), a); read(cache, 'c');
  assert.equal(cache.size, 2); assert.strictEqual(read(cache, 'a'), a);
  assert.notStrictEqual(read(cache, 'b'), b); assert.equal(cache.size, 2);
  const defaults = new ReadonlyHeaderCache(), first = read(defaults, '0', '{}');
  for (let index = 1; index <= 32; index++) read(defaults, String(index), '{}');
  assert.equal(defaults.size, 32); assert.notStrictEqual(read(defaults, '0', '{}'), first);
});

test('the total budget counts raw UTF-8 bytes rather than JS string length and evicts by recency', () => {
  const aRaw = JSON.stringify({ text: 'é🌙A' }), bRaw = JSON.stringify({ text: 'é🌙B' }), cRaw = JSON.stringify({ text: 'é🌙C' });
  const bytes = Buffer.byteLength(aRaw); assert.ok(bytes > aRaw.length);
  const cache = new ReadonlyHeaderCache({ maxEntries: 4, maxBytes: bytes * 2, maxHeaderBytes: bytes });
  const a = read(cache, 'a', aRaw), b = read(cache, 'b', bRaw);
  assert.equal(cache.bytes, bytes * 2); assert.equal(cache.size, 2); assert.strictEqual(read(cache, 'a', aRaw), a);
  read(cache, 'c', cRaw); assert.equal(cache.bytes, bytes * 2); assert.equal(cache.size, 2);
  assert.strictEqual(read(cache, 'a', aRaw), a); assert.notStrictEqual(read(cache, 'b', bRaw), b);
  assert.ok(cache.bytes <= bytes * 2);
});

test('oversized headers bypass retention and remove a former version without evicting unrelated scopes', () => {
  const cache = new ReadonlyHeaderCache({ maxEntries: 3, maxBytes: 128, maxHeaderBytes: 32 });
  const other = read(cache, 'other', '{"other":true}'), old = read(cache, 'target', '{"old":true}');
  const large = JSON.stringify({ text: 'synthetic'.repeat(12) }), a = read(cache, 'target', large), b = read(cache, 'target', large);
  assert.notStrictEqual(a, b); assert.notStrictEqual(a, old); assert.ok(Object.isFrozen(a));
  assert.equal(cache.size, 1); assert.equal(cache.bytes, Buffer.byteLength('{"other":true}')); assert.strictEqual(read(cache, 'other', '{"other":true}'), other);
  const aggregate = new ReadonlyHeaderCache({ maxBytes: 8, maxHeaderBytes: 32 });
  assert.deepEqual(read(aggregate, 'target', '{"long":true}'), { long: true }); assert.equal(aggregate.size, 0); assert.equal(aggregate.bytes, 0);
});

test('clear releases all retained versions and configurable limits cannot exceed the production ceilings', () => {
  const cache = new ReadonlyHeaderCache(), before = read(cache, 'tenant'); read(cache, 'other'); cache.clear();
  assert.equal(cache.size, 0); assert.equal(cache.bytes, 0); assert.ok(Object.isFrozen(before)); assert.notStrictEqual(read(cache, 'tenant'), before);
  cache.clear(); cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
  for (const [field, maximum] of [['maxEntries', 32], ['maxBytes', 32 * 1024 ** 2], ['maxHeaderBytes', 4 * 1024 ** 2]]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '2', maximum + 1]) assert.throws(() => new ReadonlyHeaderCache({ [field]: value }), `${field}:${value}`);
  }
});
