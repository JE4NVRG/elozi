import test from 'node:test';
import assert from 'node:assert/strict';
import { canSyncDeviceRead, readStateCommand, readActionLabel, readSyncNotice, attendanceResponseIsCurrent, canRefreshDeviceReads, deviceReadStateNotice } from '../public/attendance-read-ui.js';

const conversation = { id: 'c', channelId: 'wa', owner: 'human', assignedUserId: 'me', unread: 3 };
const context = { userId: 'me', channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }] };

test('leitura no WhatsApp é explícita, somente do responsável, sem alterar marcação não lida', () => {
  assert.equal(canSyncDeviceRead(conversation, context), true);
  assert.deepEqual(readStateCommand(conversation, 2, false, context), { version: 2, unread: false, syncDevice: true });
  assert.deepEqual(readStateCommand(conversation, 2, true, context), { version: 2, unread: true });
  for (const [c, access] of [
    [{ ...conversation, assignedUserId: 'other' }, context], [{ ...conversation, owner: 'agent' }, context],
    [{ ...conversation, owner: 'queue' }, context], [conversation, { ...context, supportGrantId: 'grant' }],
    [conversation, { ...context, userId: null }], [conversation, { ...context, channels: [] }],
    [conversation, { ...context, channels: [{ id: 'wa', kind: 'whatsapp_cloud', transport: 'cloud' }] }]
  ]) assert.deepEqual(readStateCommand(c, 2, false, access), { version: 2, unread: false });
});

test('ações e resultado distinguem leitura local, envio ao WhatsApp e falta de confirmação', () => {
  assert.match(readActionLabel(conversation, context), /WhatsApp e no painel/);
  assert.equal(readActionLabel({ ...conversation, unread: 0 }, context), 'Marcar como não lida no painel');
  assert.equal(readActionLabel(conversation, {}), 'Marcar como lida no painel');
  assert.match(readSyncNotice({ readSync: { state: 'pending' } }), /não foi confirmada/);
  assert.match(readSyncNotice({ readSync: { state: 'synced' } }), /enviada ao WhatsApp/);
  assert.equal(readSyncNotice({}), 'Leitura atualizada no painel.');
});

test('resposta de leitura atrasada não remove mensagem nova nem responsável de versão mais recente', () => {
  const current = { ...conversation, version: 5, messages: [{ id: 'old' }, { id: 'new' }] };
  assert.equal(attendanceResponseIsCurrent({ ...current, version: 4, assignedUserId: 'old-owner' }, current), false);
  assert.equal(attendanceResponseIsCurrent({ ...current, messages: [{ id: 'old' }] }, current), false);
  assert.equal(attendanceResponseIsCurrent({ ...current, channelId: 'other' }, current), false);
  assert.equal(attendanceResponseIsCurrent({ ...current, version: 6, unread: 0 }, current), true);
});

test('atualização de leitura antiga exige administração do canal, informa contagem real ou falta de confirmação', () => {
  assert.equal(canRefreshDeviceReads(conversation, { ...context, role: 'reseller' }), true);
  assert.equal(canRefreshDeviceReads(conversation, { ...context, role: 'operator' }), false);
  assert.equal(canRefreshDeviceReads(conversation, { ...context, role: 'reseller', supportGrantId: 'g' }), false);
  assert.equal(canRefreshDeviceReads(conversation, { ...context, role: 'reseller', channels: [] }), false);
  assert.equal(deviceReadStateNotice({ state: 'synced', updatedConversations: 2 }), '2 conversas atualizadas com as leituras do WhatsApp.');
  assert.match(deviceReadStateNotice({ state: 'pending' }), /ainda não confirmou/);
});
