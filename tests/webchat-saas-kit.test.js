import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signWebchatIdentity, createWebchatIdentityHandler } from '../public/webchat-identity-sdk.js';
import { createSaasWebchat } from '../public/widget-saas.js';
import { Store } from '../src/store.js';
import { WebchatIdentity } from '../src/webchat-identity.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const input = { issuer:'https://saas.example.test', channelId:'support-channel', key:{kid:'synthetic-key',secret:'s'.repeat(43)},
  accountId:'account-a', userId:'user-a', email:'qa@example.test', emailVerified:true, name:'Pessoa sintética', now:1_800_000_000_000 };
test('backend signer binds account and user with channel audience, bounded expiry and unique replay IDs', () => {
  const jwt=signWebchatIdentity({...input,context:{accountName:'Conta A',product:'SaaS',pagePath:'/help'}}),[header,body,signature]=jwt.split('.');
  const claims=JSON.parse(Buffer.from(body,'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'HS256',typ:'JWT',kid:input.key.kid});
  assert.equal(signature,createHmac('sha256',input.key.secret).update(`${header}.${body}`).digest('base64url'));
  assert.equal(claims.v,2);assert.equal(claims.accountId,'account-a');assert.equal(claims.sub,'user-a');assert.equal(claims.aud,'elozi:webchat:support-channel');
  assert.equal(claims.exp-claims.iat,600);assert.equal(claims.ctx.pagePath,'/help');assert.equal(claims.email_verified,true);
  assert.notEqual(JSON.parse(Buffer.from(signWebchatIdentity(input).split('.')[1],'base64url')).jti,claims.jti);
  assert.equal(jwt.includes(input.key.secret),false);
});
test('signer rejects unverified membership inputs, unbounded context and sensitive routes without echoing values', () => {
  for(const patch of [{accountId:''},{userId:''},{emailVerified:false},{ttlSeconds:601},{issuer:'https://saas.example.test/path'},
    {context:{accessToken:'private'}},{context:{pagePath:'/help?token=private'}},{context:{pagePath:'/oauth/callback'}},{context:{pagePath:'/a/../help'}},
    {context:{pagePath:'/'+'a'.repeat(510)+'?'}},{context:{accountName:'\n'}},{key:{kid:'bad/key',secret:'private'}}])assert.throws(()=>signWebchatIdentity({...input,...patch}),/identidade do suporte inválida/);
});
test('SDK tokens are accepted by the real backend and separate account/user identities without changing legacy history',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const admin={role:'reseller',resellerId:'mep-demo',userId:'synthetic-owner',name:'QA'},authority={reauthorize:()=>admin};
  const tenant=store.createTenant(admin,{name:'SDK QA',segment:'QA'});
  store.mutate(admin,tenant.id,'Fixture SDK',state=>{state.channels=[{id:input.channelId,kind:'webchat',transport:'elozi-webchat',state:'connected',webchat:{version:1,enabled:true,origins:[input.issuer]}}];});
  const identity=new WebchatIdentity(store,{secrets:encryptedChannelSecrets(store.db,Buffer.alloc(32,42)),now:()=>input.now,
    channelContext:()=>({tenant:store.tenant(admin,tenant.id),channel:store.tenant(admin,tenant.id).channels[0],origin:input.issuer})});
  identity.configure(admin,tenant.id,input.channelId,{version:0,enabled:true,issuer:input.issuer,externalIdPrefix:'saas',scope:'account-user'},authority);
  const key=identity.createKey(admin,tenant.id,input.channelId,{version:1},authority);
  const verify=patch=>identity.verifyAndConsume({tenantId:tenant.id,channelId:input.channelId,origin:input.issuer,identityToken:signWebchatIdentity({...input,key,...patch})});
  const a=verify({}),b=verify({accountId:'account-b'}),other=verify({userId:'user-b'});
  assert.equal(a.accountId,'account-a');assert.equal(a.subject,'user-a');assert.notEqual(a.externalId,b.externalId);assert.notEqual(a.externalId,other.externalId);
  assert.equal(verify({}).externalId,a.externalId);assert.equal(store.db.prepare('SELECT count(*) n FROM webchat_identity_jti').get().n,4);
});
test('generic backend endpoint verifies live membership and expected account/user, denies cross-origin and never caches tokens',async()=>{
  let resolved=0,current={...input};const handler=createWebchatIdentityHandler({...input,resolveIdentity:async()=>{resolved++;return current;}});
  const request=(query='accountId=account-a&userId=user-a',headers={},method='GET')=>new Request('https://saas.example.test/api/support/identity?'+query,{method,headers});
  const ok=await handler(request());assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'private, no-store');
  const body=await ok.json();assert.deepEqual(body.identity,{accountId:'account-a',userId:'user-a'});assert.equal(Object.hasOwn(body,'key'),false);
  assert.equal((await handler(request('',{},'POST'))).status,405);assert.equal((await handler(request('',{}))).status,400);
  const before=resolved;assert.equal((await handler(request(undefined,{'sec-fetch-site':'cross-site'}))).status,403);assert.equal((await handler(request(undefined,{origin:'https://other.example.test'}))).status,403);assert.equal(resolved,before);
  current={...input,accountId:'account-b'};assert.equal((await handler(request())).status,409);
  current={...input,emailVerified:false};assert.equal((await handler(request())).status,403);
  current=null;assert.equal((await handler(request())).status,401);
  const unavailable=createWebchatIdentityHandler({issuer:input.issuer,channelId:input.channelId,resolveIdentity:async()=>input});assert.equal((await unavailable(request())).status,503);
});
test('SaaS lifecycle destroys the prior account, cancels its late identity and removes support on logout', async () => {
  const mounts=[];let resolve;const pending=new Promise(done=>{resolve=done;});
  const widgetFactory=options=>{const entry={options,destroyed:0,opened:0,host:{},destroy(){this.destroyed++;},open(){this.opened++;},close(){}};mounts.push(entry);return entry;};
  const support=createSaasWebchat({identity:{accountId:'a',userId:'u'},widgetFactory,getIdentityToken:()=>pending});
  assert.equal(mounts[0].options.identityRequired,true);assert.deepEqual(mounts[0].options.expectedIdentity,{accountId:'a',userId:'u'});
  support.open();assert.equal(mounts[0].opened,1);const oldIdentity=mounts[0].options.getIdentityToken();
  support.setAccount({accountId:'b',userId:'u'});assert.equal(mounts[0].destroyed,1);resolve('old.header.signature');assert.equal(await oldIdentity,null);
  assert.equal(support.setAccount({accountId:'b',userId:'u'}),false);assert.equal(mounts.length,2);
  support.setAccount(null);assert.equal(mounts[1].destroyed,1);assert.equal(support.host,null);support.open();assert.equal(mounts[1].opened,0);
  support.destroy();assert.equal(support.setAccount({accountId:'a',userId:'u'}),false);
});
