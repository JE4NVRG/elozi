import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import { contactPage, createWorkspaceUI } from '../public/workspace-ui.js';
import { excerpt } from './helpers/app-source.js';

const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decode=v=>v.replace(/&(quot|#39|lt|gt|amp);/g,(_,key)=>({quot:'"','#39':"'",lt:'<',gt:'>',amp:'&'}[key]));
const records=(n,prefix='contact')=>Array.from({length:n},(_,index)=>({id:`${prefix}-${String(index).padStart(5,'0')}`,name:`Contato ${index}`,phone:`119${String(index).padStart(8,'0')}`,email:`p${index}@example.test`,tags:[],identities:[],type:'person'}));
function fixture(t,list=records(7501)){
  const previous=globalThis.document;globalThis.document={addEventListener:()=>{},querySelector:()=>null};t.after(()=>{globalThis.document=previous;});
  const state={boot:{session:{role:'operator',userId:'user'}},workspaceId:'workspace-a',tenant:{id:'tenant-a',channels:[]},contacts:list,view:'contacts',conversation:'open-chat',drafts:{text:'Texto do chat',quote:'quoted-message'}};
  const avatars=[],calls={updates:0},ctx={state,escape,icon:()=>'',badge:text=>'<span>'+escape(text)+'</span>',button:()=>'',pageHeading:()=>'',hasPermission:()=>true,
    contactAvatar:c=>{avatars.push(c.id);return '<span data-avatar-for="'+escape(c.id)+'"></span>';},
    render:()=>assert.fail('pagination must not render the entire app'),api:()=>assert.fail('client pagination must not make a request'),
    updateContacts:()=>{calls.updates++;calls.markup=ui.views.contacts();}
  };
  const ui=createWorkspaceUI(ctx);return {state,ui,avatars,calls};
}
function pageChoice(ui,direction='next',target){
  const html=ui.views.contacts(),match=html.match(new RegExp(`data-contact-direction="${direction}" data-id="([^"]+)"`));assert.ok(match);
  const choice=JSON.parse(decode(match[1]));if(target!==undefined)choice[2]=target;return JSON.stringify(choice);
}
const rows=html=>(html.match(/<tr data-contact-row>/g)||[]).length;

test('7501 authorized contacts render only 50 rows and avatars, with no off-page contact IDs',t=>{
  const f=fixture(t),html=f.ui.views.contacts();assert.equal(rows(html),50);assert.equal(f.avatars.length,50);assert.ok(html.includes('1–50 de 7.501 contatos'));assert.ok(html.includes('Página 1 de 151'));
  assert.ok(html.includes('contact-00049'));assert.ok(!html.includes('contact-00050'));assert.ok(!html.includes('contact-07500'));assert.equal((html.match(/<button type="button" class="ui-btn [^"]*" data-action="contacts-page"(?: disabled)? data-contact-direction="(?:previous|next)"/g)||[]).length,2,'dois botões do design system (alvo de 44 px abaixo de 900 px)');assert.match(html,/aria-label="Paginação de contatos"/);assert.match(html,/role="status" aria-live="polite"/);
});

test('the real controller reaches the last page and changes neither selected chat origin nor drafts',async t=>{
  const f=fixture(t),tenant=f.state.tenant,drafts=f.state.drafts,id=pageChoice(f.ui,'next',150);f.avatars.length=0;
  assert.equal(await f.ui.action('contacts-page',id),true);assert.equal(f.state.contactPage,150);assert.equal(rows(f.calls.markup),1);assert.deepEqual(f.avatars,['contact-07500']);assert.ok(f.calls.markup.includes('7.501–7.501 de 7.501 contatos'));
  assert.strictEqual(f.state.tenant,tenant);assert.equal(f.state.conversation,'open-chat');assert.strictEqual(f.state.drafts,drafts);assert.equal(f.calls.updates,1);
  const previous=pageChoice(f.ui,'previous');await f.ui.action('contacts-page',previous);assert.equal(f.state.contactPage,149);assert.equal(rows(f.calls.markup),50);
});

test('search covers all contacts including the final record and resets a later page',async t=>{
  const f=fixture(t);await f.ui.action('contacts-page',pageChoice(f.ui,'next',150));
  f.state.contactSearch='Contato 7500';f.avatars.length=0;const html=f.ui.views.contacts();assert.equal(f.state.contactPage,0);assert.equal(rows(html),1);assert.deepEqual(f.avatars,['contact-07500']);assert.ok(html.includes('1–1 de 1 contatos'));assert.ok(!html.includes('contact-00000'));
  f.state.contacts.at(-1).tags=['ÚLTIMA etiqueta'];f.state.contactSearch='ultima etiqueta';assert.equal(rows(f.ui.views.contacts()),1);
});

test('archive filter resets pagination and zero results have accurate counts and disabled controls',async t=>{
  const list=records(102);list.at(-1).archivedAt='2026-10-02';const f=fixture(t,list);
  await f.ui.action('contacts-page',pageChoice(f.ui,'next',2));assert.equal(f.state.contactPage,2);
  f.state.showArchived=true;let html=f.ui.views.contacts();assert.equal(f.state.contactPage,0);assert.ok(html.includes('1–50 de 102 contatos'));
  f.state.contactSearch='Nada neste conjunto';html=f.ui.views.contacts();assert.equal(f.state.contactPage,0);assert.equal(rows(html),0);assert.ok(html.includes('0–0 de 0 contatos'));assert.ok(html.includes('Página 1 de 1'));assert.equal((html.match(/data-action="contacts-page" disabled data-contact-direction=/g)||[]).length,2);
});

test('pages clamp safely after list shrinkage and invalid numeric input',async t=>{
  for(const page of [-1,Infinity,NaN,'150',1.5])assert.equal(contactPage(records(51),{page}).page,0);
  assert.equal(contactPage(records(51),{page:900}).page,1);assert.equal(contactPage([],{page:20}).start,0);
  const f=fixture(t);await f.ui.action('contacts-page',pageChoice(f.ui,'next',150));f.state.contacts=records(51);const html=f.ui.views.contacts();assert.equal(f.state.contactPage,1);assert.equal(rows(html),1);assert.ok(html.includes('51–51 de 51 contatos'));
});

test('tenant, workspace and user changes reset pages and reject stale page buttons without exposing former IDs',async t=>{
  const f=fixture(t);await f.ui.action('contacts-page',pageChoice(f.ui,'next',100));const stale=pageChoice(f.ui,'next');
  f.state.tenant={id:'tenant-b',channels:[]};f.state.contacts=records(51,'other');let html=f.ui.views.contacts();assert.equal(f.state.contactPage,0);assert.equal(rows(html),50);assert.ok(!html.includes('contact-000'));assert.ok(html.includes('other-00000'));
  const updates=f.calls.updates;await f.ui.action('contacts-page',stale);assert.equal(f.calls.updates,updates);assert.equal(f.state.contactPage,0);
  await f.ui.action('contacts-page',pageChoice(f.ui));assert.equal(f.state.contactPage,1);f.state.workspaceId='workspace-b';f.ui.views.contacts();assert.equal(f.state.contactPage,0);
  await f.ui.action('contacts-page',pageChoice(f.ui));f.state.boot.session.userId='another-user';f.ui.views.contacts();assert.equal(f.state.contactPage,0);
});

test('obsolete filter buttons and malformed action IDs cannot alter a current page',async t=>{
  const f=fixture(t),stale=pageChoice(f.ui,'next',100);f.state.contactSearch='Contato 7500';f.ui.views.contacts();await f.ui.action('contacts-page',stale);assert.equal(f.state.contactPage,0);assert.equal(f.calls.updates,0);
  for(const id of ['bad','{}','[]',JSON.stringify(['x','x',Infinity])])await f.ui.action('contacts-page',id);
  f.state.view='inbox';await f.ui.action('contacts-page',pageChoice(f.ui));assert.equal(f.calls.updates,0);assert.equal(f.state.conversation,'open-chat');
});

test('visible contact fields and action IDs are escaped and excluded pages never enter markup',t=>{
  const list=records(51);Object.assign(list[0],{id:'"><img src=x onerror=x>',name:'<script>bad</script>',email:'<iframe>',tags:['<svg>'],identities:[{channelId:'unknown',label:'<b>unsafe</b>'}]});list[50].id='off-page-private-id';const f=fixture(t,list),html=f.ui.views.contacts();
  assert.equal(rows(html),50);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('<iframe>'));assert.ok(!html.includes('off-page-private-id'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&quot;&gt;&lt;img'));assert.ok(!html.includes('onclick='));
});

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const updateSource=excerpt('contacts-page');
function updateHarness(f){
  const parts={tbody:{innerHTML:'old rows'},'[data-contact-pagination]':{innerHTML:'old count'}},calls={binds:0},input={id:'contact-search',value:'',selectionStart:3,selectionEnd:7,dataset:{}};
  const panel={querySelector:selector=>parts[selector]||null};
  const sandbox={...i18n,state:f.state,workspaceUI:f.ui,$:selector=>selector==='.crm-panel'?panel:null,avatarUI:{bind:()=>calls.binds++},
    document:{activeElement:input,createElement:()=>{let html='';return {set innerHTML(value){html=value;},content:{querySelector:selector=>({innerHTML:selector==='tbody'?html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1]:html.match(/<nav[^>]*data-contact-pagination[^>]*>([\s\S]*?)<\/nav>/)[1]})}};}}
  };
  const update=runInNewContext(updateSource+'\nupdateContactsPage',sandbox);return {parts,calls,input,update,sandbox};
}

test('the served search and archive hooks update rows and footer together without replacing the input or rendering chat',async t=>{
  const f=fixture(t),h=updateHarness(f),source=f.state.tenant,draft=f.state.drafts;await f.ui.action('contacts-page',pageChoice(f.ui,'next',150));
  const search=app.match(/if\(event.target.id==='contact-search'\)\{[^}]+\}/)?.[0];assert.ok(search);h.input.value='Contato 7500';runInNewContext(search,{ ...i18n,event:{target:h.input},state:f.state,updateContactsPage:h.update});
  assert.equal(f.state.contactPage,0);assert.equal(rows(h.parts.tbody.innerHTML),1);assert.ok(h.parts['[data-contact-pagination]'].innerHTML.includes('1–1 de 1 contatos'));assert.equal(h.input.selectionStart,3);assert.equal(h.input.selectionEnd,7);assert.equal(h.calls.binds,1);
  const archive=app.match(/if\(event.target.id==='contacts-archived'\)\{[^}]+\}/)?.[0];assert.ok(archive);f.state.contactSearch='';runInNewContext(archive,{ ...i18n,event:{target:{id:'contacts-archived',checked:true}},state:f.state,updateContactsPage:h.update});
  assert.equal(rows(h.parts.tbody.innerHTML),50);assert.ok(h.parts['[data-contact-pagination]'].innerHTML.includes('1–50 de 7.501 contatos'));assert.equal(h.calls.binds,2);assert.strictEqual(f.state.tenant,source);assert.strictEqual(f.state.drafts,draft);assert.equal(f.state.conversation,'open-chat');
});

test('partial updates are ignored when the contacts view is no longer active',t=>{
  const f=fixture(t),h=updateHarness(f);f.state.view='inbox';h.update();assert.equal(h.calls.binds,0);assert.equal(h.parts.tbody.innerHTML,'old rows');assert.equal(h.parts['[data-contact-pagination]'].innerHTML,'old count');
});
