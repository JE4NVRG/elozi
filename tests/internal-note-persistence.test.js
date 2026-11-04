import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createInternalNoteDrafts } from '../public/attendance-ui.js';
const context={userId:'u1',workspaceId:'w1',tenantId:'t1',conversationId:'c1',active:true,allowedIds:['c1'],authorityKey:'synthetic-csrf-do-not-store',persistenceKey:'public-permissions-v1'};
function fixture(){const map=new Map();let clock=1000;const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};return {map,storage,advance:ms=>clock+=ms,make:()=>createInternalNoteDrafts({now:()=>clock,storage:()=>storage})};}

test('authorized reload restores private note with a separate namespace, no reply or authority token',()=>{
 const f=fixture(),before=f.make();before.sync(context);before.save('Synthetic private note');
 assert.equal(before.persistent,true);assert.equal(f.map.size,1);
 assert.ok(![...f.map.values()].join('').includes(context.authorityKey));
 const after=f.make();assert.equal(after.value,'');after.sync(context);assert.equal(after.value,'Synthetic private note');
 assert.deepEqual([...f.map.keys()],['elozi:internal-note-drafts:v1']);
});
test('hydration requires current allowed conversation and does not revive revoked drafts',()=>{
 const f=fixture(),before=f.make();before.sync(context);before.save('Private');
 const after=f.make();after.sync({...context,allowedIds:[]});assert.equal(after.value,'');
 after.sync(context);assert.equal(after.value,'');
});
test('initial list without selected conversation does not prune a saved note before authorization',()=>{
 const f=fixture(),before=f.make();before.sync(context);before.save('Private');
 const after=f.make();after.sync({...context,conversationId:null,allowedIds:[]});assert.equal(after.value,'');assert.equal(f.map.size,1);
 after.sync(context);assert.equal(after.value,'Private');
});
test('served bootstrap reset preserves initial reload cache but clears an existing authority',()=>{
 const f=fixture(),saved=f.make();saved.sync(context);saved.save('Private');
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const branch=source.split('\n').find(line=>line.includes('if(previousMediaScope!==mediaScope)'));
 assert.ok(branch,'actual bootstrap authority branch');
 const run=previousNoteUser=>vm.runInNewContext(branch,{previousMediaScope:'old',mediaScope:'new',previousNoteUser,
  mediaUI:{reset(){}},state:{},$:()=>null,noteDrafts:f.make(),previousTenants:[],boot:{tenants:[]}});
 run(undefined);assert.equal(f.map.size,1);
 run('u1');assert.equal(f.map.size,0);
});
test('tenant and conversation keys never mix identical conversation IDs',()=>{
 const f=fixture(),d=f.make();d.sync(context);d.save('A');d.sync({...context,tenantId:'t2'});d.save('B');
 const after=f.make();after.sync(context);assert.equal(after.value,'A');after.sync({...context,tenantId:'t2'});assert.equal(after.value,'B');
});
test('user, workspace and public permission changes reject old session content',()=>{
 for(const change of [{userId:'u2'},{workspaceId:'w2'},{persistenceKey:'permissions-v2'}]){
  const f=fixture(),d=f.make();d.sync(context);d.save('Private');const after=f.make();after.sync({...context,...change});assert.equal(after.value,'');
  after.sync(context);assert.equal(after.value,'');
 }
});
test('in-memory authority revocation and reset erase persisted notes too',()=>{
 const f=fixture(),d=f.make();d.sync(context);d.save('Private');d.sync({...context,authorityKey:'revoked'});assert.equal(d.value,'');assert.equal(f.map.size,0);
 d.save('Other');d.reset();assert.equal(f.map.size,0);const after=f.make();after.sync(context);assert.equal(after.value,'');
});
test('24 hour TTL is enforced on reload and expired content is removed',()=>{
 const f=fixture(),d=f.make();d.sync(context);d.save('Private');f.advance(24*60*60*1000);
 const after=f.make();after.sync(context);assert.equal(after.value,'');assert.equal(f.map.size,0);
});
test('blocked or full storage leaves an honestly memory-only draft',()=>{
 const d=createInternalNoteDrafts({storage:()=>({getItem:()=>null,setItem:()=>{throw Error('quota');},removeItem:()=>{}})});
 d.sync(context);assert.equal(d.save('Private'),true);assert.equal(d.value,'Private');assert.equal(d.persistent,false);
});
test('corrupt session content is discarded without blocking typing',()=>{
 const f=fixture();f.map.set('elozi:internal-note-drafts:v1','{bad');const d=f.make();d.sync(context);assert.equal(d.value,'');assert.equal(d.save('Fresh'),true);
});
test('served syncAttendanceTools opts into persistence without serializing CSRF, across reload',()=>{
 const f=fixture(),source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const hook=source.slice(source.indexOf('function syncAttendanceTools()'),source.indexOf('function jumpAttendanceMessage('));
 const state={boot:{session:{userId:'u1',role:'admin',csrfToken:'never-store-this-synthetic-token',permissions:{'inbox.read':true}},tenants:[{id:'t1'}]},tenant:{conversations:[{id:'c1'}]}};
 const run=d=>{vm.runInNewContext(hook+';syncAttendanceTools();',{state,noteDrafts:d,currentConversation:()=>({id:'c1'}),attendanceContext:()=>context,conversationTools:{syncContext(){}},participantsUI:{sync(){}},serviceHandoffsUI:{sync(){}},memoryUI:{syncContext(){}}});};
 const before=f.make();run(before);before.save('Private source-hook draft');const after=f.make();run(after);assert.equal(after.value,'Private source-hook draft');
 assert.ok(![...f.map.values()].join('').includes(state.boot.session.csrfToken));
});
