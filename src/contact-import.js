import { createHash, randomUUID } from 'node:crypto';
import { fail } from './store.js';

export const CONTACT_IMPORT_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, rows: 10000, columns: 40, previewRows: 100, previews: 16, ttlMs: 15 * 60 * 1000 });
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const phoneDDD = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));
const aliases = new Map([
  ['name', 'name'], ['nome', 'name'], ['nome completo', 'name'], ['contact name', 'name'],
  ['phone', 'phone'], ['number', 'phone'], ['telefone', 'phone'], ['numero', 'phone'], ['whatsapp', 'phone'], ['celular', 'phone'],
  ['email', 'email'], ['e-mail', 'email'], ['e mail', 'email'],
  ['notes', 'notes'], ['note', 'notes'], ['notas', 'notes'], ['observacoes', 'notes'], ['observacao', 'notes'], ['anotacoes', 'notes'],
  ['tags', 'tags'], ['tag', 'tags'], ['etiquetas', 'tags'], ['etiqueta', 'tags'],
  ['sourceref', 'sourceRef'], ['source ref', 'sourceRef']
]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const heading = value => value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
const signature = row => JSON.stringify([row.name, row.phone, row.email, row.notes, [...row.tags].sort()]);
const contactsOf = state => Array.isArray(state.contacts) ? state.contacts : [];

function allowed(input, fields) {
  if (!plain(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !fields.includes(key))) fail(400, 'Informe somente os campos permitidos da importação.');
}
function scalar(value, max, label, multiline = false) {
  if (typeof value !== 'string' || value.trim().length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail(400, `${label} inválido.`);
  return value.trim();
}

/** Preserves the provided subscriber digits; never inserts/removes a ninth digit. */
export function normalizeImportedPhone(value) {
  const clean = scalar(value, 30, 'Telefone');
  if (!/^\+?[0-9 ()-]+$/.test(clean)) fail(400, 'Informe telefone brasileiro com DDD, sem ramal.');
  let digits = clean.replace(/\D/g, '');
  if (!clean.startsWith('+') && [10, 11].includes(digits.length)) digits = '55' + digits;
  if (!/^55\d{10,11}$/.test(digits) || !phoneDDD.has(digits.slice(2, 4))) fail(400, 'Telefone brasileiro com DDD inválido ou ambíguo.');
  const subscriber = digits.slice(4);
  if (!(subscriber.length === 8 ? /^[2-9]\d{7}$/ : /^9\d{8}$/).test(subscriber) || /^(\d)\1+$/.test(subscriber)) fail(400, 'Telefone brasileiro inválido ou ambíguo.');
  return digits;
}

function csvMatrix(content) {
  const source = content.replace(/^\uFEFF/, '');
  let commas = 0, semicolons = 0, quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') i++; else quoted = !quoted; }
    if (!quoted && (char === '\n' || char === '\r')) break;
    if (!quoted && char === ',') commas++;
    if (!quoted && char === ';') semicolons++;
  }
  const delimiter = semicolons > commas ? ';' : ',';
  const rows = []; let row = [], cell = '', inQuote = false, closedQuote = false;
  const field = () => {
    row.push(cell); cell = ''; closedQuote = false;
    if (row.length > CONTACT_IMPORT_LIMITS.columns) fail(413, 'O arquivo possui colunas demais.');
  };
  const line = () => {
    field();
    if (row.some(value => value.trim())) rows.push(row);
    row = [];
    if (rows.length > CONTACT_IMPORT_LIMITS.rows + 1) fail(413, 'Importe até 10.000 contatos por arquivo.');
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuote) {
      if (char === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { inQuote = false; closedQuote = true; } }
      else cell += char;
      continue;
    }
    if (char === delimiter) { field(); continue; }
    if (char === '\r' || char === '\n') { line(); if (char === '\r' && source[i + 1] === '\n') i++; continue; }
    if (closedQuote) {
      if (char === ' ' || char === '\t') continue;
      fail(400, 'CSV inválido: texto depois das aspas de fechamento.');
    }
    if (char === '"') {
      if (cell) fail(400, 'CSV inválido: aspas precisam iniciar o campo.');
      inQuote = true;
    } else cell += char;
  }
  if (inQuote) fail(400, 'CSV inválido: aspas não foram fechadas.');
  if (cell || row.length || closedQuote) line();
  if (!rows.length) fail(400, 'O arquivo está vazio.');
  const originalHeaders = rows.shift();
  if (originalHeaders.some(key => forbiddenKeys.has(key.trim()))) fail(400, 'Cabeçalho não permitido.');
  const headers = originalHeaders.map(heading);
  if (headers.some(key => forbiddenKeys.has(key))) fail(400, 'Cabeçalho não permitido.');
  const recognized = headers.map(key => aliases.get(key));
  if (!recognized.includes('name') || !recognized.includes('phone')) fail(400, 'O arquivo precisa das colunas nome e telefone/número.');
  if (recognized.filter(Boolean).some((key, index, array) => array.indexOf(key) !== index)) fail(400, 'Não repita colunas de nome, telefone ou outros campos reconhecidos.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) return { row: index + 2, error: 'A quantidade de campos difere do cabeçalho.' };
    const record = Object.create(null);
    recognized.forEach((key, column) => { if (key) record[key] = values[column]; });
    return { row: index + 2, record };
  });
}
function jsonRows(content) {
  let parsed;
  try { parsed = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { fail(400, 'Arquivo JSON inválido.'); }
  const checkKeys = (value, depth = 0) => {
    if (!value || typeof value !== 'object') return;
    if (depth > 8) fail(400, 'O JSON possui estrutura profunda demais.');
    for (const key of Object.keys(value)) {
      if (forbiddenKeys.has(key)) fail(400, 'O arquivo possui campos não permitidos.');
      checkKeys(value[key], depth + 1);
    }
  };
  checkKeys(parsed);
  let rows = parsed;
  if (plain(parsed)) {
    const lists = ['contacts', 'contatos', 'data'].filter(key => Object.hasOwn(parsed, key) && Array.isArray(parsed[key]));
    if (lists.length !== 1) fail(400, 'Use uma lista JSON de contatos ou a propriedade contacts/contatos/data.');
    rows = parsed[lists[0]];
  }
  if (!Array.isArray(rows) || !rows.length) fail(400, 'Informe uma lista JSON de contatos.');
  if (rows.length > CONTACT_IMPORT_LIMITS.rows) fail(413, 'Importe até 10.000 contatos por arquivo.');
  return rows.map((source, index) => {
    if (!plain(source)) return { row: index + 1, error: 'Cada contato precisa ser um objeto JSON.' };
    const record = Object.create(null);
    for (const key of Object.keys(source)) {
      const recognized = aliases.get(heading(key));
      if (!recognized) continue;
      if (Object.hasOwn(record, recognized)) return { row: index + 1, error: 'Contato com campos equivalentes repetidos.' };
      record[recognized] = source[key];
    }
    if (source.isGroup === true || source.isGroup === 'true' || source.type === 'group') return { row: index + 1, error: 'Grupos exigem identidade própria e não são importados por telefone.' };
    return { row: index + 1, record };
  });
}
function normalizedRow(item, preserveInvalid = false) {
  const result = { row: item.row, status: 'invalid', name: '', phone: '', email: '', notes: '', tags: [] };
  if (item.error) return { ...result, reason: item.error };
  try {
    const record = item.record;
    result.name = scalar(record.name, 80, 'Nome');
    if (!result.name) fail(400, 'Informe o nome do contato.');
    result.email = scalar(record.email ?? '', 254, 'E-mail').toLowerCase();
    if (result.email && (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(result.email) || result.email.startsWith('.') || result.email.split('@')[0].endsWith('.') || result.email.includes('..'))) fail(400, 'E-mail inválido.');
    result.notes = scalar(record.notes ?? '', 2000, 'Anotações', true);
    let tags = record.tags ?? [];
    if (typeof tags === 'string') tags = tags.trim() ? tags.split(/[;,|]/) : [];
    if (!Array.isArray(tags) || tags.length > 20) fail(400, 'Informe até vinte etiquetas de texto.');
    result.tags = [...new Set(tags.map(tag => scalar(tag, 40, 'Etiqueta')).filter(Boolean))];
    if (Object.hasOwn(record, 'sourceRef')) {
      if (typeof record.sourceRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(record.sourceRef)) fail(400, 'A referência de origem precisa ser um identificador textual de até 120 caracteres.');
      result.sourceRef = record.sourceRef;
    }
    try {
      result.phone = scalar(record.phone, 30, 'Telefone');
      result.phone = normalizeImportedPhone(result.phone);
      result.status = 'valid';
    } catch (error) {
      if (error.status !== 400 || !preserveInvalid) throw error;
      if (!result.sourceRef) fail(400, 'Preservar telefone inválido exige sourceRef estável da origem.');
      const originalPhone = scalar(record.phone, 256, 'Telefone original', true);
      const notes = `${result.notes}${result.notes ? '\n\n' : ''}Telefone original MEPChat: ${originalPhone || '(vazio)'}`;
      result.notes = scalar(notes, 2000, 'Anotações com telefone original', true);
      if (!result.tags.includes('Revisar telefone')) {
        if (result.tags.length >= 20) fail(400, 'Reserve uma das vinte etiquetas para Revisar telefone.');
        result.tags.push('Revisar telefone');
      }
      result.phone = ''; result.originalPhone = originalPhone;
      result.status = 'review'; result.reason = 'Telefone original preservado nas notas; contato sem telefone válido e sem identidade de canal.';
    }
  } catch (error) {
    if (error.status !== 400) throw error;
    result.reason = error.message;
  }
  return result;
}

export function parseContactImport(input) {
  allowed(input, ['format', 'content', 'preserveInvalid']);
  if (input.preserveInvalid !== undefined && typeof input.preserveInvalid !== 'boolean') fail(400, 'Informe se deseja preservar telefones inválidos para revisão.');
  if (!['csv', 'json'].includes(input.format) || typeof input.content !== 'string') fail(400, 'Informe arquivo CSV ou JSON em texto.');
  if (Buffer.byteLength(input.content, 'utf8') > CONTACT_IMPORT_LIMITS.bytes) fail(413, 'O arquivo deve ter até 5 MiB.');
  return (input.format === 'csv' ? csvMatrix(input.content) : jsonRows(input.content)).map(item => normalizedRow(item, input.preserveInvalid === true));
}

function identity(row, channelId) { return { channelId, kind: 'person', externalId: row.phone + '@s.whatsapp.net' }; }
function sameIdentity(left, right) { return left.channelId === right.channelId && left.kind === right.kind && left.externalId === right.externalId; }
function safePhone(value) { try { return normalizeImportedPhone(value); } catch { return ''; } }
function classify(rows, state, channelId) {
  const groups = new Map(), ownerIndex = new Map(), sourceIndex = new Map(), unverifiedPhones = new Set();
  for (const contact of contactsOf(state)) {
    const identities = contact.identities || [], phone = safePhone(contact.phone);
    if (contact.importSource?.provider === 'mepchat' && typeof contact.importSource.ref === 'string') {
      const owners = sourceIndex.get(contact.importSource.ref) || []; owners.push(contact); sourceIndex.set(contact.importSource.ref, owners);
    }
    for (const item of identities) if (item.channelId === channelId && item.kind === 'person') {
      const owners = ownerIndex.get(item.externalId) || [];
      if (!owners.includes(contact)) owners.push(contact);
      ownerIndex.set(item.externalId, owners);
    }
    if (phone && (!identities.length || identities.some(item => item.channelId === channelId)) && !identities.some(item => sameIdentity(item, identity({ phone }, channelId)))) unverifiedPhones.add(phone);
  }
  const result = structuredClone(rows);
  const sourceGroups = new Map();
  for (const row of result) if (['valid', 'review'].includes(row.status) && row.sourceRef) {
    const list = sourceGroups.get(row.sourceRef) || []; list.push(row); sourceGroups.set(row.sourceRef, list);
  }
  for (const [ref, group] of sourceGroups) {
    const first = group[0], owners = sourceIndex.get(ref) || [];
    let conflict;
    if (new Set(group.map(row => JSON.stringify([row.status, signature(row)]))).size > 1) conflict = 'A mesma referência de origem possui dados diferentes no arquivo.';
    else if (owners.length > 1) conflict = 'A referência de origem possui cadastros conflitantes na empresa.';
    else if (owners[0]?.archivedAt || owners[0]?.type === 'group') conflict = 'A referência de origem pertence a um cadastro arquivado ou de tipo diferente.';
    else if (owners.length) {
      const owner = owners[0], matches = signature({ ...owner, phone: owner.phone ? safePhone(owner.phone) : '', email: owner.email || '', notes: owner.notes || '', tags: owner.tags || [] }) === signature(first);
      const kindMatches = first.status === 'review' ? !owner.phone && !(owner.identities || []).length : (owner.identities || []).some(item => sameIdentity(item, identity(first, channelId)));
      if (!matches || !kindMatches) conflict = 'A referência de origem já existe com outros dados ou destino; o cadastro atual será preservado.';
    }
    if (conflict) for (const row of group) { row.status = 'conflict'; row.reason = conflict; }
    else group.forEach((row, index) => {
      if (owners.length || index) { row.status = 'duplicate'; row.reason = owners.length ? 'Referência de origem já cadastrada nesta empresa.' : 'Referência de origem repetida no arquivo.'; }
    });
  }
  for (const row of result) if (row.status === 'valid') {
    const list = groups.get(row.phone) || []; list.push(row); groups.set(row.phone, list);
  }
  for (const group of groups.values()) {
    const first = group[0], target = identity(first, channelId);
    const owners = ownerIndex.get(target.externalId) || [];
    let conflict;
    if (new Set(group.map(signature)).size > 1) conflict = 'O arquivo possui dados diferentes para a mesma identidade.';
    else if (owners.length > 1) conflict = 'A identidade já possui vínculos conflitantes na empresa.';
    else if (owners[0]?.type === 'group') conflict = 'A identidade existente tem tipo conflitante; nenhum cadastro foi alterado.';
    else if (owners[0]?.archivedAt) conflict = 'A identidade pertence a um contato arquivado; nenhum cadastro foi alterado.';
    else if (owners.length && signature({ ...owners[0], phone: safePhone(owners[0].phone), email: owners[0].email || '', notes: owners[0].notes || '', tags: owners[0].tags || [] }) !== signature(first)) conflict = 'A identidade já existe com dados diferentes; o cadastro atual será preservado.';
    else if (!owners.length && unverifiedPhones.has(first.phone)) conflict = 'Há cadastro com este telefone sem identidade confirmada neste canal.';
    if (conflict) for (const row of group) { row.status = 'conflict'; row.reason = conflict; }
    else group.forEach((row, index) => {
      if (owners.length || index) { row.status = 'duplicate'; row.reason = owners.length ? 'Identidade já cadastrada neste canal.' : 'Identidade repetida no arquivo.'; }
    });
  }
  return result;
}
function countsOf(rows) {
  const counts = { total: rows.length, valid: 0, review: 0, duplicate: 0, conflict: 0, invalid: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}
function stateVersion(state, channelId) {
  return digest({ channel: (state.channels || []).find(item => item.id === channelId)?.kind, contacts: contactsOf(state).map(contact => ({ id: contact.id, version: contact.version, name: contact.name, phone: contact.phone || '', email: contact.email || '', notes: contact.notes || '', tags: contact.tags || [], type: contact.type, archivedAt: contact.archivedAt || '', identities: contact.identities || [], importSource: contact.importSource ? { provider: contact.importSource.provider, ref: contact.importSource.ref } : null })) });
}

/** Creates only CRM records, inside Store.mutate; it never touches inbox/outbox/transports. */
export class ContactImportService {
  constructor(store, auth, { clock = Date.now } = {}) {
    if (!store || typeof auth?.can !== 'function' || typeof clock !== 'function') throw new TypeError('Importação exige Store e autorização.');
    this.store = store; this.auth = auth; this.clock = clock; this.previews = new Map();
  }
  context(actor, tenantId, channelId, state = this.store.tenant(actor, tenantId)) {
    if (typeof actor?.userId !== 'string' || !actor.userId) fail(403, 'Seu acesso não permite importar contatos.');
    // New identities have no conversation/department metadata. Department-limited actors
    // cannot authorize them through an unrelated conversation or a browser-supplied scope.
    const scope = { tenantId, channelId };
    if (!this.auth.can(actor, 'contacts.read', scope) || !this.auth.can(actor, 'contacts.write', scope)) fail(403, 'Seu acesso não permite importar contatos neste canal.');
    const channel = (state.channels || []).find(item => item.id === channelId);
    if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
    if (!['whatsapp_qr', 'whatsapp_cloud'].includes(channel.kind)) fail(400, 'Escolha um canal WhatsApp para importar contatos por telefone.');
    return state;
  }
  prune() {
    for (const [id, preview] of this.previews) if (preview.expiresAt <= this.clock()) this.previews.delete(id);
  }
  requireSourceAccess(actor, tenantId) {
    if (!this.auth.can(actor, 'contacts.read', { tenantId }) || !this.auth.can(actor, 'contacts.write', { tenantId })) fail(403, 'Preservar contatos sem telefone ou usar referências de origem exige acesso completo aos contatos da empresa.');
  }
  preview(actor, tenantId, input) {
    allowed(input, ['channelId', 'format', 'content', 'preserveInvalid']);
    const channelId = scalar(input.channelId, 120, 'Canal');
    const state = this.context(actor, tenantId, channelId);
    if (input.preserveInvalid === true) this.requireSourceAccess(actor, tenantId);
    const parsed = parseContactImport({ format: input.format, content: input.content, preserveInvalid: input.preserveInvalid });
    const sourceAccess = input.preserveInvalid === true || parsed.some(row => row.sourceRef);
    if (sourceAccess) this.requireSourceAccess(actor, tenantId);
    const rows = classify(parsed, state, channelId);
    const counts = countsOf(rows);
    if (contactsOf(state).length + counts.valid + counts.review > 10000) fail(409, 'A importação excede o limite de 10.000 contatos da empresa.');
    this.prune();
    while (this.previews.size >= CONTACT_IMPORT_LIMITS.previews) this.previews.delete(this.previews.keys().next().value);
    const previewId = randomUUID(), expiresAt = this.clock() + CONTACT_IMPORT_LIMITS.ttlMs;
    const preview = { previewId, userId: actor.userId, resellerId: actor.resellerId, tenantId, channelId, sourceAccess, hash: digest({ tenantId, channelId, rows }), version: stateVersion(state, channelId), expiresAt, rows, counts };
    this.previews.set(previewId, preview);
    return { previewId, hash: preview.hash, version: preview.version, channelId, expiresAt: new Date(expiresAt).toISOString(), counts: { ...counts }, rows: structuredClone(rows.slice(0, CONTACT_IMPORT_LIMITS.previewRows)), truncated: rows.length > CONTACT_IMPORT_LIMITS.previewRows };
  }
  apply(actor, tenantId, input) {
    allowed(input, ['previewId', 'hash', 'version']);
    if (typeof input.previewId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.previewId) || ![input.hash, input.version].every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) fail(400, 'Informe a prévia e sua revisão atual.');
    this.prune();
    const preview = this.previews.get(input.previewId);
    if (!preview || preview.userId !== actor?.userId || preview.resellerId !== actor?.resellerId || preview.tenantId !== tenantId) fail(409, 'A prévia expirou ou não pertence a este acesso. Gere outra prévia.');
    if (preview.hash !== input.hash || preview.version !== input.version) fail(409, 'A prévia mudou. Gere outra prévia.');
    const state = this.context(actor, tenantId, preview.channelId);
    if (preview.sourceAccess) this.requireSourceAccess(actor, tenantId);
    if (preview.result) return { ...structuredClone(preview.result), replayed: true };
    if (stateVersion(state, preview.channelId) !== preview.version) fail(409, 'Os contatos ou o canal mudaram. Gere outra prévia antes de importar.');
    const run = current => {
      this.context(actor, tenantId, preview.channelId, current);
      if (preview.sourceAccess) this.requireSourceAccess(actor, tenantId);
      if (stateVersion(current, preview.channelId) !== preview.version) fail(409, 'Os contatos ou o canal mudaram. Gere outra prévia antes de importar.');
      const rows = classify(preview.rows.filter(row => ['valid', 'review'].includes(row.status)).map(row => ({ ...row })), current, preview.channelId);
      if (rows.some(row => !['valid', 'review'].includes(row.status))) fail(409, 'Uma identidade ou referência de origem mudou. Gere outra prévia antes de importar.');
      if (contactsOf(current).length + rows.length > 10000) fail(409, 'Limite de contatos do piloto atingido.');
      const createdAt = new Date(this.clock()).toISOString(), contactIds = [];
      if (rows.length) current.contacts ||= [];
      for (const row of rows) {
        const id = randomUUID();
        current.contacts.push({ id, name: row.name, type: 'person', phone: row.phone, email: row.email, notes: row.notes, tags: [...row.tags], identities: row.status === 'review' ? [] : [identity(row, preview.channelId)], ...(row.sourceRef ? { importSource: { provider: 'mepchat', ref: row.sourceRef } } : {}), version: 1, createdAt, updatedAt: createdAt });
        contactIds.push(id);
      }
      return { imported: contactIds.length, reviewImported: rows.filter(row => row.status === 'review').length, duplicate: preview.counts.duplicate, conflict: preview.counts.conflict, invalid: preview.counts.invalid, counts: { ...preview.counts }, contactIds, replayed: false };
    };
    const result = preview.counts.valid + preview.counts.review ? this.store.mutate(actor, tenantId, 'CRM: contatos importados', run) : run(state);
    preview.result = structuredClone(result);
    // Applied previews retain only their receipt for retry; contact content is released.
    preview.rows = [];
    return result;
  }
}
