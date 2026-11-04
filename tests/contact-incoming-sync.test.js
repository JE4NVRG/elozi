import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publicContact, syncConversationContact, syncIncomingConversationContact } from '../src/contacts.js';

const status = code => error => error.status === code;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const channels = [
  { id: 'web', kind: 'webchat', transport: 'elozi-webchat' },
  { id: 'web-other', kind: 'webchat', transport: 'elozi-webchat' },
  { id: 'mail', kind: 'email', transport: 'mepmail-channel' },
  { id: 'ig', kind: 'instagram', transport: 'meta-instagram' },
  { id: 'fb', kind: 'messenger', transport: 'meta-messenger' },
  { id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' },
  { id: 'tg', kind: 'telegram', transport: 'telegram-bot' },
];
const fixture = (id = 'tenant-a') => ({ id, channels: structuredClone(channels), contacts: [], conversations: [] });
const conversation = (id, channelId, extra = {}) => ({ id, channelId, contact: 'Pessoa sintética', conversationKind: 'direct',
  version: 2, status: 'open', messages: [{ id: 'message-existing', kind: 'customer', text: 'Texto sintético recebido' }], ...extra });
const sync = (state, item, incoming = true) => (incoming ? syncIncomingConversationContact : syncConversationContact)(state, item, state.channels.find(channel => channel.id === item.channelId));
const fullFixture = () => {
  const state = fixture();
  state.contacts = Array.from({ length: 10000 }, (_, i) => ({ id: 'contact-' + i, name: 'Agenda sintética ' + i,
    type: 'person', email: '', phone: '', notes: '', tags: [], identities: [], version: 1 }));
  return state;
};

for (const channelId of ['web', 'mail', 'ig', 'fb']) {
  test(channelId + ': entrada usa identidade da conversa/canal e nunca infere telefone dos metadados', () => {
    const state = fixture(), item = conversation('same-server-conversation-id', channelId, { contact: '11 91234-5678',
      remoteSessionId: 'trusted-session', remoteEmail: 'PERSON@EXAMPLE.TEST', remoteSocialId: '5511912345678', remoteJid: '5511912345678@s.whatsapp.net' });
    state.conversations.push(item);
    const beforeMessages = hash(item.messages), contact = sync(state, item);
    assert.equal(item.contactSyncStatus, 'linked'); assert.equal(item.contactId, contact.id);
    assert.equal(state.contacts.length, 1); assert.equal(contact.type, 'person'); assert.equal(contact.phone, '');
    assert.equal(contact.email, channelId === 'mail' ? 'person@example.test' : '');
    assert.deepEqual(contact.identities, [{ channelId, kind: 'person', externalId: 'conversation:same-server-conversation-id' }]);
    assert.equal(item.version, 2); assert.equal(hash(item.messages), beforeMessages);
    const dto = publicContact(contact);
    assert.deepEqual(dto.identities, [{ channelId, kind: 'person', label: 'Contato vinculado' }]);
    assert.equal(JSON.stringify(dto).includes('conversation:'), false); assert.equal(JSON.stringify(dto).includes('trusted-session'), false);
    const before = hash(state); assert.strictEqual(sync(state, item), contact); assert.equal(hash(state), before);
  });
}

test('nomes, e-mails e sender IDs iguais não fundem sessões, canais ou empresas', () => {
  const state = fixture(), other = fixture('tenant-b'), metadata = { contact: 'Mesmo nome', remoteEmail: 'same@example.test', remoteSocialId: 'same-sender' };
  const first = sync(state, conversation('same-id', 'web', metadata));
  const secondSession = sync(state, conversation('new-session-conversation', 'web', metadata));
  const secondChannel = sync(state, conversation('same-id', 'web-other', metadata));
  const secondTenant = sync(other, conversation('same-id', 'web', metadata));
  const emailA = sync(state, conversation('email-a', 'mail', metadata)), emailB = sync(state, conversation('email-b', 'mail', metadata));
  const metaA = sync(state, conversation('meta-a', 'ig', metadata)), metaB = sync(state, conversation('meta-b', 'fb', metadata));
  assert.equal(new Set([first, secondSession, secondChannel, secondTenant, emailA, emailB, metaA, metaB].map(contact => contact.id)).size, 8);
  assert.equal(emailA.email, emailB.email); assert.equal(state.contacts.length, 7); assert.equal(other.contacts.length, 1);
});

test('e-mail é validado/canonicalizado somente ao criar e não enriquece cadastro existente', () => {
  const state = fixture(), item = conversation('mail-conversation', 'mail', { remoteEmail: 'PERSON+sales@EXAMPLE.TEST' });
  const contact = sync(state, item);
  assert.equal(contact.email, 'person+sales@example.test');
  Object.assign(contact, { name: 'Nome revisado', type: 'company', email: 'edited@example.test', phone: '(11) 91234-5678', notes: 'Nota mantida',
    tags: ['Origem manual'], archivedAt: '2026-10-03T00:00:00Z', version: 7 });
  item.contact = 'Outro nome do remetente'; item.remoteEmail = 'incoming-new-address@example.test';
  const before = hash(contact); assert.strictEqual(sync(state, item), contact); assert.equal(hash(contact), before);
  assert.equal(item.contactSyncStatus, 'linked'); assert.equal(item.contactId, contact.id);
  contact.email = ''; const blankBefore = hash(contact); sync(state, item); assert.equal(hash(contact), blankBefore);
  for (const remoteEmail of ['invalid', '.person@example.test', 'person.@example.test', 'person..sales@example.test', 'person@\nexample.test', 123]) {
    const freshState = fixture(), bad = conversation('mail-invalid', 'mail', { remoteEmail }), snapshot = hash([freshState, bad]);
    assert.throws(() => sync(freshState, bad), status(400)); assert.equal(hash([freshState, bad]), snapshot);
  }
});

test('capacidade automática marca pendência sem inventar contato, apagar mensagens ou modificar a agenda', () => {
  const state = fullFixture(), item = conversation('over-capacity', 'web'), beforeContacts = hash(state.contacts), before = structuredClone(item);
  const warning = sync(state, item);
  assert.deepEqual(warning, { code: 'CONTACT_CAPACITY', limit: 10000 }); assert.equal(warning.id, undefined);
  assert.deepEqual(item, { ...before, contactSyncStatus: 'capacity' }); assert.equal(item.contactId, undefined);
  assert.equal(hash(state.contacts), beforeContacts);
  const repeated = hash([state, item]); assert.deepEqual(sync(state, item), warning); assert.equal(hash([state, item]), repeated);
  state.contacts.pop(); const contact = sync(state, item);
  assert.equal(state.contacts.length, 10000); assert.equal(item.contactSyncStatus, 'linked'); assert.equal(item.contactId, contact.id);
  assert.equal(contact.identities[0].externalId, 'conversation:over-capacity');
  assert.deepEqual(item.messages, before.messages); assert.equal(item.version, before.version);
  const after = hash([state, item]); sync(state, item); assert.equal(hash([state, item]), after);
});

test('sync manual conserva409 de capacidade e não escreve status automático', () => {
  const state = fullFixture(), item = conversation('manual-full', 'web', { contactSyncStatus: 'capacity' }), before = hash([state, item]);
  assert.throws(() => sync(state, item, false), status(409)); assert.equal(hash([state, item]), before);
  const available = fixture(), manual = conversation('manual-available', 'mail', { remoteEmail: 'manual@example.test' });
  const contact = sync(available, manual, false);
  assert.equal(contact.email, 'manual@example.test'); assert.equal(manual.contactId, contact.id); assert.equal(manual.contactSyncStatus, undefined);
});

test('sync manual limpa uma pendência capacity ao vincular sem alterar cadastro ou incrementar versões na repetição', () => {
  const state = fullFixture(), item = conversation('manual-existing', 'web', { contactSyncStatus: 'capacity' }), contact = state.contacts[0];
  contact.identities = [{ channelId: 'web', kind: 'person', externalId: 'conversation:manual-existing' }];
  const beforeContact = hash(contact);
  assert.strictEqual(sync(state, item, false), contact); assert.equal(item.contactId, contact.id); assert.equal(item.contactSyncStatus, 'linked');
  assert.equal(hash(contact), beforeContact); assert.equal(item.version, 2);
  const before = hash([state, item]); assert.strictEqual(sync(state, item, false), contact); assert.equal(hash([state, item]), before);
});

test('agenda cheia reutiliza identidade existente e preserva edição/arquivo/revisão em todos os transportes', () => {
  for (const [channelId, metadata] of [['web', {}], ['mail', { remoteEmail: 'seed@example.test' }], ['ig', {}], ['fb', {}],
    ['wa', { remoteJid: '5511987654321@s.whatsapp.net' }], ['tg', { remoteChatId: '12345' }]]) {
    const state = fixture(), item = conversation('existing-' + channelId, channelId, metadata), contact = sync(state, item);
    Object.assign(contact, { name: 'Dados revisados', email: 'reviewed@example.test', notes: 'Nota revisada', tags: ['Revisado'],
      archivedAt: '2026-10-03T00:00:00Z', version: 9 });
    const fillers = fullFixture().contacts; state.contacts.push(...fillers.slice(0, 9999));
    const before = hash(state.contacts); item.contactSyncStatus = 'capacity';
    assert.strictEqual(sync(state, item), contact); assert.equal(state.contacts.length, 10000); assert.equal(hash(state.contacts), before);
    assert.equal(item.contactSyncStatus, 'linked'); assert.equal(item.contactId, contact.id);
  }
});

test('capacidade nunca mascara canal inválido, vínculo estrangeiro, identidade ocupada, tipo incompatível ou e-mail malformado', () => {
  const checks = [
    [conversation('unknown-channel', 'missing'), 404],
    [conversation('unknown-contact', 'web', { contactId: 'foreign-contact' }), 404],
    [conversation('mail-malformed', 'mail', { remoteEmail: 'invalid' }), 400],
    [conversation('wa-malformed', 'wa', { remoteJid: 'not-a-whatsapp-jid' }), 400],
  ];
  for (const [item, expected] of checks) {
    const state = fullFixture(), before = hash([state, item]);
    assert.throws(() => sync(state, item), status(expected)); assert.equal(hash([state, item]), before);
  }
  const state = fullFixture(), occupied = conversation('occupied', 'web');
  state.contacts[0].identities = [{ channelId: 'web', kind: 'person', externalId: 'conversation:occupied' }];
  occupied.contactId = state.contacts[1].id; const before = hash([state, occupied]);
  assert.throws(() => sync(state, occupied), status(409)); assert.equal(hash([state, occupied]), before);
  const wrongKind = conversation('occupied', 'web'); state.contacts[0].type = 'group'; const beforeKind = hash([state, wrongKind]);
  assert.throws(() => sync(state, wrongKind), status(409)); assert.equal(hash([state, wrongKind]), beforeKind);
  const valid = conversation('wrong-adapter-channel', 'web'), wrongChannel = state.channels.find(channel => channel.id === 'mail'), beforeChannel = hash([state, valid]);
  assert.throws(() => syncIncomingConversationContact(state, valid, wrongChannel), status(400)); assert.equal(hash([state, valid]), beforeChannel);
});
