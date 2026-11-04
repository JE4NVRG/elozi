import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair,SignJWT,exportJWK,createLocalJWKSet } from 'jose';
import {GoogleIdentity} from '../src/google-auth.js';
const clientId='fixture-client.apps.googleusercontent.com';
const pair=await generateKeyPair('RS256');const jwk=await exportJWK(pair.publicKey);jwk.kid='fixture';
async function credential(nonce,changes={},key=pair.privateKey){return new SignJWT({nonce,email:'owner@example.test',email_verified:true,name:'Pessoa QA',...changes}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(changes.iss||'https://accounts.google.com').setAudience(changes.aud||clientId).setSubject('synthetic-google-subject').setIssuedAt().setExpirationTime(changes.exp??'5m').sign(key);}
function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return {db,google:new GoogleIdentity(db,{clientId,jwks:createLocalJWKSet({keys:[jwk]})})};}
test('Google valida JWT assinado, nonce ligado à sessão e uso único',async t=>{
 const {db,google}=setup(t),c=google.issue(),jwt=await credential(c.nonce);const stored=db.prepare('SELECT * FROM google_challenges').get();
 assert.equal(JSON.stringify(stored).includes(c.token),false);assert.equal(JSON.stringify(stored).includes(c.nonce),false);
 const results=await Promise.allSettled([google.verify(jwt,c.token),google.verify(jwt,c.token)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='fulfilled').value.sub,'synthetic-google-subject');await assert.rejects(google.verify(jwt,c.token),e=>e.status===401);
});
test('Google rejeita audience, issuer, assinatura, nonce e e-mail não verificado',async t=>{
 const {google}=setup(t),c=google.issue();
 for(const changes of [{aud:'other-client'},{iss:'https://attacker.example'},{nonce:'wrong'},{email_verified:false},{exp:1}])await assert.rejects(google.verify(await credential(c.nonce,changes),c.token),e=>e.status===401);
 const other=await generateKeyPair('RS256');await assert.rejects(google.verify(await credential(c.nonce,{},other.privateKey),c.token),e=>e.status===401);
 const separate=google.issue();await assert.rejects(google.verify(await credential(c.nonce),separate.token),e=>e.status===401);
 const noExpiry=await new SignJWT({nonce:c.nonce,email:'owner@example.test',email_verified:true}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://accounts.google.com').setAudience(clientId).setSubject('synthetic').setIssuedAt().sign(pair.privateKey);await assert.rejects(google.verify(noExpiry,c.token),e=>e.status===401);
});
test('Google sem Client ID não cria desafios nem aceita credenciais',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const google=new GoogleIdentity(db);assert.deepEqual(google.issue(),{enabled:false});
 assert.throws(()=>google.configure('invalid-client'),e=>e.status===400);await assert.rejects(google.verify('token','cookie'),e=>e.status===503);
});
