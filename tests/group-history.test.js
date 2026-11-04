import test from 'node:test';
import assert from 'node:assert/strict';
import { groupHistory } from '../src/group-history.js';
const now = Date.parse('2026-10-05T15:00:00Z');
const options = { tenantId: 'tenant-a', now };
const group = () => ({ id: 'group-a', channelId: 'wa-a', conversationKind: 'group', version: 3, messages: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, kind: 'customer', senderName: `Pessoa ${index}`, text: `Mensagem ${index}`, createdAt: new Date(now - (6 - index) * 60000).toISOString() })) });
const status = value => error => error.status === value;
test('group history moves backwards without duplicates and preserves page chronology and speakers', () => {
  const conversation = group(), seen = [];
  let cursor;
  do { const page = groupHistory(conversation, { limit: 2, ...(cursor ? { cursor } : {}) }, options); seen.push(...page.messages.map(m => m.id)); cursor = page.nextCursor; assert.equal(page.messages[0].senderName, `Pessoa ${Number(page.messages[0].id.slice(1))}`); assert.equal(page.coverage.availableCount, 6); } while (cursor);
  assert.deepEqual(seen, ['m4', 'm5', 'm2', 'm3', 'm0', 'm1']);
});
test('group history never exposes notes, provider identities, URLs or internal attachment properties', () => {
  const conversation = group();
  conversation.messages.push({ id: 'note', kind: 'note', text: 'Private note', createdAt: new Date(now).toISOString() });
  Object.assign(conversation.messages[0], { senderJid: 'private-jid', secret: 'forbidden', attachments: [{ id: 'file-a', kind: 'image', name: 'Foto', mime: 'image/jpeg', size: 12, url: 'secret-provider-url', secret: 'secret' }] });
  const page = groupHistory(conversation, {}, options), serialized = JSON.stringify(page);
  assert.equal(page.messages.length, 6); assert.equal(serialized.includes('secret'), false); assert.equal(serialized.includes('private-jid'), false); assert.equal(page.coverage.attachmentsAnalyzed, false);
});
test('group history cursor is bound to conversation, tenant, channel, version and time window', () => {
  const conversation = group(), page = groupHistory(conversation, { limit: 2 }, options);
  for (const changed of [{ ...options, tenantId: 'tenant-b' }, { ...options, channelId: 'wa-b' }]) assert.throws(() => groupHistory(conversation, { cursor: page.nextCursor }, changed), status(409));
  assert.throws(() => groupHistory({ ...conversation, id: 'group-b' }, { cursor: page.nextCursor }, options), status(409));
  assert.throws(() => groupHistory({ ...conversation, version: 4 }, { cursor: page.nextCursor }, options), status(409));
  assert.throws(() => groupHistory(conversation, { cursor: page.nextCursor, after: '2026-10-04T00:00:00Z' }, options), status(409));
});
test('group history rejects invalid period, calendar, range, limits, unknown fields and forged cursor format', () => {
  const conversation = group();
  for (const input of [{ limit: 101 }, { limit: 0 }, { after: '2026-02-31T01:00:00Z' }, { after: '2026-08-01T00:00:00Z' }, { before: '2026-10-01T00:00:00Z', after: '2026-10-02T00:00:00Z' }, { after: '2026-10-04' }, { includeNotes: true }, { cursor: '%%%bad' }, { cursor: Buffer.from(JSON.stringify({ format: 1, offset: 1, unknown: true })).toString('base64url') }]) assert.throws(() => groupHistory(conversation, input, options), status(400));
  assert.throws(() => groupHistory({ ...conversation, conversationKind: 'direct' }, {}, options), status(400));
});
test('group history respects explicit window with offset timezone and skips invalid message dates', () => {
  const conversation = group(); conversation.messages.push({ id: 'bad', kind: 'customer', createdAt: 'bad', text: 'bad' });
  const page = groupHistory(conversation, { after: '2026-10-05T11:57:00-03:00', before: '2026-10-05T12:00:00-03:00' }, options);
  assert.deepEqual(page.messages.map(m => m.id), ['m3', 'm4', 'm5']); assert.equal(page.coverage.from, '2026-10-05T14:57:00.000Z');
});
