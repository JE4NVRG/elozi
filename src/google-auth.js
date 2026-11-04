import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
export class GoogleIdentity {
  constructor(db,{clientId='',jwks=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),now=Date.now}={}) {
    this.db=db;this.jwks=jwks;this.now=now;this.configure(clientId);
    db.exec('CREATE TABLE IF NOT EXISTS google_challenges (token_hash TEXT PRIMARY KEY,nonce_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER)');
  }
  validate(clientId) {
    if(typeof clientId!=='string'||(clientId&&!/^[A-Za-z0-9._-]{8,180}\.apps\.googleusercontent\.com$/.test(clientId)))fail(400,'Informe um Client ID web válido do Google.');
  }
  configure(clientId) {this.validate(clientId);this.clientId=clientId;}
  issue() {
    if(!this.clientId)return {enabled:false};
    const token=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM google_challenges WHERE expires_at<?').run(this.now());
    this.db.prepare('INSERT INTO google_challenges VALUES (?,?,?,NULL)').run(digest(token),digest(nonce),this.now()+300000);
    return {enabled:true,clientId:this.clientId,nonce,token};
  }
  async verify(credential,token) {
    if(!this.clientId)fail(503,'O login Google ainda precisa ser configurado.');
    if(typeof credential!=='string'||credential.length>16000||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))fail(401,'Reabra o login Google e tente novamente.');
    const row=this.db.prepare('SELECT * FROM google_challenges WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(digest(token),this.now());
    if(!row)fail(401,'Reabra o login Google e tente novamente.');
    let payload;
    try { ({payload}=await jwtVerify(credential,this.jwks,{audience:this.clientId,issuer:['https://accounts.google.com','accounts.google.com'],algorithms:['RS256'],requiredClaims:['exp','iat','sub','email','nonce'],currentDate:new Date(this.now()),clockTolerance:5})); }
    catch { fail(401,'O Google não confirmou este acesso.'); }
    if(typeof payload.nonce!=='string'||digest(payload.nonce)!==row.nonce_hash||payload.email_verified!==true||typeof payload.sub!=='string'||!payload.sub||typeof payload.email!=='string')fail(401,'O Google não confirmou este acesso.');
    const used=this.db.prepare('UPDATE google_challenges SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').run(this.now(),digest(token),this.now());
    if(used.changes!==1)fail(401,'Este acesso Google já foi utilizado. Reabra o login.');
    return {sub:payload.sub,email:payload.email,email_verified:true,name:typeof payload.name==='string'?payload.name.slice(0,80):payload.email.split('@')[0]};
  }
}
