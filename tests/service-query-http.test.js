import test from 'node:test';import assert from 'node:assert/strict';import {queryFixture}from'./service-query-fixture.js';
const search='/api/service/v1/search',history='/api/service/v1/conversation-history';
test('REST busca encontra textos antigos nos três canais e somente grupos selecionados, sem mudar atendimento',async t=>{
  const f=await queryFixture(t),s=await f.service(),before=f.snapshot(),body={requestId:'http_query_0001',query:'SINCRONIZACAO pedido'};
  const first=await f.request(search,{method:'POST',token:s.token,body}),again=await f.request(search,{method:'POST',token:s.token,body});
  assert.equal(first.status,200,first.data.error);assert.deepEqual(first.data.conversations.map(c=>c.conversationId).sort(),['tg-direct','tg-group','wa-direct','wa-group','web-direct']);
  assert.equal(again.status,200,again.data.error);assert.equal(first.data.receipt,again.data.receipt);assert.equal(f.app.servicePrincipals.list(f.admin,f.tenantId).principals[0].usage.requests,1);
  for(const hidden of ['PRIVATE_NOTE_QUERY_SECRET','UNSELECTED_GROUP_QUERY','HIDDEN_CHANNEL_QUERY','HIDDEN_DEPARTMENT_QUERY','FOREIGN_COMPANY_QUERY'])assert.equal(JSON.stringify(first.data).includes(hidden),false);
  assert.equal(f.snapshot(),before);assert.equal((await f.request(search,{method:'POST',token:s.token,body:{requestId:'http_query_0002',query:'Joao cliente'}})).data.conversations.length,3);
});
test('REST pagina a busca sem duplicar e lê as150 mensagens antigas em páginas cronológicas',async t=>{
  const f=await queryFixture(t),s=await f.service(),args={query:'sincronização',limit:2};const seen=[];let cursor;
  do{const r=await f.request(search,{method:'POST',token:s.token,body:{requestId:'http_page_'+String(seen.length).padStart(3,'0'),...args,...(cursor?{cursor}:{})}});assert.equal(r.status,200,r.data.error);seen.push(...r.data.conversations.map(c=>c.conversationId));cursor=r.data.nextCursor;}while(cursor);
  assert.equal(seen.length,5);assert.equal(new Set(seen).size,5);
  const h={conversationId:'old-history',after:'2026-08-01T00:00:00Z',before:'2026-08-02T00:00:00Z',limit:100};
  const a=await f.request(history,{method:'POST',token:s.token,body:{requestId:'http_history_01',...h}});assert.equal(a.status,200,a.data.error);assert.equal(a.data.messages.length,100);assert.equal(a.data.messages[0].id,'old-050');
  const b=await f.request(history,{method:'POST',token:s.token,body:{requestId:'http_history_02',...h,cursor:a.data.nextCursor}});assert.equal(b.status,200,b.data.error);assert.equal(b.data.messages.length,50);assert.equal(b.data.messages[0].id,'old-000');assert.equal(b.data.nextCursor,null);
  assert.ok(a.data.messages.every((m,i,all)=>!i||m.createdAt>=all[i-1].createdAt));for(const value of ['PRIVATE_MEDIA_QUERY','PRIVATE_PREVIEW_QUERY'])assert.equal(JSON.stringify(b.data).includes(value),false);
});
test('REST recusa cookies humanos, escopo estrangeiro, capacidade ausente e argumento de empresa forjado',async t=>{
  const f=await queryFixture(t),s=await f.service(),readonlyCompany=await f.service(['company.read']);
  assert.equal((await f.request(search,{method:'POST',cookie:f.owner.cookie,body:{requestId:'http_unauth_01',query:'pedido'}})).status,401);
  assert.equal((await f.request(search,{method:'POST',token:readonlyCompany.token,body:{requestId:'http_capability_01',query:'pedido'}})).status,403);
  assert.equal((await f.request(search,{method:'POST',token:s.token,body:{requestId:'http_forged_01',query:'pedido',tenantId:f.tenantId}})).status,400);
  for(const conversationId of ['hidden-conversation','hidden-department','unselected'])assert.equal((await f.request(history,{method:'POST',token:s.token,body:{requestId:'http_denied_'+conversationId,conversationId}})).status,403);
  assert.equal((await f.request(history,{method:'POST',token:s.token,body:{requestId:'http_foreign_01',conversationId:'foreign-conversation'}})).status,404);
});
test('REST cursor exige mesmo filtro, principal e snapshot; grupo desmarcado nunca reaparece',async t=>{
  const f=await queryFixture(t),s=await f.service(),other=await f.service();const first=await f.request(search,{method:'POST',token:s.token,body:{requestId:'http_cursor_01',query:'pedido',limit:1}});assert.equal(first.status,200,first.data.error);assert.ok(first.data.nextCursor);
  for(const [token,query]of[[other.token,'pedido'],[s.token,'outro']])assert.equal((await f.request(search,{method:'POST',token,body:{requestId:'http_cursor_02',query,limit:1,cursor:first.data.nextCursor}})).status,409);
  f.change(state=>{state.channels.find(c=>c.id==='wa').allowedGroups=[];});
  assert.equal((await f.request(search,{method:'POST',token:s.token,body:{requestId:'http_cursor_03',query:'pedido',limit:1,cursor:first.data.nextCursor}})).status,409);
  const current=await f.request(search,{method:'POST',token:s.token,body:{requestId:'http_cursor_04',query:'pedido'}});assert.equal(current.status,200,current.data.error);assert.equal(current.data.conversations.some(c=>c.conversationId==='wa-group'),false);
});
