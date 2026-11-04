import { fail } from './store.js';

const DAY = 86400000;
const keys = ['after', 'before', 'limit', 'cursor'];
const fields = (input, allowed) => input && typeof input === 'object' && !Array.isArray(input)
  && [Object.prototype, null].includes(Object.getPrototypeOf(input)) && Reflect.ownKeys(input).every(key => allowed.includes(key));
function instant(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(400, 'Informe data e hora com fuso para o histórico.');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) fail(400, 'O período do histórico é inválido.');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(400, 'O período do histórico é inválido.');
  return new Date(time).toISOString();
}
const author = message => String(message.senderName || message.authorName || (message.kind === 'agent' ? 'Agente' : message.kind === 'human' ? 'Atendente' : 'Participante')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
function attachment(value) {
  return { id: String(value.id || '').slice(0, 160), kind: String(value.kind || 'document').slice(0, 20), name: String(value.name || '').slice(0, 160), mime: String(value.mime || '').slice(0, 100), size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null };
}

/** Public messages only. Pagination moves backwards; each page remains chronological. */
export function groupHistory(conversation, input = {}, { tenantId, channelId = conversation?.channelId, now = Date.now() } = {}) {
  if (!conversation || conversation.conversationKind !== 'group') fail(400, 'Escolha uma conversa de grupo.');
  if (!fields(input, keys)) fail(400, 'Informe somente os filtros de histórico permitidos.');
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'Consulte entre uma e 100 mensagens por página.');
  if (!Number.isFinite(now)) throw new TypeError('Relógio do histórico inválido.');
  let cursor;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 1600 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) fail(400, 'Cursor de histórico inválido.');
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { fail(400, 'Cursor de histórico inválido.'); }
    if (!fields(cursor, ['format', 'tenantId', 'channelId', 'conversationId', 'version', 'after', 'before', 'offset']) || cursor.format !== 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1) fail(400, 'Cursor de histórico inválido.');
    if (cursor.tenantId !== tenantId || cursor.channelId !== channelId || cursor.conversationId !== conversation.id || cursor.version !== conversation.version) fail(409, 'O grupo ou histórico mudou. Atualize o histórico antes de continuar.');
  }
  const before = instant(input.before ?? cursor?.before ?? new Date(now).toISOString());
  const after = instant(input.after ?? cursor?.after ?? new Date(Date.parse(before) - 7 * DAY).toISOString());
  const duration = Date.parse(before) - Date.parse(after);
  if (duration <= 0 || duration > 31 * DAY) fail(400, 'Escolha um período de até 31 dias.');
  if (cursor && (after !== cursor.after || before !== cursor.before)) fail(409, 'O período deste cursor mudou. Atualize o histórico.');
  const available = (conversation.messages || []).filter(message => ['customer', 'human', 'agent'].includes(message.kind) && typeof message.id === 'string' && typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt)) && Date.parse(message.createdAt) >= Date.parse(after) && Date.parse(message.createdAt) <= Date.parse(before))
    .map(message => ({ id: message.id.slice(0, 160), kind: message.kind, text: typeof message.text === 'string' ? message.text.slice(0, 12000) : '', senderName: author(message), createdAt: new Date(message.createdAt).toISOString(), attachments: (message.attachments || []).slice(0, 10).map(attachment) }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const offset = cursor?.offset ?? 0;
  if (offset > available.length) fail(409, 'O histórico mudou. Atualize antes de continuar.');
  const end = available.length - offset, start = Math.max(0, end - limit), messages = available.slice(start, end);
  const nextOffset = offset + messages.length, hasMore = start > 0;
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({ format: 1, tenantId, channelId, conversationId: conversation.id, version: conversation.version, after, before, offset: nextOffset })).toString('base64url') : null;
  return { conversationId: conversation.id, version: conversation.version, messages,
    coverage: { from: after, to: before, availableCount: available.length, includedCount: messages.length, hasMore, historySource: 'elozi', attachmentsAnalyzed: false }, nextCursor };
}
