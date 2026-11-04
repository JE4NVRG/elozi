import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const acorn={exports:{}};
new Function('exports','module',process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports,acorn);
const tree=acorn.exports.parse(source,{ecmaVersion:'latest',sourceType:'module'});
const declaration=tree.body.find(n=>n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id.name==='customerContextUI'));
const factory=declaration.declarations.find(d=>d.id.name==='customerContextUI').init;
function harness(overrides={}){
  const calls=[],conversation={id:'a',contactId:'contact',version:4};
  let current={active:true,busy:false,selecting:false,canReadInbox:true,workspaceId:'workspace',tenantId:'company',conversation,
    conversations:[conversation,{id:'b',contactId:'contact'},{id:'other',contactId:'different'}],
    capabilities:{takeover:true,transfer:true,participants:true,handoffs:true,prepareDraft:true},...overrides};
  const ui=runInNewContext(source.slice(factory.start,factory.end),{
    createCustomerContextUI:args=>args,customerContextState:()=>current,escape:String,icon:()=>'',updateCustomerContext:()=>{},
    selectInboxConversation:async(...args)=>calls.push(['open',...args]),act:async action=>calls.push(['act',action]),
    serviceHandoffsUI:{open:async()=>calls.push(['handoffs'])}
  });
  return {ui,calls,set:next=>{current={...current,...next};}};
}
const target={workspaceId:'workspace',tenantId:'company',conversationId:'a',version:4};
test('customer context uses the existing collaboration handlers without sending data',async()=>{
  const h=harness();for(const action of ['takeover','transfer-conversation','conversation-participants','run-agent','service-handoffs'])await h.ui.onAction(action,target);
  assert.deepEqual(h.calls,[['act','takeover'],['act','transfer-conversation'],['act','conversation-participants'],['act','run-agent'],['handoffs']]);
});
for(const [label,change] of Object.entries({workspace:{workspaceId:'other'},company:{tenantId:'other'},revision:{version:3},conversation:{conversationId:'other'}})){
  test(`customer collaboration with stale ${label} never dispatches`,async()=>{
    const h=harness();await h.ui.onAction('takeover',{...target,...change});assert.deepEqual(h.calls,[]);
  });
}
test('revoked capabilities, busy and changed view stop customer context actions',async()=>{
  const h=harness({capabilities:{}});await h.ui.onAction('run-agent',target);
  h.set({busy:true,capabilities:{takeover:true}});await h.ui.onAction('takeover',target);
  h.set({busy:false,active:false});await h.ui.onAction('takeover',target);assert.deepEqual(h.calls,[]);
});
test('related conversation navigation requires the same explicit contact and company',async()=>{
  const h=harness();await h.ui.onOpenConversation({...target,conversationId:'other'});
  await h.ui.onOpenConversation({...target,tenantId:'other',conversationId:'b'});assert.deepEqual(h.calls,[]);
  await h.ui.onOpenConversation({...target,conversationId:'b'});assert.deepEqual(h.calls,[['open','company','b']]);
});
test('a conversation without an explicit contact cannot navigate by similarity',async()=>{
  const h=harness({conversation:{id:'a',version:4}});await h.ui.onOpenConversation({...target,conversationId:'b'});assert.deepEqual(h.calls,[]);
});
