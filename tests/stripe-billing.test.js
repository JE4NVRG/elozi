import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { STRIPE_API_VERSION, StripeBilling, billingReturnTarget, stripeCheckoutEnabled, stripeConfig, stripeFetchTransport, verifyStripeSignature } from '../src/stripe-billing.js';
import { PlanQuotaGuard } from '../src/commercial-usage.js';

const SECRET_KEY = 'sk_' + 'test_fixtureOnlyKey0000';
const WEBHOOK_SECRET = 'whsec' + '_fixtureOnlySecret0000';
const ENV = { ELOZI_STRIPE_SECRET_KEY: SECRET_KEY, ELOZI_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ELOZI_STRIPE_PRICE_CONECTA: 'price_conecta', ELOZI_STRIPE_PRICE_EQUIPE: 'price_equipe',
  ELOZI_STRIPE_PRICE_OPERACAO: 'price_operacao', ELOZI_STRIPE_PRICE_EXTRA_NUMBER: 'price_extra' };
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const ORIGIN = 'https://elozi.test';
const VALID_CPF = '529.982.247-25';

/** Stateful fake Stripe: no network. Subscriptions are what GET /v1/subscriptions/:id returns (the source of truth). */
function fakeStripe() {
  const state = { calls: [], customers: new Map(), sessions: new Map(), subs: new Map(), taxIds: [], seq: 0, failGetSubscription: false };
  state.sub = (id, customer, status, { items = [{ price: { id: 'price_equipe' }, quantity: 1, current_period_end: 1796000000 }, { price: { id: 'price_extra' }, quantity: 2, current_period_end: 1796000000 }],
    metadata, cancel = false, trialEnd = null } = {}) => {
    const sub = { id, object: 'subscription', livemode: false, customer, status, cancel_at_period_end: cancel, trial_end: trialEnd, items: { data: items }, ...(metadata ? { metadata } : {}) };
    state.subs.set(id, sub); return sub;
  };
  state.transport = async request => {
    state.calls.push(request);
    const { method, path } = request;
    let match;
    if (method === 'POST' && path === '/v1/customers') { const id = `cus_${++state.seq}`; state.customers.set(id, request.form); return { status: 200, body: { id, object: 'customer', livemode: false } }; }
    if (method === 'POST' && (match = /^\/v1\/customers\/(cus_\w+)\/tax_ids$/.exec(path))) { state.taxIds.push({ customer: match[1], ...request.form }); return { status: 200, body: { id: 'txi_1', object: 'tax_id', livemode: false } }; }
    if (method === 'GET' && (match = /^\/v1\/customers\/(cus_\w+)$/.exec(path))) return state.customers.has(match[1]) ? { status: 200, body: { id: match[1], object: 'customer', livemode: false, email: state.customers.get(match[1]).email ?? null } } : { status: 404, body: { error: { code: 'resource_missing' } } };
    if (method === 'POST' && (match = /^\/v1\/customers\/(cus_\w+)$/.exec(path))) {
      if (!state.customers.has(match[1])) return { status: 404, body: { error: { code: 'resource_missing' } } };
      const customer = { ...state.customers.get(match[1]), ...request.form }; state.customers.set(match[1], customer);
      return { status: 200, body: { id: match[1], object: 'customer', livemode: false, email: customer.email ?? null } };
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const id = `cs_test_${++state.seq}`, session = { id, object: 'checkout.session', livemode: false, status: 'open', url: `https://checkout.stripe.test/c/${id}`, expires_at: Math.floor(NOW / 1000) + 86400 };
      state.sessions.set(id, session); return { status: 200, body: session };
    }
    if (method === 'GET' && (match = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(path))) return state.sessions.has(match[1]) ? { status: 200, body: state.sessions.get(match[1]) } : { status: 404, body: { error: { code: 'resource_missing' } } };
    if (method === 'POST' && (match = /^\/v1\/checkout\/sessions\/(cs_\w+)\/expire$/.exec(path))) { const session = state.sessions.get(match[1]); session.status = 'expired'; return { status: 200, body: session }; }
    if (method === 'GET' && (match = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(path))) {
      if (state.failGetSubscription) return { status: 500, body: { error: { code: 'api_error' } } };
      return state.subs.has(match[1]) ? { status: 200, body: structuredClone(state.subs.get(match[1])) } : { status: 404, body: { error: { code: 'resource_missing' } } };
    }
    if (method === 'POST' && (match = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(path))) {
      const sub = state.subs.get(match[1]); if (!sub) return { status: 404, body: { error: { code: 'resource_missing' } } };
      const form = request.form, next = sub.items.data.map(item => ({ ...item }));
      for (let i = 0; form[`items[${i}][id]`] !== undefined || form[`items[${i}][price]`] !== undefined; i++) {
        const id = form[`items[${i}][id]`], index = id ? next.findIndex(item => item.id === id) : -1;
        if (id && index < 0) return { status: 400, body: { error: { code: 'resource_missing' } } };
        if (form[`items[${i}][deleted]`] === 'true') { next.splice(index, 1); continue; }
        const item = index >= 0 ? next[index] : (next.push({ id: `si_new_${++state.seq}`, quantity: 1 }), next.at(-1));
        if (form[`items[${i}][price]`]) item.price = { id: form[`items[${i}][price]`] };
        if (form[`items[${i}][quantity]`]) item.quantity = Number(form[`items[${i}][quantity]`]);
      }
      sub.items = { data: next }; return { status: 200, body: structuredClone(sub) };
    }
    if (method === 'POST' && path === '/v1/billing_portal/configurations') return { status: 200, body: { id: `bpc_${++state.seq}`, object: 'billing_portal.configuration', livemode: false } };
    if (method === 'POST' && path === '/v1/billing_portal/sessions') return { status: 200, body: { id: 'bps_1', url: 'https://billing.stripe.test/p/1', livemode: false } };
    return { status: 404, body: { error: { code: 'resource_missing' } } };
  };
  return state;
}

async function fixture(t, { env = ENV, publicOrigin = '', stripeOrigin = ORIGIN, testLifecycle = () => true } = {}) {
  const key = randomBytes(32), external = [], stripe = fakeStripe();
  const deny = async () => { external.push('blocked'); throw new Error('Transporte externo bloqueado na fixture.'); };
  const stripeOptions = { env, transport: stripe.transport, now: () => NOW, logger: { error() {} }, ...(stripeOrigin !== undefined ? { publicOrigin: stripeOrigin } : {}), ...(testLifecycle ? { testLifecycle } : {}) };
  const app = createApp({ databasePath: ':memory:', publicOrigin, serviceKey: key, providerCall: deny,
    mcpFetchImpl: deny, gatewayOptions: { authKey: key, socketFactory: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: deny }, googleOptions: { clientId: '' }, stripeOptions });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.centralSupport.close();
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.webchat.close(),
      app.emailChannel.close(), app.meta.close(), app.bridge.close()]);
    app.store.close();
  });
  const db = app.store.db;
  const person = (username, workspaceId, role = 'reseller', tenantIds = [], platformAdmin = false) => {
    const row = app.auth.insertUser({ username, name: 'Fixture' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), role, tenantIds, workspaceId, { platformAdmin });
    const value = app.auth.session(row);
    return { actor: value.actor, cookie: `mep_session=${value.token}` };
  };
  const root = person('stripe.root', 'mep-demo', 'reseller', [], true);
  const account = (actor, name, accountKind, parentWorkspaceId) => app.accounts.create(actor, { requestId: randomUUID(), name, accountKind,
    parentWorkspaceId, initialTenantName: 'Unidade', segment: 'Fixture' }).account;
  const business = account(root.actor, 'Empresa A', 'business', 'mep-demo');
  const businessB = account(root.actor, 'Empresa B', 'business', 'mep-demo');
  const reseller = account(root.actor, 'Revenda', 'reseller', 'mep-demo');
  const partner = person('stripe.partner', reseller.id);
  const child = account(partner.actor, 'Cliente da revenda', 'business', reseller.id);
  const owner = person('stripe.owner', business.id), ownerB = person('stripe.ownerb', businessB.id), childOwner = person('stripe.child', child.id);
  const tenantId = db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(business.id).id;
  const operator = person('stripe.operator', business.id, 'operator', [tenantId]);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, { cookie = owner.cookie, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, data, text };
  };
  const sign = (raw, ts = Math.floor(NOW / 1000), secret = WEBHOOK_SECRET) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  let seq = 0;
  const webhook = async (type, object, { id = `evt_${++seq}`, livemode = false, signature, raw } = {}) => {
    const payload = raw ?? JSON.stringify({ id, object: 'event', type, livemode, created: 1000 + seq, data: { object } });
    return api('/api/stripe/webhook', { cookie: null, method: 'POST', body: payload, headers: { 'Stripe-Signature': signature ?? sign(payload) } });
  };
  const bindCustomer = (workspaceId, customerId) => db.prepare('INSERT INTO elozi_stripe_customers (workspace_id,livemode,customer_id,tax_id_kind,created_at) VALUES (?,?,?,?,?)').run(workspaceId, 0, customerId, null, new Date(NOW).toISOString());
  const lifecycle = id => app.accounts.lifecycle.describe(app.accounts.accountRow(id)).state;
  const setLifecycle = (id, state, extra = {}) => app.accounts.lifecycle.update(root.actor, id, { version: app.accounts.accountRow(id).version, state, reason: 'Fixture', ...(state === 'trial' ? { trialEndsAt: '2099-01-01' } : {}), ...extra });
  const checkoutBody = (workspaceId, extra = {}) => ({ workspaceId, plan: 'equipe', extraNumbers: 2, requestId: `req_${randomUUID()}`, locale: 'pt-BR', ...extra });
  const view = async (workspaceId, cookie = owner.cookie) => (await api(`/api/billing/subscription?workspaceId=${workspaceId}`, { cookie })).data;
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  return { app, db, api, webhook, sign, stripe, bindCustomer, lifecycle, setLifecycle, checkoutBody, view, count, external, base,
    root, partner, owner, ownerB, childOwner, operator, business, businessB, reseller, child };
}

const snapshot = (db, sql, ...args) => createHash('sha256').update(JSON.stringify(db.prepare(sql).all(...args))).digest('hex');
const manualContract = (f, targetWorkspaceId) => {
  f.app.billing.createContract(f.partner.actor, { requestId: randomUUID(), scope: 'workspace', targetKind: 'reseller', targetWorkspaceId: f.child.id, name: 'Manual',
    currency: 'BRL', items: [{ kind: 'connections', label: 'Conexões', unitCents: 700, units: 0, metered: true }], quotas: { connections: 3, users: 4, agent_service: 0 },
    periodMonths: 1, startsAt: '2026-01-01', endsAt: null, graceDays: 0, state: 'active', reason: 'Contrato manual existente' });
  const contract = f.db.prepare('SELECT id FROM billing_contracts ORDER BY rowid DESC LIMIT 1').get();
  if (targetWorkspaceId) f.db.prepare('UPDATE billing_contracts SET target_workspace_id=? WHERE id=?').run(targetWorkspaceId, contract.id);
  return contract;
};

test('configuration, key mode, public-origin switch and pinned API version transport', async () => {
  assert.equal(stripeConfig({}).enabled, false);
  assert.equal(stripeConfig({ ...ENV, ELOZI_STRIPE_PRICE_EXTRA_NUMBER: '' }).enabled, false);
  assert.equal(stripeConfig({ ...ENV, ELOZI_STRIPE_SECRET_KEY: 'pk_' + 'test_public000000' }).enabled, false);
  assert.equal(stripeConfig({ ...ENV, ELOZI_STRIPE_PRICE_EQUIPE: 'price_conecta' }).enabled, false, 'duplicate price ids');
  assert.equal(stripeConfig(ENV).livemode, false);
  assert.equal(stripeConfig({ ...ENV, ELOZI_STRIPE_SECRET_KEY: 'rk_' + 'live_FIXTURE000000' }).livemode, true);
  assert.equal(stripeCheckoutEnabled({ env: ENV, publicOrigin: '' }), false);
  assert.equal(stripeCheckoutEnabled({ env: ENV, publicOrigin: ORIGIN }), true);
  assert.equal(stripeCheckoutEnabled({ env: {}, publicOrigin: ORIGIN }), false);
  assert.match(STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  const seen = [];
  const transport = stripeFetchTransport('sk_' + 'test_fixtureOnlyKey0000', { fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 200, json: async () => ({ ok: true }) }; } });
  await transport({ method: 'GET', path: '/v1/subscriptions/sub_1' });
  await transport({ method: 'POST', path: '/v1/customers', form: { 'metadata[a]': 'b' }, idempotencyKey: 'k1' });
  assert.equal(seen[0].init.headers['Stripe-Version'], STRIPE_API_VERSION); assert.equal(seen[0].init.body, undefined); assert.equal(seen[0].init.headers['Content-Type'], undefined);
  assert.equal(seen[1].init.headers['Stripe-Version'], STRIPE_API_VERSION); assert.equal(seen[1].init.body, 'metadata%5Ba%5D=b'); assert.equal(seen[1].init.headers['Idempotency-Key'], 'k1');
});

test('signature verifier: raw bytes, stale and future tolerance, all candidates', () => {
  const raw = Buffer.from('{"id":"evt_1","object":"event","type":"x","data":{"object":{}}}'), ts = 1000000;
  const good = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.`).update(raw).digest('hex');
  assert.equal(verifyStripeSignature(raw, `t=${ts},v1=${'0'.repeat(64)},v1=${good}`, WEBHOOK_SECRET, ts + 299).id, 'evt_1');
  assert.throws(() => verifyStripeSignature(raw, `t=${ts},v1=${good}`, WEBHOOK_SECRET, ts + 301), { status: 400 });
  assert.throws(() => verifyStripeSignature(raw, `t=${ts},v1=${good}`, WEBHOOK_SECRET, ts - 301), { status: 400 }, 'future-dated');
  assert.throws(() => verifyStripeSignature(Buffer.from(raw.toString().replace('"x"', '"y"')), `t=${ts},v1=${good}`, WEBHOOK_SECRET, ts), { status: 400 });
  assert.throws(() => verifyStripeSignature(raw, `t=${ts},v0=${good}`, WEBHOOK_SECRET, ts), { status: 400 });
});

test('disabled: enabled:false, 503 on checkout/portal and on a validly signed webhook; no public origin also disables', async t => {
  const f = await fixture(t, { env: {} });
  assert.deepEqual(await f.view(f.business.id), { enabled: false, workspaceId: f.business.id, state: 'none', plan: null, extraNumbers: 0, currentPeriodEnd: null, cancelAtPeriodEnd: false, trial: null, trialExpired: false, quotas: null, canManage: false, manualContract: false });
  assert.equal((await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(f.business.id) })).status, 503);
  assert.equal((await f.api('/api/billing/portal', { method: 'POST', body: { workspaceId: f.business.id, requestId: 'req_portal_0001', locale: 'en' } })).status, 503);
  assert.equal((await f.webhook('invoice.paid', { customer: 'cus_1' })).status, 503, 'Stripe retries instead of losing the event');
  assert.equal(f.app.stripeBilling.subscriptionQuotas(f.business.id), null);
  const g = await fixture(t, { stripeOrigin: '' });
  assert.equal((await g.view(g.business.id)).enabled, false);
  assert.equal((await g.api('/api/billing/checkout', { method: 'POST', body: g.checkoutBody(g.business.id) })).status, 503);
  assert.equal(f.stripe.calls.length + g.stripe.calls.length, 0); assert.equal(f.external.length + g.external.length, 0);
});

test('authorization matrix: only the admin of the own direct business; support, impersonation, partner-billed and manual contract refused', async t => {
  const f = await fixture(t);
  const deny = async (cookie, workspaceId, status) => {
    const result = await f.api('/api/billing/checkout', { cookie, method: 'POST', body: f.checkoutBody(workspaceId) });
    assert.equal(result.status, status, `${workspaceId} -> ${result.text}`); assert.equal(typeof result.data.error, 'string');
  };
  await deny(f.operator.cookie, f.business.id, 403);
  await deny(f.root.cookie, 'mep-demo', 403);
  await deny(f.root.cookie, f.business.id, 403);
  await deny(f.partner.cookie, f.reseller.id, 403);
  await deny(f.childOwner.cookie, f.child.id, 403);
  await deny(f.partner.cookie, f.child.id, 403, 'reseller cannot subscribe for its child');
  await deny(f.ownerB.cookie, f.business.id, 404);
  await deny(null, f.business.id, 401);
  assert.equal((await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(f.business.id), headers: { Origin: 'https://evil.example' } })).status, 403);
  // Platform admin entering the business through workspace access (actor.resellerId === business) is not its owner.
  try {
    const columns = f.db.prepare('PRAGMA table_info(auth_workspace_access)').all();
    const values = columns.map(column => column.name === 'user_id' ? f.root.actor.userId : column.name === 'reseller_id' ? f.business.id : column.notnull && column.dflt_value === null ? (/INT/i.test(column.type) ? 0 : new Date(NOW).toISOString()) : null);
    f.db.prepare(`INSERT INTO auth_workspace_access (${columns.map(column => column.name).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
  } catch { /* the crafted actor below is refused either way */ }
  await assert.rejects(f.app.stripeBilling.checkout({ ...f.root.actor, resellerId: f.business.id }, f.checkoutBody(f.business.id)), { status: 403 });
  // Support session acting on the customer's workspace.
  await assert.rejects(f.app.stripeBilling.checkout({ ...f.owner.actor, supportGrantId: 'grant_fixture' }, f.checkoutBody(f.business.id)), { status: 403 });
  assert.equal((await f.api(`/api/billing/subscription?workspaceId=mep-demo`, { cookie: f.root.cookie })).status, 403);
  assert.equal((await f.api(`/api/billing/subscription?workspaceId=${f.reseller.id}`, { cookie: f.partner.cookie })).status, 403);
  assert.equal((await f.view(f.business.id, f.operator.cookie)).canManage, false);
  assert.equal((await f.view(f.child.id, f.childOwner.cookie)).canManage, false);
  assert.equal((await f.view(f.business.id)).canManage, true);
  // Active manual billing contract for the workspace -> 409 and canManage:false.
  manualContract(f, f.businessB.id);
  assert.equal((await f.view(f.businessB.id, f.ownerB.cookie)).canManage, false);
  await deny(f.ownerB.cookie, f.businessB.id, 409);
  assert.equal(f.stripe.calls.length, 0, 'no provider call on refusal');
});

test('checkout: customer first, card-only, tax-id field, one open session (reuse / expire / completed 409), return URLs from public origin', async t => {
  const f = await fixture(t), A = f.business.id;
  const first = await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A) });
  assert.equal(first.status, 200);
  assert.deepEqual(f.stripe.calls.map(call => `${call.method} ${call.path}`), ['POST /v1/customers', 'POST /v1/checkout/sessions']);
  const [customerCall, sessionCall] = f.stripe.calls;
  assert.equal(customerCall.form['metadata[elozi_workspace_id]'], A); assert.match(customerCall.idempotencyKey, /^elozi-customer-[a-f0-9]{64}$/);
  assert.equal(f.app.stripeBilling.customerId(A), 'cus_1', 'customer persisted before the session');
  const form = sessionCall.form;
  assert.equal(form.customer, 'cus_1'); assert.equal(form.mode, 'subscription'); assert.equal(form['payment_method_types[0]'], 'card'); assert.equal(form.currency, 'brl');
  assert.equal(Object.keys(form).some(name => name.startsWith('payment_method_types[') && name !== 'payment_method_types[0]'), false);
  assert.equal(form.client_reference_id, A); assert.equal(form['metadata[elozi_workspace_id]'], A); assert.equal(form['subscription_data[metadata][elozi_workspace_id]'], A);
  assert.equal(form['custom_fields[0][key]'], 'tax_id'); assert.equal(form['custom_fields[0][type]'], 'text');
  assert.equal(form['line_items[0][price]'], 'price_equipe'); assert.equal(form['line_items[1][price]'], 'price_extra'); assert.equal(form['line_items[1][quantity]'], '2');
  assert.equal(form['subscription_data[trial_end]'], undefined, 'no signup trial -> charged immediately');
  assert.equal(form.success_url, `${ORIGIN}/billing/return?state=success&workspace=${A}`); assert.equal(form.cancel_url, `${ORIGIN}/billing/return?state=cancel&workspace=${A}`);
  assert.match(sessionCall.idempotencyKey, /^elozi-checkout-[a-f0-9]{64}$/);
  // Same order (another tab / requestId): same URL, no provider call.
  const again = await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A) });
  assert.equal(again.data.url, first.data.url); assert.equal(f.stripe.calls.length, 2);
  // Concurrent double click with the same order still yields one session.
  const [x, y] = await Promise.all([f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A) }), f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A) })]);
  assert.equal(x.data.url, first.data.url); assert.equal(y.data.url, first.data.url); assert.equal(f.stripe.calls.length, 2);
  // Different order: the open session is expired via API, then a new one is created (customer reused).
  const changed = await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A, { plan: 'conecta', extraNumbers: 0, locale: 'en' }) });
  assert.equal(changed.status, 200); assert.notEqual(changed.data.url, first.data.url);
  assert.deepEqual(f.stripe.calls.slice(2).map(call => `${call.method} ${call.path.replace(/cs_test_\d+/, ':id')}`), ['GET /v1/checkout/sessions/:id', 'POST /v1/checkout/sessions/:id/expire', 'POST /v1/checkout/sessions']);
  assert.equal(f.stripe.sessions.get(new URL(first.data.url).pathname.split('/').pop()).status, 'expired');
  assert.equal(f.stripe.calls.at(-1).form['line_items[1][price]'], undefined); assert.equal(f.stripe.calls.at(-1).form['custom_fields[0][label][custom]'], 'CPF or CNPJ (Brazilian tax ID)');
  // The open session got paid meanwhile: a different order is refused (no second subscription).
  f.stripe.sessions.get(new URL(changed.data.url).pathname.split('/').pop()).status = 'complete';
  const paid = await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A, { plan: 'operacao' }) });
  assert.equal(paid.status, 409);
  assert.equal(f.stripe.calls.filter(call => call.path === '/v1/checkout/sessions').length, 2);
  assert.equal(f.stripe.calls.filter(call => call.path === '/v1/customers').length, 1);
  assert.equal(f.lifecycle(A), 'active'); assert.equal(f.app.stripeBilling.subscriptionRow(A), null, 'checkout grants nothing');
  for (const body of [f.checkoutBody(A, { extraNumbers: 21 }), f.checkoutBody(A, { requestId: 'short' }), f.checkoutBody(A, { plan: 'revenda' }), f.checkoutBody(A, { locale: 'es' }), { ...f.checkoutBody(A), extra: 1 }]) {
    assert.equal((await f.api('/api/billing/checkout', { method: 'POST', body })).status, 400);
  }
});

test('signup trial: >=48h left aligns subscription trial_end to the exact expiry; <48h charges now; GET reports trialing+plan:null', async t => {
  const f = await fixture(t);
  const provision = (startOffsetDays, username) => {
    const resellerId = `reseller_${randomUUID()}`, startsAt = new Date(NOW - startOffsetDays * 86400000).toISOString(), expiresAt = new Date(Date.parse(startsAt) + 7 * 86400000).toISOString();
    f.app.store.provisionReseller({ resellerId, tenantId: `tenant_${randomUUID()}`, name: 'Cadastro', onboardingTrial: { startsAt, expiresAt } });
    const row = f.app.auth.insertUser({ username, name: 'Fixture' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], resellerId, { platformAdmin: false });
    return { resellerId, expiresAt, cookie: `mep_session=${f.app.auth.session(row).token}` };
  };
  const long = provision(2, 'trial.long'), short = provision(6, 'trial.short');
  const longView = await f.view(long.resellerId, long.cookie);
  assert.equal(longView.state, 'trialing'); assert.equal(longView.plan, null); assert.equal(longView.trial.expiresAt, long.expiresAt); assert.equal(longView.trial.daysRemaining, 5);
  assert.equal((await f.api('/api/billing/checkout', { cookie: long.cookie, method: 'POST', body: f.checkoutBody(long.resellerId) })).status, 200);
  assert.equal(f.stripe.calls.at(-1).form['subscription_data[trial_end]'], String(Math.floor(Date.parse(long.expiresAt) / 1000)));
  assert.equal(Object.keys(f.stripe.calls.at(-1).form).some(name => name.includes('trial_period_days')), false);
  assert.equal((await f.api('/api/billing/checkout', { cookie: short.cookie, method: 'POST', body: f.checkoutBody(short.resellerId) })).status, 200);
  assert.equal(f.stripe.calls.at(-1).form['subscription_data[trial_end]'], undefined);
  // Stripe subscription in trial: trialing + plan, trial from the subscription.
  const customer = f.app.stripeBilling.customerId(long.resellerId), trialEnd = Math.floor(Date.parse(long.expiresAt) / 1000);
  f.stripe.sub('sub_T', customer, 'trialing', { trialEnd });
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_T', object: 'subscription', customer })).data.outcome, 'subscription:trialing');
  const stripeTrial = await f.view(long.resellerId, long.cookie);
  assert.equal(stripeTrial.state, 'trialing'); assert.equal(stripeTrial.plan, 'equipe'); assert.equal(stripeTrial.trial.expiresAt, long.expiresAt);
  assert.equal(f.lifecycle(long.resellerId), 'active', 'paying subscriber keeps the autopilot after day 7');
});

test('webhook transport security: oversized body, livemode mismatch, thin/non-event payloads; nothing recorded', async t => {
  const f = await fixture(t);
  const big = JSON.stringify({ id: 'evt_big', object: 'event', type: 'invoice.paid', livemode: false, data: { object: { pad: 'x'.repeat(530000) } } });
  assert.equal((await f.webhook('x', {}, { raw: big })).status, 413);
  const nearLimit = JSON.stringify({ id: 'evt_mid', object: 'event', type: 'invoice.created', livemode: false, data: { object: { pad: 'x'.repeat(100000) } } });
  assert.equal((await f.webhook('x', {}, { raw: nearLimit })).status, 200, 'events above the old 32 KiB limit are accepted');
  const live = await f.webhook('customer.subscription.updated', { id: 'sub_X', customer: 'cus_1' }, { id: 'evt_live', livemode: true });
  assert.equal(live.status, 400);
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE event_id='evt_live' AND detail LIKE '%livemode-mismatch%'"), 1);
  const thin = JSON.stringify({ id: 'evt_thin', object: 'v2.core.event', type: 'v1.customer.subscription.updated', related_object: { id: 'sub_X' } });
  assert.equal((await f.webhook('x', {}, { raw: thin })).status, 400);
  const noLivemode = JSON.stringify({ id: 'evt_nolive', object: 'event', type: 'invoice.paid', data: { object: {} } });
  assert.equal((await f.webhook('x', {}, { raw: noLivemode })).status, 400);
  const raw = JSON.stringify({ id: 'evt_bad', object: 'event', type: 'invoice.paid', livemode: false, data: { object: {} } });
  assert.equal((await f.webhook('x', {}, { raw, signature: f.sign(raw, undefined, 'whsec' + '_wrongSecret000000') })).status, 400);
  assert.equal((await f.webhook('x', {}, { raw, signature: f.sign(raw, Math.floor(NOW / 1000) + 301) })).status, 400);
  assert.equal((await f.webhook('x', {}, { raw, signature: '' })).status, 400);
  assert.equal((await f.api('/api/stripe/webhook', { cookie: null })).status, 405);
  assert.deepEqual(f.db.prepare('SELECT id FROM elozi_stripe_events').all().map(row => row.id), ['evt_mid']);
});

test('webhooks: out-of-order, current-state fetch, metadata-less subscription, tax id, invoices, portal config, second subscription, cross-tenant, terminal cancel', async t => {
  const f = await fixture(t), db = f.db, A = f.business.id, B = f.businessB.id;
  manualContract(f);
  f.setLifecycle(A, 'trial');
  const untouched = () => [snapshot(db, 'SELECT * FROM resellers WHERE id NOT IN (?,?) ORDER BY id', A, B), snapshot(db, 'SELECT * FROM billing_contracts ORDER BY id')];
  const baseline = untouched();
  const checkout = await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A) });
  const sessionId = new URL(checkout.data.url).pathname.split('/').pop(), cus = f.app.stripeBilling.customerId(A);
  // subscription.updated arrives BEFORE checkout.session.completed, payload says incomplete, Stripe says active; no metadata.
  f.stripe.sub('sub_A', cus, 'active');
  const early = await f.webhook('customer.subscription.updated', { id: 'sub_A', object: 'subscription', customer: cus, status: 'incomplete' });
  assert.equal(early.data.outcome, 'subscription:active', 'metadata-missing subscription resolved via stored customer, current state applied');
  assert.equal(f.lifecycle(A), 'active');
  let current = await f.view(A);
  assert.equal(current.state, 'active'); assert.equal(current.plan, 'equipe'); assert.equal(current.extraNumbers, 2);
  assert.deepEqual(current.quotas, { whatsappNumbers: 4, users: 5 }); assert.equal(current.currentPeriodEnd, new Date(1796000000 * 1000).toISOString());
  assert.deepEqual(f.app.stripeBilling.subscriptionQuotas(A), { whatsappNumbers: 4, users: 5, plan: 'equipe', state: 'active' });
  assert.equal(f.app.stripeBilling.subscriptionQuotas(B), null);
  // Late checkout.session.completed: tax id saved on the customer, open session cleared, still active.
  const completed = { id: sessionId, object: 'checkout.session', mode: 'subscription', client_reference_id: A, metadata: { elozi_workspace_id: A }, customer: cus, subscription: 'sub_A',
    custom_fields: [{ key: 'tax_id', type: 'text', text: { value: VALID_CPF } }] };
  const late = await f.webhook('checkout.session.completed', completed, { id: 'evt_checkout' });
  assert.equal(late.data.outcome, 'subscription:active');
  assert.deepEqual(f.stripe.taxIds, [{ customer: cus, type: 'br_cpf', value: VALID_CPF }]);
  assert.equal(f.app.stripeBilling.customerRow(A).tax_id_kind, 'cpf');
  assert.equal(f.count('SELECT count(*) n FROM elozi_stripe_checkouts WHERE workspace_id=?', A), 0);
  // Match the document itself (raw digits or formatted), not a 3-digit fragment that random audit UUIDs can contain.
  const auditDump = JSON.stringify(db.prepare('SELECT * FROM elozi_stripe_audit').all());
  for (const form of [VALID_CPF, VALID_CPF.replace(/\D/g, '')]) assert.equal(auditDump.includes(form), false, 'document never stored locally');
  assert.deepEqual((await f.webhook('checkout.session.completed', completed, { id: 'evt_checkout' })).data, { received: true, duplicate: true });
  assert.equal(f.stripe.taxIds.length, 1);
  // A new checkout while live -> 409.
  assert.equal((await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A, { plan: 'operacao' }) })).status, 409);
  // Invoices: state follows the fetched subscription; past_due keeps access.
  f.stripe.subs.get('sub_A').status = 'past_due';
  assert.equal((await f.webhook('invoice.payment_failed', { customer: cus, subscription: 'sub_A' })).data.outcome, 'subscription:past_due');
  assert.equal(f.lifecycle(A), 'active'); current = await f.view(A); assert.equal(current.state, 'past_due'); assert.deepEqual(current.quotas, { whatsappNumbers: 4, users: 5 });
  f.stripe.subs.get('sub_A').status = 'active';
  assert.equal((await f.webhook('invoice.paid', { customer: cus, parent: { subscription_details: { subscription: 'sub_A', metadata: { elozi_workspace_id: A } } } })).data.outcome, 'subscription:active');
  assert.equal((await f.webhook('invoice.paid', { customer: cus, subscription: 'sub_A', subscription_details: { metadata: { elozi_workspace_id: B } } })).data.outcome, 'ignored:metadata-mismatch');
  // Portal: dedicated configuration created lazily once, then reused.
  const portal = await f.api('/api/billing/portal', { method: 'POST', body: { workspaceId: A, requestId: 'req_portal_0001', locale: 'pt-BR' } });
  assert.deepEqual(portal.data, { url: 'https://billing.stripe.test/p/1' });
  const configCalls = f.stripe.calls.filter(call => call.path === '/v1/billing_portal/configurations');
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].form['features[subscription_cancel][mode]'], 'at_period_end'); assert.equal(configCalls[0].form['features[subscription_update][enabled]'], 'false');
  assert.equal(configCalls[0].form['features[payment_method_update][enabled]'], 'true'); assert.equal(configCalls[0].form['features[invoice_history][enabled]'], 'true');
  const portalSession = f.stripe.calls.at(-1);
  assert.equal(portalSession.form.customer, cus); assert.match(portalSession.form.configuration, /^bpc_/); assert.equal(portalSession.form.return_url, `${ORIGIN}/billing/return?state=portal&workspace=${A}`);
  await f.api('/api/billing/portal', { method: 'POST', body: { workspaceId: A, requestId: 'req_portal_0002', locale: 'en' } });
  assert.equal(f.stripe.calls.filter(call => call.path === '/v1/billing_portal/configurations').length, 1);
  assert.equal((await f.api('/api/billing/portal', { method: 'POST', body: { workspaceId: A, requestId: 'req_portal_0003', locale: 'pt-BR' }, cookie: f.operator.cookie })).status, 403);
  assert.equal((await f.api('/api/billing/portal', { method: 'POST', cookie: f.ownerB.cookie, body: { workspaceId: B, requestId: 'req_portal_0004', locale: 'pt-BR' } })).status, 404);
  // Second live subscription: alert, never replaces or adds.
  f.stripe.sub('sub_A2', cus, 'active', { items: [{ price: { id: 'price_operacao' }, quantity: 1 }] });
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_A2', customer: cus })).data.outcome, 'ignored:second-subscription');
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE action='subscription.duplicate-alert'"), 1);
  assert.equal(f.app.stripeBilling.subscriptionRow(A).subscription_id, 'sub_A'); assert.equal((await f.view(A)).plan, 'equipe');
  // Unknown price (never from metadata): no entitlement change.
  f.stripe.sub('sub_A', cus, 'active', { items: [{ price: { id: 'price_foreign' }, quantity: 1 }], metadata: { elozi_workspace_id: A, elozi_plan: 'operacao' } });
  assert.equal((await f.webhook('customer.subscription.updated', { id: 'sub_A', customer: cus })).data.outcome, 'ignored:unknown-price');
  assert.equal((await f.view(A)).plan, 'equipe');
  f.stripe.sub('sub_A', cus, 'active');
  // Cross-tenant: B metadata with A's customer; unknown customer (no fetch); partner-billed child.
  f.bindCustomer(B, 'cus_B'); f.bindCustomer(f.child.id, 'cus_C');
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_B', customer: cus, metadata: { elozi_workspace_id: B } })).data.outcome, 'ignored:metadata-mismatch');
  const fetchesBefore = f.stripe.calls.length;
  assert.equal((await f.webhook('customer.subscription.updated', { id: 'sub_Z', customer: 'cus_unknown', metadata: { elozi_workspace_id: B } })).data.outcome, 'ignored:unbound-customer');
  assert.equal((await f.webhook('invoice.paid', { customer: 'cus_other_product', subscription: 'sub_Q' })).data.outcome, 'ignored:unbound-customer');
  assert.equal(f.stripe.calls.length, fetchesBefore, 'unknown customers are never fetched');
  f.stripe.sub('sub_C', 'cus_C', 'active');
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_C', customer: 'cus_C' })).data.outcome, 'ignored:not-self-serve');
  f.stripe.sub('sub_BX', 'cus_B', 'active', { metadata: { elozi_workspace_id: A } });
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_BX', customer: 'cus_B' })).data.outcome, 'ignored:metadata-mismatch');
  assert.equal((await f.view(B, f.ownerB.cookie)).state, 'none'); assert.equal(f.lifecycle(B), 'active');
  // Unknown types acknowledged once.
  const unknown = await f.webhook('customer.created', { id: 'cus_X' }, { id: 'evt_unknown' });
  assert.equal(unknown.status, 200); assert.equal(unknown.data.outcome, 'ignored');
  // Deletion -> canceled -> paused; a late updated(active) payload cannot resurrect; canceled is terminal per id.
  f.stripe.subs.get('sub_A').status = 'canceled';
  assert.equal((await f.webhook('customer.subscription.deleted', { id: 'sub_A', customer: cus, status: 'canceled' })).data.outcome, 'subscription:canceled');
  assert.equal(f.lifecycle(A), 'paused');
  assert.equal((await f.webhook('customer.subscription.updated', { id: 'sub_A', customer: cus, status: 'active' })).data.outcome, 'subscription:canceled');
  f.stripe.subs.get('sub_A').status = 'active';
  assert.equal((await f.webhook('customer.subscription.updated', { id: 'sub_A', customer: cus, status: 'active' })).data.outcome, 'ignored:terminal-subscription');
  assert.equal(f.lifecycle(A), 'paused'); assert.equal((await f.view(A)).state, 'canceled');
  // D4: canceled keeps the last plan limits (effective quotas shown in GET, same source as enforcement).
  assert.deepEqual((await f.view(A)).quotas, { whatsappNumbers: 4, users: 5 });
  assert.deepEqual(f.app.stripeBilling.subscriptionQuotas(A), { whatsappNumbers: 4, users: 5, plan: 'equipe', state: 'canceled' });
  // A new subscription after cancellation replaces the ended one.
  f.stripe.sub('sub_A3', cus, 'active', { items: [{ price: { id: 'price_conecta' }, quantity: 1 }] });
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_A3', customer: cus })).data.outcome, 'subscription:active');
  assert.equal(f.lifecycle(A), 'active', 'a pause made by the webhook can be lifted by the webhook');
  assert.deepEqual((await f.view(A)).quotas, { whatsappNumbers: 1, users: 2 });
  const record = f.app.accounts.lifecycle.describe(f.app.accounts.accountRow(A));
  assert.equal(record.changedBy.userId, 'stripe-webhook'); assert.equal(record.reason, 'Assinatura stripe: active');
  assert.equal(f.count("SELECT count(*) n FROM commercial_account_audit WHERE workspace_id=? AND actor_id='stripe-webhook'", A) >= 3, true);
  assert.deepEqual(untouched(), baseline, 'other accounts and manual contracts unchanged');
  assert.equal(f.external.length, 0);
});

test('processed only after commit: provider failure and lifecycle failure leave the event unrecorded and effects rolled back', async t => {
  const f = await fixture(t), A = f.business.id;
  f.bindCustomer(A, 'cus_A'); f.setLifecycle(A, 'trial');
  f.stripe.sub('sub_A', 'cus_A', 'active');
  f.stripe.failGetSubscription = true;
  const failed = await f.webhook('customer.subscription.created', { id: 'sub_A', customer: 'cus_A' }, { id: 'evt_retry' });
  assert.equal(failed.status, 502);
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_events WHERE id='evt_retry'"), 0);
  f.stripe.failGetSubscription = false;
  // Malformed lifecycle record: the effect throws inside the transaction -> rollback, event stays unprocessed.
  const good = f.db.prepare('SELECT data FROM resellers WHERE id=?').get(A).data;
  f.db.prepare("UPDATE resellers SET data=json_set(data,'$.commercialLifecycle.reason','') WHERE id=?").run(A);
  const broken = await f.webhook('customer.subscription.created', { id: 'sub_A', customer: 'cus_A' }, { id: 'evt_retry' });
  assert.equal(broken.status, 500);
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_events WHERE id='evt_retry'"), 0);
  assert.equal(f.app.stripeBilling.subscriptionRow(A), null, 'subscription write rolled back');
  f.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(good, A);
  const retried = await f.webhook('customer.subscription.created', { id: 'sub_A', customer: 'cus_A' }, { id: 'evt_retry' });
  assert.equal(retried.data.outcome, 'subscription:active');
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_events WHERE id='evt_retry'"), 1); assert.equal(f.lifecycle(A), 'active');
});

test('lifecycle protection: archived and a manual pause are never overridden; system pause reversible; metadata() accepts records', async t => {
  const f = await fixture(t), A = f.business.id, B = f.businessB.id;
  f.bindCustomer(A, 'cus_A'); f.bindCustomer(B, 'cus_B');
  f.setLifecycle(A, 'paused');
  f.stripe.sub('sub_A', 'cus_A', 'active');
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_A', customer: 'cus_A' })).data.outcome, 'subscription:active');
  assert.equal(f.lifecycle(A), 'paused', 'manual pause kept');
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE workspace_id=? AND action='entitlement.skipped' AND detail LIKE '%manual-pause%'", A), 1);
  f.setLifecycle(A, 'archived');
  f.stripe.subs.get('sub_A').status = 'canceled';
  await f.webhook('customer.subscription.deleted', { id: 'sub_A', customer: 'cus_A' });
  assert.equal(f.lifecycle(A), 'archived');
  f.stripe.sub('sub_B', 'cus_B', 'unpaid');
  await f.webhook('customer.subscription.updated', { id: 'sub_B', customer: 'cus_B' });
  assert.equal(f.lifecycle(B), 'paused');
  f.stripe.subs.get('sub_B').status = 'active';
  await f.webhook('invoice.paid', { customer: 'cus_B', subscription: 'sub_B' });
  assert.equal(f.lifecycle(B), 'active');
  assert.equal((await f.api('/api/bootstrap', { cookie: f.ownerB.cookie })).status, 200, 'listing/bootstrap still read the record');
  assert.throws(() => f.app.accounts.lifecycle.applyBillingState(B, 'paused', { source: 'stripe', status: 'unpaid', eventId: 'evt_x' }), { status: 500 }, 'requires the event transaction');
  assert.throws(() => f.app.accounts.transaction(() => f.app.accounts.lifecycle.applyBillingState(B, 'archived', { source: 'stripe', status: 'canceled', eventId: 'evt_x' })), { status: 500 });
});

test('test-mode keys never change the lifecycle of non-allow-listed workspaces (staging shares real data)', async t => {
  const f = await fixture(t, { testLifecycle: null }), A = f.business.id;
  f.bindCustomer(A, 'cus_A'); f.setLifecycle(A, 'trial');
  f.stripe.sub('sub_A', 'cus_A', 'active');
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_A', customer: 'cus_A' })).data.outcome, 'subscription:active');
  assert.equal(f.lifecycle(A), 'trial');
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE action='entitlement.skipped' AND detail LIKE '%test-mode%'"), 1);
});

test('tenant DTO strips Stripe keys; billing responses carry no provider ids or secrets', async t => {
  const f = await fixture(t), A = f.business.id;
  f.db.prepare("UPDATE resellers SET data=json_set(data,'$.stripeBilling',json('{\"customer\":\"cus_leak\"}'),'$.stripe','sub_leak') WHERE id=?").run(A);
  const dto = f.app.store.reseller({ resellerId: A });
  assert.equal('stripeBilling' in dto, false); assert.equal('stripe' in dto, false); assert.equal(JSON.stringify(dto).includes('cus_leak'), false);
  f.bindCustomer(A, 'cus_A'); f.stripe.sub('sub_A', 'cus_A', 'active');
  await f.webhook('customer.subscription.created', { id: 'sub_A', customer: 'cus_A' });
  const text = (await f.api(`/api/billing/subscription?workspaceId=${A}`)).text;
  for (const marker of [SECRET_KEY, WEBHOOK_SECRET, 'price_', 'cus_', 'sub_', 'bpc_']) assert.equal(text.includes(marker), false, marker);
  assert.equal(Object.keys(f.app.stripeBilling).includes('config'), false);
  assert.equal(inspect(f.app.stripeBilling, { depth: 0 }).includes(SECRET_KEY), false);
});

test('public site shows checkout copy only when Stripe billing is enabled', async t => {
  const faq = 'Como funcionam a cobrança e o cancelamento?';
  const pages = async f => { let html = ''; for (const path of ['/', '/precos']) html += await (await fetch(f.base + path)).text(); return html; };
  const on = await fixture(t, { publicOrigin: 'https://127.0.0.1', stripeOrigin: undefined });
  assert.equal(on.app.stripeBilling.enabled, true);
  assert.equal((await pages(on)).includes(faq), true);
  const off = await fixture(t, { publicOrigin: 'https://127.0.0.1', stripeOrigin: undefined, env: {} });
  assert.equal((await pages(off)).includes(faq), false);
});

// ---------------------------------------------------------------------------------------------------------------
// contract-addendum-2: D1 return route, D2 change, D4 default limits, D5 codes / expired trial / incomplete / webhook 429

const liveSub = async (f, A, cus = 'cus_A', items = [{ id: 'si_plan', price: { id: 'price_equipe' }, quantity: 1, current_period_end: 1796000000 }, { id: 'si_extra', price: { id: 'price_extra' }, quantity: 2, current_period_end: 1796000000 }], status = 'active') => {
  f.bindCustomer(A, cus); f.stripe.sub('sub_A', cus, status, { items });
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_A', customer: cus })).data.outcome, `subscription:${status}`);
};
const signupWorkspace = (f, { startOffsetDays = 2, username = `signup.${randomUUID().slice(0, 8)}` } = {}) => {
  const resellerId = `reseller_${randomUUID()}`, startsAt = new Date(NOW - startOffsetDays * 86400000).toISOString(), expiresAt = new Date(Date.parse(startsAt) + 7 * 86400000).toISOString();
  f.app.store.provisionReseller({ resellerId, tenantId: `tenant_${randomUUID()}`, name: 'Cadastro', onboardingTrial: { startsAt, expiresAt } });
  f.db.prepare('INSERT INTO signup_trial_registrations VALUES (?,?,?,?,?)').run(resellerId, createHash('sha256').update(resellerId).digest('hex'), 'cpf', startsAt, expiresAt);
  const row = f.app.auth.insertUser({ username, name: 'Fixture' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], resellerId, { platformAdmin: false });
  return { resellerId, expiresAt, cookie: `mep_session=${f.app.auth.session(row).token}` };
};

test('D1 /billing/return: strict params, no-store page without app data or script, same-site target; /?billing= is never the marketing home', async t => {
  const f = await fixture(t, { publicOrigin: 'https://127.0.0.1', stripeOrigin: undefined }), A = f.business.id;
  const get = (path, headers = {}) => fetch(f.base + path, { redirect: 'manual', headers: { Accept: 'text/html', ...headers } });
  const ok = await get(`/billing/return?state=success&workspace=${A}`), html = await ok.text();
  assert.equal(ok.status, 200); assert.match(ok.headers.get('content-type'), /^text\/html/); assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer'); assert.match(ok.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(html, new RegExp(`http-equiv="refresh" content="0;url=/\\?billing=success&amp;workspace=${A}#settings/billing"`));
  assert.equal(/<script/i.test(html), false); assert.equal(html.includes('Empresa A'), false); assert.equal(/cus_|sub_|price_/.test(html), false);
  for (const state of ['cancel', 'portal']) assert.equal(billingReturnTarget(new URLSearchParams({ state, workspace: A })), `/?billing=${state}&workspace=${A}#settings/billing`);
  for (const query of ['', 'state=success', `workspace=${A}`, `state=paid&workspace=${A}`, 'state=success&workspace=%3Cscript%3E', `state=success&workspace=${A}&next=https://evil.example`,
    `state=success&state=cancel&workspace=${A}`, `state=success&workspace=${'a'.repeat(121)}`, 'state=success&workspace=..%2F..%2Fapi']) {
    assert.equal(billingReturnTarget(new URLSearchParams(query)), '/', query);
    const page = await (await get(`/billing/return?${query}`)).text();
    assert.match(page, /content="0;url=\/"/, query); assert.equal(page.includes('<script'), false);
  }
  assert.equal((await fetch(f.base + `/billing/return?state=success&workspace=${A}`, { method: 'HEAD' })).status, 200);
  // Marketing home stays for a plain visit; with billing= the panel answers (shell or sign-in), never the marketing page.
  const home = await (await get('/')).text();
  const ret = await get(`/?billing=success&workspace=${A}`), retText = await ret.text();
  assert.notEqual(retText, home); assert.equal(ret.status, 200); assert.match(retText, /<html/i);
  // fetch() overrides Sec-Fetch-Mode, so real page loads are replayed with node:http.
  const navigate = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(f.base + path, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, text }));
    });
    req.on('error', reject); req.end();
  });
  const anonymous = await navigate(`/?billing=success&workspace=${A}`);
  assert.equal(anonymous.status, 302); assert.equal(anonymous.location, '/login');
  const signedIn = await navigate(`/?billing=cancel&workspace=${A}`, { Cookie: f.owner.cookie });
  assert.equal(signedIn.status, 200); assert.notEqual(signedIn.text, home);
  assert.equal((await navigate('/')).status, 200, 'plain anonymous home is still the marketing page');
  assert.equal(f.stripe.calls.length, 0);
});

test('D2 change: upgrade, downgrade, extra numbers add/remove from configured prices, same order 400, replay idempotent, one call under the lock', async t => {
  const f = await fixture(t), A = f.business.id;
  await liveSub(f, A);
  const change = (body, cookie = f.owner.cookie) => f.api('/api/billing/change', { cookie, method: 'POST', body: { workspaceId: A, requestId: `req_${randomUUID()}`, locale: 'pt-BR', ...body } });
  const calls = () => f.stripe.calls.map(call => `${call.method} ${call.path}`);
  const before = f.stripe.calls.length;
  const upgrade = await change({ plan: 'operacao', extraNumbers: 3, requestId: 'req_change_up_01' });
  assert.equal(upgrade.status, 200, upgrade.text);
  assert.deepEqual(Object.keys(upgrade.data).sort(), Object.keys(await f.view(A)).sort(), 'same shape as GET subscription');
  assert.equal(upgrade.data.state, 'active'); assert.equal(upgrade.data.plan, 'operacao'); assert.equal(upgrade.data.extraNumbers, 3); assert.deepEqual(upgrade.data.quotas, { whatsappNumbers: 8, users: 15 });
  assert.deepEqual(calls().slice(before), ['GET /v1/subscriptions/sub_A', 'POST /v1/subscriptions/sub_A']);
  const update = f.stripe.calls.at(-1);
  assert.deepEqual(update.form, { proration_behavior: 'create_prorations', 'metadata[elozi_workspace_id]': A, 'items[0][id]': 'si_plan', 'items[0][price]': 'price_operacao', 'items[0][quantity]': '1', 'items[1][id]': 'si_extra', 'items[1][quantity]': '3' });
  assert.match(update.idempotencyKey, /^elozi-change-[a-f0-9]{64}$/);
  assert.deepEqual(f.app.stripeBilling.subscriptionQuotas(A), { whatsappNumbers: 8, users: 15, plan: 'operacao', state: 'active' });
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE workspace_id=? AND action='subscription.changed'", A), 1);
  // Replay of the same request (lost response): same answer, no provider call. New request with the same order: 400 same_order.
  const n = f.stripe.calls.length;
  const replay = await change({ plan: 'operacao', extraNumbers: 3, requestId: 'req_change_up_01' });
  assert.equal(replay.status, 200); assert.equal(replay.data.plan, 'operacao'); assert.equal(f.stripe.calls.length, n);
  const same = await change({ plan: 'operacao', extraNumbers: 3 });
  assert.equal(same.status, 400); assert.equal(same.data.code, 'same_order'); assert.equal(typeof same.data.error, 'string'); assert.equal(f.stripe.calls.length, n);
  // Downgrade below usage is allowed; extra item removed when 0.
  const down = await change({ plan: 'conecta', extraNumbers: 0 });
  assert.equal(down.status, 200); assert.equal(down.data.plan, 'conecta'); assert.equal(down.data.extraNumbers, 0); assert.deepEqual(down.data.quotas, { whatsappNumbers: 1, users: 2 });
  assert.equal(f.stripe.calls.at(-1).form['items[1][id]'], 'si_extra'); assert.equal(f.stripe.calls.at(-1).form['items[1][deleted]'], 'true');
  // Adding extra numbers when there is no extra item: new item from the configured extra price.
  const add = await change({ plan: 'conecta', extraNumbers: 2 });
  assert.equal(add.status, 200); assert.equal(add.data.extraNumbers, 2); assert.deepEqual(add.data.quotas, { whatsappNumbers: 3, users: 2 });
  assert.equal(f.stripe.calls.at(-1).form['items[1][price]'], 'price_extra'); assert.equal(f.stripe.calls.at(-1).form['items[1][quantity]'], '2'); assert.equal(f.stripe.calls.at(-1).form['items[1][id]'], undefined);
  // Concurrent different requests with the same order: one provider update under the per-workspace lock.
  const updatesBefore = f.stripe.calls.filter(call => call.method === 'POST' && call.path === '/v1/subscriptions/sub_A').length;
  const [x, y] = await Promise.all([change({ plan: 'equipe', extraNumbers: 1 }), change({ plan: 'equipe', extraNumbers: 1 })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 400]);
  assert.equal(f.stripe.calls.filter(call => call.method === 'POST' && call.path === '/v1/subscriptions/sub_A').length, updatesBefore + 1);
  // Client price ids / unknown plans / out of range are rejected before any provider call.
  const m = f.stripe.calls.length;
  for (const body of [{ plan: 'price_operacao', extraNumbers: 0 }, { plan: 'operacao', extraNumbers: 21 }, { plan: 'operacao', extraNumbers: 1, price: 'price_x' }, { plan: 'operacao', extraNumbers: -1 }, { plan: 'operacao', locale: 'es' }]) {
    const result = await change(body); assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.data.code, 'billing_invalid_request');
  }
  assert.equal(f.stripe.calls.length, m);
  // Trialing and past_due subscriptions can change too; canceled cannot.
  f.stripe.subs.get('sub_A').status = 'past_due';
  await f.webhook('invoice.payment_failed', { customer: 'cus_A', subscription: 'sub_A' });
  assert.equal((await change({ plan: 'operacao', extraNumbers: 1 })).status, 200);
  f.stripe.subs.get('sub_A').status = 'canceled';
  await f.webhook('customer.subscription.deleted', { id: 'sub_A', customer: 'cus_A' });
  const dead = await change({ plan: 'conecta', extraNumbers: 0 });
  assert.equal(dead.status, 409); assert.equal(dead.data.code, 'billing_no_subscription');
  assert.equal(f.external.length, 0);
});

test('D2 change authz: support, impersonation, operator, other company, partner-billed, platform, manual contract and no live subscription refused without provider calls', async t => {
  const f = await fixture(t), A = f.business.id, B = f.businessB.id;
  await liveSub(f, A);
  const n = f.stripe.calls.length;
  const body = (workspaceId, extra = {}) => ({ workspaceId, plan: 'operacao', extraNumbers: 0, requestId: `req_${randomUUID()}`, locale: 'en', ...extra });
  const post = (cookie, workspaceId) => f.api('/api/billing/change', { cookie, method: 'POST', body: body(workspaceId) });
  assert.equal((await post(f.operator.cookie, A)).status, 403);
  assert.equal((await post(f.ownerB.cookie, A)).status, 404);
  assert.equal((await post(null, A)).status, 401);
  assert.equal((await post(f.root.cookie, 'mep-demo')).status, 403);
  assert.equal((await post(f.root.cookie, A)).status, 403);
  const child = await post(f.childOwner.cookie, f.child.id); assert.equal(child.status, 403); assert.equal(child.data.code, 'billing_not_self_serve');
  assert.equal((await post(f.partner.cookie, f.reseller.id)).status, 403);
  assert.equal((await f.api('/api/billing/change', { method: 'POST', body: body(A), headers: { Origin: 'https://evil.example' } })).status, 403);
  await assert.rejects(f.app.stripeBilling.change({ ...f.owner.actor, supportGrantId: 'grant_fixture' }, body(A)), { status: 403 });
  assert.deepEqual(f.app.stripeBilling.denial({ ...f.owner.actor, supportGrantId: 'grant_fixture' }, f.app.accounts.accountRow(A))?.[2], 'not_owner');
  await assert.rejects(f.app.stripeBilling.change({ ...f.root.actor, resellerId: A }, body(A)), { status: 403 });
  const none = await post(f.ownerB.cookie, B); assert.equal(none.status, 409); assert.equal(none.data.code, 'billing_no_subscription');
  manualContract(f, B);
  const manual = await post(f.ownerB.cookie, B); assert.equal(manual.status, 409); assert.equal(manual.data.code, 'manual_contract');
  assert.equal(f.stripe.calls.length, n, 'no provider call on refusal');
  assert.equal(f.app.stripeBilling.subscriptionRow(A).plan, 'equipe');
});

test('D4 default limits: signup workspace -> Conecta during/after trial and with incomplete; canceled keeps last plan; legacy/platform null; enforced with Stripe config disabled', async t => {
  const f = await fixture(t), billing = f.app.stripeBilling;
  const conecta = (state) => ({ whatsappNumbers: 1, users: 2, plan: 'conecta', state, default: true });
  const fresh = signupWorkspace(f), expired = signupWorkspace(f, { startOffsetDays: 10 });
  assert.deepEqual(billing.subscriptionQuotas(fresh.resellerId), conecta('trialing'));
  assert.deepEqual(billing.subscriptionQuotas(expired.resellerId), conecta('none'));
  assert.deepEqual((await f.view(fresh.resellerId, fresh.cookie)).quotas, { whatsappNumbers: 1, users: 2 });
  // Legacy/direct business without signup registration, platform, reseller and partner-billed: unchanged (null).
  for (const id of [f.business.id, 'mep-demo', f.reseller.id, f.child.id]) assert.equal(billing.subscriptionQuotas(id), null, id);
  assert.equal((await f.view(f.business.id)).quotas, null);
  // Real wiring: the app guard enforces the default (2 users) for the signup workspace.
  assert.deepEqual(f.app.auth.planQuota.quotas(fresh.resellerId), conecta('trialing'));
  f.app.auth.insertUser({ username: `second.${randomUUID().slice(0, 8)}`, name: 'Fixture' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], fresh.resellerId, { platformAdmin: false });
  assert.throws(() => f.app.auth.planQuota.assertUser(fresh.resellerId), { status: 409, code: 'plan_limit' });
  assert.equal(f.app.auth.planQuota.assertUser(f.business.id) ?? null, null, 'legacy workspace untouched');
  // incomplete (first payment pending) -> still the default, never the paid plan; checkout blocked with subscription_pending.
  const cus = 'cus_S'; f.bindCustomer(fresh.resellerId, cus);
  f.stripe.sub('sub_S', cus, 'incomplete', { items: [{ price: { id: 'price_operacao' }, quantity: 1 }] });
  assert.equal((await f.webhook('customer.subscription.created', { id: 'sub_S', customer: cus })).data.outcome, 'subscription:incomplete');
  assert.deepEqual(billing.subscriptionQuotas(fresh.resellerId), conecta('incomplete'));
  const pending = await f.api('/api/billing/checkout', { cookie: fresh.cookie, method: 'POST', body: f.checkoutBody(fresh.resellerId) });
  assert.equal(pending.status, 409); assert.equal(pending.data.code, 'subscription_pending'); assert.match(pending.data.error, /pendente/);
  // incomplete_expired never paid: default again, shown as no subscription.
  f.stripe.subs.get('sub_S').status = 'incomplete_expired';
  assert.equal((await f.webhook('customer.subscription.updated', { id: 'sub_S', customer: cus })).data.outcome, 'subscription:canceled');
  assert.deepEqual(billing.subscriptionQuotas(fresh.resellerId), conecta('trialing'));
  assert.equal((await f.view(fresh.resellerId, fresh.cookie)).plan, null);
  // A paid subscription replaces the default; canceled/unpaid keep the last plan.
  f.stripe.sub('sub_S2', cus, 'active', { items: [{ price: { id: 'price_equipe' }, quantity: 1 }] });
  await f.webhook('customer.subscription.created', { id: 'sub_S2', customer: cus });
  assert.deepEqual(billing.subscriptionQuotas(fresh.resellerId), { whatsappNumbers: 2, users: 5, plan: 'equipe', state: 'active' });
  f.stripe.subs.get('sub_S2').status = 'unpaid';
  await f.webhook('customer.subscription.updated', { id: 'sub_S2', customer: cus });
  assert.deepEqual(billing.subscriptionQuotas(fresh.resellerId), { whatsappNumbers: 2, users: 5, plan: 'equipe', state: 'unpaid' });
  // Missing/typo Stripe env: enforcement stays on (persisted rows + signup default).
  // N2: a disabled config reads only live rows, so a staging test-mode subscription (shared database) never sets limits;
  // test rows count only for workspaces allow-listed for test lifecycle.
  const disabled = new StripeBilling(f.app.accounts, { env: {}, now: () => NOW, logger: { error() {} } });
  assert.equal(disabled.enabled, false);
  // fresh was paused by the unpaid webhook above, so its default state is none.
  assert.deepEqual(disabled.subscriptionQuotas(fresh.resellerId), conecta('none'), 'test-mode row ignored with config disabled');
  assert.deepEqual(disabled.subscriptionQuotas(expired.resellerId), conecta('none'));
  assert.equal(disabled.subscriptionQuotas(f.business.id), null);
  const allowListed = new StripeBilling(f.app.accounts, { env: {}, now: () => NOW, logger: { error() {} }, testLifecycle: id => id === fresh.resellerId });
  assert.deepEqual(allowListed.subscriptionQuotas(fresh.resellerId), { whatsappNumbers: 2, users: 5, plan: 'equipe', state: 'unpaid' });
  f.db.prepare('UPDATE elozi_stripe_subscriptions SET livemode=1 WHERE workspace_id=?').run(fresh.resellerId);
  assert.deepEqual(disabled.subscriptionQuotas(fresh.resellerId), { whatsappNumbers: 2, users: 5, plan: 'equipe', state: 'unpaid' }, 'live row enforced with config disabled');
  f.db.prepare('UPDATE elozi_stripe_subscriptions SET livemode=0 WHERE workspace_id=?').run(fresh.resellerId);
  const guard = new PlanQuotaGuard(f.db, { subscriptionQuotas: id => allowListed.subscriptionQuotas(id) });
  assert.equal(guard.quotas(fresh.resellerId).plan, 'equipe');
  // N1: a signup that moved to a manual sales contract is no longer limited by the self-serve default.
  const sold = signupWorkspace(f);
  assert.deepEqual(billing.subscriptionQuotas(sold.resellerId), conecta('trialing'));
  manualContract(f, sold.resellerId);
  assert.equal(billing.subscriptionQuotas(sold.resellerId), null, 'manual contract: limits follow the contract');
  assert.equal(disabled.subscriptionQuotas(sold.resellerId), null);
  // N5: the subscription view says why the owner cannot subscribe.
  const soldView = await f.view(sold.resellerId, sold.cookie);
  assert.equal(soldView.canManage, false); assert.equal(soldView.manualContract, true);
  assert.equal((await f.view(fresh.resellerId, fresh.cookie)).manualContract, false);
  f.app.auth.insertUser({ username: `expired.${randomUUID().slice(0, 8)}`, name: 'Fixture' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], expired.resellerId, { platformAdmin: false });
  assert.throws(() => guard.assertUser(expired.resellerId), { status: 409, code: 'plan_limit' }, 'expired signup trial: Conecta 2 users enforced with config disabled');
});

test('D5: expired trial null + flagged, error codes on 409/403/503, webhook per-IP rate limit before buffering', async t => {
  const f = await fixture(t), A = f.business.id;
  const expired = signupWorkspace(f, { startOffsetDays: 10 });
  const view = await f.view(expired.resellerId, expired.cookie);
  assert.equal(view.trial, null); assert.equal(view.trialExpired, true); assert.equal(view.state, 'none'); assert.equal(view.canManage, true);
  const fresh = signupWorkspace(f);
  const freshView = await f.view(fresh.resellerId, fresh.cookie);
  assert.equal(freshView.trialExpired, false); assert.equal(freshView.state, 'trialing'); assert.equal(typeof freshView.trial.expiresAt, 'string');
  await liveSub(f, A);
  const exists = await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A, { plan: 'operacao' }) });
  assert.equal(exists.status, 409); assert.equal(exists.data.code, 'subscription_exists'); assert.match(exists.data.error, /Alterar plano ou números/);
  manualContract(f, f.businessB.id);
  const manual = await f.api('/api/billing/checkout', { cookie: f.ownerB.cookie, method: 'POST', body: f.checkoutBody(f.businessB.id) });
  assert.equal(manual.data.code, 'manual_contract');
  const badLocale = await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A, { locale: 'es' }) });
  assert.equal(badLocale.status, 400); assert.equal(badLocale.data.code, 'billing_invalid_request');
  await assert.rejects(f.app.stripeBilling.checkout({ ...f.owner.actor, supportGrantId: 'grant_fixture' }, f.checkoutBody(A)), { status: 403 });
  assert.equal(f.app.stripeBilling.denial({ ...f.root.actor, resellerId: A }, f.app.accounts.accountRow(A))?.[2], 'not_owner', 'platform admin entering the workspace');
  const off = await fixture(t, { env: {} });
  const unavailable = await off.api('/api/billing/change', { method: 'POST', body: { workspaceId: off.business.id, plan: 'equipe', extraNumbers: 0, requestId: 'req_disabled_01', locale: 'pt-BR' } });
  assert.equal(unavailable.status, 503); assert.equal(unavailable.data.code, 'billing_unavailable');
  const noCustomer = await f.api('/api/billing/portal', { cookie: f.ownerB.cookie, method: 'POST', body: { workspaceId: f.businessB.id, requestId: 'req_portal_nc01', locale: 'pt-BR' } });
  assert.equal(noCustomer.status, 404); assert.equal(noCustomer.data.code, 'billing_no_customer');
  // Webhook: 120 per minute per client (one already used by liveSub), refused with 429 before the body is processed.
  const statuses = [];
  for (let i = 0; i < 125; i++) statuses.push((await f.api('/api/stripe/webhook', { cookie: null, method: 'POST', body: '{}', headers: { 'Stripe-Signature': 't=1,v1=00' } })).status);
  const first = statuses.indexOf(429);
  assert.equal(first >= 115 && first <= 120, true, `first 429 at ${first}`);
  assert.equal(statuses.slice(0, first).every(status => status === 400), true); assert.equal(statuses.slice(first).every(status => status === 429), true);
  const limited = await f.webhook('invoice.paid', { customer: 'cus_A', subscription: 'sub_A' }, { id: 'evt_after_limit' });
  assert.equal(limited.status, 429); assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_events WHERE id='evt_after_limit'"), 0);
});

test('checkout prefill: owner e-mail on the Customer (new or legacy, set once, never overwritten); CPF/CNPJ field stays empty and editable', async t => {
  const f = await fixture(t), A = f.business.id, B = f.businessB.id;
  const setEmail = (username, email) => f.db.prepare('UPDATE auth_users SET email=? WHERE username=?').run(email, username);
  const sessionForms = () => f.stripe.calls.filter(call => call.path === '/v1/checkout/sessions').map(call => call.form);
  setEmail('stripe.owner', 'dona@empresa-a.com.br');
  // New customer: the owner e-mail goes on the Customer (Checkout with `customer` cannot take customer_email).
  assert.equal((await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A) })).status, 200);
  const created = f.stripe.calls.find(call => call.method === 'POST' && call.path === '/v1/customers');
  assert.equal(created.form.email, 'dona@empresa-a.com.br');
  assert.equal(f.stripe.calls.some(call => call.path.startsWith('/v1/customers/cus_')), false, 'new customer: no read-back');
  const [form] = sessionForms();
  assert.equal(form.customer, 'cus_1'); assert.equal(form.customer_email, undefined);
  // The signup document is kept only as an HMAC digest (signup_trial_registrations): nothing to prefill, field editable.
  assert.equal(Object.keys(form).some(name => name.startsWith('custom_fields[0][text][default_value]')), false);
  assert.equal(form['custom_fields[0][key]'], 'tax_id'); assert.equal(form['custom_fields[0][text][minimum_length]'], '11'); assert.equal(form['custom_fields[0][text][maximum_length]'], '18');
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE workspace_id=? AND action='customer.email_set'", A), 0);
  // Legacy customer (created before this change, no e-mail): updated once, audited, then never read again.
  f.bindCustomer(B, 'cus_L'); f.stripe.customers.set('cus_L', { name: 'Empresa B' }); setEmail('stripe.ownerb', 'dono@empresa-b.com.br');
  const first = await f.api('/api/billing/checkout', { cookie: f.ownerB.cookie, method: 'POST', body: f.checkoutBody(B) });
  assert.equal(first.status, 200);
  const update = f.stripe.calls.find(call => call.method === 'POST' && call.path === '/v1/customers/cus_L');
  assert.deepEqual(update.form, { email: 'dono@empresa-b.com.br' }); assert.match(update.idempotencyKey, /^elozi-customer-email-[a-f0-9]{64}$/);
  assert.equal(f.stripe.customers.get('cus_L').email, 'dono@empresa-b.com.br');
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE workspace_id=? AND action='customer.email_set'", B), 1);
  const before = f.stripe.calls.length;
  assert.equal((await f.api('/api/billing/checkout', { cookie: f.ownerB.cookie, method: 'POST', body: f.checkoutBody(B, { plan: 'operacao' }) })).status, 200);
  assert.equal(f.stripe.calls.slice(before).some(call => call.path.startsWith('/v1/customers')), false, 'marker: no second read/update');
  assert.equal(f.count("SELECT count(*) n FROM elozi_stripe_audit WHERE workspace_id=? AND action='customer.email_set'", B), 1);
  assert.equal(f.external.length, 0, 'no network');
});

test('checkout prefill: an existing Customer e-mail is kept; invalid or absent owner e-mail is never sent; read failure does not block checkout', async t => {
  const f = await fixture(t), A = f.business.id, B = f.businessB.id;
  // Customer already has an address: read once, not overwritten.
  f.db.prepare('UPDATE auth_users SET email=? WHERE username=?').run('dona@empresa-a.com.br', 'stripe.owner');
  f.bindCustomer(A, 'cus_K'); f.stripe.customers.set('cus_K', { email: 'financeiro@empresa-a.com.br' });
  assert.equal((await f.api('/api/billing/checkout', { method: 'POST', body: f.checkoutBody(A) })).status, 200);
  assert.deepEqual(f.stripe.calls.filter(call => call.path === '/v1/customers/cus_K').map(call => call.method), ['GET']);
  assert.equal(f.stripe.customers.get('cus_K').email, 'financeiro@empresa-a.com.br');
  // Invalid owner e-mail (and the acting owner has the same): the Customer is created without `email`.
  f.db.prepare('UPDATE auth_users SET email=? WHERE username=?').run('sem-arroba', 'stripe.ownerb');
  assert.equal((await f.api('/api/billing/checkout', { cookie: f.ownerB.cookie, method: 'POST', body: f.checkoutBody(B) })).status, 200);
  const created = f.stripe.calls.find(call => call.method === 'POST' && call.path === '/v1/customers');
  assert.equal(Object.hasOwn(created.form, 'email'), false);
  // Legacy customer unknown to the provider read: checkout still proceeds (non-blocking), and no update is attempted.
  const g = await fixture(t), C = g.business.id;
  g.db.prepare('UPDATE auth_users SET email=? WHERE username=?').run('dona@empresa-a.com.br', 'stripe.owner');
  g.bindCustomer(C, 'cus_missing');
  assert.equal((await g.api('/api/billing/checkout', { method: 'POST', body: g.checkoutBody(C) })).status, 200);
  assert.equal(g.stripe.calls.some(call => call.method === 'POST' && call.path === '/v1/customers/cus_missing'), false);
  assert.equal(g.count("SELECT count(*) n FROM elozi_stripe_settings WHERE key='customer_email:cus_missing'"), 0, 'retried on a later checkout');
  assert.equal(f.external.length + g.external.length, 0, 'no network');
});
