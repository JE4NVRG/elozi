import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Outbox QA' };
function setup(t, options) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tenant = store.createTenant(actor, { name: 'Outbox QA', segment: 'Fixture sintética' });
  const channelId = randomUUID(), conversationId = randomUUID();
  store.mutate(actor, tenant.id, 'Fixture', state => {
    state.channels.push({ id: channelId, kind: 'telegram', name: 'Bot QA', transport: 'telegram-bot' });
    state.conversations.push({ id: conversationId, channelId, contact: 'Contato QA', owner: 'human', version: 1, messages: [], status: 'open' });
  });
  const outbox = new Outbox(store, options);
  const input = { channelId, version: 1, text: 'Mensagem sintética', idempotencyKey: randomUUID() };
  const dispatch = (send, override = {}) => outbox.dispatch(actor, tenant.id, conversationId, { ...input, ...override }, send);
  const command = () => store.db.prepare('SELECT * FROM outbound_commands WHERE tenant_id=?').get(tenant.id);
  return { store, tenant, channelId, conversationId, input, outbox, dispatch, command };
}
const status = code => error => error.status === code;

test('forward origin is durable and separates idempotency from ordinary sends and another source', async t => {
  const c=setup(t);let calls=0;
  const forwardOrigin={actorUserId:'synthetic-owner',sourceId:'source-a',messageId:'message-a',sourceVersion:3,sourceChannelId:'source-channel',fingerprint:'synthetic-preview',destinationId:c.conversationId,destinationVersion:1,destinationChannelId:c.channelId};
  const send=async()=>{calls++;return c.store.getConversation(c.store.tenant(actor,c.tenant.id),c.conversationId);};
  await c.dispatch(send,{forwardOrigin});
  assert.deepEqual(JSON.parse(c.command().payload).forwardOrigin,forwardOrigin);
  await c.dispatch(send,{forwardOrigin});assert.equal(calls,1);
  await assert.rejects(c.dispatch(send),status(409));
  await assert.rejects(c.dispatch(send,{forwardOrigin:{...forwardOrigin,sourceId:'source-b'}}),status(409));
  assert.equal(calls,1);assert.equal(c.command().attempts,1);assert.equal(c.command().state,'confirmed');
});

test('quote identity participates in idempotency and is revalidated after asynchronous gates', async t => {
 let gates=0,calls=0;
 const c=setup(t,{beforeSend:async()=>{if(++gates===2)c.store.mutate(actor,c.tenant.id,'Synthetic removal',s=>{s.conversations[0].messages=[];});}});
 c.store.mutate(actor,c.tenant.id,'Synthetic quote',s=>{s.conversations[0].messages=[{id:'original',kind:'customer',text:'Synthetic question'}];});
 await assert.rejects(c.dispatch(async()=>{calls++;},{replyToMessageId:'original'}),status(404));
 assert.equal(calls,0);assert.equal(c.command().state,'failed');assert.equal(JSON.parse(c.command().payload).replyToMessageId,'original');
 await assert.rejects(c.dispatch(async()=>{calls++;},{replyToMessageId:'different'}),status(409));assert.equal(calls,0);
});

test('outbox deduplica corrida concorrente e replay confirmado sem segundo efeito externo', async t => {
  let release, reached;
  const blocked = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  let gates = 0, calls = 0;
  const c = setup(t, { beforeSend: async () => { if (++gates <= 2) { reached(); await blocked; } } });
  const send = async () => { calls++; return c.store.getConversation(c.store.tenant(actor, c.tenant.id), c.conversationId); };
  const first = c.dispatch(send), second = c.dispatch(send);
  await entered;
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(calls, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(c.command().state, 'confirmed'); assert.equal(c.command().attempts, 1);
  await c.dispatch(send); assert.equal(calls, 1);
  await assert.rejects(c.dispatch(send, { text: 'Outra mensagem' }), status(409));
  assert.equal(calls, 1);
});

test('banco indisponível preserva pending e não chama o provedor em nenhum dos dois gates', async t => {
  for (const failingGate of [1, 2]) {
    let gates = 0, calls = 0;
    const c = setup(t, { beforeSend: async () => { if (++gates === failingGate) throw new Error('Fixture: PostgreSQL offline'); } });
    await assert.rejects(c.dispatch(async () => { calls++; }));
    assert.equal(calls, 0); assert.equal(c.command().state, 'pending');
    c.outbox.beforeSend = async () => {};
    await c.dispatch(async () => { calls++; return { accepted: true }; });
    assert.equal(calls, 1); assert.equal(c.command().state, 'confirmed');
  }
});

test('sessão expirada antes do claim não sobrescreve envio concorrente em voo ou confirmado', async t => {
  for (const competingState of ['in_flight', 'confirmed']) {
    let gates = 0, expired = false, calls = 0;
    const c = setup(t, { beforeSend: async () => {
      if (++gates === 1) {
        c.store.db.prepare('UPDATE outbound_commands SET state=?,attempts=1').run(competingState);
        expired = true;
      }
    } });
    await assert.rejects(c.outbox.dispatch(actor,c.tenant.id,c.conversationId,c.input,async()=>{calls++;},
      {reauthorize:()=>{if(expired)throw Object.assign(new Error('Sessão sintética expirada'),{status:401});}}),status(401));
    assert.equal(c.command().state,competingState);assert.equal(c.command().attempts,1);assert.equal(calls,0);
  }
});

test('timeout e reinício de in_flight viram unknown sem reenvio automático', async t => {
  const c = setup(t), provider = async () => { throw new Error('Fixture: resposta perdida depois de aceitação'); };
  await assert.rejects(c.dispatch(provider)); assert.equal(c.command().state, 'unknown');
  let calls = 0;
  await assert.rejects(c.dispatch(async () => { calls++; }), status(409)); assert.equal(calls, 0);
  c.store.db.prepare("UPDATE outbound_commands SET state='in_flight'").run();
  const restored = new Outbox(c.store);
  await assert.rejects(restored.dispatch(actor, c.tenant.id, c.conversationId, c.input, async () => { calls++; }), status(409));
  assert.equal(c.command().state, 'unknown'); assert.equal(calls, 0);
});

test('takeover durante espera cancela o envio antes de qualquer efeito externo', async t => {
  let gates = 0, calls = 0;
  const c = setup(t, { beforeSend: async () => {
    if (++gates === 2) c.store.mutate(actor, c.tenant.id, 'Fixture takeover', state => {
      const conversation = c.store.getConversation(state, c.conversationId); conversation.owner = 'agent'; conversation.version++;
    });
  } });
  await assert.rejects(c.dispatch(async () => { calls++; }), status(409));
  assert.equal(calls, 0); assert.equal(c.command().state, 'failed');
});

test('acesso cruzado, canal incorreto e versão antiga falham antes de criar comando', async t => {
  const c = setup(t), restricted = { role: 'operator', resellerId: 'mep-demo', tenantIds: [], name: 'QA' };
  let calls = 0;
  await assert.rejects(c.outbox.dispatch(restricted, c.tenant.id, c.conversationId, c.input, async () => { calls++; }), status(403));
  await assert.rejects(c.dispatch(async () => { calls++; }, { channelId: 'outro-canal' }), status(400));
  await assert.rejects(c.dispatch(async () => { calls++; }, { version: 0 }), status(409));
  assert.equal(calls, 0); assert.equal(c.command(), undefined);
});
