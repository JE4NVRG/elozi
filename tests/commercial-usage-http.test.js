import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';

const privateMessage = 'PRIVATE_USAGE_CUSTOMER_MESSAGE';
const privatePhone = '5511999991234';
const privateToken = 'PRIVATE_USAGE_PROVIDER_TOKEN';
const channel = (id, transport, state, extra = {}) => ({ id, transport, state,
  kind: transport === 'baileys' ? 'whatsapp_qr' : transport === 'telegram-bot' ? 'telegram' : 'webchat',
  name: 'PRIVATE_USAGE_CHANNEL_NAME', phone: privatePhone, token: privateToken, ...extra });

function databaseSnapshot(db) {
  // Hash rows locally; no private payload is returned or printed on assertion failure.
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
    return { table: name, count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  });
}

async function fixture(t) {
  const key = randomBytes(32), external = [];
  const deny = async () => { external.push('blocked'); throw new Error('Transporte externo bloqueado na fixture.'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: deny,
    mcpFetchImpl: deny, gatewayOptions: { authKey: key, socketFactory: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: deny }, googleOptions: { clientId: '' } });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.centralSupport.close();
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.webchat.close(),
      app.emailChannel.close(), app.meta.close(), app.bridge.close()]);
    app.store.close();
  });
  const person = (username, workspaceId, role = 'reseller', tenantIds = [], platformAdmin = false) => {
    const row = app.auth.insertUser({ username, name: 'PRIVATE_USAGE_USER_NAME' }, Buffer.alloc(16, 3),
      Buffer.alloc(64, 3), role, tenantIds, workspaceId, { platformAdmin });
    const session = app.auth.session(row);
    return { actor: session.actor, token: session.token, cookie: `mep_session=${session.token}` };
  };
  const root = person('usage.fixture.root', 'mep-demo', 'reseller', [], true);
  const account = (actor, name, accountKind, parentWorkspaceId) => app.accounts.create(actor, {
    requestId: randomUUID(), name, accountKind, parentWorkspaceId,
    initialTenantName: 'PRIVATE_USAGE_TENANT_NAME', segment: 'Fixture' }).account;
  const reseller = account(root.actor, 'Revenda A', 'reseller', 'mep-demo');
  const partner = person('usage.fixture.partner', reseller.id);
  const business = account(partner.actor, 'Cliente A', 'business', reseller.id);
  const secondBusiness = account(partner.actor, 'Cliente B', 'business', reseller.id);
  const secondReseller = account(root.actor, 'Revenda B', 'reseller', 'mep-demo');
  const otherPartner = person('usage.fixture.other', secondReseller.id);
  const foreignBusiness = account(otherPartner.actor, 'Cliente estrangeiro', 'business', secondReseller.id);
  const customer = person('usage.fixture.customer', business.id);
  const tenantOf = workspaceId => app.store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(workspaceId).id;
  const tenantId = tenantOf(business.id);
  const operator = person('usage.fixture.operator', business.id, 'operator', [tenantId]);
  const configure = (actor, workspaceId, channels) => {
    const id = tenantOf(workspaceId);
    app.store.mutate(actor, id, 'Fixture privada para inventário', state => {
      state.channels = channels;
      state.agents = [{ id: 'usage-hermes', name: 'PRIVATE_USAGE_AGENT_NAME', provider: 'hermes', mode: 'copilot',
        configured: true, version: 1, tools: [], endpoint: 'https://private-fixture.invalid' },
      { id: 'usage-planned', name: 'PRIVATE_USAGE_PLANNED_AGENT', provider: 'codex', configured: false }];
      state.conversations = [{ id: 'private-conversation', contact: 'PRIVATE_USAGE_CONTACT_NAME', phone: privatePhone,
        channelId: channels[0]?.id, version: 1, owner: 'queue', status: 'open',
        messages: [{ id: 'private-message', kind: 'customer', text: privateMessage }] }];
      state.contacts = [{ id: 'private-contact', name: 'PRIVATE_USAGE_CONTACT_NAME', phone: privatePhone }];
    });
    return id;
  };
  configure(partner.actor, reseller.id, [channel('reseller-tg', 'telegram-bot', 'connected')]);
  configure(customer.actor, business.id, [channel('wa-live', 'baileys', 'connected'),
    channel('wa-offline', 'baileys', 'disconnected'), channel('tg-disabled', 'telegram-bot', 'connected', { enabled: false }),
    channel('webchat-live', 'webchat', 'connected'), channel('future-unknown', 'custom-transport', 'custom-state')]);
  configure(person('usage.fixture.second.customer', secondBusiness.id).actor, secondBusiness.id,
    [channel('second-wa', 'baileys', 'disconnected')]);
  configure(person('usage.fixture.foreign.customer', foreignBusiness.id).actor, foreignBusiness.id,
    Array.from({ length: 13 }, (_, index) => channel(`foreign-wa-${index}`, 'baileys', 'connected')));
  const service = app.servicePrincipals.create(customer.actor, tenantId, { name: 'Serviço sintético', agentId: 'usage-hermes',
    capabilities: ['conversation.read'], channelIds: ['wa-live'], departmentIds: ['unassigned'],
    dailyRequests: 2, maxConcurrent: 1, ttlHours: 1 });
  const support = app.support.create(customer.actor, { requestId: randomUUID(), supportUserId: root.actor.userId,
    tenantIds: [tenantId], permissions: ['inbox.read'],
    scopeRules: { [tenantId]: { channelIds: ['wa-live'], departmentIds: ['unassigned'] } },
    reason: 'Suporte sintético em RAM', ticket: 'USAGE-QA', ttlMinutes: 5 });
  const contract = app.billing.createContract(partner.actor, { requestId: randomUUID(), scope: 'workspace',
    targetKind: 'reseller', targetWorkspaceId: business.id, name: 'Quota sintética vigente', currency: 'BRL',
    items: [{ kind: 'connections', label: 'PRIVATE_USAGE_ITEM_LABEL', unitCents: 700, units: 0, metered: true }],
    quotas: { connections: 2, users: 1, agent_service: 0 }, periodMonths: 1, startsAt: '2026-01-01', endsAt: null,
    graceDays: 0, state: 'active', reason: 'PRIVATE_USAGE_FINANCIAL_REASON' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (id, { cookie = root.cookie, scope = 'own', workspace, grant, headers = {}, query, method = 'GET' } = {}) => {
    const response = await fetch(`${base}/api/accounts/${id}/usage?${query ?? 'scope=' + scope}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(workspace ? { 'X-Elozi-Workspace': workspace } : {}),
        ...(grant ? { 'X-Elozi-Support-Grant': grant } : {}), ...headers }
    });
    return { status: response.status, data: await response.json(), allow: response.headers.get('allow') };
  };
  const assertPrivate = data => {
    const serialized = JSON.stringify(data);
    for (const marker of ['PRIVATE_USAGE_', privatePhone, privateToken, privateMessage,
      'private-conversation', 'private-contact', 'wa-live', 'private-fixture.invalid', service.token,
      root.token, customer.token, partner.token]) assert.equal(serialized.includes(marker), false, 'DTO contém dado privado.');
  };
  const assertReadonly = before => {
    assert.deepEqual(databaseSnapshot(app.store.db), before, 'GET de consumo alterou o banco.');
    assert.equal(external.length, 0);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM billing_invoices').get().n, 0);
  };
  return { app, root, partner, customer, operator, reseller, business, secondBusiness, secondReseller,
    foreignBusiness, tenantId, service, support, contract, request, assertPrivate, assertReadonly };
}

test('HTTP consumo da própria empresa separa transportes/estados e quota sem cobrar ou abrir atendimento', async t => {
  const f = await fixture(t), before = databaseSnapshot(f.app.store.db);
  const own = await f.request(f.business.id, { cookie: f.customer.cookie });
  assert.equal(own.status, 200, own.data.error);
  assert.equal(own.data.account.id, f.business.id);
  assert.equal(own.data.scope, 'own');
  assert.deepEqual(own.data.includedAccounts, { count: 1, ids: [f.business.id] });
  assert.equal(own.data.inventory.tenants, 1);
  assert.deepEqual(Object.fromEntries(['registered', 'connected', 'disconnected', 'disabled', 'unknown']
    .map(key => [key, own.data.inventory.channels[key]])), { registered: 5, connected: 2, disconnected: 1, disabled: 1, unknown: 1 });
  assert.equal(own.data.inventory.channels.byTransport.length, 8);
  const transports = Object.fromEntries(own.data.inventory.channels.byTransport.map(item => [item.transport, item]));
  assert.equal(transports.baileys.registered, 2);
  assert.equal(transports.baileys.connected, 1);
  assert.equal(transports['telegram-bot'].disabled, 1);
  assert.equal(transports.other.unknown, 1);
  assert.equal(transports.email.registered, 0);
  assert.equal(own.data.inventory.users.active, 2);
  assert.deepEqual(own.data.inventory.agents, { registered: 2, configured: 1 });
  assert.deepEqual(own.data.inventory.servicePrincipals, { active: 1 });
  assert.equal(own.data.definitions.quotaPreviewOnly, true);
  assert.equal(own.data.quotas.length, 1);
  assert.equal(own.data.quotas[0].id, f.contract.id);
  assert.equal(own.data.quotas[0].revision, 1);
  const connection = own.data.quotas[0].lines.find(line => line.metric === 'connections');
  assert.equal(connection.quantity, 3);
  assert.equal(connection.limit, 2);
  assert.equal(connection.excess, 1);
  assert.equal(connection.remaining, 0);
  f.assertPrivate(own.data); f.assertReadonly(before);
});

test('HTTP principal e revenda leem carteira autorizada sem herança de atendimento ou cliente estrangeiro', async t => {
  const f = await fixture(t), before = databaseSnapshot(f.app.store.db);
  const rootChild = await f.request(f.business.id);
  assert.equal(rootChild.status, 200, rootChild.data.error); f.assertPrivate(rootChild.data);
  const partnerChild = await f.request(f.business.id, { cookie: f.partner.cookie });
  assert.equal(partnerChild.status, 200, partnerChild.data.error); f.assertPrivate(partnerChild.data);
  const portfolio = await f.request(f.reseller.id, { cookie: f.partner.cookie, scope: 'portfolio' });
  assert.equal(portfolio.status, 200, portfolio.data.error);
  assert.equal(portfolio.data.includedAccounts.count, 3);
  assert.deepEqual([...portfolio.data.includedAccounts.ids].sort(), [f.reseller.id, f.business.id, f.secondBusiness.id].sort());
  assert.equal(portfolio.data.inventory.channels.registered, 7);
  assert.equal(portfolio.data.inventory.channels.connected, 3);
  assert.equal(portfolio.data.inventory.channels.disabled, 1);
  assert.equal(portfolio.data.inventory.channels.unknown, 1);
  assert.equal(portfolio.data.includedAccounts.ids.includes(f.foreignBusiness.id), false);
  assert.equal((await f.request(f.foreignBusiness.id, { cookie: f.partner.cookie })).status, 404);
  assert.equal((await f.request(f.secondReseller.id, { cookie: f.partner.cookie, scope: 'portfolio' })).status, 404);
  assert.equal((await f.request(f.business.id, { cookie: f.customer.cookie, scope: 'portfolio' })).status, 403);
  const platform = await f.request('mep-demo', { scope: 'portfolio' });
  assert.equal(platform.status, 200, platform.data.error);
  assert.equal(platform.data.includedAccounts.ids.includes(f.foreignBusiness.id), true);
  f.assertPrivate(portfolio.data); f.assertPrivate(platform.data); f.assertReadonly(before);
});

test('HTTP consumo recusa operador, serviço, suporte e header que tenta ampliar workspace', async t => {
  const f = await fixture(t), before = databaseSnapshot(f.app.store.db);
  assert.equal((await f.request(f.business.id, { cookie: '' })).status, 401);
  assert.equal((await f.request(f.business.id, { cookie: f.operator.cookie,
    headers: { 'X-Elozi-Role': 'reseller', 'X-Elozi-Platform-Admin': 'true' } })).status, 403);
  assert.equal((await f.request(f.business.id, { cookie: '', headers: { Authorization: `Bearer ${f.service.token}` } })).status, 401);
  assert.equal((await f.request(f.business.id, { cookie: `mep_session=${f.service.token}` })).status, 401);
  assert.equal((await f.request(f.business.id, { workspace: f.business.id, grant: f.support.id })).status, 403);
  assert.equal((await f.request(f.business.id, { cookie: f.partner.cookie, workspace: f.business.id })).status, 403);
  assert.equal((await f.request(f.foreignBusiness.id, { cookie: f.partner.cookie, workspace: f.secondReseller.id })).status, 403);
  assert.equal((await f.request(f.reseller.id, { cookie: f.customer.cookie,
    headers: { 'X-Elozi-Platform-Admin': 'true', 'X-Elozi-Account': f.reseller.id } })).status, 404);
  f.assertReadonly(before);
});

test('HTTP query de consumo é estrita; respostas repetidas conservam banco e revisão financeira', async t => {
  const f = await fixture(t), before = databaseSnapshot(f.app.store.db);
  for (const query of ['scope=unknown', 'scope=', 'scope=own&scope=portfolio', 'scope=own&tenantId=' + f.tenantId,
    'scope=own&workspaceId=' + f.foreignBusiness.id, 'scope=own&send=true']) {
    const result = await f.request(f.business.id, { query });
    assert.equal(result.status, 400, `Query deve ser recusada: ${query}`);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const result = await f.request(f.business.id, { method });
    assert.equal(result.status, 405);
    assert.equal(result.allow, 'GET');
  }
  const first = await f.request(f.business.id, { cookie: f.customer.cookie }),
    repeated = await f.request(f.business.id, { cookie: f.customer.cookie });
  assert.equal(first.status, 200); assert.equal(repeated.status, 200);
  const { measuredAt: firstTime, ...firstStable } = first.data,
    { measuredAt: repeatedTime, ...repeatedStable } = repeated.data;
  assert.ok(Number.isFinite(Date.parse(firstTime))); assert.ok(Number.isFinite(Date.parse(repeatedTime)));
  assert.deepEqual(repeatedStable, firstStable);
  assert.equal(f.app.store.db.prepare('SELECT version FROM billing_contracts WHERE id=?').get(f.contract.id).version, 1);
  f.assertPrivate(first.data); f.assertReadonly(before);
});
