import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { effectiveTenantDataSql, effectiveTenantRows } from './conversation-journal.js';
import { loadLocalKey } from './wa-auth.js';
import { fail } from './store.js';

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const MEDIA_MAX_BYTES = MAX_MEDIA_BYTES;
const kinds = ['image', 'audio', 'video', 'document'];
const idPattern = /^[0-9a-f-]{36}$/i;
const defaultNames = { image: 'Imagem', audio: 'Áudio', video: 'Vídeo', document: 'Documento' };
/**
 * Files of a deleted account. Rows are inserted by the account deletion inside its SQLite transaction (ids and the
 * relative file name only, no personal data), so a crash after COMMIT still leaves the work queued; the files are
 * removed after COMMIT, at startup and periodically. A row stays with attempts/backoff until its file is gone.
 * MediaService stores exactly one encrypted file per attachment (<id>.mepmedia, no thumbnails or derived variants).
 */
export const MEDIA_DELETION_SPOOL_SQL = 'CREATE TABLE IF NOT EXISTS media_deletion_spool (attachment_id TEXT PRIMARY KEY, file TEXT NOT NULL, queued_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT)';
/** 30 s, 60 s, 120 s ... capped at 1 h; the row is never dropped while its file may still exist. */
export const mediaDeletionBackoffMs = attempts => Math.min(30000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
const previewMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/webm', 'video/mp4', 'video/webm', 'video/quicktime']);
const safeDocumentMimes = new Set(['application/pdf', 'application/zip', 'application/octet-stream', 'text/plain', 'text/csv', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);

export function safeMediaName(value, kind = 'document') {
  const result = String(value || defaultNames[kind] || 'Arquivo').split(/[\\/]/).at(-1).normalize('NFKC').replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 160);
  return result || defaultNames[kind] || 'Arquivo';
}
const normalizeMime = value => typeof value === 'string' ? value.split(';')[0].trim().toLowerCase().slice(0, 120) : 'application/octet-stream';
function descriptor(input = {}) {
  let mime = normalizeMime(input.mime), kind = kinds.includes(input.kind) ? input.kind : previewMimes.has(mime) ? mime.split('/')[0] : 'document';
  // Active content and unsupported codecs are downloadable documents, never inline previews.
  if (kind !== 'document' && !previewMimes.has(mime)) kind = 'document';
  if (kind !== 'document' && mime.split('/')[0] !== kind) kind = 'document';
  if (kind === 'document' && !safeDocumentMimes.has(mime)) mime = 'application/octet-stream';
  return { kind, name: safeMediaName(input.name, kind), mime };
}
function signatureMatches(bytes, mime) {
  const prefix = bytes.subarray(0, 16), ascii = prefix.toString('latin1');
  switch (mime) {
    case 'image/png': return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg': return prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
    case 'image/gif': return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'image/webp': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'audio/ogg': return ascii.startsWith('OggS');
    case 'audio/mpeg': return ascii.startsWith('ID3') || prefix[0] === 255 && (prefix[1] & 224) === 224;
    case 'audio/wav': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE';
    case 'audio/flac': return ascii.startsWith('fLaC');
    case 'audio/mp4': case 'video/mp4': case 'video/quicktime': return ascii.slice(4, 8) === 'ftyp';
    case 'audio/webm': case 'video/webm': return prefix.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    default: return false;
  }
}

export function validateMedia(bytes, input) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail(400, 'Selecione um arquivo com conteúdo.');
  if (bytes.byteLength > MAX_MEDIA_BYTES) fail(413, 'O limite por arquivo é 16 MiB.');
  const result = descriptor(input);
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (result.kind !== 'document' && !signatureMatches(data, result.mime)) fail(400, 'O conteúdo do arquivo não corresponde ao formato informado.');
  return { ...result, size: data.length, preview: result.kind !== 'document' && signatureMatches(data, result.mime) };
}

export async function readLimitedMedia(input, limit = MAX_MEDIA_BYTES) {
  if (input instanceof Uint8Array) {
    if (input.byteLength > limit) fail(413, 'O limite por arquivo é 16 MiB.');
    return Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (!input || typeof input[Symbol.asyncIterator] !== 'function') fail(502, 'O arquivo não está disponível para download.');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > limit) fail(413, 'O limite por arquivo é 16 MiB.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally { if (size > limit) { input.destroy?.(); await input.cancel?.().catch(() => {}); } }
}

export function attachmentIds(input) {
  const ids = input.attachmentIds ?? [];
  if (!Array.isArray(ids) || ids.length > 1 || ids.some(id => typeof id !== 'string' || !idPattern.test(id))) fail(400, 'Envie um arquivo por mensagem.');
  return ids;
}

export function outgoingText(input, hasAttachment = false) {
  if (input.text == null && hasAttachment) return '';
  if (typeof input.text !== 'string' || input.text.trim().length > (hasAttachment ? 1024 : 4000) || !hasAttachment && !input.text.trim()) fail(400, hasAttachment ? 'A legenda pode ter até 1024 caracteres.' : 'Informe um texto entre 1 e 4000 caracteres.');
  return input.text.trim();
}

export class MediaService {
  constructor(store, { directory = 'data/media', authKey, keyLoader = loadLocalKey, maxTenantBytes = 512 * 1024 * 1024, maxConcurrentCaptures = 4, maxQueuedCaptures = 32, captureQueueTtlMs = 60000 } = {}) {
    this.store = store; this.directory = directory == null || directory === ':memory:' ? null : resolve(directory); this.blobs = new Map(); this.authKey = authKey; this.keyLoader = keyLoader; this.captures = new Map(); this.captureQueue = []; this.activeCaptures = 0;
    if (typeof keyLoader !== 'function') throw new TypeError('O carregador privado de chave de arquivo precisa ser uma função.');
    this.maxTenantBytes = Number.isSafeInteger(maxTenantBytes) && maxTenantBytes > 0 ? maxTenantBytes : 512 * 1024 * 1024;
    this.maxConcurrentCaptures = Number.isSafeInteger(maxConcurrentCaptures) && maxConcurrentCaptures > 0 ? maxConcurrentCaptures : 4;
    this.maxQueuedCaptures = Number.isSafeInteger(maxQueuedCaptures) && maxQueuedCaptures >= 0 && maxQueuedCaptures <= 64 ? maxQueuedCaptures : 32;
    this.captureQueueTtlMs = Number.isSafeInteger(captureQueueTtlMs) && captureQueueTtlMs > 0 && captureQueueTtlMs <= 60000 ? captureQueueTtlMs : 60000;
    store.db.exec('CREATE TABLE IF NOT EXISTS media_attachments (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, channel_id TEXT NOT NULL, purpose TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL)');
    store.db.exec(MEDIA_DELETION_SPOOL_SQL);
    store.sweepMediaDeletions = options => this.sweepDeletionSpool(options);
    const indexed = new Map(), indexKey = (tenantId, conversationId, channelId, id) => JSON.stringify([tenantId, conversationId, channelId, id]);
    // The encrypted-file index is authoritative if the process stopped before updating history.
    // Interrupted downloads are unavailable; completed downloads are reconciled without fetching again.
    for (const row of store.db.prepare('SELECT id,tenant_id,conversation_id,channel_id,metadata FROM media_attachments').all()) {
      const metadata = JSON.parse(row.metadata);
      if (metadata.status === 'pending') { metadata.status = 'unavailable'; metadata.reason = 'unavailable'; store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify(metadata), row.id); }
      if (['ready', 'unavailable'].includes(metadata.status)) indexed.set(indexKey(row.tenant_id, row.conversation_id, row.channel_id, row.id), metadata);
    }
    const replacement = (tenantId, conversation, attachment) => {
      const metadata = indexed.get(indexKey(tenantId, conversation.id, conversation.channelId, attachment.id));
      if (!metadata || Object.keys(metadata).length === Object.keys(attachment).length && Object.entries(metadata).every(([key, value]) => attachment[key] === value)) return null;
      return metadata;
    };
    if (indexed.size) for (const row of effectiveTenantRows(store.db)) {
      const affected = JSON.parse(row.data).conversations.some(conversation => conversation.messages.some(message => (message.attachments || []).some(attachment => replacement(row.id, conversation, attachment))));
      if (affected) store.mutate({ role: 'reseller', resellerId: row.reseller_id, name: 'Arquivos' }, row.id, 'Arquivos: histórico reconciliado com índice cifrado', tenant => {
        for (const conversation of tenant.conversations) {
          let changed = false;
          for (const message of conversation.messages) if (message.attachments?.some(attachment => replacement(row.id, conversation, attachment))) { message.attachments = message.attachments.map(attachment => replacement(row.id, conversation, attachment) || attachment); changed = true; }
          if (changed) conversation.version++;
        }
      });
    }
  }
  context(context, { incoming = false } = {}) {
    if (!context || ['tenantId', 'conversationId', 'channelId'].some(key => typeof context[key] !== 'string' || !context[key] || context[key].length > 160)) fail(400, 'Contexto de arquivo inválido.');
    const tenant = this.store.db.prepare(`SELECT ${effectiveTenantDataSql(this.store.db, 't')} AS data FROM tenants t WHERE t.id=?`).get(context.tenantId);
    if (!tenant) fail(404, 'Empresa não encontrada.');
    const state = JSON.parse(tenant.data), conversation = state.conversations.find(item => item.id === context.conversationId);
    if (!conversation && !(incoming && state.channels.some(item => item.id === context.channelId)) || conversation && conversation.channelId !== context.channelId) fail(404, 'Arquivo não encontrado neste atendimento.');
    return context;
  }
  record(id, context, { uploadOnly = false } = {}) {
    this.context(context);
    if (typeof id !== 'string' || !idPattern.test(id)) fail(404, 'Arquivo não encontrado neste atendimento.');
    const row = this.store.db.prepare('SELECT * FROM media_attachments WHERE id=? AND tenant_id=? AND conversation_id=? AND channel_id=?').get(id, context.tenantId, context.conversationId, context.channelId);
    if (!row || uploadOnly && row.purpose !== 'upload') fail(404, 'Arquivo não encontrado neste atendimento.');
    return { ...row, metadata: JSON.parse(row.metadata) };
  }
  insert(context, input, purpose, status) {
    this.context(context, { incoming: purpose === 'received' });
    const metadata = { id: randomUUID(), ...descriptor(input), size: Number.isSafeInteger(input.size) && input.size >= 0 ? input.size : 0, status, preview: false };
    if (metadata.size > MAX_MEDIA_BYTES) { metadata.status = 'unavailable'; metadata.reason = 'too_large'; }
    const used = this.usage(context.tenantId), reservation = metadata.size || MAX_MEDIA_BYTES;
    if (metadata.status === 'pending' && used + reservation > this.maxTenantBytes) {
      if (purpose === 'upload') fail(413, 'O armazenamento de arquivos desta empresa atingiu o limite.');
      metadata.status = 'unavailable'; metadata.reason = 'quota';
    }
    this.store.db.prepare('INSERT INTO media_attachments VALUES (?,?,?,?,?,?,?)').run(metadata.id, context.tenantId, context.conversationId, context.channelId, purpose, JSON.stringify(metadata), new Date().toISOString());
    return metadata;
  }
  placeholder(context, input) { return this.insert(context, input, 'received', 'pending'); }
  usage(tenantId, exceptId) {
    return this.store.db.prepare('SELECT id,metadata FROM media_attachments WHERE tenant_id=?').all(tenantId).reduce((total, row) => {
      if (row.id === exceptId) return total;
      const metadata = JSON.parse(row.metadata);
      return total + (metadata.status === 'ready' ? metadata.size : metadata.status === 'pending' ? metadata.size || MAX_MEDIA_BYTES : 0);
    }, 0);
  }
  metadata(id, context) { return this.record(id, context).metadata; }
  aad(row) { return Buffer.from(JSON.stringify([row.id, row.tenant_id, row.conversation_id, row.channel_id])); }
  fresh(context) {
    if (context.reauthorize === undefined) return;
    if (typeof context.reauthorize !== 'function') fail(500, 'A autorização interna de mídia é inválida.');
    const result = context.reauthorize();
    if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail(500, 'A autorização interna de mídia precisa ser síncrona.'); }
    if (result === false) fail(403, 'O acesso ao arquivo mudou.');
  }
  async save(id, context, bytes, input) {
    this.fresh(context);
    const row = this.record(id, context), snapshot = Buffer.from(bytes), validated = validateMedia(snapshot, input);
    if (row.metadata.status !== 'pending') fail(409, 'Este arquivo já foi processado.');
    if (this.usage(context.tenantId, id) + validated.size > this.maxTenantBytes) fail(413, 'O armazenamento de arquivos desta empresa atingiu o limite.');
    this.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify({ ...row.metadata, size: validated.size }), id);
    this.authKey ||= await this.keyLoader();
    this.fresh(context);
    if (!(this.authKey instanceof Uint8Array) || this.authKey.length !== 32) throw new Error('Chave de arquivo inválida.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.authKey, iv); cipher.setAAD(this.aad(row));
    const ciphertext = Buffer.concat([cipher.update(snapshot), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    const path = this.directory ? join(this.directory, id + '.mepmedia') : null;
    if (path) { await mkdir(this.directory, { recursive: true, mode: 0o700 }); this.fresh(context); await writeFile(path, blob, { flag: 'wx', mode: 0o600 }); }
    else this.blobs.set(id, blob);
    const metadata = { id, ...validated, status: 'ready' };
    try { this.fresh(context); if (this.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify(metadata), id).changes !== 1) fail(404, 'Arquivo não encontrado neste atendimento.'); }
    catch (error) { if (path) await unlink(path).catch(() => {}); else this.blobs.delete(id); throw error; }
    return metadata;
  }
  async upload(context, input) {
    this.fresh(context);
    const bytes = await readLimitedMedia(input.bytes); this.fresh(context);
    const validated = validateMedia(bytes, input), metadata = this.insert(context, validated, 'upload', 'pending');
    try { return await this.save(metadata.id, context, bytes, validated); }
    catch (error) { this.store.db.prepare('DELETE FROM media_attachments WHERE id=?').run(metadata.id); throw error; }
  }
  async capture(id, context, download) {
    this.fresh(context);
    const row = this.record(id, context);
    if (row.metadata.status !== 'pending') return row.metadata;
    if (this.captures.has(id)) return this.captures.get(id);
    if (this.activeCaptures >= this.maxConcurrentCaptures && this.captureQueue.length >= this.maxQueuedCaptures) return this.captureUnavailable(row, 'busy');
    let complete, reject;
    const task = new Promise((resolve, fail) => { complete = resolve; reject = fail; });
    const job = { id, context: { ...context }, row, download, complete, reject, queuedAt: null, timer: null };
    // Both queued and active jobs share the same promise, including duplicate provider events.
    this.captures.set(id, task);
    if (this.activeCaptures < this.maxConcurrentCaptures) this.startCapture(job);
    else {
      job.queuedAt = Date.now(); this.captureQueue.push(job);
      job.timer = setTimeout(() => this.expireCapture(job), this.captureQueueTtlMs); job.timer.unref();
    }
    return task;
  }
  captureUnavailable(row, reason) {
    const current = this.store.db.prepare('SELECT metadata FROM media_attachments WHERE id=? AND tenant_id=? AND conversation_id=? AND channel_id=?').get(row.id, row.tenant_id, row.conversation_id, row.channel_id);
    const metadata = current ? JSON.parse(current.metadata) : row.metadata;
    if (metadata.status !== 'pending') return metadata;
    const unavailable = { ...metadata, status: 'unavailable', preview: false, reason };
    this.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=? AND tenant_id=? AND conversation_id=? AND channel_id=?').run(JSON.stringify(unavailable), row.id, row.tenant_id, row.conversation_id, row.channel_id);
    return unavailable;
  }
  expireCapture(job) {
    const index = this.captureQueue.indexOf(job);
    if (index >= 0) this.captureQueue.splice(index, 1);
    clearTimeout(job.timer); this.captures.delete(job.id);
    try { job.complete(this.captureUnavailable(job.row, 'busy')); } catch (error) { job.reject(error); }
  }
  startCapture(job) {
    clearTimeout(job.timer);
    if (job.queuedAt !== null && Date.now() - job.queuedAt >= this.captureQueueTtlMs) { this.expireCapture(job); return; }
    this.activeCaptures++;
    const finish = () => {
      this.activeCaptures--; this.captures.delete(job.id);
      while (this.activeCaptures < this.maxConcurrentCaptures && this.captureQueue.length) this.startCapture(this.captureQueue.shift());
    };
    this.runCapture(job).then(metadata => { finish(); job.complete(metadata); }, error => { finish(); job.reject(error); });
  }
  async runCapture(job) {
    try {
      this.fresh(job.context);
      const row = this.record(job.id, job.context);
      if (row.metadata.status !== 'pending') return row.metadata;
      const tenant = JSON.parse(this.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(job.context.tenantId).data);
      if (!tenant.channels.some(channel => channel.id === job.context.channelId)) fail(409, 'A conexão mudou.');
      if (row.metadata.size > MAX_MEDIA_BYTES) return this.captureUnavailable(row, 'too_large');
      if (this.usage(job.context.tenantId) > this.maxTenantBytes) return this.captureUnavailable(row, 'quota');
      const downloaded = await job.download(); this.fresh(job.context);
      const described = downloaded && Object.getPrototypeOf(downloaded) === Object.prototype && Object.hasOwn(downloaded, 'bytes') && Object.hasOwn(downloaded, 'metadata');
      const bytes = await readLimitedMedia(described ? downloaded.bytes : downloaded); this.fresh(job.context);
      let metadata = row.metadata;
      if (described) {
        if (Object.keys(downloaded).some(key => !['bytes','metadata'].includes(key)) || !downloaded.metadata || Object.getPrototypeOf(downloaded.metadata) !== Object.prototype || Object.keys(downloaded.metadata).some(key => !['kind','mime','name'].includes(key))) fail(500, 'Metadados internos do download inválidos.');
        metadata = { ...row.metadata, ...downloaded.metadata };
      }
      return await this.save(job.id, job.context, bytes, metadata);
    } catch (error) { return this.captureUnavailable(job.row, error.status === 413 ? 'too_large' : 'unavailable'); }
  }
  async read(id, context, options) {
    this.fresh(context);
    const row = this.record(id, context, options);
    if (row.metadata.status !== 'ready') fail(404, 'Este arquivo está indisponível.');
    let blob;
    try { blob = this.directory ? await readFile(join(this.directory, id + '.mepmedia')) : this.blobs.get(id); if (!blob) throw new Error('Arquivo ausente.'); }
    catch { fail(404, 'Este arquivo está indisponível.'); }
    if (blob.length > MAX_MEDIA_BYTES + 28 || blob.length < 29) fail(404, 'Este arquivo está indisponível.');
    this.authKey ||= await this.keyLoader();
    this.fresh(context);
    let bytes,cleartext,tail;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.authKey, blob.subarray(0, 12)); decipher.setAAD(this.aad(row)); decipher.setAuthTag(blob.subarray(12, 28));
      cleartext=decipher.update(blob.subarray(28));tail=decipher.final();
      bytes = Buffer.concat([cleartext,tail]);
      if (bytes.length !== row.metadata.size) throw new Error('Tamanho divergente.');
      this.fresh(context);
      return { metadata: row.metadata, bytes };
    } catch (error) { bytes?.fill(0); if([401,403,409].includes(error?.status))throw error; fail(404, 'Este arquivo está indisponível.'); }
    finally{cleartext?.fill(0);tail?.fill(0);}
  }
  async resolve(ids, context) {
    attachmentIds({ attachmentIds: ids });
    return Promise.all(ids.map(id => this.read(id, context, { uploadOnly: true })));
  }
  async discard(id, context) {
    const row = this.record(id, context, { uploadOnly: true });
    if (this.directory) await unlink(join(this.directory, row.id + '.mepmedia')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else this.blobs.delete(row.id);
    this.store.db.prepare('DELETE FROM media_attachments WHERE id=?').run(row.id);
  }
  /** Removes the files queued by account deletions; idempotent (a missing file counts as removed). */
  async sweepDeletionSpool({ now = Date.now(), limit = 500 } = {}) {
    const db = this.store.db, result = { removed: 0, missing: 0, failed: 0, pending: 0 };
    const rows = db.prepare('SELECT * FROM media_deletion_spool WHERE next_attempt_at<=? ORDER BY queued_at,attachment_id LIMIT ?').all(now, limit);
    const retry = (row, code) => { const attempts = row.attempts + 1; result.failed++;
      db.prepare('UPDATE media_deletion_spool SET attempts=?,next_attempt_at=?,last_error=? WHERE attachment_id=?').run(attempts, now + mediaDeletionBackoffMs(attempts), code, row.attachment_id); };
    for (const row of rows) {
      // Only <uuid>.mepmedia inside the media directory; anything else stays queued for an operator, never unlinked.
      if (!idPattern.test(row.attachment_id) || row.file !== row.attachment_id + '.mepmedia') { retry(row, 'invalid_entry'); continue; }
      // A live attachment with this id is never removed (defense in depth; ids are random UUIDs).
      if (db.prepare('SELECT 1 FROM media_attachments WHERE id=?').get(row.attachment_id)) { db.prepare('DELETE FROM media_deletion_spool WHERE attachment_id=?').run(row.attachment_id); continue; }
      this.captures.delete(row.attachment_id);
      try {
        if (this.directory) {
          try { await unlink(join(this.directory, row.file)); result.removed++; }
          catch (error) { if (error?.code !== 'ENOENT') throw error; result.missing++; }
        } else if (this.blobs.delete(row.attachment_id)) result.removed++; else result.missing++;
        db.prepare('DELETE FROM media_deletion_spool WHERE attachment_id=?').run(row.attachment_id);
      } catch (error) { retry(row, String(error?.code || 'unlink_failed').slice(0, 40)); }
    }
    result.pending = db.prepare('SELECT count(*) AS n FROM media_deletion_spool').get().n;
    return result;
  }
  async cleanupOrphans({ pinnedIds, now = Date.now() } = {}) {
    // Missing backup information means no cleanup. The caller supplies every retained backup reference.
    if (!Array.isArray(pinnedIds) || pinnedIds.some(id => typeof id !== 'string' || !idPattern.test(id)) || !Number.isFinite(now)) return { removed: 0 };
    const references = new Set(pinnedIds);
    for (const row of this.store.db.prepare(`SELECT ${effectiveTenantDataSql(this.store.db, 't')} AS data FROM tenants t`).all()) for (const conversation of JSON.parse(row.data).conversations || []) for (const message of conversation.messages || []) for (const attachment of message.attachments || []) references.add(attachment.id);
    if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbound_commands'").get()) for (const row of this.store.db.prepare('SELECT payload FROM outbound_commands').all()) for (const id of JSON.parse(row.payload).attachmentIds || []) references.add(id);
    const rows = this.store.db.prepare("SELECT * FROM media_attachments WHERE purpose='upload' AND created_at<?").all(new Date(now - 24 * 60 * 60 * 1000).toISOString());
    let removed = 0;
    for (const row of rows) if (!references.has(row.id)) {
      await this.discard(row.id, { tenantId: row.tenant_id, conversationId: row.conversation_id, channelId: row.channel_id }); removed++;
    }
    return { removed };
  }
}
