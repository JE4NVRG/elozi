import test from 'node:test';import assert from 'node:assert/strict';import { createApp } from '../src/server.js';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
const { version: packageVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
test('real sessions, multi-company operator permissions and disabled demo access',async()=>{
 const app=createApp({databasePath:':memory:'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const request=async(path,{method='GET',body,cookie='',origin}={})=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{
  assert.equal((await request('/api/demo-session',{method:'POST',body:{role:'reseller'}})).status,404);
  assert.equal((await request('/api/bootstrap')).status,401);
  const health=await request('/api/health');assert.equal(health.status,200);assert.equal(health.data.version,packageVersion);
  const owner=await request('/api/auth/setup',{method:'POST',body:{name:'Synthetic owner',username:'owner-test',password:'Synthetic-owner-4567'}});assert.equal(owner.status,200);assert.ok(owner.cookie);assert.equal(owner.data.token,undefined);
  assert.equal((await request('/api/auth/setup',{method:'POST',body:{name:'Injected',username:'injected',password:'Synthetic-owner-4567'}})).status,409);
  const user=await request('/api/users',{cookie:owner.cookie,method:'POST',body:{username:'operator-test',password:'Synthetic-operator-4567',name:'Operator',role:'operator',tenantIds:['playtech-demo','studio-demo']}});assert.equal(user.status,201);
  const login=await request('/api/auth/login',{method:'POST',body:{username:'operator-test',password:'Synthetic-operator-4567'}});assert.equal(login.status,200);
  const boot=await request('/api/bootstrap',{cookie:login.cookie});assert.equal(boot.status,200);assert.equal(boot.data.version,health.data.version);assert.equal(boot.data.authentication,'local');assert.deepEqual(boot.data.tenants.map(t=>t.id).sort(),['playtech-demo','studio-demo']);
  assert.equal((await request('/api/tenants/loja-demo',{cookie:login.cookie})).status,403);
  assert.equal((await request('/api/users',{cookie:login.cookie})).status,403);
  assert.equal((await request('/api/tenants/studio-demo/flows',{cookie:login.cookie,method:'POST',body:{name:'Operator configuration'}})).status,403);
  assert.equal((await request('/api/users',{cookie:owner.cookie,method:'POST',origin:'https://foreign.example',body:{}})).status,403);
  assert.equal((await request(`/api/users/${user.data.id}/disable`,{cookie:owner.cookie,method:'POST',body:{}})).status,200);
  assert.equal((await request('/api/bootstrap',{cookie:login.cookie})).status,401);
  await request('/api/auth/logout',{cookie:owner.cookie,method:'POST',body:{}});assert.equal((await request('/api/bootstrap',{cookie:owner.cookie})).status,401);
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.bridge.close();app.store.close();}
});

const canonicalHost = 'elozi.je4ndev.com', canonicalOrigin = `https://${canonicalHost}`;
const googleClientId = 'referrer-fixture.apps.googleusercontent.com';
const googleHTMLPaths = ['/', '/login', '/accept-invite', '/reset-password', '/verify-email'];

test('imports locais de app, login e widget são servidos pelo runtime sem liberar fontes privadas', async t => {
 const {request}=await referrerFixture(t),publicRoot=new URL('../public/',import.meta.url),pending=['app.js','login.js','widget.js'],seen=new Set();
 while(pending.length){
  const path=pending.shift();if(seen.has(path))continue;seen.add(path);
  const source=await readFile(new URL(path,publicRoot),'utf8'),response=await request('/'+path);
  assert.equal(response.status,200,'Módulo público necessário: '+path);assert.match(response.headers['content-type'],/^text\/javascript\b/);assert.equal(response.body,source,'Fonte exata do módulo: '+path);
  for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+\.js)['"]/g)){
   const dependency=new URL(match[1],new URL(path,publicRoot));assert.ok(dependency.href.startsWith(publicRoot.href),'Imports do cliente devem permanecer em public/');pending.push(dependency.href.slice(publicRoot.href.length));
  }
 }
 assert.ok(seen.has('flow-departments-ui.js'),'Editor de fluxos faz parte da jornada servida');
 assert.equal((await request('/src/server.js')).status,404);assert.equal((await request('/api/bootstrap')).status,401);
});

async function referrerFixture(t, clientId = '') {
 const key = randomBytes(32), denyExternal = async () => assert.fail('Nenhum transporte externo pode ser usado no teste de headers.');
 let app;
 app = createApp({ databasePath: ':memory:', publicOrigin: canonicalOrigin, allowRegistration: false, serviceKey: key,
  googleOptions: { clientId, jwks: denyExternal }, providerCall: denyExternal, mcpFetchImpl: denyExternal,
  gatewayOptions: { authKey: key, socketFactory: denyExternal }, telegramOptions: { authKey: key, polling: false, fetchImpl: denyExternal },
  emailOptions: { apiKey: '', from: '', key, fetchImpl: denyExternal },
  domainOptions: { canonicalHost, resolver: {
   resolveTxt: async () => [[`elozi-verification=${app.accounts.accountRow('mep-demo').data.workspaceDomain.challenge}`]],
   resolveCname: async () => [canonicalHost]
  }, inspectDeployment: async host => ({host,httpsOrigin:`https://${host}`,tlsValid:true,proxyVerified:true,certificateExpiresAt:new Date(Date.now()+3600000).toISOString()}) }
 });
 await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
 t.after(async () => {
  app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  await Promise.all([app.email.close(),app.gateway.close(),app.telegram.close(),app.meta.close(),app.webchat.close(),app.bridge.close()]); app.store.close();
 });
 const request = (path, {host = canonicalHost, cookie = '', accept} = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({hostname:'127.0.0.1',port:app.server.address().port,path,headers:{Host:host,Cookie:cookie,...(accept === undefined ? {} : {Accept:accept})}},res => {
   const chunks=[];res.on('error',reject);res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.end();
 });
 return {app,request};
}

test('Google ativo permite somente origem no HTML canônico e mantém APIs, arquivos e mídia privados sem referrer', async t => {
 const f = await referrerFixture(t, googleClientId);
 for(const path of googleHTMLPaths){
  const response=await f.request(path+'?token=synthetic-sensitive-query',{accept:'application/json'});
  assert.equal(response.status,200,path);assert.match(response.headers['content-type'],/^text\/html/);
  assert.equal(response.headers['referrer-policy'],'strict-origin',path);
  assert.equal(response.headers['cross-origin-opener-policy'],'same-origin-allow-popups');
  assert.match(response.headers['content-security-policy'],/script-src 'self' https:\/\/accounts\.google\.com\/gsi\//);
  assert.doesNotMatch(response.body,/synthetic-sensitive-query/);
  assert.doesNotMatch(response.headers['content-security-policy'],/cloudflareinsights/,'private app/auth HTML does not inherit marketing analytics');
 }
 const marketing=await f.request('/');assert.equal(marketing.headers['referrer-policy'],'no-referrer');assert.match(marketing.body,/Seu cliente chamou/);
 for(const [path,status] of [['/api/health',200],['/api/auth/status',200],['/api/bootstrap',401],['/login.js',200],['/google-ui.js',200],['/login.css',200],['/mark.svg',200],['/widget.js',200],['/index.html',404]]){
  const response=await f.request(path);assert.equal(response.status,status,path);assert.equal(response.headers['referrer-policy'],'no-referrer',path);
 }
 const owner=await f.app.auth.setup({name:'Headers QA',username:'headers-owner',password:'Synthetic-Headers-4567'});
 const tenant=f.app.store.tenant(owner.actor,'playtech-demo'),conversation=tenant.conversations[0];
 const context={tenantId:tenant.id,conversationId:conversation.id,channelId:conversation.channelId};
 const attachment=await f.app.media.upload(context,{bytes:Buffer.from('Private RAM fixture'),mime:'text/plain',name:'private.txt'});
 f.app.store.mutate(owner.actor,tenant.id,'Mídia sintética somente em RAM',state=>f.app.store.getConversation(state,conversation.id).messages.push({id:'referrer-media-fixture',kind:'human',text:'',attachments:[attachment]}));
 const response=await f.request(`/api/tenants/${tenant.id}/conversations/${conversation.id}/attachments/${attachment.id}`,{cookie:`mep_session=${owner.token}`});
 assert.equal(response.status,200,response.body);assert.equal(response.headers['referrer-policy'],'no-referrer');assert.equal(response.headers['content-type'],'text/plain');assert.equal(response.body,'Private RAM fixture');
});

test('Google desativado conserva no-referrer em todas as páginas HTML e arquivos canônicos', async t => {
 const f=await referrerFixture(t);
 for(const path of [...googleHTMLPaths,'/api/auth/status','/login.js','/login.css']){
  const response=await f.request(path);assert.equal(response.status,200,path);assert.equal(response.headers['referrer-policy'],'no-referrer',path);
  assert.doesNotMatch(response.headers['content-security-policy'],/accounts\.google\.com/);
 }
 assert.equal(JSON.parse((await f.request('/api/auth/status')).body).google.enabled,false);
});

test('Domínio personalizado ativo conserva no-referrer e Google bloqueado mesmo com clientId global', async t => {
 const f=await referrerFixture(t,googleClientId),host='headers-custom.je4ndev.com';
 const owner=await f.app.auth.setup({name:'Headers domínio QA',username:'headers-domain-owner',password:'Synthetic-Headers-4567'});
 let state=f.app.domains.register(owner.actor,'mep-demo',{version:f.app.accounts.accountRow('mep-demo').version,host});
 state=await f.app.domains.verify(owner.actor,'mep-demo',{version:state.version});
 state=await f.app.domains.confirmDeployment(owner.actor,'mep-demo',{version:state.version});assert.equal(state.binding.active,true);
 for(const path of [...googleHTMLPaths,'/api/auth/status','/login.js','/login.css']){
  const response=await f.request(path,{host});assert.equal(response.status,200,path);assert.equal(response.headers['referrer-policy'],'no-referrer',path);
 }
 const status=JSON.parse((await f.request('/api/auth/status',{host})).body);assert.deepEqual(status.google,{enabled:false});assert.equal(status.registrationEnabled,false);
 assert.equal((await f.request('/login')).headers['referrer-policy'],'strict-origin');
});
