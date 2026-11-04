// Address book of a WhatsApp QR channel: the names saved in the phone, as WhatsApp syncs them to linked devices (app state
// "contactAction": contacts.upsert/contacts.update with `name`). They live in wa_contacts, outside the tenant document, and
// only rename what still carries a WhatsApp name: a conversation or CRM contact named from the profile (push name) or from
// an earlier agenda sync. A name a person typed in Elozi (contact.nameSource 'manual') is never replaced.
const PROFILE = 'whatsapp-profile', AGENDA = 'whatsapp-agenda';
export const AGENDA_SOURCES = Object.freeze([PROFILE, AGENDA]);

export function ensureAgendaSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS wa_contacts (channel_id TEXT NOT NULL, jid TEXT NOT NULL, name TEXT NOT NULL, phone_jid TEXT, lid_jid TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(channel_id,jid))');
}

export const agendaName = value => typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
/** A person's JID (phone or LID) without device suffix, or null. Groups, broadcasts and newsletters are not contacts. */
export function personJid(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(value.trim());
  return match ? `${match[1]}@${match[2]}` : null;
}

/** Keeps the saved names of contacts.upsert/update; returns how many rows changed. Entries without `name` are ignored. */
export function rememberAgenda(db, channelId, contacts, now = Date.now()) {
  if (!Array.isArray(contacts)) return 0;
  const select = db.prepare('SELECT name, phone_jid, lid_jid FROM wa_contacts WHERE channel_id=? AND jid=?');
  const upsert = db.prepare('INSERT INTO wa_contacts VALUES (?,?,?,?,?,?) ON CONFLICT(channel_id,jid) DO UPDATE SET name=excluded.name, phone_jid=COALESCE(excluded.phone_jid, wa_contacts.phone_jid), lid_jid=COALESCE(excluded.lid_jid, wa_contacts.lid_jid), updated_at=excluded.updated_at');
  let changed = 0;
  for (const contact of contacts.slice(0, 20000)) {
    const jid = personJid(contact?.id), name = agendaName(contact?.name);
    if (!jid || !name) continue;
    const phone = personJid(contact.phoneNumber) || (jid.endsWith('@s.whatsapp.net') ? jid : null), lid = personJid(contact.lid) || (jid.endsWith('@lid') ? jid : null);
    const before = select.get(channelId, jid), nextPhone = phone || before?.phone_jid || null, nextLid = lid || before?.lid_jid || null;
    if (before && before.name === name && (before.phone_jid || null) === nextPhone && (before.lid_jid || null) === nextLid) continue;
    upsert.run(channelId, jid, name, phone, lid, new Date(now).toISOString());
    changed++;
  }
  return changed;
}

/** jid → saved name for every known form of each contact (its own JID, phone JID and LID). */
export function agendaNames(db, channelId) {
  const names = new Map();
  for (const row of db.prepare('SELECT jid, name, phone_jid, lid_jid FROM wa_contacts WHERE channel_id=? ORDER BY updated_at').all(channelId)) {
    for (const jid of [row.jid, row.phone_jid, row.lid_jid]) if (jid) names.set(jid, row.name);
  }
  return names;
}

export const agendaCount = (db, channelId) => db.prepare('SELECT count(*) AS n FROM wa_contacts WHERE channel_id=?').get(channelId).n;

/** Saved name for a conversation's JIDs, or null. */
export function savedName(names, jids) {
  for (const jid of jids || []) { const name = names.get(personJid(jid)); if (name) return name; }
  return null;
}

/** Contacts of the address book with a phone number, for the CRM import (JSON rows {name, phone}). */
export function agendaRows(db, channelId) {
  const rows = [], seen = new Set();
  for (const row of db.prepare('SELECT name, phone_jid FROM wa_contacts WHERE channel_id=? AND phone_jid IS NOT NULL ORDER BY name').all(channelId)) {
    const phone = `+${row.phone_jid.split('@')[0]}`;
    if (seen.has(phone)) continue; seen.add(phone); rows.push({ name: row.name, phone });
  }
  return rows;
}

const renameable = (conversation, contact) => {
  if (contact?.nameSource === 'manual') return false;
  if (AGENDA_SOURCES.includes(conversation.contactNameSource) || AGENDA_SOURCES.includes(contact?.nameSource)) return true;
  // Conversations from before the agenda: still the name they were created with, never edited in the CRM.
  return !conversation.contactNameSource && (!contact || (contact.version === 1 && contact.name === conversation.contact));
};

/** Applies saved names to the channel's direct conversations (and their CRM contacts); returns how many were renamed. */
export function applyAgendaNames(tenant, channelId, names, now = Date.now()) {
  if (!names.size) return 0;
  let renamed = 0;
  const contacts = new Map((tenant.contacts || []).map(contact => [contact.id, contact]));
  for (const conversation of tenant.conversations || []) {
    if (conversation.channelId !== channelId || conversation.conversationKind === 'group') continue;
    const name = savedName(names, [conversation.remoteJid, ...(conversation.remoteAliases || [])]);
    if (!name) continue;
    const contact = conversation.contactId ? contacts.get(conversation.contactId) : null;
    if (!renameable(conversation, contact)) continue;
    let changed = false;
    if (conversation.contact !== name) { conversation.contact = name; conversation.initials = name.slice(0, 2).toUpperCase(); changed = true; }
    if (conversation.contactNameSource !== AGENDA) { conversation.contactNameSource = AGENDA; changed = true; }
    if (contact && contact.nameSource !== 'manual' && (contact.name !== name || contact.nameSource !== AGENDA)) {
      contact.name = name; contact.nameSource = AGENDA; contact.version = (contact.version || 1) + 1; contact.updatedAt = new Date(now).toISOString(); changed = true;
    }
    if (changed) renamed++;
  }
  return renamed;
}
