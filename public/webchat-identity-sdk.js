import { createHmac, randomUUID } from 'node:crypto';

const opaque = value => typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,160}$/.test(value);
const label = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && value === value.toWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => { throw new TypeError('Configuração ou identidade do suporte inválida.'); };
const path = value => typeof value === 'string' && value.length <= 512 && /^\/[A-Za-z0-9._~/-]*$/.test(value) && !value.includes('//')
  && !value.split('/').some(segment => segment === '.' || segment === '..')
  && !/(?:^|\/)(?:token|secret|password|passwd|senha|segredo|reset-password|verify-email|accept-invite|oauth|callback)(?:\/|$)/i.test(value);

/** Backend only (Node.js >=22). Save as webchat-identity.mjs; never load this file in a browser.
 * Derive account/user from the authenticated membership, never the request body. */
export function signWebchatIdentity({ issuer, channelId, key, accountId, userId, email, emailVerified, name, locale = 'pt-BR', context = {}, now = Date.now(), ttlSeconds = 600 } = {}) {
  let origin; try { origin = new URL(issuer); } catch { invalid(); }
  if (origin.origin !== issuer || origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))
    || !/^[A-Za-z0-9_-]{1,120}$/.test(channelId ?? '') || !opaque(accountId) || !opaque(userId)
    || !plain(key) || typeof key.secret !== 'string' || key.secret.length < 32 || !/^[A-Za-z0-9_-]{1,120}$/.test(key.kid ?? '')
    || !label(name, 120) || emailVerified !== true || typeof email !== 'string' || email.length > 254 || !/^[^\s@<>"\\]+@[^\s@<>"\\]+\.[^\s@<>"\\]+$/.test(email)
    || !['pt-BR', 'en'].includes(locale) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600 || !plain(context)) invalid();
  const allowed = ['accountName', 'product', 'pagePath', 'teamId', 'teamName', 'plan', 'mailboxes'];
  if (Object.keys(context).some(field => !allowed.includes(field))
    || ['accountName', 'teamName'].some(field => context[field] !== undefined && !label(context[field], 160))
    || ['product', 'plan'].some(field => context[field] !== undefined && !label(context[field], 80))
    || context.teamId !== undefined && !opaque(context.teamId)
    || context.pagePath !== undefined && !path(context.pagePath)
    || context.mailboxes !== undefined && (!Number.isSafeInteger(context.mailboxes) || context.mailboxes < 0 || context.mailboxes > 100_000)) invalid();
  const iat = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: key.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ v: 2, iss: issuer, aud: `elozi:webchat:${channelId}`, accountId, sub: userId,
    email, email_verified: true, name, locale, ctx: { ...context }, iat, exp: iat + ttlSeconds, jti: randomUUID() })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', key.secret).update(`${header}.${payload}`).digest('base64url')}`;
}

/** resolveIdentity verifies the live login and membership on the SaaS backend. */
export function createWebchatIdentityHandler({ issuer, channelId, key, resolveIdentity } = {}) {
  if(typeof resolveIdentity !== 'function') invalid();
  const response = (status, body) => Response.json(body, {status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
  return async request => {
    if(request.method!=='GET')return response(405,{error:'Método indisponível.'});
    const url=new URL(request.url),site=request.headers.get('sec-fetch-site'),origin=request.headers.get('origin');
    if(site&&site!=='same-origin'||origin&&origin!==url.origin)return response(403,{error:'Origem não autorizada.'});
    const expected={accountId:url.searchParams.get('accountId'),userId:url.searchParams.get('userId')};
    if(!opaque(expected.accountId)||!opaque(expected.userId))return response(400,{error:'Informe a conta e o usuário atuais.'});
    try{
      const identity=await resolveIdentity(request);
      if(!identity)return response(401,{error:'Entre novamente no SaaS.'});
      if(identity.emailVerified!==true)return response(403,{error:'Identidade não verificada.'});
      if(identity.accountId!==expected.accountId||identity.userId!==expected.userId)return response(409,{error:'A conta ou o usuário mudou.'});
      return response(200,{token:signWebchatIdentity({...identity,issuer,channelId,key}),identity:expected});
    }catch(error){return response([401,403,409].includes(error?.status)?error.status:503,{error:'Identidade indisponível.'});}
  };
}
