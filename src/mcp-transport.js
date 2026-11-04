import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable, Transform } from 'node:stream';
import { fail } from './store.js';

export function publicAddress(address) {
  if (address.startsWith('::ffff:')) return publicAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return a>0 && a<224 && ![10,127].includes(a) && !(a===169&&b===254)
      && !(a===172&&b>=16&&b<=31) && !(a===192&&(b===168||b===0||b===2))
      && !(a===100&&b>=64&&b<=127) && !(a===198&&(b===18||b===19||b===51&&c===100))
      && !(a===203&&b===0&&c===113);
  }
  return isIP(address)===6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
}

export function mcpEndpoint(value, allowedOrigins=[], privateOrigins=[]) {
  if(typeof value!=='string')fail(400,'Informe a URL do servidor MCP.');
  let url; try { url=new URL(value); } catch { fail(400,'Informe a URL do servidor MCP.'); }
  const privateAllowed=privateOrigins.includes(url.origin);
  if (value.length>500 || url.username || url.password || url.search || url.hash
    || !allowedOrigins.includes(url.origin) || (url.protocol!=='https:' && !(url.protocol==='http:'&&privateAllowed)))
    fail(400,'Este endereço MCP precisa ser autorizado pela plataforma.');
  const literal=url.hostname.replace(/^\[|\]$/g,'');
  if (isIP(literal)&&!publicAddress(literal)&&!privateAllowed) fail(400,'Endereço MCP privado não autorizado.');
  return url;
}

/** DNS is resolved, checked and pinned for each request; no redirects or auth discovery. */
export function pinnedMcpFetch(endpoint,{privateOrigins=[],authorize=()=>{},signal,lookupImpl=lookup,maxBytes=256*1024,timeoutMs=10000}={}) {
  return async (input,init={}) => {
    const url=new URL(typeof input==='string'?input:input.href||input.url);
    if(url.href!==endpoint.href)fail(502,'O servidor MCP tentou mudar o endereço autorizado.');
    const method=init.method||'GET';
    // Server-initiated subscriptions are outside this pilot. POST response SSE is supported.
    if(method==='GET')return new Response(null,{status:405});
    if(!['POST','DELETE'].includes(method))fail(502,'Método MCP não autorizado.');
    const hostname=url.hostname.replace(/^\[|\]$/g,''),records=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookupImpl(hostname,{all:true,verbatim:true});
    if(!records.length||records.some(record=>!isIP(record.address)||!privateOrigins.includes(url.origin)&&!publicAddress(record.address)))
      fail(502,'Resolução de endereço MCP não autorizada.');
    const abort=AbortSignal.any([...(signal?[signal]:[]),...(init.signal?[init.signal]:[]),AbortSignal.timeout(timeoutMs)]);
    abort.throwIfAborted(); authorize(); // Fresh authority after asynchronous DNS, immediately before I/O.
    const headers=Object.fromEntries(new Headers(init.headers||{}));
    const body=init.body??null;
    if(body!==null && (typeof body!=='string'||Buffer.byteLength(body)>128*1024))fail(400,'Solicitação MCP excedeu o limite.');
    return await new Promise((resolve,reject)=>{
      const record=records[0],request=(url.protocol==='https:'?https:http).request(url,{
        method,headers,signal:abort,agent:false,
        lookup:(_host,options,done)=>options.all?done(null,[record]):done(null,record.address,record.family)
      },response=>{
        const status=response.statusCode||502;
        if(status<200||status>599||status>=300&&status<400||Number(response.headers['content-length'])>maxBytes){response.destroy();reject(new Error('MCP response rejected'));return;}
        const responseHeaders=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)responseHeaders.append(response.rawHeaders[i],response.rawHeaders[i+1]);
        const session=responseHeaders.get('mcp-session-id');
        if(session&&(session.length>256||!/^[\x21-\x7e]+$/.test(session))){response.destroy();reject(new Error('Invalid MCP session'));return;}
        // Request identity/session stay scoped to this short-lived client. No content logging.
        let bytes=0;
        const bounded=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;if(bytes>maxBytes)done(new Error('MCP response limit'));else done(null,chunk);}});
        bounded.on('error',()=>response.destroy());response.on('error',error=>bounded.destroy(error));
        bounded.on('close',()=>response.destroy());response.pipe(bounded);
        resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(bounded),{status,headers:responseHeaders}));
      });
      request.on('error',reject);if(body!==null)request.write(body);request.end();
    });
  };
}
