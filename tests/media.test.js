import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/store.js';
import { MediaService, MAX_MEDIA_BYTES, validateMedia, readLimitedMedia, safeMediaName } from '../src/media.js';
import { Outbox } from '../src/outbox.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { TelegramGateway } from '../src/telegram.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Arquivos QA' };
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('Arquivo PNG sintético sem clientes')]);
const rejectStatus = code => error => error.status === code;
function setup(t, options = {}) {
  const store = new Store(':memory:'), key = randomBytes(32), tenant = store.createTenant(actor, { name: 'Mídia QA', segment: 'Fixture' });
  const channelId = randomUUID(), conversationId = randomUUID();
  store.mutate(actor, tenant.id, 'Fixture sintética', state => {
    state.channels.push({ id: channelId, kind: 'telegram', transport: 'telegram-bot' });
    state.conversations.push({ id: conversationId, channelId, owner: 'human', status: 'open', version: 1, messages: [] });
  });
  const media = new MediaService(store, { directory: null, authKey: key, ...options });
  t.after(() => store.close());
  return { store, media, key, tenant, context: { tenantId: tenant.id, conversationId, channelId } };
}

test('arquivos cifrados persistem em disco, conferem contexto e recusam adulteração', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-media-unit-'));
  t.after(async () => { assert.ok(directory.startsWith(join(tmpdir(), 'elozi-media-unit-'))); await rm(directory, { recursive: true, force: true }); });
  const c = setup(t, { directory }), metadata = await c.media.upload(c.context, { bytes: png, name: '../../imagem.png', mime: 'image/png' });
  assert.equal(metadata.name, 'imagem.png'); assert.equal(metadata.status, 'ready'); assert.equal(metadata.preview, true);
  const path = join(directory, metadata.id + '.mepmedia'), blob = await readFile(path);
  assert.equal(blob.length, png.length + 28); assert.equal(blob.includes(png), false);
  const restored = new MediaService(c.store, { directory, authKey: c.key });
  assert.deepEqual((await restored.read(metadata.id, c.context)).bytes, png);
  await assert.rejects(restored.read(metadata.id, { ...c.context, conversationId: randomUUID() }), rejectStatus(404));
  const otherTenant = c.store.createTenant(actor, { name: 'Outra empresa', segment: 'Fixture' });
  await assert.rejects(restored.read(metadata.id, { ...c.context, tenantId: otherTenant.id }), rejectStatus(404));
  blob[blob.length - 1] ^= 1; await writeFile(path, blob);
  await assert.rejects(restored.read(metadata.id, c.context), rejectStatus(404));
  assert.equal((await readdir(directory)).length, 1);
});

test('validação bloqueia MIME falso e excesso de bytes; conteúdo ativo sempre é documento', async () => {
  assert.throws(() => validateMedia(Buffer.from('<script>atividade</script>'), { mime: 'image/png', name: 'imagem.png' }), rejectStatus(400));
  assert.throws(() => validateMedia(Buffer.alloc(MAX_MEDIA_BYTES + 1), { mime: 'application/pdf' }), rejectStatus(413));
  assert.throws(() => validateMedia(Buffer.alloc(0), { mime: 'application/pdf' }), rejectStatus(400));
  const svg = validateMedia(Buffer.from('<svg onload="atividade"></svg>'), { mime: 'image/svg+xml', kind: 'image', name: 'ativo.svg' });
  assert.equal(svg.kind, 'document'); assert.equal(svg.mime, 'application/octet-stream'); assert.equal(svg.preview, false);
  const pdf = validateMedia(Buffer.from('%PDF-fixture'), { mime: 'application/pdf', name: 'registro.pdf' });
  assert.equal(pdf.kind, 'document'); assert.equal(pdf.preview, false);
  assert.equal(safeMediaName('..\\\u202e<teste>:arquivo?.pdf'), 'testearquivo.pdf');
  const stream = Readable.from([Buffer.alloc(10), Buffer.alloc(11)]);
  await assert.rejects(readLimitedMedia(stream, 20), rejectStatus(413));
  assert.equal(stream.destroyed, true);
});

test('captura recebe uma vez e falha conserva placeholder sem URL/token ou texto binário', async t => {
  const c = setup(t), placeholder = c.media.placeholder(c.context, { kind: 'image', mime: 'image/png', size: png.length });
  let calls = 0;
  const download = async () => { calls++; return Readable.from([png]); };
  const [first, concurrent] = await Promise.all([c.media.capture(placeholder.id, c.context, download), c.media.capture(placeholder.id, c.context, download)]);
  assert.equal(calls, 1); assert.equal(first.status, 'ready'); assert.deepEqual(concurrent, first);
  assert.deepEqual(await c.media.capture(placeholder.id, c.context, download), first); assert.equal(calls, 1);
  await assert.rejects(c.media.resolve([placeholder.id], c.context), rejectStatus(404));
  const failed = c.media.placeholder(c.context, { kind: 'document', size: 2 });
  const failure = await c.media.capture(failed.id, c.context, async () => { throw new Error('https://provider/token-secret'); });
  assert.equal(failure.status, 'unavailable'); assert.equal(JSON.stringify(failure).includes('token-secret'), false);
  const oversized = c.media.placeholder(c.context, { kind: 'document', size: MAX_MEDIA_BYTES + 1 });
  assert.equal(oversized.status, 'unavailable'); assert.equal(oversized.reason, 'too_large');
  await c.media.capture(oversized.id, c.context, async () => { calls++; }); assert.equal(calls, 1);
  assert.equal(JSON.stringify(c.store.db.prepare('SELECT metadata FROM media_attachments').all()).includes(png.toString('base64')), false);
});

test('reinício transforma pending em indisponível também no histórico, sem redownload', t => {
  const c = setup(t), placeholder = c.media.placeholder(c.context, { mime: 'application/pdf', name: 'pendente.pdf' });
  c.store.mutate(actor, c.tenant.id, 'Fixture pending', tenant => tenant.conversations[0].messages.push({ id: randomUUID(), kind: 'customer', text: 'Texto preservado', attachments: [placeholder] }));
  const restored = new MediaService(c.store, { directory: null, authKey: c.key });
  assert.equal(restored.metadata(placeholder.id, c.context).status, 'unavailable');
  const message = c.store.tenant(actor, c.tenant.id).conversations[0].messages[0];
  assert.equal(message.text, 'Texto preservado'); assert.equal(message.attachments[0].status, 'unavailable');
});

test('reinício recupera ready confirmado no índice antes do update do histórico e é idempotente', async t => {
  const c = setup(t), placeholder = c.media.placeholder(c.context, { kind: 'image', mime: 'image/png', size: png.length, name: 'capturada.png' });
  c.store.mutate(actor, c.tenant.id, 'Fixture crash window', tenant => tenant.conversations[0].messages.push({ id: randomUUID(), kind: 'customer', text: 'Legenda preservada', attachments: [placeholder] }));
  let downloads = 0;
  const ready = await c.media.capture(placeholder.id, c.context, async () => { downloads++; return png; });
  assert.equal(ready.status, 'ready'); assert.equal(c.store.tenant(actor, c.tenant.id).conversations[0].messages[0].attachments[0].status, 'pending');
  const version = c.store.tenant(actor, c.tenant.id).conversations[0].version;
  new MediaService(c.store, { directory: null, authKey: c.key });
  const recovered = c.store.tenant(actor, c.tenant.id).conversations[0];
  assert.equal(recovered.version, version + 1); assert.equal(recovered.messages[0].text, 'Legenda preservada');
  assert.deepEqual(recovered.messages[0].attachments, [ready]); assert.equal(downloads, 1);
  const audits = c.store.db.prepare('SELECT count(*) AS count FROM audit WHERE tenant_id=?').get(c.tenant.id).count;
  // Scalar metadata order does not change state or add a second recovery event.
  c.store.mutate(actor, c.tenant.id, 'Fixture JSON order', tenant => tenant.conversations[0].messages[0].attachments[0] = Object.fromEntries(Object.entries(ready).reverse()));
  new MediaService(c.store, { directory: null, authKey: c.key });
  assert.equal(c.store.tenant(actor, c.tenant.id).conversations[0].version, recovered.version);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM audit WHERE tenant_id=?').get(c.tenant.id).count, audits + 1);
});

test('reconciliação do índice exige empresa, conversa e canal exatos, sem vazar metadados', async t => {
  const c = setup(t), placeholder = c.media.placeholder(c.context, { mime: 'application/pdf', name: 'documento-do-contexto-original.pdf', size: 2 });
  const localReference = { id: placeholder.id, kind: 'document', name: 'Referência de outro contexto', mime: 'application/octet-stream', size: 0, status: 'pending', preview: false };
  const sameTenantOtherConversation = randomUUID(), sameTenantOtherChannel = randomUUID(), otherTenant = c.store.createTenant(actor, { name: 'Outra empresa', segment: 'Fixture' });
  c.store.mutate(actor, c.tenant.id, 'Fixture mismatched references', tenant => {
    tenant.channels.push({ id: sameTenantOtherChannel, kind: 'telegram', transport: 'telegram-bot' });
    tenant.conversations.push({ id: sameTenantOtherConversation, channelId: c.context.channelId, version: 4, messages: [{ id: randomUUID(), text: 'Outra conversa', attachments: [localReference] }] });
    tenant.conversations.push({ id: c.context.conversationId + '-other-channel', channelId: sameTenantOtherChannel, version: 7, messages: [{ id: randomUUID(), text: 'Outro canal', attachments: [localReference] }] });
    // The attachment ID and conversation ID alone are insufficient when the channel changes.
    tenant.conversations[0].channelId = sameTenantOtherChannel;
    tenant.conversations[0].messages.push({ id: randomUUID(), text: 'Canal divergente', attachments: [localReference] });
  });
  c.store.mutate(actor, otherTenant.id, 'Fixture other tenant same IDs', tenant => {
    tenant.channels.push({ id: c.context.channelId, kind: 'telegram', transport: 'telegram-bot' });
    tenant.conversations.push({ id: c.context.conversationId, channelId: c.context.channelId, version: 9, messages: [{ id: randomUUID(), text: 'Outra empresa', attachments: [localReference] }] });
  });
  // Simulate index pending -> unavailable committed before history updates.
  const unavailable = { ...placeholder, status: 'unavailable', reason: 'unavailable' };
  c.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify(unavailable), placeholder.id);
  const before = [c.store.tenant(actor, c.tenant.id).conversations, c.store.tenant(actor, otherTenant.id).conversations];
  new MediaService(c.store, { directory: null, authKey: c.key });
  assert.deepEqual([c.store.tenant(actor, c.tenant.id).conversations, c.store.tenant(actor, otherTenant.id).conversations], before);
  assert.equal(JSON.stringify(before).includes('documento-do-contexto-original.pdf'), false);
  c.store.mutate(actor, c.tenant.id, 'Fixture restore exact channel', tenant => tenant.conversations[0].channelId = c.context.channelId);
  new MediaService(c.store, { directory: null, authKey: c.key });
  const recovered = c.store.tenant(actor, c.tenant.id).conversations;
  assert.deepEqual(recovered[0].messages[0].attachments, [unavailable]); assert.equal(recovered[0].messages[0].text, 'Canal divergente');
  assert.equal(recovered[0].version, before[0][0].version + 1);
  assert.deepEqual(recovered.slice(1), before[0].slice(1)); assert.deepEqual(c.store.tenant(actor, otherTenant.id).conversations, before[1]);
});

test('quota e simultaneidade limitam captura antes do download e uploads antes de gravar', async t => {
  const c = setup(t, { maxTenantBytes: png.length, maxConcurrentCaptures: 1 });
  await c.media.upload(c.context, { bytes: png, mime: 'image/png' });
  await assert.rejects(c.media.upload(c.context, { bytes: png, mime: 'image/png' }), rejectStatus(413));
  const rejected = c.media.placeholder(c.context, { mime: 'application/pdf', size: 1 });
  assert.equal(rejected.reason, 'quota');
  const d = setup(t, { maxConcurrentCaptures: 1, maxQueuedCaptures: 0 }), first = d.media.placeholder(d.context, { mime: 'image/png', size: png.length }), second = d.media.placeholder(d.context, { mime: 'image/png', size: png.length });
  let release;
  const pending = d.media.capture(first.id, d.context, () => new Promise(resolve => { release = resolve; }));
  let calls = 0;
  const busy = await d.media.capture(second.id, d.context, async () => { calls++; return png; });
  assert.equal(busy.reason, 'busy'); assert.equal(calls, 0);
  release(png); assert.equal((await pending).status, 'ready');
});

test('lotes de cinco e seis capturas preservam FIFO, quatro downloads e replay único', async t => {
  for (const total of [5, 6]) {
    const c = setup(t), files = Array.from({ length: total }, () => c.media.placeholder(c.context, { mime: 'image/png', size: png.length }));
    const releases = [], order = [];
    let active = 0, peak = 0;
    const download = index => async () => {
      order.push(index); active++; peak = Math.max(peak, active);
      await new Promise(resolve => { releases[index] = resolve; }); active--; return png;
    };
    const tasks = files.map((file, index) => c.media.capture(file.id, c.context, download(index)));
    const duplicate = c.media.capture(files.at(-1).id, c.context, () => { throw new Error('Replay não pode baixar.'); });
    assert.deepEqual(order, [0, 1, 2, 3]); assert.equal(c.media.activeCaptures, 4); assert.equal(c.media.captureQueue.length, total - 4);
    assert.equal(c.media.metadata(files.at(-1).id, c.context).status, 'pending');
    for (let index = 0; index < 4; index++) releases[index]();
    await Promise.all(tasks.slice(0, 4));
    assert.deepEqual(order, Array.from({ length: total }, (_, index) => index));
    for (let index = 4; index < total; index++) releases[index]();
    const results = await Promise.all(tasks);
    assert.ok(results.every(result => result.status === 'ready')); assert.deepEqual(await duplicate, results.at(-1)); assert.equal(peak, 4);
    assert.equal(c.media.activeCaptures, 0); assert.equal(c.media.captures.size, 0); assert.equal(c.media.captureQueue.length, 0);
    assert.equal(c.media.usage(c.tenant.id), total * png.length);
  }
});

test('fila limitada recusa excesso sem download e conserva reserva e limite de bytes', async t => {
  const c = setup(t, { maxConcurrentCaptures: 1, maxQueuedCaptures: 2 });
  const files = Array.from({ length: 4 }, () => c.media.placeholder(c.context, { mime: 'image/png', size: png.length }));
  let release, calls = 0;
  const first = c.media.capture(files[0].id, c.context, async () => { calls++; await new Promise(resolve => { release = resolve; }); return png; });
  const second = c.media.capture(files[1].id, c.context, async () => { calls++; return png; });
  const third = c.media.capture(files[2].id, c.context, async () => { calls++; return Buffer.alloc(MAX_MEDIA_BYTES + 1); });
  const overflow = await c.media.capture(files[3].id, c.context, async () => { calls++; return png; });
  assert.equal(overflow.reason, 'busy'); assert.equal(calls, 1); assert.equal(c.media.captureQueue.length, 2); assert.equal(c.media.captures.size, 3);
  assert.equal(c.media.usage(c.tenant.id), 3 * png.length);
  release(); assert.equal((await first).status, 'ready'); assert.equal((await second).status, 'ready');
  const oversized = await third; assert.equal(oversized.status, 'unavailable'); assert.equal(oversized.reason, 'too_large'); assert.equal(calls, 3);
  assert.equal(c.media.usage(c.tenant.id), 2 * png.length); assert.equal(c.media.captures.size, 0);
});

test('fila reserva tamanho desconhecido e relê quota antes de iniciar o download', async t => {
  const c = setup(t, { maxConcurrentCaptures: 1, maxTenantBytes: MAX_MEDIA_BYTES + png.length });
  const firstFile = c.media.placeholder(c.context, { mime: 'image/png', size: png.length });
  let release, calls = 0;
  const first = c.media.capture(firstFile.id, c.context, async () => { calls++; await new Promise(resolve => { release = resolve; }); return png; });
  const unknown = c.media.placeholder(c.context, { mime: 'application/pdf' }), quota = c.media.placeholder(c.context, { mime: 'application/pdf' });
  assert.equal(unknown.status, 'pending'); assert.equal(quota.reason, 'quota'); assert.equal(c.media.usage(c.tenant.id), MAX_MEDIA_BYTES + png.length);
  const queued = c.media.capture(unknown.id, c.context, async () => { calls++; return png; });
  await c.media.capture(quota.id, c.context, async () => { calls++; return png; });
  c.media.maxTenantBytes = png.length; release(); await first;
  assert.equal((await queued).reason, 'quota'); assert.equal(calls, 1); assert.equal(c.media.usage(c.tenant.id), 0);
});

test('fila vence dentro do prazo sem rede e libera capacidade e timers', async t => {
  const c = setup(t, { maxConcurrentCaptures: 1, maxQueuedCaptures: 1, captureQueueTtlMs: 10 });
  const firstFile = c.media.placeholder(c.context, { mime: 'image/png', size: png.length }), waiting = c.media.placeholder(c.context, { mime: 'image/png', size: png.length });
  let release, calls = 0;
  const first = c.media.capture(firstFile.id, c.context, async () => { calls++; await new Promise(resolve => { release = resolve; }); return png; });
  const queued = c.media.capture(waiting.id, c.context, async () => { calls++; return png; });
  const duplicate = c.media.capture(waiting.id, c.context, async () => { calls++; return png; });
  await new Promise(resolve => setTimeout(resolve, 25));
  const expired = await queued; assert.equal(expired.reason, 'busy'); assert.deepEqual(await duplicate, expired); assert.equal(calls, 1);
  assert.equal(c.media.captureQueue.length, 0); assert.equal(c.media.captures.size, 1); assert.equal(c.media.usage(c.tenant.id), png.length);
  release(); await first; assert.equal(c.media.captures.size, 0); assert.equal(c.media.activeCaptures, 0);
});

test('fila revalida conversa e canal e coleta não descarta capturas recebidas', async t => {
  for (const change of ['conversation', 'channel']) {
    const c = setup(t, { maxConcurrentCaptures: 1 }), firstFile = c.media.placeholder(c.context, { mime: 'image/png', size: png.length }), waiting = c.media.placeholder(c.context, { mime: 'image/png', size: png.length });
    let release, calls = 0;
    const first = c.media.capture(firstFile.id, c.context, async () => { calls++; await new Promise(resolve => { release = resolve; }); return png; });
    const queued = c.media.capture(waiting.id, c.context, async () => { calls++; return png; });
    assert.equal((await c.media.cleanupOrphans({ pinnedIds: [], now: Date.now() + 25 * 60 * 60 * 1000 })).removed, 0);
    c.store.mutate(actor, c.tenant.id, 'Fixture revogar origem', tenant => {
      if (change === 'conversation') tenant.conversations[0].channelId = randomUUID();
      else tenant.channels = tenant.channels.filter(channel => channel.id !== c.context.channelId);
    });
    release(); await first;
    assert.equal((await queued).status, 'unavailable'); assert.equal(calls, 1); assert.equal(c.media.captureQueue.length, 0); assert.equal(c.media.captures.size, 0);
  }
});

test('gateways fechados ou substituídos drenam fila sem baixar novamente ou duplicar eventos', async t => {
  for (const kind of ['wa', 'tg']) for (const action of ['close', 'replace']) await t.test(`${kind}: ${action}`, async t => {
    const c = setup(t, { maxConcurrentCaptures: 1 });
    const bytes = kind === 'tg' ? Buffer.from([255, 216, 255, 224, 0, 1, 2, 3]) : png;
    c.store.mutate(actor, c.tenant.id, 'Fixture gateway em RAM', tenant => Object.assign(tenant.channels.find(channel => channel.id === c.context.channelId), kind === 'wa' ? { kind: 'whatsapp_qr', transport: 'baileys' } : {}));
    let release, downloads = 0;
    const download = async () => { downloads++; await new Promise(resolve => { release = resolve; }); return bytes; };
    const deniedFetch = async () => { throw new Error('Rede proibida no ensaio.'); };
    const gateway = kind === 'wa'
      ? new WhatsAppGateway(c.store, { authKey: c.key, socketFactory: () => { throw new Error('Socket proibido no ensaio.'); }, downloadMediaImpl: download, fetchImpl: deniedFetch })
      : new TelegramGateway(c.store, { authKey: c.key, polling: false, fetchImpl: deniedFetch });
    if (kind === 'tg') gateway.downloadMedia = download;
    const entry = { channelId: c.context.channelId, tenantId: c.tenant.id, actor: gateway.actor(actor.resellerId), matched: true, state: 'connected', generation: 1, abort: new AbortController(), socket: { end() {} } };
    gateway.media = c.media; gateway.entries.set(entry.channelId, entry);
    const incoming = index => kind === 'wa'
      ? { key: { id: `burst-${index}`, remoteJid: '5511900000000@s.whatsapp.net' }, message: { imageMessage: { mimetype: 'image/png', fileLength: bytes.length } }, messageTimestamp: 1750000000 }
      : { update_id: index, message: { message_id: index, date: 1750000000, chat: { id: 1001, type: 'private', first_name: 'QA' }, photo: [{ file_id: `burst-${index}`, file_size: bytes.length }] } };
    for (let index = 1; index <= 6; index++) await gateway.receive(entry, incoming(index));
    await gateway.receive(entry, incoming(6));
    assert.equal(downloads, 1); assert.equal(c.media.captureQueue.length, 5);
    const closing = action === 'close' ? gateway.close() : null;
    if (action === 'replace') gateway.entries.set(entry.channelId, { ...entry, abort: new AbortController() });
    release(); await Promise.all([...gateway.mediaTasks]); if (closing) await closing;
    const messages = c.store.tenant(actor, c.tenant.id).conversations.flatMap(conversation => conversation.messages);
    assert.equal(messages.length, 6); assert.equal(messages.filter(message => message.attachments[0].status === 'ready').length, 1);
    assert.equal(messages.filter(message => message.attachments[0].status === 'unavailable').length, 5); assert.equal(downloads, 1);
    assert.equal(c.media.captureQueue.length, 0); assert.equal(c.media.captures.size, 0); assert.equal(c.media.activeCaptures, 0);
    await gateway.close(); assert.equal(gateway.mediaTasks.size, 0);
  });
});

test('coleta de órfãos preserva histórico, comandos e backups; ausência de pins impede limpeza', async t => {
  const c = setup(t), create = () => c.media.upload(c.context, { bytes: Buffer.from('Fixture'), mime: 'text/plain' });
  const [orphan, historical, pinned, commanded] = await Promise.all([create(), create(), create(), create()]);
  c.store.mutate(actor, c.tenant.id, 'Fixture referenced', tenant => tenant.conversations[0].messages.push({ id: randomUUID(), kind: 'human', text: '', attachments: [historical] }));
  const outbox = new Outbox(c.store);
  await outbox.dispatch(actor, c.tenant.id, c.context.conversationId, { text: '', attachmentIds: [commanded.id], channelId: c.context.channelId, version: 1, idempotencyKey: randomUUID() }, async () => true);
  const now = Date.now() + 25 * 60 * 60 * 1000;
  assert.equal((await c.media.cleanupOrphans({ now })).removed, 0);
  assert.equal((await c.media.cleanupOrphans({ pinnedIds: [pinned.id], now })).removed, 1);
  await assert.rejects(c.media.read(orphan.id, c.context), rejectStatus(404));
  for (const metadata of [historical, pinned, commanded]) assert.equal((await c.media.read(metadata.id, c.context)).metadata.status, 'ready');
});

test('outbox inclui anexo na identidade, impede nova chave de repetir ready/unknown e mantém replay', async t => {
  const c = setup(t), file = await c.media.upload(c.context, { bytes: png, mime: 'image/png' }), outbox = new Outbox(c.store);
  const input = { text: '', attachmentIds: [file.id], version: 1, channelId: c.context.channelId, idempotencyKey: randomUUID() };
  let calls = 0, release;
  const dispatch = data => outbox.dispatch(actor, c.tenant.id, c.context.conversationId, data, async () => { calls++; await new Promise(resolve => { release = resolve; }); return true; });
  const first = dispatch(input); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(dispatch({ ...input, idempotencyKey: randomUUID() }), rejectStatus(409));
  release(); await first; assert.equal(calls, 1);
  await outbox.dispatch(actor, c.tenant.id, c.context.conversationId, input, async () => { calls++; }); assert.equal(calls, 1);
  await assert.rejects(dispatch({ ...input, idempotencyKey: randomUUID() }), rejectStatus(409));
  await assert.rejects(dispatch({ ...input, attachmentIds: [randomUUID()] }), rejectStatus(409));
  const payload = JSON.parse(c.store.db.prepare('SELECT payload FROM outbound_commands').get().payload);
  assert.deepEqual(payload, { text: '', attachmentIds: [file.id] });
  c.store.db.prepare("UPDATE outbound_commands SET state='unknown'").run();
  await assert.rejects(dispatch({ ...input, idempotencyKey: randomUUID() }), rejectStatus(409));
  await assert.rejects(dispatch(input), rejectStatus(409)); assert.equal(calls, 1);
});
