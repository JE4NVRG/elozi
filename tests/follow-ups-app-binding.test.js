import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { excerpt } from './helpers/app-source.js';

function fixture(){
 const conversation={id:'c1',channelId:'ch1',version:3},label={textContent:''},host={},errors=[];
 const state={workspaceId:'w1',tenant:{id:'t1'},conversation:'c1',view:'inbox',inboxSelecting:false,boot:{session:{userId:'u1'}}};
 let authority='scope1',options,current=conversation;
 const context={state,currentConversation:()=>current,inboxContactAuthority:()=>authority,
  hasPermission:permission=>['inbox.read','inbox.reply'].includes(permission),api:()=>{throw Error('Binding test must not call an API');},
  $:selector=>selector==='#conversation-follow-ups'?host:selector==='#conversation-context .pg-inbox__version strong'?label:null,
  t:(_key,values)=>'Version '+values.version,toast:error=>errors.push(error),createFollowUpsUI:value=>{options=value;return {};}};
 vm.runInNewContext(excerpt('follow-ups-ui'),context);
 return {state,conversation,label,host,errors,options,setAuthority:x=>authority=x,setConversation:x=>current=x};
}

test('served follow-up binding exposes live authorized identity and current version, not a captured selection',()=>{
 const f=fixture(),initial=f.options.getContext();
 assert.equal(initial.workspaceId,'w1');assert.equal(initial.tenantId,'t1');assert.equal(initial.conversationId,'c1');assert.equal(initial.channelId,'ch1');assert.equal(initial.userId,'u1');assert.equal(initial.authorityKey,'scope1');assert.equal(initial.version,3);assert.equal(initial.active,true);assert.equal(initial.canWrite,true);assert.equal(f.options.getHost(),f.host);
 f.state.inboxSelecting=true;assert.equal(f.options.getContext().active,false);
 f.state.inboxSelecting=false;f.setConversation(null);assert.equal(f.options.getContext().canRead,false);assert.equal(f.options.getContext().canWrite,false);
 f.state.view='contacts';assert.equal(f.options.getHost(),null);assert.equal(f.options.getContext().active,false);
});
test('served mutation hook advances only a current version and never rolls back a newer poll',()=>{
 const f=fixture(),captured=f.options.getContext();
 f.options.onMutation({version:4},captured);assert.equal(f.conversation.version,4);assert.equal(f.label.textContent,'Version 4');
 f.conversation.version=7;f.options.onMutation({version:5},captured);assert.equal(f.conversation.version,7);assert.equal(f.label.textContent,'Version 7');
 f.options.onMutation({version:'999'},captured);assert.equal(f.conversation.version,7);
});
test('served error hook accepts translated strings as well as Error objects',()=>{
 const f=fixture();f.options.onError('Translated scope failure');f.options.onError(new Error('Operation failed'));
 assert.deepEqual(f.errors,['Translated scope failure','Operation failed']);
});
for(const field of ['workspaceId','tenantId','conversationId','channelId','userId','authorityKey'])test('served mutation hook rejects stale '+field+' before touching conversation or DOM',()=>{
 const f=fixture(),captured=f.options.getContext();captured[field]='foreign';
 f.options.onMutation({version:99},captured);assert.equal(f.conversation.version,3);assert.equal(f.label.textContent,'');assert.deepEqual(f.errors,[]);
});
test('served mutation cannot update after navigation, revocation or selection removal',()=>{
 for(const mutation of [f=>{f.state.view='contacts';},f=>f.setAuthority('revoked'),f=>f.setConversation(null)]){
  const f=fixture(),captured=f.options.getContext();mutation(f);f.options.onMutation({version:99},captured);
  assert.equal(f.conversation.version,3);assert.equal(f.label.textContent,'');
 }
});
