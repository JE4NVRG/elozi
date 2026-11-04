import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './helpers/mini-dom.js';
import { createFollowUpsUI, followUpDueAt, followUpsContextKey } from '../public/follow-ups-ui.js';
import { setLocale } from '../public/i18n.js';

const item = (extra={}) => ({id:'f1',kind:'support',title:'Retorno humano',nextAction:'Conferir orçamento',dueAt:null,state:'pending',userId:'u',authorName:'Ana',createdAt:'2026-10-24T12:00:00Z',updatedAt:'2026-10-24T12:00:00Z',...extra});
function fixture(t, intercept) {
  const context={workspaceId:'w',tenantId:'t',conversationId:'c',channelId:'ch',userId:'u',authorityKey:'role',active:true,canRead:true,canWrite:true,version:1};
  const doc=createDocument('<section id="conversation-follow-ups"></section>');
  let host=doc.querySelector('#conversation-follow-ups'), rows=[item()], version=1;
  const calls=[], mutations=[], errors=[], bindings=new Map();
  // mini-dom parses the real UI. This adapter adds host-local event delivery (the helper only has document listeners).
  function bind(node) { const listeners={}; node.addEventListener=(type,fn)=>(listeners[type]??=[]).push(fn);node.removeEventListener=(type,fn)=>{listeners[type]=(listeners[type]||[]).filter(x=>x!==fn);};bindings.set(node,listeners);return node; }
  bind(host);
  const fallback=(path,init)=>{
    if(init.method==='GET')return {items:structuredClone(rows),version,canWrite:true};
    const body=JSON.parse(init.body);version++;
    const record=init.method==='POST'?item({...body,id:'new',userId:'u'}):{...(rows.find(row=>row.id==='f1') || item()),...body,id:'f1'};
    rows=init.method==='POST'?[record,...rows]:[record];return {item:record,version};
  };
  const ui=createFollowUpsUI({getContext:()=>context,getHost:()=>host,request:async(path,init)=>{calls.push({path,init});return intercept?intercept(path,init,fallback):fallback(path,init);},onMutation:(result,captured)=>mutations.push({result,captured}),onError:error=>errors.push(error)});
  const find=s=>host.querySelector(s),field=(name,value)=>{const node=find(`[name="${name}"]`);assert.ok(node,name);if(value!==undefined)node.value=value;return node;};
  async function dispatch(type,target){assert.ok(target);const event={target,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};await Promise.all((bindings.get(host)[type]||[]).map(fn=>fn(event)));return event;}
  const click=(action,id)=>dispatch('click',find(`[data-follow-up-action="${action}"]${id?`[data-id="${id}"]`:''}`));
  const submit=()=>dispatch('submit',find('[data-follow-up-form]'));
  t.after(()=>{ui.reset();setLocale('pt-BR',{persist:false,notify:false});});
  return {ui,context,calls,mutations,errors,doc,find,field,click,submit,dispatch,get host(){return host;},replaceHost(){const next=doc.createElement('section');next.setAttribute('id','conversation-follow-ups');host.remove();doc.body.append(next);host=bind(next);},setRows:r=>{rows=r;},text:()=>host.textContent};
}

test('strict datetime-local conversion rejects impossible/offset input and accepts past or empty dates',()=>{
  assert.equal(followUpDueAt(''),null);
  assert.equal(followUpDueAt('2020-01-02T03:04'),new Date(2020,0,2,3,4).toISOString());
  for(const value of ['2026-02-30T10:00','2026-13-01T10:00','2026-01-01','2026-01-01T10:00Z','nope'])assert.throws(()=>followUpDueAt(value));
});

test('sync loads only changed context/version and escapes customer data, exposes no owner picker',async t=>{
  const f=fixture(t);f.setRows([item({title:'<script>unsafe</script>',nextAction:'<img src=x>',authorName:'<b>Ana</b>'})]);
  await f.ui.sync();await f.ui.sync();assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/tenants/t/conversations/c/follow-ups');
  assert.deepEqual(f.calls[0].init.headers,{'X-Elozi-Workspace':'w'});assert.equal(f.find('script'),null);assert.equal(f.find('img'),null);assert.ok(f.text().includes('<script>unsafe</script>'));assert.ok(f.text().includes('não envia mensagens'));
  f.context.version=2;await f.ui.sync();assert.equal(f.calls.length,2);await f.ui.open();assert.equal(f.find('[name="userId"]'),null);assert.equal(f.doc.activeElement,f.field('title'));
});

test('open joins the actual initial scoped GET instead of silently requiring a second click',async t=>{
  let resolve,read;
  const f=fixture(t,(path,init,next)=>{
    assert.equal(init.method,'GET');read=()=>next(path,init);return new Promise(done=>{resolve=done;});
  });
  const initial=f.ui.sync(),opening=f.ui.open();
  assert.equal(f.calls.length,1);assert.equal(f.find('[data-follow-up-form]'),null);
  resolve(read());await initial;
  assert.equal(await opening,true);assert.ok(f.find('[data-follow-up-form]'));
  assert.equal(f.calls.length,1);assert.equal(f.doc.activeElement,f.field('title'));
});

test('joined initial read cannot open an editor without fresh server write authority',async t=>{
  let resolve;
  const f=fixture(t,()=>new Promise(done=>{resolve=done;}));
  const initial=f.ui.sync(),opening=f.ui.open();
  resolve({items:[],version:1,canWrite:false});await initial;
  assert.equal(await opening,false);assert.equal(f.find('[data-follow-up-form]'),null);
  assert.equal(f.calls.length,1);
});

test('create is explicit, scoped and emits confirmed receipt with captured context, not message send',async t=>{
  const f=fixture(t);await f.ui.sync();await f.ui.open();f.field('title','  Retornar  ');f.field('nextAction','Conferir');f.field('kind','quote');f.field('dueAt','2020-01-02T03:04');
  const event=await f.submit();assert.equal(event.prevented,true);assert.equal(event.stopped,true);
  const body=JSON.parse(f.calls[1].init.body);assert.deepEqual({...body,commandId:'id'}, {version:1,commandId:'id',kind:'quote',title:'Retornar',nextAction:'Conferir',dueAt:new Date(2020,0,2,3,4).toISOString()});assert.ok(body.commandId);assert.equal(f.calls[1].init.method,'POST');assert.equal(f.mutations.length,1);assert.equal(f.mutations[0].captured.conversationId,'c');assert.equal(f.calls.some(c=>/messages|send/.test(c.path)),false);assert.equal(f.find('[data-follow-up-form]'),null);
});

test('draft DOM/focus survives version polling; busy submit cannot duplicate writes',async t=>{
  let resolve;const f=fixture(t,(p,i,next)=>i.method==='POST'?new Promise(done=>resolve=done):next(p,i));
  await f.ui.sync();await f.ui.open();const title=f.field('title','Draft');title.focus();f.context.version=2;await f.ui.sync();assert.equal(f.field('title'),title);assert.equal(title.value,'Draft');assert.equal(f.doc.activeElement,title);
  const pending=f.submit();assert.equal(f.field('title').disabled,true);await f.submit();assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
  resolve({item:item({id:'new',title:'Draft',nextAction:'',kind:'support'}),version:2});await pending;
});

test('edit next step and deadline; terminal transitions require outcome and never offer reopen',async t=>{
  const f=fixture(t);await f.ui.sync();await f.click('edit','f1');f.field('nextAction','Ligar amanhã');f.field('dueAt','');await f.submit();
  assert.deepEqual(JSON.parse(f.calls[1].init.body),{version:1,state:'pending',nextAction:'Ligar amanhã',dueAt:null,outcome:''});
  await f.click('done','f1');f.field('outcome','');await f.submit();assert.equal(f.calls.length,2);f.field('outcome','Resolvido por telefone');await f.submit();assert.equal(JSON.parse(f.calls[2].init.body).state,'done');assert.equal(f.find('[data-follow-up-action="edit"]'),null);assert.equal(f.find('[data-follow-up-action="reopen"]'),null);
});

test('cancel requires explicit outcome; invalid lengths/date do not issue writes',async t=>{
  const f=fixture(t);await f.ui.sync();await f.click('cancel','f1');f.field('outcome','Sem necessidade');await f.submit();assert.equal(JSON.parse(f.calls[1].init.body).state,'cancelled');
  await f.ui.open();f.field('title','x'.repeat(161));await f.submit();assert.equal(f.calls.length,2);f.field('title','Ok');f.field('dueAt','2026-02-30T10:00');await f.submit();assert.equal(f.calls.length,2);
});

test('409 preserves edits, requires an explicit real GET and never replays a mutation',async t=>{
  const f=fixture(t,(p,i,next)=>{if(i.method==='PATCH')throw Object.assign(new Error('Conflict'),{status:409});return next(p,i);});
  await f.ui.sync();await f.click('edit','f1');f.field('nextAction','Não perder');await f.submit();assert.equal(f.field('nextAction').value,'Não perder');assert.equal(f.calls.length,2);await f.submit();assert.equal(f.calls.length,2);await f.click('refresh');assert.equal(f.calls[2].init.method,'GET');assert.equal(f.field('nextAction').value,'Não perder');assert.equal(f.calls.filter(c=>c.init.method==='PATCH').length,1);
});

test('uncertain create retries use original commandId and exact body, editing starts another intent',async t=>{
  const f=fixture(t,(p,i,next)=>{if(i.method==='POST')throw new Error('Network');return next(p,i);});
  await f.ui.sync();await f.ui.open();f.field('title','Mesmo pedido');await f.submit();await f.submit();assert.equal(f.calls[1].init.body,f.calls[2].init.body);assert.equal(f.mutations.length,0);f.field('title','Outro pedido');await f.submit();assert.notEqual(JSON.parse(f.calls[2].init.body).commandId,JSON.parse(f.calls[3].init.body).commandId);
});

test('uncertain create keeps original command and version after a real refresh observes the committed record',async t=>{
 let original,receipt;
 const f=fixture(t,(path,init,next)=>{
  if(init.method==='POST'){
   const body=JSON.parse(init.body);
   if(!original){original=body;receipt=next(path,init);throw new Error('Response lost after commit');}
   return body.commandId===original.commandId?receipt:next(path,init);
  }
  return next(path,init);
 });
 await f.ui.sync();await f.ui.open();f.field('title','Same committed task');await f.submit();
 await f.click('refresh');await f.submit();
 const posts=f.calls.filter(c=>c.init.method==='POST');assert.equal(posts.length,2);
 assert.deepEqual(JSON.parse(posts[1].init.body),original,'poll/GET revision is not a new user command');
 assert.equal(f.mutations.length,1);assert.equal(f.mutations[0].result.item.id,receipt.item.id);
});

test('replayed original receipt reconciles a newer completed record instead of showing stale pending state',async t=>{
 let original,receipt;
 const f=fixture(t,(path,init,next)=>{
  if(init.method==='POST'){
   if(!original){original=JSON.parse(init.body);receipt=next(path,init);throw new Error('Lost after commit');}
   return receipt;
  }
  if(original)return {items:[{...receipt.item,state:'done',outcome:'Completed elsewhere'}],version:5,canWrite:true};
  return next(path,init);
 });
 await f.ui.sync();await f.ui.open();f.field('title','Existing task');await f.submit();await f.click('refresh');await f.submit();
 assert.equal(f.calls.filter(c=>c.init.method==='GET').length,3,'real GET after replay reconciles newer server state');
 assert.ok(f.text().includes('Completed elsewhere'));assert.equal(f.find('[data-follow-up-action="edit"]'),null);assert.equal(f.mutations.length,1);
});
test('definitive conflict allows rebasing only after refresh and another explicit submit',async t=>{
 let first;
 const f=fixture(t,(path,init,next)=>{
  if(init.method==='POST'&&!first){first=JSON.parse(init.body);throw Object.assign(Error('CAS refused before mutation'),{status:409});}
  if(init.method==='GET'&&first)return {items:[],version:2,canWrite:true};
  if(init.method==='POST'&&first)return {item:item({...JSON.parse(init.body),id:'new'}),version:3};
  return next(path,init);
 });
 await f.ui.sync();await f.ui.open();f.field('title','Explicit retry');await f.submit();await f.submit();assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
 await f.click('refresh');await f.submit();const last=JSON.parse(f.calls.filter(c=>c.init.method==='POST')[1].init.body);assert.equal(last.version,2);assert.notEqual(last.commandId,first.commandId);assert.equal(f.mutations.length,1);
});

test('generation fences A-B-A, reset and detached hosts even when transport ignores abort',async t=>{
  const waits=[];const f=fixture(t,()=>new Promise(done=>waits.push(done)));
  const a=f.ui.sync();f.context.conversationId='b';const b=f.ui.sync();f.context.conversationId='c';const again=f.ui.sync();
  waits[2]({items:[item({title:'Current'})],version:1});await again;waits[0]({items:[item({title:'Old A'})],version:1});waits[1]({items:[item({title:'Old B'})],version:1});await Promise.all([a,b]);assert.ok(f.text().includes('Current'));assert.equal(f.text().includes('Old A'),false);assert.equal(f.calls[0].init.signal.aborted,true);
  f.context.version=3;const pending=f.ui.sync();f.replaceHost();waits[3]({items:[item({title:'Detached'})],version:3});await pending;assert.equal(f.text().includes('Detached'),false);f.ui.reset();assert.equal(f.calls[3].init.signal.aborted,true);
});

test('read/write permissions fail closed, revoked context clears and stale writes never notify',async t=>{
  assert.equal(followUpsContextKey({active:true,canRead:true}), '');
  let resolve;const f=fixture(t,(p,i,next)=>i.method==='POST'?new Promise(done=>resolve=done):next(p,i));await f.ui.sync();await f.ui.open();f.field('title','Pending');const pending=f.submit();f.context.canRead=false;await f.ui.sync();assert.equal(f.text(),'');resolve({item:item({id:'new',title:'Pending',nextAction:''}),version:2});await pending;assert.equal(f.mutations.length,0);
  f.context.canRead=true;f.context.canWrite=false;await f.ui.sync();assert.equal(await f.ui.open(),false);assert.equal(f.find('[data-follow-up-action="edit"]'),null);
});

test('malformed receipt never claims success; auth failure clears and reports; GET retry works',async t=>{
  let mode='get';const f=fixture(t,(p,i,next)=>{if(mode==='get')throw new Error('Offline');if(mode==='receipt'&&i.method==='POST')return {item:item({title:'Other'}),version:2};if(mode==='denied')throw Object.assign(new Error('Denied'),{status:403});return next(p,i);});
  await f.ui.sync();assert.ok(f.find('[role="alert"]'));mode='ok';await f.click('refresh');await f.ui.open();f.field('title','Requested');mode='receipt';await f.submit();assert.equal(f.mutations.length,0);assert.ok(f.find('[data-follow-up-form]'));mode='denied';await f.click('refresh');assert.equal(f.text(),'');assert.equal(f.errors.length,1);
});

test('fresh scoped GET false or absent never grants write from the global prefilter',async t=>{
  for(const canWrite of [false,undefined]) {
    const f=fixture(t,()=>({items:[item()],version:1,...(canWrite===undefined?{}:{canWrite})}));
    await f.ui.sync();assert.ok(f.text().includes('Retorno humano'));assert.equal(await f.ui.open(),false);
    assert.equal(f.find('[data-follow-up-form]'),null);assert.equal(f.find('[data-follow-up-action="edit"]'),null);
  }
});

test('English labels and 40-item limit are real rendered behavior',async t=>{
  setLocale('en',{persist:false,notify:false});const f=fixture(t);f.setRows([]);await f.ui.sync();assert.ok(f.text().includes('No manual follow-ups'));assert.ok(f.text().includes('does not send messages'));f.setRows(Array.from({length:41},(_,i)=>item({id:String(i)})));f.context.version=2;await f.ui.sync();assert.ok(f.find('[role="alert"]'));assert.equal(f.find('[data-follow-up-action="edit"]'),null);
});
