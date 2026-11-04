import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {MediaService} from '../src/media.js';

const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic scoped capture')]);
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture(t,options={}){
 const store=new Store(':memory:'),actor={role:'reseller',resellerId:'mep-demo',name:'Synthetic capture owner'},tenant=store.createTenant(actor,{name:'Capture authority fixture',segment:'RAM'}),channelId=randomUUID(),conversationId=randomUUID();
 store.mutate(actor,tenant.id,'Synthetic channel',state=>{state.channels.push({id:channelId,kind:'messenger',transport:'meta-messenger'});state.conversations.push({id:conversationId,channelId,owner:'human',status:'open',version:1,messages:[]});});
 const media=new MediaService(store,{directory:null,authKey:randomBytes(32),...options}),context={tenantId:tenant.id,conversationId,channelId};t.after(()=>store.close());return {store,media,context};
}

test('download MIME and kind produce a real private preview without storing remote transport metadata',async t=>{
 const {media,context}=fixture(t),pending=media.placeholder(context,{kind:'image',mime:'application/octet-stream',name:'Incoming media'});
 const ready=await media.capture(pending.id,context,async()=>({bytes:png,metadata:{kind:'image',mime:'image/png',name:'Synthetic.png'}}));
 assert.equal(ready.status,'ready');assert.equal(ready.kind,'image');assert.equal(ready.mime,'image/png');assert.equal(ready.preview,true);assert.deepEqual((await media.read(ready.id,context)).bytes,png);assert.equal(media.activeCaptures,0);
});

test('revocation while CDN bytes are pending prevents persistence and inline publication',async t=>{
 const {media,context}=fixture(t),download=deferred(),started=deferred();let allowed=true;
 context.reauthorize=()=>allowed;
 const pending=media.placeholder(context,{kind:'image'}),result=media.capture(pending.id,context,()=>{started.resolve();return download.promise;});
 await started.promise;allowed=false;download.resolve({bytes:png,metadata:{kind:'image',mime:'image/png'}});
 assert.equal((await result).status,'unavailable');assert.equal(media.blobs.size,0);assert.equal(media.metadata(pending.id,{...context,reauthorize:undefined}).preview,false);await assert.rejects(media.read(pending.id,{...context,reauthorize:undefined}),e=>e.status===404);
});

test('revocation during private key loading cannot publish ready bytes',async t=>{
 const key=deferred(),started=deferred(),{media,context}=fixture(t,{authKey:undefined,keyLoader:()=>{started.resolve();return key.promise;}});let allowed=true;
 context.reauthorize=()=>allowed;
 const pending=media.placeholder(context,{kind:'image',mime:'image/png'}),result=media.capture(pending.id,context,async()=>png);
 await started.promise;allowed=false;key.resolve(randomBytes(32));
 assert.equal((await result).status,'unavailable');assert.equal(media.blobs.size,0);assert.equal(media.metadata(pending.id,{...context,reauthorize:undefined}).status,'unavailable');
});

test('upload revocation during stream reading leaves no index or bytes',async t=>{
 const {media,context,store}=fixture(t),body=deferred(),started=deferred();let allowed=true;
 context.reauthorize=()=>allowed;
 const stream={async *[Symbol.asyncIterator](){started.resolve();yield await body.promise;}};
 const upload=media.upload(context,{bytes:stream,kind:'image',mime:'image/png'});await started.promise;allowed=false;body.resolve(png);
 await assert.rejects(upload,e=>e.status===403);assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n,0);assert.equal(media.blobs.size,0);
});

test('async or invalid authority guards never start a download',async t=>{
 const {media,context}=fixture(t);let calls=0;
 const pending=media.placeholder(context,{kind:'image'});
 for(const reauthorize of ['bad',async()=>true])await assert.rejects(media.capture(pending.id,{...context,reauthorize},async()=>{calls++;return png;}),e=>e.status===500);
 assert.equal(calls,0);assert.equal(media.blobs.size,0);
});

test('transport URL, active MIME and mismatched file signature cannot become an inline image',async t=>{
 const {media,context}=fixture(t);
 for(const metadata of [{kind:'image',mime:'image/png',url:'https://cdn.example.test/private'},{kind:'image',mime:'image/png'}]){
  const pending=media.placeholder(context,{kind:'image'}),ready=await media.capture(pending.id,context,async()=>({bytes:Buffer.from('<html>not an image</html>'),metadata}));
  assert.equal(ready.status,'unavailable');assert.equal(ready.preview,false);
 }
 assert.equal(media.blobs.size,0);
});
