import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { TelegramGateway } from '../src/telegram.js';
import { AvatarService, AVATAR_MAX_BYTES, avatarImage, readAvatarResponse } from '../src/avatars.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Fixture avatar' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=', 'base64');
const peer = '5511988880000@s.whatsapp.net';
const token = '123456:' + 'T'.repeat(32); // Synthetic, never a real bot credential.
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = result => Response.json({ ok: true, result });

function fixture(t, fetchImpl = async () => new Response(png)) {
  const store = new Store(':memory:');
  const a = store.createTenant(actor, { name: 'Fotos A', segment: 'Fixture' });
  const b = store.createTenant(actor, { name: 'Fotos B', segment: 'Fixture' });
  for (const [tenant, prefix] of [[a, 'a'], [b, 'b']]) store.mutate(actor, tenant.id, 'Fixture: canais e conversas', state => {
    state.channels.push({ id: prefix + '-wa', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', expectedNumber: '5511999990000', allowedGroups: ['12000001@g.us'] }, { id: prefix + '-tg', kind: 'telegram', transport: 'telegram-bot', state: 'connected' });
    state.conversations.push({ id: prefix + '-conversation', channelId: prefix + '-wa', remoteJid: peer }, { id: prefix + '-telegram', channelId: prefix + '-tg', remoteChatId: '55555' }, { id: prefix + '-group', channelId: prefix + '-tg', remoteChatId: '-10055555' });
  });
  const gateway = new WhatsAppGateway(store, { fetchImpl });
  const telegram = new TelegramGateway(store, { fetchImpl, polling: false });
  for (const [tenant, prefix] of [[a, 'a'], [b, 'b']]) {
    gateway.entries.set(prefix + '-wa', { tenantId: tenant.id, channelId: prefix + '-wa', state: 'connected', matched: true, expectedNumber: '5511999990000', socket: { user: { id: '5511999990000:1@s.whatsapp.net' }, profilePictureUrl: async () => 'https://pps.whatsapp.net/v/avatar.png?provider=signed' } });
    telegram.entries.set(prefix + '-tg', { tenantId: tenant.id, channelId: prefix + '-tg', state: 'connected', stopped: false, botId: '123456', token, abort: new AbortController() });
  }
  t.after(() => store.close());
  return { store, gateway, telegram, a, b };
}

test('avatar raster infers MIME and rejects active formats, spoofed signatures and overlarge bytes', async () => {
  assert.equal(avatarImage(png).mime, 'image/png');
  assert.equal(avatarImage(Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==', 'base64')).mime, 'image/jpeg');
  assert.equal(avatarImage(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')).mime, 'image/webp');
  for (const bytes of [Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from('<html>image</html>'), png.subarray(0, 20), Buffer.alloc(AVATAR_MAX_BYTES + 1)]) assert.equal(avatarImage(bytes), null);
  const bigDimensions = Buffer.from(png); bigDimensions.writeUInt32BE(100000, 16);
  assert.equal(avatarImage(bigDimensions), null);
});

test('avatar response limits declared and streamed sizes and cancels excess body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(AVATAR_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  assert.equal(await readAvatarResponse(new Response(body)), null); assert.equal(cancelled, true);
  assert.equal(await readAvatarResponse(new Response(png, { headers: { 'content-length': String(AVATAR_MAX_BYTES + 1) } })), null);
  assert.equal(await readAvatarResponse(new Response(png, { status: 302 })), null);
  const redirected = new Response(png); Object.defineProperty(redirected, 'redirected', { value: true });
  assert.equal(await readAvatarResponse(redirected), null);
  const result = await readAvatarResponse(new Response(png, { headers: { 'content-type': 'text/html' } }));
  assert.equal(result.mime, 'image/png'); assert.deepEqual(result.bytes, png);
});

test('WhatsApp avatars reject SSRF, credentials, redirects and unexpected origins before download', async t => {
  let downloads = 0;
  const c = fixture(t, async (_, options) => { downloads++; assert.equal(options.redirect, 'error'); return new Response(png); });
  const socket = c.gateway.entries.get('a-wa').socket;
  for (const url of ['http://pps.whatsapp.net/avatar', 'https://127.0.0.1/avatar', 'https://pps.whatsapp.net.evil.test/avatar', 'https://user:password@pps.whatsapp.net/avatar', 'https://pps.whatsapp.net:444/avatar', 'https://mmg.whatsapp.net/avatar', 'https://pps.whatsapp.net/avatar#fragment', 'https://pps.whatsapp.net\\@evil.test/avatar']) {
    socket.profilePictureUrl = async () => url;
    assert.equal(await c.gateway.avatar(actor, c.a.id, 'a-wa', { peer }), null);
  }
  assert.equal(downloads, 0);
  socket.profilePictureUrl = async () => 'https://pps.whatsapp.net/avatar';
  const image = await c.gateway.avatar(actor, c.a.id, 'a-wa', { peer });
  assert.deepEqual(image.bytes, png); assert.equal(downloads, 1);
  assert.equal(await c.gateway.avatar(actor, c.a.id, 'b-wa', { peer }), null);
  assert.equal(downloads, 1);
});

test('WhatsApp photo captures require the same live socket and allowed group; channel resolves self', async t => {
  const c = fixture(t); let queried;
  const entry = c.gateway.entries.get('a-wa');
  entry.socket.profilePictureUrl = async jid => { queried = jid; return 'https://pps.whatsapp.net/avatar'; };
  assert.equal((await c.gateway.avatar(actor, c.a.id, 'a-wa')).mime, 'image/png');
  assert.equal(queried, '5511999990000@s.whatsapp.net');
  assert.equal(await c.gateway.avatar(actor, c.a.id, 'a-wa', { peer: '9999@g.us' }), null);
  entry.socket.profilePictureUrl = async () => { c.gateway.entries.set('a-wa', { ...entry }); return 'https://pps.whatsapp.net/avatar'; };
  assert.equal(await c.gateway.avatar(actor, c.a.id, 'a-wa', { peer }), null);
});

test('Telegram private/group/bot photos use fixed API, smallest preview and never return credentials', async t => {
  const calls = [];
  const c = fixture(t, async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.telegram.org'); assert.equal(options.redirect, 'error');
    if (url.includes('/file/')) { calls.push('download'); return new Response(png); }
    const method = url.split('/').at(-1), payload = JSON.parse(options.body); calls.push({ method, payload });
    if (method === 'getUserProfilePhotos') return json({ photos: [[{ file_id: 'large', width: 640, height: 640 }, { file_id: 'small', width: 160, height: 160 }]] });
    if (method === 'getChat') return json({ id: Number(payload.chat_id), photo: { small_file_id: 'group-small' } });
    if (method === 'getFile') return json({ file_path: 'photos/preview.png', file_size: png.length });
    throw Error('Unexpected method');
  });
  const service = new AvatarService(c.store, c);
  assert.deepEqual((await service.conversation(actor, c.a.id, 'a-telegram')).bytes, png);
  assert.equal(calls[0].method, 'getUserProfilePhotos'); assert.deepEqual(calls[0].payload, { user_id: 55555, limit: 1 });
  assert.equal(calls[1].payload.file_id, 'small');
  const group = await service.conversation(actor, c.a.id, 'a-group'); assert.equal(group.mime, 'image/png');
  assert.equal(calls[3].method, 'getChat'); assert.equal(calls[4].payload.file_id, 'group-small');
  const self = await service.channel(actor, c.a.id, 'a-tg'); assert.equal(self.mime, 'image/png');
  assert.equal(calls[6].payload.user_id, 123456);
  assert.deepEqual(Object.keys(self).sort(), ['bytes', 'mime']);
  assert.ok(!JSON.stringify([...service.cache.values()]).includes(token));
});

test('Telegram file traversal, external URLs, identity mismatch and overlarge metadata stop download', async t => {
  let file = { file_path: '../private.png' }, downloadCount = 0, mismatch = false;
  const c = fixture(t, async (url, options) => {
    if (url.includes('/file/')) { downloadCount++; return new Response(png); }
    const method = url.split('/').at(-1);
    if (method === 'getUserProfilePhotos') return json({ photos: [[{ file_id: 'small', width: 160, height: 160 }]] });
    if (method === 'getChat') return json({ id: mismatch ? -999 : Number(JSON.parse(options.body).chat_id), photo: { small_file_id: 'small' } });
    return json(file);
  });
  for (const file_path of ['../private.png', '/private.png', 'https://evil.test/private.png', 'photos/%2e%2e/private.png', 'photos/back\\slash.png']) {
    file = { file_path }; assert.equal(await c.telegram.avatar(actor, c.a.id, 'a-tg', { peer: '55555' }), null);
  }
  file = { file_path: 'photos/private.png', file_size: AVATAR_MAX_BYTES + 1 };
  assert.equal(await c.telegram.avatar(actor, c.a.id, 'a-tg', { peer: '55555' }), null);
  mismatch = true;
  assert.equal(await c.telegram.avatar(actor, c.a.id, 'a-tg', { peer: '-10055555' }), null);
  assert.equal(downloadCount, 0);
});

test('Telegram group photo cache follows selection and migration quarantine without using send permissions', async t => {
  const c = fixture(t); let requests = 0;
  c.telegram.avatar = async () => { requests++; return { bytes: png }; };
  const service = new AvatarService(c.store, { ...c });
  const configure = input => c.store.mutate(actor, c.a.id, 'Synthetic group policy', state => { state.channels.find(channel => channel.id === 'a-tg').telegramGroups = input; });
  configure({ mode: 'selected', groupIds: ['-10055555'], known: [{ id: '-10055555', joined: true, sendPermissions: { text: false, photos: false } }] });
  assert.deepEqual((await service.conversation(actor, c.a.id, 'a-group')).bytes, png); assert.equal(requests, 1);
  configure({ mode: 'selected', groupIds: [] });
  assert.equal(await service.conversation(actor, c.a.id, 'a-group'), null); assert.equal(requests, 1);
  configure({ mode: 'selected', groupIds: ['-10055555'], known: [{ id: '-10055555', joined: false }] });
  assert.equal(await service.conversation(actor, c.a.id, 'a-group'), null); assert.equal(requests, 1);
  configure({ mode: 'selected', groupIds: ['-10055555'], migrationConflicts: [{ fromGroupId: '-10055555', toGroupId: '-10099999' }] });
  assert.equal(await service.conversation(actor, c.a.id, 'a-group'), null); assert.equal(requests, 1);
  configure({ mode: 'all', groupIds: [] });
  assert.deepEqual((await service.conversation(actor, c.a.id, 'a-group')).bytes, png); assert.equal(requests, 1);
  assert.equal((await service.conversation(actor, c.a.id, 'a-telegram')).mime, 'image/png', 'Direct photos remain independent of group selection');
});

test('Telegram photo request loses selection during await and cannot cache or return raster', async t => {
  const c = fixture(t); let release;
  c.telegram.avatar = () => new Promise(resolve => { release = resolve; });
  const service = new AvatarService(c.store, { ...c });
  const pending = service.conversation(actor, c.a.id, 'a-group'); await tick();
  c.store.mutate(actor, c.a.id, 'Synthetic deselection', state => { state.channels.find(channel => channel.id === 'a-tg').telegramGroups = { mode: 'selected', groupIds: [] }; });
  release({ bytes: png }); assert.equal(await pending, null); assert.equal(service.cacheBytes, 0); assert.equal(service.cache.size, 0);
});

test('avatar cache coalesces requests, expires positives and negatives and returns defensive copies', async t => {
  const c = fixture(t); let clock = 100, queries = 0, release;
  c.gateway.avatar = async () => { queries++; await new Promise(resolve => { release = resolve; }); return { bytes: png, mime: 'image/png' }; };
  const service = new AvatarService(c.store, { ...c, now: () => clock, positiveTtlMs: 20, negativeTtlMs: 10 });
  const one = service.conversation(actor, c.a.id, 'a-conversation'), two = service.conversation(actor, c.a.id, 'a-conversation');
  await tick(); assert.equal(queries, 1); release();
  const [a, b] = await Promise.all([one, two]); a.bytes[0] = 0;
  assert.deepEqual(b.bytes, png); assert.deepEqual((await service.conversation(actor, c.a.id, 'a-conversation')).bytes, png);
  clock += 21; c.gateway.avatar = async () => { queries++; return null; };
  assert.equal(await service.conversation(actor, c.a.id, 'a-conversation'), null); assert.equal(queries, 2);
  assert.equal(await service.conversation(actor, c.a.id, 'a-conversation'), null); assert.equal(queries, 2);
  clock += 11; assert.equal(await service.conversation(actor, c.a.id, 'a-conversation'), null); assert.equal(queries, 3);
  assert.equal(service.pendingCount, 0);
});

test('avatar cache isolates tenant/channel/peer and never fetches an unauthorized or disconnected identity', async t => {
  const c = fixture(t); let queries = 0;
  c.gateway.avatar = async () => { queries++; return { bytes: png }; };
  const service = new AvatarService(c.store, c);
  assert.ok(await service.conversation(actor, c.a.id, 'a-conversation'));
  assert.ok(await service.conversation(actor, c.b.id, 'b-conversation')); assert.equal(queries, 2);
  assert.equal(await service.conversation(actor, c.a.id, 'b-conversation'), null);
  assert.equal(await service.conversation({ ...actor, resellerId: 'foreign' }, c.a.id, 'a-conversation'), null);
  c.gateway.entries.get('a-wa').state = 'disconnected';
  assert.equal(await service.conversation(actor, c.a.id, 'a-conversation'), null); assert.equal(queries, 2);
  c.gateway.entries.get('a-wa').state = 'connected'; c.gateway.entries.get('a-wa').tenantId = c.b.id;
  assert.equal(await service.conversation(actor, c.a.id, 'a-conversation'), null); assert.equal(queries, 2);
});

test('avatar cache LRU bounds entries and byte budget without mutating persisted business state', async t => {
  const c = fixture(t); let queries = 0;
  c.gateway.avatar = async () => { queries++; return { bytes: png }; };
  const before = c.store.tenant(actor, c.a.id);
  const service = new AvatarService(c.store, { ...c, maxEntries: 1, maxCacheBytes: png.length });
  await service.conversation(actor, c.a.id, 'a-conversation'); await service.conversation(actor, c.b.id, 'b-conversation');
  assert.equal(service.cache.size, 1); assert.equal(service.cacheBytes, png.length);
  await service.conversation(actor, c.a.id, 'a-conversation'); assert.equal(queries, 3);
  assert.deepEqual(c.store.tenant(actor, c.a.id), before);
  const small = new AvatarService(c.store, { ...c, maxCacheBytes: png.length - 1 });
  assert.ok(await small.channel(actor, c.a.id, 'a-wa')); assert.equal(small.cache.size, 0); assert.equal(small.cacheBytes, 0);
});

test('avatar pending cap and deadline release capacity while provider failures become negative cache', async t => {
  const c = fixture(t); let queries = 0;
  c.gateway.avatar = async () => { queries++; return new Promise(() => {}); };
  const service = new AvatarService(c.store, { ...c, maxPending: 1, timeoutMs: 15 });
  // Start both requests in the same turn; yielding allowed the 15ms deadline to
  // expire under parallel CPU load before the capacity assertion ran.
  const slow = service.conversation(actor, c.a.id, 'a-conversation');
  assert.equal(await service.conversation(actor, c.b.id, 'b-conversation'), null); assert.equal(queries, 1);
  assert.equal(await slow, null); assert.equal(service.pendingCount, 0); assert.equal(service.pending.size, 0);
  assert.equal(await service.conversation(actor, c.a.id, 'a-conversation'), null); assert.equal(queries, 1);
  c.gateway.avatar = async () => { throw Error('Private provider detail'); };
  assert.equal(await service.conversation(actor, c.b.id, 'b-conversation'), null);
});
