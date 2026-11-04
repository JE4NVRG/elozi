import { randomUUID, createHash } from 'node:crypto';
import { fail, text } from './store.js';

const editable = new Set(['name', 'type', 'email', 'phone', 'notes', 'tags']);
const types = ['person', 'company', 'group'];
const CONTACT_LIMIT = 10000;
const MERGE_JOURNAL_LIMIT = 100;
const MERGE_JOURNAL_BYTES = 2 * 1024 * 1024;
const now = () => new Date().toISOString();
const contactKind = contact => contact.type === 'group' ? 'group' : 'person';
const sameIdentity = (left, right) => left.channelId === right.channelId && left.kind === right.kind && left.externalId === right.externalId;
const scopeOf = (tenantId, conversation, state) => ({ tenantId, channelId: conversation.channelId, departmentId: conversation.departmentId || (state.departments || []).find(department => department.name === conversation.department)?.id || 'unassigned' });

function inputObject(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(400, 'Informe os dados do contato.');
  if (Reflect.ownKeys(input).some(key => !allowed.has(key))) fail(400, 'Edite somente os campos permitidos do contato.');
  return input;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Informe a versão atual.');
  return value;
}
function optionalText(value, max, label) {
  if (typeof value !== 'string' || value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(400, `Informe ${label} com até ${max} caracteres.`);
  return value.trim();
}

/** Keeps the friendly display string in contact.phone; canonical digits are derived. */
export function normalizeContactPhone(value) {
  const friendly = optionalText(value, 30, 'um telefone');
  if (!friendly) return '';
  if (!/^\+?[0-9 ()-]+$/.test(friendly)) fail(400, 'Informe um telefone brasileiro com DDD.');
  let digits = friendly.replace(/\D/g, '');
  if (!friendly.startsWith('+') && (digits.length === 10 || digits.length === 11)) digits = '55' + digits;
  if (!/^55\d{10,11}$/.test(digits)) fail(400, 'Informe um telefone brasileiro com DDD.');
  return digits;
}

function fields(input, previous = null) {
  const result = previous ? { name: previous.name, type: previous.type, email: previous.email || '', phone: previous.phone || '', notes: previous.notes || '', tags: [...(previous.tags || [])] } : { name: '', type: 'person', email: '', phone: '', notes: '', tags: [] };
  if (Object.hasOwn(input, 'name')) {
    result.name = text(input.name, 80);
    if (/[\x00-\x1f\x7f]/.test(result.name)) fail(400, 'Informe um nome válido.');
  }
  if (!result.name) fail(400, 'Informe o nome do contato.');
  if (Object.hasOwn(input, 'type')) {
    if (!types.includes(input.type)) fail(400, 'Escolha pessoa, empresa ou grupo.');
    result.type = input.type;
  }
  if (Object.hasOwn(input, 'email')) {
    result.email = optionalText(input.email, 254, 'um e-mail').toLowerCase();
    if (result.email && (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(result.email) || result.email.startsWith('.') || result.email.split('@')[0].endsWith('.') || result.email.includes('..'))) fail(400, 'Informe um e-mail válido.');
  }
  if (Object.hasOwn(input, 'phone')) {
    result.phone = optionalText(input.phone, 30, 'um telefone');
    normalizeContactPhone(result.phone);
  }
  if (Object.hasOwn(input, 'notes')) result.notes = optionalText(input.notes, 2000, 'anotações');
  if (Object.hasOwn(input, 'tags')) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) fail(400, 'Informe até vinte etiquetas.');
    result.tags = [...new Set(input.tags.map(tag => {
      const clean = text(tag, 40);
      if (/[\x00-\x1f\x7f]/.test(clean)) fail(400, 'Informe etiquetas válidas.');
      return clean;
    }))];
  }
  if (result.type === 'group' && result.phone) fail(400, 'Grupo não usa um telefone individual no cadastro.');
  return result;
}

function contactsOf(state) { return Array.isArray(state.contacts) ? state.contacts : []; }
function findContact(state, id) {
  const contact = typeof id === 'string' && contactsOf(state).find(item => item.id === id);
  if (!contact) fail(404, 'Contato não encontrado nesta empresa.');
  return contact;
}
function requireVersion(contact, supplied) {
  version(supplied);
  if (contact.version !== supplied) fail(409, 'O contato mudou. Atualize antes de continuar.');
}
function fingerprint(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function requireRevision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(400, 'Informe a revisão atual da prévia.');
}
function linkSnapshot(conversation) {
  // Only fields changed by CRM are retained. Message contents are never copied
  // into the recovery journal; their current fingerprint still detects races.
  return Object.fromEntries(['id', 'contactId', 'contactSyncStatus', 'version', 'updatedAt']
    .filter(key => Object.hasOwn(conversation, key)).map(key => [key, conversation[key]]));
}
function publicLinks(conversations) {
  return conversations.map(conversation => ({ conversationId: conversation.id, contactId: conversation.contactId || null,
    version: conversation.version, ...(conversation.contactSyncStatus ? { contactSyncStatus: conversation.contactSyncStatus } : {}) }));
}
function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(snapshot));
}
function duplicatePhone(state, contact, exceptId = null) {
  if (contact.type === 'group' || !contact.phone) return;
  const canonical = normalizeContactPhone(contact.phone);
  if (contactsOf(state).some(item => item.id !== exceptId && !item.archivedAt && item.type !== 'group' && item.phone && normalizeContactPhone(item.phone) === canonical)) fail(409, 'Já existe um contato ativo com esse telefone nesta empresa.');
}

function channelOf(state, channelId) {
  const channel = (state.channels || []).find(item => item.id === channelId);
  if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
  return channel;
}

/** Only consumes existing server-side conversation metadata, never browser identity input. */
function conversationIdentity(state, conversation, channel) {
  const registered = channelOf(state, conversation.channelId);
  if (!channel || channel.id !== registered.id || channel.kind !== registered.kind) fail(400, 'Use o canal de origem da conversa.');
  let externalId, isGroup = conversation.conversationKind === 'group';
  if (channel.kind?.startsWith('whatsapp') && typeof conversation.remoteJid === 'string') {
    externalId = conversation.remoteJid;
    if (!/^(?:\d+(?::\d+)?@(s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(externalId)) fail(400, 'Identidade WhatsApp da conversa inválida.');
    const remoteGroup = externalId.endsWith('@g.us');
    if (conversation.conversationKind && isGroup !== remoteGroup) fail(409, 'O tipo da conversa não corresponde à identidade.');
    isGroup = remoteGroup;
  } else if (['telegram','telegram_user'].includes(channel.kind) && typeof conversation.remoteChatId === 'string') {
    externalId = conversation.remoteChatId;
    if (!/^-?\d+$/.test(externalId)) fail(400, 'Identidade Telegram da conversa inválida.');
    if (!conversation.conversationKind) isGroup = externalId.startsWith('-');
    else if (isGroup !== externalId.startsWith('-')) fail(409, 'O tipo da conversa não corresponde à identidade.');
  } else if (channel.kind === 'webchat' && conversation.webchatVisitor?.verified === true && typeof conversation.webchatVisitor.externalId === 'string') {
    externalId = conversation.webchatVisitor.externalId;
    if (!externalId || externalId.length > 300 || /[\x00-\x1f\x7f]/.test(externalId)) fail(400,'Identidade webchat inválida.');
    isGroup = false;
  } else {
    if (typeof conversation.id !== 'string' || !conversation.id || conversation.id.length > 120) fail(400, 'Conversa sem identidade válida.');
    externalId = 'conversation:' + conversation.id;
  }
  return { channelId: channel.id, kind: isGroup ? 'group' : 'person', externalId, ...(channel.kind === 'webchat' && conversation.webchatVisitor?.verified === true ? {verified:true} : {}) };
}
function identityOwner(state, identity) {
  const matches = contactsOf(state).filter(contact => (contact.identities || []).some(item => sameIdentity(item, identity)));
  if (matches.length > 1) fail(409, 'A identidade da conversa possui vínculos conflitantes.');
  return matches[0] || null;
}
function ensureKind(contact, identity) {
  if (contactKind(contact) !== identity.kind) fail(409, 'Pessoas e grupos precisam de contatos separados.');
}
function phoneFromIdentity(identity) {
  if (identity.kind !== 'person' || !/^55\d{10,11}@s\.whatsapp\.net$/.test(identity.externalId)) return '';
  return identity.externalId.split('@')[0];
}
function publicIdentity(identity) {
  const phone = phoneFromIdentity(identity);
  return { channelId: identity.channelId, kind: identity.kind, label: phone ? `WhatsApp · final ${phone.slice(-4)}` : identity.kind === 'group' ? 'Grupo vinculado' : 'Contato vinculado', ...(identity.verified === true ? {verified:true,externalId:identity.externalId} : {}) };
}

function readIdentityMatches(state) {
  const index = new Map();
  const key = (contactId, identity) => JSON.stringify([contactId, identity.channelId, identity.kind, identity.externalId]);
  for (const conversation of state.conversations || []) {
    const channel = (state.channels || []).find(item => item.id === conversation.channelId);
    if (!channel) continue;
    try {
      const identity = conversationIdentity(state, conversation, channel), id = key(conversation.contactId || null, identity);
      const matches = index.get(id) || []; matches.push(conversation); index.set(id, matches);
    } catch { /* Invalid/stale persisted identities do not grant contact visibility. */ }
  }
  return (contact, identity) => [...(index.get(key(contact.id, identity)) || []), ...(index.get(key(null, identity)) || [])];
}

/** Public business metadata only; remote IDs, aliases and arbitrary persisted fields are omitted. */
export function publicContact(contact, identities = contact.identities || []) {
  return { id: contact.id, name: contact.name, type: contact.type, email: contact.email || '', phone: contact.phone || '', notes: contact.notes || '', tags: [...(contact.tags || [])], identities: identities.map(publicIdentity), version: contact.version, createdAt: contact.createdAt, updatedAt: contact.updatedAt, ...(contact.archivedAt ? { archivedAt: contact.archivedAt } : {}), ...(contact.mergedIntoId ? { mergedIntoId: contact.mergedIntoId } : {}) };
}

/**
 * Lazy backfill inside the gateway's existing audited Store.mutate only.
 * It has no I/O, never merges by phone/alias/name, and is idempotent for the same remote identity.
 * It returns an INTERNAL contact. Use publicContact before serializing it.
 */
export function syncConversationContact(state, conversation, channel) {
  return syncContact(state, conversation, channel, false);
}

/** Read-only identity proof for private context. Never backfills or follows aliases. */
export function boundConversationContact(state, conversation) {
  if (!conversation.contactId) return null;
  const channel=channelOf(state,conversation.channelId);
  const contact=findContact(state,conversation.contactId);
  if(contact.archivedAt||contact.mergedIntoId)fail(409,'O vínculo do atendimento precisa de um contato ativo.');
  const identity=conversationIdentity(state,conversation,channel);
  ensureKind(contact,identity);
  const owner=identityOwner(state,identity);
  if(!owner||owner.id!==contact.id||!(contact.identities||[]).some(item=>sameIdentity(item,identity)))fail(409,'A identidade do atendimento não corresponde ao contato vinculado.');
  return contact;
}

/**
 * Incoming-only variant, inside the adapter's already-authorized transaction.
 * Capacity leaves the message admissible and marks the conversation for a later
 * incoming retry. Other failures still throw; no identity/configuration error is
 * translated into a capacity warning. Never serialize the internal contact.
 */
export function syncIncomingConversationContact(state, conversation, channel) {
  return syncContact(state, conversation, channel, true);
}

function syncContact(state, conversation, channel, incoming) {
  const identity = conversationIdentity(state, conversation, channel);
  const existingOwner = identityOwner(state, identity);
  let contact = conversation.contactId ? findContact(state, conversation.contactId) : existingOwner;
  if (contact && existingOwner && existingOwner.id !== contact.id) fail(409, 'A identidade da conversa já pertence a outro contato.');
  if (contact) ensureKind(contact, identity);
  if (!contact) {
    const name = String(conversation.contact || (identity.kind === 'group' ? 'Grupo' : 'Contato')).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) || 'Contato';
    const email = ['email','webchat'].includes(channel.kind) ? fields({name,email:channel.kind === 'email' ? conversation.remoteEmail ?? '' : conversation.webchatVisitor?.email || ''}).email : '';
    if (contactsOf(state).length >= CONTACT_LIMIT) {
      if (!incoming) fail(409, 'Limite de contatos do piloto atingido.');
      conversation.contactSyncStatus = 'capacity';
      return { code: 'CONTACT_CAPACITY', limit: CONTACT_LIMIT };
    }
    const timestamp = now();
    contact = { id: randomUUID(), name, ...(['whatsapp-profile', 'whatsapp-agenda'].includes(conversation.contactNameSource) ? { nameSource: conversation.contactNameSource } : {}), type: identity.kind === 'group' ? 'group' : 'person', email, phone: phoneFromIdentity(identity), notes: '', tags: [], identities: [identity], version: 1, createdAt: timestamp, updatedAt: timestamp };
    state.contacts ||= [];
    state.contacts.push(contact);
  } else if (!(contact.identities || []).some(item => sameIdentity(item, identity))) {
    contact.identities ||= [];
    contact.identities.push(identity);
    contact.version++; contact.updatedAt = now();
  }
  conversation.contactId = contact.id;
  if (incoming && channel.kind === 'webchat' && conversation.webchatVisitor) {
    const email = fields({name:contact.name,email:conversation.webchatVisitor.email || ''}).email;
    if (email && !contact.email && !contact.archivedAt) { contact.email = email; contact.version++; contact.updatedAt = now(); }
  }
  if (incoming || conversation.contactSyncStatus === 'capacity') conversation.contactSyncStatus = 'linked';
  return contact;
}

export class ContactService {
  constructor(store, auth) {
    if (!store || typeof auth?.can !== 'function') throw new TypeError('CRM exige Store e autorização de acesso.');
    this.store = store; this.auth = auth; this.readSequence = 0;
    store.db.exec(`CREATE TABLE IF NOT EXISTS contact_merge_journals (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      reseller_id TEXT NOT NULL REFERENCES resellers(id), data TEXT NOT NULL CHECK(json_valid(data))
    ); CREATE INDEX IF NOT EXISTS contact_merge_journals_scope ON contact_merge_journals(tenant_id,reseller_id);`);
  }
  mergeJournals(actor, tenantId, targetId) {
    const rows = targetId === undefined
      ? this.store.db.prepare('SELECT data FROM contact_merge_journals WHERE tenant_id=? AND reseller_id=? ORDER BY rowid').all(tenantId, actor.resellerId)
      : this.store.db.prepare("SELECT data FROM contact_merge_journals WHERE tenant_id=? AND reseller_id=? AND json_extract(data,'$.targetId')=? ORDER BY rowid").all(tenantId, actor.resellerId, targetId);
    return rows.map(row => JSON.parse(row.data));
  }
  require(actor, permission, scope, checker = null) {
    if (!(checker ? checker.can(scope) : this.auth.can(actor, permission, scope))) fail(403, 'Seu acesso não permite esta operação.');
  }
  related(state, contact) {
    return (state.conversations || []).filter(conversation => {
      if (conversation.contactId === contact.id) return true;
      if (conversation.contactId) return false;
      const channel = (state.channels || []).find(item => item.id === conversation.channelId);
      if (!channel) return false;
      try { return (contact.identities || []).some(item => sameIdentity(item, conversationIdentity(state, conversation, channel))); }
      catch { return false; }
    });
  }
  identityAllowed(actor, permission, tenantId, state, contact, identity, allRelated = false, checker = null) {
    if (!(state.channels || []).some(channel => channel.id === identity.channelId)) return false;
    const can = scope => checker ? checker.can(scope) : this.auth.can(actor, permission, scope);
    if (can({ tenantId, channelId: identity.channelId })) return true;
    const matching = checker?.matches ? checker.matches(contact, identity) : this.related(state, contact).filter(conversation => {
      if (conversation.channelId !== identity.channelId) return false;
      const channel = (state.channels || []).find(item => item.id === identity.channelId);
      try { return channel && sameIdentity(identity, conversationIdentity(state, conversation, channel)); }
      catch { return false; }
    });
    return matching.length > 0 && (allRelated ? matching.every(conversation => can(scopeOf(tenantId, conversation, state))) : matching.some(conversation => can(scopeOf(tenantId, conversation, state))));
  }
  canContact(actor, permission, tenantId, state, contact, all = false, checker = null) {
    if (checker ? checker.can({ tenantId }) : this.auth.can(actor, permission, { tenantId })) return true;
    const identities = contact.identities || [];
    return identities.length > 0 && (all ? identities.every(identity => this.identityAllowed(actor, permission, tenantId, state, contact, identity, true, checker)) : identities.some(identity => this.identityAllowed(actor, permission, tenantId, state, contact, identity, false, checker)));
  }
  requireContact(actor, permission, tenantId, state, contact, all = false) {
    if (!this.canContact(actor, permission, tenantId, state, contact, all)) fail(403, 'Seu acesso não permite operar este contato.');
  }
  view(actor, tenantId, state, contact, checker = null) {
    const value = publicContact(contact, (contact.identities || []).filter(identity => this.identityAllowed(actor, 'contacts.read', tenantId, state, contact, identity, false, checker)));
    for (const journal of [...(checker?.mergeJournals || this.mergeJournals(actor, tenantId, contact.id))].reverse()) {
      if (journal.targetId !== contact.id || journal.undoneAt) continue;
      try {
        this.undoContext(actor, tenantId, checker?.undoState ? checker.undoState(journal) : state, contact.id, journal.id, journal);
        value.reversibleMergeId = journal.id; break;
      } catch (error) {
        if (![400, 403, 404, 409].includes(error.status)) throw error;
      }
    }
    return value;
  }
  list(actor, tenantId, options = {}) {
    // Keep current authority, private header, identity metadata and any scoped
    // recovery fingerprints in one synchronous SQLite read snapshot.
    const savepoint = `contacts_list_${++this.readSequence}`;
    this.store.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = this.listSnapshot(actor, tenantId, options);
      this.store.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) { this.store.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  listSnapshot(actor, tenantId, options) {
    inputObject(options, new Set(['search', 'includeArchived']));
    const search = optionalText(options.search ?? '', 160, 'uma busca').toLocaleLowerCase('pt-BR');
    if (options.includeArchived !== undefined && typeof options.includeArchived !== 'boolean') fail(400, 'Informe se deseja incluir contatos arquivados.');
    const snapshot = typeof this.auth.createTenantPermissionChecker === 'function' ? this.auth.createTenantPermissionChecker(actor, 'contacts.read', tenantId) : null;
    const header = snapshot?.state || this.store.readonlyTenantHeader(actor, tenantId);
    const checker = { can: snapshot?.can || (scope => this.auth.can(actor, 'contacts.read', scope)) };
    this.require(actor, 'contacts.read', { tenantId, aggregate: true }, checker);
    const summaries = this.store.serviceTenant(actor.resellerId, tenantId).conversations;
    // The shared service DTO intentionally excludes private webchat proof.
    // CRM needs only these two trusted fields, not visitor email/profile or history.
    const webchatChannels = new Set((header.channels || []).filter(channel => channel.kind === 'webchat').map(channel => channel.id));
    const webchatConversations = summaries.filter(conversation => webchatChannels.has(conversation.channelId)).map(conversation => conversation.id);
    const visitors = new Map((webchatConversations.length ? this.store.db.prepare(`SELECT c.id,
        json_extract(c.data,'$.webchatVisitor.verified') AS verified,
        CASE WHEN json_type(c.data,'$.webchatVisitor.externalId')='text'
          THEN json_extract(c.data,'$.webchatVisitor.externalId') END AS externalId,
        json_type(c.data,'$.webchatVisitor.verified') AS verifiedType
      FROM tenants t JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id AND p.valid=1
      JOIN service_read_model_meta m ON m.id='routing' AND m.version=9
      JOIN service_conversation_private c ON c.tenant_id=t.id
      WHERE t.id=? AND t.reseller_id=? AND c.id IN (SELECT value FROM json_each(?))
        AND json_type(c.data,'$.webchatVisitor')='object'`).all(tenantId, actor.resellerId, JSON.stringify(webchatConversations)) : [])
      .map(row => [row.id, { verified: row.verifiedType === 'true' && row.verified === 1, externalId: row.externalId }]));
    const state = { ...header, conversations: summaries.map(conversation => visitors.has(conversation.id)
      ? { ...conversation, webchatVisitor: visitors.get(conversation.id) } : conversation) };
    checker.matches = readIdentityMatches(state);
    checker.mergeJournals = this.mergeJournals(actor, tenantId);
    const fullConversations = new Map();
    checker.undoState = journal => {
      const source = findContact(state, journal.sourceId), target = findContact(state, journal.targetId);
      const conversations = this.mergeConversations(state, source, target).map(conversation => {
        if (!fullConversations.has(conversation.id)) fullConversations.set(conversation.id,
          this.store.readonlyConversationTenant(actor, tenantId, conversation.id).conversations[0]);
        return fullConversations.get(conversation.id);
      });
      return { ...state, conversations };
    };
    return contactsOf(state).filter(contact => (options.includeArchived || !contact.archivedAt) && this.canContact(actor, 'contacts.read', tenantId, state, contact, false, checker) && `${contact.name} ${contact.email || ''} ${contact.phone || ''} ${normalizeContactPhone(contact.phone || '')} ${(contact.tags || []).join(' ')}`.toLocaleLowerCase('pt-BR').includes(search)).map(contact => this.view(actor, tenantId, state, contact, checker));
  }
  snapshot(actor, tenantId, options = {}, since = '') {
    // Authorization and redaction are repeated before comparing a revision.
    // A cached revision never grants access to the underlying agenda.
    const contacts = this.list(actor, tenantId, options);
    if (typeof since !== 'string' || since && !/^[a-f0-9]{64}$/.test(since)) fail(400, 'Informe uma revisão válida da agenda.');
    const revision = createHash('sha256').update(JSON.stringify([actor.userId, actor.resellerId, tenantId, options.search || '', Boolean(options.includeArchived), contacts])).digest('hex');
    return since === revision ? { revision, unchanged: true } : { contacts, revision, unchanged: false };
  }
  get(actor, tenantId, contactId) {
    const state = this.store.tenant(actor, tenantId), contact = findContact(state, contactId);
    this.requireContact(actor, 'contacts.read', tenantId, state, contact);
    return this.view(actor, tenantId, state, contact);
  }
  create(actor, tenantId, input) {
    inputObject(input, editable);
    const values = fields(input);
    return this.store.mutate(actor, tenantId, 'CRM: contato criado', state => {
      this.require(actor, 'contacts.write', { tenantId });
      if (contactsOf(state).length >= CONTACT_LIMIT) fail(409, 'Limite de contatos do piloto atingido.');
      duplicatePhone(state, values);
      const timestamp = now(), contact = { id: randomUUID(), ...values, identities: [], version: 1, createdAt: timestamp, updatedAt: timestamp };
      state.contacts ||= []; state.contacts.push(contact);
      return this.view(actor, tenantId, state, contact);
    });
  }
  update(actor, tenantId, contactId, input) {
    inputObject(input, new Set([...editable, 'version'])); version(input.version);
    return this.store.mutate(actor, tenantId, 'CRM: contato atualizado', state => {
      const contact = findContact(state, contactId);
      this.requireContact(actor, 'contacts.write', tenantId, state, contact, true); requireVersion(contact, input.version);
      if (contact.archivedAt) fail(409, 'Reative o contato antes de editar.');
      const values = fields(input, contact);
      if ((contact.identities || []).some(identity => identity.kind !== contactKind(values))) fail(409, 'O tipo precisa preservar as identidades de pessoa ou grupo.');
      if (normalizeContactPhone(values.phone) !== normalizeContactPhone(contact.phone || '')) duplicatePhone(state, values, contact.id);
      if (JSON.stringify(values) !== JSON.stringify(fields({}, contact))) { if (values.name !== contact.name) contact.nameSource = 'manual'; Object.assign(contact, values); contact.version++; contact.updatedAt = now(); }
      return this.view(actor, tenantId, state, contact);
    });
  }
  archive(actor, tenantId, contactId, input) { return this.setArchived(actor, tenantId, contactId, input, true); }
  reactivate(actor, tenantId, contactId, input) { return this.setArchived(actor, tenantId, contactId, input, false); }
  setArchived(actor, tenantId, contactId, input, archived) {
    inputObject(input, new Set(['version'])); version(input.version);
    return this.store.mutate(actor, tenantId, archived ? 'CRM: contato arquivado' : 'CRM: contato reativado', state => {
      const contact = findContact(state, contactId);
      this.requireContact(actor, 'contacts.write', tenantId, state, contact, true); requireVersion(contact, input.version);
      if (!archived && contact.mergedIntoId) fail(409, 'Este contato foi fundido. Use Desfazer fusão no contato de destino.');
      if (Boolean(contact.archivedAt) !== archived) {
        if (archived) contact.archivedAt = now();
        else { duplicatePhone(state, contact, contact.id); delete contact.archivedAt; }
        contact.version++; contact.updatedAt = now();
      }
      return this.view(actor, tenantId, state, contact);
    });
  }
  associationContext(actor, tenantId, state, conversationId, contactId, conversationVersion) {
    const contact = findContact(state, contactId), conversation = this.store.getConversation(state, conversationId, conversationVersion);
    this.requireContact(actor, 'contacts.read', tenantId, state, contact, true);
    this.requireContact(actor, 'contacts.write', tenantId, state, contact, true);
    this.require(actor, 'inbox.read', scopeOf(tenantId, conversation, state));
    this.require(actor, 'contacts.write', scopeOf(tenantId, conversation, state));
    this.require(actor, 'inbox.transfer', scopeOf(tenantId, conversation, state));
    if (contact.archivedAt || contact.mergedIntoId) fail(409, 'Reative o contato ou desfaça sua fusão antes de vincular.');
    const channel = channelOf(state, conversation.channelId), identity = conversationIdentity(state, conversation, channel), owner = identityOwner(state, identity);
    ensureKind(contact, identity);
    if (owner && owner.id !== contact.id) fail(409, 'A identidade da conversa já pertence a outro contato.');
    if (conversation.contactId && conversation.contactId !== contact.id) fail(409, 'A conversa já está vinculada a outro contato.');
    return { contact, conversation, channel, identity };
  }
  associationPreview(actor, tenantId, conversationId, contactId) {
    const state = this.store.tenant(actor, tenantId), current = this.associationContext(actor, tenantId, state, conversationId, contactId);
    return { contact: this.view(actor, tenantId, state, current.contact), conversationId: current.conversation.id,
      channelId: current.channel.id, version: current.conversation.version, kind: current.identity.kind };
  }
  associateConversation(actor, tenantId, conversationId, input) {
    inputObject(input, new Set(['contactId', 'version', 'contactVersion'])); version(input.version);
    if (Object.hasOwn(input, 'contactVersion')) version(input.contactVersion);
    return this.store.mutate(actor, tenantId, 'CRM: conversa vinculada ao contato', state => {
      const { contact, conversation, channel, identity } = this.associationContext(actor, tenantId, state, conversationId, input.contactId, input.version);
      if (Object.hasOwn(input, 'contactVersion')) requireVersion(contact, input.contactVersion);
      const changed = conversation.contactId !== contact.id || !(contact.identities || []).some(item => sameIdentity(item, identity));
      const statusChanged = conversation.contactSyncStatus === 'capacity';
      syncConversationContact(state, { ...conversation, contactId: contact.id }, channel);
      if (changed || statusChanged) {
        conversation.contactId = contact.id;
        if (statusChanged) conversation.contactSyncStatus = 'linked';
        conversation.version++; conversation.updatedAt = now();
      }
      return { contact: this.view(actor, tenantId, state, contact), conversationId: conversation.id, version: conversation.version,
        ...(conversation.contactSyncStatus ? { contactSyncStatus: conversation.contactSyncStatus } : {}) };
    });
  }
  mergeAuthority(actor, tenantId, state, contacts, conversations) {
    for (const contact of contacts) {
      this.requireContact(actor, 'contacts.read', tenantId, state, contact, true);
      this.requireContact(actor, 'contacts.write', tenantId, state, contact, true);
    }
    for (const conversation of conversations) {
      const scope = scopeOf(tenantId, conversation, state);
      this.require(actor, 'inbox.read', scope); this.require(actor, 'inbox.transfer', scope);
    }
  }
  mergeConversations(state, source, target) {
    return [...new Map([...this.related(state, source), ...this.related(state, target)]
      .map(conversation => [conversation.id, conversation])).values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  mergeContext(actor, tenantId, state, sourceId, targetId) {
    const source = findContact(state, sourceId), target = findContact(state, targetId);
    if (source.id === target.id) fail(400, 'Escolha dois contatos diferentes.');
    const conversations = this.mergeConversations(state, source, target);
    this.mergeAuthority(actor, tenantId, state, [source, target], conversations);
    if ([source, target].some(contact => contact.archivedAt || contact.mergedIntoId)) fail(409, 'Use contatos ativos que não tenham sido fundidos.');
    if (contactKind(source) !== contactKind(target)) fail(409, 'Pessoas e grupos precisam de contatos separados.');
    const identities = [];
    for (const identity of [...(target.identities || []), ...(source.identities || [])]) {
      channelOf(state, identity.channelId); ensureKind(target, identity);
      if (contactsOf(state).some(contact => ![source.id, target.id].includes(contact.id)
        && (contact.identities || []).some(item => sameIdentity(item, identity)))) fail(409, 'Uma identidade já pertence a um terceiro contato.');
      if (!identities.some(item => sameIdentity(item, identity))) identities.push(structuredClone(identity));
    }
    for (const conversation of conversations) {
      const identity = conversationIdentity(state, conversation, channelOf(state, conversation.channelId));
      const expected = conversation.contactId === source.id ? source : conversation.contactId === target.id ? target : null;
      if (expected && !(expected.identities || []).some(item => sameIdentity(item, identity))) fail(409, 'A conversa possui vínculo de identidade inconsistente.');
    }
    const values = fields({}, target);
    for (const key of ['name', 'email', 'phone']) if (!values[key]) values[key] = source[key] || '';
    values.tags = [...new Set([...(target.tags || []), ...(source.tags || [])])];
    values.notes = [...new Set([target.notes || '', source.notes || ''].filter(Boolean))].join('\n\n');
    if (values.tags.length > 20 || values.notes.length > 2000) fail(409, 'A fusão excede vinte etiquetas ou 2000 caracteres de anotações. Revise os contatos antes de continuar.');
    fields(values);
    const moved = this.related(state, source).filter(conversation => conversation.contactId !== target.id);
    const revision = fingerprint(['contact-merge', actor.userId, actor.resellerId, actor.supportGrantId || null, tenantId,
      source, target, conversations.map(conversation => [conversation.id, fingerprint(conversation)])]);
    return { source, target, conversations, identities, values, moved, revision };
  }
  mergePreview(actor, tenantId, sourceId, targetId) {
    const state = this.store.tenant(actor, tenantId), current = this.mergeContext(actor, tenantId, state, sourceId, targetId);
    return { sourceContact: this.view(actor, tenantId, state, current.source), targetContact: this.view(actor, tenantId, state, current.target),
      revision: current.revision, conversationCount: current.moved.length };
  }
  merge(actor, tenantId, sourceId, input) {
    inputObject(input, new Set(['targetId', 'sourceVersion', 'targetVersion', 'revision']));
    version(input.sourceVersion); version(input.targetVersion); requireRevision(input.revision);
    return this.store.mutate(actor, tenantId, 'CRM: contatos fundidos com recuperação', state => {
      const current = this.mergeContext(actor, tenantId, state, sourceId, input.targetId);
      const { source, target, conversations, moved } = current;
      requireVersion(source, input.sourceVersion); requireVersion(target, input.targetVersion);
      if (current.revision !== input.revision) fail(409, 'A prévia mudou. Revise os contatos e atendimentos antes de fundir.');
      const journals = this.mergeJournals(actor, tenantId);
      if (journals.length >= MERGE_JOURNAL_LIMIT) fail(409, 'Limite de registros de fusão atingido. Preserve o histórico e revise a operação.');
      const timestamp = now(), journal = { id: randomUUID(), sourceId: source.id, targetId: target.id, createdAt: timestamp,
        before: { source: structuredClone(source), target: structuredClone(target), links: moved.map(linkSnapshot) },
        conversationIds: conversations.map(conversation => conversation.id) };
      source.identities = []; source.archivedAt = timestamp; source.mergedIntoId = target.id; source.version++; source.updatedAt = timestamp;
      Object.assign(target, current.values, { identities: current.identities, version: target.version + 1, updatedAt: timestamp });
      duplicatePhone(state, target, target.id);
      for (const conversation of moved) {
        conversation.contactId = target.id;
        if (conversation.contactSyncStatus === 'capacity') conversation.contactSyncStatus = 'linked';
        conversation.version++; conversation.updatedAt = timestamp;
      }
      journal.after = { source: fingerprint(source), target: fingerprint(target),
        conversations: conversations.map(conversation => ({ id: conversation.id, fingerprint: fingerprint(conversation) })) };
      journals.push(journal);
      if (Buffer.byteLength(JSON.stringify(journals), 'utf8') > MERGE_JOURNAL_BYTES) fail(409, 'O registro de recuperação atingiu seu limite. Preserve o histórico e revise a operação.');
      this.store.db.prepare('INSERT INTO contact_merge_journals(id,tenant_id,reseller_id,data) VALUES (?,?,?,?)')
        .run(journal.id, tenantId, actor.resellerId, JSON.stringify(journal));
      return { sourceContact: this.view(actor, tenantId, state, source), targetContact: this.view(actor, tenantId, state, target),
        mergeId: journal.id, conversationCount: moved.length, links: publicLinks(conversations) };
    });
  }
  undoContext(actor, tenantId, state, targetId, mergeId, loadedJournal) {
    if (typeof mergeId !== 'string' || !mergeId || mergeId.length > 120) fail(400, 'Informe a fusão a desfazer.');
    const journal = loadedJournal || this.mergeJournals(actor, tenantId, targetId).find(item => item.id === mergeId);
    if (journal && (journal.id !== mergeId || journal.targetId !== targetId)) fail(404, 'Fusão não encontrada nesta empresa e contato.');
    if (!journal) fail(404, 'Fusão não encontrada nesta empresa e contato.');
    const source = findContact(state, journal.sourceId), target = findContact(state, targetId);
    const originalSource = { ...journal.before.source, id: source.mergedIntoId === target.id ? target.id : source.id };
    const conversations = this.mergeConversations(state, source, target);
    this.mergeAuthority(actor, tenantId, state, [target, originalSource], conversations);
    if (journal.undoneAt) fail(409, 'Esta fusão já foi desfeita.');
    if (source.mergedIntoId !== target.id || !source.archivedAt
      || fingerprint(source) !== journal.after.source || fingerprint(target) !== journal.after.target
      || fingerprint(conversations.map(conversation => ({ id: conversation.id, fingerprint: fingerprint(conversation) }))) !== fingerprint(journal.after.conversations)) {
      fail(409, 'Os contatos ou atendimentos mudaram após a fusão. O desfazer não pode sobrescrever alterações posteriores.');
    }
    for (const contact of [journal.before.source, journal.before.target]) {
      for (const identity of contact.identities || []) {
        channelOf(state, identity.channelId); ensureKind(contact, identity);
        if (contactsOf(state).some(item => ![source.id, target.id].includes(item.id)
          && (item.identities || []).some(candidate => sameIdentity(candidate, identity)))) fail(409, 'Uma identidade passou a pertencer a outro contato.');
      }
      if (contact.phone && contact.type !== 'group' && contactsOf(state).some(item => ![source.id, target.id].includes(item.id)
        && !item.archivedAt && item.type !== 'group' && item.phone
        && normalizeContactPhone(item.phone) === normalizeContactPhone(contact.phone))) fail(409, 'O telefone original agora pertence a outro contato ativo.');
    }
    return { source, target, journal, conversations, revision: fingerprint(['contact-merge-undo', actor.userId, actor.resellerId,
      actor.supportGrantId || null, tenantId, journal.id, journal.after]), conversationCount: journal.before.links.length };
  }
  mergeUndoPreview(actor, tenantId, targetId, mergeId) {
    const state = this.store.tenant(actor, tenantId), current = this.undoContext(actor, tenantId, state, targetId, mergeId);
    return { sourceContact: this.view(actor, tenantId, state, current.source), targetContact: this.view(actor, tenantId, state, current.target),
      revision: current.revision, conversationCount: current.conversationCount };
  }
  mergeUndo(actor, tenantId, targetId, input) {
    inputObject(input, new Set(['mergeId', 'revision'])); requireRevision(input.revision);
    return this.store.mutate(actor, tenantId, 'CRM: fusão desfeita com recuperação', state => {
      const current = this.undoContext(actor, tenantId, state, targetId, input.mergeId);
      if (current.revision !== input.revision) fail(409, 'A prévia mudou. Atualize antes de desfazer.');
      const { source, target, journal } = current, sourceVersion = source.version, targetVersion = target.version, timestamp = now();
      restoreObject(source, journal.before.source); source.version = sourceVersion + 1; source.updatedAt = timestamp;
      restoreObject(target, journal.before.target); target.version = targetVersion + 1; target.updatedAt = timestamp;
      for (const link of journal.before.links) {
        const conversation = this.store.getConversation(state, link.id), nextVersion = conversation.version + 1;
        for (const key of ['contactId', 'contactSyncStatus']) {
          if (Object.hasOwn(link, key)) conversation[key] = link[key]; else delete conversation[key];
        }
        conversation.version = nextVersion; conversation.updatedAt = timestamp;
      }
      journal.undoneAt = timestamp;
      const saved = this.store.db.prepare('UPDATE contact_merge_journals SET data=? WHERE id=? AND tenant_id=? AND reseller_id=?')
        .run(JSON.stringify(journal), journal.id, tenantId, actor.resellerId);
      if (saved.changes !== 1) fail(409, 'O registro de recuperação mudou. Atualize antes de desfazer.');
      return { sourceContact: this.view(actor, tenantId, state, source), targetContact: this.view(actor, tenantId, state, target),
        conversationCount: current.conversationCount, links: publicLinks(current.conversations) };
    });
  }
  history(actor, tenantId, contactId) {
    const state = this.store.tenant(actor, tenantId), contact = findContact(state, contactId);
    this.requireContact(actor, 'contacts.read', tenantId, state, contact);
    return this.related(state, contact).filter(conversation => this.auth.can(actor, 'inbox.read', scopeOf(tenantId, conversation, state))).map(conversation => ({ id: conversation.id, channelId: conversation.channelId, kind: conversation.conversationKind === 'group' ? 'group' : 'direct', status: conversation.status, updatedAt: conversation.updatedAt, ...(conversation.threadId ? { threadId: conversation.threadId } : {}) }));
  }
  openInput(actor, tenantId, contactId, input) {
    inputObject(input, new Set(['channelId']));
    const state = this.store.tenant(actor, tenantId), contact = findContact(state, contactId), channel = channelOf(state, input.channelId);
    this.requireContact(actor, 'contacts.read', tenantId, state, contact);
    const department = (state.departments || []).find(item => item.active !== false && item.id === state.defaultDepartmentId);
    this.require(actor, 'inbox.reply', { tenantId, channelId: channel.id, departmentId: department?.id || 'unassigned' });
    if (contact.archivedAt) fail(409, 'Reative o contato antes de abrir atendimento.');
    if (contact.type === 'group' || !contact.phone) fail(400, 'Use um contato individual com telefone brasileiro.');
    if (channel.kind !== 'whatsapp_qr' || channel.transport !== 'baileys') fail(400, 'A abertura proativa está disponível no WhatsApp QR.');
    if (channel.state !== 'connected') fail(409, 'O número de origem não está conectado.');
    return { name: contact.name, number: normalizeContactPhone(contact.phone), channelId: channel.id };
  }
}
