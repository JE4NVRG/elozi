import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CommercialAccounts } from '../src/commercial-accounts.js';
import { WorkspaceDomains, normalizeWorkspaceHost } from '../src/workspace-domains.js';

const owner = { userId: 'owner', resellerId: 'platform', role: 'reseller' };
const partner = { userId: 'partner', resellerId: 'partner-a', role: 'reseller' };
const client = { userId: 'client', resellerId: 'business-a', role: 'reseller' };
const other = { userId: 'other', resellerId: 'partner-b', role: 'reseller' };
const denied = expected => error => error.status === expected;
const host = 'chat.cliente.com.br';
const canonicalHost = 'elozi.je4ndev.com';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);
    CREATE TABLE qa_users(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,role TEXT NOT NULL,platform INTEGER NOT NULL,disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE qa_queue(tenant_id TEXT NOT NULL REFERENCES tenants(id));
    CREATE TABLE qa_protected(data TEXT NOT NULL);`);
  for (const [id, accountKind, parentWorkspaceId] of [['platform', 'platform', null], ['partner-a', 'reseller', 'platform'], ['partner-b', 'reseller', 'platform'], ['business-a', 'business', 'partner-a']]) {
    db.prepare('INSERT INTO resellers VALUES(?,?)').run(id, JSON.stringify({ name: id, accountKind, parentWorkspaceId, version: 1,
      brand: { name: 'Marca QA', initials: 'QA', accent: '#123456', domain: 'intencao.anterior.com.br', logo: 'https://private.invalid/secret-logo', privateKey: 'synthetic-brand-secret' },
      credential: 'synthetic-account-secret', unknownFutureField: { kept: true } }));
    db.prepare('INSERT INTO tenants VALUES(?,?,?)').run(`tenant-${id}`, id, JSON.stringify({ channels: [{ token: 'synthetic-channel-secret', state: 'connected' }], conversations: [{ text: 'synthetic-customer-message' }] }));
  }
  for (const actor of [owner, partner, client, other, { userId: 'operator', resellerId: 'partner-a', role: 'operator' }]) db.prepare('INSERT INTO qa_users VALUES(?,?,?,?,0)').run(actor.userId, actor.resellerId, actor.role, Number(actor === owner));
  db.prepare('INSERT INTO qa_protected VALUES(?)').run('synthetic-identity-and-billing-data');
  let instant = Date.parse('2026-10-03T12:00:00.000Z');
  const data = id => JSON.parse(db.prepare('SELECT data FROM resellers WHERE id=?').get(id).data);
  const store = { db, provisionReseller() { throw new Error('Não provisionar no ensaio de domínios.'); }, queuePostgres: tenantId => db.prepare('INSERT INTO qa_queue VALUES(?)').run(tenantId) };
  const accounts = new CommercialAccounts(store, { platformWorkspaceId: 'platform', now: () => instant,
    validateActor: candidate => {
      const row = candidate && db.prepare('SELECT * FROM qa_users WHERE id=?').get(candidate.userId);
      if (!row || row.disabled || candidate.resellerId !== row.workspace) throw Object.assign(new Error('Acesso revogado'), { status: 403 });
      return { ...candidate, role: row.role, resellerId: row.workspace };
    }, isPlatformAdmin: actor => Boolean(db.prepare('SELECT 1 FROM qa_users WHERE id=? AND workspace=? AND platform=1 AND disabled=0').get(actor.userId, actor.resellerId)) });
  const dnsCalls = [], deploymentCalls = [];
  const resolver = options.resolver || {
    resolveTxt: async name => {
      dnsCalls.push(['TXT', name]);
      const binding = db.prepare("SELECT json_extract(data,'$.workspaceDomain') AS binding FROM resellers WHERE json_extract(data,'$.workspaceDomain.host')=?").get(name.replace(/^_elozi-verification\./, ''));
      return binding ? [[`elozi-verification=${JSON.parse(binding.binding).challenge}`]] : [];
    },
    resolveCname: async name => { dnsCalls.push(['CNAME', name]); return [`${canonicalHost}.`]; },
  };
  const proof = requestedHost => ({ host: requestedHost, httpsOrigin: `https://${requestedHost}`, tlsValid: true, proxyVerified: true,
    certificateExpiresAt: new Date(instant + 3600000).toISOString(), sourceRevision: 'a'.repeat(40), secret: 'synthetic-inspector-secret' });
  const inspectDeployment = options.inspector === false ? null : options.inspectDeployment || (async (requestedHost, context) => { deploymentCalls.push([requestedHost, context]); return proof(requestedHost); });
  const domains = new WorkspaceDomains(accounts, { resolver, inspectDeployment, ...(options.dnsTimeoutMs ? { dnsTimeoutMs: options.dnsTimeoutMs } : {}) });
  const protectedRows = () => ['tenants', 'qa_users', 'qa_protected'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const auditCount = () => db.prepare('SELECT count(*) AS n FROM commercial_account_audit').get().n;
  return { db, store, accounts, domains, data, resolver, dnsCalls, deploymentCalls, proof, protectedRows, auditCount, clock: value => { instant = value; } };
}

async function verified(c) {
  const registered = c.domains.register(client, 'business-a', { version: 1, host });
  return c.domains.verify(client, 'business-a', { version: registered.version });
}

test('DNS flattened exige TXT e rota assinada; verificação não ativa domínio automaticamente',async t=>{
  const c=fixture(t);c.resolver.resolveCname=async()=>[];
  c.domains.inspectDeployment=async(requestedHost,context)=>{assert.equal(context.challenge,c.data('business-a').workspaceDomain.challenge);assert.equal(context.version,c.data('business-a').version);return {...c.proof(requestedHost),signedRouteVerified:true};};
  const before=c.protectedRows(),status=await verified(c);
  assert.equal(status.binding.state,'verified');assert.equal(status.binding.active,false);assert.equal(status.binding.lastCheck.cnameTarget,false);assert.equal(status.binding.lastCheck.routeVerified,true);assert.equal(status.binding.lastCheck.verificationMethod,'txt+signed-https');assert.equal(status.binding.deployment,null);assert.equal(c.domains.resolve(host),null);assert.deepEqual(c.protectedRows(),before);
  const active=await c.domains.confirmDeployment(owner,'business-a',{version:status.version});assert.equal(active.binding.active,true);
});

test('fallback assinado nunca substitui TXT, destino divergente, SERVFAIL ou prova incompleta',async t=>{
  for(const mode of ['txt-absent','wrong-cname','servfail','unsigned','expired'])await t.test(mode,async tt=>{
    const c=fixture(tt);let calls=0;c.resolver.resolveCname=async()=>{if(mode==='wrong-cname')return ['outro.empresa.com.br'];if(mode==='servfail')throw Object.assign(new Error('DNSfailed'),{code:'ESERVFAIL'});throw Object.assign(new Error('flattened'),{code:'ENODATA'});};
    if(mode==='txt-absent')c.resolver.resolveTxt=async()=>[];
    c.domains.inspectDeployment=async requestedHost=>{calls++;return {...c.proof(requestedHost),signedRouteVerified:mode!=='unsigned',...(mode==='expired'?{certificateExpiresAt:'2020-01-01T00:00:00.000Z'}:{})};};
    const status=await verified(c);assert.equal(status.binding.state,'pending');assert.equal(status.binding.verifiedAt,null);assert.equal(c.domains.resolve(host),null);assert.equal(calls,['unsigned','expired'].includes(mode)?1:0);
  });
});

test('CAS é revalidado depois da inspeção assinada de rota e não grava prova velha',async t=>{
  const c=fixture(t);c.resolver.resolveCname=async()=>[];
  c.domains.inspectDeployment=async requestedHost=>{c.accounts.update(owner,'business-a',{version:2,name:'Nome revisto durante DNS'});return {...c.proof(requestedHost),signedRouteVerified:true};};
  await assert.rejects(verified(c),denied(409));assert.equal(c.data('business-a').workspaceDomain.state,'pending');assert.equal(c.data('business-a').workspaceDomain.verifiedAt,null);
});

test('host público normaliza IDN/FQDN e recusa IP, portas, paths, curinga e sufixos privados', () => {
  assert.equal(normalizeWorkspaceHost('CHAT.BÜCHER.DE.'), 'chat.xn--bcher-kva.de');
  assert.equal(normalizeWorkspaceHost('chat.cliente.com.br'), host);
  for (const value of [null, '', ' chat.cliente.com.br', 'chat.cliente.com.br ', 'localhost', '127.0.0.1', '127.1', '2130706433', '0x7f000001', '[::1]', 'chat.localhost', 'chat.local', 'chat.internal', 'chat.home.arpa', 'chat.test', 'chat.invalid', 'chat.onion', 'chat.lan', 'chat.example', '*.cliente.com.br', 'chat.cliente.com.br:443', 'https://chat.cliente.com.br', 'chat.cliente.com.br/path', 'chat.cliente.com.br?x', 'chat.cliente.com.br#x', 'user@chat.cliente.com.br', 'chat\\cliente.com.br', 'chat%2ecliente.com.br', 'chat..cliente.com.br', '-chat.cliente.com.br', 'chat_.cliente.com.br', 'chat.123', `${'a'.repeat(64)}.cliente.com.br`, 'chat\n.cliente.com.br']) assert.throws(() => normalizeWorkspaceHost(value), denied(400), String(value));
});

test('status é puro, domínio usa JSON existente e binding não altera dados, marca ou grants', t => {
  const c = fixture(t), schema = c.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), protectedRows = c.protectedRows(), before = c.data('business-a');
  assert.equal(c.domains.status(client).binding, null); assert.equal(c.auditCount(), 0);
  new WorkspaceDomains(c.accounts, { resolver: c.resolver });
  assert.deepEqual(c.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schema);
  const first = c.domains.register(client, 'business-a', { version: 1, host: host.toUpperCase() });
  assert.equal(first.version, 2); assert.equal(first.binding.state, 'pending'); assert.equal(first.binding.active, false); assert.match(first.binding.challenge, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.binding.records, [{ type: 'TXT', name: `_elozi-verification.${host}`, value: `elozi-verification=${first.binding.challenge}` }, { type: 'CNAME', name: host, value: canonicalHost }]);
  assert.deepEqual(c.data('business-a').brand, before.brand); assert.deepEqual(c.data('business-a').unknownFutureField, before.unknownFutureField); assert.deepEqual(c.protectedRows(), protectedRows);
  assert.equal(c.db.prepare('SELECT count(*) AS n FROM qa_queue').get().n, 1); assert.equal(c.auditCount(), 1); assert.equal(c.domains.resolve(host), null);
  const repeated = c.domains.register(client, 'business-a', { version: 2, host });
  assert.deepEqual(repeated, first); assert.equal(c.auditCount(), 1);
  const audit = JSON.stringify(c.db.prepare('SELECT * FROM commercial_account_audit').all()); assert.equal(audit.includes(first.binding.challenge), false);
});

test('uniquidade global, lineage comercial e autoridade fresca não ampliam acesso operacional', t => {
  const c = fixture(t); c.domains.register(partner, 'business-a', { version: 1, host });
  assert.throws(() => c.domains.register(other, 'partner-b', { version: 1, host: host.toUpperCase() }), denied(409));
  assert.throws(() => c.domains.status(other, 'business-a'), denied(404));
  assert.throws(() => c.domains.status({ userId: 'operator', resellerId: 'partner-a', role: 'reseller' }), denied(403));
  for (const candidate of [{ ...client, supportGrantId: 'grant' }, { ...client, kind: 'service' }, { ...client, resellerId: 'platform', platformAdmin: true }]) assert.throws(() => c.domains.status(candidate, 'business-a'), denied(403));
  assert.throws(() => c.domains.register(client, 'business-a', { version: 2, host: canonicalHost }), denied(400));
  assert.throws(() => c.domains.register(client, 'business-a', { version: 2, host: 'outro.cliente.com.br' }), denied(409));
  assert.throws(() => c.domains.register(client, 'business-a', { version: 2, host, active: true }), denied(400));
});

test('TXT fragmentado mais CNAME canônico comprova ownership sem ativar ou inspecionar TLS', async t => {
  const c = fixture(t), registered = c.domains.register(client, 'business-a', { version: 1, host });
  const challenge = `elozi-verification=${registered.binding.challenge}`;
  c.resolver.resolveTxt = async () => [['outro-token'], [challenge.slice(0, 22), challenge.slice(22)]];
  const result = await c.domains.verify(client, 'business-a', { version: 2 });
  assert.equal(result.version, 3); assert.equal(result.binding.state, 'verified'); assert.equal(result.binding.active, false);
  assert.deepEqual(result.binding.lastCheck, { txtOwnership: true, cnameTarget: true, checkedAt: '2026-10-03T12:00:00.000Z' });
  assert.equal(c.deploymentCalls.length, 0); assert.equal(c.domains.resolve(host), null);
});

test('DNS incorreto, resposta privada e erro do resolver nunca comprovam verificação', async t => {
  for (const variant of ['txt', 'cname', 'private', 'error', 'excess']) await t.test(variant, async t => {
    const c = fixture(t); c.domains.register(client, 'business-a', { version: 1, host });
    if (variant === 'txt') c.resolver.resolveTxt = async () => [['elozi-verification=token-incorreto']];
    if (variant === 'cname') c.resolver.resolveCname = async () => ['outra.origem.com.br'];
    if (variant === 'private') c.resolver.resolveCname = async () => ['localhost'];
    if (variant === 'error') c.resolver.resolveTxt = async () => { throw new Error('synthetic-private-dns-error'); };
    if (variant === 'excess') c.resolver.resolveTxt = async () => Array.from({ length: 65 }, () => [`elozi-verification=${c.data('business-a').workspaceDomain.challenge}`]);
    const result = await c.domains.verify(client, 'business-a', { version: 2 });
    assert.equal(result.binding.state, 'pending'); assert.equal(result.binding.verifiedAt, null); assert.equal(result.binding.active, false); assert.equal(c.domains.resolve(host), null);
    assert.equal(JSON.stringify(result).includes('synthetic-private-dns-error'), false);
    await assert.rejects(c.domains.confirmDeployment(owner, 'business-a', { version: 3 }), denied(409));
  });
});

test('DNS tem timeout limitado, sem transação pendente ou persistência parcial', async t => {
  const c = fixture(t, { dnsTimeoutMs: 10, resolver: { resolveTxt: () => new Promise(() => {}), resolveCname: async () => [canonicalHost] } });
  c.domains.register(client, 'business-a', { version: 1, host }); const before = c.data('business-a');
  await assert.rejects(c.domains.verify(client, 'business-a', { version: 2 }), denied(504));
  assert.deepEqual(c.data('business-a'), before); assert.equal(c.auditCount(), 1);
  assert.equal(c.domains.disable(client, 'business-a', { version: 2 }).version, 3);
});

test('espera DNS revalida usuário, role, lineage, versão e remoção antes de gravar', async t => {
  for (const variant of ['user', 'role', 'lineage', 'version', 'removed']) await t.test(variant, async t => {
    const c = fixture(t); c.domains.register(partner, 'business-a', { version: 1, host });
    let release; c.resolver.resolveTxt = () => new Promise(resolve => { release = resolve; });
    const waiting = c.domains.verify(partner, 'business-a', { version: 2 }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.db.isTransaction, false);
    const challenge = c.data('business-a').workspaceDomain.challenge;
    if (variant === 'user') c.db.prepare('UPDATE qa_users SET disabled=1 WHERE id=?').run(partner.userId);
    if (variant === 'role') c.db.prepare("UPDATE qa_users SET role='operator' WHERE id=?").run(partner.userId);
    if (variant === 'lineage' || variant === 'version') {
      const data = c.data('business-a'); data.version++; if (variant === 'lineage') data.parentWorkspaceId = 'partner-b'; else data.name = 'Renomeado durante DNS';
      c.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), 'business-a');
    }
    if (variant === 'removed') c.domains.remove(partner, 'business-a', { version: 2 });
    const preserved = c.data('business-a'); release([[`elozi-verification=${challenge}`]]);
    await assert.rejects(waiting, denied(variant === 'user' || variant === 'role' ? 403 : variant === 'lineage' ? 404 : 409));
    assert.deepEqual(c.data('business-a'), preserved);
  });
});

test('verificação simultânea usa CAS compartilhado, sem duplicar gravação ou auditoria', async t => {
  const c = fixture(t); c.domains.register(client, 'business-a', { version: 1, host });
  const results = await Promise.allSettled([c.domains.verify(client, 'business-a', { version: 2 }), c.domains.verify(client, 'business-a', { version: 2 })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(c.data('business-a').version, 3); assert.equal(c.auditCount(), 2);
});

test('falha ou persistência assíncrona PG reverte JSON, fila e auditoria; CAS não escreve revisão antiga', t => {
  for (const variant of ['queue', 'async', 'cas']) {
    const c = fixture(t), before = c.data('business-a');
    if (variant === 'queue') c.store.queuePostgres = id => { c.db.prepare('INSERT INTO qa_queue VALUES(?)').run(id); throw new Error('Fila recusada'); };
    if (variant === 'async') c.store.queuePostgres = () => Promise.resolve();
    if (variant === 'cas') c.db.exec("CREATE TRIGGER qa_block_domain BEFORE UPDATE ON resellers BEGIN SELECT RAISE(IGNORE); END;");
    assert.throws(() => c.domains.register(client, 'business-a', { version: 1, host }), variant === 'queue' ? /Fila recusada/ : denied(variant === 'cas' ? 409 : 500));
    assert.deepEqual(c.data('business-a'), before); assert.equal(c.auditCount(), 0); assert.equal(c.db.prepare('SELECT count(*) AS n FROM qa_queue').get().n, 0);
  }
});

test('ativação é exclusiva da plataforma e só aceita prova da inspeção injetada', async t => {
  const c = fixture(t, { inspector: false }); await verified(c);
  for (const actor of [client, partner, { ...owner, supportGrantId: 'grant' }]) await assert.rejects(c.domains.confirmDeployment(actor, 'business-a', { version: 3 }), denied(403));
  await assert.rejects(c.domains.confirmDeployment(owner, 'business-a', { version: 3, evidence: c.proof(host) }), denied(400));
  await assert.rejects(c.domains.confirmDeployment(owner, 'business-a', { version: 3 }), denied(503));
  assert.equal(c.data('business-a').version, 3); assert.equal(c.domains.resolve(host), null);
});

test('HTTPS/TLS/proxy incorretos não ativam e prova expirada não resolve marca pública', async t => {
  for (const variant of ['host', 'origin', 'tls', 'proxy', 'expired']) await t.test(variant, async t => {
    const c = fixture(t); await verified(c);
    c.domains.inspectDeployment = async () => ({ ...c.proof(host), ...(variant === 'host' ? { host: 'outro.cliente.com.br' } : variant === 'origin' ? { httpsOrigin: `http://${host}` } : variant === 'tls' ? { tlsValid: false } : variant === 'proxy' ? { proxyVerified: false } : { certificateExpiresAt: '2026-10-03T12:00:00.000Z' }) });
    await assert.rejects(c.domains.confirmDeployment(owner, 'business-a', { version: 3 }), denied(502));
    assert.equal(c.data('business-a').version, 3); assert.equal(c.domains.resolve(host), null);
  });
});

test('prova confiável ativa somente o binding; resolve expõe só workspace, host e marca segura', async t => {
  const c = fixture(t), protectedRows = c.protectedRows(); await verified(c);
  const active = await c.domains.confirmDeployment(owner, 'business-a', { version: 3 });
  assert.equal(active.binding.state, 'active'); assert.equal(active.binding.active, true); assert.equal(active.version, 4);
  assert.deepEqual(c.deploymentCalls, [[host, { workspaceId: 'business-a', canonicalHost,challenge:c.data('business-a').workspaceDomain.challenge,version:3 }]]);
  const resolved = c.domains.resolve(host.toUpperCase());
  assert.deepEqual(resolved, { workspaceId: 'business-a', host, brand: { name: 'Marca QA', initials: 'QA', accent: '#123456' } });
  for (const marker of [active.binding.challenge, 'synthetic-inspector-secret', 'synthetic-brand-secret', 'synthetic-account-secret', 'synthetic-channel-secret', 'synthetic-customer-message', 'parentWorkspaceId', 'intencao.anterior']) assert.equal(JSON.stringify(resolved).includes(marker), false);
  assert.equal(JSON.stringify(active).includes('synthetic-inspector-secret'), false); assert.deepEqual(c.protectedRows(), protectedRows);
  c.clock(Date.parse('2026-10-03T13:00:00.000Z')); assert.equal(c.domains.resolve(host), null); assert.equal(c.domains.status(client).binding.active, false); assert.equal(c.data('business-a').version, 4);
  for (const invalid of ['localhost', '127.0.0.1', `${host}:443`, `https://${host}`, 'outro.cliente.com.br']) assert.equal(c.domains.resolve(invalid), null);
});

test('relógio de parede que volta não reordena a prova nem recusa o host recém-ativado; prova futura e certificado vencido seguem recusados', async t => {
  const c = fixture(t); await verified(c);
  c.clock(Date.parse('2026-10-03T11:59:58.900Z'));
  const active = await c.domains.confirmDeployment(owner, 'business-a', { version: 3 });
  assert.equal(active.binding.active, true); assert.equal(active.binding.verifiedAt, '2026-10-03T12:00:00.000Z'); assert.equal(active.binding.deployment.observedAt, '2026-10-03T12:00:00.000Z');
  c.clock(Date.parse('2026-10-03T11:59:57.800Z'));
  assert.equal(c.domains.resolve(host)?.workspaceId, 'business-a'); assert.equal(c.domains.status(client).binding.active, true);
  const data = c.data('business-a'), issued = data.workspaceDomain.deployment.observedAt;
  data.workspaceDomain.deployment.observedAt = '2026-10-03T12:00:00.001Z'; c.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), 'business-a');
  assert.equal(c.domains.resolve(host), null, 'Somente instantes já emitidos por este processo deixam de ser futuros.');
  data.workspaceDomain.deployment.observedAt = issued; c.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), 'business-a');
  assert.equal(c.domains.resolve(host)?.workspaceId, 'business-a');
  c.clock(Date.parse('2026-10-03T11:58:59.999Z')); assert.equal(c.domains.resolve(host), null, 'Correção maior que um minuto volta a seguir o relógio.');
  c.clock(Date.parse('2026-10-03T12:00:00.000Z')); assert.equal(c.domains.resolve(host)?.workspaceId, 'business-a');
  c.clock(Date.parse('2026-10-03T12:59:58.900Z')); assert.equal(c.domains.resolve(host), null);
});

test('revogar plataforma durante inspeção não ativa nem sobrescreve alterações concorrentes', async t => {
  for (const variant of ['actor', 'version']) await t.test(variant, async t => {
    const c = fixture(t); await verified(c); let release;
    c.domains.inspectDeployment = () => new Promise(resolve => { release = resolve; });
    const waiting = c.domains.confirmDeployment(owner, 'business-a', { version: 3 }); await new Promise(resolve => setImmediate(resolve));
    if (variant === 'actor') c.db.prepare('UPDATE qa_users SET disabled=1 WHERE id=?').run(owner.userId);
    else c.domains.disable(client, 'business-a', { version: 3 });
    const preserved = c.data('business-a'); release(c.proof(host));
    await assert.rejects(waiting, denied(variant === 'actor' ? 403 : 409)); assert.deepEqual(c.data('business-a'), preserved); assert.equal(c.domains.resolve(host), null);
  });
});

test('erro privado e timeout da inspeção são sanitizados e nunca persistem ativação', async t => {
  for (const variant of ['error', 'timeout']) await t.test(variant, async t => {
    const c = fixture(t, { dnsTimeoutMs: 10 }); await verified(c);
    c.domains.inspectDeployment = variant === 'error' ? async () => { throw new Error('synthetic-provider-secret'); } : () => new Promise(() => {});
    await assert.rejects(c.domains.confirmDeployment(owner, 'business-a', { version: 3 }), error => error.status === (variant === 'error' ? 502 : 504) && !error.message.includes('synthetic-provider-secret'));
    assert.equal(c.data('business-a').version, 3); assert.equal(c.domains.resolve(host), null); assert.equal(c.db.isTransaction, false);
  });
});

test('DNS perdido desativa binding ativo e disable/remove/re-registro conservam dados e trocam challenge', async t => {
  const c = fixture(t), protectedRows = c.protectedRows(); await verified(c); await c.domains.confirmDeployment(owner, 'business-a', { version: 3 });
  const oldChallenge = c.data('business-a').workspaceDomain.challenge;
  c.resolver.resolveTxt = async () => [['elozi-verification=outro-token']];
  const lost = await c.domains.verify(client, 'business-a', { version: 4 });
  assert.equal(lost.binding.state, 'pending'); assert.equal(lost.binding.deployment, null); assert.equal(c.domains.resolve(host), null);
  assert.equal(c.domains.disable(client, 'business-a', { version: 5 }).binding.state, 'disabled');
  assert.throws(() => c.domains.register(other, 'partner-b', { version: 1, host }), denied(409));
  const renewed = c.domains.register(client, 'business-a', { version: 6, host });
  assert.notEqual(renewed.binding.challenge, oldChallenge); assert.equal(renewed.binding.state, 'pending'); assert.equal(renewed.binding.verifiedAt, null);
  const removed = c.domains.remove(client, 'business-a', { version: 7 }); assert.equal(removed.binding, null); assert.equal(removed.version, 8);
  assert.equal(c.domains.remove(client, 'business-a', { version: 8 }).version, 8);
  const taken = c.domains.register(other, 'partner-b', { version: 1, host }); assert.notEqual(taken.binding.challenge, renewed.binding.challenge);
  assert.deepEqual(c.protectedRows(), protectedRows); assert.equal(c.data('business-a').brand.domain, 'intencao.anterior.com.br');
});

test('duplicidade legada ou metadata adulterada nunca resolve workspace público', async t => {
  const c = fixture(t); await verified(c); await c.domains.confirmDeployment(owner, 'business-a', { version: 3 });
  const duplicated = c.data('partner-b'); duplicated.workspaceDomain = c.data('business-a').workspaceDomain;
  c.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(duplicated), 'partner-b'); assert.equal(c.domains.resolve(host), null);
  delete duplicated.workspaceDomain; c.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(duplicated), 'partner-b');
  const corrupt = c.data('business-a'); corrupt.workspaceDomain.challenge = 'invalid'; c.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(corrupt), 'business-a');
  assert.equal(c.domains.resolve(host), null); assert.throws(() => c.domains.status(client), denied(500));
});
