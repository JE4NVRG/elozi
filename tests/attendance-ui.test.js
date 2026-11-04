import test from 'node:test';import assert from 'node:assert/strict';
import {selectAttendance,attendanceCounts,attendanceHistory,createInternalNoteDrafts} from '../public/attendance-ui.js';
const e=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const conversations=[{id:'a',contactId:'ca',contact:'Márcia',status:'open',owner:'human',assignedUserId:'u',channelId:'wa',departmentId:'support',updatedAt:'2026-10-01',messages:[{text:'Documento anterior: renovação',attachments:[{name:'Contrato.pdf'}]}]},{id:'b',contact:'Grupo',status:'pending',owner:'queue',channelId:'tg',conversationKind:'group',unread:1,updatedAt:'2026-10-02',messages:[]},{id:'c',contact:'Encerrado',status:'closed',owner:'human',assignedUserId:'u',channelId:'wa',updatedAt:'2026-10-03',messages:[]}];
test('list searches the entire authorized history, accents and explicit CRM link without expanding its source',()=>{
 assert.deepEqual(selectAttendance(conversations,{search:'RENOVACAO'}).map(x=>x.id),['a']);
 assert.deepEqual(selectAttendance(conversations,{search:'contrato.pdf'}).map(x=>x.id),['a']);
 assert.deepEqual(selectAttendance(conversations,{search:'private@example.test',contacts:[{id:'unlinked',email:'private@example.test'}]}),[]);
 assert.deepEqual(selectAttendance(conversations,{search:'private@example.test',contacts:[{id:'ca',email:'private@example.test'}]}).map(x=>x.id),['a']);
 assert.equal(conversations[0].id,'a');
});
test('combined channel/assignment/unread/department/group/status filters are deterministic',()=>{
 assert.deepEqual(selectAttendance(conversations,{userId:'u',filter:'mine',channel:'wa',department:'support'}).map(x=>x.id),['a']);
 assert.deepEqual(selectAttendance(conversations,{unread:true,kind:'group',filter:'queue'}).map(x=>x.id),['b']);
 assert.deepEqual(selectAttendance(conversations,{status:'closed'}).map(x=>x.id),['c']);
 assert.deepEqual(selectAttendance(conversations,{status:'all',sort:'oldest'}).map(x=>x.id),['a','b','c']);
 assert.deepEqual(attendanceCounts(conversations,'u'),{all:3,active:2,mine:1,queue:1,agent:0,unread:1,closed:1});
});
test('internal drafts survive conversation switching but clear on workspace/user/access removal',()=>{
 const d=createInternalNoteDrafts({limit:1}),base={userId:'u',workspaceId:'w',tenantId:'t',active:true,allowedIds:['a','b']};
 d.sync({...base,conversationId:'a'});assert.equal(d.save('Só para a equipe'),true);d.sync({...base,conversationId:'b'});assert.equal(d.value,'');assert.equal(d.save('Outro'),false);
 d.sync({...base,conversationId:'a'});assert.equal(d.value,'Só para a equipe');d.sync({...base,conversationId:'a',allowedIds:['b']});assert.equal(d.value,'');assert.equal(d.count,0);
 d.sync({...base,conversationId:'a'});d.save('Privado');d.sync({...base,conversationId:'a',workspaceId:'other'});assert.equal(d.value,'');
});
test('nota interna em edição sobrevive à caixa multiempresa sem colidir IDs nem exceder limite total',()=>{
 const d=createInternalNoteDrafts({limit:2}),base={userId:'operador',workspaceId:'revenda',authorityKey:'acesso-v1',active:true,conversationId:'same',allowedIds:['same','second']};
 d.sync({...base,tenantId:'a'});assert.equal(d.save('Nota privada A'),true);
 d.sync({...base,tenantId:'b'});assert.equal(d.value,'');assert.equal(d.save('Nota privada B'),true);assert.equal(d.count,2);
 d.sync({...base,tenantId:'a'});assert.equal(d.value,'Nota privada A');assert.equal(d.key,'same');
 d.sync({...base,tenantId:'a',conversationId:'second'});assert.equal(d.value,'');assert.equal(d.save('Terceira nota'),false);
 d.sync({...base,tenantId:'b'});assert.equal(d.value,'Nota privada B');d.clear();assert.equal(d.count,1);
 d.sync({...base,tenantId:'a',conversationId:'second'});assert.equal(d.save('Contexto de transferência'),true);
 d.sync({...base,tenantId:'a',active:false});assert.equal(d.value,'');assert.equal(d.save('Campo inativo'),false);
 d.sync({...base,tenantId:'a'});assert.equal(d.value,'Nota privada A');assert.equal(d.count,2);
});
test('snapshot revogado poda apenas sua empresa e mudança de autoridade limpa notas das duas empresas',()=>{
 const base={userId:'operador',workspaceId:'revenda',authorityKey:'delegação-v1',active:true,conversationId:'same',allowedIds:['same']},d=createInternalNoteDrafts();
 d.sync({...base,tenantId:'a'});d.save('Nota A');d.sync({...base,tenantId:'b'});d.save('Nota B');
 d.sync({...base,tenantId:'a',allowedIds:[]});assert.equal(d.value,'');assert.equal(d.save('Texto antigo ainda no DOM'),false);assert.equal(d.count,1);
 d.sync({...base,tenantId:'b'});assert.equal(d.value,'Nota B');
 d.sync({...base,tenantId:'a'});assert.equal(d.value,'');d.save('Acesso restaurado sem nota antiga');
 d.sync({...base,tenantId:'b',authorityKey:'delegação-v2'});assert.equal(d.value,'');assert.equal(d.count,0);
 d.sync({...base,tenantId:'a',authorityKey:'delegação-v2'});assert.equal(d.value,'');
 for(const change of [{userId:'outro'},{workspaceId:'outra'}]){
  const notes=createInternalNoteDrafts();notes.sync({...base,tenantId:'a'});notes.save('A');notes.sync({...base,tenantId:'b'});notes.save('B');
  notes.sync({...base,tenantId:'a',...change});assert.equal(notes.value,'');assert.equal(notes.count,0);
 }
 d.sync({active:true,conversationId:'same',allowedIds:['same']});assert.equal(d.save('Sem identidade ou empresa'),false);
});
test('status history escapes stored text and omits duplicated assignment events',()=>{
 const markup=attendanceHistory({attendantEvents:[{type:'assignment',actorName:'Assignment duplicate'},{type:'closed',actorName:'<img src=x>',reason:'<script>alert(1)</script>',createdAt:'2026-10-02',to:{status:'closed'}}]},{escape:e,icon:()=>''});
 assert.ok(markup.includes('Atendimento encerrado'));assert.ok(markup.includes('&lt;img'));assert.ok(!markup.includes('<script>'));assert.ok(!markup.includes('Assignment duplicate'));
});
