import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { MediaService } from '../src/media.js';
import { createLocalBackup, validateBackup } from '../src/backup.js';
import { PostgresBridge } from '../src/postgres-bridge.js';
import { OwnLines } from '../src/own-lines.js';
import { WhatsAppGateway } from '../src/whatsapp.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Journal consumers fixture' };
const bytes = Buffer.from('Anexo exclusivo de fixture sintética, sem cliente ou transporte.');
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-journal-consumers-'));
  const store = new Store(join(directory, 'fixture.sqlite'), { conversationJournal: true });
  t.after(async () => {
    store.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('elozi-journal-consumers-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const tenant = store.createTenant(actor, { name: 'Journal sintético', segment: 'Fixture' });
  const channelId = randomUUID(), conversationId = randomUUID(), key = randomBytes(32);
  store.mutate(actor, tenant.id, 'Fixture base', state => {
    state.channels = [{ id: channelId, kind: 'telegram', transport: 'telegram-bot' }];
    state.conversations = [{ id: conversationId, channelId, remoteJid: '5511999990000@s.whatsapp.net', remoteAliases: [],
      owner: 'human', status: 'open', version: 1, unread: 0, messages: [] }];
  });
  const mediaDirectory = join(directory, 'media'), media = new MediaService(store, { directory: mediaDirectory, authKey: key });
  const context = { tenantId: tenant.id, conversationId, channelId };
  const physical = () => JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get(tenant.id).data).conversations[0];
  const journalRows = () => store.db.prepare('SELECT count(*) AS n FROM conversation_journal WHERE tenant_id=?').get(tenant.id).n;
  const reference = metadata => store.mutateConversation(actor, tenant.id, conversationId, 'Fixture somente no journal', conversation => {
    conversation.messages.push({ id: randomUUID(), kind: 'human', text: 'Referência de fixture.', attachments: [metadata] });
    conversation.version++;
  });
  const upload = name => media.upload(context, { bytes, name, mime: 'text/plain' });
  return { directory, store, tenant, channelId, conversationId, key, mediaDirectory, media, context, physical, journalRows, reference, upload };
}

test('cleanup preserva anexo referenciado apenas no journal e retira órfão verdadeiro', async t => {
  const c = await setup(t), retained = await c.upload('retido.txt'), orphan = await c.upload('orfao.txt');
  c.reference(retained);
  assert.equal(c.physical().messages.length, 0);
  assert.equal(c.journalRows(), 1);
  c.store.db.prepare('UPDATE media_attachments SET created_at=?').run('2000-01-01T00:00:00.000Z');
  assert.deepEqual(await c.media.cleanupOrphans({ pinnedIds: [] }), { removed: 1 });
  assert.deepEqual((await c.media.read(retained.id, c.context)).bytes, bytes);
  assert.equal(c.store.db.prepare('SELECT 1 FROM media_attachments WHERE id=?').get(orphan.id), undefined);
  await assert.rejects(readFile(join(c.mediaDirectory, orphan.id + '.mepmedia')), error => error.code === 'ENOENT');
  assert.equal(c.physical().messages.length, 0);
  assert.equal(c.journalRows(), 1);
});

test('backup cifrado inclui referência exclusiva do journal e valida sua mídia sem materializar a origem', async t => {
  const c = await setup(t), retained = await c.upload('journal.txt'), orphan = await c.upload('sem-referencia.txt');
  c.reference(retained);
  assert.equal(c.physical().messages.length, 0);
  assert.equal(c.journalRows(), 1);
  const backup = await createLocalBackup(c.store.db, { destination: join(c.directory, 'backups'), key: c.key, mediaDirectory: c.mediaDirectory });
  assert.equal(backup.media.count, 1);
  assert.deepEqual(backup.media.files.map(file => file.id), [retained.id]);
  assert.equal(backup.media.files.some(file => file.id === orphan.id), false);
  const restored = await validateBackup(backup.file, { key: c.key });
  assert.equal(restored.integrity, 'ok');
  assert.equal(restored.media.restoreVerified, true);
  assert.equal(restored.media.count, 1);
  assert.equal(c.physical().messages.length, 0);
  assert.equal(c.journalRows(), 1);
});

test('spool PostgreSQL recebe a conversa efetiva sem enviar ou materializar o journal', async t => {
  const c = await setup(t), attachment = await c.upload('spool.txt');
  c.reference(attachment);
  const bridge = new PostgresBridge(c.store, { pool: { async end() {} } });
  try {
    bridge.queue(c.tenant.id);
    const snapshot = JSON.parse(c.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(c.tenant.id).payload);
    const conversation = snapshot.conversations.find(item => item.id === c.conversationId);
    assert.equal(conversation.version, 2);
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].attachments[0].id, attachment.id);
    assert.equal(snapshot.resellerId, actor.resellerId);
    assert.equal(c.physical().messages.length, 0);
    assert.equal(c.journalRows(), 1);
  } finally { await bridge.close(); }
});

test('reconciliação de mídia no boot encontra metadados antigos apenas no journal', async t => {
  const c = await setup(t), attachment = await c.upload('reconciliado.txt');
  c.reference({ ...attachment, status: 'pending' });
  assert.equal(c.physical().messages.length, 0);
  assert.equal(c.journalRows(), 1);
  new MediaService(c.store, { directory: c.mediaDirectory, authKey: c.key });
  const conversation = c.store.tenant(actor, c.tenant.id).conversations[0];
  assert.equal(conversation.version, 3);
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].attachments[0].status, 'ready');
  assert.deepEqual((await c.media.read(attachment.id, c.context)).bytes, bytes);
});

test('linhas próprias e lookup WhatsApp legado observam identidade e posse somente no journal', async t => {
  const c = await setup(t), nextJid = '5511888880000@s.whatsapp.net';
  c.store.mutateConversation(actor, c.tenant.id, c.conversationId, 'Fixture identidade efetiva', conversation => {
    conversation.remoteJid = nextJid;
    conversation.owner = 'agent';
    conversation.version++;
  });
  const gateway = new WhatsAppGateway(c.store, { authKey: c.key });
  try {
    gateway.lookupConversationIds = () => null; // Exercise the supported legacy/coverage-absent fallback.
    const entry = { actor, tenantId: c.tenant.id, channelId: c.channelId };
    assert.equal(gateway.incomingConversationRecord(entry, [nextJid]).id, c.conversationId);
    assert.equal(gateway.incomingConversationRecord(entry, [c.physical().remoteJid]), undefined);
    const state = new OwnLines(c.store.db).tenantState(c.tenant.id);
    assert.equal(state.conversations[0].owner, 'agent');
    assert.equal(state.conversations[0].remoteJid, nextJid);
    assert.equal(c.physical().owner, 'human');
    assert.equal(c.journalRows(), 1);
    const other = c.store.createTenant(actor, { name: 'Outra linha própria sintética', segment: 'Fixture' });
    const otherChannelId = randomUUID(), ownJid = c.physical().remoteJid;
    const mirror = { id: randomUUID(), channelId: otherChannelId, remoteJid: ownJid, remoteAliases: [], owner: 'human', status: 'open', version: 1, messages: [] };
    c.store.mutate(actor, other.id, 'Fixture outra ponta', tenant => {
      tenant.channels = [{ id: otherChannelId, kind: 'whatsapp_qr', transport: 'baileys' }];
      tenant.conversations = [mirror];
    });
    const bind = c.store.db.prepare('INSERT INTO wa_number_bindings VALUES (?,?,?)');
    bind.run(ownJid.split('@')[0], c.channelId, c.tenant.id);
    bind.run(nextJid.split('@')[0], otherChannelId, other.id);
    const ownLines = new OwnLines(c.store.db);
    assert.equal(ownLines.agentOnOtherSide(other.id, mirror), true);
    assert.throws(() => ownLines.assertAgentAllowed(other.id, mirror), error => error.code === 'OWN_LINE_AGENT_PAIR');
  } finally { await gateway.close(); }
});
