import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const foreignOrigin = 'https://product.example.test';
const publicModules = ['/channel-capabilities.js', '/i18n.js', '/locales-media.js', '/webchat-media.js', '/widget.js'];

async function fixture(t, { publicWidget = false } = {}) {
  const key = randomBytes(32), externalCalls = [];
  const denied = async () => { externalCalls.push(true); throw new Error('External transport forbidden in widget CORS fixture'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key,
    providerCall: denied, mcpFetchImpl: denied,
    gatewayOptions: { authKey: key, socketFactory: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denied },
    webchatOptions:{siteIcon:denied},emailChannelOptions: { fetchImpl: denied }, metaOptions: { fetchImpl: denied },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const changes = () => app.store.db.prepare('SELECT total_changes() AS count').get().count;
  let actor,tenant;
  if(publicWidget){const row=app.auth.insertUser({username:'widget-cors-operator',name:'QA'},Buffer.alloc(16,1),Buffer.alloc(64,1),'reseller',[],'mep-demo');actor=app.auth.actor(row);tenant=app.store.createTenant(actor,{name:'Public widget CORS QA',segment:'QA'});app.store.mutate(actor,tenant.id,'Fixture canal',state=>state.channels.push({id:'webchat-cors',kind:'webchat',name:'QA'}));app.webchat.configure(actor,tenant.id,'webchat-cors',{origins:[foreignOrigin]});app.webchat.widgetConfiguration(actor,tenant.id,'webchat-cors',{version:0,widget:{displayName:'QA Support',emailPrompt:true,feedbackEnabled:true,assistantInstructions:'PRIVATE-QA-INSTRUCTION',handoffNotificationEmail:'private-qa@example.test'}});}
  const initialChanges = changes();
  t.after(async () => {
    if(!publicWidget)assert.equal(changes(), initialChanges, 'static module reads must not mutate the RAM database');
    await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    assert.equal(externalCalls.length, 0, 'no external provider, bot or socket was contacted');
  });
  const request = (path, { method = 'GET', body, origin = foreignOrigin } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    pending.setTimeout(5000, () => pending.destroy(new Error('Loopback widget request exceeded fixture deadline')));
    pending.on('error', reject);
    pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { base, request,app,actor,tenant };
}

test('GET estrangeiro carrega o widget e todo o grafo ESM público com CORS e bytes exatos', async t => {
  const c = await fixture(t), visited = new Set(), queue = ['/widget.js'];
  while (queue.length) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const response = await c.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['access-control-allow-origin'], '*', `${path} must be readable by an anonymous cross-origin module import`);
    assert.equal(response.headers['access-control-allow-credentials'], undefined, path);
    assert.equal(response.headers['set-cookie'], undefined, path);
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8', path);
    assert.deepEqual(response.bytes, await readFile(new URL(`../public${path}`, import.meta.url)), 'only static public client code is served');
    const source = response.bytes.toString('utf8');
    const imports = [...new Set([
      ...[...source.matchAll(/\b(?:import|export)\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)].map(match => match[1]),
      ...[...source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)].map(match => match[1])
    ])];
    for (const specifier of imports) {
      assert.ok(specifier.startsWith('./'), 'the current widget graph contains local audited modules only');
      const dependency = new URL(specifier, c.base + path);
      assert.equal(dependency.origin, c.base);
      assert.ok(publicModules.includes(dependency.pathname), `audit new public dependency before serving it cross-origin: ${dependency.pathname}`);
      queue.push(dependency.pathname);
    }
  }
  assert.deepEqual([...visited].sort(), publicModules);
});

test('HEAD estrangeiro dos módulos públicos conserva MIME/CORS/tamanho do GET sem corpo', async t => {
  const c = await fixture(t);
  for (const path of publicModules) {
    const get = await c.request(path), head = await c.request(path, { method: 'HEAD' });
    assert.equal(get.status, 200, path);
    assert.equal(head.status, 200, path);
    assert.equal(head.headers['access-control-allow-origin'], '*', path);
    assert.equal(head.headers['access-control-allow-credentials'], undefined, path);
    assert.equal(head.headers['content-type'], get.headers['content-type'], path);
    assert.equal(Number(head.headers['content-length']), get.bytes.length, path);
    assert.equal(head.headers['content-length'], get.headers['content-length'], path);
    assert.equal(head.bytes.length, 0, path);
    assert.equal(head.headers['set-cookie'], undefined, path);
  }
});

test('outros assets e APIs humanas não ganham CORS nem suporte HEAD por associação ao widget', async t => {
  const c = await fixture(t);
  for (const path of ['/app.js', '/locales-operations.js', '/support-assistant-ui.js', '/login.js', '/styles.css', '/']) {
    const get = await c.request(path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers['access-control-allow-origin'], undefined, path);
    assert.equal(get.headers['access-control-allow-credentials'], undefined, path);
  }
  const privateHead = await c.request('/app.js', { method: 'HEAD' });
  assert.equal(privateHead.status, 404);
  assert.equal(privateHead.headers['access-control-allow-origin'], undefined);
  const bootstrap = await c.request('/api/bootstrap');
  assert.equal(bootstrap.status, 401);
  assert.equal(bootstrap.headers['access-control-allow-origin'], undefined);
  const missing = await c.request('/missing-widget-module.js');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['access-control-allow-origin'], undefined);
});

test('liberar código público não libera escrita por origem estrangeira ou preflight de APIs privadas', async t => {
  const c = await fixture(t);
  for (const method of ['POST', 'OPTIONS']) {
    const response = await c.request('/api/auth/login', { method, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 403, method);
    assert.equal(response.headers['access-control-allow-origin'], undefined, method);
  }
  const response = await c.request('/widget.js', { method: 'POST', body: {} });
  assert.equal(response.status, 403);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('rotas do widget conservam CORS no histórico e novas jornadas somente para a origem do canal',async t=>{
  const c=await fixture(t,{publicWidget:true}),path=`/api/public/webchat/${c.tenant.id}/webchat-cors`;
  const post=async(action,body)=>{const response=await c.request(`${path}/${action}`,{method:'POST',body});assert.equal(response.headers['access-control-allow-origin'],foreignOrigin,action);assert.equal(response.headers['access-control-allow-credentials'],undefined,action);assert.equal(response.headers['set-cookie'],undefined,action);return {...response,json:JSON.parse(response.bytes)};};
  for(const action of ['config','challenge','session','history','messages','contact','identity','feedback','logout']){const response=await c.request(`${path}/${action}`,{method:'OPTIONS'});assert.equal(response.status,204,action);assert.equal(response.headers['access-control-allow-origin'],foreignOrigin,action);assert.match(response.headers['access-control-allow-methods'],/POST/);}
  const config=await post('config',{});assert.equal(config.status,200);assert.equal(config.json.widget.displayName,'QA Support');assert.equal(config.bytes.includes(Buffer.from('PRIVATE-QA-INSTRUCTION')),false);assert.equal(config.bytes.includes(Buffer.from('private-qa@example.test')),false);assert.equal(c.app.store.tenant(c.actor,c.tenant.id).conversations.length,0);
  const challenge=await post('challenge',{}),session=await post('session',{challenge:challenge.json.challenge,name:'QA guest',locale:'en'}),token=session.json.token;assert.equal(session.status,200);assert.equal(c.app.store.tenant(c.actor,c.tenant.id).conversations.length,0);
  const before=await post('history',{token,limit:100});assert.equal(before.status,200);assert.deepEqual(before.json.messages,[]);
  const contact=await post('contact',{token,email:'guest@example.test'});assert.equal(contact.status,200);assert.equal(contact.json.contact.email,'guest@example.test');
  const message=await post('messages',{token,clientMessageId:'cors-client-message-0001',text:'Synthetic QA only'});assert.equal(message.status,200);const history=await post('history',{token,limit:100});assert.equal(history.status,200);assert.equal(history.json.messages.length,1);
  c.app.store.mutate(c.actor,c.tenant.id,'Fixture encerramento',state=>{state.conversations[0].status='closed';});const feedback=await post('feedback',{token,rating:'useful'});assert.equal(feedback.status,200);assert.equal(feedback.json.feedback.rating,'useful');
  const identity=await post('identity',{token,identityToken:'synthetic.invalid.jwt'});assert.equal(identity.status,403,'guest session cannot become another identity');
  const denied=await c.request(`${path}/history`,{method:'POST',body:{token},origin:'https://other.example.test'});assert.equal(denied.status,403);assert.equal(denied.headers['access-control-allow-origin'],undefined);assert.equal(denied.bytes.includes(Buffer.from('Synthetic QA only')),false);
  const logout=await post('logout',{token});assert.equal(logout.status,200);const expired=await post('history',{token});assert.equal(expired.status,403);
});
