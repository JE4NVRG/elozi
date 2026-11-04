import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import {signDomainProbe} from '../src/domain-deployment.js';

const canonicalHost = 'elozi.je4ndev.com', origin = `https://${canonicalHost}`, customHost = 'revenda-teste.je4ndev.com', customOrigin = `https://${customHost}`, revision = 'd'.repeat(40);
const password = () => `Domains-QA-${randomBytes(12).toString('hex')}`;
const tokenFrom = value => new URLSearchParams(new URL(value).hash.slice(1)).get('token');

test('bootstrap de marca própria conserva a origem canônica dos conectores sem mudar a origem do painel',async t=>{
  const f=await fixture(t);await f.active();
  const login=await f.request('/api/auth/login',{method:'POST',host:customHost,requestOrigin:customOrigin,body:{username:f.customer.username,password:f.customer.password}});
  assert.equal(login.status,200,login.data.error);
  const boot=await f.request('/api/bootstrap',{host:customHost,cookie:login.cookie,headers:{'X-Forwarded-Host':'forged.example.test'}});
  assert.equal(boot.status,200,boot.data.error);
  assert.equal(boot.data.publicOrigin,customOrigin);
  assert.equal(boot.data.canonicalPublicOrigin,origin);
  assert.deepEqual(boot.data.workspaces.map(item=>item.id),[f.business.id]);
  const tenantId=boot.data.tenants[0].id;
  const created=await f.request(`/api/tenants/${tenantId}/channels`,{method:'POST',host:customHost,requestOrigin:customOrigin,cookie:login.cookie,body:{name:'Widget canônico QA',kind:'webchat'}});
  assert.equal(created.status,201,created.data.error);
  const channelId=created.data.id;
  const configured=await f.request(`/api/tenants/${tenantId}/channels/${channelId}/configuration`,{method:'POST',host:customHost,requestOrigin:customOrigin,cookie:login.cookie,body:{version:0,enabled:true,origins:[customOrigin]}});
  assert.equal(configured.status,200,configured.data.error);
  assert.equal(configured.data.install.scriptUrl,boot.data.canonicalPublicOrigin+'/widget.js');
  assert.equal(configured.data.install.embedSnippet,`<script type="module" src="${origin}/widget.js" data-tenant-id="${tenantId}" data-channel-id="${channelId}"></script>`);
  const fresh=await f.request(`/api/tenants/${tenantId}/channels/${channelId}/configuration`,{host:customHost,cookie:login.cookie});
  assert.equal(fresh.status,200,fresh.data.error);
  assert.deepEqual(fresh.data.install,configured.data.install);
  assert.deepEqual(fresh.data.origins,[customOrigin]);
  const canonical=await f.request('/api/bootstrap',{cookie:f.owner.cookie,headers:{'X-Forwarded-Host':customHost}});
  assert.equal(canonical.status,200,canonical.data.error);
  assert.equal(canonical.data.publicOrigin,origin);
  assert.equal(canonical.data.canonicalPublicOrigin,origin);
});

test('relógio de parede que volta não derruba o domínio recém-ativado; certificado vencido continua cortando o host',async t=>{
  // 06/10 Linux image: login accepted on the custom host, then the VM clock stepped back ~1.1 s and the bootstrap saw
  // the deployment proof just recorded as "from the future" (403 Host não autorizado). The step can also land between DNS and activation.
  for(const step of ['antes-da-ativacao','depois-do-login'])await t.test(step,async child=>{
    const f=await fixture(child);
    for(const action of ['register','verify','activate']){
      if(action==='activate'&&step==='antes-da-ativacao')f.shiftClock(-1100);
      const result=await f.mutate(action);assert.equal(result.status,200,result.data.error);
      if(action==='activate'){assert.equal(result.data.binding.state,'active');assert.equal(result.data.binding.active,true);assert.ok(result.data.binding.deployment.observedAt>=result.data.binding.verifiedAt);}
    }
    const login=await f.request('/api/auth/login',{method:'POST',host:customHost,requestOrigin:customOrigin,body:{username:f.customer.username,password:f.customer.password}});
    assert.equal(login.status,200,login.data.error);
    if(step==='depois-do-login')f.shiftClock(-1100);
    const boot=await f.request('/api/bootstrap',{host:customHost,cookie:login.cookie});
    assert.equal(boot.status,200,boot.data.error);assert.equal(boot.data.session.resellerId,f.business.id);
    f.shiftClock(7200000);
    assert.equal((await f.request('/api/bootstrap',{host:customHost,cookie:login.cookie})).status,403);
  });
});

test('rota pendente responde apenas prova assinada com nonce fresco e revisão real, sem abrir painel',async t=>{
  const f=await fixture(t),registered=await f.mutate('register');assert.equal(registered.status,200);
  const nonce=randomBytes(32).toString('hex'),proof=await f.request('/api/domain-check',{host:customHost,headers:{'x-elozi-domain-check':'1','x-elozi-domain-nonce':nonce}});
  assert.equal(proof.status,200);assert.equal(proof.headers['x-elozi-domain-check'],'1');assert.deepEqual(Object.keys(proof.data).sort(),['canonicalHost','host','nonce','signature','sourceRevision','workspaceId']);
  const expected={workspaceId:f.business.id,host:customHost,canonicalHost,sourceRevision:revision};assert.equal(proof.data.signature,signDomainProbe(expected,{nonce,challenge:registered.data.binding.challenge,version:registered.data.version},f.key));
  assert.notEqual(proof.data.signature,signDomainProbe(expected,{nonce,challenge:registered.data.binding.challenge,version:registered.data.version+1},f.key));
  for(const path of ['/login','/api/bootstrap','/api/auth/status'])assert.equal((await f.request(path,{host:customHost,cookie:f.owner.cookie})).status,403);
  assert.equal((await f.request('/api/domain-check',{host:customHost,headers:{'x-elozi-domain-check':'1'}})).status,403);
  const next=randomBytes(32).toString('hex'),second=await f.request('/api/domain-check',{host:customHost,headers:{'x-elozi-domain-check':'1','x-elozi-domain-nonce':next}});assert.equal(second.status,200);assert.notEqual(second.data.signature,proof.data.signature);assert.equal((await f.state()).binding.state,'pending');
  await f.mutate('disable');assert.equal((await f.request('/api/domain-check',{host:customHost,headers:{'x-elozi-domain-check':'1','x-elozi-domain-nonce':next}})).status,403);
});

async function fixture(t, options = {}) {
  const key = randomBytes(32), external = [], dnsCalls = [], inspections = [];
  const deny = async (...args) => { external.push(args.length); throw new Error('Transporte externo proibido neste ensaio em RAM'); };
  let app, dnsMatches = true, clock = Date.now();
  const resolver = {
    resolveTxt: async name => { dnsCalls.push(['TXT', name]); const row = app.store.db.prepare("SELECT json_extract(data,'$.workspaceDomain.challenge') AS challenge FROM resellers WHERE json_extract(data,'$.workspaceDomain.host')=?").get(name.replace(/^_elozi-verification\./, '')); return row && dnsMatches ? [[`elozi-verification=${row.challenge}`]] : []; },
    resolveCname: async name => { dnsCalls.push(['CNAME', name]); return dnsMatches ? [canonicalHost] : []; }
  };
  const inspectDeployment = async (host, context) => { inspections.push({ host, context }); return { host, httpsOrigin: `https://${host}`, tlsValid: true, proxyVerified: true, certificateExpiresAt: new Date(clock + 3600000).toISOString(), sourceRevision: revision }; };
  app = createApp({ databasePath: ':memory:', publicOrigin: origin, allowRegistration: false, releaseRevision: revision, serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny }, googleOptions: { clientId: '' },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: deny }, domainOptions: { canonicalHost, resolver, inspectDeployment }, ...options });
  // Domain proofs and host authorization read the commercial clock; the tests drive it instead of the wall clock,
  // which Docker Desktop's VM steps back about a second several times a minute.
  app.accounts.now = () => clock;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]); app.store.close(); assert.deepEqual(external, [], 'Nenhum provedor ou transporte real pode ser acionado.'); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', host = canonicalHost, requestOrigin, cookie = '', workspace, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = httpRequest(base + path, { method, headers: { Host: host, 'Content-Type': 'application/json', Cookie: cookie, ...(serialized === undefined ? {} : { 'Content-Length': Buffer.byteLength(serialized) }), ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(workspace ? { 'X-Elozi-Workspace': workspace } : {}), ...headers } }, response => {
      const chunks = []; response.on('error', reject); response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        try { const text = Buffer.concat(chunks).toString(), setCookie = (response.headers['set-cookie'] || []).join(', '); resolve({ status: response.statusCode, data: response.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text, headers: response.headers, setCookie, cookie: setCookie.split(';')[0] }); } catch (failure) { reject(failure); }
      });
    }); outgoing.on('error', reject); outgoing.end(serialized);
  });
  const ownerPassword = password(), owner = await request('/api/auth/setup', { method: 'POST', host: `127.0.0.1:${app.server.address().port}`, body: { name: 'Owner domínio QA', username: 'domain.owner', password: ownerPassword } }); assert.equal(owner.status, 200, owner.data.error);
  async function createAccount(label = 'Empresa domínio QA') {
    const result = await request('/api/accounts', { method: 'POST', cookie: owner.cookie, requestOrigin: origin, body: { requestId: randomUUID(), name: label, accountKind: 'business', parentWorkspaceId: 'mep-demo', initialTenantName: 'Matriz QA', segment: 'QA' } }); assert.equal(result.status, 201, result.data.error); return result.data.account;
  }
  async function invite(account) {
    const result = await request(`/api/accounts/${account.id}/invitations`, { method: 'POST', cookie: owner.cookie, requestOrigin: origin, body: { requestId: randomUUID(), name: 'Admin domínio QA', sendEmail: false } }); assert.equal(result.status, 201, result.data.error); return result;
  }
  async function accept(invitation, username = 'domain.' + randomBytes(6).toString('hex'), args = {}) {
    const secret = password(), result = await request('/api/auth/invitations/accept', { method: 'POST', requestOrigin: origin, body: { token: tokenFrom(invitation.data.inviteUrl), name: 'Admin convidado QA', username, password: secret }, ...args }); assert.equal(result.status, 200, result.data.error); return { ...result, username, password: secret };
  }
  const business = await createAccount(), customer = await accept(await invite(business));
  const domainPath = `/api/accounts/${business.id}/domain`;
  async function state() { const result = await request(domainPath, { cookie: owner.cookie }); assert.equal(result.status, 200, result.data.error); return result.data; }
  async function mutate(action, who = owner, extra = {}) {
    const current = await state(); return request(domainPath + (action === 'register' || action === 'remove' ? '' : '/' + action), { method: action === 'remove' ? 'DELETE' : 'POST', cookie: who.cookie, requestOrigin: origin, body: { version: current.version, ...(action === 'register' ? { host: customHost } : {}), ...extra } });
  }
  async function active() { for (const action of ['register', 'verify', 'activate']) { const result = await mutate(action); assert.equal(result.status, 200, result.data.error); } return state(); }
  const protectedRows = () => ({ tenants: app.store.db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all(), users: app.store.db.prepare('SELECT id,reseller_id,role,tenant_ids,permissions,scope_rules FROM auth_users ORDER BY id').all(), outbox: app.store.db.prepare('SELECT id FROM outbound_commands ORDER BY id').all() });
  return { key,app, request, owner, ownerPassword, customer, business, domainPath, createAccount, invite, accept, state, mutate, active, dnsCalls, inspections, protectedRows, setDNS: value => { dnsMatches = value; }, shiftClock: ms => { clock += ms; } };
}

test('HTTP host canônico conserva acesso; desconhecido e vínculo pendente recusam todo acesso público', async t => {
  const f = await fixture(t), before = f.protectedRows();
  assert.equal((await f.request('/api/health')).status, 200); assert.equal((await f.request('/api/auth/status')).data.registrationEnabled, false);
  assert.equal((await f.request('/api/health', { host: 'nao-vinculado.je4ndev.com', headers: { 'X-Forwarded-Host': canonicalHost } })).status, 403);
  const registered = await f.mutate('register'); assert.equal(registered.status, 200); assert.equal(registered.data.binding.state, 'pending'); assert.equal(registered.data.binding.active, false);
  for (const path of ['/api/health', '/api/auth/status', '/login', '/api/bootstrap', '/api/domain-check']) assert.equal((await f.request(path, { host: customHost, cookie: f.customer.cookie, headers: { 'X-Elozi-Domain-Check': '1' } })).status, 403, path);
  assert.deepEqual(f.protectedRows(), before); assert.equal(f.inspections.length, 0);
});

test('HTTP domínio verificado permite somente probe explícito mínimo com SHA servido; não entrega aplicação', async t => {
  const f = await fixture(t); assert.equal((await f.mutate('register')).status, 200); const verified = await f.mutate('verify'); assert.equal(verified.status, 200); assert.equal(verified.data.binding.state, 'verified'); assert.equal(verified.data.binding.active, false);
  const proof = await f.request('/api/domain-check', { host: customHost, headers: { 'X-Elozi-Domain-Check': '1' } });
  assert.equal(proof.status, 200); assert.equal(proof.headers['x-elozi-domain-check'], '1'); assert.deepEqual(proof.data, { workspaceId: f.business.id, host: customHost, canonicalHost, sourceRevision: revision }); assert.equal(proof.headers['cache-control'], 'no-store');
  for (const headers of [{}, { 'X-Elozi-Domain-Check': 'true' }, { 'X-Elozi-Domain-Check': '01' }]) { const denied = await f.request('/api/domain-check', { host: customHost, headers }); assert.equal(denied.status, 403); assert.equal(denied.headers['x-elozi-domain-check'], undefined); }
  for (const path of ['/api/auth/status', '/api/bootstrap', '/login', '/']) assert.equal((await f.request(path, { host: customHost, cookie: f.customer.cookie, headers: { 'X-Elozi-Domain-Check': '1' } })).status, 403, path);
  const wrong = await f.request('/api/domain-check', { host: 'outro.je4ndev.com', headers: { 'X-Elozi-Domain-Check': '1' } }); assert.equal(wrong.status, 403); assert.equal(wrong.headers['x-elozi-domain-check'], undefined);
  const canonical = await f.request('/api/domain-check', { headers: { 'X-Elozi-Domain-Check': '1' } }); assert.notEqual(canonical.status, 200); assert.equal(canonical.headers['x-elozi-domain-check'], undefined); assert.equal(f.inspections.length, 0);
});

test('HTTP ativo usa branding, cookie Secure e bootstrap/workspace limitados ao vínculo sem herdar acesso principal', async t => {
  const f = await fixture(t), before = f.protectedRows(); await f.active();
  const accountData = JSON.parse(f.app.store.db.prepare('SELECT data FROM resellers WHERE id=?').get(f.business.id).data); accountData.brand = { name: 'Marca QA', initials: 'QA', accent: '#123456', credential: 'synthetic-private-brand' }; f.app.store.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(accountData), f.business.id);
  const status = await f.request('/api/auth/status', { host: customHost }); assert.equal(status.status, 200); assert.equal(status.data.productName, 'Marca QA'); assert.equal(status.data.registrationEnabled, false); assert.deepEqual(status.data.google, { enabled: false }); assert.equal(JSON.stringify(status.data).includes('synthetic-private-brand'), false);
  const login = await f.request('/api/auth/login', { host: customHost, requestOrigin: customOrigin, method: 'POST', body: { username: f.customer.username, password: f.customer.password } }); assert.equal(login.status, 200, login.data.error); assert.match(login.setCookie, /HttpOnly; SameSite=Strict; Path=\//); assert.match(login.setCookie, /; Secure/);
  const boot = await f.request('/api/bootstrap', { host: customHost, cookie: login.cookie }); assert.equal(boot.status, 200, boot.data.error); assert.equal(boot.data.session.resellerId, f.business.id); assert.equal(boot.data.publicOrigin, customOrigin); assert.deepEqual(boot.data.workspaces.map(item => item.id), [f.business.id]); assert.ok(boot.data.tenants.every(item => item.resellerId === undefined || item.resellerId === f.business.id));
  const list = await f.request('/api/workspaces', { host: customHost, cookie: login.cookie }); assert.equal(list.status, 200); assert.deepEqual(list.data.workspaces.map(item => item.id), [f.business.id]); assert.equal(list.data.currentResellerId, f.business.id);
  assert.equal((await f.request('/api/bootstrap', { host: customHost, cookie: f.owner.cookie })).status, 403); assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM auth_workspace_access').get().n, 0);
  const rootLogin = await f.request('/api/auth/login', { host: customHost, requestOrigin: customOrigin, method: 'POST', body: { username: 'domain.owner', password: f.ownerPassword } }); assert.equal(rootLogin.status, 403); assert.equal(rootLogin.setCookie, '');
  assert.deepEqual(f.protectedRows(), before); assert.equal(f.inspections.length, 1);
});

test('HTTP custom host recusa login de outro cliente e headers workspace forjados mesmo com grants explícitos', async t => {
  const f = await fixture(t), other = await f.createAccount('Outra empresa QA'), second = await f.accept(await f.invite(other)); await f.active();
  const count = () => f.app.store.db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get().n, before = count();
  const denied = await f.request('/api/auth/login', { method: 'POST', host: customHost, requestOrigin: customOrigin, body: { username: second.username, password: second.password } }); assert.equal(denied.status, 403); assert.equal(denied.cookie, ''); assert.equal(count(), before);
  for (const account of [f.business, other]) { const current = await f.request(`/api/accounts/${account.id}`, { cookie: f.owner.cookie }); const granted = await f.request(`/api/accounts/${account.id}/platform-access`, { method: 'POST', cookie: f.owner.cookie, requestOrigin: origin, body: { version: current.data.account.version } }); assert.equal(granted.status, 200, granted.data.error); }
  const ownerBoot = await f.request('/api/bootstrap', { host: customHost, cookie: f.owner.cookie });
  let bootFailure;
  if (ownerBoot.status !== 200) {
    const ownerId = f.owner.data.session.userId, binding = f.app.accounts.accountRow(f.business.id).data.workspaceDomain;
    bootFailure = JSON.stringify({ error: ownerBoot.data.error, now: f.app.domains.instant(),
      domain: { state: binding.state, verifiedAt: binding.verifiedAt, observedAt: binding.deployment?.observedAt, certificateExpiresAt: binding.deployment?.certificateExpiresAt, resolved: Boolean(f.app.domains.resolve(customHost)) },
      owner: f.app.store.db.prepare('SELECT platform_admin,disabled_at FROM auth_users WHERE id=?').get(ownerId),
      grants: [f.business, other].map(account => Boolean(f.app.store.db.prepare('SELECT 1 FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(ownerId, account.id))) });
  }
  assert.equal(ownerBoot.status, 200, bootFailure); assert.deepEqual(ownerBoot.data.workspaces.map(item => item.id), [f.business.id]);
  assert.equal((await f.request('/api/workspaces', { host: customHost, cookie: f.owner.cookie, workspace: other.id })).status, 403);
  assert.equal((await f.request('/api/bootstrap', { host: customHost, cookie: f.customer.cookie, workspace: 'mep-demo' })).status, 403);
  const canonical = await f.request('/api/workspaces', { cookie: f.owner.cookie }); assert.equal(canonical.status, 200); assert.ok(canonical.data.workspaces.some(item => item.id === other.id));
});

test('HTTP convite aceita somente alvo do hostname; cadastro/Google/setup continuam fechados no custom', async t => {
  const f = await fixture(t), other = await f.createAccount('Empresa convite QA'), matching = await f.invite(f.business), foreign = await f.invite(other); await f.active();
  const before = f.app.store.db.prepare('SELECT count(*) AS n FROM auth_users').get().n;
  const preview = await f.request('/api/auth/invitations/preview', { host: customHost, requestOrigin: customOrigin, method: 'POST', body: { token: tokenFrom(matching.data.inviteUrl) } }); assert.equal(preview.status, 200); assert.equal(preview.data.workspace.id, f.business.id);
  for (const path of ['/api/auth/invitations/preview', '/api/auth/invitations/accept']) { const denied = await f.request(path, { host: customHost, requestOrigin: customOrigin, method: 'POST', body: { token: tokenFrom(foreign.data.inviteUrl), name: 'Invadido QA', username: 'wrong.domain', password: password() } }); assert.equal(denied.status, 403); }
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM auth_users').get().n, before);
  for (const [path, status] of [['/api/auth/register', 403], ['/api/auth/setup', 403], ['/api/auth/google', 409]]) assert.equal((await f.request(path, { host: customHost, requestOrigin: customOrigin, method: 'POST', body: { name: 'Registro bloqueado QA', email: 'domain-qa@example.test', company: 'QA', password: password(), credential: 'synthetic-credential' } })).status, status);
  const accepted = await f.accept(matching, 'matching.domain', { host: customHost, requestOrigin: customOrigin }); assert.match(accepted.setCookie, /; Secure/); assert.equal((await f.request('/api/bootstrap', { host: customHost, cookie: accepted.cookie })).data.session.resellerId, f.business.id);
  assert.equal((await f.request('/api/auth/register', { requestOrigin: origin, method: 'POST', body: {} })).status, 403);
});

test('HTTP guard CSRF exige Origin HTTPS do custom host e recusa origem canônica/foreign/cross-site', async t => {
  const f = await fixture(t); await f.active();
  const before = f.protectedRows(), state = await f.state();
  for (const requestOrigin of [origin, 'http://' + customHost, 'https://foreign.je4ndev.com', customOrigin + ':443', customOrigin + '/']) assert.equal((await f.request(f.domainPath + '/disable', { host: customHost, requestOrigin, cookie: f.customer.cookie, method: 'POST', body: { version: state.version } })).status, 403);
  assert.equal((await f.request(f.domainPath + '/disable', { host: customHost, requestOrigin: customOrigin, cookie: f.customer.cookie, method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { version: state.version } })).status, 403); assert.equal((await f.state()).version, state.version); assert.deepEqual(f.protectedRows(), before);
  const accepted = await f.request(f.domainPath + '/disable', { host: customHost, requestOrigin: customOrigin, cookie: f.customer.cookie, method: 'POST', body: { version: state.version } }); assert.equal(accepted.status, 200, accepted.data.error); assert.equal(accepted.data.binding.state, 'disabled'); assert.equal((await f.request('/api/health', { host: customHost })).status, 403); assert.deepEqual(f.protectedRows(), before);
});

test('HTTP perda de DNS, certificado expirado, desativação e remoção cortam host público mas conservam dados', async t => {
  for (const operation of ['dns', 'certificate', 'disable', 'remove']) await t.test(operation, async child => {
    const f = await fixture(child), before = f.protectedRows(); await f.active();
    if (operation === 'dns') { f.setDNS(false); const result = await f.mutate('verify'); assert.equal(result.status, 200); assert.equal(result.data.binding.state, 'pending'); }
    else if (operation === 'certificate') { const row = f.app.store.db.prepare('SELECT data FROM resellers WHERE id=?').get(f.business.id), data = JSON.parse(row.data); data.workspaceDomain.deployment.certificateExpiresAt = '2000-01-01T00:00:00.000Z'; f.app.store.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), f.business.id); }
    else assert.equal((await f.mutate(operation)).status, 200);
    assert.equal((await f.request('/api/health', { host: customHost })).status, 403); assert.deepEqual(f.protectedRows(), before);
    const probe = await f.request('/api/domain-check', { host: customHost, headers: { 'X-Elozi-Domain-Check': '1' } }); assert.equal(probe.status, operation === 'certificate' ? 200 : 403); if (operation !== 'certificate') assert.equal(probe.headers['x-elozi-domain-check'], undefined);
  });
});

test('HTTP sem SHA40 válido não emite prova de revisão nem header de confiança para domínio verificado', async t => {
  const f = await fixture(t, { releaseRevision: '' }); assert.equal((await f.mutate('register')).status, 200); assert.equal((await f.mutate('verify')).status, 200);
  const result = await f.request('/api/domain-check', { host: customHost, headers: { 'X-Elozi-Domain-Check': '1' } }); assert.equal(result.status, 403); assert.equal(result.headers['x-elozi-domain-check'], undefined); assert.equal(result.data.sourceRevision, undefined);
});

test('HTTP descoberta e prévia de suporte no HostA preservam grantA antes da seleção e nunca revelam metadataB', async t => {
  const f = await fixture(t), other = await f.createAccount('Metadata exclusiva cliente B QA'), second = await f.accept(await f.invite(other));
  async function grant(account, administrator, label) {
    const boot = await f.request('/api/bootstrap', { cookie: administrator.cookie }); assert.equal(boot.status, 200, boot.data.error);
    const tenantId = boot.data.tenants[0].id, channelId = `qa-support-${label}`;
    f.app.store.mutate({ userId: administrator.data.user.id, resellerId: account.id, role: 'reseller', name: boot.data.session.name }, tenantId, 'Canal sintético do escopo de suporte', state => { state.channels = [{ id: channelId, name: 'Canal planejado QA', kind: 'telegram', state: 'planned' }]; });
    const result = await f.request('/api/support/grants', { method: 'POST', cookie: administrator.cookie, requestOrigin: origin, body: {
      requestId: randomUUID(), supportUserId: f.owner.data.session.userId, tenantIds: [tenantId], permissions: ['inbox.read'], scopeRules: { [tenantId]: { channelIds: [channelId], departmentIds: ['unassigned'] } }, reason: `Motivo privado suporte ${label} QA`, ticket: `Ticket privado ${label} QA`, ttlMinutes: 5
    } }); assert.equal(result.status, 201, result.data.error); return { ...result.data.grant, tenantId };
  }
  const foreign = await grant(other, second, 'B'); await f.active();
  const requestAtDomain = path => f.request(path, { host: customHost, cookie: f.owner.cookie });
  const protectedRows = f.protectedRows();
  assert.equal((await requestAtDomain('/api/bootstrap')).status, 403, 'Grant de outro cliente não autoriza entrar no HostA.');
  const foreignOnly = await requestAtDomain('/api/support/available'); assert.equal(foreignOnly.status, 200); assert.deepEqual(foreignOnly.data.grants, []);
  const forbidden = await requestAtDomain(`/api/support/grants/${foreign.id}`); assert.equal(forbidden.status, 403); assert.equal(forbidden.data.grant, undefined);
  for (const result of [foreignOnly, forbidden]) for (const privateValue of [foreign.id, other.id, foreign.tenantId, foreign.reason, foreign.ticket, other.name]) assert.equal(JSON.stringify(result.data).includes(privateValue), false, 'Metadata B fora do endereço A.');
  assert.deepEqual(f.protectedRows(), protectedRows);
  const matching = await grant(f.business, f.customer, 'A');
  const beforeMixedDiscovery = f.protectedRows();
  assert.equal((await requestAtDomain('/api/bootstrap')).status, 403, 'A descoberta precisa funcionar antes da seleção explícita do grantA.');
  const mixed = await requestAtDomain('/api/support/available'); assert.equal(mixed.status, 200); assert.deepEqual(mixed.data.grants.map(item => item.id), [matching.id]); assert.equal(mixed.data.grants[0].workspaceId, f.business.id);
  const preview = await requestAtDomain(`/api/support/grants/${matching.id}`); assert.equal(preview.status, 200); assert.equal(preview.data.grant.id, matching.id); assert.equal(preview.data.grant.workspaceId, f.business.id);
  for (const result of [mixed, preview]) for (const privateValue of [foreign.id, other.id, foreign.tenantId, foreign.reason, foreign.ticket, other.name]) assert.equal(JSON.stringify(result.data).includes(privateValue), false, 'Mistura A/B não pode retornar metadata B no HostA.');
  const canonical = await f.request('/api/support/available', { cookie: f.owner.cookie }); assert.equal(canonical.status, 200); assert.deepEqual(new Set(canonical.data.grants.map(item => item.id)), new Set([matching.id, foreign.id]));
  const canonicalForeign = await f.request(`/api/support/grants/${foreign.id}`, { cookie: f.owner.cookie }); assert.equal(canonicalForeign.status, 200); assert.equal(canonicalForeign.data.grant.workspaceId, other.id);
  const selected = await f.request('/api/bootstrap', { host: customHost, cookie: f.owner.cookie, headers: { 'X-Elozi-Support-Grant': matching.id } }); assert.equal(selected.status, 200, selected.data.error); assert.equal(selected.data.session.role, 'operator'); assert.equal(selected.data.session.supportGrantId, matching.id); assert.equal(selected.data.session.resellerId, f.business.id); assert.deepEqual(selected.data.tenants.map(item => item.id), [matching.tenantId]); assert.ok(selected.data.workspaces.every(item => item.id === f.business.id));
  assert.equal((await f.request('/api/bootstrap', { host: customHost, cookie: f.owner.cookie, headers: { 'X-Elozi-Support-Grant': foreign.id } })).status, 403);
  assert.deepEqual(f.protectedRows(), beforeMixedDiscovery);
});

test('HTTP bearer de serviço respeita HostA antes de qualquer operação e conserva A/B no host canônico', async t => {
  const f = await fixture(t), other = await f.createAccount('Empresa serviço B QA'), second = await f.accept(await f.invite(other));
  async function principal(account, administrator, label) {
    const boot = await f.request('/api/bootstrap', { cookie: administrator.cookie }); assert.equal(boot.status, 200);
    const tenantId = boot.data.tenants[0].id, actor = f.app.auth.actor(f.app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(administrator.data.user.id));
    f.app.store.mutate(actor, tenantId, 'Adaptador de serviço sintético QA', state => {
      state.agents = [{ id: 'hermes-qa', name: `Adaptador QA ${label}`, provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Fixture em RAM', tools: [] }];
      state.channels = [{ id: 'service-qa', name: 'Canal planejado QA', kind: 'telegram', state: 'planned' }];
    });
    return f.app.servicePrincipals.create(actor, tenantId, { name: `Serviço privado ${label} QA`, agentId: 'hermes-qa', capabilities: ['conversation.read', 'reply.draft', 'handoff.request'], channelIds: ['service-qa'], departmentIds: ['unassigned'], ttlHours: 1 });
  }
  const matching = await principal(f.business, f.customer, 'A'), foreign = await principal(other, second, 'B'); await f.active();
  const calls = [];
  for (const method of ['me', 'read', 'draft', 'handoff']) { const original = f.app.serviceApi[method].bind(f.app.serviceApi); f.app.serviceApi[method] = (...args) => { calls.push([method, args[0].workspaceId]); return original(...args); }; }
  const getReceipt = f.app.servicePrincipals.getReceipt.bind(f.app.servicePrincipals); f.app.servicePrincipals.getReceipt = (...args) => { calls.push(['receipt', args[0].workspaceId]); return getReceipt(...args); };
  const before = f.protectedRows();
  for (const [path, method] of [['/api/service/v1/me', 'GET'], ['/api/service/v1/conversations/qa-conversation', 'GET'], ['/api/service/v1/drafts', 'POST'], ['/api/service/v1/handoff-requests', 'POST'], ['/api/service/v1/receipts/qa-receipt', 'GET']]) {
    const denied = await f.request(path, { method, host: customHost, requestOrigin: customOrigin, headers: { Authorization: `Bearer ${foreign.token}`, 'X-Elozi-Workspace': other.id }, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(denied.status, 403, path); assert.equal(denied.data.principal, undefined);
    for (const privateValue of [foreign.principal.id, foreign.principal.tenantId, foreign.principal.name, other.id]) assert.equal(JSON.stringify(denied.data).includes(privateValue), false);
  }
  assert.deepEqual(calls, [], 'Bearer B precisa ser recusado antes de chamar ServiceApi ou ler recibos.');
  const same = await f.request('/api/service/v1/me', { host: customHost, headers: { Authorization: `Bearer ${matching.token}` } }); assert.equal(same.status, 200); assert.equal(same.data.principal.id, matching.principal.id); assert.equal(same.data.principal.workspaceId, f.business.id);
  for (const created of [matching, foreign]) { const canonical = await f.request('/api/service/v1/me', { headers: { Authorization: `Bearer ${created.token}` } }); assert.equal(canonical.status, 200); assert.equal(canonical.data.principal.id, created.principal.id); }
  assert.deepEqual(calls, [['me', f.business.id], ['me', f.business.id], ['me', other.id]]);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM service_principal_receipts').get().n, 0); assert.deepEqual(f.protectedRows(), before);
});

test('HTTP webchat público recusa tenantB no HostA antes do adapter e mantém abertura real em RAM para A/canônico B', async t => {
  const f = await fixture(t), other = await f.createAccount('Empresa webchat B QA'), second = await f.accept(await f.invite(other));
  async function channel(administrator) {
    const boot = await f.request('/api/bootstrap', { cookie: administrator.cookie }); assert.equal(boot.status, 200);
    const tenantId = boot.data.tenants[0].id, actor = f.app.auth.actor(f.app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(administrator.data.user.id)), channelId = 'webchat-qa';
    f.app.store.mutate(actor, tenantId, 'Canal webchat sintético QA', state => { state.channels = [{ id: channelId, name: 'Atendimento webchat QA', kind: 'webchat', state: 'planned' }]; });
    f.app.webchat.configure(actor, tenantId, channelId, { origins: [customOrigin], version: 0 }); return { tenantId, channelId };
  }
  const matching = await channel(f.customer), foreign = await channel(second); await f.active();
  const calls = [];
  for (const method of ['publicAccess', 'challenge', 'openSession', 'receive', 'history']) { const original = f.app.webchat[method].bind(f.app.webchat); f.app.webchat[method] = (...args) => { calls.push([method, method === 'publicAccess' ? args[0] : args[0].tenantId]); return original(...args); }; }
  const path = (target, action) => `/api/public/webchat/${target.tenantId}/${target.channelId}/${action}`, before = f.protectedRows();
  for (const action of ['challenge', 'session', 'messages', 'history']) {
    const denied = await f.request(path(foreign, action), { method: 'POST', host: customHost, requestOrigin: customOrigin, body: action === 'challenge' ? {} : { challenge: 'invalid-synthetic-secret', token: 'invalid-synthetic-secret' } });
    assert.equal(denied.status, 403, action); assert.equal(denied.headers['access-control-allow-origin'], undefined); assert.equal(denied.data.brand, undefined); assert.equal(denied.data.challenge, undefined); assert.equal(denied.data.token, undefined);
  }
  assert.equal((await f.request(path(foreign, 'challenge'), { method: 'OPTIONS', host: customHost, requestOrigin: customOrigin })).status, 403); assert.deepEqual(calls, []);
  assert.equal(f.app.webchat.challenges.size, 0); assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM webchat_sessions').get().n, 0);
  for (const [target, host] of [[matching, customHost], [foreign, canonicalHost]]) {
    const challenge = await f.request(path(target, 'challenge'), { method: 'POST', host, requestOrigin: customOrigin, body: {} }); assert.equal(challenge.status, 200, challenge.data.error); assert.equal(challenge.data.allowed, true);
    const opened = await f.request(path(target, 'session'), { method: 'POST', host, requestOrigin: customOrigin, body: { challenge: challenge.data.challenge, name: 'Visitante QA' } }); assert.equal(opened.status, 200, opened.data.error); assert.equal(typeof opened.data.token, 'string');
  }
  assert.deepEqual(calls, [matching.tenantId, foreign.tenantId].flatMap(id => [['publicAccess',id],['publicAccess',id],['challenge',id],['publicAccess',id],['publicAccess',id],['openSession',id],['publicAccess',id]]));
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM webchat_sessions').get().n, 2); assert.deepEqual(f.protectedRows(), before);
});

test('HTTP webhooks Meta/email isolam tenantB antes de verificar segredo e preservam adapter sintético no host próprio/canônico', async t => {
  const f = await fixture(t), other = await f.createAccount('Empresa webhook B QA'), second = await f.accept(await f.invite(other));
  const firstBoot = await f.request('/api/bootstrap', { cookie: f.customer.cookie }), secondBoot = await f.request('/api/bootstrap', { cookie: second.cookie }); assert.equal(firstBoot.status, 200); assert.equal(secondBoot.status, 200);
  const matching = firstBoot.data.tenants[0].id, foreign = secondBoot.data.tenants[0].id, calls = []; await f.active();
  f.app.meta.verifyWebhook = async (tenantId, channelId, query) => { calls.push(['meta-verify', tenantId, channelId]); assert.equal(query['hub.verify_token'], 'qa-valid-secret'); return query['hub.challenge']; };
  f.app.meta.receiveWebhook = async (tenantId, channelId, rawBody, signature) => { calls.push(['meta-receive', tenantId, channelId]); assert.equal(signature, 'qa-valid-secret'); assert.deepEqual(JSON.parse(rawBody.toString()), { fixture: 'meta' }); return { fixture: 'meta' }; };
  f.app.emailChannel.receiveWebhook = async ({ tenantId, channelId, rawBody, timestamp, signature }) => { calls.push(['email-receive', tenantId, channelId]); assert.equal(signature, 'qa-valid-secret'); assert.equal(timestamp, 'qa-valid-timestamp'); assert.deepEqual(JSON.parse(rawBody.toString()), { fixture: 'email' }); return { fixture: 'email' }; };
  const path = (kind, tenantId) => `/api/webhooks/${kind}/${tenantId}/webhook-qa`, before = f.protectedRows();
  const verify = await f.request(path('meta', foreign) + '?hub.verify_token=qa-invalid-secret&hub.challenge=qa-private-challenge', { host: customHost }); assert.equal(verify.status, 403); assert.equal(JSON.stringify(verify.data).includes('qa-private-challenge'), false);
  for (const kind of ['meta', 'email']) {
    const denied = await f.request(path(kind, foreign), { host: customHost, method: 'POST', requestOrigin: customOrigin, body: { fixture: kind }, headers: { 'X-Hub-Signature-256': 'qa-invalid-secret', 'X-Elozi-Signature': 'qa-invalid-secret', 'X-Elozi-Timestamp': 'qa-invalid-timestamp' } });
    assert.equal(denied.status, 403, kind); assert.equal(denied.data.accepted, undefined); assert.equal(JSON.stringify(denied.data).includes(foreign), false);
  }
  assert.deepEqual(calls, [], 'Nenhum adapter pode validar segredo ou processar evento do tenantB pelo HostA.'); assert.deepEqual(f.protectedRows(), before);
  for (const [tenantId, host, requestOrigin] of [[matching, customHost, customOrigin], [foreign, canonicalHost, origin]]) {
    const confirmed = await f.request(path('meta', tenantId) + '?hub.verify_token=qa-valid-secret&hub.challenge=qa-confirmed', { host }); assert.equal(confirmed.status, 200); assert.equal(confirmed.data, 'qa-confirmed');
    for (const kind of ['meta', 'email']) { const received = await f.request(path(kind, tenantId), { host, method: 'POST', requestOrigin, body: { fixture: kind }, headers: { 'X-Hub-Signature-256': 'qa-valid-secret', 'X-Elozi-Signature': 'qa-valid-secret', 'X-Elozi-Timestamp': 'qa-valid-timestamp' } }); assert.equal(received.status, 200, received.data.error); assert.deepEqual(received.data, { accepted: true, fixture: kind }); }
  }
  assert.deepEqual(calls, [['meta-verify', matching, 'webhook-qa'], ['meta-receive', matching, 'webhook-qa'], ['email-receive', matching, 'webhook-qa'], ['meta-verify', foreign, 'webhook-qa'], ['meta-receive', foreign, 'webhook-qa'], ['email-receive', foreign, 'webhook-qa']]); assert.deepEqual(f.protectedRows(), before);
});
