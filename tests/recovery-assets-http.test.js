import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createApp } from '../src/server.js';

const recoveryAssets=['inbox-route-filters.js','locales-agent-detail-recovery.js','locales-channel-recovery.js','locales-conversation-coverage.js','locales-guide-journey.js','locales-inbox-route-recovery.js','locales-knowledge-recovery.js','locales-palette-recovery.js','locales-send-recovery.js','send-unload-guard.js'];

test('actual panel server serves all recovery and route modules with exact source bytes',async t=>{
 const key=randomBytes(32),external=[];
 const denied=async(...args)=>{external.push(args);throw Error('External provider forbidden in static asset fixture');};
 const app=createApp({databasePath:':memory:',publicOrigin:'',serviceKey:key,providerCall:denied,
  gatewayOptions:{authKey:key,socketFactory:denied},telegramOptions:{authKey:key,polling:false,fetchImpl:denied},
  googleOptions:{clientId:''},emailOptions:{key,apiKey:'',from:'',fetchImpl:denied}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{
  await Promise.all(['gateway','telegram','telegramUser','email','bridge','emailChannel','meta'].map(name=>app[name]?.close?.()));
  app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();
 });
 const base=`http://127.0.0.1:${app.server.address().port}`;
 for(const file of recoveryAssets){
  const result=await new Promise((resolve,reject)=>{
   const req=request(base+'/'+file,res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],bytes:Buffer.concat(chunks)}));});
   req.setTimeout(3000,()=>req.destroy(Error('Static asset fixture timed out')));req.on('error',reject);req.end();
  });
  assert.equal(result.status,200,file+' must not 404 in the real server');
  assert.match(result.type,/javascript/,file);
  assert.deepEqual(result.bytes,readFileSync(new URL('../public/'+file,import.meta.url)),file+' served bytes must equal source');
 }
 assert.equal(external.length,0);
});
