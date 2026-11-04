import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './store.js';
import { servicePollFields } from './whatsapp-polls.js';

const DAY = 86400000, SEARCH_BYTES = 65536, HISTORY_BYTES = 24576;
const publicKinds = new Set(['customer', 'human', 'agent']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const validConversation = value => value && id(value.id) && id(value.channelId) && (!value.departmentId || id(value.departmentId)) && Number.isSafeInteger(value.version) && value.version > 0 && ['open', 'pending', 'closed'].includes(value.status);
const normalize = value => typeof value === 'string' ? value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR') : '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const clip = (value, length) => value.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
const clean = (value, length) => typeof value === 'string' ? clip(value.toWellFormed().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''), length) : '';

// No remote media address, operational secret or private message field enters a DTO.
function publicText(value, length = 12000) {
  return clip(clean(value, Number.MAX_SAFE_INTEGER)
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, '[credencial omitida]')
    .replace(/\b(?:elozi_svc_|sk-)[A-Za-z0-9_-]+/g, '[credencial omitida]')
    .replace(/\b(?:senha|password|token|secret|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '[credencial omitida]'), length);
}
const publicLabel = (value, length) => publicText(value, length).replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi, '[link omitido]');
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os filtros permitidos para a consulta.');
  if (!id(input.requestId) || input.requestId.length < 8) fail(400, 'Informe uma chave única da solicitação.');
}
function limit(value, fallback, max) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) fail(400, `Consulte entre uma e ${max} entradas por página.`);
  return result;
}
function instant(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(400, 'Informe data e hora com fuso para a consulta.');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number), second = Number(value.slice(17, 19) || 0);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || second > 59 || !Number.isFinite(Date.parse(value))) fail(400, 'O período da consulta é inválido.');
  return new Date(value).toISOString();
}
const maybeInstant = value => value === undefined ? null : instant(value);
function safeInstant(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function attachment(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.id)) return null;
  return { id: value.id, kind: ['image', 'audio', 'video', 'document', 'sticker'].includes(value.kind) ? value.kind : 'document', name: publicLabel(value.name, 160), mime: typeof value.mime === 'string' && /^[A-Za-z0-9!#$&^_.+-]{1,40}\/[A-Za-z0-9!#$&^_.+-]{1,60}$/.test(value.mime) ? value.mime : '', size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null };
}
function messages(conversation, { after = null, before = null } = {}) {
  return (Array.isArray(conversation.messages) ? conversation.messages : []).filter(message => message && publicKinds.has(message.kind) && typeof message.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(message.id))
    .map(message => ({ message, createdAt: safeInstant(message.createdAt) }))
    .filter(item => (!after || item.createdAt && item.createdAt >= after) && (!before || item.createdAt && item.createdAt <= before));
}
function metadata(tenant, conversation) {
  const channel = (tenant.channels || []).find(item => item.id === conversation.channelId), department = (tenant.departments || []).find(item => item.id === conversation.departmentId);
  const contact = conversation.contactId && (tenant.contacts || []).find(item => item.id === conversation.contactId);
  // A linked contact can span hidden channels/departments; only this attendance's own peer is searchable.
  const peers = [conversation.remoteJid, conversation.remoteChatId, conversation.remoteSenderId, conversation.remoteUserId].filter(value => typeof value === 'string');
  const identities = (Array.isArray(contact?.identities) ? contact.identities : []).filter(identity => identity?.channelId === conversation.channelId && peers.includes(identity.externalId)).map(identity => identity.externalId);
  return [conversation.id, conversation.contact, conversation.contactId, conversation.status, conversation.conversationKind,
    conversation.department, conversation.assignedUserName, channel?.name, channel?.kind, channel?.transport, department?.name,
    conversation.remoteJid, conversation.remoteChatId, conversation.remoteSenderId, conversation.remoteUserId,
    ...(Array.isArray(conversation.tags) ? conversation.tags : []), ...identities].filter(value => typeof value === 'string').map(value => publicText(value, 1000));
}
function snippet(text, terms) {
  const normalized = normalize(text), positions = terms.map(term => normalized.indexOf(term)).filter(position => position >= 0);
  const start = Math.max(0, Math.min(...positions) - 48);
  return (start ? '…' : '') + clip(text.slice(start).replace(/^[\uDC00-\uDFFF]/, ''), start ? 159 : 160);
}
function historyMessage(item) {
  const message = item.message;
  return { id: message.id, kind: message.kind, text: publicText(message.text), ...servicePollFields(message), senderName: publicText(message.senderName || message.authorName || (message.kind === 'agent' ? 'Agente' : message.kind === 'human' ? 'Atendente' : 'Participante'), 100), createdAt: item.createdAt,
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).slice(0, 10).map(attachment).filter(Boolean) };
}
const OUTBOUND_DELIVERY = new Set(['pending', 'sent', 'delivered', 'read', 'failed', 'unconfirmed']);
const ATTACHMENT_STATES = new Set(['pending', 'ready', 'unavailable']);
// Live provider signals stay out of the cursor snapshot: a delivery or download update must not void pagination.
function pageMessage(item) {
  const value = historyMessage(item), message = item.message, source = Array.isArray(message.attachments) ? message.attachments : [];
  value.attachments = value.attachments.map(entry => { const state = source.find(candidate => candidate?.id === entry.id)?.status; return ATTACHMENT_STATES.has(state) ? { ...entry, status: state } : entry; });
  return message.kind !== 'customer' && OUTBOUND_DELIVERY.has(message.delivery) ? { ...value, delivery: message.delivery } : value;
}
function shortenText(message, fits) {
  let low = 0, high = message.text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits({ ...message, text: message.text.slice(0, middle) })) low = middle; else high = middle - 1; }
  return { ...message, text: message.text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '') };
}

/** Pure recorded-data queries; authority and quotas remain in the existing service namespace. */
export class ServiceQueries {
  constructor(api) { this.api = api; this.cursorKey = randomBytes(32); }
  binding(actor, authority, operation) {
    return { principalId: actor.principalId, revision: actor.revision, keyRevision: actor.keyRevision, workspaceId: actor.workspaceId, tenantId: actor.tenantId, agentId: actor.agentId, adapterHash: authority.adapterHash, operation };
  }
  encode(value) {
    const payload = Buffer.from(JSON.stringify({ format: 1, ...value })).toString('base64url');
    return payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('base64url');
  }
  decode(value) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > 2400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) fail(400, 'Cursor da consulta inválido.');
    const [payload, signature] = value.split('.'), expected = createHmac('sha256', this.cursorKey).update(payload).digest(), signatureBytes = Buffer.from(signature, 'base64url'), payloadBytes = Buffer.from(payload, 'base64url');
    if (signatureBytes.length !== expected.length || signatureBytes.toString('base64url') !== signature || payloadBytes.toString('base64url') !== payload || !timingSafeEqual(expected, signatureBytes)) fail(400, 'Cursor da consulta inválido.');
    let cursor;
    try { cursor = JSON.parse(payloadBytes.toString('utf8')); } catch { fail(400, 'Cursor da consulta inválido.'); }
    if (!cursor || cursor.format !== 1 || Object.keys(cursor).some(key => !['format', 'binding', 'filters', 'snapshot', 'offset'].includes(key)) || !cursor.binding || typeof cursor.binding !== 'object' || !cursor.filters || typeof cursor.filters !== 'object' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1 || typeof cursor.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.snapshot)) fail(400, 'Cursor da consulta inválido.');
    return cursor;
  }
  assertCursor(cursor, binding, filters, snapshot) {
    if (cursor && (hash(cursor.binding) !== hash(binding) || hash(cursor.filters) !== hash(filters) || cursor.snapshot !== snapshot)) fail(409, 'O escopo, filtro ou histórico mudou. Inicie uma nova consulta.');
  }
  authority(actor, conversationId, version) {
    const context = this.api.context(actor, conversationId, version);
    if (context.conversationKind === 'group') return this.api.groupAuthority(actor, conversationId, 'conversation.read', version);
    return { context, authority: this.api.principals.revalidate(actor, 'conversation.read', context) };
  }
  inventory(actor) {
    const context = this.api.inventoryContext(actor), authority = this.api.principals.revalidate(actor, 'conversation.read', context);
    return { context, authority, tenant: this.api.store.tenant(this.api.internalActor(actor, authority), actor.tenantId) };
  }
  scoped(actor, tenant) {
    return this.api.withReadScope(actor, scope => (tenant.conversations || []).filter(validConversation).filter(conversation => {
      try { scope.check(conversation); return true; }
      catch (error) { if ([403, 404].includes(error.status)) return false; throw error; }
    }));
  }
  finish(actor, context, input, payload, result, recheck) {
    const principals = this.api.principals, reserved = principals.reserve(actor, { requestId: input.requestId, capability: 'conversation.read', context, units: 1, costMicros: 0, payload });
    if (!reserved.replayed) {
      principals.beginDispatch(actor, reserved.receipt.id);
      principals.complete(actor, reserved.receipt.id, { state: 'confirmed', result: { operation: payload.operation, includedCount: result.coverage.includedCount } });
    }
    principals.revalidate(actor, 'conversation.read', context); recheck();
    return { ...result, receipt: reserved.receipt.id };
  }
  search(actor, input) {
    fields(input, ['requestId', 'query', 'status', 'channelId', 'after', 'before', 'limit', 'cursor']);
    if (typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.trim().length > 200 || /[\x00-\x1f\x7f]/.test(input.query)) fail(400, 'Informe uma busca de dois a 200 caracteres.');
    const pageLimit = limit(input.limit, 20, 50), status = input.status ?? 'all';
    if (!['all', 'open', 'pending', 'closed'].includes(status) || input.channelId !== undefined && !id(input.channelId)) fail(400, 'Informe status e canal válidos.');
    const query = normalize(input.query.trim()).replace(/\s+/g, ' '), terms = query.split(' ').filter(Boolean), after = maybeInstant(input.after), before = maybeInstant(input.before);
    if (after && before && after > before) fail(400, 'O início da busca precisa anteceder o fim.');
    const cursor = this.decode(input.cursor), inventory = this.inventory(actor), binding = this.binding(actor, inventory.authority, 'search');
    if (input.channelId) this.api.principals.revalidate(actor, 'conversation.read', { ...inventory.context, channelId: input.channelId });
    const filters = { query, status, channelId: input.channelId ?? null, after, before, limit: pageLimit };
    const scoped = this.scoped(actor, inventory.tenant).filter(conversation => (status === 'all' || conversation.status === status) && (!input.channelId || conversation.channelId === input.channelId));
    const prepared = scoped.map(conversation => {
      const recorded = messages(conversation, { after, before }), meta = metadata(inventory.tenant, conversation), text = recorded.map(item => publicText(item.message.text, Number.MAX_SAFE_INTEGER));
      return { conversation, recorded, text, searchable: normalize([...meta, ...text].join('\n')) };
    });
    const snapshot = hash(prepared.map(item => [item.conversation.id, item.conversation.version, item.conversation.status, item.conversation.channelId, item.conversation.departmentId, item.conversation.updatedAt, item.searchable, item.recorded.map(entry => [entry.message.id, entry.createdAt, entry.message.kind])]));
    this.assertCursor(cursor, binding, filters, snapshot);
    const matches = prepared.filter(item => terms.every(term => item.searchable.includes(term))).sort((a, b) => (safeInstant(b.conversation.updatedAt) || '').localeCompare(safeInstant(a.conversation.updatedAt) || '') || a.conversation.id.localeCompare(b.conversation.id));
    const offset = cursor?.offset ?? 0;
    if (offset > matches.length) fail(409, 'O resultado da busca mudou. Inicie uma nova consulta.');
    const conversations = [], make = () => {
      const hasMore = offset + conversations.length < matches.length;
      return { tenantId: actor.tenantId, conversations, coverage: { includedCount: conversations.length, hasMore, truncated: hasMore && conversations.length < pageLimit }, nextCursor: hasMore ? this.encode({ binding, filters, snapshot, offset: offset + conversations.length }) : null };
    };
    for (const item of matches.slice(offset, offset + pageLimit)) {
      const conversation = item.conversation, snippets = [];
      for (let index = item.recorded.length - 1; index >= 0 && snippets.length < 3; index--) {
        if (terms.some(term => normalize(item.text[index]).includes(term))) snippets.push({ messageId: item.recorded[index].message.id, kind: servicePollFields(item.recorded[index].message).kind || item.recorded[index].message.kind, text: snippet(item.text[index], terms), createdAt: item.recorded[index].createdAt });
      }
      conversations.push({ conversationId: conversation.id, contact: publicText(conversation.contact, 120), channelId: conversation.channelId, departmentId: conversation.departmentId || null, status: conversation.status, version: conversation.version, updatedAt: safeInstant(conversation.updatedAt), snippets });
      if (bytes({ ...make(), receipt: '0'.repeat(36) }) > SEARCH_BYTES) { conversations.pop(); break; }
    }
    const result = make();
    return this.finish(actor, inventory.context, input, { operation: 'search', ...filters, cursor: input.cursor ?? null }, result, () => {
      this.api.revalidateInventoryPage(actor, conversations);
      // Counts and cursor also disclose scope: recheck every scoped candidate, not just this page.
      this.api.revalidateInventoryPage(actor, scoped);
    });
  }
  history(actor, input) {
    fields(input, ['requestId', 'conversationId', 'after', 'before', 'limit', 'cursor']);
    if (!id(input.conversationId)) fail(400, 'Informe um atendimento válido.');
    const pageLimit = limit(input.limit, 50, 100), cursor = this.decode(input.cursor);
    const { context, authority } = this.authority(actor, input.conversationId);
    const tenant = this.api.store.serviceTenant(actor.workspaceId, actor.tenantId, { conversationId: input.conversationId, includeMessages: true }), conversation = this.api.store.getConversation(tenant, input.conversationId);
    if (!validConversation(conversation)) fail(409, 'O atendimento não tem metadados válidos para esta consulta.');
    const before = instant(input.before ?? cursor?.filters?.before ?? new Date(this.api.principals.now()).toISOString()), after = instant(input.after ?? cursor?.filters?.after ?? new Date(Date.parse(before) - 7 * DAY).toISOString());
    if (Date.parse(before) - Date.parse(after) <= 0 || Date.parse(before) - Date.parse(after) > 31 * DAY) fail(400, 'Escolha um período de até 31 dias.');
    const filters = { conversationId: input.conversationId, after, before, limit: pageLimit }, binding = this.binding(actor, authority, 'history');
    const available = messages(conversation, { after, before }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.message.id.localeCompare(b.message.id));
    const snapshot = hash([conversation.id, conversation.version, conversation.channelId, conversation.departmentId, available.map(historyMessage)]);
    this.assertCursor(cursor, binding, filters, snapshot);
    const offset = cursor?.offset ?? 0;
    if (offset > available.length) fail(409, 'O histórico mudou. Inicie uma nova consulta.');
    const page = [], end = available.length - offset; let truncated = false;
    const make = () => {
      const hasMore = offset + page.length < available.length;
      return { tenantId: actor.tenantId, channelId: context.channelId, conversationId: conversation.id, version: conversation.version, messages: [...page].reverse(),
        coverage: { from: after, to: before, availableCount: available.length, includedCount: page.length, hasMore, historySource: 'elozi', attachmentsAnalyzed: false, truncated },
        nextCursor: hasMore ? this.encode({ binding, filters, snapshot, offset: offset + page.length }) : null };
    };
    for (let index = end - 1; index >= 0 && page.length < pageLimit; index--) {
      const value = pageMessage(available[index]);
      page.push(value);
      if (bytes({ ...make(), receipt: '0'.repeat(36) }) > HISTORY_BYTES) {
        page.pop();
        if (page.length) { truncated = true; break; }
        truncated = true;
        const shortened = shortenText(value, message => { page.push(message); const fits = bytes({ ...make(), receipt: '0'.repeat(36) }) <= HISTORY_BYTES; page.pop(); return fits; });
        page.push(shortened);
      }
      if (typeof available[index].message.text === 'string' && available[index].message.text.length > 12000) truncated = true;
    }
    const result = make();
    const receiptContext = { ...context }; delete receiptContext.conversationVersion;
    return this.finish(actor, receiptContext, input, { operation: 'conversation-history', conversationId: input.conversationId, after: input.after === undefined ? null : instant(input.after), before: input.before === undefined ? null : instant(input.before), limit: pageLimit, cursor: input.cursor ?? null }, result, () => this.authority(actor, conversation.id, conversation.version));
  }
}
