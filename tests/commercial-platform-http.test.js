import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApp } from '../src/server.js';

const password = () => 'Local-QA-' + randomBytes(12).toString('hex');
const tokenFrom = value => { const url = new URL(value); assert.equal(url.pathname, '/accept-invite'); assert.equal(url.search, ''); const token = new URLSearchParams(url.hash.slice(1)).get('token'); assert.ok(token); return token; };
const accountInput = (extra = {}) => ({ requestId: randomUUID(), name: 'Conta comercial QA', accountKind: 'business', parentWorkspaceId: 'mep-demo', initialTenantName: 'Matriz QA', segment: 'QA', ...extra });
async function fixture(t, { google = false } = {}) {
  const key = randomBytes(32), external = [], deny = async (...args) => { external.push(args.length); throw new Error('Transporte externo negado na fixture sintética'); };
  const clientId = 'commercial-fixture.apps.googleusercontent.com'; let pair, jwk;
  if (google) { pair = await generateKeyPair('RS256'); jwk = await exportJWK(pair.publicKey); jwk.kid = 'commercial-qa'; }
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: deny }, googleOptions: { clientId: google ? clientId : '', ...(google ? { jwks: createLocalJWKSet({ keys: [jwk] }) } : {}) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]); app.store.close(); });
  const request = async (path, { method = 'GET', cookie = '', workspace, grant, body, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(workspace ? { 'X-Elozi-Workspace': workspace } : {}), ...(grant ? { 'X-Elozi-Support-Grant': grant } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const setCookie = response.headers.get('set-cookie') || '';
    return { status: response.status, data: await response.json(), cookie: setCookie.split(';')[0], setCookie };
  };
  const ownerPassword = password(), owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Administrador principal QA', username: 'commercial.root', password: ownerPassword } }); assert.equal(owner.status, 200);
  const f = { app, base, request, owner, ownerPassword, external, pair, clientId };
  f.createAccount = async (body, cookie = owner.cookie) => { const result = await request('/api/accounts', { method: 'POST', cookie, body }); assert.equal(result.status, 201, result.data.error); return result.data.account; };
  f.inviteAdmin = async (account, cookie = owner.cookie) => { const created = await request(`/api/accounts/${account.id}/invitations`, { method: 'POST', cookie, body: { requestId: randomUUID(), name: 'Admin da conta QA', sendEmail: false } }); assert.equal(created.status, 201, created.data.error); return created; };
  f.accept = async created => { const name = 'qa.' + randomBytes(6).toString('hex'), result = await request('/api/auth/invitations/accept', { method: 'POST', body: { token: tokenFrom(created.data.inviteUrl), name: 'Pessoa convidada QA', username: name, password: password() } }); assert.equal(result.status, 200, result.data.error); return result; };
  return f;
}
async function commerce(f) {
  const reseller = await f.createAccount(accountInput({ accountKind: 'reseller', name: 'Revenda QA' })), partner = await f.accept(await f.inviteAdmin(reseller));
  const business = await f.createAccount(accountInput({ name: 'Cliente da revenda QA', parentWorkspaceId: reseller.id }), partner.cookie), invited = await f.inviteAdmin(business, partner.cookie), customer = await f.accept(invited);
  const boot = await f.request('/api/bootstrap', { cookie: customer.cookie }); assert.equal(boot.status, 200);
  return { reseller, partner, business, customer, invited, tenant: boot.data.tenants[0], customerActor: { userId: boot.data.session.userId, resellerId: business.id, role: 'reseller', name: 'Pessoa QA' } };
}

test('HTTP ciclo comercial por responsável, filtro autorizado, CAS comum e nenhuma suspensão de acesso', async t => {
  const f = await fixture(t), c = await commerce(f), path = `/api/accounts/${c.business.id}/lifecycle`;
  const before = f.app.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(c.tenant.id).data;
  assert.equal((await f.request(path, { method: 'PATCH', cookie: c.customer.cookie, body: { version: 1, state: 'paused', reason: 'Forjado' } })).status, 403);
  const changed = await f.request(path, { method: 'PATCH', cookie: c.partner.cookie, body: { version: 1, state: 'paused', reason: 'Acordo interno' } });
  assert.equal(changed.status, 200); assert.equal(changed.data.account.version, 2); assert.equal(changed.data.lifecycle.state, 'paused');
  assert.equal((await f.request(`/api/accounts/${c.business.id}`, { method: 'PATCH', cookie: c.partner.cookie, body: { version: 1, name: 'Revisão antiga' } })).status, 409);
  const filtered = await f.request('/api/accounts?state=paused', { cookie: c.partner.cookie });
  assert.equal(filtered.status, 200); assert.deepEqual(filtered.data.accounts.map(item => item.id), [c.business.id]);
  assert.equal((await f.request('/api/accounts?state=unknown', { cookie: c.partner.cookie })).status, 400);
  assert.equal((await f.request('/api/tenants/' + c.tenant.id, { cookie: c.customer.cookie })).status, 200);
  assert.equal(f.app.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(c.tenant.id).data, before);
  assert.equal(f.app.store.db.prepare("SELECT count(*) AS n FROM commercial_account_audit WHERE workspace_id=? AND action='account.lifecycle.paused'").get(c.business.id).n, 1);
  noExternal(f);
});

test('HTTP catálogo comercial reutiliza termos após revisão sem criar contrato ou fatura na prévia', async t => {
  const f = await fixture(t), c = await commerce(f);
  const empty = await f.request('/api/commercial/plans?workspaceId=mep-demo&limit=25', { cookie: f.owner.cookie }); assert.equal(empty.status, 200);
  const input = { requestId: randomUUID(), accountVersion: empty.data.accountVersion, name: 'Plano de teste acordado', targetKind: 'reseller', state: 'active', currency: 'BRL', periodMonths: 2,
    items: [{ kind: 'subscription', label: 'Preço sintético QA', unitCents: 12345, units: 1, metered: false }], quotas: { connections: 4 }, reason: 'Fixture sem cobrança real' };
  const created = await f.request('/api/accounts/mep-demo/plans', { method: 'POST', cookie: f.owner.cookie, body: input }); assert.equal(created.status, 201, created.data.error);
  const repeated = await f.request('/api/accounts/mep-demo/plans', { method: 'POST', cookie: f.owner.cookie, body: input }); assert.equal(repeated.status, 201); assert.equal(repeated.data.replayed, true); assert.equal(repeated.data.plan.id, created.data.plan.id);
  const path = `/api/accounts/mep-demo/plans/${created.data.plan.id}/contract-draft`;
  const previewInput = { accountVersion: created.data.accountVersion, version: created.data.plan.version, targetWorkspaceId: c.reseller.id, startsAt: '2026-10-01', graceDays: 3 };
  assert.equal((await f.request(path, { method: 'POST', cookie: c.partner.cookie, body: previewInput })).status, 404);
  const preview = await f.request(path, { method: 'POST', cookie: f.owner.cookie, body: previewInput }); assert.equal(preview.status, 200, preview.data.error); assert.equal(preview.data.requiresReview, true);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM billing_contracts').get().n, 0); assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM billing_invoices').get().n, 0);
  const contract = await f.request('/api/billing/contracts', { method: 'POST', cookie: f.owner.cookie, body: { ...preview.data.draft, requestId: randomUUID(), reason: 'Revisão sintética aprovada' } });
  assert.equal(contract.status, 201, contract.data.error); assert.equal(contract.data.periodMonths, 2); assert.equal(contract.data.items[0].unitCents, 12345);
  assert.equal((await f.request('/api/commercial/plans?workspaceId=mep-demo', { cookie: c.customer.cookie })).status, 404);
  noExternal(f);
});
function noExternal(f, { emails = 0 } = {}) {
  assert.equal(f.external.length, 0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM email_outbox').get().n, emails);
  for (const job of f.app.store.db.prepare('SELECT state,attempts FROM email_outbox').all()) { assert.equal(job.state, 'pending'); assert.equal(job.attempts, 0); }
}

test('HTTP pagina baixas da própria fatura e revalida uma correção sem expor ledger do pagador', async t => {
  const f = await fixture(t), c = await commerce(f);
  const terms = { requestId: randomUUID(), scope: 'platform', targetKind: 'reseller', targetWorkspaceId: c.reseller.id,
    name: 'Fatura sintética de paginação', currency: 'BRL', items: [{ kind: 'subscription', label: 'Teste em RAM', unitCents: 4, units: 1, metered: false }],
    quotas: {}, periodMonths: 1, startsAt: '2026-10-01', endsAt: null, graceDays: 0, state: 'active', reason: 'Fixture sem cobrança real' };
  const created = await f.request('/api/billing/contracts', { method: 'POST', cookie: f.owner.cookie, body: terms }); assert.equal(created.status, 201, created.data.error);
  const draft = await f.request(`/api/billing/contracts/${created.data.id}/invoices`, { method: 'POST', cookie: f.owner.cookie,
    body: { requestId: randomUUID(), version: 1, periodStart: '2026-10-01', periodEnd: '2026-10-31', dueDate: '2026-11-05', reason: 'Teste em RAM' } }); assert.equal(draft.status, 201, draft.data.error);
  const path = `/api/billing/invoices/${draft.data.id}`;
  let invoice = draft.data;
  for (const action of ['issue', 'settle', 'settle', 'settle']) {
    const result = await f.request(path + '/events', { method: 'POST', cookie: f.owner.cookie,
      body: { requestId: randomUUID(), version: invoice.version, action, reason: 'Operação sintética', ...(action === 'settle' ? { amountCents: 1, reference: 'QA-' + invoice.version, settledAt: '2026-10-03' } : {}) } });
    assert.equal(result.status, 200, result.data.error); invoice = result.data;
  }
  const first = await f.request(path + '?settlementsOffset=0&settlementsLimit=2', { cookie: f.owner.cookie });
  assert.equal(first.status, 200); assert.equal(first.data.settlements.length, 2);
  assert.deepEqual(first.data.settlementPage, { offset: 0, limit: 2, total: 3, hasMore: true });
  const last = await f.request(path + '?settlementsOffset=2&settlementsLimit=2', { cookie: f.owner.cookie });
  assert.equal(last.status, 200); assert.equal(last.data.settlements.length, 1); assert.equal(last.data.settlementPage.hasMore, false);
  assert.ok(!first.data.settlements.some(item => item.id === last.data.settlements[0].id));
  const selection = '?settlementId=' + encodeURIComponent(last.data.settlements[0].id);
  const exact = await f.request(path + selection, { cookie: f.owner.cookie });
  assert.equal(exact.status, 200); assert.deepEqual(exact.data.settlements, last.data.settlements); assert.equal(exact.data.settlementPage, null);
  assert.equal((await f.request(path + selection, { cookie: c.partner.cookie })).status, 403);
  assert.equal((await f.request(path + selection, { cookie: c.customer.cookie })).status, 404);
  assert.equal((await f.request(path + selection + '&settlementsOffset=0', { cookie: f.owner.cookie })).status, 400);
  assert.equal((await f.request(path + '?settlementsLimit=201', { cookie: f.owner.cookie })).status, 400);
  assert.equal((await f.request(path + '?tenantId=other', { cookie: f.owner.cookie })).status, 400);
  assert.equal((await f.request(path)).status, 401);
  const paid = await f.request(path + '?settlementsOffset=2', { cookie: c.partner.cookie });
  assert.equal(paid.status, 200); assert.deepEqual(paid.data.settlements, []); assert.equal(paid.data.settlementPage.total, 0);
  assert.equal(exact.data.reconciliation.balanced, true); noExternal(f);
});

test('HTTP plataforma→revenda→cliente cria paineis isolados e administrador alvo com issuer preservado', async t => {
  const f = await fixture(t), c = await commerce(f), db = f.app.store.db;
  const record = db.prepare('SELECT reseller_id,issuer_workspace_id,creator_id FROM auth_invitations WHERE id=?').get(c.invited.data.invitation.id);
  assert.equal(record.reseller_id, c.business.id); assert.equal(record.issuer_workspace_id, c.reseller.id); assert.equal(record.creator_id, c.partner.data.user.id);
  const customer = (await f.request('/api/bootstrap', { cookie: c.customer.cookie })).data;
  assert.equal(customer.reseller.accountKind, 'business'); assert.equal(customer.reseller.parentWorkspaceId, c.reseller.id); assert.equal(customer.session.platformOwner, false); assert.equal(customer.session.role, 'reseller');
  assert.deepEqual(customer.workspaces.map(item => item.id), [c.business.id]);
  assert.equal((await f.request('/api/tenants/' + c.tenant.id, { cookie: c.partner.cookie })).status, 404);
  assert.equal((await f.request('/api/tenants/' + c.tenant.id, { cookie: f.owner.cookie, workspace: c.business.id })).status, 403);
  assert.equal((await f.request('/api/users', { cookie: c.partner.cookie })).data.users.length, 1);
  assert.equal((await f.request('/api/users', { cookie: c.customer.cookie })).data.users.length, 1);
  assert.equal((await f.request('/api/accounts', { cookie: c.partner.cookie })).data.accounts.length, 2);
  assert.deepEqual((await f.request('/api/accounts', { cookie: c.customer.cookie })).data.accounts.map(item => item.id), [c.business.id]);
  assert.equal((await f.request('/api/platform/accounts', { cookie: c.partner.cookie })).status, 403); noExternal(f);
});

test('HTTP diretório global informa contas/usuários sem abrir operação antes do grant próprio auditado', async t => {
  const f = await fixture(t), c = await commerce(f), db = f.app.store.db;
  f.app.store.mutate(c.customerActor, c.tenant.id, 'Fixture privada', state => { state.channels = [{ id: 'private-channel', kind: 'telegram', name: 'Canal privado', state: 'planned' }]; state.conversations = [{ id: 'private-attendance', channelId: 'private-channel', contact: 'PRIVATE_CONTACT_MARKER', version: 1, status: 'open', owner: 'queue', unread: 0, messages: [{ id: 'private-message', kind: 'customer', text: 'PRIVATE_MESSAGE_MARKER', createdAt: new Date().toISOString() }] }]; });
  const global = await f.request('/api/platform/accounts?limit=100', { cookie: f.owner.cookie }); assert.equal(global.status, 200); assert.equal(global.data.accounts.length, 3); assert.equal(JSON.stringify(global.data).includes('PRIVATE_'), false);
  const users = await f.request('/api/platform/users?limit=100', { cookie: f.owner.cookie }); assert.equal(users.status, 200); assert.equal(users.data.total, 3);
  assert.equal((await f.request('/api/workspaces', { cookie: f.owner.cookie })).data.workspaces.some(item => item.id === c.business.id), false);
  assert.equal((await f.request('/api/tenants/' + c.tenant.id, { cookie: f.owner.cookie })).status, 404);
  const url = `/api/accounts/${c.business.id}/platform-access`;
  for (const body of [{ version: 2 }, { version: '1' }, { version: 1, userId: c.partner.data.user.id }]) assert.equal((await f.request(url, { method: 'POST', cookie: f.owner.cookie, body })).status, 409);
  assert.equal(db.prepare('SELECT count(*) n FROM auth_workspace_access WHERE reseller_id=?').get(c.business.id).n, 0);
  const grant = await f.request(url, { method: 'POST', cookie: f.owner.cookie, body: { version: 1 } }); assert.equal(grant.status, 200); assert.equal(grant.data.auditRecorded, true);
  assert.deepEqual(db.prepare('SELECT user_id FROM auth_workspace_access WHERE reseller_id=?').all(c.business.id).map(row => row.user_id), [f.owner.data.session.userId]);
  const replay = await f.request(url, { method: 'POST', cookie: f.owner.cookie, body: { version: 1 } }); assert.equal(replay.status, 200); assert.equal(replay.data.auditRecorded, false);
  assert.equal(db.prepare("SELECT count(*) n FROM commercial_account_audit WHERE workspace_id=? AND action='account.platform-access.granted'").get(c.business.id).n, 1);
  assert.equal((await f.request('/api/bootstrap', { cookie: f.owner.cookie })).data.session.resellerId, 'mep-demo');
  const opened = await f.request('/api/tenants/' + c.tenant.id, { cookie: f.owner.cookie, workspace: c.business.id }); assert.equal(opened.status, 200); assert.equal(JSON.stringify(opened.data).includes('PRIVATE_MESSAGE_MARKER'), true);
  assert.equal((await f.request('/api/tenants/' + c.tenant.id, { cookie: c.partner.cookie, workspace: c.business.id })).status, 403); noExternal(f);
});

test('HTTP grant da plataforma recusa reseller, business, operador, suporte e platformAdmin forjado', async t => {
  const f = await fixture(t), c = await commerce(f), url = `/api/accounts/${c.business.id}/platform-access`, db = f.app.store.db;
  for (const cookie of [c.partner.cookie, c.customer.cookie]) assert.equal((await f.request(url, { method: 'POST', cookie, body: { version: 1 }, headers: { 'X-Elozi-Platform-Admin': 'true' } })).status, 403);
  const p = password(), member = await f.request('/api/users', { method: 'POST', cookie: c.customer.cookie, body: { name: 'Operador QA', username: 'commercial.operator', password: p, role: 'operator', tenantIds: [c.tenant.id] } }); assert.equal(member.status, 201);
  const operator = await f.request('/api/auth/login', { method: 'POST', body: { username: 'commercial.operator', password: p } }); assert.equal(operator.status, 200);
  assert.equal((await f.request(url, { method: 'POST', cookie: operator.cookie, body: { version: 1 }, headers: { 'X-Elozi-Platform-Admin': 'true' } })).status, 403);
  f.app.store.mutate(c.customerActor, c.tenant.id, 'Fixture suporte', state => { state.channels = [{ id: 'support-channel', name: 'Suporte QA', kind: 'telegram', state: 'planned' }]; });
  const support = await f.request('/api/support/grants', { method: 'POST', cookie: c.customer.cookie, body: { requestId: randomUUID(), supportUserId: f.owner.data.session.userId, tenantIds: [c.tenant.id], permissions: ['inbox.read'], scopeRules: { [c.tenant.id]: { channelIds: ['support-channel'], departmentIds: ['unassigned'] } }, reason: 'Suporte sintético', ticket: 'QA', ttlMinutes: 5 } }); assert.equal(support.status, 201);
  const delegated = await f.request(url, { method: 'POST', cookie: f.owner.cookie, workspace: c.business.id, grant: support.data.grant.id, body: { version: 1 } }); assert.equal(delegated.status, 403);
  assert.equal(db.prepare('SELECT count(*) n FROM auth_workspace_access WHERE reseller_id=?').get(c.business.id).n, 0); noExternal(f);
});

test('HTTP convite comercial aceita só admin da conta e alvo próprio; lista/revoke não expõem segredo nem cruzam clientes', async t => {
  const f = await fixture(t), c = await commerce(f), other = await f.createAccount(accountInput({ name: 'Cliente externo' })), endpoint = `/api/accounts/${c.business.id}/invitations`;
  for (const extra of [{ role: 'operator' }, { permissions: [] }, { scopeRules: null }, { tenantIds: [c.tenant.id] }, { targetWorkspaceId: other.id }, { sendEmail: true }]) assert.ok([400, 409].includes((await f.request(endpoint, { method: 'POST', cookie: c.partner.cookie, body: { requestId: randomUUID(), ...extra } })).status));
  assert.equal((await f.request(`/api/accounts/${other.id}/invitations`, { cookie: c.partner.cookie })).status, 404);
  const body = { requestId: randomUUID(), name: 'Administrador adicional QA', sendEmail: false }, created = await f.request(endpoint, { method: 'POST', cookie: c.partner.cookie, body }); assert.equal(created.status, 201);
  const retry = await f.request(endpoint, { method: 'POST', cookie: c.partner.cookie, body }); assert.equal(retry.status, 201); assert.equal(retry.data.inviteUrl, created.data.inviteUrl);
  const list = await f.request(endpoint, { cookie: c.partner.cookie }); assert.equal(list.status, 200); assert.equal(JSON.stringify(list.data).includes(tokenFrom(created.data.inviteUrl)), false);
  assert.equal((await f.request(`/api/accounts/${other.id}/invitations/${created.data.invitation.id}/revoke`, { method: 'POST', cookie: f.owner.cookie, body: {} })).status, 404);
  const revoked = await f.request(`${endpoint}/${created.data.invitation.id}/revoke`, { method: 'POST', cookie: c.customer.cookie, body: {} }); assert.equal(revoked.status, 200); assert.equal(revoked.data.invitation.state, 'revoked');
  assert.equal((await f.request('/api/auth/invitations/preview', { method: 'POST', body: { token: tokenFrom(created.data.inviteUrl) } })).status, 400); noExternal(f);
});

test('HTTP filial e atendente granular preservam mensagens e grants após CAS; parent não herda acesso', async t => {
  const f = await fixture(t), c = await commerce(f), branch = await f.request('/api/tenants', { method: 'POST', cookie: c.customer.cookie, body: { name: 'Filial QA', segment: 'QA', parentTenantId: c.tenant.id } }); assert.equal(branch.status, 201);
  f.app.store.mutate(c.customerActor, branch.data.id, 'Fixture filial', state => { state.channels = [{ id: 'branch-channel', name: 'Canal QA', kind: 'telegram', state: 'planned' }]; state.conversations = [{ id: 'branch-conversation', channelId: 'branch-channel', contact: 'Pessoa QA', version: 1, status: 'open', owner: 'queue', unread: 0, messages: [{ id: 'branch-message', kind: 'customer', text: 'Preservar esta mensagem', createdAt: new Date().toISOString() }] }]; });
  const rules = { [branch.data.id]: { channelIds: ['branch-channel'], departmentIds: ['unassigned'] } }, invite = await f.request('/api/users/invitations', { method: 'POST', cookie: c.customer.cookie, body: { requestId: randomUUID(), role: 'operator', tenantIds: [branch.data.id], permissions: ['inbox.read'], scopeRules: rules } }); assert.equal(invite.status, 201);
  const attendant = await f.accept(invite), boot = await f.request('/api/bootstrap', { cookie: attendant.cookie }); assert.deepEqual(boot.data.tenants.map(item => item.id), [branch.data.id]); assert.equal(boot.data.tenants[0].parentTenantId, null);
  assert.equal((await f.request('/api/tenants/' + c.tenant.id, { cookie: attendant.cookie })).status, 403);
  const endpoint = `/api/tenants/${branch.data.id}/identity`, body = { version: 1, name: 'Filial atualizada', segment: 'Atendimento', parentTenantId: c.tenant.id };
  assert.equal((await f.request(endpoint, { method: 'PATCH', cookie: attendant.cookie, body })).status, 403);
  assert.equal((await f.request(endpoint, { method: 'PATCH', cookie: c.customer.cookie, body })).status, 200);
  assert.equal((await f.request(endpoint, { method: 'PATCH', cookie: c.customer.cookie, body: { ...body, name: 'Edição atrasada' } })).status, 409);
  const after = await f.request('/api/tenants/' + branch.data.id, { cookie: attendant.cookie }); assert.equal(after.status, 200); assert.equal(after.data.name, 'Filial atualizada'); assert.equal(after.data.conversations[0].messages[0].text, 'Preservar esta mensagem');
  const grants = f.app.store.db.prepare('SELECT tenant_ids,permissions,scope_rules FROM auth_users WHERE id=?').get(attendant.data.user.id); assert.deepEqual(JSON.parse(grants.tenant_ids), [branch.data.id]); assert.deepEqual(JSON.parse(grants.scope_rules), rules);
  assert.equal((await f.request('/api/tenants', { method: 'POST', cookie: c.customer.cookie, body: { name: 'Filial de filial', segment: 'QA', parentTenantId: branch.data.id } })).status, 400); noExternal(f);
});

test('HTTP cadastro default business e escolha reseller recusam plataforma, parent e roles; Google assinado cria business', async t => {
  const f = await fixture(t, { google: true });
  for (const [accountKind, expected] of [[undefined, 'business'], ['reseller', 'reseller']]) {
    const signed = await f.request('/api/auth/register', { method: 'POST', body: { fiscalDocument: syntheticFiscalDocument(), name: 'Admin público QA', company: 'Conta pública QA', email: randomUUID() + '@example.test', password: password(), ...(accountKind ? { accountKind } : {}) } }); assert.equal(signed.status, 200);
    const boot = await f.request('/api/bootstrap', { cookie: signed.cookie }); assert.equal(boot.data.reseller.accountKind, expected); assert.equal(boot.data.reseller.parentWorkspaceId, 'mep-demo'); assert.equal(boot.data.session.platformOwner, false);
  }
  for (const extra of [{ accountKind: 'platform' }, { parentWorkspaceId: 'mep-demo' }, { role: 'reseller' }, { platformAdmin: true }]) assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { fiscalDocument: syntheticFiscalDocument(), name: 'Elevação QA', email: randomUUID() + '@example.test', password: password(), ...extra } })).status, 400);
  const challenge = await f.request('/api/auth/status'); assert.equal(challenge.data.google.enabled, true);
  const credential = await new SignJWT({ nonce: challenge.data.google.nonce, email: 'commercial-google@example.test', email_verified: true, name: 'Google QA' }).setProtectedHeader({ alg: 'RS256', kid: 'commercial-qa' }).setIssuer('https://accounts.google.com').setAudience(f.clientId).setSubject('commercial-google-subject').setIssuedAt().setExpirationTime('5m').sign(f.pair.privateKey);
  const google = await f.request('/api/auth/google', { method: 'POST', cookie: challenge.cookie, body: { fiscalDocument: syntheticFiscalDocument(), credential } }); assert.equal(google.status, 200);
  const boot = await f.request('/api/bootstrap', { cookie: google.cookie }); assert.equal(boot.data.reseller.accountKind, 'business'); assert.equal(boot.data.session.platformOwner, false); assert.equal(boot.data.workspaces.length, 1); noExternal(f, { emails: 2 });
});

test('HTTP Google aceita escolha explícita de revenda sem promover plataforma nem converter conta existente', async t => {
  const f = await fixture(t, { google: true }), db = f.app.store.db, before = db.prepare('SELECT count(*) n FROM resellers').get().n;
  const googleLogin = async (accountKind, subject = 'commercial-reseller-google') => {
    const challenge = await f.request('/api/auth/status');
    const credential = await new SignJWT({ nonce: challenge.data.google.nonce, email: subject + '@example.test', email_verified: true, name: 'Revenda Google QA' }).setProtectedHeader({ alg: 'RS256', kid: 'commercial-qa' }).setIssuer('https://accounts.google.com').setAudience(f.clientId).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(f.pair.privateKey);
    return f.request('/api/auth/google', { method: 'POST', cookie: challenge.cookie, body: { fiscalDocument: syntheticFiscalDocument(), credential, accountKind } });
  };
  const signed = await googleLogin('reseller'); assert.equal(signed.status, 200);
  const boot = await f.request('/api/bootstrap', { cookie: signed.cookie }); assert.equal(boot.status, 200);
  assert.equal(boot.data.reseller.accountKind, 'reseller'); assert.equal(boot.data.reseller.parentWorkspaceId, 'mep-demo'); assert.equal(boot.data.session.platformOwner, false); assert.equal(boot.data.workspaces.length, 1);
  assert.equal((await f.request('/api/platform/accounts', { cookie: signed.cookie })).status, 403);
  const existing = await googleLogin('business'); assert.equal(existing.status, 200);
  const same = await f.request('/api/bootstrap', { cookie: existing.cookie }); assert.equal(same.data.session.userId, boot.data.session.userId); assert.equal(same.data.session.resellerId, boot.data.session.resellerId); assert.equal(same.data.reseller.accountKind, 'reseller');
  assert.equal((await googleLogin('platform', 'commercial-platform-forged')).status, 400);
  assert.equal(db.prepare('SELECT count(*) n FROM resellers').get().n, before + 1); assert.equal(db.prepare('SELECT count(*) n FROM auth_users').get().n, 2); noExternal(f);
});

test('HTTP financeiro plataforma/revenda/cliente inclui serviço de agente, edição CAS e histórico recebido limitado', async t => {
  const f = await fixture(t), c = await commerce(f);
  const terms = { requestId: randomUUID(), name: 'Contrato QA', currency: 'BRL', items: [{ kind: 'subscription', label: 'Atendimento QA', unitCents: 10000, units: 1, metered: false }, { kind: 'agent_service', label: 'Agente QA', unitCents: 2500, units: 1, metered: false }], quotas: { connections: 5, agent_service: 1 }, periodMonths: 1, startsAt: '2026-10-01', endsAt: null, graceDays: 3, state: 'active', reason: 'PRIVATE_COMMERCIAL_AGREEMENT' };
  const upstream = await f.request('/api/billing/contracts', { method: 'POST', cookie: f.owner.cookie, body: { ...terms, scope: 'platform', targetWorkspaceId: c.reseller.id, targetKind: 'reseller' } }); assert.equal(upstream.status, 201);
  const downstream = await f.request('/api/billing/contracts', { method: 'POST', cookie: c.partner.cookie, body: { ...terms, requestId: randomUUID(), scope: 'workspace', targetKind: 'reseller', targetWorkspaceId: c.business.id } }); assert.equal(downstream.status, 201);
  const invoice = await f.request(`/api/billing/contracts/${downstream.data.id}/invoices`, { method: 'POST', cookie: c.partner.cookie, body: { requestId: randomUUID(), version: 1, periodStart: '2026-10-01', periodEnd: '2026-10-31', dueDate: '2026-11-05', reason: 'Fatura sintética' } }); assert.equal(invoice.status, 201); assert.equal(invoice.data.totalCents, 12500);
  const updatedItems = terms.items.map(item => item.kind === 'subscription' ? { ...item, unitCents: 9999 } : item), edit = { ...terms, requestId: randomUUID(), version: 1, items: updatedItems };
  const updated = await f.request('/api/billing/contracts/' + downstream.data.id, { method: 'PATCH', cookie: c.partner.cookie, body: edit }); assert.equal(updated.status, 200); assert.equal(updated.data.version, 2);
  assert.equal((await f.request('/api/billing/contracts/' + downstream.data.id, { method: 'PATCH', cookie: c.partner.cookie, body: { ...edit, requestId: randomUUID() } })).status, 409);
  const received = await f.request('/api/billing?view=payable', { cookie: c.customer.cookie }); assert.equal(received.status, 200); assert.equal(received.data.canManage, false); assert.equal(received.data.contracts.length, 1); assert.equal(received.data.invoices[0].totalCents, 12500);
  const detail = await f.request('/api/billing/contracts/' + downstream.data.id, { cookie: c.customer.cookie }); assert.equal(detail.status, 200); assert.deepEqual(detail.data.audit, []); assert.deepEqual(detail.data.versions, []); assert.equal(JSON.stringify(detail.data).includes(terms.reason), false);
  assert.equal((await f.request('/api/billing/contracts/' + downstream.data.id, { method: 'PATCH', cookie: c.customer.cookie, body: edit })).status, 404);
  assert.equal((await f.request('/api/billing/contracts/' + downstream.data.id, { cookie: f.owner.cookie })).status, 404);
  assert.equal((await f.request('/api/accounts/' + c.business.id, { cookie: c.partner.cookie })).data.account.onboarding.contractConfigured, true); noExternal(f);
});

async function logoutDuringBody(f, path, cookie, body, method = 'POST') {
  const sessionToken = cookie.split('=')[1], authenticate = f.app.auth.authenticate.bind(f.app.auth); let entered;
  const seen = new Promise(resolve => { entered = resolve; });
  f.app.auth.authenticate = token => { const current = authenticate(token); if (token === sessionToken) entered(); return current; };
  let pending;
  const result = new Promise((resolve, reject) => { pending = httpRequest(f.base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Transfer-Encoding': 'chunked' } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); }); pending.on('error', reject); pending.write('{'); });
  await seen; f.app.auth.logout(sessionToken); pending.end(JSON.stringify(body).slice(1));
  return result;
}
test('HTTP logout durante body parcial recusa conta, acesso principal, convite comercial e edição da filial', async t => {
  for (const operation of ['account', 'access', 'invitation', 'identity']) await t.test(operation, async sub => {
    const f = await fixture(sub), c = await commerce(f), db = f.app.store.db;
    const snapshot = () => ({ accounts: db.prepare('SELECT id,data FROM resellers ORDER BY id').all(), tenants: db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all(), users: db.prepare('SELECT id,reseller_id,role,tenant_ids FROM auth_users ORDER BY id').all(), invitations: db.prepare('SELECT id,reseller_id,issuer_workspace_id,accepted_at,revoked_at FROM auth_invitations ORDER BY id').all(), requests: db.prepare('SELECT * FROM commercial_account_requests ORDER BY request_id').all(), audits: db.prepare('SELECT * FROM commercial_account_audit ORDER BY id').all(), access: db.prepare('SELECT * FROM auth_workspace_access ORDER BY user_id,reseller_id').all(), email: db.prepare('SELECT id FROM email_outbox ORDER BY id').all(), outbox: db.prepare('SELECT id FROM outbound_commands ORDER BY id').all() });
    const before = snapshot(); let path, cookie = f.owner.cookie, body, method = 'POST';
    if (operation === 'account') { path = '/api/accounts'; body = accountInput(); }
    if (operation === 'access') { path = `/api/accounts/${c.business.id}/platform-access`; body = { version: 1 }; }
    if (operation === 'invitation') { path = `/api/accounts/${c.business.id}/invitations`; body = { requestId: randomUUID(), sendEmail: false }; cookie = c.partner.cookie; }
    if (operation === 'identity') { path = `/api/tenants/${c.tenant.id}/identity`; body = { version: 1, name: 'Mudança tardia', segment: 'QA', parentTenantId: null }; cookie = c.customer.cookie; method = 'PATCH'; }
    assert.equal((await logoutDuringBody(f, path, cookie, body, method)).status, 401); assert.deepEqual(snapshot(), before); noExternal(f);
  });
});
