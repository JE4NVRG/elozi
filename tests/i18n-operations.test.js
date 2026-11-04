import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import vm from 'node:vm';
import {setLocale, getLocale} from '../public/i18n.js';
import {operationsTranslations} from '../public/locales-operations.js';
import {supportCentralTranslations} from '../public/locales-support-central.js';
import {attendanceHistory, createInternalNoteDrafts} from '../public/attendance-ui.js';
import {createOverviewMarkup} from '../public/overview-ui.js';
import {flowDepartmentOptions, validateFlowEditorGraph} from '../public/flow-departments-ui.js';
import {createRepliesUI} from '../public/replies-ui.js';
import {createConversationTools} from '../public/conversation-tools.js';
import {channelCapabilities, assertChannelText, validateAttachmentSelection} from '../public/channel-capabilities.js';
import {widgetFile} from '../public/webchat-media.js';
import {formatFileSize} from '../public/media-ui.js';
import {createKnowledgeUI} from '../public/knowledge-ui.js';
import {supportCatalogMarkup} from '../public/support-assistant-ui.js';
import {createMcpUI} from '../public/mcp-ui.js';
import {createTelegramGroupsUi} from '../public/telegram-groups-ui.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=()=>'<svg></svg>';
const locale=value=>setLocale(value,{persist:false,notify:false});
// Mirror explicit production catalog registration, including recovery modules.
const catalogTranslations = {};
const catalogContext = vm.createContext({ registerTranslations(dictionary) {
  for (const [source, target] of Object.entries(dictionary)) if (!Object.hasOwn(catalogTranslations, source)) catalogTranslations[source] = target;
} });
for (const file of (await readdir(new URL('../public/', import.meta.url))).filter(file => /^locales(?:-[\w-]+)?\.js$/.test(file)).sort()) {
  const source = await readFile(new URL('../public/' + file, import.meta.url), 'utf8');
  new vm.Script(source.replace(/^import[^\n]*\n/gm, '').replace(/\bexport (?=const|function)/g, '')).runInContext(catalogContext);
}

test.afterEach(()=>locale('pt-BR'));

test('overview switches PT/EN/PT while customer names, identifiers and snapshots stay intact',()=>{
 const fixture={tenant:{id:'tenant-a',name:'Empresa selecionada'},session:{role:'reseller',userId:'human-a'},conversations:[{id:'c-a',tenantId:'tenant-a',channelId:'wa-a',contact:'Atendimento encerrado',status:'open',owner:'human',assignedUserId:'human-a',unread:1}],channels:[{id:'wa-a',name:'Canal conectado',tenantId:'tenant-a',kind:'whatsapp_qr',state:'connected'}],contacts:[],assignees:[{id:'human-a',name:'Responsável',presence:'available'}],access:{inboxRead:true,contactsRead:true,manageChannels:true,manageTeam:true},icon};
 const before=JSON.stringify(fixture);locale('pt-BR');const pt=createOverviewMarkup(fixture);locale('en');const en=createOverviewMarkup(fixture);locale('pt-BR');const back=createOverviewMarkup(fixture);
 assert.match(pt,/>Visão geral</);assert.match(en,/>Overview</);assert.match(en,/>Connected</);assert.match(en,/>Canal conectado</);assert.ok(en.includes('Atendimento encerrado'));
 assert.equal(back,pt);assert.equal(JSON.stringify(fixture),before);assert.ok(en.includes('data-view="channels"'));assert.ok(en.includes('data-overview-count="queue"'));
});

test('attendance copy and dates change without translating the actor or internal note',()=>{
 const stamp='2026-10-05T13:45:00.000Z',record={attendantEvents:[{type:'closed',createdAt:stamp,actorName:'Equipe',reason:'Atendimento encerrado'}]};
 locale('en');const en=attendanceHistory(record,{escape,icon});assert.match(en,/Conversation history/);assert.match(en,/<strong>Conversation closed<\/strong>/);assert.match(en,/<p>Atendimento encerrado<\/p>/);assert.match(en,/>Equipe · /);assert.ok(en.includes(escape(new Date(stamp).toLocaleString('en'))));
 locale('pt-BR');assert.match(attendanceHistory(record,{escape,icon}),/Histórico do atendimento/);
});

test('department choice localizes placeholders while department names and graph IDs are preserved',()=>{
 const departments=[{id:'d-a',name:'Escolha um departamento',active:false}];locale('en');const html=flowDepartmentOptions('',departments,{format:'id-v1',escape});
 assert.match(html,/Choose a department/);assert.match(html,/value="d-a"\s*>Escolha um departamento \(inactive\)/);
 const graph={departmentReferenceFormat:'id-v1',nodes:[{id:'step-a',type:'department',config:{department:'d-a'}}],edges:[]};assert.deepEqual(validateFlowEditorGraph(graph),graph);
});

test('reply quote and text drafts survive rendering in both languages; client text is never translated',()=>{
 const ui=createRepliesUI({escape,icon}),message={id:'m-a',kind:'customer',conversationId:'c-a',senderName:'Contato',text:'Conectado',delivery:'received'};
 ui.syncContext({workspaceId:'w-a',tenantId:'tenant-a',conversationId:'c-a',messages:[message]},['c-a']);ui.selectQuote('m-a');
 const drafts=createInternalNoteDrafts();drafts.sync({workspaceId:'w-a',tenantId:'tenant-a',userId:'human-a',authorityKey:'read-write',conversationId:'c-a',active:true,allowedIds:['c-a']});drafts.save('Mensagem interna');
 locale('pt-BR');const pt=ui.quoteComposer();locale('en');const en=ui.quoteComposer();
 assert.match(en,/Replying to message/);assert.match(en,/aria-label="View Contato's original message"/);assert.match(en,/<span>Conectado<\/span>/);assert.match(en,/Reference selected\. Review the reply before sending\./);assert.equal(ui.replyToMessageId,'m-a');assert.equal(ui.draftCount,1);assert.equal(drafts.value,'Mensagem interna');
 const editor=ui.editor({id:'reply-a',version:3,shortcut:'boas-vindas',title:'Boas-vindas',text:'Olá! Como podemos ajudar?'});
 assert.match(editor,/placeholder="Welcome"/);assert.match(editor,/value="Boas-vindas"/);assert.match(editor,/>Olá! Como podemos ajudar\?<\/textarea>/);assert.match(editor,/placeholder="Hello! How can we help\?"/);
 locale('pt-BR');assert.equal(ui.quoteComposer(),pt);
});

test('conversation search keeps query, context and results while filter labels resolve dynamically',()=>{
 const context={workspaceId:'w-a',tenantId:'tenant-a',channelId:'wa-a',conversationId:'c-a',authorityKey:'read'},conversation={id:'c-a',channelId:'wa-a',messages:[{id:'m-a',kind:'customer',text:'Mensagem interna',senderName:'Responsável',createdAt:'2026-10-05T12:00:00Z'}]};
 const ui=createConversationTools({conversation:()=>conversation,escape,icon});ui.syncContext(context,['c-a']);ui.open();ui.setQuery('Mensagem interna');const results=ui.results();
 locale('en');const en=ui.panel();assert.match(en,/>Search loaded history</);assert.match(en,/<span class="sr-only">Search text, filename, caption or author in loaded messages<\/span>/);assert.match(en,/>All</);assert.match(en,/>Photos</);assert.match(en,/value="Mensagem interna"/);assert.match(en,/Responsável/);assert.equal(ui.query,'Mensagem interna');assert.equal(ui.filter,'all');assert.match(ui.results(),/data-message-id="m-a"/);
 locale('pt-BR');assert.match(ui.panel(),/>Todas</);assert.equal(ui.results(),results);assert.equal(ui.opened,true);
});

test('capability errors use current locale with the same limits, permissions and user text',()=>{
 const caps=channelCapabilities({transport:'baileys'}),before=structuredClone(caps);locale('en');assert.throws(()=>assertChannelText('x'.repeat(4001),caps),/up to 4,000 characters/);assert.equal(assertChannelText('Conectado',caps),'Conectado');assert.deepEqual(caps,before);
 assert.equal(formatFileSize(1536),'1.5 KB');locale('pt-BR');assert.equal(formatFileSize(1536),'1,5 KB');assert.throws(()=>assertChannelText('x'.repeat(4001),caps),/até 4\.000 caracteres/);
});

test('explicit visitor validation locale stays independent of the operator preference and never changes payload text',()=>{
 const caps=channelCapabilities({transport:'baileys'}),blocked=channelCapabilities({transport:'elozi-webchat'});
 locale('en');assert.throws(()=>assertChannelText('x'.repeat(4001),caps,{locale:'pt-BR'}),/até 4\.000 caracteres/);assert.throws(()=>validateAttachmentSelection({size:1,type:'image/png'},blocked,{locale:'pt-BR'}),/Esta conexão ainda não permite/);assert.equal(getLocale(),'en');
 locale('pt-BR');assert.throws(()=>assertChannelText('x'.repeat(4001),caps,{locale:'en'}),/up to 4,000 characters/);assert.throws(()=>widgetFile({size:1,type:'image/png'},blocked,false,'Arquivo','en'),/does not support sending files/);assert.equal(getLocale(),'pt-BR');
 const file={size:1,type:'image/png',name:'Arquivo',slice(){throw Error('Validation cannot read bytes');}};assert.deepEqual(widgetFile(file,caps,false,'File','en'),{kind:'image',mime:'image/png',name:'Arquivo',voice:false});assert.equal(assertChannelText('Conectado',caps,{locale:'en'}),'Conectado');
});

test('knowledge controller labels are not frozen at construction and never translate source content',()=>{
 const state={workspaceId:'w-a',view:'knowledge',boot:{session:{role:'reseller',resellerId:'w-a',userId:'human-a'}},tenant:{id:'tenant-a',name:'Base de conhecimento'},knowledgeLoaded:true,knowledgeSources:[{id:'source-a',title:'Nova fonte',category:'Atendimento',version:1,contentChars:10,draftChanged:false,archived:false}]};let calls=0;
 locale('pt-BR');const ui=createKnowledgeUI({state,escape,icon,badge:(text)=>`<span>${escape(text)}</span>`,pageHeading:(_eyebrow,title,description,actions)=>`<h1>${escape(title)}</h1><p>${escape(description)}</p>${actions}`,api:()=>{calls++;throw Error('No request while rendering');},tenantApi:path=>`/api/tenants/tenant-a/${path}`});
 const pt=ui.panel();locale('en');const en=ui.panel();assert.match(en,/>All sources</);assert.match(en,/>Drafts</);assert.match(en,/>Knowledge base</);assert.match(en,/<h2>Nova fonte<\/h2>/);assert.match(en,/Atendimento/);assert.equal(calls,0);locale('pt-BR');assert.equal(ui.panel(),pt);
});

test('support job states and form copy change; agent names, products and mode values do not',()=>{
 const catalog={channels:[{id:'web-a',name:'Agente de suporte',configured:false,origins:[],assistant:{enabled:true,autoReply:false,agentId:'a-a',jobs:[{state:'pending',updatedAt:'2026-10-05T12:00:00Z'}]}}],agents:[{id:'a-a',name:'Escolher Hermes',knowledgeCount:1}],products:[{id:'p-a',name:'Produtos atendidos'}]};
 locale('pt-BR');const pt=supportCatalogMarkup(catalog);locale('en');const en=supportCatalogMarkup(catalog);assert.match(en,/Support agent/);assert.match(en,/In queue/);assert.match(en,/<h3>Agente de suporte<\/h3>/);assert.match(en,/value="a-a" selected>Escolher Hermes/);assert.match(en,/value="p-a"[^>]*>Produtos atendidos/);assert.match(en,/value="automatic"/);locale('pt-BR');assert.equal(supportCatalogMarkup(catalog),pt);
});

test('MCP internal activation retains the exact API payload independently of UI locale',async()=>{
 const calls=[],state={workspaceId:'w-a',boot:{session:{role:'reseller'}},tenant:{id:'tenant-a'},mcpServers:[]};const ui=createMcpUI({state,escape,icon,badge:()=>'',tenantApi:path=>`/api/tenants/tenant-a/${path}`,api:async(path,options)=>{calls.push({path,...options});return{};},refresh:async()=>{},render:()=>{},toast:()=>{}});
 locale('en');assert.equal(ui.summary().text,'Configure');await ui.act('mcp-activate-internal');assert.equal(calls[0].path,'/api/tenants/tenant-a/mcp/servers');assert.equal(calls[0].method,'POST');assert.deepEqual(JSON.parse(calls[0].body),{name:'Elozi interna',kind:'internal',enabled:true});
});

test('Telegram status maps survive locale changes; group names and permission field IDs stay original',async()=>{
 const channel={id:'tg-a',kind:'telegram'},state={view:'channels',workspaceId:'w-a',tenant:{id:'tenant-a',resellerId:'w-a',channels:[channel]},boot:{session:{role:'reseller',userId:'human-a',resellerId:'w-a'}}};
 const dto={tenantId:'tenant-a',channelId:'tg-a',version:0,mode:'all',groupIds:[],groupReadMode:'all',connectionState:'connected',groups:[{id:'-11',name:'Bot presente',type:'group',memberStatus:'member',joined:true,canSend:true,sendPermissions:{text:true,photos:false,audios:false,documents:false,videos:false,voiceNotes:false}}]};
 const calls=[];let markup='';const modal={open:true,addEventListener(){},querySelector(){return {dataset:{telegramGroupsToken:markup.match(/data-telegram-groups-token="([^"]+)"/)?.[1]},querySelector(){return null;},querySelectorAll(){return[];}};}};
 locale('pt-BR');const ui=createTelegramGroupsUi({state,api:async(path,init)=>{calls.push({path,init});return structuredClone(dto);},getModal:()=>modal,openModal:(_title,_subtitle,html)=>{markup=html;}});await ui.open(channel);assert.match(markup,/Bot presente/);locale('en');await ui.open(channel);assert.match(markup,/<strong>Bot presente<\/strong>/);assert.match(markup,/Bot present/);assert.match(markup,/Blocked: photos, audio, documents, videos, voice\./);assert.match(markup,/Allowed: text\./);assert.equal(calls.length,2);assert.ok(calls.every(call=>call.init.method==='GET'));assert.match(markup,/name="groupIds" value="-11"/);ui.reset();
});

test('every translated markup key is explicit in the catalog and uses only existing parameter slots',async()=>{
 const native={exports:{}};new Function('exports','module',process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(native.exports,native);
 const names=['attendance-ui','participants-ui','consolidated-inbox-ui','contact-import-ui','contact-links-ui','contact-refresh','team-chat-ui','media-ui','voice-recorder','replies-ui','chat-layout','conversation-tools','forwarding','automation-ui','telegram-groups-ui','groups-workspace-ui','group-history-import-ui','flow-departments-ui','channel-connectors-ui','channel-capabilities','mcp-ui','knowledge-ui','agent-memory-ui','agent-admin-proposals-ui','support-assistant-ui','overview-ui'];
 const neutral=new Set(['Status','Telegram','Webchat','Instagram','Facebook Messenger','Messenger','G','https://seusite.com','https://servico.exemplo/mcp','/ajuda']);let checked=0;
 const scan=(node,translations)=>{if(!node||typeof node!=='object')return;if(node.type==='TaggedTemplateExpression'&&node.tag.name==='i18nHtml'||node.type==='CallExpression'&&node.callee.name==='i18nMarkup'){
  const child=node.type==='TaggedTemplateExpression'?node.quasi:node.arguments[0];const source=child.type==='Literal'?child.value:child.quasis.reduce((s,q,i)=>s+(i?`{${i-1}}`:'')+q.value.cooked,'');
  const keys=source.split(/(<[^>]*>)/g).flatMap(part=>part.startsWith('<')?[...part.matchAll(/\b(?:aria-label|title|placeholder|alt|label|data-nav-label)=("|')([\s\S]*?)\1/g)].map(m=>m[2].trim()):[part.trim()]);
  for(const key of keys){if(!/\p{L}/u.test(key)||/^[{}0-9v·\s]+$/.test(key)||/^(?:SHA |v)\{\d+\}/.test(key)||neutral.has(key))continue;assert.ok(Object.hasOwn(translations,key),`Missing explicit markup translation: ${key}`);checked++;}
 }
 for(const value of Object.values(node))if(Array.isArray(value))value.forEach(child=>scan(child,translations));else if(value?.type)scan(value,translations);};
 for(const name of names){const translations=catalogTranslations;scan(native.exports.parse(await readFile(new URL(`../public/${name}.js`,import.meta.url),'utf8'),{sourceType:'module',ecmaVersion:'latest'}),translations);}
 assert.ok(checked>300,`Only ${checked} markup keys checked`);for(const translations of [operationsTranslations,supportCentralTranslations])for(const[source,target]of Object.entries(translations)){const slots=new Set([...source.matchAll(/\{(\d+)\}/g)].map(m=>m[1]));for(const match of target.matchAll(/\{(\d+)\}/g))assert.ok(slots.has(match[1]),`Unexpected slot in ${source}`);}
 assert.equal(getLocale(),'pt-BR');
});
