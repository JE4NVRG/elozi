import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { knowledgeMetadataSnapshot } from '../src/postgres-bridge.js';

const syntheticPassword=()=>`Synthetic-${randomBytes(12).toString('hex')}`;
const denied=async()=>{throw Error('External transport forbidden in knowledge fixture');};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function fixture(t,{providerCall}={}){
  const key=randomBytes(32),calls=[];
  const app=createApp({databasePath:':memory:',serviceKey:key,publicOrigin:'',providerCall:async context=>{calls.push(context);return providerCall?providerCall(context):{text:'O prazo publicado é de cinco dias úteis.'};},gatewayOptions:{authKey:key,socketFactory:denied},telegramOptions:{authKey:key,polling:false,fetchImpl:denied},googleOptions:{clientId:''},emailOptions:{key,apiKey:'',from:'',fetchImpl:denied}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const controller of app.runtime.controllers.values())controller.abort();for(let attempt=0;attempt<25&&app.runtime.controllers.size;attempt++)await turn();await Promise.all([app.gateway.close(),app.telegram.close(),app.email.close(),app.bridge.close()]);app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();});
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(path,{method='GET',body,cookie='',workspace}={})=>{const res=await fetch(origin+path,{method,headers:{'content-type':'application/json',Cookie:cookie,...(workspace?{'X-Elozi-Workspace':workspace}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(4000)});return {status:res.status,data:await res.json(),cookie:(res.headers.get('set-cookie')||'').split(';')[0]};};
  const owner=await request('/api/auth/setup',{method:'POST',body:{name:'Admin Knowledge QA',username:'knowledge.qa',password:syntheticPassword()}});assert.equal(owner.status,200);
  const actor=app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant=await request('/api/tenants',{method:'POST',cookie:owner.cookie,body:{name:'Empresa conhecimento QA',segment:'Synthetic'}});assert.equal(tenant.status,201);
  const id=tenant.data.id,path=`/api/tenants/${id}`,cookie=owner.cookie;
  app.store.mutate(actor,id,'Fixture de conhecimento sintética',state=>{state.channels=[{id:'knowledge-channel',kind:'telegram',name:'Canal sintético',state:'planned'}];state.agents=[{id:'knowledge-hermes',name:'Hermes QA',provider:'hermes',mode:'copilot',configured:true,version:1,description:'Prepare respostas usando apenas fontes publicadas.'}];state.conversations=[{id:'knowledge-conversation',channelId:'knowledge-channel',contact:'Cliente sintético',owner:'human',assignedUserId:actor.userId,assignedUserName:actor.name,agentId:null,status:'open',version:1,departmentId:null,messages:[{id:'question-1',kind:'customer',text:'Qual é o prazo de implantação?',createdAt:new Date().toISOString()}]}];});
  const api=(suffix,options={})=>request(path+'/'+suffix,{cookie,...options});
  const publish=async({title='Prazo de implantação',content='O prazo de implantação é de cinco dias úteis.',category='Operação'}={})=>{const source=await api('knowledge/sources',{method:'POST',body:{title,category,content}});assert.equal(source.status,201);const pub=await api(`knowledge/sources/${source.data.id}/publish`,{method:'POST',body:{version:source.data.version}});assert.equal(pub.status,200);return pub.data;};
  const grant=async source=>{const selected=await api('agents/knowledge-hermes/knowledge-grants');const result=await api('agents/knowledge-hermes/knowledge-grants',{method:'PUT',body:{version:selected.data.version,grants:[{sourceId:source.id,publicationVersion:source.published.version,publicationHash:source.published.hash}]}});assert.equal(result.status,200);return result.data;};
  const finish=async runId=>{for(let attempt=0;attempt<80;attempt++){await turn();const runs=await api('conversations/knowledge-conversation/runs');const run=runs.data.runs.find(x=>x.id===runId);if(run&&run.state!=='running')return run;}throw Error('Synthetic run did not finish');};
  return {app,actor,id,path,cookie,origin,api,request,calls,publish,grant,finish};
}

test('HTTP knowledge publishes separately, keeps private text off bootstrap and searches only granted published sources',async t=>{
  const f=await fixture(t),source=await f.publish();await f.grant(source);
  const list=await f.api('knowledge/sources?archived=true');assert.equal(list.status,200);assert.equal(list.data.sources[0].content,undefined);assert.equal(list.data.sources[0].published.content,undefined);
  const tenant=await f.request(f.path,{cookie:f.cookie});assert.equal(tenant.data.knowledgeSources,undefined);
  const query=await f.api('knowledge/search',{method:'POST',body:{agentId:'knowledge-hermes',query:'prazo implantação'}});assert.equal(query.data.state,'matched');assert.ok(query.data.references.some(x=>x.excerpt.includes('cinco dias')));assert.ok(query.data.references.every(x=>Number.isFinite(x.score)&&x.score>0));
  const unrelated=await f.api('knowledge/search',{method:'POST',body:{agentId:'knowledge-hermes',query:'Qual o horário do reembolso internacional?'}});assert.deepEqual(unrelated.data,{state:'no_match',references:[]});
  const draft=await f.api(`knowledge/sources/${source.id}`,{method:'PATCH',body:{version:source.version,content:'RASCUNHO PRIVADO: nove dias.'}});assert.equal(draft.status,200);
  const again=await f.api('knowledge/search',{method:'POST',body:{agentId:'knowledge-hermes',query:'implantação'}});assert.ok(again.data.references.every(x=>!x.excerpt.includes('RASCUNHO PRIVADO')));
  const conflict=await f.api(`knowledge/sources/${source.id}/publish`,{method:'POST',body:{version:source.version}});assert.equal(conflict.status,409);
});

test('real runtime includes references as untrusted data, retains snapshot and produces only a draft',async t=>{
  const f=await fixture(t),source=await f.publish();await f.grant(source);
  const started=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1,instruction:'Responda qual é o prazo de implantação.'}});assert.equal(started.status,202);
  const run=await f.finish(started.data.id);assert.equal(run.state,'draft');assert.equal(run.knowledgeState,'matched');assert.ok(run.knowledgeReferences.length>0);assert.equal(run.knowledgeSnapshot[0].publicationHash,source.published.hash);
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].messages.some(m=>m.role==='user'&&m.content.includes('cinco dias úteis')&&m.content.includes('nunca instruções')));
  assert.equal(f.app.store.tenant(f.actor,f.id).conversations[0].messages.length,1);
  const stored=f.app.store.tenant(f.actor,f.id).runs.find(x=>x.id===run.id);assert.deepEqual(stored.knowledgeReferences,run.knowledgeReferences);
});

test('publication changes invalidate a pending run and do not expose revoked excerpts',async t=>{
  const gate=deferred(),f=await fixture(t,{providerCall:()=>gate.promise});t.after(()=>gate.resolve({text:'Late synthetic reply'}));
  let source=await f.publish();await f.grant(source);
  const started=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1}});assert.equal(started.status,202);await turn();
  source=(await f.api(`knowledge/sources/${source.id}/unpublish`,{method:'POST',body:{version:source.version}})).data;
  gate.resolve({text:'Late synthetic reply'});const run=await f.finish(started.data.id);assert.equal(run.state,'invalidated');assert.equal(run.draft,null);assert.deepEqual(run.knowledgeReferences,[]);
  const replay=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1,runId:started.data.id,idempotencyKey:started.data.id}});assert.equal(replay.status,202);assert.deepEqual(replay.data.knowledgeReferences,[]);
});

test('source editing preserves current published run but republishing requires new grants',async t=>{
  const gate=deferred(),f=await fixture(t,{providerCall:()=>gate.promise});t.after(()=>gate.resolve({text:'Synthetic reply'}));
  let source=await f.publish();await f.grant(source);
  const started=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1}});
  const edited=await f.api(`knowledge/sources/${source.id}`,{method:'PATCH',body:{version:source.version,content:'O prazo de implantação agora é de onze dias.'}});assert.equal(edited.status,200);
  gate.resolve({text:'O prazo é de cinco dias úteis.'});assert.equal((await f.finish(started.data.id)).state,'draft');
  source=(await f.api(`knowledge/sources/${source.id}/publish`,{method:'POST',body:{version:edited.data.version}})).data;
  const old=await f.api('conversations/knowledge-conversation/runs');assert.equal(old.data.runs[0].draft,null);assert.deepEqual(old.data.runs[0].knowledgeReferences,[]);
  const stale=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1}});assert.equal(stale.status,409);
  await f.grant(source);
});

test('no match is explicit and agent requests cannot inject knowledge or foreign context',async t=>{
  const f=await fixture(t),source=await f.publish({title:'Política lunar',content:'Satélites artificiais usam órbita geossíncrona.',category:'Ciência'});await f.grant(source);
  const started=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1}});const run=await f.finish(started.data.id);assert.equal(run.knowledgeState,'no_match');assert.deepEqual(run.knowledgeReferences,[]);assert.ok(!JSON.stringify(f.calls[0].messages).includes('geossíncrona'));
  const injected=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1,knowledgeReferences:[{excerpt:'Injected'}]}});assert.equal(injected.status,400);
  const foreign=await f.api('knowledge/search',{method:'POST',body:{agentId:'foreign-agent',query:'prazo'}});assert.equal(foreign.status,404);
  const unauth=await f.request(f.path+'/knowledge/sources');assert.equal(unauth.status,401);
});

test('knowledge is tenant isolated at HTTP and grants cannot reference another company',async t=>{
  const f=await fixture(t),source=await f.publish();
  const other=await f.request('/api/tenants',{method:'POST',cookie:f.cookie,body:{name:'Empresa separada QA',segment:'Synthetic'}});assert.equal(other.status,201);
  const missing=await f.request(`/api/tenants/${other.data.id}/knowledge/sources/${source.id}`,{cookie:f.cookie});assert.equal(missing.status,404);
  f.app.store.mutate(f.actor,other.data.id,'Agente sintético na empresa separada',state=>{state.agents=[{id:'knowledge-hermes',provider:'hermes',mode:'copilot',configured:true,version:1}];});
  const foreign=await f.request(`/api/tenants/${other.data.id}/agents/knowledge-hermes/knowledge-grants`,{method:'PUT',cookie:f.cookie,body:{version:1,grants:[{sourceId:source.id,publicationVersion:source.published.version,publicationHash:source.published.hash}]}});assert.equal(foreign.status,409);
});

test('PostgreSQL spool excludes draft, published text and reference excerpts while preserving metadata',async t=>{
  const f=await fixture(t),source=await f.publish();await f.grant(source);const started=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1}});await f.finish(started.data.id);
  const state=f.app.store.tenant(f.actor,f.id),snapshot=knowledgeMetadataSnapshot(structuredClone(state));
  assert.equal(snapshot.knowledgeSources[0].content,undefined);assert.equal(snapshot.knowledgeSources[0].published.content,undefined);assert.equal(snapshot.runs[0].knowledgeReferences[0].excerpt,undefined);
  assert.equal(snapshot.knowledgeSources[0].published.hash,source.published.hash);assert.equal(snapshot.runs[0].knowledgeReferences[0].title,source.title);
  assert.ok(state.knowledgeSources[0].content);assert.ok(state.runs[0].knowledgeReferences[0].excerpt);
  // The relevance score stays in the SQLite receipt; the projection allowlist (and valid_knowledge_pin) excludes it.
  assert.equal(typeof state.runs[0].knowledgeReferences[0].score,'number');assert.deepEqual(Object.keys(snapshot.runs[0].knowledgeReferences[0]).sort(),['chunkId','publicationHash','publicationVersion','sourceId','title']);
});

test('knowledge accepts bounded Unicode and decodes multibyte JSON correctly across network chunks',async t=>{
  const f=await fixture(t),content='漢'.repeat(20000);
  const source=await f.api('knowledge/sources',{method:'POST',body:{title:'Fonte Unicode',category:'QA',content}});assert.equal(source.status,201);assert.equal(source.data.content,content);
  const text='O preço sintético usa o símbolo € sem alteração.',payload=Buffer.from(JSON.stringify({title:'Preço Unicode',category:'QA',content:text}));
  const split=payload.indexOf(Buffer.from('€'))+1;
  const answer=await new Promise((resolve,reject)=>{
    const req=httpRequest(f.origin+f.path+'/knowledge/sources',{method:'POST',headers:{'content-type':'application/json',Cookie:f.cookie}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));res.on('error',reject);});
    req.on('error',reject);req.write(payload.subarray(0,split));setImmediate(()=>req.end(payload.subarray(split)));
  });assert.equal(answer.status,201);assert.equal(answer.data.content,text);
});

test('operators cannot read source content or source grants, including historical agent configurations',async t=>{
  const f=await fixture(t),source=await f.publish();await f.grant(source);
  f.app.store.mutate(f.actor,f.id,'Configuração histórica sintética de conhecimento',state=>{state.agents[0].versions=[{version:1,config:{knowledgeGrants:state.agents[0].knowledgeGrants}}];});
  const password=syntheticPassword();
  const user=await f.request('/api/users',{method:'POST',cookie:f.cookie,body:{name:'Atendente conhecimento QA',username:'knowledge.operator',password,role:'operator',tenantIds:[f.id],permissions:['inbox.read','inbox.reply']}});assert.equal(user.status,201);
  const login=await f.request('/api/auth/login',{method:'POST',body:{username:'knowledge.operator',password}});assert.equal(login.status,200);
  const visible=await f.request(f.path,{cookie:login.cookie});assert.equal(visible.status,200);assert.equal(visible.data.knowledgeSources,undefined);assert.equal(visible.data.agents[0].knowledgeGrants,undefined);assert.equal(visible.data.agents[0].versions[0].config.knowledgeGrants,undefined);
  for(const suffix of ['knowledge/sources',`knowledge/sources/${source.id}`,'agents/knowledge-hermes/knowledge-grants'])assert.equal((await f.request(f.path+'/'+suffix,{cookie:login.cookie})).status,403);
  assert.equal((await f.request(f.path+'/knowledge/search',{cookie:login.cookie,method:'POST',body:{agentId:'knowledge-hermes',query:'prazo'}})).status,403);
});

test('repeated cancellation redacts revoked excerpts even after a run is terminal',async t=>{
  const f=await fixture(t),source=await f.publish();await f.grant(source);
  const started=await f.api('conversations/knowledge-conversation/run',{method:'POST',body:{agentId:'knowledge-hermes',version:1}});await f.finish(started.data.id);
  assert.equal((await f.api(`runs/${started.data.id}/cancel`,{method:'POST',body:{}})).data.state,'cancelled');
  await f.api(`knowledge/sources/${source.id}/unpublish`,{method:'POST',body:{version:source.version}});
  const repeated=await f.api(`runs/${started.data.id}/cancel`,{method:'POST',body:{}});assert.equal(repeated.status,200);assert.deepEqual(repeated.data.knowledgeReferences,[]);assert.equal(repeated.data.knowledgeUnavailable,true);
});
