import test from 'node:test';
import assert from 'node:assert/strict';
import { clientRecordMarkup } from '../public/workspace-ui.js';
const options = { canRead:true, canWrite:true, escape:value => String(value ?? '').replace(/[<>&"]/g, char => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[char])), icon:() => '' };

test('CRM capacity notice explains continued attendance without displaying another contact or unsafe stored status', () => {
  const markup = clientRecordMarkup({id:'conversation-a',contactSyncStatus:'capacity'}, {...options, contacts:[{id:'other',name:'Wrong customer'}]});
  assert.match(markup, /agenda atingiu o limite/); assert.match(markup, /mensagens continuam neste atendimento/); assert.match(markup, /próxima entrada quando houver espaço/);
  assert.doesNotMatch(markup, /Wrong customer|Editar contato|data-id/);
  assert.equal(clientRecordMarkup({contactSyncStatus:'capacity'}, {...options,canRead:false}), '');
  assert.doesNotMatch(clientRecordMarkup({contactSyncStatus:'<script>bad</script>'}, options), /<script>|agenda atingiu/);
});

test('Actual scoped linked record supersedes stale capacity marker, preserving archive and edit permissions', () => {
  const contact = {id:'contact-a', name:'Customer & Co',type:'person',archivedAt:'2026-10-03',notes:'Saved notes',tags:[]};
  const markup = clientRecordMarkup({contactId:contact.id,contactSyncStatus:'capacity'}, {...options,canWrite:false,contacts:[contact]});
  assert.match(markup, /Customer &amp; Co/); assert.match(markup, /Arquivado/); assert.match(markup, /Saved notes/); assert.doesNotMatch(markup, /agenda atingiu|Editar contato/);
});
