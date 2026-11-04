import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GroupSummaries } from '../src/group-summaries.js';
const now = Date.parse('2026-10-05T15:00:00Z'), actor = { userId: 'jean', resellerId: 'ws-a', role: 'reseller' };
const status = value => error => error.status === value;
function fixture({ providerCall = async () => ({ text: 'Decisão: entrega sexta. Responsável: Lia.' }), ...config } = {}) {
  const conversation = { id: 'group-a', channelId: 'wa-a', contact: 'Grupo próprio', conversationKind: 'group', version: 1, messages: [{ id: 'm1', kind: 'customer', senderName: 'Lia', text: 'Vou entregar sexta.', createdAt: new Date(now - 1000).toISOString() }] };
  const tenant = { agents: [{ id: 'hermes-a', provider: 'hermes', mode: 'copilot', configured: true, version: 1 }], conversations: [conversation] };
  const store = { tenant: () => tenant, getConversation: (tenant, id, version) => { const c = tenant.conversations.find(c => c.id === id); if (!c || c.version !== version) throw Object.assign(new Error('Changed'), { status: 409 }); return c; } };
  let allowed = true, calls = 0, payload;
  const summaries = new GroupSummaries(store, { now: () => now, authorize: () => allowed, providerCall: async context => { calls++; payload = context; return providerCall(context); }, ...config });
  const input = { version: 1, agentId: 'hermes-a', commandId: 'summary-a' };
  return { summaries, tenant, conversation, input, calls: () => calls, payload: () => payload, deny: () => { allowed = false; } };
}
test('private summary preserves speakers and never mutates conversation, draft, memory or schedule', async () => {
  const f = fixture(), before = structuredClone(f.tenant), result = await f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input);
  assert.equal(result.state, 'ready'); assert.equal(result.coverage.includedCount, 1); assert.equal(result.coverage.attachmentsAnalyzed, false); assert.deepEqual(f.tenant, before);
  assert.deepEqual(f.payload().tools, []); assert.equal(f.payload().messages[1].content.includes('Lia'), true);
  const replay = await f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input); assert.deepEqual(replay, result); assert.equal(f.calls(), 1);
  await assert.rejects(f.summaries.summarize(actor, 'tenant-a', 'group-a', { ...f.input, limit: 30 }), status(409));
});
test('summary denies revoked scope before calls and after provider awaits without exposing result', async () => {
  const f = fixture(); f.deny(); await assert.rejects(f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input), status(403)); assert.equal(f.calls(), 0);
  let finish; const pending = new Promise(resolve => { finish = resolve; }); const fresh = fixture({ providerCall: () => pending });
  const run = fresh.summaries.summarize(actor, 'tenant-a', 'group-a', fresh.input); fresh.deny(); finish({ text: 'Private result' }); await assert.rejects(run, status(403));
});
test('summary invalidates conversation, adapter and authenticated workspace changes during generation', async () => {
  for (const change of ['conversation', 'adapter', 'session']) {
    let finish, current = actor; const f = fixture({ providerCall: () => new Promise(resolve => { finish = resolve; }) });
    const run = f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input, { reauthorize: () => current });
    if (change === 'conversation') f.conversation.version++;
    if (change === 'adapter') f.tenant.agents[0].version++;
    if (change === 'session') current = { ...actor, resellerId: 'other' };
    finish({ text: 'Result' }); await assert.rejects(run, status(change === 'session' ? 403 : 409));
  }
});
test('summary bounds all serialized provider context and reports truncation without claiming media analysis', async () => {
  const f = fixture({ maxBytes: 4096 }); f.conversation.contact='🙂'.repeat(10000); f.conversation.messages = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, kind: 'customer', senderName: 'Participante', text: '🙂"\\'.repeat(2500), createdAt: new Date(now - 1000 + i).toISOString(), attachments: [{ id: 'image', name: 'Foto', kind: 'image' }] }));
  const result = await f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input);
  assert.ok(Buffer.byteLength(f.payload().messages.map(m => m.content).join('')) <= 4096); assert.equal(result.coverage.hasMore, true); assert.equal(result.coverage.textTruncated, true); assert.equal(result.coverage.attachmentsAnalyzed, false);
});

test('default summary context respects the deployed Hermes content bound for long group messages',async()=>{
  const f=fixture();f.conversation.messages=Array.from({length:100},(_,i)=>({id:'long-'+i,kind:'customer',senderName:'Jean',text:'🙂"\\'.repeat(2500),createdAt:new Date(now-1000+i).toISOString()}));
  const result=await f.summaries.summarize(actor,'tenant-a','group-a',f.input);
  const bytes=f.payload().messages.reduce((n,m)=>n+Buffer.byteLength(m.content),0);
  assert.ok(bytes<=24*1024);assert.ok(bytes>16*1024);assert.equal(result.coverage.hasMore,true);
});

test('closing summary aborts pending provider and never discloses a late response', async () => {
  const f=fixture({providerCall:()=>new Promise(()=>{})});
  const pending=f.summaries.summarize(actor,'tenant-a','group-a',f.input);
  f.summaries.close();await assert.rejects(pending,status(503));
  assert.equal(f.payload().signal.aborted,true);assert.equal(f.summaries.entries.size,0);
  await assert.rejects(f.summaries.summarize(actor,'tenant-a','group-a',f.input),status(503));
});
test('summary rejects empty history, unconfigured agent, direct chat and tool-call response', async () => {
  for (const type of ['empty', 'agent', 'direct']) { const f = fixture(); if (type === 'empty') f.conversation.messages = []; if (type === 'agent') f.tenant.agents[0].configured = false; if (type === 'direct') f.conversation.conversationKind = 'direct'; await assert.rejects(f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input), status(type === 'direct' ? 400 : 409)); assert.equal(f.calls(), 0); }
  const f = fixture({ providerCall: async () => ({ toolCall: { name: 'send' } }) }); await assert.rejects(f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input), status(502));
});
test('summary deduplicates concurrent retries, limits another request per person and respects deadline', async () => {
  let finish; const f = fixture({ providerCall: () => new Promise(resolve => { finish = resolve; }) });
  const one = f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input), two = f.summaries.summarize(actor, 'tenant-a', 'group-a', f.input);
  await assert.rejects(f.summaries.summarize(actor, 'tenant-a', 'group-a', { ...f.input, commandId: 'summary-b' }), status(429)); finish({ text: 'Resultado' }); assert.deepEqual(await one, await two); assert.equal(f.calls(), 1);
  const timeout = fixture({ timeoutMs: 15, providerCall: () => new Promise(() => {}) }); await assert.rejects(timeout.summaries.summarize(actor, 'tenant-a', 'group-a', timeout.input), status(504)); assert.equal(timeout.payload().signal.aborted, true);
});
