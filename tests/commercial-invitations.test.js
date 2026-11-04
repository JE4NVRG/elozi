import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { CommercialAccounts } from '../src/commercial-accounts.js';

const status = code => error => error.status === code;
const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const invite = (extra = {}) => ({ requestId: randomUUID(), name: 'Pessoa QA', role: 'reseller', tenantIds: [], ...extra });
const identity = (extra = {}) => ({ name: 'Pessoa QA', username: 'qa.' + randomBytes(6).toString('hex'), password: password(), ...extra });
async function fixture(t) {
  const store = new Store(':memory:'), key = randomBytes(32); let now = Date.now();
  t.after(() => store.close());
  const auth = new Auth(store.db, { invitationKey: key, now: () => now, validateTenant: (actor, id) => store.tenant(actor, id) });
  const owner = await auth.setup({ name: 'Administrador principal QA', username: 'qa.platform', password: password() });
  const accounts = new CommercialAccounts(store, { validateActor: value => auth.resolveActor(value), isPlatformAdmin: value => auth.isPlatformAdmin(value), now: () => now });
  auth.commercialAuthority = (actor, id) => accounts.authorizeAdministration(actor, id);
  const reseller = accounts.create(owner.actor, { requestId: randomUUID(), name: 'Revenda QA', accountKind: 'reseller', parentWorkspaceId: 'mep-demo' }).account;
  const adminInvite = await auth.createInvitation(owner.actor, invite(), { targetWorkspaceId: reseller.id });
  const partner = await auth.acceptInvitation(adminInvite.token, identity({ username: 'qa.partner' }));
  const business = accounts.create(partner.actor, { requestId: randomUUID(), name: 'Cliente QA', accountKind: 'business', parentWorkspaceId: reseller.id }).account;
  const tenant = store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(business.id).id;
  return { store, db: store.db, auth, accounts, owner, reseller, partner, business, tenant, advance(ms) { now += ms; } };
}

test('convite comercial armazena issuer diferente do target e cria somente admin no workspace cliente', async t => {
  const { db, auth, partner, business, reseller } = await fixture(t), beforeUsers = db.prepare('SELECT count(*) n FROM auth_users').get().n, beforeAccounts = db.prepare('SELECT count(*) n FROM resellers').get().n;
  const created = await auth.createInvitation(partner.actor, invite({ email: 'client-admin@example.test' }), { targetWorkspaceId: business.id });
  const persisted = db.prepare('SELECT * FROM auth_invitations WHERE id=?').get(created.invitation.id);
  assert.equal(persisted.issuer_workspace_id, reseller.id); assert.equal(persisted.reseller_id, business.id);
  assert.equal(auth.previewInvitation(created.token).workspace.id, business.id); assert.deepEqual(auth.previewInvitation(created.token).tenants, []);
  assert.equal(auth.listInvitations(partner.actor, { targetWorkspaceId: business.id }).length, 1);
  const accepted = await auth.acceptInvitation(created.token, identity());
  assert.equal(accepted.actor.role, 'reseller'); assert.equal(accepted.actor.resellerId, business.id); assert.equal(accepted.actor.platformAdmin, false); assert.equal(accepted.actor.emailVerified, false);
  assert.deepEqual(accepted.actor.tenantIds, []); assert.equal(db.prepare('SELECT count(*) n FROM auth_users').get().n, beforeUsers + 1); assert.equal(db.prepare('SELECT count(*) n FROM resellers').get().n, beforeAccounts);
  assert.equal(auth.workspaces(partner.actor).some(item => item.id === business.id), false);
  assert.throws(() => auth.workspaceActor(partner.actor, business.id), status(403));
  assert.deepEqual(auth.workspaces(accepted.actor).map(item => item.id), [business.id]);
  assert.equal(db.prepare('SELECT count(*) n FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(partner.actor.userId, business.id).n, 0);
  await assert.rejects(auth.acceptInvitation(created.token, identity()), status(400));
});

test('retry comercial recupera só mesmo payload/criador/target sem token em listagem', async t => {
  const { auth, partner, business, owner } = await fixture(t), body = invite(), first = await auth.createInvitation(partner.actor, body, { targetWorkspaceId: business.id });
  const replay = await auth.createInvitation(partner.actor, { ...body }, { targetWorkspaceId: business.id }); assert.deepEqual(replay, first);
  await assert.rejects(auth.createInvitation(partner.actor, { ...body, name: 'Outro nome' }, { targetWorkspaceId: business.id }), status(409));
  const platform = await auth.createInvitation(owner.actor, body, { targetWorkspaceId: business.id }); assert.notEqual(platform.token, first.token);
  const listed = auth.listInvitations(partner.actor, { targetWorkspaceId: business.id }); assert.equal(listed.length, 2);
  for (const row of listed) for (const key of ['token', 'token_hash', 'token_secret', 'creator_access', 'request_payload']) assert.equal(Object.hasOwn(row, key), false);
  assert.equal(JSON.stringify(listed).includes(first.token), false);
});

test('fornecedor só convida administrador comercial e não conceda operadores/escopos por via cruzada', async t => {
  const { auth, partner, business, tenant } = await fixture(t);
  await assert.rejects(auth.createInvitation(partner.actor, invite({ role: 'operator', tenantIds: [tenant], permissions: ['inbox.read'] }), { targetWorkspaceId: business.id }), status(400));
});

test('negativas comerciais impedem convidar/listar/revogar clientes alheios ou parent e preservam convite original', async t => {
  const { auth, accounts, partner, business, owner } = await fixture(t);
  const foreign = accounts.create(owner.actor, { requestId: randomUUID(), name: 'Cliente direto externo', accountKind: 'business', parentWorkspaceId: 'mep-demo' }).account;
  const created = await auth.createInvitation(owner.actor, invite(), { targetWorkspaceId: foreign.id });
  await assert.rejects(auth.createInvitation(partner.actor, invite(), { targetWorkspaceId: foreign.id }), status(404));
  assert.throws(() => auth.listInvitations(partner.actor, { targetWorkspaceId: foreign.id }), status(404));
  assert.throws(() => auth.revokeInvitation(partner.actor, created.invitation.id, { targetWorkspaceId: business.id }), status(404));
  assert.throws(() => auth.listInvitations({ ...partner.actor, role: 'reseller', platformAdmin: true }, { targetWorkspaceId: foreign.id }), status(404));
  assert.equal(auth.previewInvitation(created.token).workspace.id, foreign.id);
});

test('admin alvo pode revogar convite recebido e nenhum replay ou aceite recria acesso', async t => {
  const { auth, owner, partner, business } = await fixture(t), first = await auth.createInvitation(partner.actor, invite(), { targetWorkspaceId: business.id });
  const acceptedInvite = await auth.createInvitation(owner.actor, invite(), { targetWorkspaceId: business.id }), admin = await auth.acceptInvitation(acceptedInvite.token, identity());
  assert.equal(auth.listInvitations(admin.actor).some(item => item.id === first.invitation.id), true);
  assert.equal(auth.revokeInvitation(admin.actor, first.invitation.id).state, 'revoked');
  assert.throws(() => auth.previewInvitation(first.token), status(400)); await assert.rejects(auth.acceptInvitation(first.token, identity()), status(400));
});

test('criador desabilitado e mudança material de role, plataforma ou home workspace invalidam consumo/retry', async t => {
  const f = await fixture(t), body = invite(), created = await f.auth.createInvitation(f.partner.actor, body, { targetWorkspaceId: f.business.id });
  const row = f.db.prepare('SELECT role,reseller_id,platform_admin FROM auth_users WHERE id=?').get(f.partner.actor.userId), before = f.db.prepare('SELECT count(*) n FROM auth_users').get().n;
  f.db.prepare('UPDATE auth_users SET platform_admin=0 WHERE id=?').run(f.owner.actor.userId);
  for (const [sql, value] of [['disabled_at', Date.now()], ['role', 'operator'], ['platform_admin', 1], ['reseller_id', 'mep-demo']]) {
    f.db.prepare(`UPDATE auth_users SET ${sql}=? WHERE id=?`).run(value, f.partner.actor.userId);
    assert.throws(() => f.auth.previewInvitation(created.token), status(400)); await assert.rejects(f.auth.acceptInvitation(created.token, identity()), status(400));
    await assert.rejects(f.auth.createInvitation(f.partner.actor, body, { targetWorkspaceId: f.business.id }), error => [403, 409].includes(error.status));
    f.db.prepare('UPDATE auth_users SET disabled_at=NULL,role=?,reseller_id=?,platform_admin=? WHERE id=?').run(row.role, row.reseller_id, row.platform_admin, f.partner.actor.userId);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM auth_users').get().n, before);
});

test('mudança de parent ou tipo comercial invalida stamp; renomear conta/pessoa mantém o convite', async t => {
  const { db, auth, accounts, partner, business } = await fixture(t), created = await auth.createInvitation(partner.actor, invite(), { targetWorkspaceId: business.id });
  auth.updateProfile(partner.actor, { name: 'Mesmo administrador renomeado' });
  accounts.update(partner.actor, business.id, { version: 1, name: 'Cliente renomeado' }); assert.equal(auth.previewInvitation(created.token).workspace.name, 'Cliente renomeado');
  const previous = db.prepare('SELECT data FROM resellers WHERE id=?').get(business.id).data, data = JSON.parse(previous);
  for (const changes of [{ parentWorkspaceId: 'mep-demo' }, { accountKind: 'reseller' }]) {
    db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify({ ...data, ...changes }), business.id);
    assert.throws(() => auth.previewInvitation(created.token), status(400)); await assert.rejects(auth.acceptInvitation(created.token, identity()), status(400));
  }
  db.prepare('UPDATE resellers SET data=? WHERE id=?').run(previous, business.id);
});

test('aguardar chave não permite criar convite após revogação do administrador', async t => {
  const { db, auth, partner, business } = await fixture(t); let release;
  auth.invitationKey = () => new Promise(resolve => { release = resolve; });
  const before = db.prepare('SELECT count(*) n FROM auth_invitations').get().n, operation = auth.createInvitation(partner.actor, invite(), { targetWorkspaceId: business.id });
  db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), partner.actor.userId); release(randomBytes(32));
  await assert.rejects(operation, status(403)); assert.equal(db.prepare('SELECT count(*) n FROM auth_invitations').get().n, before);
});

test('aceite revalida criador depois do hash de senha e não deixa usuário/sessão parcial', async t => {
  const { db, auth, partner, business } = await fixture(t), created = await auth.createInvitation(partner.actor, invite(), { targetWorkspaceId: business.id });
  const before = { users: db.prepare('SELECT count(*) n FROM auth_users').get().n, sessions: db.prepare('SELECT count(*) n FROM auth_sessions').get().n };
  const accepting = auth.acceptInvitation(created.token, identity());
  db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), partner.actor.userId);
  await assert.rejects(accepting, status(400));
  assert.equal(db.prepare('SELECT count(*) n FROM auth_users').get().n, before.users); assert.equal(db.prepare('SELECT count(*) n FROM auth_sessions').get().n, before.sessions);
  assert.equal(db.prepare('SELECT accepted_at FROM auth_invitations WHERE id=?').get(created.invitation.id).accepted_at, null);
});

test('admin de business convida atendente granular somente nas suas unidades sem herança matriz/filial', async t => {
  const { store, db, auth, owner, business, tenant } = await fixture(t), ownerInvite = await auth.createInvitation(owner.actor, invite(), { targetWorkspaceId: business.id }), admin = await auth.acceptInvitation(ownerInvite.token, identity());
  const branch = store.createTenant(admin.actor, { name: 'Filial QA', segment: 'QA', parentTenantId: tenant });
  store.mutate(admin.actor, branch.id, 'Fixture escopo', state => { state.channels = [{ id: 'branch-channel' }]; state.departments = [{ id: 'support', name: 'Suporte', active: true }]; });
  const rules = { [branch.id]: { channelIds: ['branch-channel'], departmentIds: ['support'] } }, created = await auth.createInvitation(admin.actor, invite({ role: 'operator', tenantIds: [branch.id], permissions: ['inbox.read'], scopeRules: rules }));
  const person = await auth.acceptInvitation(created.token, identity()); assert.deepEqual(person.actor.tenantIds, [branch.id]); assert.deepEqual(person.actor.scopeRules, rules);
  assert.equal(auth.can(person.actor, 'inbox.read', { tenantId: branch.id, channelId: 'branch-channel', departmentId: 'support' }), true);
  assert.equal(auth.can(person.actor, 'inbox.read', { tenantId: tenant }), false); assert.equal(auth.can(person.actor, 'inbox.reply', { tenantId: branch.id, channelId: 'branch-channel', departmentId: 'support' }), false);
  assert.throws(() => store.tenant(person.actor, tenant), status(403)); assert.deepEqual(store.list(person.actor).map(item => item.id), [branch.id]); assert.equal(store.list(person.actor)[0].parentTenantId, null);
  const ownRow = db.prepare('SELECT reseller_id FROM auth_users WHERE id=?').get(person.actor.userId); assert.equal(ownRow.reseller_id, business.id);
});
