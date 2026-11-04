import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentRail,isHistoricalInvalidation} from '../public/agent-rail-ui.js';
import {setLocale} from '../public/i18n.js';
const T0=Date.parse('2026-10-09T11:51:08Z'),at=ms=>new Date(T0+ms).toISOString();
const reason='A conversa ou configuração mudou durante a execução.';
const sourceHint='As fontes desta execução não estão mais disponíveis. Prepare um novo rascunho.';
const invalidation=(extra={})=>({id:'old-run',conversationId:'internal-case',agentId:'agent',state:'invalidated',conversationVersion:3,updatedAt:at(0),startedAt:at(-80_000),reason,knowledgeUnavailable:true,draft:null,...extra});
const reply=(kind='human',ms=120_000)=>({id:'public-reply',kind,text:'Resposta sintética.',createdAt:at(ms)});
function fixture(runs,messages=[reply()]){
 const calls=[],conversation={id:'internal-case',version:6,owner:'human',assignedUserId:'operator',agentId:null,status:'open',messages};
 const state={workspaceId:'workspace',conversation:conversation.id,tenant:{id:'tenant',name:'Equipe teste',runs,conversations:[conversation],agents:[{id:'agent',name:'Assistente',configured:true,provider:'hermes',mode:'copilot'}]},boot:{session:{userId:'operator',role:'operator'}}};
 const rail=createAgentRail({state,tenantApi:p=>'/test/'+p,api:(...args)=>{calls.push(args);throw Error('Unexpected request');},canReplyTo:()=>true,renderRuns:()=>{},toast:()=>{},now:()=>T0+600_000,document:null,noListeners:true,knowledgeReferences:r=>r.knowledgeUnavailable?sourceHint:'',memoryReferences:()=>''});
 return {rail,state,conversation,calls};
}

test('invalidação seguida de resposta pública fica no histórico, sem alerta atual ou orientação de fonte sem rascunho',()=>{
 setLocale('pt');const r=invalidation(),f=fixture([r]),before=JSON.stringify(f.state);
 assert.equal(isHistoricalInvalidation(r,f.conversation),true);
 assert.equal(String(f.rail.render(f.conversation)),'');
 const context=String(f.rail.contextTab(f.conversation));
 assert.match(context,/Última execução/);assert.match(context,/09\/10\/2026/);assert.match(context,/Histórico preservado/);assert.ok(context.includes(reason));
 assert.ok(!context.includes(sourceHint));assert.doesNotMatch(context,/Execução atual/);
 assert.equal(JSON.stringify(f.state),before);assert.equal(f.calls.length,0);
});

test('invalidação atual continua visível sem pedir recuperação de fontes de um rascunho inexistente',()=>{
 const f=fixture([invalidation()],[reply('customer',-30_000)]),markup=String(f.rail.render(f.conversation));
 assert.ok(markup.includes(reason));assert.match(markup,/Gerar novamente/);assert.ok(!markup.includes(sourceHint));
 assert.match(String(f.rail.contextTab(f.conversation)),/Execução atual/);assert.equal(f.calls.length,0);
});

test('somente resposta pública posterior encerra a relevância do aviso: entrada, nota, evento e relógio inválido conservam alerta',()=>{
 for(const message of [reply('customer'),reply('internal'),reply('system'),reply('human',0),reply('human',-1),{...reply(),createdAt:'invalid'}]){
  const f=fixture([invalidation()],[message]);assert.equal(isHistoricalInvalidation(f.state.tenant.runs[0],f.conversation),false,JSON.stringify(message));assert.ok(String(f.rail.render(f.conversation)).includes(reason));
 }
 const f=fixture([invalidation({updatedAt:null})]);assert.equal(isHistoricalInvalidation(f.state.tenant.runs[0],f.conversation),false);
 assert.equal(isHistoricalInvalidation(invalidation({conversationId:'other'}),f.conversation),false);
 assert.equal(isHistoricalInvalidation({state:'invalidated'},null),false);
 assert.equal(isHistoricalInvalidation(invalidation(),{id:'internal-case'}),false);
 assert.equal(isHistoricalInvalidation(invalidation({conversationVersion:6}),f.conversation),false);
 assert.equal(isHistoricalInvalidation(invalidation({conversationVersion:null}),f.conversation),false);
});

test('resposta do agente também torna a invalidação anterior histórica, sem mutação',()=>{
 const f=fixture([invalidation()],[reply('agent')]);assert.equal(String(f.rail.render(f.conversation)),'');assert.equal(f.calls.length,0);
});

test('ações externas sem confirmação não são escondidas por uma resposta posterior',()=>{
 for(const state of ['tool_unknown','invalidated'])for(const receiptState of ['unknown','in_flight']){
  const r=invalidation({state,toolProposal:{readOnly:false,title:'Ação externa'},toolReceipt:{state:receiptState}}),f=fixture([r]);
  assert.equal(isHistoricalInvalidation(r,f.conversation),false);assert.notEqual(String(f.rail.render(f.conversation)),'');assert.equal(f.calls.length,0);
 }
});

test('aprovação pendente, execução ativa e rascunho continuam no compositor mesmo após resposta mais recente',()=>{
 for(const state of ['running','queued','tool_running','waiting_approval','draft']){
  const r=invalidation({state,draft:'Rascunho sintético',knowledgeUnavailable:false,toolProposal:{id:'proposal',readOnly:false,title:'Consultar',expiresAt:at(1_200_000)}}),f=fixture([r]);
  assert.equal(isHistoricalInvalidation(r,f.conversation),false);assert.notEqual(String(f.rail.render(f.conversation)),'');assert.equal(f.calls.length,0);
 }
});

test('falha nova depois da invalidação antiga permanece visível',()=>{
 const f=fixture([invalidation(),invalidation({id:'new-run',state:'failed',updatedAt:at(300_000),reason:'Execução interrompida ou tempo limite atingido.'})]);
 assert.match(String(f.rail.render(f.conversation)),/tempo limite/);assert.equal(f.calls.length,0);
});

test('histórico tem título e data também em inglês',t=>{
 setLocale('en');t.after(()=>setLocale('pt'));const f=fixture([invalidation()]);
 const markup=String(f.rail.contextTab(f.conversation));assert.match(markup,/Last run/);assert.match(markup,/Run ended on/);assert.match(markup,/History preserved/);assert.doesNotMatch(markup,/Current run/);
});
