import test from 'node:test';import assert from 'node:assert/strict';
import {clientRecordMarkup} from '../public/workspace-ui.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const options={canRead:true,canWrite:true,escape,icon:()=>'<svg></svg>',contacts:[{id:'authorized',name:'Pessoa autorizada',type:'person',phone:'11900000000',email:'qa@example.test',notes:'Cadastro privado',tags:['Cadastro']}]};
test('customer record fails closed without contact permission, including write-only capability',()=>{
 assert.equal(clientRecordMarkup({contactId:'authorized'},{...options,canRead:false}), '');
});
test('customer linkage uses only the authorized contact ID, never a matching name or external ID',()=>{
 for(const conversation of [{contact:'Pessoa autorizada',remoteJid:'11900000000@s.whatsapp.net'},{contactId:'unavailable',contact:'Pessoa autorizada'},null]){
  const markup=clientRecordMarkup(conversation,options);assert.doesNotMatch(markup,/11900000000|qa@example|Cadastro privado|data-action/);
 }
});
test('read-only record escapes fields and keeps CRM tags distinct from conversation tags',()=>{
 const markup=clientRecordMarkup({contactId:'authorized',tags:['Atendimento']},{...options,canWrite:false,contacts:[{...options.contacts[0],name:'<img src=x onerror=alert(1)>',notes:'<script>private</script>',tags:['<b>CRM</b>'],archivedAt:'2026-10-02'}]});
 assert.match(markup,/&lt;img/);assert.match(markup,/&lt;script/);assert.doesNotMatch(markup,/<script>|<img|edit-contact|Atendimento/);assert.match(markup,/contact-history/);assert.match(markup,/Etiquetas do cadastro/);assert.match(markup,/Arquivado/);
});
