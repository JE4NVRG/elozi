import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { proto } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { GroupHistoryImporter, providerHistoryCursor } from '../src/group-history-import.js';

const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;
const JID = '12000001@g.us', SECOND = '12000002@g.us', NOW = Date.parse('2026-10-05T12:00:00Z'), SEC = NOW / 1000;
const status = expected => error => error.status === expected;
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const raw = (id, timestamp = SEC - 10, extra = {}) => ({ key: { remoteJid: JID, id, fromMe: false, participant: '551199000001@s.whatsapp.net' }, messageTimestamp: timestamp, pushName: 'Pessoa observada', message: { conversation: `Texto ${id}` }, ...extra });

function fixture(t, options = {}) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'history-admin', name: 'Admin sintético' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo'));
  const a = store.createTenant(admin, { name: 'Histórico A', segment: 'QA' }), b = store.createTenant(admin, { name: 'Histórico B', segment: 'QA' });
  const operations = new Operations(store, auth), requests = [], entries = new Map();
  // Existing gateway-owned receipt schema; the importer must not provision any table.
  store.db.exec('CREATE TABLE wa_seen (channel_id TEXT NOT NULL,remote_jid TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_jid,message_id))');
  for (const [tenant, channelId] of [[a, 'wa-a'], [b, 'wa-b']]) {
    store.mutate(admin, tenant.id, 'Fixture histórica RAM', current => {
      current.channels = [{ id: channelId, name: 'WhatsApp sintético', kind: 'whatsapp_qr', transport: 'baileys', enabled: true, allowedGroups: [JID, SECOND], groupNames: { [JID]: 'Grupo escolhido', [SECOND]: 'Outro grupo escolhido' } }];
      current.contacts = [{ id: 'contact-preserved', name: 'Contato anterior' }];
      current.conversations = [{ id: 'group', channelId, remoteJid: JID, conversationKind: 'group', version: 4, owner: 'human', assignedUserId: admin.userId, assignedUserName: 'Admin sintético', status: 'closed', unread: 3,
        updatedAt: new Date(NOW - 1000).toISOString(), tags: ['Preservada'], participants: [{ userId: admin.userId }], messages: [
          { id: 'local-preserved', externalId: 'EXISTING', kind: 'customer', text: 'Texto anterior intacto', createdAt: new Date(NOW - 100000).toISOString() },
          { id: 'private-note', kind: 'internal', text: 'Nota privada intacta', createdAt: new Date(NOW - 99000).toISOString() },
          { id: 'local-recent', externalId: 'RECENT', kind: 'human', text: 'Envio anterior intacto', createdAt: new Date(NOW - 1000).toISOString(), authorUserId: admin.userId }
        ] }, { id: 'second-group', channelId, remoteJid: SECOND, conversationKind: 'group', version: 1, owner: 'queue', unread: 0, messages: [] },
        { id: 'direct', channelId, remoteJid: '551199000001@s.whatsapp.net', conversationKind: 'direct', version: 1, messages: [] }];
    });
    const entry = { tenantId: tenant.id, channelId, generation: 1, state: 'connected', matched: true, groupCache: new Map(), historyCursors: new Map([[JID, providerHistoryCursor(raw('ANCHOR', SEC))], [SECOND, providerHistoryCursor(raw('SECOND_ANCHOR', SEC, { key: { remoteJid: SECOND, id: 'SECOND_ANCHOR', fromMe: true } }))]]) };
    entry.socket = { fetchMessageHistory: async (count, key, timestamp) => { const id = `SESSION_${requests.length + 1}`; requests.push({ id, channelId, count, key: structuredClone(key), timestamp }); return id; } };
    entries.set(channelId, entry);
  }
  const authorize = (actor, tenantId, conversation) => {
    auth.admin(actor); store.admin(actor);
    const context = { tenantId, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' };
    operations.permission(actor, 'inbox.read', context); return true;
  };
  const settings = { authorize, resolveConnection: (_actor, _tenantId, channelId) => entries.get(channelId), resolveCursor: (entry, context) => entry.historyCursors.get(context.groupId), onCursor: (entry, groupId, cursor) => entry.historyCursors.set(groupId, cursor), now: () => NOW, ...options };
  const importer = new GroupHistoryImporter(store, settings);
  t.after(() => { importer.close(); store.close(); });
  const input = (extra = {}) => ({ version: 4, limit: 50, commandId: randomUUID(), ...extra });
  const current = (tenant = a) => store.tenant(admin, tenant.id);
  const mutate = fn => store.mutate(admin, a.id, 'Mudança sintética', fn);
  const event = (messages, extra = {}) => ({ syncType: ON_DEMAND, peerDataRequestSessionId: requests.at(-1)?.id, messages, ...extra });
  return { store, auth, admin, a, b, importer, entries, entry: entries.get('wa-a'), requests, input, current, mutate, event, settings, authorize };
}

test('cursor exige WebMessageInfo real e conserva segundos originais, inclusive Long/BigInt, sem copiar segredos', () => {
  const native = raw('REAL_KEY', SEC, { messageTimestamp: { toString: () => String(SEC) }, url: 'secret-url', message: { conversation: 'Privado' } });
  const value = providerHistoryCursor(native);
  assert.deepEqual(value, { key: { remoteJid: JID, id: 'REAL_KEY', fromMe: false }, timestampSeconds: SEC, timestampMs: NOW });
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.key), true);
  assert.equal(providerHistoryCursor(raw('BIGINT', BigInt(SEC))).timestampSeconds, SEC);
  assert.equal(providerHistoryCursor(raw('DATE_OVERFLOW', 8640000000001)), null);
  assert.equal(providerHistoryCursor(raw('UNSAFE', Number.MAX_SAFE_INTEGER)), null);
  for (const invalid of [null, {}, { externalId: 'REAL_KEY', createdAt: new Date(NOW).toISOString() }, raw('X', 0), raw('X', -1), raw('X', NaN), raw('X', Infinity), raw('X', SEC + .1), raw('X', { toString() { throw Error('não é timestamp'); } }), raw('X', SEC, { key: { remoteJid: JID, id: 'X' } }), raw('X', SEC, { key: { remoteJid: '5511@s.whatsapp.net', id: 'X', fromMe: false } })]) assert.equal(providerHistoryCursor(invalid), null);
  assert.doesNotMatch(JSON.stringify(value), /Privado|secret|participant/);
});

test('histórico local não fabrica âncora nem inicia jobs; metadados reais privados não aparecem no DTO', async t => {
  const f = fixture(t); f.entry.historyCursors.clear();
  assert.equal(f.importer.status(f.admin, f.a.id, 'group').state, 'need_anchor');
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(409)); assert.equal(f.requests.length, 0); assert.equal(f.importer.jobs.size, 0);
  f.entry.historyCursors.set(JID, { key: { remoteJid: JID, id: 'FORGED', fromMe: false }, timestampSeconds: SEC, timestampMs: SEC });
  assert.equal(f.importer.status(f.admin, f.a.id, 'group').anchor.available, false);
  f.entry.historyCursors.set(JID, providerHistoryCursor(raw('WRONG_UNIT', NOW)));
  assert.equal(f.importer.status(f.admin, f.a.id, 'group').anchor.available, false);
  f.entry.historyCursors.set(JID, providerHistoryCursor(raw('REAL_ANCHOR', SEC)));
  const result = await f.importer.start(f.admin, f.a.id, 'group', f.input());
  assert.equal(result.state, 'pending'); assert.equal(result.anchor.available, true); assert.equal(f.requests[0].timestamp, SEC);
  assert.deepEqual(f.requests[0].key, { remoteJid: JID, id: 'REAL_ANCHOR', fromMe: false });
  assert.doesNotMatch(JSON.stringify(result), /REAL_ANCHOR|SESSION_|remoteJid|timestamp|socket|messageTimestamp/);
});

test('autorização humana fresca é obrigatória e serviço/suporte/operador não disparam request', async t => {
  const f = fixture(t), before = f.current();
  for (const actor of [{ ...f.admin, kind: 'service' }, { ...f.admin, supportGrantId: 'grant' }, { ...f.admin, role: 'operator' }, { ...f.admin, userId: 'missing' }, { ...f.admin, resellerId: 'other-workspace' }]) {
    await assert.rejects(f.importer.start(actor, f.a.id, 'group', f.input()), error => [403, 404].includes(error.status));
  }
  f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(NOW, f.admin.userId);
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(403));
  assert.equal(f.requests.length, 0); assert.deepEqual(f.current(), before);
});

test('canal, empresa, grupo conhecido e seleção são validados antes de qualquer request', async t => {
  const f = fixture(t);
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'direct', f.input({ version: 1 })), status(409));
  f.mutate(tenant => { tenant.channels[0].allowedGroups = []; });
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(409));
  f.mutate(tenant => { tenant.channels[0].allowedGroups = [JID]; tenant.channels[0].groupNames = {}; });
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(409));
  f.entry.groupCache.set(JID, { id: JID }); f.entry.tenantId = f.b.id;
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(409));
  f.entry.tenantId = f.a.id; f.entry.matched = false;
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(409));
  assert.equal(f.requests.length, 0);
});

test('CAS, campos desconhecidos e limites recusam entrada; validações assíncronas falham fechadas', async t => {
  const f = fixture(t);
  for (const input of [f.input({ version: 3 }), f.input({ version: NaN }), f.input({ limit: 201 }), f.input({ limit: 0 }), f.input({ commandId: 'not-uuid' }), f.input({ groupId: JID })]) await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', input), error => [400, 409].includes(error.status));
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input(), { reauthorize: async () => { throw Error('rejeição privada'); } }), status(500));
  f.importer.authorize = async () => true;
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(500));
  f.importer.authorize = () => undefined;
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(403));
  await delay(0); assert.equal(f.requests.length, 0);
});

test('commandId reconcilia POST incerto e retorno final, sem repetir pedido nem mudar contexto/conteúdo', async t => {
  const f = fixture(t), input = f.input(), first = await f.importer.start(f.admin, f.a.id, 'group', input);
  assert.deepEqual(await f.importer.start(f.admin, f.a.id, 'group', input), first);
  assert.deepEqual(f.importer.status(f.admin, f.a.id, 'group', { commandId: input.commandId }), first);
  for (const changed of [{ ...input, limit: 100 }, { ...input, version: 5 }]) await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', changed), status(409));
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'second-group', { ...input, version: 1 }), status(409));
  assert.throws(() => f.importer.status(f.admin, f.a.id, 'second-group', { commandId: input.commandId }), status(403));
  const final = await f.importer.receive(f.entry, f.event([raw('OLD', SEC - 120)]));
  assert.equal(final.state, 'completed'); assert.equal(final.version, 5); assert.deepEqual(await f.importer.start(f.admin, f.a.id, 'group', input), final); assert.equal(f.requests.length, 1);
  assert.equal(await f.importer.receive(f.entry, f.event([raw('OLD', SEC - 120)])), false);
});

test('uma importação por conexão e duas empresas ficam independentes mesmo com mesmo grupo e native ID', async t => {
  const f = fixture(t);
  const a = await f.importer.start(f.admin, f.a.id, 'group', f.input());
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'second-group', f.input({ version: 1 })), status(409));
  const b = await f.importer.start(f.admin, f.b.id, 'group', f.input()); assert.notEqual(a.job.id, b.job.id); assert.equal(f.requests.length, 2);
  const first = { syncType: ON_DEMAND, peerDataRequestSessionId: f.requests[0].id, messages: [raw('SAME_NATIVE_ID', SEC - 120)] }, second = { ...first, peerDataRequestSessionId: f.requests[1].id };
  assert.equal(await f.importer.receive(f.entries.get('wa-b'), first), false);
  await f.importer.receive(f.entry, first); await f.importer.receive(f.entries.get('wa-b'), second);
  assert.equal(f.current().conversations[0].messages.filter(m => m.externalId === 'SAME_NATIVE_ID').length, 1);
  assert.equal(f.current(f.b).conversations[0].messages.filter(m => m.externalId === 'SAME_NATIVE_ID').length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen WHERE message_id=?').get('SAME_NATIVE_ID').count, 2);
});

test('importação ordena cronologia e preserva históricos anteriores, unread, atribuição e estado fechado', async t => {
  const f = fixture(t), before = f.current(), original = before.conversations[0];
  f.store.db.prepare('INSERT INTO wa_seen VALUES (?,?,?)').run('wa-a', JID, 'RECEIPT_ONLY');
  await f.importer.start(f.admin, f.a.id, 'group', f.input());
  const result = await f.importer.receive(f.entry, f.event([raw('OWN', SEC - 80, { key: { remoteJid: JID, id: 'OWN', fromMe: true } }), raw('EARLIEST', SEC - 120), raw('EXISTING', SEC - 100), raw('RECEIPT_ONLY', SEC - 90), raw('EARLIEST', SEC - 120)]));
  assert.deepEqual(result.job.counters, { imported: 2, duplicates: 3, excluded: 0, requested: 50 });
  const after = f.current(), conversation = after.conversations[0];
  assert.deepEqual(conversation.messages.filter(m => !m.imported), original.messages); assert.equal(conversation.version, 5);
  assert.deepEqual({ ...conversation, messages: original.messages, version: original.version }, original);
  assert.deepEqual(after.contacts, before.contacts); assert.deepEqual(after.channels, before.channels); assert.deepEqual(after.conversations.slice(1), before.conversations.slice(1));
  assert.deepEqual(conversation.messages.map(m => m.externalId || m.id), ['EARLIEST', 'EXISTING', 'private-note', 'OWN', 'RECENT']);
  const own = conversation.messages.find(m => m.externalId === 'OWN'); assert.equal(own.kind, 'human'); assert.equal(own.delivery, 'sent'); assert.equal(own.createdAt, new Date((SEC - 80) * 1000).toISOString());
  assert.equal(own.authorUserId, undefined); assert.equal(own.imported, true); assert.equal(own.historySource, 'whatsapp-on-demand');
  assert.equal(f.entry.historyCursors.get(JID).key.id, 'EARLIEST');
});

test('mídia histórica registra somente metadados indisponíveis; conteúdo efêmero/privado e outros grupos são excluídos', async t => {
  const f = fixture(t), tables = f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  await f.importer.start(f.admin, f.a.id, 'group', f.input());
  const image = raw('IMAGE', SEC - 120, { message: { imageMessage: { caption: 'Foto antiga', mimetype: 'image/jpeg', fileLength: { toString: () => '1024' }, url: 'https://private.invalid', directPath: '/private', mediaKey: Buffer.from('secret-media'), jpegThumbnail: Buffer.from('private-thumb') } } });
  const document = raw('DOC', SEC - 130, { message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'Documento antigo', fileName: 'antigo.pdf', mimetype: 'application/pdf', fileLength: 200 } } } } });
  const excluded = [raw('EPHEMERAL', SEC - 140, { message: { ephemeralMessage: { message: { conversation: 'Privado efêmero' } } } }), raw('ONCE', SEC - 150, { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'Privado uma vez' } } } } }), raw('EXPIRING', SEC - 150, { message: { extendedTextMessage: { text: 'Privado expirável', contextInfo: { expiration: 100 } } } }), raw('EXPIRING_DOC', SEC - 150, { message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'Privado anexo', contextInfo: { expiration: 10 } } } } } }), raw('WRONG_GROUP', SEC - 180, { key: { remoteJid: SECOND, id: 'WRONG_GROUP', fromMe: false } }), raw('NEWER', SEC + 1), raw('PROTOCOL', SEC - 160, { message: { protocolMessage: { type: 1 } } }), raw('NO_TIMESTAMP', null)];
  const result = await f.importer.receive(f.entry, f.event([image, document, ...excluded]));
  assert.deepEqual(result.job.counters, { imported: 2, duplicates: 0, excluded: 8, requested: 50 });
  const imported = f.current().conversations[0].messages.filter(m => m.imported);
  assert.equal(imported.length, 2); assert.ok(imported.every(m => m.attachments[0].status === 'unavailable' && m.attachments[0].preview === false && m.attachments[0].reason === 'historical_not_downloaded'));
  assert.equal(imported.find(m => m.externalId === 'IMAGE').attachments[0].size, 1024);
  assert.doesNotMatch(JSON.stringify(imported), /private.invalid|directPath|secret-media|private-thumb|mediaKey|messageTimestamp|Privado/);
  assert.deepEqual(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen').get().count, 2);
});

test('paginação é limitada a50/página e200 no total; cursor permanece real e texto extenso é marcado', async t => {
  const f = fixture(t), input = f.input({ limit: 200 }); await f.importer.start(f.admin, f.a.id, 'group', input);
  for (let page = 0; page < 4; page++) {
    const messages = Array.from({ length: 50 }, (_, i) => raw(`PAGE_${page}_${i}`, SEC - 200 - page * 100 - i, i === 0 && page === 0 ? { message: { conversation: 'x'.repeat(4100) } } : {}));
    const result = await f.importer.receive(f.entry, f.event(messages)); assert.equal(result.state, page < 3 ? 'pending' : 'completed');
    assert.ok(Object.values(result.job.counters).every(n => Number.isInteger(n) && n >= 0 && n <= 200));
  }
  assert.deepEqual(f.requests.map(r => r.count), [50, 50, 50, 50]); assert.equal(f.requests[1].key.id, 'PAGE_0_49'); assert.equal(f.requests[1].timestamp, SEC - 249);
  const final = f.importer.status(f.admin, f.a.id, 'group', { commandId: input.commandId }); assert.deepEqual(final.job.counters, { imported: 200, duplicates: 0, excluded: 0, requested: 200 });
  const message = f.current().conversations[0].messages.find(m => m.externalId === 'PAGE_0_0'); assert.equal(message.text.length, 4000); assert.equal(message.textTruncated, true);
  assert.equal(f.current().conversations[0].version, 8); assert.equal(f.current().conversations[0].unread, 3); assert.equal(f.importer.active.size, 0);
});

test('IDs distintos no mesmo segundo ainda permitem paginação, sem inferir timestamps ou gerar cursor vazio', async t => {
  const f = fixture(t); await f.importer.start(f.admin, f.a.id, 'group', f.input({ limit: 100 }));
  await f.importer.receive(f.entry, f.event(Array.from({ length: 50 }, (_, i) => raw(`SAME_SECOND_${i}`, SEC))));
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].timestamp, SEC); assert.notEqual(f.requests[1].key.id, 'ANCHOR');
  await f.importer.receive(f.entry, f.event([])); assert.equal(f.importer.status(f.admin, f.a.id, 'group').state, 'completed');
});

test('chunks fora de ordem e repetidos são correlacionados; não há escrita antes de completar a página', async t => {
  const f = fixture(t), before = f.current(); await f.importer.start(f.admin, f.a.id, 'group', f.input());
  const last = f.event([raw('CHUNK_1', SEC - 120)], { chunkOrder: 1, progress: 100 });
  assert.equal((await f.importer.receive(f.entry, last)).state, 'pending'); assert.deepEqual(f.current(), before);
  await f.importer.receive(f.entry, last); assert.deepEqual(f.current(), before);
  const result = await f.importer.receive(f.entry, f.event([raw('CHUNK_0', SEC - 110)], { chunkOrder: 0, progress: 50 }));
  assert.equal(result.state, 'completed'); assert.deepEqual(result.job.counters, { imported: 2, duplicates: 0, excluded: 0, requested: 50 });
  assert.deepEqual(f.current().conversations[0].messages.filter(m => m.imported).map(m => m.externalId), ['CHUNK_1', 'CHUNK_0']);
});

for (const invalid of ['page-size', 'aggregate-size', 'changed-chunk', 'bad-sequence']) test(`página inválida (${invalid}) falha sem importar conteúdo nem recibos`, async t => {
  const f = fixture(t), before = f.current(); await f.importer.start(f.admin, f.a.id, 'group', f.input());
  let event;
  if (invalid === 'page-size') event = f.event(Array.from({ length: 51 }, (_, i) => raw(`OVER_${i}`)));
  if (invalid === 'aggregate-size') { await f.importer.receive(f.entry, f.event(Array.from({ length: 30 }, (_, i) => raw(`FIRST_${i}`)), { progress: 50, chunkOrder: 0 })); event = f.event(Array.from({ length: 21 }, (_, i) => raw(`LAST_${i}`)), { progress: 100, chunkOrder: 1 }); }
  if (invalid === 'changed-chunk') { await f.importer.receive(f.entry, f.event([raw('SAME_CHUNK')], { progress: 50, chunkOrder: 0 })); event = f.event([raw('CHANGED_CHUNK')], { progress: 50, chunkOrder: 0 }); }
  if (invalid === 'bad-sequence') event = f.event([raw('INVALID')], { chunkOrder: -1 });
  await assert.rejects(f.importer.receive(f.entry, event), status(502)); assert.equal(f.importer.status(f.admin, f.a.id, 'group').state, 'failed');
  assert.deepEqual(f.current(), before); assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen').get().count, 0);
});

test('bootstrap, sessão ausente/errada e entrada de outra geração não abrem recepção', async t => {
  const f = fixture(t), before = f.current(); await f.importer.start(f.admin, f.a.id, 'group', f.input());
  for (const event of [f.event([raw('BOOTSTRAP')], { syncType: proto.HistorySync.HistorySyncType.FULL }), f.event([raw('WRONG_SESSION')], { peerDataRequestSessionId: 'other-session' }), f.event([raw('NO_SESSION')], { peerDataRequestSessionId: null })]) assert.equal(await f.importer.receive(f.entry, event), false);
  assert.equal(await f.importer.receive({ ...f.entry }, f.event([raw('WRONG_ENTRY')])), false);
  f.entry.generation++; assert.equal(await f.importer.receive(f.entry, f.event([raw('STALE_GENERATION')])), false);
  assert.equal(f.importer.status(f.admin, f.a.id, 'group').state, 'cancelled'); assert.deepEqual(f.current(), before);
});

for (const change of ['selection', 'user', 'authority', 'generation', 'session']) test(`revogação ${change} durante await do pedido impede ingestão e libera a conexão`, async t => {
  const pending = deferred(), f = fixture(t, { requestHistory: () => pending.promise }), input = f.input();
  let session = true; const start = f.importer.start(f.admin, f.a.id, 'group', input, { reauthorize: () => session });
  // Flush the provider request; no real socket or external request exists.
  await delay(0);
  if (change === 'selection') f.mutate(state => { state.channels[0].allowedGroups = []; });
  if (change === 'user') f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(NOW, f.admin.userId);
  if (change === 'authority') f.admin.resellerId = 'changed-workspace';
  if (change === 'generation') f.entry.generation++;
  if (change === 'session') session = false;
  const rejection = assert.rejects(start, error => [403, 409].includes(error.status)); pending.resolve('REAL_SESSION'); await rejection;
  assert.equal(f.importer.active.size, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen').get().count, 0);
  assert.ok([...f.importer.jobs.values()].every(job => job.state === 'cancelled'));
});

test('revogação depois do pedido e antes da página preserva histórico e bloqueia leitura do job', async t => {
  const f = fixture(t), before = f.current(); await f.importer.start(f.admin, f.a.id, 'group', f.input());
  f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(NOW, f.admin.userId);
  assert.equal(await f.importer.receive(f.entry, f.event([raw('DENIED')])), false);
  assert.throws(() => f.importer.status(f.admin, f.a.id, 'group'), status(403)); assert.deepEqual(f.current(), before); assert.equal(f.importer.active.size, 0);
});

test('autorização revalidada dentro da transação faz rollback antes de importar e gravar wa_seen', async t => {
  const f = fixture(t), before = f.current(); await f.importer.start(f.admin, f.a.id, 'group', f.input());
  const mutate = f.store.mutate.bind(f.store); let denied = false;
  f.importer.authorize = (...args) => denied ? false : f.authorize(...args);
  f.store.mutate = (...args) => { denied = true; return mutate(...args); };
  await assert.rejects(f.importer.receive(f.entry, f.event([raw('TRANSACTION_DENIED')])), status(403));
  f.store.mutate = mutate; assert.deepEqual(f.current(), before); assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen').get().count, 0);
});

test('timeout de resposta e chunk incompleto terminam unavailable e replay não inicia outra solicitação', async t => {
  const f = fixture(t, { timeoutMs: 12 }), input = f.input(); await f.importer.start(f.admin, f.a.id, 'group', input);
  await f.importer.receive(f.entry, f.event([raw('INCOMPLETE')], { chunkOrder: 0, progress: 50 })); await delay(30);
  const result = f.importer.status(f.admin, f.a.id, 'group', { commandId: input.commandId }); assert.equal(result.state, 'unavailable'); assert.equal(result.job.counters.imported, 0);
  assert.deepEqual(await f.importer.start(f.admin, f.a.id, 'group', input), result); assert.equal(f.requests.length, 1);
  assert.equal(await f.importer.receive(f.entry, f.event([raw('LATE')], { chunkOrder: 1, progress: 100 })), false);
  assert.equal(f.current().conversations[0].messages.some(m => m.imported), false);
});

test('timeout enquanto socket aguarda e abort/close interrompem start sem aguardar provider tardio', async t => {
  const pending = deferred(), f = fixture(t, { timeoutMs: 10, requestHistory: () => pending.promise }), input = f.input();
  const rejection = assert.rejects(f.importer.start(f.admin, f.a.id, 'group', input), status(504)); await delay(25); await rejection;
  assert.equal(f.importer.status(f.admin, f.a.id, 'group', { commandId: input.commandId }).state, 'unavailable'); pending.resolve('TOO_LATE'); await delay(0); assert.equal(f.importer.active.size, 0);
  const next = deferred(), signal = new AbortController(); f.importer.requestHistory = () => next.promise;
  const aborted = assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input(), { signal: signal.signal }), status(409)); await delay(0); signal.abort(); await aborted;
  const closed = assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(409)); await delay(0); f.importer.close(); await closed;
  next.reject(Error('late private provider rejection')); await delay(0); assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen').get().count, 0);
});

test('erro ou pedido não confirmado não expõe provider details, não é reenviado e cancelamento é explícito', async t => {
  const f = fixture(t, { requestHistory: () => { throw Error('secret provider credential'); } }), input = f.input();
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', input), error => error.status === 502 && !error.message.includes('secret'));
  assert.equal((await f.importer.start(f.admin, f.a.id, 'group', input)).state, 'failed');
  f.importer.requestHistory = () => null;
  await assert.rejects(f.importer.start(f.admin, f.a.id, 'group', f.input()), status(502));
  f.importer.requestHistory = ({ entry, count, cursor }) => entry.socket.fetchMessageHistory(count, cursor.key, cursor.timestampSeconds);
  const cancel = f.input(); await f.importer.start(f.admin, f.a.id, 'group', cancel);
  assert.equal(f.importer.cancel(f.admin, f.a.id, 'group', cancel.commandId).state, 'cancelled');
  assert.throws(() => f.importer.cancel(f.admin, f.a.id, 'group', undefined), status(400));
  assert.equal(await f.importer.receive(f.entry, f.event([raw('CANCELLED')])), false);
});

test('falha após commit e novo importador conservam efeito único com recibo e externalId persistidos', async t => {
  const f = fixture(t, { onCursor: () => { throw Error('private settle detail'); } }), input = f.input(); await f.importer.start(f.admin, f.a.id, 'group', input);
  await assert.rejects(f.importer.receive(f.entry, f.event([raw('COMMITTED', SEC - 120)])), error => error.status === 502 && !error.message.includes('private'));
  assert.equal(f.current().conversations[0].messages.filter(m => m.externalId === 'COMMITTED').length, 1);
  assert.equal((await f.importer.start(f.admin, f.a.id, 'group', input)).job.counters.imported, 1); assert.equal(f.requests.length, 1);
  f.importer.close(); const restarted = new GroupHistoryImporter(f.store, { ...f.settings, onCursor: () => {} }); t.after(() => restarted.close());
  const version = f.current().conversations[0].version;
  await restarted.start(f.admin, f.a.id, 'group', f.input({ version }));
  const result = await restarted.receive(f.entry, f.event([raw('COMMITTED', SEC - 120), raw('EXISTING', SEC - 100)]));
  assert.deepEqual(result.job.counters, { imported: 0, duplicates: 2, excluded: 0, requested: 50 });
  assert.equal(f.current().conversations[0].version, version); assert.equal(f.current().conversations[0].messages.filter(m => m.externalId === 'COMMITTED').length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen').get().count, 1);
});

test('adaptação explícita de unidade mantém timestamp original privado, sem adivinhar pelo nome SDK', async t => {
  const captures = [], f = fixture(t, { requestHistory: ({ cursor, count }) => { captures.push({ seconds: cursor.timestampSeconds, sdkMs: cursor.timestampMs, count }); return 'EXPLICIT_ADAPTER'; } });
  const result = await f.importer.start(f.admin, f.a.id, 'group', f.input());
  assert.deepEqual(captures, [{ seconds: SEC, sdkMs: NOW, count: 50 }]); assert.equal(result.state, 'pending');
  assert.doesNotMatch(JSON.stringify(result), /timestampSeconds|timestampMs|EXPLICIT_ADAPTER/);
});
