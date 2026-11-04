import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatLayout} from '../public/chat-layout.js';

function node(){const classes=new Set(),attributes=new Map(),properties=new Map(),events=new Map();return {
 classList:{toggle(name,value){value?classes.add(name):classes.delete(name);},contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)},
 setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name),attributes,dataset:{},children:[],
 style:{setProperty:(name,value)=>properties.set(name,value),removeProperty:name=>properties.delete(name),getPropertyValue:name=>properties.get(name)||''},
 addEventListener(type,fn){const listeners=events.get(type)||[];listeners.push(fn);events.set(type,listeners);},
 dispatch(type,event={}){const e={button:0,pointerId:1,clientX:100,preventDefault(){this.defaultPrevented=true;},...event};for(const fn of events.get(type)||[])fn(e);return e;},
 append(child){this.children.push(child);},setPointerCapture(id){this.captured=id;},releasePointerCapture(){this.captured=null;},
 focus(){this.focused=true;},innerHTML:'',hidden:false};}
function fixture(storage){
 const shell=node();shell.dataset={view:'inbox'};
 const sidebar=node(),expand=node(),collapse=node(),conversations=node(),search=node();
 const message={text:'Original'},textarea={value:'Rascunho que não pode sumir',selectionStart:9},audio={currentTime:12,playbackRate:1.5,paused:false},video={currentTime:8,paused:false},timeline={scrollTop:175,children:[message,audio,video]};
 let dialog=null,pane={},activeExpand=expand;
 const doc={querySelector(selector){return {'.app-shell':shell,'.chat-pane':pane,'#sidebar':sidebar,'[data-layout-action="expand"]':activeExpand,'dialog[open]':dialog,'#messages':timeline,'#message-text':textarea,'#conversation-search':search}[selector]||null;},querySelectorAll(selector){return {'[data-layout-action="expand"]':activeExpand?[activeExpand]:[],'[data-layout-action="sidebar"]':[collapse],'[data-layout-action="conversations"]':[conversations]}[selector]||[];}};
 let openedList=0;
 const layout=createChatLayout({document:doc,storage,icon:key=>`<svg>${key}</svg>`,onConversations:()=>{openedList++;}});
 return {layout,doc,shell,sidebar,expand,collapse,conversations,search,textarea,audio,video,timeline,message,get openedList(){return openedList;},setDialog(value){dialog=value;},removePane(){pane=null;activeExpand=null;},emptyPane(){activeExpand=null;}};
}
test('layout changes preserve message/media identity, playback, scroll and unfinished text',()=>{
 const saved=new Map(),f=fixture({getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)});
 const nodes=f.timeline.children.slice();f.layout.toggleSidebar();f.layout.expand();
 assert.equal(f.layout.collapsed,true);assert.equal(f.layout.expanded,true);assert.equal(f.sidebar.attributes.has('inert'),true);
 assert.deepEqual(f.timeline.children,nodes);assert.equal(f.timeline.children[1],f.audio);assert.equal(f.timeline.children[2],f.video);
 assert.equal(f.audio.currentTime,12);assert.equal(f.audio.playbackRate,1.5);assert.equal(f.audio.paused,false);assert.equal(f.video.currentTime,8);
 assert.equal(f.timeline.scrollTop,175);assert.equal(f.textarea.value,'Rascunho que não pode sumir');assert.equal(f.textarea.selectionStart,9);
 f.layout.conversations();assert.equal(f.layout.expanded,false);assert.equal(f.layout.collapsed,true);assert.equal(f.openedList,1);assert.equal(saved.get('elozi-sidebar-collapsed'),'true');
});
test('Escape respects open dialogs, composition and consumed events before leaving chat',()=>{
 const f=fixture();f.layout.expand();let prevented=0;const event={key:'Escape',preventDefault(){prevented++;}};
 f.setDialog({});assert.equal(f.layout.escape(event),false);assert.equal(f.layout.expanded,true);
 f.setDialog(null);assert.equal(f.layout.escape({...event,isComposing:true}),false);assert.equal(f.layout.escape({...event,defaultPrevented:true}),false);
 assert.equal(f.layout.escape(event),true);assert.equal(prevented,1);assert.equal(f.layout.expanded,false);assert.equal(f.expand.focused,true);
 assert.equal(f.sidebar.attributes.has('inert'),false);assert.equal(f.expand.attributes.get('aria-expanded'),'false');
});
test('sidebar remains usable when browser storage is unavailable and resets only chat focus',()=>{
 const f=fixture({getItem(){throw Error('Blocked');},setItem(){throw Error('Blocked');}});
 f.layout.toggleSidebar();f.layout.expand();f.layout.reset();assert.equal(f.layout.collapsed,true);assert.equal(f.layout.expanded,false);
 assert.equal(f.collapse.attributes.get('aria-label'),'Expandir menu lateral');assert.equal(f.collapse.attributes.get('aria-expanded'),'false');
 f.layout.toggleSidebar();assert.equal(f.layout.collapsed,false);
});
test('view change or revoked conversation exits expanded state, keeping only a boolean preference',()=>{
 const f=fixture({getItem:()=> 'true'});f.layout.sync();assert.equal(f.layout.collapsed,true);
 f.layout.expand();f.shell.dataset.view='account';f.layout.sync();assert.equal(f.layout.expanded,false);assert.equal(f.layout.collapsed,true);
 f.shell.dataset.view='inbox';f.layout.expand();f.emptyPane();f.layout.sync();assert.equal(f.layout.expanded,false);
});

test('returning after a mobile resize focuses the conversation search when the chat is hidden',()=>{
 const f=fixture();f.layout.expand();f.expand.focused=false;f.expand.getClientRects=()=>[];
 f.layout.expand(false);assert.equal(f.expand.focused,false);assert.equal(f.search.focused,true);
});

function panelFixture(storage,{width=1000,viewport=1440,columnContext=false,contextState}={}) {
 const f=fixture(storage),observers=[];let workspace=node(),list=node(),context=node();
 let viewportWidth=viewport;workspace.clientWidth=width;
 const expanded=()=>f.shell.classList.contains('chat-expanded');
 // Three panels from 1280 px (FRONTEND-V2 §3.6); below it the context is a drawer (absolute).
 const docked=()=>viewportWidth>=1280;
 // CSS defaults of the panels: list 340 (280–480) and context 340 (300–440).
 const listWidth=()=>Number.parseFloat(workspace.style.getPropertyValue('--attendance-list-width'))||340;
 const contextWidth=()=>Number.parseFloat(workspace.style.getPropertyValue('--attendance-context-width'))||340;
 const mount=()=>{if(contextState!==undefined)workspace.dataset.context=contextState;
  workspace.querySelector=selector=>({'.pg-inbox__list':list,'.pg-inbox__context':context}[selector]||null);
  list.getBoundingClientRect=()=>({width:listWidth()});context.getBoundingClientRect=()=>({width:contextWidth()});};mount();
 const original=f.doc.querySelector.bind(f.doc);f.doc.querySelector=selector=>selector==='.inbox-workspace'?workspace:original(selector);
 f.doc.createElement=()=>node();
 class Observer { constructor(callback){this.callback=callback;this.active=true;this.targets=[];observers.push(this);}observe(target,options={}){this.targets.push({target,options});}disconnect(){this.active=false;} }
 f.doc.defaultView={matchMedia:()=>({matches:viewportWidth<900}),ResizeObserver:Observer,MutationObserver:Observer,
  getComputedStyle(element){const closed=workspace.classList.contains('context-collapsed')||workspace.dataset.context==='closed';
   if(element===list)return {display:expanded()||columnContext&&viewportWidth>=900&&viewportWidth<1280&&!closed?'none':'flex',position:'relative'};
   if(element===context)return {display:closed?'none':'block',position:(columnContext&&viewportWidth>=900||(expanded()?viewportWidth>=960:docked()))?'relative':'absolute'};
   return {display:'block',position:'relative'};}};
 f.layout=createChatLayout({document:f.doc,storage,icon:key=>`<svg>${key}</svg>`});f.layout.sync();
 return {...f,get workspace(){return workspace;},get list(){return list;},get context(){return context;},
  handle:name=>workspace.children.find(child=>child.dataset.panel===name),width:listWidth,contextWidth,
  refresh(){for(const observer of observers)if(observer.active)observer.callback();},
  setContext(value){contextState=value;workspace.dataset.context=value;
   for(const observer of observers)if(observer.active&&observer.targets.some(({target,options})=>target===workspace&&options.attributes&&options.attributeFilter?.includes('data-context')))observer.callback([{target:workspace,type:'attributes',attributeName:'data-context'}]);},
  resize(nextWidth,nextViewport=viewportWidth){workspace.clientWidth=nextWidth;viewportWidth=nextViewport;this.refresh();},
  remount(){workspace=node();workspace.clientWidth=width;list=node();context=node();mount();f.layout.sync();},
  get activeObservers(){return observers.filter(observer=>observer.active).length;}};
}

test('keyboard panel sizing stores bounded anonymous preferences and restores CSS defaults',()=>{
 const saved=new Map(),f=panelFixture({getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}),list=f.handle('list'),context=f.handle('context');
 assert.equal(list.attributes.get('role'),'separator');assert.equal(list.attributes.get('aria-controls'),'conversation-items');
 assert.equal(list.attributes.get('aria-valuenow'),'340');assert.equal(context.attributes.get('aria-controls'),'conversation-context');
 assert.equal(list.dispatch('keydown',{key:'ArrowRight'}).defaultPrevented,true);assert.equal(f.width(),350);
 list.dispatch('keydown',{key:'ArrowRight',shiftKey:true});assert.equal(f.width(),390);
 context.dispatch('keydown',{key:'ArrowLeft'});assert.equal(f.contextWidth(),350);
 list.dispatch('keydown',{key:'End'});assert.equal(f.width(),410);
 assert.deepEqual(JSON.parse(saved.get('elozi-chat-panel-widths')),{list:410,context:350});
 list.dispatch('keydown',{key:'Home'});assert.equal(f.width(),280);
 list.dispatch('keydown',{key:'Enter'});assert.equal(f.width(),340);
 context.dispatch('dblclick');assert.equal(f.contextWidth(),340);assert.deepEqual(JSON.parse(saved.get('elozi-chat-panel-widths')),{});
});

test('dragging preserves timeline, composer and player nodes; cancellation restores the preference',()=>{
 const saved=new Map(),f=panelFixture({getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}),handle=f.handle('list'),children=f.timeline.children.slice();
 handle.dispatch('pointerdown');assert.equal(handle.captured,1);assert.equal(f.workspace.classList.contains('panels-resizing'),true);
 handle.dispatch('pointermove',{clientX:900,pointerId:2});assert.equal(f.width(),340);
 handle.dispatch('pointermove',{clientX:160});assert.equal(f.width(),400);assert.equal(saved.has('elozi-chat-panel-widths'),false);
 handle.dispatch('pointerup',{clientX:160});assert.deepEqual(JSON.parse(saved.get('elozi-chat-panel-widths')),{list:400});
 handle.dispatch('pointerdown');handle.dispatch('pointermove',{clientX:80});assert.equal(f.width(),380);
 handle.dispatch('pointercancel');assert.equal(f.width(),400);assert.equal(f.workspace.classList.contains('panels-resizing'),false);
 assert.deepEqual(f.timeline.children,children);assert.equal(f.timeline.children[1],f.audio);assert.equal(f.audio.currentTime,12);assert.equal(f.audio.paused,false);
 assert.equal(f.timeline.scrollTop,175);assert.equal(f.textarea.value,'Rascunho que não pode sumir');assert.equal(f.textarea.selectionStart,9);
 handle.dispatch('pointerdown');handle.dispatch('pointermove',{clientX:70});assert.equal(handle.dispatch('keydown',{key:'Escape'}).defaultPrevented,true);assert.equal(f.width(),400);
});

test('responsive resizing clamps widths without discarding the desktop choice and ignores overlays/mobile',()=>{
 const saved=new Map([['elozi-chat-panel-widths','{"list":420,"context":400}']]),f=panelFixture({getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)});
 assert.equal(f.width(),360);assert.equal(f.contextWidth(),400);
 f.resize(700,1100);assert.equal(f.width(),420);assert.equal(f.handle('context').hidden,true);
 f.resize(560,1000);assert.equal(f.width(),320);assert.equal(f.handle('list').attributes.get('aria-valuemax'),'320');
 f.resize(390,390);assert.equal(f.handle('list').hidden,true);assert.equal(f.handle('context').hidden,true);
 f.handle('list').dispatch('keydown',{key:'End'});assert.equal(saved.get('elozi-chat-panel-widths'),'{"list":420,"context":400}');
 f.resize(1200,1500);assert.equal(f.width(),420);assert.equal(f.contextWidth(),400);
 f.workspace.classList.add('context-collapsed');f.refresh();assert.equal(f.handle('context').hidden,true);
 f.layout.expand();assert.equal(f.handle('list').hidden,true);
 f.workspace.classList.remove('context-collapsed');f.refresh();assert.equal(f.handle('context').hidden,false);
 f.resize(960,960);assert.equal(f.contextWidth(),400);assert.equal(f.workspace.style.getPropertyValue('--elozi-context-width'),'400px');
});

test('opening and closing docked context refreshes separators without a resize or class change',()=>{
 for(const viewport of [1100,1440]){
  const f=panelFixture(undefined,{viewport,columnContext:true,contextState:'closed'}),list=f.handle('list'),context=f.handle('context'),messages=f.timeline.children.slice();
  assert.equal(list.hidden,false);assert.equal(context.hidden,true);
  f.setContext('open');
  assert.equal(list.hidden,viewport<1280,'intermediate layout hides the list and its separator');
  assert.equal(context.hidden,false,'new context column exposes its separator');
  assert.equal(context.style.left,'660px','separator follows the docked context edge');
  f.setContext('closed');
  assert.equal(list.hidden,false,'list separator returns when the list returns');
  assert.equal(context.hidden,true,'closed context leaves no separator over the conversation');
  assert.equal(f.workspace.clientWidth,1000);assert.equal(f.workspace.classList.contains('context-collapsed'),false);
  assert.deepEqual(f.timeline.children,messages);assert.equal(f.timeline.scrollTop,175);assert.equal(f.textarea.value,'Rascunho que não pode sumir');
 }
});

test('new conversation DOM reuses widths and disconnects observers; stale detached controls do nothing',()=>{
 const f=panelFixture(),old=f.handle('list'),oldWorkspace=f.workspace;
 old.dispatch('keydown',{key:'ArrowRight'});assert.equal(f.width(),350);assert.equal(f.activeObservers,2);
 f.remount();assert.equal(f.width(),350);assert.equal(f.workspace.children.length,2);assert.equal(f.activeObservers,2);
 old.dispatch('keydown',{key:'End'});assert.equal(f.width(),350);assert.equal(oldWorkspace.style.getPropertyValue('--attendance-list-width'),'350px');
 f.layout.sync();assert.equal(f.workspace.children.length,2);
 f.shell.dataset.view='account';f.layout.sync();assert.equal(f.activeObservers,0);
});

test('invalid stored sizing and unavailable storage preserve usable controls',()=>{
 for(const content of ['not JSON','{"list":"420","context":null}','{"list":999999,"context":-1}','null']) {
  const f=panelFixture({getItem:k=>k==='elozi-chat-panel-widths'?content:null,setItem(){throw Error('Blocked');}});
  assert.equal(f.width(),340);assert.equal(f.contextWidth(),340);
  f.handle('list').dispatch('keydown',{key:'ArrowRight'});assert.equal(f.width(),350);
 }
 const f=panelFixture({getItem(){throw Error('Blocked');},setItem(){throw Error('Blocked');}});
 const handle=f.handle('context');handle.dispatch('pointerdown',{button:2});assert.equal(handle.captured,undefined);
 handle.dispatch('keydown',{key:'ArrowLeft',isComposing:true});assert.equal(f.contextWidth(),340);
 handle.dispatch('keydown',{key:'ArrowLeft',defaultPrevented:true});assert.equal(f.contextWidth(),340);
 handle.dispatch('pointerdown');handle.dispatch('pointermove',{clientX:60});assert.equal(f.contextWidth(),380);
 f.workspace.classList.add('context-collapsed');f.refresh();assert.equal(f.contextWidth(),340);assert.equal(handle.hidden,true);
});
