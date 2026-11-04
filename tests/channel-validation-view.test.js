import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChannelValidation, normalizeChannelValidationPage, channelValidatedForUse } from '../public/channel-validation-view.js';
const scope = { tenantId: 'tenant-qa', channelId: 'channel-qa' };
const dto = more => ({ ...scope, version: 1, state: 'validated', startedAt: '2026-10-09T12:00:00.000Z', validatedAt: '2026-10-09T12:00:03.000Z', conversationId: 'conversation-qa', incomingRecorded: true, replyRecorded: true, recipientConfirmed: true, channelAvailable: true, ...more });
test('validation view allows only scoped public metadata', () => {
  const result = normalizeChannelValidation(dto({ token:'private', text:'private', checkedBy:'private' }),scope);
  assert.equal(Object.keys(result).length, 11);
  assert.equal(JSON.stringify(result).includes('private'),false);
});
test('a disconnected validated channel preserves history but is not ready for use', () => {
  const result = normalizeChannelValidation(dto({channelAvailable:false}),scope);
  assert.equal(result.state,'validated'); assert.equal(channelValidatedForUse(result),false);
  assert.equal(channelValidatedForUse(normalizeChannelValidation(dto(),scope)),true);
});
for(const change of [{tenantId:'another'}, {channelId:'another'}, {version:-1}, {version:1.5}, {state:'connected'}, {startedAt:'never'}, {validatedAt:undefined}, {conversationId:'\n'}, {incomingRecorded:false}, {replyRecorded:false}, {recipientConfirmed:false}])
  test(`invalid acceptance is refused: ${Object.keys(change)[0]} ${String(Object.values(change)[0])}`,()=>assert.throws(()=>normalizeChannelValidation(dto(change),scope)));
test('pending and stale states never qualify as validated', () => {
  for(const state of ['not_started','waiting_incoming','waiting_reply','waiting_confirmation','stale']) assert.equal(channelValidatedForUse(dto({state})),false);
});
test('contradictory partial exchange cannot produce a confirmation action', () => {
  for (const change of [
    {state:'waiting_reply',recipientConfirmed:false,validatedAt:null,conversationId:null},
    {state:'waiting_reply',recipientConfirmed:false,validatedAt:null,startedAt:null},
    {state:'waiting_confirmation',recipientConfirmed:false,validatedAt:null,replyRecorded:false},
    {state:'waiting_incoming',recipientConfirmed:false,validatedAt:null,incomingRecorded:false,replyRecorded:true}
  ]) assert.throws(()=>normalizeChannelValidation(dto(change),scope));
});
test('batch refuses unknown channels, duplicates, foreign tenant and excess rows', () => {
  const context={tenantId:scope.tenantId,channelIds:[scope.channelId]};
  assert.equal(normalizeChannelValidationPage({tenantId:scope.tenantId,items:[dto()]},context).length,1);
  for(const value of [{tenantId:'other',items:[]},{tenantId:scope.tenantId,items:[dto({channelId:'other'})]},{tenantId:scope.tenantId,items:[dto(),dto()]},{tenantId:scope.tenantId,items:Array(21).fill(dto())}]) assert.throws(()=>normalizeChannelValidationPage(value,context));
});
