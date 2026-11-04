import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { proto, processSyncAction, chatModificationToAppPatch } from '@whiskeysockets/baileys';
import { READ_SYNC_SDK_VERSION, createReadSyncLogger, projectReadSync } from '../src/whatsapp-read-state.js';

const NOW = Date.parse('2026-10-20T12:00:00Z'), SEC = NOW / 1000, JID = '5511988880000@s.whatsapp.net';
const key = { id: 'actual-provider-key', remoteJid: JID, fromMe: false };
function action({ timestamp = NOW, messageTimestamp = SEC - 1, read = true, range = true } = {}) {
  // The protobuf wire contract names this field timestamp; outbound MinimalMessage uses messageTimestamp.
  const syncAction = proto.SyncActionData.decode(proto.SyncActionData.encode(proto.SyncActionData.fromObject({ value: { timestamp, markChatAsReadAction: { read,
    ...(range ? { messageRange: { lastMessageTimestamp: messageTimestamp, messages: [{ key, timestamp: messageTimestamp }] } } : {}) } } })).finish());
  return { index: ['markChatAsRead', JID], syncAction };
}

test('pinned SDK real processSyncAction exposes validated timestamp/range to the silent per-entry logger', () => {
  assert.equal(createRequire(import.meta.url)('@whiskeysockets/baileys/package.json').version, READ_SYNC_SDK_VERSION);
  const emitter = new EventEmitter(), updates = [], evidence = [];
  emitter.on('chats.update', values => updates.push(...values));
  const logger = createReadSyncLogger({ now: () => NOW, onRead: value => evidence.push(value) });
  processSyncAction(action(), emitter, { id: '5511999990000@s.whatsapp.net' }, undefined, logger);
  assert.equal(logger.level, 'silent'); assert.equal(logger.child(), logger);
  assert.equal(evidence.length, 1); assert.deepEqual(evidence[0], { chatJid: JID, readAtMs: NOW, initialSync: false, anchors: [{ key, providerTs: SEC - 1 }] });
  assert.equal(updates[0].unreadCount, 0); assert.equal(updates[0].messageRange, undefined); assert.equal(updates[0].timestamp, undefined);
  assert.deepEqual(Object.keys(evidence[0]).sort(), ['anchors','chatJid','initialSync','readAtMs']);
});

test('snapshot projection requires real protobuf message timestamps and never accepts a bare chats.update', () => {
  const good = { syncAction: action(), initialSync: true };
  assert.ok(projectReadSync(good, 'processing sync action', NOW));
  assert.equal(projectReadSync({ id: JID, unreadCount: 0 }, 'processing sync action', NOW), null);
  const missing = action(); delete missing.syncAction.value.markChatAsReadAction.messageRange.messages[0].timestamp;
  assert.equal(projectReadSync({ syncAction: missing, initialSync: false }, 'processing sync action', NOW), null);
  assert.equal(projectReadSync({ syncAction: action({ range: false }), initialSync: false }, 'processing sync action', NOW), null);
});

test('protobuf null/undefined participant means absent only in direct chats; group inbound still requires a valid sender', () => {
  const mutation = action(), sdkKey = mutation.syncAction.value.markChatAsReadAction.messageRange.messages[0].key;
  assert.equal(sdkKey.participant, null, 'the decoded rc14 protobuf uses null as its default');
  for (const value of [null, undefined]) {
    sdkKey.participant = value;
    const projected = projectReadSync({ syncAction: mutation, initialSync: false }, 'processing sync action', NOW);
    assert.ok(projected); assert.equal(Object.hasOwn(projected.anchors[0].key, 'participant'), false);
  }
  for (const value of ['', false, 0, 'invalid-participant']) {
    sdkKey.participant = value;
    assert.equal(projectReadSync({ syncAction: mutation, initialSync: false }, 'processing sync action', NOW), null);
  }
  mutation.index[1] = '12000001@g.us'; sdkKey.remoteJid = mutation.index[1];
  for (const value of [null, undefined]) { sdkKey.participant = value; assert.equal(projectReadSync({ syncAction: mutation, initialSync: false }, 'processing sync action', NOW), null); }
  sdkKey.participant = JID;
  assert.ok(projectReadSync({ syncAction: mutation, initialSync: false }, 'processing sync action', NOW));
});

test('incompatible SDK, unrelated trace, unread action, invalid or future timestamps stay conservative', () => {
  const good = { syncAction: action(), initialSync: false };
  assert.equal(projectReadSync(good, 'processing sync action', NOW, '7.0.0-unknown'), null);
  assert.equal(projectReadSync(good, 'another SDK diagnostic', NOW), null);
  for (const options of [{ timestamp: 0 }, { timestamp: NOW + 300001 }, { messageTimestamp: SEC + 600 }, { read: false }]) assert.equal(projectReadSync({ syncAction: action(options), initialSync: false }, 'processing sync action', NOW), null);
  const evidence = [], logger = createReadSyncLogger({ version: 'unknown', onRead: item => evidence.push(item), now: () => NOW });
  processSyncAction(action(), new EventEmitter(), {}, undefined, logger); assert.deepEqual(evidence, []);
});

test('outbound SDK patch retains the captured message cursor after real protobuf encode/decode', () => {
  const patch = chatModificationToAppPatch({ markRead: true, lastMessages: [{ key: { ...key }, messageTimestamp: SEC - 1, timestamp: SEC - 1 }] }, JID);
  const decoded = proto.SyncActionValue.decode(proto.SyncActionValue.encode(proto.SyncActionValue.fromObject(patch.syncAction)).finish());
  assert.equal(decoded.markChatAsReadAction.read, true); assert.equal(Number(decoded.markChatAsReadAction.messageRange.lastMessageTimestamp), SEC - 1);
  assert.equal(Number(decoded.markChatAsReadAction.messageRange.messages[0].timestamp), SEC - 1); assert.equal(decoded.markChatAsReadAction.messageRange.messages[0].key.id, key.id);
});
