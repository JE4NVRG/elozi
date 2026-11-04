import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { ensureAgendaSchema, rememberAgenda, agendaNames, savedName, agendaRows, applyAgendaNames, personJid } from '../src/whatsapp-agenda.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Teste' };
const operator = { role: 'operator', resellerId: 'mep-demo', name: 'Operador', tenantIds: [] };
const expected = '5511999990000';
const ana = '5511988880000@s.whatsapp.net', anaLid = '123456789012345@lid', bia = '5511977770000@s.whatsapp.net';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('agenda: only saved names of people are kept, by phone JID and LID, and a repeat changes nothing', () => {
  const db = new DatabaseSync(':memory:'); ensureAgendaSchema(db);
  assert.equal(personJid('5511988880000:7@s.whatsapp.net'), ana); assert.equal(personJid('120363000000000000@g.us'), null); assert.equal(personJid('status@broadcast'), null);
  const changed = rememberAgenda(db, 'qr', [
    { id: ana, name: '  Ana   Souza ', lid: anaLid }, { id: bia, notify: 'perfil sem nome salvo' }, { id: '120363000000000000@g.us', name: 'Grupo' }, { id: anaLid, name: 'Ana Souza', phoneNumber: ana },
  ], Date.parse('2026-10-06T12:00:00Z'));
  assert.equal(changed, 2);
  assert.equal(rememberAgenda(db, 'qr', [{ id: ana, name: 'Ana Souza', lid: anaLid }]), 0, 'repetição não muda nada');
  const names = agendaNames(db, 'qr');
  assert.equal(savedName(names, [anaLid]), 'Ana Souza'); assert.equal(savedName(names, ['5511988880000:3@s.whatsapp.net']), 'Ana Souza'); assert.equal(savedName(names, [bia]), null);
  assert.deepEqual(agendaRows(db, 'qr'), [{ name: 'Ana Souza', phone: '+5511988880000' }]);
  assert.equal(agendaNames(db, 'outro').size, 0, 'cada canal tem a própria agenda');
});

test('agenda: renames conversations and CRM contacts with a WhatsApp name; a name typed by a person stays', () => {
  const names = new Map([[ana, 'Ana Souza'], [bia, 'Bia Lima'], ['5511966660000@s.whatsapp.net', 'Caio'], ['5511955550000@s.whatsapp.net', 'Duda']]);
  const tenant = {
    contacts: [{ id: 'c-bia', name: 'Beatriz (cliente VIP)', nameSource: 'manual', version: 3 }, { id: 'c-caio', name: '~caio', version: 1 }, { id: 'c-duda', name: 'Duda editada', version: 2 }],
    conversations: [
      { id: 'a', channelId: 'qr', conversationKind: 'direct', remoteJid: '5511988880000@s.whatsapp.net', remoteAliases: [anaLid], contact: 'Ana perfil', contactNameSource: 'whatsapp-profile' },
      { id: 'b', channelId: 'qr', conversationKind: 'direct', remoteJid: bia, contact: 'Beatriz (cliente VIP)', contactId: 'c-bia', contactNameSource: 'whatsapp-profile' },
      { id: 'c', channelId: 'qr', conversationKind: 'direct', remoteJid: '5511966660000@s.whatsapp.net', contact: '~caio', contactId: 'c-caio' },
      { id: 'd', channelId: 'qr', conversationKind: 'direct', remoteJid: '5511955550000@s.whatsapp.net', contact: 'Duda', contactId: 'c-duda' },
      { id: 'g', channelId: 'qr', conversationKind: 'group', remoteJid: ana, contact: 'Grupo' },
      { id: 'o', channelId: 'outro', conversationKind: 'direct', remoteJid: ana, contact: 'Outro canal', contactNameSource: 'whatsapp-profile' },
    ],
  };
  assert.equal(applyAgendaNames(tenant, 'qr', names, Date.parse('2026-10-06T12:00:00Z')), 2);
  const conversation = id => tenant.conversations.find(item => item.id === id), contact = id => tenant.contacts.find(item => item.id === id);
  assert.equal(conversation('a').contact, 'Ana Souza'); assert.equal(conversation('a').contactNameSource, 'whatsapp-agenda'); assert.equal(conversation('a').initials, 'AN');
  assert.equal(conversation('b').contact, 'Beatriz (cliente VIP)', 'contato editado à mão fica'); assert.equal(contact('c-bia').name, 'Beatriz (cliente VIP)');
  assert.equal(conversation('c').contact, 'Caio', 'conversa antiga ainda com o nome de criação'); assert.equal(contact('c-caio').name, 'Caio'); assert.equal(contact('c-caio').nameSource, 'whatsapp-agenda'); assert.equal(contact('c-caio').version, 2);
  assert.equal(conversation('d').contact, 'Duda', 'contato antigo já editado no CRM fica');
  assert.equal(conversation('g').contact, 'Grupo'); assert.equal(conversation('o').contact, 'Outro canal');
  assert.equal(applyAgendaNames(tenant, 'qr', names), 0, 'segunda aplicação não muda nada');
});

function setup(t) {
  const store = new Store(':memory:'), sockets = [];
  const tenant = store.createTenant(admin, { name: 'Agenda QR', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Canal de teste', state => state.channels.push({ id: 'qr-test', kind: 'whatsapp_qr', name: 'Teste', expectedNumber: expected, transport: 'baileys', state: 'disconnected', label: 'final 0000' }));
  const resyncs = [], keySets = [];
  const socketFactory = config => {
    const socket = { config, ev: new EventEmitter(), user: { id: expected + ':1@s.whatsapp.net' }, end: () => {}, logout: async () => {}, sent: [] };
    socket.authState = { creds: config.auth.creds, keys: { get: config.auth.keys.get, set: async data => { keySets.push(data); return config.auth.keys.set(data); } } };
    socket.resyncAppState = async (collections, initial) => { resyncs.push([collections, initial]); socket.ev.emit('contacts.upsert', [{ id: ana, name: 'Ana Souza', lid: anaLid }, { id: bia, name: 'Bia Lima' }]); };
    sockets.push(socket); return socket;
  };
  const gateway = new WhatsAppGateway(store, { socketFactory, authKey: randomBytes(32), reconnectDelay: 10 });
  t.after(async () => { await gateway.close(); store.close(); });
  return { store, sockets, gateway, tenant, resyncs, keySets };
}
async function connect(c) {
  await c.gateway.start(admin, c.tenant.id, 'qr-test');
  c.sockets.at(-1).config.auth.creds.me = { id: expected + ':1@s.whatsapp.net' }; c.sockets.at(-1).ev.emit('creds.update', {});
  c.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await tick();
}

test('agenda no gateway: sincronizar pede de novo só a coleção de contatos, aplica os nomes e conversas novas já nascem com o nome salvo', async t => {
  const c = setup(t); await connect(c);
  const entry = c.gateway.entries.get('qr-test');
  await c.gateway.receive(entry, { key: { id: 'm-1', remoteJid: ana }, pushName: 'Ana perfil', message: { conversation: 'Oi' } });
  let state = c.store.tenant(admin, c.tenant.id);
  assert.equal(state.conversations[0].contact, 'Ana perfil'); assert.equal(state.conversations[0].contactNameSource, 'whatsapp-profile');
  assert.equal(state.contacts.find(item => item.id === state.conversations[0].contactId).nameSource, 'whatsapp-profile');
  await assert.rejects(c.gateway.syncAddressBook(operator, c.tenant.id, 'qr-test'), error => error.status === 403);
  const result = await c.gateway.syncAddressBook(admin, c.tenant.id, 'qr-test');
  assert.deepEqual(c.resyncs, [[['critical_unblock_low'], true]]);
  assert.deepEqual(c.keySets, [{ 'app-state-sync-version': { critical_unblock_low: null } }], 'só a versão da coleção de contatos é apagada');
  assert.deepEqual(result, { channelId: 'qr-test', contacts: 2, renamed: 1 });
  state = c.store.tenant(admin, c.tenant.id);
  assert.equal(state.conversations[0].contact, 'Ana Souza'); assert.equal(state.contacts.find(item => item.id === state.conversations[0].contactId).name, 'Ana Souza');
  await c.gateway.receive(entry, { key: { id: 'm-2', remoteJid: bia }, pushName: 'perfil da Bia', message: { conversation: 'Olá' } });
  state = c.store.tenant(admin, c.tenant.id);
  const second = state.conversations.find(item => item.remoteJid === bia);
  assert.equal(second.contact, 'Bia Lima'); assert.equal(second.contactNameSource, 'whatsapp-agenda');
  assert.deepEqual(c.gateway.addressBook(admin, c.tenant.id, 'qr-test'), { channelId: 'qr-test', contacts: 2, rows: [{ name: 'Ana Souza', phone: '+5511988880000' }, { name: 'Bia Lima', phone: '+5511977770000' }] });
  assert.throws(() => c.gateway.addressBook(operator, c.tenant.id, 'qr-test'), error => error.status === 403);
});

test('agenda no gateway: nomes que chegam sozinhos pelo WhatsApp são aplicados em lote; sem conexão não há sincronização', async t => {
  const c = setup(t);
  await assert.rejects(c.gateway.syncAddressBook(admin, c.tenant.id, 'qr-test'), error => error.status === 409);
  await connect(c);
  const entry = c.gateway.entries.get('qr-test');
  await c.gateway.receive(entry, { key: { id: 'm-1', remoteJid: ana }, pushName: 'Ana perfil', message: { conversation: 'Oi' } });
  c.sockets.at(-1).ev.emit('contacts.update', [{ id: ana, notify: 'só o nome do perfil' }]);
  assert.equal(c.gateway.agendaTimers.size, 0, 'nome de perfil não agenda nada');
  c.sockets.at(-1).ev.emit('contacts.upsert', [{ id: anaLid, name: 'Ana da Agenda', phoneNumber: ana }]);
  assert.equal(c.gateway.agendaTimers.size, 1);
  assert.equal(c.gateway.applyAgenda(entry), 1);
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].contact, 'Ana da Agenda');
});

test('agenda: cada empresa só lê a agenda dos próprios canais', async t => {
  const c = setup(t); await connect(c);
  await c.gateway.syncAddressBook(admin, c.tenant.id, 'qr-test');
  const other = c.store.createTenant(admin, { name: 'Outra empresa', segment: 'Teste' });
  assert.throws(() => c.gateway.addressBook(admin, other.id, 'qr-test'), error => error.status === 404, 'canal de outra empresa');
  await assert.rejects(c.gateway.syncAddressBook(admin, other.id, 'qr-test'), error => error.status === 404);
  const stranger = { role: 'reseller', resellerId: 'outra-revenda', name: 'Outra revenda' };
  assert.throws(() => c.gateway.addressBook(stranger, c.tenant.id, 'qr-test'), error => [403, 404].includes(error.status), 'outra revenda');
  assert.equal(c.gateway.addressBook(admin, c.tenant.id, 'qr-test').rows.length, 2);
});

test('agenda no gateway: a resposta espera o Baileys liberar os eventos da sincronização (cerca de 100 ms depois)', async t => {
  const c = setup(t); await connect(c);
  const socket = c.sockets.at(-1);
  socket.resyncAppState = async () => { setTimeout(() => socket.ev.emit('contacts.upsert', [{ id: ana, name: 'Ana Atrasada' }]), 100); };
  const entry = c.gateway.entries.get('qr-test');
  await c.gateway.receive(entry, { key: { id: 'm-1', remoteJid: ana }, pushName: 'Ana perfil', message: { conversation: 'Oi' } });
  const result = await c.gateway.syncAddressBook(admin, c.tenant.id, 'qr-test');
  assert.deepEqual(result, { channelId: 'qr-test', contacts: 1, renamed: 1 });
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].contact, 'Ana Atrasada');
});
