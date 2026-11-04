import test from 'node:test';
import assert from 'node:assert/strict';
import { queryFixture } from './service-query-fixture.js';
const parseTool=r=>r.structuredContent||JSON.parse(r.content.find(c=>c.type==='text').text);
const stable=p=>Object.fromEntries(Object.entries(p).filter(([k])=>!['usage','lastSeenAt','updatedAt'].includes(k)));

test('manager panel, REST and actual MCP elozi_me share one scoped autonomy contract',async t=>{
 const f=await queryFixture(t);
 f.change(state=>{for(const id of ['wa-direct','wa-group']){const c=state.conversations.find(c=>c.id===id);c.messages.find(m=>m.kind==='customer').createdAt='2026-10-24T15:01:00.000Z';}});
 const service=await f.service(['conversation.read','events.read','conversation.manage','reply.send'],{channelIds:['wa','web'],conversationPolicy:{customerMessagesAfter:'2026-10-24T14:58:00.000Z',allowGroups:false,excludedChannelIds:['hidden']}});
 const id=service.principal.id;
 const before=await f.request(f.path+'/service-principals',{cookie:f.owner.cookie});
 assert.equal(before.status,200);
 const policy=before.data.responsePolicies[id];assert.equal(policy.version,2);
 assert.equal(policy.effectiveMode,'autonomous');assert.equal(policy.humanApprovalRequired,false);
 assert.equal(policy.requiresConversationAuthorization,false);
 assert.equal(policy.requiresServerConversationAuthorization,true);
 assert.equal(policy.privateReplies.requiresAgentAssignment,true);
 assert.equal(policy.groups.sendCapable,false);
 const rest=await f.request('/api/service/v1/me',{token:service.token});assert.equal(rest.status,200);
 const client=await f.connect(service.token),mcp=parseTool(await client.callTool({name:'elozi_me',arguments:{}}));
 for(const me of [rest.data,mcp]){
  assert.equal(me.apiVersion,2);assert.equal(me.agent.mode,'autonomous');assert.equal(me.agent.adapterMode,'copilot');
  assert.equal(me.humanApprovalRequired,false);assert.deepEqual(me.responsePolicy,policy);
  assert.equal(me.groupActions.send,false);assert.equal(me.groupActions.schedule,false);
 }
 const after=await f.request(f.path+'/service-principals',{cookie:f.owner.cookie});
 assert.deepEqual(stable(after.data.principals.find(p=>p.id===id)),stable(before.data.principals.find(p=>p.id===id)));
 assert.deepEqual(after.data.responsePolicies[id],policy);
 assert.equal(after.data.principals.find(p=>p.id===id).usage.requests,0);
 const a=f.app.store.tenant(f.admin,f.tenantId).agents.find(a=>a.id==='external');assert.equal(a.mode,'copilot');
 const denied=await f.request('/api/service/v1/replies',{method:'POST',token:service.token,body:{requestId:'autonomy_denied_queue_01',conversationId:'wa-direct',version:1,text:'Synthetic must not be sent'}});
 assert.equal(denied.status,403);assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,0);
});

test('manager autonomy metadata preserves draft and read-only distinctions and tenant boundary',async t=>{
 const f=await queryFixture(t),draft=await f.service(['conversation.read','reply.submit']),reader=await f.service(['conversation.read']);
 const r=await f.request(f.path+'/service-principals',{cookie:f.owner.cookie});assert.equal(r.status,200);
 assert.equal(r.data.responsePolicies[draft.principal.id].effectiveMode,'copilot');assert.equal(r.data.responsePolicies[draft.principal.id].humanApprovalRequired,true);
 assert.equal(r.data.responsePolicies[draft.principal.id].privateReplies.capable,false);
 assert.equal(r.data.responsePolicies[reader.principal.id].effectiveMode,'read-only');
 const anonymous=await f.request(f.path+'/service-principals');assert.equal(anonymous.status,401);assert.equal(anonymous.data.responsePolicies,undefined);
 const foreign=await f.request('/api/tenants/not-this-tenant/service-principals',{cookie:f.owner.cookie});assert.notEqual(foreign.status,200);assert.equal(foreign.data.responsePolicies,undefined);
});
