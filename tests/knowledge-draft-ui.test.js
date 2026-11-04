import test from 'node:test';
import assert from 'node:assert/strict';
// The run cards moved from mcp-ui.js to the agent rail in P1 commit 1f (FRONTEND-V2 §8.2); P4 renders them as
// SafeHTML and inserts a draft through rail:insert-draft (composerBridge) instead of use-run-draft.
import {createAgentRail} from '../public/agent-rail-ui.js';

test('revoked knowledge disables copying a draft while legacy and current sources remain usable',()=>{
  const ui=createAgentRail({state:{},escape:value=>String(value??''),icon:()=>'',badge:()=>'',canReplyTo:()=>true,runNames:{draft:'Rascunho pronto'}});
  const card=(...args)=>String(ui.runCard(...args));
  const conversation={version:9},run={id:'run-1',state:'draft',draft:'Resposta preparada',conversationVersion:9,agentName:'Hermes',requestedByName:'Atendente'};
  const enabled=card(run,conversation);assert.match(enabled,/data-action="rail:insert-draft"/);assert.doesNotMatch(enabled,/data-action="rail:insert-draft"[^>]*disabled/);
  const revoked=card({...run,knowledgeUnavailable:true},conversation);assert.match(revoked,/data-action="rail:insert-draft"[^>]*disabled/);assert.match(revoked,/Prepare um novo rascunho/);
  assert.match(card(run,{version:10}),/data-action="rail:insert-draft"[^>]*disabled/);
  const staleMemory=card({...run,memoryUnavailable:true},conversation);
  assert.match(staleMemory,/data-action="rail:insert-draft"[^>]*disabled/);
  assert.match(staleMemory,/Prepare um novo rascunho/);
});
