import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { CommercialAccounts } from '../src/commercial-accounts.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { PlanQuotaGuard, PLAN_LIMIT_CODE, PLAN_LIMIT_WHATSAPP_MESSAGE, PLAN_LIMIT_USERS_MESSAGE } from '../src/commercial-usage.js';
import { shellTranslations } from '../public/locales-shell.js';

const planLimit = (resource) => error => error.status === 409 && error.code === PLAN_LIMIT_CODE && error.resource === resource;
const noSocket = () => { throw new Error('No socket in quota tests.'); };

function waFixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const quotas = new Map();
  const guard = new PlanQuotaGuard(store.db, { subscriptionQuotas: workspaceId => quotas.get(workspaceId) ?? null });
  const gateway = new WhatsAppGateway(store, { socketFactory: noSocket, planQuota: guard });
  const workspace = (name) => {
    const resellerId = 'reseller_' + randomUUID(), tenantId = 'tenant_' + randomUUID();
    store.provisionReseller({ resellerId, tenantId, name });
    return { resellerId, tenantId, actor: { role: 'reseller', resellerId, name: 'QA' } };
  };
  let seq = 0;
  // Same order as POST /api/tenants/:id/channels in server.js: reserveNumber inside store.mutate, then push.
  const createWhatsApp = (ws, tenantId = ws.tenantId) => {
    const number = '55119' + String(10000000 + (++seq)).slice(-8);
    const channel = { id: randomUUID(), name: 'WA ' + seq, kind: 'whatsapp_qr', state: 'disconnected', transport: 'baileys', expectedNumber: number, label: 'x' };
    store.mutate(ws.actor, tenantId, 'Número de teste cadastrado', state => { gateway.reserveNumber(channel, tenantId); state.channels.push(channel); });
    return channel;
  };
  const addChannel = (ws, channel) => store.mutate(ws.actor, ws.tenantId, 'Canal', state => { state.channels.push({ id: randomUUID(), name: 'C', state: 'disconnected', label: 'x', ...channel }); });
  return { store, guard, gateway, quotas, workspace, createWhatsApp, addChannel };
}

test('WhatsApp: within limit ok, at limit 409 plan_limit, extra number raises the limit', t => {
  const f = waFixture(t), ws = f.workspace('Conecta QA');
  f.quotas.set(ws.resellerId, { whatsappNumbers: 1, users: 2, plan: 'conecta', state: 'active' });
  f.createWhatsApp(ws);
  assert.equal(f.guard.whatsappNumbers(ws.resellerId), 1);
  const before = f.store.db.prepare('SELECT count(*) n FROM wa_number_bindings').get().n;
  assert.throws(() => f.createWhatsApp(ws), error => planLimit('whatsapp_numbers')(error) && error.message === PLAN_LIMIT_WHATSAPP_MESSAGE && error.limit === 1 && error.usage === 1);
  // The rejected mutation rolled back: no channel, no binding.
  assert.equal(f.guard.whatsappNumbers(ws.resellerId), 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wa_number_bindings').get().n, before);
  f.quotas.set(ws.resellerId, { whatsappNumbers: 2, users: 2, plan: 'conecta', state: 'active' }); // + extra_number
  f.createWhatsApp(ws);
  assert.throws(() => f.createWhatsApp(ws), planLimit('whatsapp_numbers'));
});

test('WhatsApp: counts every tenant of the workspace; Telegram/webchat/Meta/email and sandbox are not counted', t => {
  const f = waFixture(t), ws = f.workspace('Equipe QA');
  f.quotas.set(ws.resellerId, { whatsappNumbers: 2, users: 5, plan: 'equipe', state: 'trialing' });
  f.addChannel(ws, { kind: 'telegram', transport: 'telegram-bot' });
  f.addChannel(ws, { kind: 'telegram_user', transport: 'telegram-user' });
  f.addChannel(ws, { kind: 'webchat', transport: 'elozi-webchat' });
  f.addChannel(ws, { kind: 'instagram', transport: 'meta-instagram' });
  f.addChannel(ws, { kind: 'email', transport: 'mepmail-channel' });
  f.addChannel(ws, { kind: 'whatsapp_qr', state: 'sandbox' });
  assert.equal(f.guard.whatsappNumbers(ws.resellerId), 0);
  f.createWhatsApp(ws);
  const unit = f.store.createTenant(ws.actor, { name: 'Filial QA', segment: 'Atendimento' });
  const unitId = unit?.id ?? f.store.db.prepare('SELECT id FROM tenants WHERE reseller_id=? AND id<>?').get(ws.resellerId, ws.tenantId).id;
  f.createWhatsApp(ws, unitId);
  assert.equal(f.guard.whatsappNumbers(ws.resellerId), 2);
  assert.throws(() => f.createWhatsApp(ws), planLimit('whatsapp_numbers'));
  assert.throws(() => f.createWhatsApp(ws, unitId), planLimit('whatsapp_numbers'));
  // Telegram creation path (no reserveNumber) stays available at the WhatsApp limit.
  f.addChannel(ws, { kind: 'telegram', transport: 'telegram-bot' });
});

test('WhatsApp: re-pairing an existing channel is not double-counted and downgrade keeps existing numbers', t => {
  const f = waFixture(t), ws = f.workspace('Operacao QA');
  f.quotas.set(ws.resellerId, { whatsappNumbers: 5, users: 15, plan: 'operacao', state: 'active' });
  const channels = [f.createWhatsApp(ws), f.createWhatsApp(ws), f.createWhatsApp(ws)];
  f.quotas.set(ws.resellerId, { whatsappNumbers: 1, users: 2, plan: 'conecta', state: 'active' }); // downgrade below usage
  // start() (QR pairing / re-pairing) calls reserveNumber with the persisted channel: never blocked.
  for (const channel of channels) assert.doesNotThrow(() => f.gateway.reserveNumber(channel, ws.tenantId));
  const persisted = JSON.parse(f.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(ws.tenantId).data).channels.filter(c => c.transport === 'baileys');
  assert.equal(persisted.length, 3);
  assert.ok(persisted.every(c => c.enabled !== false));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wa_number_bindings').get().n, 3);
  assert.throws(() => f.createWhatsApp(ws), planLimit('whatsapp_numbers'));
});

test('WhatsApp: workspaces without Stripe subscription (null) are unaffected', t => {
  const f = waFixture(t), ws = f.workspace('Manual QA');
  for (let i = 0; i < 6; i++) f.createWhatsApp(ws);
  assert.equal(f.guard.whatsappNumbers(ws.resellerId), 6);
  // Platform seed tenant (mep-demo) too.
  const seed = f.store.db.prepare("SELECT id FROM tenants WHERE reseller_id='mep-demo' LIMIT 1").get().id;
  f.createWhatsApp({ actor: { role: 'reseller', resellerId: 'mep-demo', name: 'QA' }, tenantId: seed });
  // A gateway without guard keeps the historical behaviour even for a subscribed workspace.
  const plain = new WhatsAppGateway(f.store, { socketFactory: noSocket });
  f.quotas.set(ws.resellerId, { whatsappNumbers: 1, users: 1, plan: 'conecta', state: 'active' });
  const channel = { id: randomUUID(), name: 'x', kind: 'whatsapp_qr', state: 'disconnected', transport: 'baileys', expectedNumber: '5511988887777', label: 'x' };
  assert.doesNotThrow(() => f.store.mutate(ws.actor, ws.tenantId, 'x', state => { plain.reserveNumber(channel, ws.tenantId); state.channels.push(channel); }));
});

test('guard rejects malformed quotas and async lookups', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.throws(() => new PlanQuotaGuard(store.db, { subscriptionQuotas: async () => null }));
  assert.throws(() => new PlanQuotaGuard(store.db, {}));
  const guard = new PlanQuotaGuard(store.db, { subscriptionQuotas: () => ({ whatsappNumbers: '1', users: 2 }) });
  assert.throws(() => guard.assertUser('mep-demo'), error => error.status === 500);
});

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const invite = (extra = {}) => ({ requestId: randomUUID(), name: 'Pessoa QA', role: 'reseller', tenantIds: [], ...extra });
const identity = (extra = {}) => ({ name: 'Pessoa QA', username: 'qa.' + randomBytes(6).toString('hex'), password: password(), ...extra });

async function userFixture(t) {
  const store = new Store(':memory:'), key = randomBytes(32); let now = Date.now();
  t.after(() => store.close());
  const quotas = new Map();
  const guard = new PlanQuotaGuard(store.db, { subscriptionQuotas: workspaceId => quotas.get(workspaceId) ?? null, now: () => now });
  const auth = new Auth(store.db, { invitationKey: key, now: () => now, validateTenant: (actor, id) => store.tenant(actor, id), planQuota: guard });
  const owner = await auth.setup({ name: 'Administrador principal QA', username: 'qa.platform', password: password() });
  const accounts = new CommercialAccounts(store, { validateActor: value => auth.resolveActor(value), isPlatformAdmin: value => auth.isPlatformAdmin(value), now: () => now });
  auth.commercialAuthority = (actor, id) => accounts.authorizeAdministration(actor, id);
  const business = accounts.create(owner.actor, { requestId: randomUUID(), name: 'Cliente QA', accountKind: 'business', parentWorkspaceId: 'mep-demo' }).account;
  const adminInvite = await auth.createInvitation(owner.actor, invite({ role: 'reseller' }), { targetWorkspaceId: business.id });
  const admin = await auth.acceptInvitation(adminInvite.token, identity());
  return { store, auth, guard, quotas, owner, business, admin, advance(ms) { now += ms; } };
}

test('users: active users + pending invitations count; at limit 409; replay, revoke and expiry behave', async t => {
  const f = await userFixture(t);
  f.quotas.set(f.business.id, { whatsappNumbers: 1, users: 2, plan: 'conecta', state: 'active' });
  assert.equal(f.guard.users(f.business.id), 1);
  const first = invite();
  const pending = await f.auth.createInvitation(f.admin.actor, first);
  assert.equal(f.guard.users(f.business.id), 2);
  await assert.rejects(f.auth.createInvitation(f.admin.actor, invite()), error => planLimit('users')(error) && error.message === PLAN_LIMIT_USERS_MESSAGE && error.limit === 2 && error.usage === 2);
  // Idempotent replay of the same request is not a new user.
  const replay = await f.auth.createInvitation(f.admin.actor, first);
  assert.equal(replay.invitation.id, pending.invitation.id);
  // Direct user creation is blocked too.
  await assert.rejects(f.auth.createUser(f.admin.actor, { ...identity(), role: 'reseller', tenantIds: [] }), planLimit('users'));
  // Platform-issued commercial invitation into the client counts against the same workspace.
  await assert.rejects(f.auth.createInvitation(f.owner.actor, invite({ role: 'reseller' }), { targetWorkspaceId: f.business.id }), planLimit('users'));
  // Revoking frees the slot.
  f.auth.revokeInvitation(f.admin.actor, pending.invitation.id);
  assert.equal(f.guard.users(f.business.id), 1);
  const again = await f.auth.createInvitation(f.admin.actor, invite());
  // Accepting a pending invitation does not change usage and is never blocked.
  await f.auth.acceptInvitation(again.token, identity());
  assert.equal(f.guard.users(f.business.id), 2);
  await assert.rejects(f.auth.createInvitation(f.admin.actor, invite()), planLimit('users'));
});

test('users: downgrade keeps existing users and pending invitations; reactivation is blocked at limit', async t => {
  const f = await userFixture(t);
  f.quotas.set(f.business.id, { whatsappNumbers: 5, users: 15, plan: 'operacao', state: 'active' });
  const people = [];
  for (let i = 0; i < 3; i++) people.push(await f.auth.createUser(f.admin.actor, { ...identity(), role: 'reseller', tenantIds: [] }));
  const open = await f.auth.createInvitation(f.admin.actor, invite());
  f.quotas.set(f.business.id, { whatsappNumbers: 1, users: 2, plan: 'conecta', state: 'active' });
  assert.equal(f.guard.users(f.business.id), 5);
  const active = f.store.db.prepare('SELECT count(*) n FROM auth_users WHERE reseller_id=? AND disabled_at IS NULL').get(f.business.id).n;
  assert.equal(active, 4);
  // Existing pending invitation can still be accepted after downgrade.
  await f.auth.acceptInvitation(open.token, identity());
  await assert.rejects(f.auth.createInvitation(f.admin.actor, invite()), planLimit('users'));
  f.auth.disableUser(f.admin.actor, people[0].id);
  assert.throws(() => f.auth.reactivateUser(f.admin.actor, people[0].id), planLimit('users'));
  // Within limit reactivation works.
  f.quotas.set(f.business.id, { whatsappNumbers: 1, users: 15, plan: 'operacao', state: 'active' });
  assert.equal(f.auth.reactivateUser(f.admin.actor, people[0].id).disabledAt ?? null, null);
});

test('users: expired invitations stop counting; non-Stripe workspaces are unaffected', async t => {
  const f = await userFixture(t);
  for (let i = 0; i < 4; i++) await f.auth.createInvitation(f.admin.actor, invite({ expiresInHours: 1 }));
  for (let i = 0; i < 3; i++) await f.auth.createUser(f.admin.actor, { ...identity(), role: 'reseller', tenantIds: [] });
  assert.equal(f.guard.users(f.business.id), 8);
  // Platform workspace (no Stripe subscription) also unaffected.
  await f.auth.createInvitation(f.owner.actor, invite({ role: 'reseller' }));
  f.quotas.set(f.business.id, { whatsappNumbers: 1, users: 5, plan: 'equipe', state: 'active' });
  await assert.rejects(f.auth.createInvitation(f.admin.actor, invite()), planLimit('users'));
  f.advance(2 * 3600000);
  assert.equal(f.guard.users(f.business.id), 4);
  await f.auth.createInvitation(f.admin.actor, invite());
  await assert.rejects(f.auth.createInvitation(f.admin.actor, invite()), planLimit('users'));
});

test('panel locale: PT plan-limit errors have EN translations', () => {
  assert.match(shellTranslations[PLAN_LIMIT_WHATSAPP_MESSAGE], /WhatsApp number limit.*Settings › Billing/);
  assert.match(shellTranslations[PLAN_LIMIT_USERS_MESSAGE], /user limit.*Settings › Billing/);
});

test('D4: the guard enforces any non-null quota whatever its state (signup default Conecta, state none after trial)', t => {
  const f = waFixture(t), ws = f.workspace('Cadastro sem assinatura');
  f.quotas.set(ws.resellerId, { whatsappNumbers: 1, users: 2, plan: 'conecta', state: 'none', default: true });
  f.createWhatsApp(ws);
  assert.throws(() => f.createWhatsApp(ws), planLimit('whatsapp_numbers'));
  f.quotas.set(ws.resellerId, { whatsappNumbers: 1, users: 2, plan: 'conecta', state: 'incomplete', default: true });
  assert.throws(() => f.createWhatsApp(ws), planLimit('whatsapp_numbers'));
  f.quotas.set(ws.resellerId, { whatsappNumbers: 2, users: 5, plan: 'equipe', state: 'canceled' });
  f.createWhatsApp(ws);
  assert.throws(() => f.createWhatsApp(ws), planLimit('whatsapp_numbers'), 'canceled keeps the last plan limits');
});
