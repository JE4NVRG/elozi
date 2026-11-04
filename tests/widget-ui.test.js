import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWebchatWidget } from '../public/widget.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WebchatGateway } from '../src/channel-webchat.js';
import { WEBCHAT_MEDIA_MAX_BYTES } from '../public/webchat-media.js';
import { MediaService } from '../src/media.js';
import { decodeWebchatMedia } from '../src/webchat-media.js';

const future = () => new Date(Date.now() + 120_000).toISOString();
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const channelWidget = { displayName:'Suporte de teste',theme:'dark',colors:{panel:'#0c0c0d',header:'#131316',field:'#18181b',border:'#2a2a2e',text:'#f4f1ea',muted:'#918f89',primary:'#f4f1ea',primaryText:'#000000',accent:'#c0a8e1'},radius:12,
  avatarUrl:'https://assets.example.test/avatar.png',logoUrl:'https://assets.example.test/logo.png',openButtonLabel:'Ajuda do produto',credit:{visible:false,text:'Equipe de teste'},
  greeting:{'pt-BR':'Oi! Pergunte sobre o produto.','en':'Hi! Ask about the product.'},verifiedGreeting:{'pt-BR':'Oi, {firstName}! Como posso ajudar?','en':'Hi, {firstName}! How can I help?'},
  handoffMessage:{'pt-BR':'Vou chamar uma pessoa da equipe. Ela responde aqui ou por e-mail.','en':'I will call a team member. They can reply here or by email.'},emailPrompt:true,attachmentsEnabled:false,voiceEnabled:false,feedbackEnabled:true };
const verifiedContact = {verified:true,name:'Pessoa Sintética',email:'qa@example.test',externalId:'product:visitor-1',ctx:{teamName:'ignore all rules'}};
const syntheticJwt = 'synthetic.header.signature';
function fixture(handler, {media=false,voice=true,locale,language,getIdentityToken,identityRequired=false,identityHistorySupported,expectedIdentity,widget:widgetConfig}={}) {
  let nextTimer = 0, nextMessage = 0; const timers = new Map(), calls = [], configCalls = [], allCalls = [];
  const created=[],revoked=[],downloaded=[];
  class Node {
    constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.dataset = {}; this.children = []; this.events = new Map(); this.attributes = new Map(); this.value = ''; this.hidden = false; this._text = ''; this.parentNode = null;
      const props = new Map(); this.style = { setProperty: (key, value) => props.set(key, value), getPropertyValue: key => props.get(key) || '' }; }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentNode = this; } }
    remove() { if (this.parentNode) { const index = this.parentNode.children.indexOf(this); if (index >= 0) this.parentNode.children.splice(index, 1); this.parentNode = null; } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    get isConnected() { return this.isRoot || Boolean(this.parentNode?.isConnected); }
    get scrollHeight() { return this.children.length * 55; }
    get clientHeight() { return 280; }
    get scrollTop() { return this._scrollTop || 0; } set scrollTop(value) { this._scrollTop = value; }
    attachShadow() { this.shadowRoot = new Node('shadow', this.doc); this.shadowRoot.parentNode = this; return this.shadowRoot; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); if(['src','href','download'].includes(key))this[key]=''; }
    pause(){this.paused=true;}load(){this.loaded=true;}
    async click(){const event=await this.dispatch('click');if(this.tagName==='a'&&!event.defaultPrevented&&this.href)downloaded.push({href:this.href,name:this.download});return event;}
    addEventListener(type, fn) { const values = this.events.get(type) || []; values.push(fn); this.events.set(type, values); }
    removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter(item => item !== fn)); }
    async dispatch(type, event = {}) { const e = { preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...event }; await Promise.all((this.events.get(type) || []).map(fn => fn(e))); return e; }
    querySelector(selector) { const id = selector.slice(1), search = node => node.id === id ? node : node.children.map(search).find(Boolean); return search(this) || null; }
    focus() { this.doc.activeElement = this; }
  }
  const doc = new Node('document'); doc.visibilityState = 'visible'; doc.documentElement = { lang: language }; doc.body = new Node('body', doc); doc.body.isRoot = true; doc.createElement = tag => new Node(tag, doc);
  const viewEvents=new Map();
  const view = { AbortController,Blob,File,URL:{createObjectURL(blob){const url=`blob:widget-local-${created.length+1}`;created.push({url,blob});return url;},revokeObjectURL(url){revoked.push(url);}},crypto: { randomUUID: () => 'widget-client-message-' + String(++nextMessage).padStart(4, '0') },
    addEventListener(type,fn){const events=viewEvents.get(type)||new Set();events.add(fn);viewEvents.set(type,events);},removeEventListener(type,fn){viewEvents.get(type)?.delete(fn);},
    async dispatch(type){for(const fn of viewEvents.get(type)||[])fn();await tick();},
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } }; doc.defaultView = view;
  const fetchImpl = async (url, options) => {
    const binary=options.body instanceof Blob,kind=url.includes('/media/')?'media-download':url.split('/').at(-1);let body,fileBytes;
    if(binary){const buffer=await options.body.arrayBuffer(),length=new DataView(buffer).getUint32(0,false);body=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,length)));fileBytes=Buffer.from(buffer,4+length);}else body=JSON.parse(options.body);
    const call={url,kind,options,body,fileBytes};allCalls.push(call);(kind==='config'?configCalls:calls).push(call);
    if (handler) { const result = await handler(call); if (result) return result; }
    const capabilities={mediaSupported:media,mediaKinds:media?['image','audio','video','document']:[],mediaMaxBytes:16*1024*1024,captionMaxLength:1024,voiceSupported:media&&voice,...(identityHistorySupported===undefined?{}:{identityHistorySupported})};
    const results = { config: { ...(widgetConfig?{widget:widgetConfig}:{}),...capabilities }, challenge: { challenge: 'a'.repeat(43), expiresAt: future(), brand: { name: 'Marca sintética', accent: '#27644b' },...capabilities },
      session: { token: 'b'.repeat(43), expiresAt: future(),...capabilities }, messages: { messageId: 'received-message-0001', replayed: false },media:{messageId:'received-media-0001',version:2,replayed:false},history: { messages: [], nextCursor: null, hasMore: false,...capabilities,...(identityRequired?{contact:{...verifiedContact,v:2,...expectedIdentity}}:{})} };
    return { ok: true, status: 200, json: async () => results[kind] };
  };
  const mount = options => createWebchatWidget({ document: doc, window: view, fetchImpl, apiOrigin: 'https://elozi.example', tenantId: 'tenant-test', channelId: 'channel-test', locale, getIdentityToken, identityRequired, expectedIdentity, ...options });
  const widget = mount();
  const get = id => widget.host.shadowRoot.querySelector('#widget-' + id);
  const start = async () => { await tick();widget.open();get('name').value = 'Visitante sintético';await tick();if(!get('intro').hidden)await get('intro').dispatch('submit'); await tick(); };
  return { widget, doc, view, calls, configCalls, allCalls, timers, get, start,created,revoked,downloaded,mount,fetchImpl,
    async select(file){get('file').files=[file];await get('file').dispatch('change');},
    async poll() { const entry = [...timers].find(([, value]) => value.delay >=1000&&value.delay<=3000); assert.ok(entry, 'poll timer exists'); timers.delete(entry[0]); entry[1].fn(); await tick(); } };
}

const saasContact={...verifiedContact,v:2,accountId:'account-a',userId:'user-a'};
const saasOptions={identityRequired:true,identityHistorySupported:true,expectedIdentity:{accountId:'account-a',userId:'user-a'}};
const saasSession=()=>({ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:saasContact})});
const saasHistory=(extra={})=>({ok:true,json:async()=>({contact:saasContact,messages:[],nextCursor:null,hasMore:false,...extra})});

test('combined history checks live SaaS authority on every page/poll and never posts a separate renewal',async t=>{
  let callbacks=0,page=0;
  const c=fixture(call=>call.kind==='session'?saasSession():call.kind==='history'?saasHistory(++page===1?{messages:[{id:'history-message-0001',kind:'customer',text:'Earlier question'}],nextCursor:'history-message-0001',hasMore:true}:{}):null,
    {...saasOptions,getIdentityToken:async()=>`${syntheticJwt}_${++callbacks}`});t.after(()=>c.widget.destroy());
  await c.start();await tick();await tick();
  assert.equal(page,2);assert.equal(callbacks,3,'Session + one fresh SaaS check per page.');
  assert.equal(c.calls.filter(call=>call.kind==='identity').length,0);
  assert.equal(c.calls.filter(call=>call.kind==='history').every(call=>call.body.identityToken?.startsWith(syntheticJwt+'_')),true);
  const consumed=c.calls.filter(call=>call.body.identityToken).map(call=>call.body.identityToken);assert.equal(new Set(consumed).size,consumed.length,'Each request consumes a distinct issued JWT.');
  assert.equal(c.calls.filter(call=>call.kind==='history')[1].body.after,'history-message-0001');
  await c.poll();await tick();assert.equal(callbacks,4);assert.equal(page,3);assert.equal(c.get('history').children.length,1);
});

test('combined history on focus/reopen checks SaaS once and shares renewal with a concurrent explicit send',async t=>{
  let callbacks=0,waiting=false;const wait=deferred();
  const c=fixture(call=>call.kind==='session'||call.kind==='identity'?saasSession():call.kind==='history'?saasHistory():null,
    {...saasOptions,getIdentityToken:async()=>{callbacks++;return waiting?wait.promise:`${syntheticJwt}_${callbacks}`;}});t.after(()=>c.widget.destroy());
  await c.start();await tick();const beforeFocus=callbacks;await c.view.dispatch('focus');await tick();assert.equal(callbacks,beforeFocus+1);assert.equal(c.calls.some(call=>call.kind==='identity'),false);
  c.widget.close();c.widget.open();await tick();await tick();assert.equal(callbacks,beforeFocus+2);
  waiting=true;const beforeSend=callbacks;await c.poll();c.get('text').value='One explicit send';const sending=c.get('composer').dispatch('submit');await tick();
  assert.equal(callbacks,beforeSend+1);assert.equal(c.calls.filter(call=>call.kind==='messages').length,0);
  waiting=false;wait.resolve(`${syntheticJwt}_${callbacks}`);await sending;await tick();assert.equal(c.calls.filter(call=>call.kind==='messages').length,1);assert.equal(c.calls.some(call=>call.kind==='identity'),false);
  const consumed=c.calls.filter(call=>call.body.identityToken).map(call=>call.body.identityToken);assert.equal(new Set(consumed).size,consumed.length);
});

test('send-first renewal shares its single-use JWT with polling and validates the subsequent history external identity',async t=>{
  for(const mode of ['valid','wrong-external','logout']){
    let changed=false,callbacks=0;const wait=deferred();
    const c=fixture(call=>call.kind==='session'?saasSession():call.kind==='identity'?wait.promise:call.kind==='history'?saasHistory(changed&&mode==='wrong-external'?{contact:{...saasContact,externalId:'foreign:visitor'},messages:[{id:'foreign-history-0001',kind:'agent',text:'Foreign private history'}]}:{}):null,
      {...saasOptions,getIdentityToken:async()=>{callbacks++;return changed&&mode==='logout'?null:`${syntheticJwt}_${callbacks}`;}});t.after(()=>c.widget.destroy());
    await c.start();await tick();changed=true;c.get('text').value='Explicit send first';const before=callbacks;
    const sending=c.get('composer').dispatch('submit');await tick();if(mode==='logout')await c.view.dispatch('focus');else await c.poll();await tick();
    if(mode!=='logout')assert.equal(callbacks,before+1);
    wait.resolve(saasSession());await sending;await tick();await tick();
    assert.equal(c.get('history').textContent.includes('Foreign private history'),false);
    if(mode!=='valid')assert.equal(c.get('composer').hidden,true);
    if(mode==='logout')assert.equal(c.calls.filter(call=>call.kind==='messages').length,0);
    const consumed=c.calls.filter(call=>call.body.identityToken).map(call=>call.body.identityToken);assert.equal(new Set(consumed).size,consumed.length);
  }
});

test('a revoked pending authority check cancels both combined polling and a concurrent explicit send',async t=>{
  const wait=deferred();let waiting=false,callbacks=0;
  const c=fixture(call=>call.kind==='session'?saasSession():call.kind==='history'?saasHistory():null,
    {...saasOptions,getIdentityToken:async()=>{callbacks++;return waiting?wait.promise:`${syntheticJwt}_${callbacks}`;}});t.after(()=>c.widget.destroy());
  await c.start();await tick();waiting=true;const before=callbacks,histories=c.calls.filter(call=>call.kind==='history').length;await c.poll();c.get('text').value='Do not send after revoked membership';const sending=c.get('composer').dispatch('submit');await tick();
  assert.equal(callbacks,before+1);wait.resolve(null);await sending;await tick();
  assert.equal(c.calls.filter(call=>call.kind==='history').length,histories);assert.equal(c.calls.filter(call=>call.kind==='messages').length,0);assert.equal(c.get('composer').hidden,true);assert.equal(c.get('history').children.length,0);assert.equal(c.timers.size,0);
});

test('reopening while an old poll is delayed immediately checks authority and an old completion never releases the new poll owner',async t=>{
  for(const phase of ['issuer','history']){
    const old=deferred(),newHistory=deferred();let waiting=false,oldHeld=false,newHeld=false,callbacks=0;
    const c=fixture(call=>call.kind==='session'?saasSession():call.kind==='history'?waiting?phase==='history'&&!oldHeld?(oldHeld=true,old.promise):!newHeld?(newHeld=true,newHistory.promise):saasHistory():saasHistory():null,
      {...saasOptions,getIdentityToken:async()=>{const token=`${syntheticJwt}_${++callbacks}`;if(waiting&&phase==='issuer'&&!oldHeld){oldHeld=true;return old.promise;}return token;}});t.after(()=>c.widget.destroy());
    await c.start();await tick();waiting=true;await c.poll();await tick();const beforeReopen=callbacks;
    c.widget.close();c.widget.open();await tick();await tick();assert.equal(callbacks,beforeReopen+1,'Reopen starts a fresh authority check immediately.');
    old.resolve(phase==='issuer'?`${syntheticJwt}_old_late`:saasHistory());await tick();await tick();const beforeFocus=callbacks;await c.view.dispatch('focus');await tick();assert.equal(callbacks,beforeFocus,'Old owner cannot release the new active history poll.');
    newHistory.resolve(saasHistory());await tick();await tick();assert.equal(c.get('composer').hidden,false);assert.equal([...c.timers.values()].filter(value=>value.delay<=3000).length,1);
  }
});

test('combined history refuses revoked membership and wrong identity before rendering private history',async t=>{
  for(const mode of ['revoked-membership','wrong-account','wrong-user','wrong-external','server-revoked']){
    let changed=false;
    const c=fixture(call=>call.kind==='session'?saasSession():call.kind==='history'?changed&&mode==='server-revoked'?{ok:false,status:403,json:async()=>({code:'identity_invalid'})}:saasHistory(changed?{contact:{...saasContact,...(mode==='wrong-account'?{accountId:'account-b'}:mode==='wrong-user'?{userId:'user-b'}:mode==='wrong-external'?{externalId:'other:identity'}:{})},messages:[{id:'private-message-0001',kind:'agent',text:'Must never render'}]}:{}):null,
      {...saasOptions,getIdentityToken:async()=>changed&&mode==='revoked-membership'?null:syntheticJwt});t.after(()=>c.widget.destroy());
    await c.start();await tick();const before=c.calls.filter(call=>call.kind==='history').length;changed=true;await c.poll();await tick();
    assert.equal(c.get('history').children.length,0,mode);assert.equal(c.get('composer').hidden,true,mode);assert.equal(c.calls.filter(call=>call.kind==='messages').length,0);
    if(mode==='revoked-membership')assert.equal(c.calls.filter(call=>call.kind==='history').length,before);
  }
});

test('combined history ignores late SaaS and history responses after logout, close or destroy',async t=>{
  for(const phase of ['issuer','history'])for(const action of ['close','destroy']){
    let waiting=false;const wait=deferred();
    const c=fixture(call=>call.kind==='session'?saasSession():call.kind==='history'?waiting&&phase==='history'?wait.promise:saasHistory():null,
      {...saasOptions,getIdentityToken:async()=>waiting&&phase==='issuer'?wait.promise:syntheticJwt});t.after(()=>c.widget.destroy());
    await c.start();await tick();waiting=true;await c.poll();c.widget[action]();wait.resolve(phase==='issuer'?syntheticJwt:saasHistory({messages:[{id:'late-private-message-01',kind:'agent',text:'Late private reply'}]}));await tick();await tick();
    assert.equal(c.get('history').textContent.includes('Late private reply'),false);assert.equal(c.timers.size,0);assert.equal(c.get('panel').hidden,true);
  }
});

test('combined history keeps the valid session/draft on transient history failure and resumes without a new session',async t=>{
  let broken=false;
  const c=fixture(call=>call.kind==='session'?saasSession():call.kind==='history'?broken?{ok:false,status:503,json:async()=>({})}:saasHistory():null,
    {...saasOptions,getIdentityToken:async()=>syntheticJwt});t.after(()=>c.widget.destroy());await c.start();await tick();
  c.get('text').value='Keep my draft';broken=true;await c.poll();await tick();assert.equal(c.get('composer').hidden,false);assert.equal(c.get('text').value,'Keep my draft');assert.match(c.get('status').textContent,/Conexão interrompida/);
  broken=false;await c.poll();await tick();assert.equal(c.calls.filter(call=>call.kind==='session').length,1);assert.equal(c.calls.some(call=>call.kind==='identity'),false);
});

test('polling checks pending assistant each second and returns to normal cadence after a delivered reply',async t=>{
  let phase='pending';
  const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[],nextCursor:null,hasMore:false,assistant:{state:phase,typing:phase!=='done'}})}:null);t.after(()=>c.widget.destroy());
  await c.start();assert.equal([...c.timers.values()].some(value=>value.delay===1000),true);assert.equal([...c.timers.values()].some(value=>value.delay===3000),false);
  phase='running';await c.poll();await tick();assert.equal([...c.timers.values()].some(value=>value.delay===1000),true);
  phase='done';await c.poll();await tick();assert.equal([...c.timers.values()].some(value=>value.delay===3000),true);assert.equal([...c.timers.values()].some(value=>value.delay===1000),false);
  c.widget.close();assert.equal(c.timers.size,0);
});

test('authenticated SaaS never silently opens an anonymous session when identity is unavailable',async t=>{
  for(const callback of [async()=>null,async()=>{throw Error('logged out');},async()=>'invalid']){
    const c=fixture(null,{identityRequired:true,expectedIdentity:{accountId:'account-a',userId:'user-a'},getIdentityToken:callback});t.after(()=>c.widget.destroy());
    await c.start();assert.equal(c.calls.length,0);assert.equal(c.get('start').textContent,'Confirmar minha conta');assert.equal(c.get('name').required,false);assert.match(c.get('status').textContent,/confirmar sua conta/);
  }
});
test('SaaS rejects a signed session returned for another account before showing history',async t=>{
  const c=fixture(call=>call.kind==='session'?{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:{...verifiedContact,v:2,accountId:'account-b',userId:'user-a'}})}:null,
    {identityRequired:true,expectedIdentity:{accountId:'account-a',userId:'user-a'},getIdentityToken:async()=>syntheticJwt});t.after(()=>c.widget.destroy());
  await c.start();assert.equal(c.calls.some(call=>call.kind==='history'),false);assert.equal(c.get('composer').hidden,true);assert.equal(c.get('name').required,false);
});
test('SaaS revalidates login before sending and refuses a changed account or logout without replaying the message',async t=>{
  for(const mode of ['logout','changed-account','valid']){
    const contact={...verifiedContact,v:2,accountId:'account-a',userId:'user-a'};let callbacks=0,change=false;
    const c=fixture(call=>['session','identity'].includes(call.kind)?{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:call.kind==='identity'&&change&&mode==='changed-account'?{...contact,accountId:'account-b'}:contact})}:null,
      {identityRequired:true,expectedIdentity:{accountId:'account-a',userId:'user-a'},getIdentityToken:async()=>{callbacks++;return change&&mode==='logout'?null:syntheticJwt;}});t.after(()=>c.widget.destroy());
    await c.start();await tick();assert.equal(c.get('composer').hidden,false);const before=callbacks;change=true;c.get('text').value='Texto que precisa de conta válida';await c.get('composer').dispatch('submit');await tick();
    const sends=c.calls.filter(call=>call.kind==='messages');assert.equal(sends.length,mode==='valid'?1:0,mode);assert.ok(callbacks>before,mode);
    if(mode==='valid')assert.ok(c.calls.findIndex(call=>call.kind==='identity')<c.calls.findIndex(call=>call.kind==='messages'));
    else{assert.equal(c.get('composer').hidden,true);assert.equal(c.get('history').children.length,0);}
  }
});
test('SaaS refuses a history DTO from another account and shares a pending renewal with a send',async t=>{
  for(const mode of ['history-mismatch','concurrent-valid','concurrent-logout']){
    const contact={...verifiedContact,v:2,accountId:'account-a',userId:'user-a'};const wait=deferred();let change=false,callbacks=0;
    const c=fixture(call=>['session','identity'].includes(call.kind)?{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact})}:call.kind==='history'&&change&&mode==='history-mismatch'?{ok:true,json:async()=>({contact:{...contact,accountId:'account-b'},messages:[{id:'foreign-message-0001',direction:'inbound',text:'Other account secret',createdAt:new Date().toISOString()}],nextCursor:null,hasMore:false})}:null,
      {identityRequired:true,expectedIdentity:{accountId:'account-a',userId:'user-a'},getIdentityToken:async()=>{callbacks++;return change&&mode!=='history-mismatch'?wait.promise:syntheticJwt;}});t.after(()=>c.widget.destroy());
    await c.start();await tick();change=true;
    if(mode==='history-mismatch'){await c.poll();await tick();assert.equal(c.get('history').children.length,0);assert.equal(c.get('composer').hidden,true);assert.equal(c.get('history').textContent.includes('Other account secret'),false);}
    else{
      const before=callbacks;await c.poll();c.get('text').value='One explicit send';const sending=c.get('composer').dispatch('submit');await tick();
      assert.equal(callbacks,before+1);assert.equal(c.calls.some(call=>call.kind==='messages'),false);
      wait.resolve(mode==='concurrent-valid'?syntheticJwt:null);await sending;await tick();
      assert.equal(c.calls.filter(call=>call.kind==='messages').length,mode==='concurrent-valid'?1:0);if(mode==='concurrent-logout')assert.equal(c.get('history').children.length,0);
    }
  }
});

test('widget loads only public config before explicit guest start and uses canonical scoped paths without cookies or token URLs', async t => {
  const c = fixture(); t.after(() => c.widget.destroy()); assert.equal(c.calls.length, 0); c.widget.open(); assert.equal(c.calls.length, 0);
  assert.equal(c.configCalls.length,1);assert.deepEqual(c.configCalls[0].body,{});assert.equal(c.configCalls[0].options.credentials,'omit');
  assert.equal(c.get('panel').hidden, false); assert.equal(c.get('launcher').attributes.get('aria-expanded'), 'true');
  c.get('name').value = 'Visitante sintético'; await c.get('intro').dispatch('submit'); await tick();
  assert.deepEqual(c.calls.map(call => call.kind), ['challenge', 'session', 'history']);
  for (const call of c.calls) {
    assert.ok(call.url.startsWith('https://elozi.example/api/public/webchat/tenant-test/channel-test/'));
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.mode, 'cors'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.url.includes('b'.repeat(43)), false); assert.equal(call.options.headers['Content-Type'], 'application/json');
  }
  assert.equal(c.calls[1].body.challenge, 'a'.repeat(43)); assert.equal(c.calls[2].body.token, 'b'.repeat(43));
  assert.equal(c.get('title').textContent, 'Marca sintética'); assert.equal(c.get('attachments').disabled, true);
  assert.equal(c.get('intro').hidden, true); assert.equal(c.get('composer').hidden, false);
  assert.equal(c.get('credit').textContent, 'Atendimento por Marca sintética'); assert.equal(c.get('credit').hidden, false);
});

test('white label: the credit names the company brand from the server and disappears without one', async t => {
  const c = fixture(); t.after(() => c.widget.destroy());
  assert.equal(c.get('credit').hidden, true, 'no credit before the server names the brand'); assert.equal(c.get('credit').textContent, '');
  assert.doesNotMatch(c.get('panel').textContent, /Elozi/i);
  await c.start(); assert.equal(c.get('credit').textContent, 'Atendimento por Marca sintética'); assert.equal(c.get('credit').hidden, false);
  const unbranded = fixture(call => call.kind === 'challenge' ? { ok: true, status: 200, json: async () => ({ challenge: 'a'.repeat(43), expiresAt: future(), brand: { name: '   ' } }) } : null);
  t.after(() => unbranded.widget.destroy());
  await unbranded.start(); assert.equal(unbranded.get('composer').hidden, false, 'the conversation opens without a brand');
  assert.equal(unbranded.get('credit').hidden, true); assert.equal(unbranded.get('credit').textContent, '');
  const source = await readFile(new URL('../public/widget.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/elozi(?:Widget|Mounted)\b|data-elozi-[\w-]+/g, ''), /elozi/i, 'no product name in the visitor widget (data-elozi-* hooks are protocol)');
});

test('channel appearance, greeting and media switches apply before opening and survive legacy branding after start',async t=>{
  const c=fixture(null,{widget:channelWidget,media:true});t.after(()=>c.widget.destroy());await tick();
  assert.equal(c.get('panel').hidden,true);assert.equal(c.get('title').textContent,channelWidget.displayName);assert.equal(c.get('launcher-label').textContent,channelWidget.openButtonLabel);
  assert.equal(c.widget.host.style.getPropertyValue('--widget-panel'),'#0c0c0d');assert.equal(c.widget.host.style.getPropertyValue('--widget-primary-text'),'#000000');assert.equal(c.widget.host.style.getPropertyValue('--widget-radius'),'12px');
  assert.equal(c.get('avatar').src,channelWidget.avatarUrl);assert.equal(c.get('launcher-image').src,channelWidget.logoUrl);assert.equal(c.get('credit').hidden,true);assert.equal(c.get('greeting').textContent,channelWidget.greeting['pt-BR']);
  c.widget.open();await tick();assert.equal(c.calls.length,0,'opening greeting creates neither session nor conversation');assert.equal(c.get('email-label').hidden,false);assert.match(c.get('email-privacy').textContent,/somente.*atendimento/);
  await c.start();assert.equal(c.get('title').textContent,channelWidget.displayName);assert.equal(c.get('credit').hidden,true);assert.equal(c.get('attachments').hidden,true);assert.equal(c.get('voice').hidden,true);
  await c.select(new File([png],'blocked.png',{type:'image/png'}));assert.equal(c.get('selection').hidden,true);assert.equal(c.calls.filter(call=>['media','messages'].includes(call.kind)).length,0);
});

test('public settings reject CSS/URL injection and localized channel text remains literal',async t=>{
  const c=fixture(null,{locale:'en',widget:{...channelWidget,theme:'light',lightColors:{panel:'#f4f1ea',text:'#0c0c0d',accent:'#623497'},colors:{accent:'red;position:fixed',panel:'url(https://bad.test)'},avatarUrl:'javascript:alert(1)',logoUrl:'https://user:password@assets.example.test/logo.png',openButtonLabel:'<img onerror=alert(1)>',greeting:{en:'<script>not executable</script>'},credit:{visible:true,text:'Public support'}}});t.after(()=>c.widget.destroy());await tick();
  assert.equal(c.widget.host.style.getPropertyValue('--widget-panel'),'#f4f1ea');assert.equal(c.widget.host.style.getPropertyValue('--widget-accent'),'#623497');assert.equal(c.get('avatar').hidden,true);assert.equal(c.get('launcher-image').hidden,true);
  assert.equal(c.get('launcher-label').textContent,'<img onerror=alert(1)>');assert.equal(c.get('launcher-label').children.length,0);assert.equal(c.get('greeting').textContent,'<script>not executable</script>');assert.equal(c.get('greeting').children.length,0);assert.equal(c.get('credit').textContent,'Public support');
  await c.start();assert.equal(c.calls.find(call=>call.kind==='session').body.locale,'en');assert.equal(c.get('credit').textContent,'Public support');
});

test('optional prechat email validates locally and submits only the explicitly entered contact',async t=>{
  const c=fixture(null,{widget:channelWidget});t.after(()=>c.widget.destroy());await tick();c.widget.open();c.get('name').value='Visitante';c.get('email').value='not an address';
  await c.get('intro').dispatch('submit');assert.equal(c.calls.length,0);assert.equal(c.doc.activeElement,c.get('email'));assert.equal(c.get('status').textContent,'Confira o endereço de e-mail.');
  c.get('email').value='guest@example.test';await c.get('intro').dispatch('submit');await tick();assert.equal(c.calls.find(call=>call.kind==='session').body.email,'guest@example.test');
  const optional=fixture(null,{widget:channelWidget});t.after(()=>optional.widget.destroy());await optional.start();assert.equal(Object.hasOwn(optional.calls.find(call=>call.kind==='session').body,'email'),false);
});

test('pending/running assistant and human handoff expose factual progress, localized text and an optional reply email',async t=>{
  let phase='pending';const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[],hasMore:false,nextCursor:null,assistant:phase==='handoff'?{state:'handoff',typing:false,handoffReason:'draft_needs_human',requestEmail:true}:{state:phase,typing:true},contact:{verified:false,name:'Visitante',email:''}})}:call.kind==='contact'?{ok:true,json:async()=>({contact:{verified:false,name:'Visitante',email:call.body.email}})}:null,{widget:channelWidget,locale:'en'});t.after(()=>c.widget.destroy());await c.start();
  assert.equal(c.get('typing').hidden,false);assert.equal(c.get('typing').textContent,'The assistant is typing…');phase='running';await c.poll();assert.equal(c.get('typing').hidden,false);
  phase='handoff';await c.poll();assert.equal(c.get('typing').hidden,true);assert.equal(c.get('handoff').textContent,channelWidget.handoffMessage.en);assert.equal(c.get('contact').hidden,false);assert.equal(c.calls.filter(call=>call.kind==='contact').length,0);
  c.get('reply-email').value='invalid';await c.get('contact').dispatch('submit');assert.equal(c.calls.filter(call=>call.kind==='contact').length,0);
  c.get('reply-email').value='return@example.test';await c.get('contact').dispatch('submit');assert.equal(c.calls.filter(call=>call.kind==='contact').length,1);assert.equal(c.get('contact').hidden,true);assert.equal(c.get('status').textContent,'Reply email saved.');
});

test('handoff keeps its notice before acknowledgement and renders it once after persisted history without hiding reply contact',async t=>{
  for(const locale of ['pt-BR','en']){
    let acknowledged=false;
    const notice=channelWidget.handoffMessage[locale],ack={id:'handoff_'+'a'.repeat(32),kind:'agent',text:notice};
    const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:acknowledged?[ack]:[
      {id:'customer-notice-0001',kind:'customer',text:notice},{id:'assistant-notice-0001',kind:'agent',text:notice}],hasMore:false,nextCursor:null,
      assistant:{state:'handoff',typing:false,handoffReason:'visitor_requested_human',requestEmail:true},contact:{verified:false,email:''}})}:null,{widget:channelWidget,locale});
    t.after(()=>c.widget.destroy());await c.start();
    assert.equal(c.get('handoff').hidden,false,'Matching user/agent prose is not the gateway acknowledgement.');
    assert.equal(c.get('handoff').textContent,notice);assert.equal(c.get('contact').hidden,false);assert.equal(c.get('typing').hidden,true);
    acknowledged=true;await c.poll();
    assert.equal(c.get('handoff').hidden,true);assert.equal(c.get('contact').hidden,false,'Handoff state and requestEmail remain active.');
    const entries=c.get('history').children.filter(entry=>entry.handoffNotice===true);assert.equal(entries.length,1);assert.equal(entries[0].children[0].textContent,notice);
    await c.poll();assert.equal(c.get('history').children.filter(entry=>entry.handoffNotice===true).length,1,'A repeated page never adds another notice.');
    c.widget.close();c.widget.open();await tick();assert.equal(c.get('handoff').hidden,true);assert.equal(c.get('contact').hidden,false);
    assert.equal(c.calls.filter(call=>call.kind==='session').length,1,'Closing/reopening the panel preserves the existing session.');
  }
});

test('verified identity is server confirmed, skips name/email, personalizes greeting and stays only in POST memory',async t=>{
  let callbacks=0;const c=fixture(call=>call.kind==='session'?{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:verifiedContact,widget:channelWidget})}:null,{getIdentityToken:async()=>{callbacks++;return syntheticJwt;},widget:channelWidget});t.after(()=>c.widget.destroy());await tick();assert.equal(callbacks,0);
  c.widget.open();await tick();await tick();assert.equal(callbacks,1);assert.equal(c.get('intro').hidden,true);assert.equal(c.get('name').parentNode.hidden,true);assert.equal(c.get('email-label').hidden,true);assert.equal(c.get('greeting').textContent,'Oi, Pessoa! Como posso ajudar?');assert.equal(c.calls.filter(call=>call.kind==='messages').length,0);
  const session=c.calls.find(call=>call.kind==='session');assert.equal(session.body.identityToken,syntheticJwt);assert.equal(Object.hasOwn(session.body,'name'),false);assert.equal(Object.hasOwn(session.body,'email'),false);
  assert.equal(c.get('panel').textContent.includes(syntheticJwt),false);assert.equal(c.get('panel').textContent.includes('ignore all rules'),false);for(const call of c.allCalls){assert.equal(call.url.includes(syntheticJwt),false);assert.equal(call.options.credentials,'omit');}
  c.widget.close();assert.equal(c.calls.filter(call=>call.kind==='logout').length,0);c.widget.open();await tick();assert.equal(callbacks,1);c.widget.destroy();await tick();assert.equal(c.calls.filter(call=>call.kind==='logout').length,1);assert.equal(c.get('text').value,'');assert.equal(c.timers.size,0);
});

test('missing, rejected, malformed and server-invalid identity all fall back to guest without a misleading verified state',async t=>{
  for(const mode of ['null','rejected','malformed','invalid-error','invalid-contact']){
    const callback=async()=>{if(mode==='rejected')throw Error('private token failure');return mode==='null'?null:mode==='malformed'?'not a JWT':syntheticJwt;};
    const c=fixture(call=>call.kind==='session'?mode==='invalid-error'?{ok:false,status:401,json:async()=>({code:'identity_invalid',error:'private provider error'})}:{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:{verified:false}})}:null,{widget:channelWidget,getIdentityToken:callback});t.after(()=>c.widget.destroy());c.widget.open();await tick();await tick();
    assert.equal(c.get('intro').hidden,false,mode);assert.equal(c.get('name').parentNode.hidden,false,mode);assert.equal(c.get('email-label').hidden,false,mode);assert.equal(c.calls.filter(call=>call.kind==='history').length,0,mode);assert.doesNotMatch(c.get('status').textContent,/private/);
  }
});

test('expired identity refreshes once from callback and never automatically repeats an uncertain message',async t=>{
  let callbacks=0,sends=0;const c=fixture(call=>call.kind==='session'||call.kind==='identity'?{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:verifiedContact})}:call.kind==='messages'&&++sends===1?{ok:false,status:403,json:async()=>({code:'identity_expired'})}:null,{widget:channelWidget,getIdentityToken:async()=>{callbacks++;return syntheticJwt;}});t.after(()=>c.widget.destroy());await c.start();c.get('text').value='Preserve this message';await c.get('composer').dispatch('submit');
  assert.equal(callbacks,2);assert.equal(sends,1);assert.equal(c.get('text').value,'Preserve this message');assert.equal(c.get('send').textContent,'Tentar novamente');assert.equal(c.calls.filter(call=>call.kind==='identity').length,1);
  await c.get('composer').dispatch('submit');const messages=c.calls.filter(call=>call.kind==='messages');assert.equal(messages.length,2);assert.deepEqual(messages[0].body,messages[1].body);assert.equal(c.get('text').value,'');
});

test('identity refresh refuses another contact and closing/destroying cancels late callback or session commits',async t=>{
  const c=fixture(call=>call.kind==='session'?{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:verifiedContact})}:call.kind==='history'?{ok:false,status:403,json:async()=>({code:'identity_expired'})}:call.kind==='identity'?{ok:true,json:async()=>({contact:{...verifiedContact,externalId:'product:other'}})}:null,{widget:channelWidget,getIdentityToken:async()=>syntheticJwt});t.after(()=>c.widget.destroy());await c.start();assert.equal(c.get('intro').hidden,false);assert.equal(c.get('history').children.length,0);assert.equal(c.get('name').parentNode.hidden,false);
  for(const action of ['close','destroy']){const wait=deferred(),late=fixture(null,{getIdentityToken:()=>wait.promise,widget:channelWidget});t.after(()=>late.widget.destroy());late.widget.open();await tick();late.widget[action]();wait.resolve(syntheticJwt);await tick();assert.equal(late.calls.length,0);assert.equal(late.timers.size,0);if(action==='close'){late.widget.open();await tick();await tick();assert.equal(late.get('intro').hidden,false,'fixture session is guest, not inferred verified');}}
});

test('feedback appears only on closed configured conversations and is submitted only on explicit visitor action',async t=>{
  let closed=false;const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[],nextCursor:null,hasMore:false,conversationStatus:closed?'closed':'open',feedback:null})}:call.kind==='feedback'?{ok:true,json:async()=>({feedback:{rating:call.body.rating}})}:null,{widget:channelWidget,locale:'en'});t.after(()=>c.widget.destroy());await c.start();assert.equal(c.get('feedback').hidden,true);closed=true;await c.poll();assert.equal(c.get('feedback').hidden,false);assert.equal(c.calls.filter(call=>call.kind==='feedback').length,0);
  await c.get('not-useful').dispatch('click');assert.equal(c.calls.find(call=>call.kind==='feedback').body.rating,'not_useful');assert.equal(c.get('not-useful').attributes.get('aria-pressed'),'true');assert.equal(c.get('status').textContent,'Thank you for your feedback.');
  const legacy=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[],hasMore:false,conversationStatus:'closed'})}:null);t.after(()=>legacy.widget.destroy());await legacy.start();assert.equal(legacy.get('feedback').hidden,true);
});

test('history transport failure after known closure keeps feedback and localized ended status without opening another conversation',async t=>{
  for(const locale of ['pt-BR','en'])for(const conversationStatus of ['closed','open',undefined]){
    let interrupted=false;
    const c=fixture(call=>{if(call.kind==='history'){if(interrupted)throw Error('Synthetic connection closed');return {ok:true,json:async()=>({messages:[],hasMore:false,nextCursor:null,conversationStatus})};}return null;},{widget:channelWidget,locale});
    t.after(()=>c.widget.destroy());await c.start();c.get('text').value='Preserve my draft';interrupted=true;await c.poll();
    const closed=conversationStatus==='closed';
    assert.equal(c.get('status').textContent,closed?(locale==='en'?'This conversation has ended.':'Este atendimento foi encerrado.'):(locale==='en'?'Connection interrupted. We will check for messages again.':'Conexão interrompida. Voltaremos a conferir as mensagens.'));
    assert.equal(c.get('status').className,closed?'status':'status error');assert.equal(c.get('feedback').hidden,!closed);
    assert.equal(c.get('text').value,'Preserve my draft');assert.equal(c.get('intro').hidden,true);
    await c.poll();assert.equal(c.calls.filter(call=>call.kind==='session').length,1);assert.equal(c.calls.filter(call=>call.kind==='challenge').length,1);
  }
});

test('known closed history never suppresses expired authority or identity refresh guards',async t=>{
  for(const status of [401,403]){
    let denied=false;const c=fixture(call=>call.kind==='history'?denied?{ok:false,status,json:async()=>({error:'Private detail'})}:{ok:true,json:async()=>({messages:[],hasMore:false,conversationStatus:'closed'})}:null,{widget:channelWidget});
    t.after(()=>c.widget.destroy());await c.start();c.get('text').value='Draft before revoked access';denied=true;await c.poll();
    assert.equal(c.get('intro').hidden,false);assert.equal(c.get('feedback').hidden,true);assert.equal(c.get('history').children.length,0);
    assert.equal(c.get('status').textContent,'A sessão terminou ou o atendimento ficou indisponível. Inicie novamente para conferir.');
    assert.equal(c.get('text').value,'Draft before revoked access');assert.equal(c.timers.size,0);assert.equal(c.calls.filter(call=>call.kind==='session').length,1);
  }
  let callbacks=0,expired=false;
  const c=fixture(call=>call.kind==='session'||call.kind==='identity'?{ok:true,json:async()=>({token:'b'.repeat(43),expiresAt:future(),contact:verifiedContact})}:call.kind==='history'?expired?{ok:false,status:403,json:async()=>({code:'identity_expired'})}:{ok:true,json:async()=>({messages:[],hasMore:false,conversationStatus:'closed'})}:null,
    {widget:channelWidget,getIdentityToken:async()=>{callbacks++;return syntheticJwt;}});
  t.after(()=>c.widget.destroy());await c.start();expired=true;await c.poll();await tick();
  assert.equal(callbacks,2);assert.equal(c.calls.filter(call=>call.kind==='identity').length,1);assert.equal(c.get('intro').hidden,true);assert.equal(c.get('feedback').hidden,false);
  assert.equal(c.calls.filter(call=>call.kind==='session').length,1,'Renewing identity never opens a replacement conversation.');
});

test('destroy discards late public config and late contact/feedback responses without resurrecting DOM or timers',async t=>{
  const wait=deferred(),c=fixture(call=>call.kind==='config'?wait.promise:null);c.widget.destroy();assert.equal(c.timers.size,0,'destroy clears deadlines before an uncooperative fetch resolves');wait.resolve({ok:true,json:async()=>({widget:channelWidget})});await tick();assert.equal(c.widget.host.isConnected,false);assert.notEqual(c.get('title').textContent,channelWidget.displayName);assert.equal(c.timers.size,0);
  for(const kind of ['contact','feedback']){const response=deferred(),live=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[],hasMore:false,conversationStatus:'closed',assistant:{state:'handoff',handoffReason:'visitor_requested_human',requestEmail:true},contact:{verified:false,email:''}})}:call.kind===kind?response.promise:null,{widget:channelWidget});await live.start();live.get('reply-email').value='late@example.test';const pending=kind==='contact'?live.get('contact').dispatch('submit'):live.get('useful').dispatch('click');await tick();live.widget.destroy();response.resolve({ok:true,json:async()=>({contact:{email:'late@example.test'},feedback:{rating:'useful'}})});await pending;assert.equal(live.widget.host.isConnected,false);assert.equal(live.timers.size,0);assert.notEqual(live.get('status').textContent,'E-mail de retorno salvo.');assert.notEqual(live.get('status').textContent,'Obrigado pela avaliação.');}
});

test('English widget localizes launcher, forms, status, footer and accessible labels without touching public API bodies', async t => {
  const c = fixture(null, { locale: 'en' }); t.after(() => c.widget.destroy());
  assert.equal(c.widget.host.attributes.get('lang'), 'en');
  assert.equal(c.get('launcher').textContent, '◌Chat with our team');
  assert.equal(c.get('title').textContent, 'Support');
  assert.equal(c.get('close').attributes.get('aria-label'), 'Close conversation');
  assert.equal(c.get('start').textContent, 'Start conversation');
  assert.match(c.get('intro').textContent, /What should we call you\?/);
  assert.equal(c.get('history').attributes.get('aria-label'), 'Conversation messages');
  assert.equal(c.get('text').placeholder, 'Write your message…');
  assert.match(c.get('composer').textContent, /Message to the team/);
  assert.equal(c.get('text-limit').textContent, 'Up to 4,000 characters · text');
  assert.equal(c.get('attachments').textContent, 'Attachments unavailable');
  assert.equal(c.get('attachments').attributes.get('aria-label'), 'Attachments unavailable in this chat');
  assert.equal(c.get('file').attributes.get('aria-label'), 'Choose a file');
  assert.equal(c.get('selection').attributes.get('aria-label'), 'File for review');
  assert.equal(c.get('credit').hidden, true); assert.doesNotMatch(c.get('panel').textContent, /Elozi/i);
  assert.equal(c.calls.length, 0); c.widget.open(); assert.equal(c.calls.length, 0);
  c.get('name').value = 'bad\nname'; await c.get('intro').dispatch('submit');
  assert.equal(c.calls.length, 0); assert.equal(c.get('status').textContent, 'Enter your name using up to 80 characters.');
  await c.start(); assert.equal(c.get('title').textContent, 'Marca sintética', 'server-owned names retain their exact text');
  assert.equal(c.get('credit').textContent, 'Support by Marca sintética');
  assert.equal(c.get('status').textContent, 'The team will receive your messages through this site.');
  assert.equal(c.get('capabilities').textContent, 'This chat accepts text only.');
  assert.equal(c.get('text').maxLength, 4000); assert.equal(c.get('send').textContent, 'Send');
  assert.deepEqual(c.calls.map(call => call.body), [{}, { challenge: 'a'.repeat(43), locale:'en', name: 'Visitante sintético' }, { token: 'b'.repeat(43), limit: 100 }]);
  for (const call of c.calls) { assert.equal(call.url.includes('locale'), false); assert.equal(call.options.credentials, 'omit'); }
});

test('locale resolves an explicit option before page language and unknown values keep the Portuguese default', async t => {
  for (const [options, expected] of [
    [{}, 'pt-BR'], [{ language: 'en-US' }, 'en'], [{ language: 'EN' }, 'en'], [{ language: 'pt' }, 'pt-BR'],
    [{ language: 'pt-PT' }, 'pt-BR'], [{ language: 'fr-FR' }, 'pt-BR'], [{ language: 'en', locale: 'pt-BR' }, 'pt-BR'],
    [{ language: 'pt-BR', locale: 'en-GB' }, 'en'], [{ language: 'en', locale: 'unknown' }, 'pt-BR'],
    [{ language: 'en', locale: 123 }, 'pt-BR'], [{ language: 'en', locale: '' }, 'pt-BR'], [{ language: 'en', locale: 'en<script>' }, 'pt-BR']
  ]) {
    const c = fixture(null, options); t.after(() => c.widget.destroy());
    assert.equal(c.widget.host.attributes.get('lang'), expected);
    assert.equal(c.get('start').textContent, expected === 'en' ? 'Start conversation' : 'Iniciar conversa');
    c.doc.documentElement.lang = expected === 'en' ? 'pt-BR' : 'en'; c.widget.open();
    assert.equal(c.widget.host.attributes.get('lang'), expected, 'mounted language stays fixed until destroy/remount');
    assert.equal(c.calls.length, 0);
  }
});

test('first mount wins per page and public context; destroy/remount changes locale and stale cleanup cannot remove the new instance', async t => {
  const c = fixture(null, { locale: 'en', media: true }); t.after(() => c.widget.destroy());
  assert.equal(c.mount({ locale: 'pt-BR' }), c.widget); assert.equal(c.doc.body.children.length, 1);
  assert.equal(c.get('start').textContent, 'Start conversation'); assert.equal(c.calls.length, 0);
  await c.start(); await c.select(new File([png], 'Review.png', { type: 'image/png' }));
  c.widget.destroy(); assert.equal(c.revoked.length, c.created.length); assert.equal(c.timers.size, 0);
  const remounted = c.mount({ locale: 'pt-BR' }); t.after(() => remounted.destroy());
  assert.notEqual(remounted, c.widget); assert.equal(remounted.host.attributes.get('lang'), 'pt-BR');
  assert.equal(remounted.host.dataset.eloziWidget, c.widget.host.dataset.eloziWidget);
  const before = c.calls.length; remounted.open(); assert.equal(c.calls.length, before, 'the old session is not reused');
  c.widget.destroy(); assert.equal(remounted.host.isConnected, true); assert.equal(c.mount({ locale: 'en' }), remounted);
  assert.equal(c.doc.body.children.length, 1); assert.equal(c.doc.events.get('visibilitychange').length, 1);
  const other = c.mount({ channelId: 'other-public-channel', locale: 'en' }); t.after(() => other.destroy());
  assert.notEqual(other, remounted); other.open(); assert.equal(c.calls.length, before);
  assert.equal(other.host.dataset.eloziWidget, JSON.stringify(['https://elozi.example', 'tenant-test', 'other-public-channel']));
});

test('script bootstrap accepts data-locale/data-language, keeps the first context mount, and sends nothing until explicit submit', async t => {
  const previousDocument = globalThis.document;
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  // Evaluate the real bootstrap with its served HTTPS module URL; dependencies still use the audited local modules.
  const servedModule = 'https://elozi.example/widget.js';
  const source = (await readFile(new URL('../public/widget.js', import.meta.url), 'utf8'))
    .replaceAll("from './channel-capabilities.js'", `from '${new URL('../public/channel-capabilities.js', import.meta.url).href}'`)
    .replaceAll("from './webchat-media.js'", `from '${new URL('../public/webchat-media.js', import.meta.url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(servedModule));
  for (const [index, attributes, expected] of [
    [0, { locale: 'en', language: 'pt-BR' }, 'en'], [1, { language: 'en' }, 'en'], [2, {}, 'en'], [3, { locale: 'invalid', language: 'en' }, 'pt-BR']
  ]) {
    const c = fixture(null, { language: 'en' }); c.widget.destroy();
    const script = c.doc.createElement('script'); script.src = servedModule; script.nonce = 'synthetic-nonce';
    script.dataset = { tenantId: 'tenant-test', channelId: 'channel-test', ...attributes };
    const duplicate = c.doc.createElement('script'); duplicate.src = servedModule; duplicate.dataset = { tenantId: 'tenant-test', channelId: 'channel-test', locale: expected === 'en' ? 'pt-BR' : 'en' };
    c.doc.querySelectorAll = () => [script, duplicate]; c.view.fetch = c.fetchImpl;
    globalThis.document = c.doc; const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#bootstrap-${index}`);
    assert.equal(script.dataset.eloziMounted, 'true'); assert.equal(duplicate.dataset.eloziMounted, 'true');
    assert.equal(c.doc.body.children.length, 1); assert.equal(c.doc.body.children[0].attributes.get('lang'), expected);
    assert.equal(c.doc.body.children[0].shadowRoot.children[0].attributes.get('nonce'), 'synthetic-nonce');
    const widget = module.createWebchatWidget({ document: c.doc, apiOrigin: new URL(servedModule).origin, tenantId: 'tenant-test', channelId: 'channel-test', locale: 'pt-BR' });
    t.after(() => widget.destroy()); widget.open(); assert.equal(c.calls.length, 0);
    const root = widget.host.shadowRoot; root.querySelector('#widget-name').value = 'Synthetic visitor'; await root.querySelector('#widget-intro').dispatch('submit'); await tick();
    assert.deepEqual(c.calls.map(call => call.kind), ['challenge', 'session', 'history']); widget.destroy();
  }
});

test('uncertain send retries the same immutable command and preserves draft until a confirmed receipt', async t => {
  let sends = 0;
  const c = fixture(call => { if (call.kind === 'messages' && ++sends === 1) throw Error('Synthetic timeout'); }); t.after(() => c.widget.destroy()); await c.start();
  c.get('text').value = 'Mensagem que precisa permanecer'; await c.get('composer').dispatch('submit');
  assert.equal(c.get('text').value, 'Mensagem que precisa permanecer'); assert.equal(c.get('text').readOnly, true); assert.equal(c.get('send').textContent, 'Tentar novamente');
  await c.get('composer').dispatch('submit');
  const requests = c.calls.filter(call => call.kind === 'messages'); assert.equal(requests.length, 2); assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(c.get('text').value, ''); assert.equal(c.get('text').readOnly, false); assert.equal(c.get('send').textContent, 'Enviar');
});

test('English failures localize validation, rate limits and unknown sends while keeping retry identity and draft', async t => {
  for (const [status, expected] of [
    [400, 'Check the message and file before trying again.'], [413, 'Check the message and file before trying again.'],
    [429, 'Wait a minute and try again.'], [500, 'Send unconfirmed. Try again to check the same message.'],
    [403, 'Your session has ended. Your message was preserved; review it before starting another conversation.']
  ]) {
    let sends = 0;
    const c = fixture(call => call.kind === 'messages' && ++sends === 1 ? { ok: false, status, json: async () => ({ error: 'Erro externo em português com conteúdo que não pode aparecer.' }) } : null, { locale: 'en' });
    t.after(() => c.widget.destroy()); await c.start(); c.get('text').value = 'x'.repeat(4001);
    await c.get('composer').dispatch('submit'); assert.equal(sends, 0); assert.equal(c.get('status').textContent, 'Write a message using up to 4,000 characters.');
    c.get('text').value = 'Preserve this draft'; await c.get('composer').dispatch('submit');
    assert.equal(c.get('status').textContent, expected); assert.equal(c.get('text').value, 'Preserve this draft');
    assert.equal(c.get('status').textContent.includes('Erro externo'), false);
    if ([429, 500].includes(status)) {
      assert.equal(c.get('send').textContent, 'Try again'); assert.equal(c.get('text').readOnly, true);
      await c.get('composer').dispatch('submit');
      const requests = c.calls.filter(call => call.kind === 'messages'); assert.deepEqual(requests[1].body, requests[0].body);
      assert.equal(c.get('send').textContent, 'Send'); assert.equal(c.get('status').textContent, 'The team has received your message.');
    }
    if (status === 403) { const before = c.calls.length; await c.get('composer').dispatch('submit'); assert.equal(c.calls.length, before); }
  }
  for (const [status, expected] of [[429, 'Too many conversations are being opened. Wait a minute.'], [500, 'Unable to open support. Try again.']]) {
    const c = fixture(call => call.kind === 'challenge' ? { ok: false, status } : null, { locale: 'en' }); t.after(() => c.widget.destroy());
    await c.start(); assert.equal(c.get('status').textContent, expected); assert.equal(c.get('composer').hidden, true);
  }
});

test('English history translates sender labels but preserves user, team and assistant message content', async t => {
  const messages = ['customer', 'human', 'agent'].map((kind, index) => ({ id: `localized-message-000${index}`, kind, text: `Texto original ${index}` }));
  const c = fixture(call => call.kind === 'history' ? { ok: true, json: async () => ({ messages, nextCursor: null, hasMore: false }) } : null, { locale: 'en' });
  t.after(() => c.widget.destroy()); await c.start();
  assert.deepEqual(c.get('history').children.map(entry => entry.children[0].textContent), messages.map(message => message.text));
  assert.deepEqual(c.get('history').children.map(entry => entry.children.at(-1).textContent), ['You', 'Team', 'Virtual assistant']);
});

test('history rendering uses textContent, retains node identity and cursor, and preserves an unfinished draft', async t => {
  let histories = 0;
  const one = { id: 'visible-message-0001', kind: 'human', text: '<img src=x onerror=alert(1)>' }, two = { id: 'visible-message-0002', kind: 'customer', text: 'Resposta em texto' };
  const c = fixture(call => {
    if (call.kind === 'history') { const messages = ++histories === 1 ? [one] : [two]; return { ok: true, json: async () => ({ messages, nextCursor: messages.at(-1).id, hasMore: false }) }; }
  }); t.after(() => c.widget.destroy()); await c.start();
  const existing = c.get('history').children[0]; assert.equal(existing.children[0].textContent, one.text); assert.equal(existing.children[0].children.length, 0);
  c.get('text').value = 'Rascunho local'; await c.poll();
  assert.equal(c.get('history').children[0], existing); assert.equal(c.get('history').children.length, 2); assert.equal(c.get('text').value, 'Rascunho local');
  assert.equal(c.calls.filter(call => call.kind === 'history')[1].body.after, one.id);
});

test('closing or changing widget context discards late response and preserves pending command on reopen', async t => {
  const waiting = deferred(); let sends = 0;
  const c = fixture(call => { if (call.kind === 'messages' && ++sends === 1) return waiting.promise; }); t.after(() => c.widget.destroy()); await c.start();
  c.get('text').value = 'Mensagem ainda sem recibo'; const pending = c.get('composer').dispatch('submit'); await tick(); const request = c.calls.at(-1);
  c.widget.close(); assert.equal(request.options.signal.aborted, true); assert.equal(c.get('panel').hidden, true);
  waiting.resolve({ ok: true, json: async () => ({ messageId: 'received-message-0001' }) }); await pending;
  assert.equal(c.get('text').value, 'Mensagem ainda sem recibo'); c.widget.open(); await tick(); await c.get('composer').dispatch('submit');
  const sent = c.calls.filter(call => call.kind === 'messages'); assert.deepEqual(sent[1].body, sent[0].body);
  c.widget.host.dataset.eloziWidget = 'another-context'; c.get('text').value = 'Outro contexto'; const before = c.calls.length;
  await c.get('composer').dispatch('submit'); assert.equal(c.calls.length, before);
});

test('polling stops while hidden/closed and destroys timers/listeners/DOM without persisting its token', async t => {
  const c = fixture(); await c.start(); assert.equal([...c.timers.values()].filter(value => value.delay === 3000).length, 1);
  c.doc.visibilityState = 'hidden'; await c.doc.dispatch('visibilitychange'); assert.equal(c.timers.size, 0);
  const before = c.calls.length; await c.get('composer').dispatch('submit'); assert.equal(c.calls.length, before);
  c.doc.visibilityState = 'visible'; await c.doc.dispatch('visibilitychange'); await tick(); assert.equal(c.calls.length, before + 1);
  c.widget.close(); assert.equal(c.timers.size, 0); assert.equal(c.doc.activeElement, c.get('launcher'));
  c.widget.destroy(); assert.equal(c.widget.host.isConnected, false); assert.equal(c.doc.events.get('visibilitychange').length, 0);
  c.widget.open(); assert.equal(c.calls.length, before + 1);
});

test('expired authority preserves text, blocks another send and requires a fresh explicit session', async t => {
  const c = fixture(call => call.kind === 'messages' ? { ok: false, status: 403 } : null); t.after(() => c.widget.destroy()); await c.start();
  c.get('text').value = 'Mensagem preservada'; await c.get('composer').dispatch('submit');
  assert.equal(c.get('text').value, 'Mensagem preservada'); assert.equal(c.get('intro').hidden, false); assert.equal(c.get('composer').hidden, true);
  const before = c.calls.length; await c.get('composer').dispatch('submit'); assert.equal(c.calls.length, before); assert.match(c.get('status').textContent, /sessão terminou/i);
});

test('request deadline aborts transport and leaves an uncertain command available for the same-key retry', async t => {
  const c = fixture(call => call.kind === 'messages' ? new Promise((resolve, reject) => call.options.signal.addEventListener('abort', () => reject(Error('Synthetic deadline')), { once: true })) : null);
  t.after(() => c.widget.destroy()); await c.start(); c.get('text').value = 'Texto preservado após limite'; const pending = c.get('composer').dispatch('submit'); await tick();
  const deadline = [...c.timers].find(([, value]) => value.delay === 10_000); assert.ok(deadline); deadline[1].fn(); await pending;
  assert.equal(c.calls.at(-1).options.signal.aborted, true); assert.equal(c.get('text').value, 'Texto preservado após limite'); assert.equal(c.get('send').textContent, 'Tentar novamente');
  assert.equal([...c.timers.values()].some(value => value.delay === 10_000), false);
});

test('widget validates user input, consumes Escape/keyboard shortcuts and bounds history DOM', async t => {
  let count = 0;
  const c = fixture(call => { if (call.kind === 'history') { const messages = Array.from({ length: 100 }, () => ({ id: 'bounded-message-' + String(++count).padStart(5, '0'), kind: 'human', text: 'Histórico sintético' })); return { ok: true, json: async () => ({ messages, nextCursor: messages.at(-1).id, hasMore: count < 300 }) }; } });
  t.after(() => c.widget.destroy()); c.widget.open(); c.get('name').value = 'Nome\nInválido'; await c.get('intro').dispatch('submit'); assert.equal(c.calls.length, 0);
  c.get('name').value = 'Visitante'; await c.get('intro').dispatch('submit'); await tick(); await tick(); assert.equal(c.get('history').children.length, 250);
  c.get('text').value = 'x'.repeat(4001); await c.get('composer').dispatch('submit'); assert.equal(c.calls.filter(call => call.kind === 'messages').length, 0);
  c.get('text').value = 'Atalho de envio'; const event = await c.get('text').dispatch('keydown', { key: 'Enter', ctrlKey: true }); assert.equal(event.defaultPrevented, true);
  assert.equal(c.calls.filter(call => call.kind === 'messages').length, 1);
  const escape = await c.widget.host.shadowRoot.dispatch('keydown', { key: 'Escape' }); assert.equal(escape.defaultPrevented, true); assert.equal(escape.stopped, true); assert.equal(c.get('panel').hidden, true);
});

test('widget text reaches the real RAM gateway exactly once and operator reply appears on the next poll', async t => {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const row = auth.insertUser({ username: 'widget-server-admin', name: 'Atendente' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo'), admin = auth.actor(row);
  const tenant = store.createTenant(admin, { name: 'Widget RAM', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture: canal', state => state.channels.push({ id: 'channel-test', kind: 'webchat', name: 'Atendimento do site' }));
  const operations = new Operations(store, auth), gateway = new WebchatGateway(store, { operations }); gateway.configure(admin, tenant.id, 'channel-test', { origins: ['https://customer.example'] });
  const origin = 'https://customer.example'; let failAfterCommit = true;
  const c = fixture(async ({ kind, body }) => {
    let result;
    if (kind === 'challenge') result = { ...gateway.publicAccess(tenant.id, 'channel-test', origin), ...gateway.challenge({ tenantId: tenant.id, channelId: 'channel-test', origin }) };
    if (kind === 'session') result = gateway.openSession({ tenantId: tenant.id, channelId: 'channel-test', origin, ...body });
    if (kind === 'history') result = gateway.history({ tenantId: tenant.id, channelId: 'channel-test', origin, ...body });
    if (kind === 'messages') { result = await gateway.receive({ tenantId: tenant.id, channelId: 'channel-test', origin, ...body }); if (failAfterCommit) { failAfterCommit = false; throw Error('Synthetic response lost after commit'); } }
    return { ok: true, json: async () => result };
  }); t.after(() => { c.widget.destroy(); gateway.close(); store.close(); }); await c.start();
  c.get('text').value = 'Mensagem real em RAM'; await c.get('composer').dispatch('submit'); await c.get('composer').dispatch('submit');
  let current = store.tenant(admin, tenant.id).conversations[0]; assert.equal(current.messages.length, 1);
  store.mutate(admin, tenant.id, 'Fixture: assumir', state => { const item = state.conversations[0]; item.owner = 'human'; item.assignedUserId = admin.userId; item.version++; });
  current = store.tenant(admin, tenant.id).conversations[0]; await gateway.send(admin, tenant.id, current.id, { channelId: 'channel-test', version: current.version, text: 'Resposta da equipe RAM' });
  await tick(); await c.poll(); assert.match(c.get('history').textContent, /Resposta da equipe RAM/); assert.equal(store.tenant(admin, tenant.id).conversations[0].messages.length, 2);
});

const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('Synthetic widget image')]);
const attachment=(index,extras={})=>({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,kind:'image',name:'Foto sintética.png',mime:'image/png',size:png.length,status:'ready',preview:true,...extras});
const nodes=(root,tag)=>[...(root.tagName===tag?[root]:[]),...root.children.flatMap(child=>nodes(child,tag))];
const card=c=>c.get('history').children[0].children.find(node=>node.className==='media-card');

test('unavailable attachment 404 stays on its card preserving chat and draft, while revoked media 403 ends the session',async t=>{
 for(const locale of ['pt-BR','en'])for(const status of [404,403]){
  const file=attachment(1),message={id:'visible-message-0001',kind:'human',text:'Public QA reply',attachments:[file]};
  const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[message],nextCursor:message.id,hasMore:false})}:call.kind==='media-download'?{ok:false,status,json:async()=>({error:'Private provider detail must not appear'})}:null,{media:true,locale});t.after(()=>c.widget.destroy());await c.start();
  const historyEntry=c.get('history').children[0],fileCard=card(c);c.get('text').value='Preserve my draft';await nodes(fileCard,'button')[0].dispatch('click');
  assert.equal(c.get('text').value,'Preserve my draft');assert.equal(c.created.length,0);assert.doesNotMatch(c.get('panel').textContent,/Private provider/);
  if(status===404){
   assert.equal(c.get('intro').hidden,true);assert.equal(c.get('composer').hidden,false);assert.equal(c.get('history').hidden,false);assert.equal(c.get('history').children[0],historyEntry);assert.equal(card(c),fileCard);
   assert.match(fileCard.textContent,locale==='en'?/Unable to load this file/:/Não foi possível carregar este arquivo/);assert.equal(c.calls.filter(call=>call.kind==='media-download').length,1,'no automatic retry');
   await c.poll();assert.equal(c.get('history').children[0],historyEntry);assert.equal(c.get('text').value,'Preserve my draft');assert.equal(c.calls.filter(call=>call.kind==='history').length,2);
  }else{assert.equal(c.get('intro').hidden,false);assert.equal(c.get('composer').hidden,true);assert.equal(c.get('history').children.length,0);const before=c.calls.length;await c.get('composer').dispatch('submit');assert.equal(c.calls.length,before);}
 }
});

test('widget media packs exactly one private file with caption or empty text and explicit capabilities',async t=>{
 for(const [mime,bytes,name,text]of [['image/png',png,'Foto.png','Legenda'],['video/mp4',Buffer.from('synthetic MP4'),'Vídeo.mp4',''],['audio/ogg',Buffer.from('synthetic OGG'),'Áudio.ogg','Legenda de áudio'],['application/pdf',Buffer.from('%PDF synthetic'),'Arquivo.pdf','']]){
  const c=fixture(null,{media:true});t.after(()=>c.widget.destroy());await c.start();const file=new File([bytes],name,{type:mime});await c.select(file);c.get('text').value=text;
  assert.equal(c.get('attachments').disabled,false);assert.equal(c.get('selection').hidden,false);assert.equal(c.get('text').maxLength,1024);
  await c.get('composer').dispatch('submit');const sent=c.calls.filter(call=>call.kind==='media');assert.equal(sent.length,1);assert.deepEqual(sent[0].fileBytes,bytes);
  assert.deepEqual(sent[0].body,{clientMessageId:'widget-client-message-0001',text,name,mime,voice:false});assert.equal(sent[0].options.headers.Authorization,'Bearer '+'b'.repeat(43));assert.equal(sent[0].options.headers['Content-Type'],'application/octet-stream');assert.equal(sent[0].options.referrerPolicy,'no-referrer');assert.equal(sent[0].url.includes('b'.repeat(43)),false);
  assert.equal(c.get('selection').hidden,true);assert.equal(c.get('text').value,'');assert.equal(c.calls.some(call=>call.kind==='messages'),false);assert.equal(c.created.every(entry=>c.revoked.includes(entry.url)),true);
 }
});

test('widget rejects size/multiple files/caption before reading bytes or creating URLs; voice needs its own capability',async t=>{
 const c=fixture(null,{media:true,voice:false});t.after(()=>c.widget.destroy());await c.start();assert.equal(c.get('voice').hidden,true);
 const forbidden={size:WEBCHAT_MEDIA_MAX_BYTES+1,type:'image/png',name:'Too-large.png',slice(){assert.fail('No bytes should be read');},arrayBuffer(){assert.fail('No read');}};
 await c.select(forbidden);assert.equal(c.created.length,0);assert.equal(c.get('selection').hidden,true);
 c.get('file').files=[new File([png],'a.png',{type:'image/png'}),new File([png],'b.png',{type:'image/png'})];await c.get('file').dispatch('change');assert.equal(c.created.length,0);
 await c.select(new File([png],'a.png',{type:'image/png'}));c.get('text').value='x'.repeat(1025);await c.get('composer').dispatch('submit');assert.equal(c.calls.filter(call=>call.kind==='media').length,0);assert.equal(c.get('text').readOnly,false);
 await c.get('remove-file').dispatch('click');assert.equal(c.get('selection').hidden,true);assert.equal(c.created.every(entry=>c.revoked.includes(entry.url)),true);assert.equal(c.get('text').value.length,1025);
 const textOnly=fixture();t.after(()=>textOnly.widget.destroy());await textOnly.start();await textOnly.select(new File([png],'a.png',{type:'image/png'}));assert.equal(textOnly.created.length,0);assert.equal(textOnly.get('attachments').disabled,true);
});

test('unknown media result retries the identical immutable envelope without changing caption, filename, voice or file bytes',async t=>{
 let attempts=0;const c=fixture(call=>{if(call.kind==='media'&&++attempts===1)throw Error('Lost receipt with private token');},{media:true});t.after(()=>c.widget.destroy());await c.start();
 const file=new File([png],'Original.png',{type:'image/png'});await c.select(file);c.get('text').value='Original caption';await c.get('composer').dispatch('submit');
 assert.equal(c.get('text').readOnly,true);assert.equal(c.get('remove-file').disabled,true);assert.equal(c.get('attachments').disabled,true);assert.equal(c.get('send').textContent,'Tentar novamente');
 c.get('text').value='Attempted mutation';await c.select(new File([Buffer.from('different')],'Changed.txt',{type:'text/plain'}));await c.get('composer').dispatch('submit');
 const sent=c.calls.filter(call=>call.kind==='media');assert.equal(sent.length,2);assert.equal(sent[0].options.body,sent[1].options.body);assert.deepEqual(sent[0].body,sent[1].body);assert.deepEqual(sent[1].fileBytes,png);assert.equal(sent[1].body.text,'Original caption');assert.equal(sent[1].body.name,'Original.png');assert.equal(c.get('selection').hidden,true);
});

test('media request deadline aborts once and preserves the same envelope for manual retry',async t=>{
 const started=deferred();let attempts=0;const c=fixture(call=>{if(call.kind==='media'&&++attempts===1){started.resolve();return new Promise((resolve,reject)=>call.options.signal.addEventListener('abort',()=>reject(Error('Synthetic timeout')),{once:true}));}},{media:true});t.after(()=>c.widget.destroy());await c.start();await c.select(new File([png],'Time.png',{type:'image/png'}));
 const send=c.get('composer').dispatch('submit');await started.promise;const deadline=[...c.timers].find(([,value])=>value.delay===180000);assert.ok(deadline);assert.equal([...c.timers.values()].some(value=>value.delay===10000),false);deadline[1].fn();await send;
 assert.equal(c.get('send').textContent,'Tentar novamente');assert.equal(c.get('selection').hidden,false);await c.get('composer').dispatch('submit');
 const sent=c.calls.filter(call=>call.kind==='media');assert.equal(sent[0].options.signal.aborted,true);assert.equal(sent[1].options.body,sent[0].options.body);assert.equal(sent.length,2);
});

test('closing aborts an in-flight upload and revokes preview while reopen retains the original unknown command',async t=>{
 const wait=deferred(),started=deferred();let attempts=0;const c=fixture(call=>{if(call.kind==='media'&&++attempts===1){started.resolve();return wait.promise;}},{media:true});t.after(()=>c.widget.destroy());await c.start();await c.select(new File([png],'Close.png',{type:'image/png'}));
 const send=c.get('composer').dispatch('submit');await started.promise;const original=c.calls.find(call=>call.kind==='media');c.widget.close();assert.equal(original.options.signal.aborted,true);assert.equal(c.revoked.includes(c.created[0].url),true);
 wait.resolve({ok:true,json:async()=>({messageId:'received-media-0001'})});await send;c.widget.open();await tick();assert.equal(c.get('selection').hidden,false);await c.get('composer').dispatch('submit');
 assert.equal(c.calls.filter(call=>call.kind==='media')[1].options.body,original.options.body);assert.equal(attempts,2);
});

test('expired/revoked media authority clears private files and object URLs without automatically restarting or sending',async t=>{
 const c=fixture(call=>call.kind==='media'?{ok:false,status:403}:null,{media:true});t.after(()=>c.widget.destroy());await c.start();await c.select(new File([png],'Secret.png',{type:'image/png'}));c.get('text').value='Caption';await c.get('composer').dispatch('submit');
 assert.equal(c.get('intro').hidden,false);assert.equal(c.get('composer').hidden,true);assert.equal(c.get('selection').hidden,true);assert.equal(c.created.every(entry=>c.revoked.includes(entry.url)),true);const before=c.calls.length;
 await c.get('composer').dispatch('submit');assert.equal(c.calls.length,before);assert.equal(c.get('text').value,'Caption');await c.get('intro').dispatch('submit');await tick();assert.equal(c.get('selection').hidden,true);assert.equal(c.calls.filter(call=>call.kind==='media').length,1);
});

test('a changed widget identity destroys private previews and refuses a late upload receipt',async t=>{
 const wait=deferred(),started=deferred();const c=fixture(call=>{if(call.kind==='media'){started.resolve();return wait.promise;}},{media:true});await c.start();await c.select(new File([png],'Private.png',{type:'image/png'}));const send=c.get('composer').dispatch('submit');await started.promise;
 c.widget.host.dataset.eloziWidget='different-company-channel';wait.resolve({ok:true,json:async()=>({messageId:'received-media-0001'})});await send;
 assert.equal(c.widget.host.isConnected,false);assert.equal(c.created.every(entry=>c.revoked.includes(entry.url)),true);assert.equal(c.timers.size,0);assert.equal(c.calls.filter(call=>call.kind==='media').length,1);
});

test('private inbound image/audio/video/document loads only linked IDs with POST token, compact players and no public URL',async t=>{
 for(const [index,kind,mime,bytes]of [[1,'image','image/png',png],[2,'audio','audio/ogg',Buffer.from('OggS synthetic')],[3,'video','video/mp4',Buffer.from('synthetic MP4')],[4,'document','application/pdf',Buffer.from('%PDF synthetic')]]){
  const file=attachment(index,{kind,mime,size:bytes.length,preview:kind!=='document'}),c=fixture(call=>{
   if(call.kind==='history')return {ok:true,json:async()=>({messages:[{id:'received-message-0001',kind:index%2?'human':'customer',text:'Anexo recebido',attachments:[file]}],hasMore:false,nextCursor:null})};
   if(call.kind==='media-download')return {ok:true,headers:{get:name=>name==='content-type'?mime:name==='content-length'?String(bytes.length):null},blob:async()=>new Blob([bytes],{type:mime})};
  },{media:true});t.after(()=>c.widget.destroy());await c.start();assert.equal(c.created.length,0);const original=card(c);await nodes(original,'button')[0].dispatch('click');
  const request=c.calls.find(call=>call.kind==='media-download');assert.equal(request.url.endsWith('/media/'+file.id),true);assert.deepEqual(request.body,{token:'b'.repeat(43)});assert.equal(request.options.credentials,'omit');assert.equal(request.options.referrerPolicy,'no-referrer');assert.equal(request.url.includes(request.body.token),false);
  assert.equal(c.created.length,1);assert.equal(c.get('history').children.length,1);assert.equal(nodes(original,kind==='image'?'img':kind).length,kind==='document'?0:1);await c.poll();assert.equal(card(c),original);assert.equal(c.calls.filter(call=>call.kind==='media-download').length,1);
  const save=nodes(original,'a')[0];assert.equal(save.textContent,'Salvar arquivo');assert.equal(save.hidden,false);assert.equal(save.href,c.created[0].url);assert.equal(save.download,file.name);assert.equal(c.downloaded.length,0);await save.click();assert.equal(c.downloaded.length,1);assert.equal(c.calls.filter(call=>call.kind==='media-download').length,1);
  if(kind==='document')assert.equal(c.created[0].blob.type,'application/octet-stream');c.widget.close();assert.equal(c.revoked.includes(c.created[0].url),true);assert.equal(save.href,'');assert.equal(save.download,'');assert.equal(save.isConnected,false);
 }
});

test('active content, oversized metadata and URL-bearing history never produce inline content or a remote request',async t=>{
 for(const [index,file]of [[1,attachment(1,{kind:'document',mime:'image/svg+xml',name:'<svg onload=bad>.svg',preview:true})],[2,attachment(2,{size:WEBCHAT_MEDIA_MAX_BYTES+1})],[3,attachment(3,{url:'https://arbitrary.example/secret'})]]){
  const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[{id:'received-message-0001',kind:'human',text:'Safe',attachments:[file]}],hasMore:false,nextCursor:null})}:call.kind==='media-download'?{ok:true,blob:async()=>new Blob([png])}:null,{media:true});t.after(()=>c.widget.destroy());await c.start();
  assert.equal(nodes(c.get('history'),'img').length,0);assert.equal(nodes(c.get('history'),'iframe').length,0);assert.equal(nodes(c.get('history'),'svg').length,0);
  if(index>1){assert.equal(c.created.length,0);assert.equal(c.calls.filter(call=>call.kind==='media-download').length,0);}else{await nodes(card(c),'button')[0].dispatch('click');assert.equal(c.created[0].blob.type,'application/octet-stream');assert.equal(c.downloaded.length,0);await nodes(card(c),'a')[0].click();assert.equal(c.downloaded.length,1);}
 }
});

test('private TXT waits for validated bytes then exposes a stable save link for a new click without another network request',async t=>{
 const bytes=Buffer.from('Texto sintético privado. '.repeat(3)),file=attachment(1,{kind:'document',name:'Arquivo privado.txt',mime:'text/plain',size:bytes.length,preview:false}),wait=deferred(),started=deferred();
 const c=fixture(call=>{if(call.kind==='history')return {ok:true,json:async()=>({messages:[{id:'received-message-0001',kind:'human',text:'Documento da equipe',attachments:[file]}],hasMore:false,nextCursor:null})};if(call.kind==='media-download'){started.resolve();return wait.promise;}},{media:true});t.after(()=>c.widget.destroy());await c.start();const original=card(c),load=nodes(original,'button')[0];assert.equal(load.textContent,'Carregar arquivo');
 const loading=load.dispatch('click');await started.promise;assert.equal(nodes(original,'a').length,0);assert.equal(c.downloaded.length,0);assert.equal(c.created.length,0);
 wait.resolve({ok:true,headers:{get:name=>name==='content-length'?String(bytes.length):name==='content-type'?'text/plain':null},body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})});await loading;
 const save=nodes(original,'a')[0];assert.ok(save);assert.equal(save.textContent,'Salvar arquivo');assert.equal(save.hidden,false);assert.equal(save.isConnected,true);assert.equal(save.rel,'noopener noreferrer');assert.equal(save.referrerPolicy,'no-referrer');assert.equal(save.href,c.created[0].url);assert.equal(save.href.includes('b'.repeat(43)),false);assert.equal(save.download,'Arquivo privado.txt');assert.equal(c.created[0].blob.type,'application/octet-stream');assert.deepEqual(Buffer.from(await c.created[0].blob.arrayBuffer()),bytes);assert.equal(c.downloaded.length,0);
 await c.poll();assert.equal(nodes(original,'a')[0],save);const before=c.calls.length;await save.click();assert.deepEqual(c.downloaded,[{href:save.href,name:file.name}]);await save.click();assert.equal(c.downloaded.length,2);assert.equal(c.calls.length,before);assert.equal(nodes(original,'a')[0],save);assert.equal(c.created.length,1);
});

test('a save link is revoked and a stale click is refused after closing, widget identity change or session expiry',async t=>{
 for(const action of ['close','context','expiry']){const file=attachment(1),c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[{id:'received-message-0001',kind:'human',text:'',attachments:[file]}],hasMore:false,nextCursor:null})}:call.kind==='media-download'?{ok:true,blob:async()=>new Blob([png])}:null,{media:true});t.after(()=>c.widget.destroy());await c.start();await nodes(card(c),'button')[0].dispatch('click');const save=nodes(card(c),'a')[0],url=save.href,before=c.calls.length;
  if(action==='close')c.widget.close();else if(action==='context')c.widget.host.dataset.eloziWidget='another-tenant-channel';
  const originalNow=Date.now;if(action==='expiry'){const futureNow=originalNow()+180000;Date.now=()=>futureNow;}
  let event;try{event=await save.click();}finally{Date.now=originalNow;}
  assert.equal(event.defaultPrevented,true);assert.equal(c.downloaded.length,0);assert.equal(c.calls.length,before);assert.equal(c.revoked.includes(url),true);assert.equal(save.href,'');assert.equal(save.download,'');assert.equal(save.isConnected,false);
  if(action==='context')assert.equal(c.widget.host.isConnected,false);if(action==='expiry')assert.equal(c.get('composer').hidden,true);
 }
});

test('close cancels private download and cannot create a late object URL; destroy revokes loaded players',async t=>{
 const wait=deferred(),started=deferred(),file=attachment(1),c=fixture(call=>{
  if(call.kind==='history')return {ok:true,json:async()=>({messages:[{id:'received-message-0001',kind:'human',text:'',attachments:[file]}],hasMore:false,nextCursor:null})};
  if(call.kind==='media-download'){started.resolve();return wait.promise;}
 },{media:true});await c.start();const download=nodes(card(c),'button')[0].dispatch('click');await started.promise;const request=c.calls.at(-1);c.widget.close();assert.equal(request.options.signal.aborted,true);
 wait.resolve({ok:true,blob:async()=>new Blob([png])});await download;assert.equal(c.created.length,0);c.widget.destroy();assert.equal(c.timers.size,0);
});

function microphone(c,{permission,chunk=new Blob(['OggS synthetic audio'],{type:'audio/ogg'})}={}){
 let requests=0,stopped=0;const recorders=[],stream={getTracks:()=>[{stop(){stopped++;}}]};
 c.view.navigator={mediaDevices:{getUserMedia:async()=>{requests++;return permission?await permission:stream;}}};
 c.view.MediaRecorder=class{static isTypeSupported(type){return type.startsWith('audio/ogg');}constructor(value,{mimeType}={}){this.stream=value;this.mimeType=mimeType||'audio/ogg';this.state='inactive';recorders.push(this);}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:chunk});this.onstop?.();}};
 return {recorders,stream,requests:()=>requests,stopped:()=>stopped};
}

test('English media keeps localized file review, numeric limits, previews, history fallback and download errors', async t => {
  const files = [attachment(1), { ...attachment(2), name: '', status: 'pending', preview: false }, { ...attachment(3), status: 'unavailable', preview: false }];
  let downloads = 0;
  const c = fixture(call => {
    if (call.kind === 'history') return { ok: true, json: async () => ({ messages: files.map((file, index) => ({ id: `localized-media-000${index}`, kind: 'human', text: '', attachments: [file] })), nextCursor: null, hasMore: false }) };
    if (call.kind === 'media-download') { if (++downloads === 1) throw Error('Mensagem externa privada em português'); return { ok: true, blob: async () => new Blob([png]) }; }
  }, { locale: 'en', media: true }); t.after(() => c.widget.destroy()); await c.start();
  assert.equal(c.get('capabilities').textContent, 'Text and one file per message, up to 16 MiB.');
  assert.equal(c.get('attachments').textContent, 'Attach file'); assert.equal(c.get('attachments').attributes.get('aria-label'), 'Attach a file up to 16 MiB');
  await c.select(new File([png], 'Photo.png', { type: 'image/png' }));
  assert.equal(c.get('text-limit').textContent, 'Optional caption · up to 1,024 characters');
  assert.match(c.get('selection').textContent, /Selected file/); assert.equal(nodes(c.get('selection'), 'img')[0].alt, 'Preview of Photo.png');
  assert.equal(c.get('remove-file').attributes.get('aria-label'), 'Remove selected file');
  c.get('text').value = 'x'.repeat(1025); await c.get('composer').dispatch('submit'); assert.equal(c.calls.filter(call => call.kind === 'media').length, 0);
  assert.equal(c.get('status').textContent, 'Check the caption: up to 1024 characters and an accepted file.');
  await c.get('remove-file').dispatch('click'); assert.equal(c.get('status').textContent, 'File removed. Your text is still in the field.');
  assert.equal(c.get('text').value.length, 1025); assert.equal(c.get('text-limit').textContent, 'Up to 4,000 characters · text');
  await c.select(new Blob(['plain file'])); assert.equal(nodes(c.get('selection'), 'strong')[0].textContent, 'File');
  await c.get('remove-file').dispatch('click');
  await c.select({ size: WEBCHAT_MEDIA_MAX_BYTES + 1, type: 'image/png', name: 'Oversize.png', slice() { throw Error('No byte read allowed'); } });
  assert.equal(c.get('status').textContent, 'Check the file: one per message, up to 16 MiB, in a format accepted by this connection.');
  c.get('file').files = [new File([png], 'one.png'), new File([png], 'two.png')]; await c.get('file').dispatch('change');
  assert.equal(c.get('status').textContent, 'Choose one file per message.');
  const cards = c.get('history').children.map(entry => entry.children.find(child => child.className === 'media-card'));
  assert.equal(nodes(cards[1], 'strong')[0].textContent, 'File'); assert.match(cards[1].textContent, /Preparing file…/); assert.match(cards[2].textContent, /File unavailable\./);
  assert.equal(nodes(cards[0], 'button')[0].textContent, 'Load photo'); await nodes(cards[0], 'button')[0].dispatch('click');
  assert.match(cards[0].textContent, /Unable to load this file\. Try again\./); assert.equal(cards[0].textContent.includes('Mensagem externa'), false);
  await nodes(cards[0], 'button')[0].dispatch('click');
  assert.equal(nodes(cards[0], 'img')[0].alt, `Preview of ${files[0].name}`);
  assert.equal(nodes(cards[0], 'a')[0].textContent, 'Save file'); assert.equal(nodes(cards[0], 'a')[0].attributes.get('aria-label'), `Save file: ${files[0].name}`);
});

test('English microphone localizes permission/status/errors and recording name without requesting permission or sending automatically', async t => {
  const permission = deferred(), c = fixture(null, { locale: 'en', media: true }); t.after(() => c.widget.destroy());
  const mic = microphone(c, { permission: permission.promise }); await c.start(); assert.equal(mic.requests(), 0);
  assert.equal(c.get('voice').textContent, 'Record audio'); assert.equal(c.get('voice-stop').textContent, 'Stop recording'); assert.equal(c.get('voice-cancel').textContent, 'Discard recording');
  await c.get('voice').dispatch('click'); assert.equal(c.get('voice-status').textContent, 'Waiting for microphone permission…');
  permission.resolve(mic.stream); await tick(); assert.match(c.get('voice-status').textContent, /Recording · 00:00 \/ 05:00/);
  await c.get('voice-stop').dispatch('click'); await tick(); assert.equal(mic.stopped(), 1);
  assert.equal(nodes(c.get('selection'), 'strong')[0].textContent, 'Audio.ogg'); assert.match(c.get('selection').textContent, /Recorded audio/);
  assert.equal(c.get('status').textContent, 'Audio ready. Review the recording before sending.'); assert.equal(c.calls.filter(call => call.kind === 'media').length, 0);
  await c.get('remove-file').dispatch('click'); await c.get('voice').dispatch('click'); await tick();
  mic.recorders.at(-1).ondataavailable({ data: { size: WEBCHAT_MEDIA_MAX_BYTES + 1 } });
  assert.equal(c.get('status').textContent, 'The recording exceeded 16 MiB. Record a shorter audio clip.');
  assert.equal(c.get('selection').hidden, true); assert.equal(c.calls.filter(call => call.kind === 'media').length, 0);
  c.view.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(Error('Private provider detail'), { name: 'NotAllowedError' }); };
  await c.get('voice').dispatch('click'); await tick(); assert.equal(c.get('status').textContent, 'Microphone access was denied. Allow microphone access to record.');
  c.view.navigator.mediaDevices.getUserMedia = async () => { throw Error('Private device detail'); };
  await c.get('voice').dispatch('click'); await tick(); assert.equal(c.get('status').textContent, 'Unable to access the microphone. Check that it is available.');
  assert.equal(c.get('status').textContent.includes('Private'), false);
});

test('microphone requires a click, stops tracks, lets the visitor review, and sends voice bytes only after explicit submit',async t=>{
 const c=fixture(null,{media:true});t.after(()=>c.widget.destroy());const mic=microphone(c);await c.start();assert.equal(mic.requests(),0);assert.equal(c.get('voice').disabled,false);
 await c.get('voice').dispatch('click');await tick();assert.equal(mic.requests(),1);assert.equal(c.get('voice-stop').hidden,false);assert.match(c.get('voice-status').textContent,/Gravando/);assert.equal(c.get('send').disabled,true);
 await c.get('voice-stop').dispatch('click');await tick();assert.equal(mic.stopped(),1);assert.equal(c.get('selection').hidden,false);assert.equal(nodes(c.get('selection'),'audio').length,1);assert.equal(c.calls.filter(call=>call.kind==='media').length,0);
 c.get('text').value='Voz com legenda';await c.get('composer').dispatch('submit');const sent=c.calls.find(call=>call.kind==='media');assert.equal(sent.body.voice,true);assert.equal(sent.body.mime,'audio/ogg');assert.equal(sent.body.text,'Voz com legenda');assert.equal(sent.fileBytes.toString(),'OggS synthetic audio');
});

test('cancelled/closed microphone permissions release a late stream without recording or keeping bytes',async t=>{
 for(const action of ['cancel','close']){const permission=deferred(),c=fixture(null,{media:true});t.after(()=>c.widget.destroy());const mic=microphone(c,{permission:permission.promise});await c.start();await c.get('voice').dispatch('click');await tick();assert.equal(mic.requests(),1);
  if(action==='cancel')await c.get('voice-cancel').dispatch('click');else c.widget.close();permission.resolve(mic.stream);await tick();assert.equal(mic.stopped(),1);assert.equal(mic.recorders.length,0);assert.equal(c.get('selection').hidden,true);assert.equal(c.created.length,0);
 }
});

test('voice recording enforces 5 minutes/16 MiB, discards on cancellation and never sends itself',async t=>{
 const c=fixture(null,{media:true});t.after(()=>c.widget.destroy());const mic=microphone(c);await c.start();await c.get('voice').dispatch('click');await tick();const limit=[...c.timers].find(([,value])=>value.delay===300000);assert.ok(limit);limit[1].fn();await tick();assert.equal(c.get('selection').hidden,false);assert.equal(mic.stopped(),1);assert.equal(c.calls.filter(call=>call.kind==='media').length,0);
 await c.get('remove-file').dispatch('click');await c.get('voice').dispatch('click');await tick();await c.get('voice-cancel').dispatch('click');assert.equal(c.get('selection').hidden,true);assert.equal(mic.stopped(),2);
 await c.get('voice').dispatch('click');await tick();mic.recorders.at(-1).ondataavailable({data:{size:WEBCHAT_MEDIA_MAX_BYTES+1}});assert.equal(c.get('selection').hidden,true);assert.match(c.get('status').textContent,/16 MiB/);assert.equal(c.calls.filter(call=>call.kind==='media').length,0);
});

test('RAM gateway receives the immutable visitor frame once after a lost receipt and returns both private media directions',async t=>{
 const store=new Store(':memory:'),auth=new Auth(store.db,{validateTenant:(actor,id)=>store.tenant(actor,id)});
 const row=auth.insertUser({username:'widget-media-operator',name:'Equipe sintética'},Buffer.alloc(16,1),Buffer.alloc(64,1),'reseller',[],'mep-demo'),admin=auth.actor(row);
 const tenant=store.createTenant(admin,{name:'Widget mídia RAM',segment:'QA'});store.mutate(admin,tenant.id,'Fixture: canal',state=>state.channels.push({id:'channel-test',kind:'webchat',name:'Site'}));
 const media=new MediaService(store,{directory:null,authKey:Buffer.alloc(32,3)}),gateway=new WebchatGateway(store,{operations:new Operations(store,auth),media}),origin='https://customer.example';
 gateway.configure(admin,tenant.id,'channel-test',{origins:[origin]});let lost=true;const receipts=[];
 const c=fixture(async call=>{let result;const scope={tenantId:tenant.id,channelId:'channel-test',origin};
  if(call.kind==='challenge')result={...gateway.publicAccess(tenant.id,'channel-test',origin),...gateway.challenge(scope)};
  if(call.kind==='session')result=gateway.openSession({...scope,...call.body});
  if(call.kind==='history')result=gateway.history({...scope,...call.body});
  if(call.kind==='media'){const token=call.options.headers.Authorization.slice(7),frame=Buffer.from(await call.options.body.arrayBuffer());result=await gateway.receiveMedia({...scope,token,...decodeWebchatMedia(frame)});receipts.push(result);if(lost){lost=false;throw Error('Synthetic response lost after media commit');}}
  if(call.kind==='media-download'){const {metadata,bytes}=await gateway.readMedia({...scope,...call.body,attachmentId:call.url.split('/').at(-1)});return {ok:true,headers:{get:name=>name==='content-type'?metadata.mime:name==='content-length'?String(bytes.length):null},body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})};}
  return {ok:true,json:async()=>result};
 });t.after(async()=>{c.widget.destroy();await gateway.close();store.close();});await c.start();await c.select(new File([png],'Original do visitante.png',{type:'image/png'}));c.get('text').value='Legenda original';
 await c.get('composer').dispatch('submit');const firstFrame=c.calls.find(call=>call.kind==='media').options.body;assert.equal(c.get('send').textContent,'Tentar novamente');assert.equal(c.get('text').value,'Legenda original');
 await c.get('composer').dispatch('submit');await tick();assert.equal(c.calls.filter(call=>call.kind==='media')[1].options.body,firstFrame);assert.equal(receipts[0].replayed,false);assert.equal(receipts[1].replayed,true);
 let conversation=store.tenant(admin,tenant.id).conversations[0];assert.equal(conversation.messages.length,1);assert.equal(conversation.messages[0].attachments[0].status,'ready');assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM media_attachments').get().total,1);assert.equal(c.get('history').children.length,1);
 await nodes(card(c),'button')[0].dispatch('click');assert.deepEqual(Buffer.from(await c.created.at(-1).blob.arrayBuffer()),png);
 store.mutate(admin,tenant.id,'Fixture: assumir',state=>{const item=state.conversations[0];item.owner='human';item.assignedUserId=admin.userId;item.version++;});conversation=store.tenant(admin,tenant.id).conversations[0];
 const context=gateway.assertReplySession(admin,tenant.id,conversation.id,{channelId:'channel-test',version:conversation.version}),uploaded=await media.upload(context,{bytes:png,name:'Resposta da equipe.png',mime:'image/png'});
 await gateway.send(admin,tenant.id,conversation.id,{channelId:'channel-test',version:conversation.version,text:'Foto da equipe',attachmentIds:[uploaded.id]});await c.poll();assert.equal(c.get('history').children.length,2);assert.match(c.get('history').textContent,/Foto da equipe/);
 const replyCard=c.get('history').children[1].children.find(node=>node.className==='media-card');assert.equal(nodes(replyCard,'img').length,0);await nodes(replyCard,'button')[0].dispatch('click');assert.deepEqual(Buffer.from(await c.created.at(-1).blob.arrayBuffer()),png);assert.equal(nodes(replyCard,'img').length,1);
 for(const call of c.calls){assert.equal(call.url.includes('token'),false);assert.equal(call.options.referrerPolicy,'no-referrer');}c.widget.destroy();assert.equal(c.created.every(entry=>c.revoked.includes(entry.url)),true);
});

test('history previews and the selected private file share a four-URL cache with eviction, paused players and complete cleanup',async t=>{
 const files=Array.from({length:6},(_,index)=>attachment(index+1)),messages=files.map((file,index)=>({id:`received-message-${String(index+1).padStart(4,'0')}`,kind:'human',text:'',attachments:[file]}));
 const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages,hasMore:false,nextCursor:null})}:call.kind==='media-download'?{ok:true,blob:async()=>new Blob([png])}:null,{media:true});t.after(()=>c.widget.destroy());await c.start();assert.equal(c.created.length,0);
 const cards=c.get('history').children.map(item=>item.children.find(node=>node.className==='media-card'));for(const item of cards.slice(0,4))await nodes(item,'button')[0].dispatch('click');const originalPlayer=nodes(cards[0],'img')[0],originalSave=nodes(cards[0],'a')[0],originalUrl=originalSave.href;
 assert.equal(c.created.length-c.revoked.length,4);await c.select(new File([png],'Local.png',{type:'image/png'}));assert.equal(c.created.length-c.revoked.length,4);assert.equal(originalPlayer.paused,true);assert.equal(originalPlayer.src,'');assert.equal(nodes(cards[0],'img').length,0);assert.equal(originalSave.href,'');assert.equal(originalSave.download,'');assert.equal(originalSave.isConnected,false);assert.equal(c.revoked.includes(originalUrl),true);const before=c.calls.length,event=await originalSave.click();assert.equal(event.defaultPrevented,true);assert.equal(c.downloaded.length,0);assert.equal(c.calls.length,before);
 for(const item of cards.slice(4)){await nodes(item,'button')[0].dispatch('click');assert.equal(c.created.length-c.revoked.length,4);}assert.equal(nodes(c.get('selection'),'img').length,1);
 c.widget.close();assert.equal(c.created.length,c.revoked.length);c.widget.open();await tick();assert.equal(c.created.length-c.revoked.length,1);assert.equal(c.calls.filter(call=>call.kind==='media-download').length,6);c.widget.destroy();assert.equal(c.created.length,c.revoked.length);
});

test('private downloads have a bounded media deadline and concurrency; timeout/close release every request without a late URL',async t=>{
 const waits=[deferred(),deferred()],starts=[deferred(),deferred()],files=[attachment(1),attachment(2),attachment(3)];let downloads=0;
 const c=fixture(call=>{if(call.kind==='history')return {ok:true,json:async()=>({messages:files.map((file,index)=>({id:`received-message-${String(index+1).padStart(4,'0')}`,kind:'human',text:'',attachments:[file]})),hasMore:false,nextCursor:null})};if(call.kind==='media-download'){const index=downloads++;starts[index].resolve();return index===0?new Promise((resolve,reject)=>call.options.signal.addEventListener('abort',()=>reject(Error('Synthetic media deadline')),{once:true})):waits[index].promise;}},{media:true});t.after(()=>c.widget.destroy());await c.start();
 const cards=c.get('history').children.map(item=>item.children.find(node=>node.className==='media-card')),first=nodes(cards[0],'button')[0].dispatch('click');await starts[0].promise;const second=nodes(cards[1],'button')[0].dispatch('click');await starts[1].promise;await nodes(cards[2],'button')[0].dispatch('click');assert.equal(downloads,2);assert.match(c.get('status').textContent,/Aguarde os arquivos/);
 const deadlines=[...c.timers].filter(([,value])=>value.delay===180000);assert.equal(deadlines.length,2);assert.equal([...c.timers.values()].some(value=>value.delay===10000),false);deadlines[0][1].fn();await first;assert.equal(c.created.length,0);assert.match(cards[0].textContent,/Não foi possível/);
 c.widget.close();waits[1].resolve({ok:true,blob:async()=>new Blob([png])});await second;assert.equal(c.created.length,0);assert.equal(c.timers.size,0);assert.equal(c.calls.filter(call=>call.kind==='media-download').every(call=>call.options.signal.aborted),true);
});

test('private media rejects mismatched headers/stream sizes before publishing a local URL and releases the reader',async t=>{
 for(const mode of ['declared-large','mime','overflow','truncated']){let cancelled=0;const file=attachment(1),c=fixture(call=>{
  if(call.kind==='history')return {ok:true,json:async()=>({messages:[{id:'received-message-0001',kind:'human',text:'',attachments:[file]}],hasMore:false,nextCursor:null})};
  if(call.kind==='media-download'){let count=0;return {ok:true,headers:{get:name=>name==='content-type'?(mode==='mime'?'text/html':'image/png'):name==='content-length'&&mode==='declared-large'?String(WEBCHAT_MEDIA_MAX_BYTES+1):null},body:{getReader(){return {async read(){return ++count===1?{done:false,value:mode==='overflow'?Buffer.concat([png,Buffer.from('extra')]):mode==='truncated'?png.subarray(0,2):png}:{done:true};},async cancel(){cancelled++;}};}}};}
 },{media:true});t.after(()=>c.widget.destroy());await c.start();await nodes(card(c),'button')[0].dispatch('click');assert.equal(c.created.length,0);assert.match(card(c).textContent,/Não foi possível/);assert.equal(c.calls.find(call=>call.kind==='media-download').options.signal.aborted,true);if(['overflow','truncated'].includes(mode))assert.equal(cancelled,1);
 }
});

test('without any reply 20 s after the visitor\'s last message the widget says it arrived, never stores it and hides it once someone answers',async t=>{
  const asked={id:'customer-wait-0001',kind:'customer',text:'Hi, how do I set up DKIM for a custom domain?',createdAt:new Date(Date.now()-30_000).toISOString()};
  let messages=[asked],assistant;
  const c=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages,hasMore:false,nextCursor:null,...(assistant?{assistant}:{})})}:null);
  t.after(()=>c.widget.destroy());await c.start();
  assert.equal(c.get('awaiting').hidden,false);assert.equal(c.get('awaiting').textContent,'Recebemos sua mensagem. Uma pessoa da equipe vai responder por aqui assim que possível.');
  assert.equal(c.allCalls.some(call=>JSON.stringify(call.body||{}).includes('Recebemos')),false,'the notice is local to the widget');
  assistant={state:'running',typing:true};messages=[];await c.poll();
  assert.equal(c.get('awaiting').hidden,true,'an assistant at work speaks for itself');
  assistant={state:'idle',typing:false};await c.poll();assert.equal(c.get('awaiting').hidden,false,'idle again: the visitor still waits');
  messages=[{id:'human-wait-reply-0001',kind:'human',text:'Olá! Vamos ajudar.',createdAt:new Date().toISOString()}];await c.poll();
  assert.equal(c.get('awaiting').hidden,true,'a reply from the team removes it');
  const fresh=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[{...asked,id:'customer-wait-0002',createdAt:new Date().toISOString()}],hasMore:false,nextCursor:null})}:null);
  t.after(()=>fresh.widget.destroy());await fresh.start();
  assert.equal(fresh.get('awaiting').hidden,true,'a message sent seconds ago still waits for an automatic reply');
  const custom=fixture(call=>call.kind==='history'?{ok:true,json:async()=>({messages:[asked],hasMore:false,nextCursor:null})}:null,{locale:'en',widget:{...channelWidget,awaitingMessage:{'pt-BR':'Respondemos em até 10 min.',en:'We reply within 10 min.'}}});
  t.after(()=>custom.widget.destroy());await custom.start();
  assert.equal(custom.get('awaiting').textContent,'We reply within 10 min.');
});

test('a site outside the channel origins gets a clear visitor notice, a disabled start and the exact origin for the site owner',async t=>{
  const denied={ok:false,status:403,json:async()=>({error:'Webchat indisponível para esta origem.',code:'webchat_origin_denied'})};
  const c=fixture(call=>['config','challenge'].includes(call.kind)?denied:null);t.after(()=>c.widget.destroy());
  const warnings=[];c.view.console={warn:(...args)=>warnings.push(args.join(' '))};c.view.location={origin:'https://outro.example'};
  c.widget.open();await tick();
  assert.equal(c.get('status').textContent,'Este chat ainda não foi liberado neste endereço. Avise a equipe do site.');assert.equal(c.get('start').disabled,true);
  assert.deepEqual(warnings,['Webchat: a origem https://outro.example não está autorizada no canal channel-test. Adicione-a às origens autorizadas do canal no painel.']);
  c.get('name').value='Visitante sintético';await c.get('intro').dispatch('submit');await tick();
  assert.equal(c.get('status').textContent,'Este chat ainda não foi liberado neste endereço. Avise a equipe do site.');assert.equal(warnings.length,1,'one console line per page');
  const generic=fixture(call=>call.kind==='challenge'?{ok:false,status:403,json:async()=>({error:'Webchat indisponível para esta origem.'})}:null);t.after(()=>generic.widget.destroy());
  await generic.start();assert.equal(generic.get('status').textContent,'Não foi possível abrir o atendimento. Tente novamente.','a refusal without the code keeps the generic message');
});

test('keys typed in the widget fields stay in the widget: host page shortcuts never see them',async t=>{
  const c=fixture();t.after(()=>c.widget.destroy());const root=c.widget.host.shadowRoot;
  for(const type of ['keydown','keypress','keyup']){
    const typed=await root.dispatch(type,{key:'?',target:{closest:selector=>selector.includes('textarea')?{}:null}});
    assert.equal(typed.stopped,true,type);
  }
  const other=await root.dispatch('keydown',{key:'?',target:{closest:()=>null}});
  assert.equal(other.stopped,undefined,'outside the widget fields the page keeps its keys');
});
