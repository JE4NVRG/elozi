import test from'node:test';import assert from'node:assert/strict';import{ErrorCode}from'@modelcontextprotocol/sdk/types.js';import{queryFixture}from'./service-query-fixture.js';
const object=r=>r.structuredContent;
test('SDK MCP descobre busca/histórico e consulta os canais concedidos sem navegador ou provedor',async t=>{
  const f=await queryFixture(t),s=await f.service(),client=await f.connect(s.token),before=f.snapshot();
  const tools=(await client.listTools()).tools;for(const name of ['elozi_search_conversations','elozi_read_conversation_history'])assert.equal(tools.find(x=>x.name===name).annotations.readOnlyHint,true);
  const args={requestId:'mcp_query_0001',query:'sincronização pedido'},r=object(await client.callTool({name:'elozi_search_conversations',arguments:args}));assert.equal(r.conversations.length,5);assert.equal(r.tenantId,f.tenantId);
  const again=object(await client.callTool({name:'elozi_search_conversations',arguments:args}));assert.equal(again.receipt,r.receipt);
  const h=object(await client.callTool({name:'elozi_read_conversation_history',arguments:{requestId:'mcp_history_01',conversationId:'old-history',after:'2026-08-01T00:00:00Z',before:'2026-08-02T00:00:00Z',limit:100}}));assert.equal(h.messages.length,100);assert.ok(h.nextCursor);assert.equal(h.coverage.historySource,'elozi');assert.equal(f.snapshot(),before);
});
test('SDK MCP rejeita parâmetros forjados e não lista ferramentas de consulta sem capacidade',async t=>{
  const f=await queryFixture(t),s=await f.service(),c=await f.connect(s.token),other=await f.service(['company.read']),d=await f.connect(other.token);
  assert.equal((await d.listTools()).tools.some(x=>x.name==='elozi_search_conversations'),false);
  for(const args of [{query:'x'},{query:'pedido',tenantId:f.tenantId},{query:'pedido',limit:51},{query:'pedido',channelId:'invalid/channel'}])await assert.rejects(c.callTool({name:'elozi_search_conversations',arguments:{requestId:'mcp_bad_query_01',...args}}),e=>e.code===ErrorCode.InvalidParams);
  const r=await c.callTool({name:'elozi_read_conversation_history',arguments:{requestId:'mcp_foreign_01',conversationId:'foreign-conversation'}});assert.equal(object(r).error.status,404);
});
for(const action of ['revoke','group-selection','conversation-change'])test('SDK revalida antes de devolver resultado após await: '+action,async t=>{
  const f=await queryFixture(t),s=await f.service(),c=await f.connect(s.token);let release,entered;const gate=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;}),original=f.app.serviceApi.searchConversations.bind(f.app.serviceApi);
  f.app.serviceApi.searchConversations=async(actor,input)=>{const result=original(actor,input);entered();await wait;return result;};
  const pending=c.callTool({name:'elozi_search_conversations',arguments:{requestId:'mcp_fresh_0001',query:'pedido'}});await gate;
  if(action==='revoke')f.app.servicePrincipals.revoke(f.admin,f.tenantId,s.principal.id,{revision:s.principal.revision});else f.change(state=>{if(action==='group-selection')state.channels.find(x=>x.id==='wa').allowedGroups=[];else state.conversations.find(x=>x.id==='wa-direct').version++;});
  release();const r=await pending;assert.equal(r.isError,true);assert.ok([401,403,409].includes(object(r).error.status));for(const word of ['João','Sincronização','Grupo arquivos'])assert.equal(JSON.stringify(r).includes(word),false);
});
