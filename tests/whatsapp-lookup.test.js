// Real Store/read-model lookup and WhatsApp handlers; only the provider socket is synthetic. No network or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { proto } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { syncIncomingConversationContact } from '../src/contacts.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Synthetic lookup owner' };
const own = '5511999990000', pn = '5511988880000@s.whatsapp.net', other = '5511977770000@s.whatsapp.net';
const lid = '123456@lid', group = '12000001@g.us', unknown = '5511966660000@s.whatsapp.net';
const tick = () => new Promise(resolve => setImmediate(resolve));
const device = jid => jid.replace('@', ':4@');
const ACK = proto.WebMessageInfo.Status;

async function fixture(t) {
  const store = new Store(':memory:'), sockets = [];
  const tenant = store.createTenant(admin, { name: 'Synthetic lookup', segment: 'Fixture' });
  const seconds = Math.floor(Date.now() / 1000) - 20;
  const message = (id, kind, externalId, extra = {}) => ({ id, kind, externalId, text: 'Synthetic message', transport: 'whatsapp', delivery: kind === 'customer' ? 'received' : 'pending', providerTs: seconds, createdAt: new Date(seconds * 1000).toISOString(), ...extra });
  store.mutate(admin, tenant.id, 'Lookup fixture', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', name: 'Synthetic WhatsApp', expectedNumber: own, state: 'disconnected', enabled: true, allowedGroups: [group] },
      { id: 'elsewhere', kind: 'whatsapp_qr', transport: 'baileys', name: 'Other channel', state: 'disconnected' }];
    const conversation = (id, remoteJid, messages, extra = {}) => ({ id, channelId: 'wa', remoteJid, remoteAliases: [], contact: 'Synthetic contact', conversationKind: remoteJid.endsWith('@g.us') ? 'group' : 'direct',
      owner: 'human', status: 'open', version: 3, unread: 1, messages, ...extra });
    state.conversations = [
      conversation('z-first', pn, [message('customer', 'customer', 'inbound-read'), message('out-first', 'human', 'shared-receipt'), message('ignored-transport', 'human', 'other-transport', { transport: 'webchat' })], { remoteAliases: [lid, lid] }),
      conversation('a-second', other, [message('out-second', 'agent', 'shared-receipt')], { remoteAliases: [lid] }),
      conversation('group', group, [message('group-in', 'customer', 'group-receipt', { senderJid: pn, senderJidAlt: lid })]),
      conversation('elsewhere', unknown, [message('wrong-channel', 'agent', 'shared-receipt')], { channelId: 'elsewhere' })
    ];
    for (const item of state.conversations) syncIncomingConversationContact(state, item, state.channels.find(channel => channel.id === item.channelId));
  });
  const gateway = new WhatsAppGateway(store, { authKey: Buffer.alloc(32, 61), socketFactory: config => {
    const socket = { config, ev: new EventEmitter(), user: { id: own + ':1@s.whatsapp.net' }, end() {}, async logout() {},
      async sendMessage() { assert.fail('No provider send belongs to a lookup test'); } };
    sockets.push(socket); return socket;
  } });
  await gateway.start(admin, tenant.id, 'wa');
  const socket = sockets[0]; socket.config.auth.creds.me = { id: own + ':1@s.whatsapp.net' };
  socket.ev.emit('creds.update', {}); socket.ev.emit('connection.update', { connection: 'open' }); await tick();
  const model = store.serviceReadModel;
  const prepare = store.db.prepare.bind(store.db), lookup = model.lookupConversationIds?.bind(model);
  t.after(async () => { store.db.prepare = prepare; if (lookup) model.lookupConversationIds = lookup; await gateway.close(); store.close(); });
  assert.equal(typeof model.lookupConversationIds, 'function', 'the real SQL lookup API must be integrated, not just the fallback');
  const calls = { scans: [], lookups: [] }; let allowLegacy = false;
  model.lookupConversationIds = input => { calls.lookups.push(structuredClone(input)); return lookup(input); };
  store.db.prepare = sql => {
    if (/json_each\(\s*t\.data\s*,\s*'\$\.conversations'\s*\)/.test(sql)) {
      calls.scans.push(sql.includes('GROUP BY') ? 'external' : 'address');
      assert.ok(allowLegacy, 'a proven lookup must not scan canonical conversations/messages');
    }
    return prepare(sql);
  };
  const state = () => store.tenant(admin, tenant.id), current = id => state().conversations.find(item => item.id === id);
  const change = callback => store.mutate(admin, tenant.id, 'Lookup fixture change', callback);
  const entry = gateway.entries.get('wa');
  const ids = (kind, values) => model.lookupConversationIds({ tenantId: tenant.id, workspaceId: admin.resellerId, channelId: 'wa', kind, values });
  const receive = (id, remoteJid = pn, extra = {}) => gateway.receive(entry, { key: { id, remoteJid, fromMe: false, ...extra }, message: { conversation: 'Synthetic question' }, messageTimestamp: seconds + 1 });
  const receipt = (key, status = ACK.READ) => socket.ev.emit('messages.update', [{ key, update: { status } }]);
  const audits = () => store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=? AND action=?').get(tenant.id, 'WhatsApp: recibo de mensagem').n;
  return { store, gateway, model, tenant, socket, entry, calls, state, current, change, ids, lookup, receive, receipt, audits, legacy: () => { allowLegacy = true; } };
}

test('address lookup keeps PN/LID aliases exact and chooses canonical position rather than lexical ID', async t => {
  const f = await fixture(t), second = structuredClone(f.current('a-second'));
  assert.deepEqual(f.ids('address', [lid, pn]), ['z-first', 'a-second']);
  assert.equal(f.gateway.incomingConversationRecord(f.entry, [lid]).id, 'z-first');
  assert.equal(f.gateway.incomingConversationRecord(f.entry, [device(pn)]), undefined, 'incoming address comparison remains raw, unlike receipt JIDs');
  await f.receive('indexed-input', lid, { remoteJidAlt: pn }); await f.receive('indexed-input', lid, { remoteJidAlt: pn });
  assert.equal(f.current('z-first').messages.filter(item => item.externalId === 'indexed-input').length, 1);
  assert.deepEqual(f.current('a-second'), second); assert.deepEqual(f.calls.scans, []);
  assert.ok(f.calls.lookups.some(input => input.kind === 'address' && input.workspaceId === admin.resellerId && input.tenantId === f.tenant.id && input.channelId === 'wa'));
});

test('proven empty address/external results are authoritative for an unknown reaction and ACK', async t => {
  const f = await fixture(t), before = f.state(), audits = f.audits();
  assert.deepEqual(f.ids('address', [unknown]), []); assert.deepEqual(f.ids('external', ['absent-provider-id']), []);
  await f.gateway.receive(f.entry, { key: { id: 'unknown-reaction', remoteJid: unknown, fromMe: false }, message: { reactionMessage: { text: '👍', key: { id: 'absent-provider-id' } } } });
  f.receipt({ id: 'absent-provider-id' });
  assert.deepEqual(f.state(), before); assert.equal(f.audits(), audits); assert.deepEqual(f.calls.scans, []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen WHERE message_id=?').get('unknown-reaction').n, 0);
});

test('external lookup returns every key-only ACK candidate without wa_seen, keeps channel and receipt filters', async t => {
  const f = await fixture(t), untouched = structuredClone(f.current('elsewhere'));
  assert.deepEqual(f.ids('external', ['shared-receipt']), ['z-first', 'a-second']);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen').get().n, 0, 'historical messages need not have dedupe receipts');
  f.receipt({ id: 'shared-receipt' });
  for (const id of ['z-first', 'a-second']) assert.equal(f.current(id).messages.find(item => item.externalId === 'shared-receipt').delivery, 'read');
  assert.deepEqual(f.current('elsewhere'), untouched);
  f.change(state => { for (const item of state.conversations) for (const message of item.messages) if (message.externalId === 'shared-receipt') message.delivery = 'pending'; });
  f.receipt({ id: 'shared-receipt', remoteJid: device(other), fromMe: true });
  assert.equal(f.current('a-second').messages[0].delivery, 'read'); assert.equal(f.current('z-first').messages.find(item => item.externalId === 'shared-receipt').delivery, 'pending');
  f.receipt({ id: 'other-transport', remoteJid: pn, fromMe: true });
  assert.equal(f.current('z-first').messages.find(item => item.externalId === 'other-transport').delivery, 'pending'); assert.deepEqual(f.calls.scans, []);
});

test('indexed ACK keeps direct read-self, normalized device/LID identities and group participant fences', async t => {
  const f = await fixture(t), before = f.current('z-first');
  f.receipt({ id: 'inbound-read', remoteJid: device(lid), fromMe: false });
  const read = f.current('z-first');
  assert.equal(read.messages.find(item => item.id === 'customer').delivery, 'read'); assert.equal(read.unread, 0); assert.equal(read.version, before.version); assert.ok(read.whatsappDeviceRead);
  const groupBefore = f.current('group');
  f.receipt({ id: 'group-receipt', remoteJid: group, fromMe: false, participant: other });
  assert.deepEqual(f.current('group'), groupBefore);
  f.receipt({ id: 'group-receipt', remoteJid: group, fromMe: false, participant: device(pn) });
  assert.equal(f.current('group').messages[0].delivery, 'read'); assert.equal(f.current('group').unread, groupBefore.unread); assert.equal(f.current('group').whatsappDeviceRead, undefined);
  f.change(state => { state.channels.find(channel => channel.id === 'wa').enabled = false; });
  f.receipt({ id: 'shared-receipt', remoteJid: pn, fromMe: true });
  assert.equal(f.current('z-first').messages.find(item => item.externalId === 'shared-receipt').delivery, 'pending'); assert.deepEqual(f.calls.scans, []);
});

test('null coverage preserves duplicate-ID lookup and receipt fallback for the second occurrence', async t => {
  const f = await fixture(t); f.legacy();
  f.change(state => state.conversations.push({ ...structuredClone(state.conversations[0]), remoteJid: unknown, remoteAliases: [], messages: [{ id: 'legacy-second', externalId: 'legacy-only', kind: 'agent', text: 'Synthetic legacy', transport: 'whatsapp', delivery: 'pending' }] }));
  assert.equal(f.ids('address', [unknown]), null); assert.equal(f.ids('external', ['legacy-only']), null);
  assert.equal(f.gateway.incomingConversationRecord(f.entry, [unknown]).id, 'z-first');
  f.receipt({ id: 'legacy-only', remoteJid: unknown, fromMe: true });
  assert.equal(f.state().conversations.find(item => item.remoteJid === unknown && item.channelId === 'wa').messages[0].delivery, 'read');
  assert.equal(f.current('z-first').messages.some(item => item.externalId === 'legacy-only'), false);
  assert.ok(f.calls.scans.includes('address')); assert.ok(f.calls.scans.includes('external')); assert.equal(f.audits(), 1);
});

test('legacy null IDs retain incoming reactions once when SQL coverage refuses the fast path', async t => {
  const f = await fixture(t); f.legacy(); f.change(state => { state.conversations[0].id = null; });
  assert.equal(f.ids('address', [pn]), null);
  const reaction = { key: { id: 'null-id-reaction', remoteJid: pn, fromMe: false }, message: { reactionMessage: { text: '👍', key: { id: 'inbound-read' } } } };
  await f.gateway.receive(f.entry, reaction); await f.gateway.receive(f.entry, reaction);
  assert.equal(f.state().conversations.find(item => item.remoteJid === pn).messages.filter(item => item.externalId === 'null-id-reaction').length, 1);
  assert.ok(f.calls.scans.includes('address'));
});

test('an older/missing lookup API uses the canonical query instead of treating absence as an empty inventory', async t => {
  const f = await fixture(t); f.legacy(); f.model.lookupConversationIds = undefined;
  assert.equal(f.gateway.incomingConversationRecord(f.entry, [pn]).id, 'z-first');
  f.receipt({ id: 'shared-receipt' });
  assert.equal(f.current('a-second').messages[0].delivery, 'read'); assert.ok(f.calls.scans.includes('address')); assert.ok(f.calls.scans.includes('external'));
});

test('a legacy raw canonical writer refreshes address and external lookups before the next handler call', async t => {
  const f = await fixture(t), { id, resellerId, ...data } = f.state(), newAlias = '123457@lid';
  const first = data.conversations.find(item => item.id === 'z-first');
  first.remoteAliases.push(newAlias); first.messages = first.messages.filter(item => item.externalId !== 'shared-receipt');
  first.messages.push({ id: 'raw-message', externalId: 'raw-provider', kind: 'human', transport: 'whatsapp', text: 'Synthetic legacy writer', delivery: 'pending' });
  f.store.db.prepare('UPDATE tenants SET data=? WHERE id=? AND reseller_id=?').run(JSON.stringify(data), id, resellerId);
  assert.deepEqual(f.ids('address', [newAlias]), ['z-first']); assert.deepEqual(f.ids('external', ['shared-receipt']), ['a-second']);
  f.receipt({ id: 'raw-provider', remoteJid: newAlias, fromMe: true });
  assert.equal(f.current('z-first').messages.find(item => item.id === 'raw-message').delivery, 'read'); assert.deepEqual(f.calls.scans, []);
});

test('removal after indexed discovery reconciles remaining current ACK candidates exactly once', async t => {
  const f = await fixture(t); let removed = false;
  f.model.lookupConversationIds = input => {
    const ids = f.lookup(input);
    if (!removed && input.kind === 'external' && input.values.includes('shared-receipt')) { removed = true; f.change(state => { state.conversations = state.conversations.filter(item => item.id !== 'z-first'); }); }
    return ids;
  };
  assert.doesNotThrow(() => f.receipt({ id: 'shared-receipt' }));
  assert.equal(removed, true); assert.equal(f.current('z-first'), undefined); assert.equal(f.current('a-second').messages[0].delivery, 'read');
  assert.equal(f.audits(), 1); assert.deepEqual(f.calls.scans, []);
});

test('failed indexed incoming transaction leaves wa_seen, canonical history and lookup keys unchanged before retry', async t => {
  const f = await fixture(t), mutate = f.store.mutateConversation.bind(f.store), before = f.current('z-first');
  assert.deepEqual(f.ids('external', ['rollback-indexed']), []);
  f.store.mutateConversation = (...args) => {
    if (args[3] === 'WhatsApp: mensagem recebida') { const callback = args[4]; args[4] = (conversation, metadata) => { callback(conversation, metadata); throw new Error('Synthetic indexed rollback'); }; }
    return mutate(...args);
  };
  await assert.rejects(f.receive('rollback-indexed'), /Synthetic indexed rollback/);
  assert.deepEqual(f.current('z-first'), before); assert.deepEqual(f.ids('external', ['rollback-indexed']), []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen WHERE message_id=?').get('rollback-indexed').n, 0);
  f.store.mutateConversation = mutate; await f.receive('rollback-indexed'); await f.receive('rollback-indexed');
  assert.deepEqual(f.ids('external', ['rollback-indexed']), ['z-first']); assert.equal(f.current('z-first').messages.filter(item => item.externalId === 'rollback-indexed').length, 1);
  assert.deepEqual(f.calls.scans, []);
});
