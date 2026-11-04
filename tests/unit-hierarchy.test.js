import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { CommercialAccounts } from '../src/commercial-accounts.js';

const status = code => error => error.status === code;
const password = () => 'Fixture-' + randomBytes(12).toString('hex');
async function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }), owner = await auth.setup({ name: 'Administrador QA', username: 'units.admin', password: password() });
  const accounts = new CommercialAccounts(store, { validateActor: value => auth.resolveActor(value), isPlatformAdmin: value => auth.isPlatformAdmin(value) });
  const create = name => accounts.create(owner.actor, { requestId: randomUUID(), name, accountKind: 'business', parentWorkspaceId: 'mep-demo' }).account;
  const business = create('Cliente A'), other = create('Cliente B');
  // Synthetic users are created through the ordinary API in their own workspace.
  const registered = await auth.register({ name: 'Admin cliente QA', company: 'Empresa das unidades', email: 'units@example.test', password: password() }, { provision: value => store.provisionReseller(value) });
  const matrix = store.list(registered.actor)[0], branch = store.createTenant(registered.actor, { name: 'Filial QA', segment: 'QA', parentTenantId: matrix.id });
  return { store, db: store.db, auth, accounts, owner, admin: registered.actor, business, other, matrix, branch };
}

test('matriz e filial recebem IDs compatíveis PG e vínculo somente dentro do workspace próprio', async t => {
  const { store, admin, matrix, branch } = await fixture(t);
  assert.match(matrix.id, /^tenant_[a-f0-9-]{36}$/); assert.match(branch.id, /^tenant_[a-f0-9-]{36}$/);
  assert.equal(store.tenant(admin, matrix.id).parentTenantId, null); assert.equal(branch.parentTenantId, matrix.id); assert.equal(branch.identityVersion, 1);
  assert.equal(store.list(admin).find(item => item.id === branch.id).parentTenantId, matrix.id);
});

test('pai estrangeiro, inexistente, auto-parent, filial de filial e ciclo são recusados sem órfãos', async t => {
  const { store, admin, matrix, branch, db, other } = await fixture(t), foreign = db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(other.id).id, before = store.list(admin).length;
  for (const [parentTenantId, code] of [[foreign, 404], ['missing', 404], [branch.id, 400], [12, 400]]) assert.throws(() => store.createTenant(admin, { name: 'Tentativa QA', segment: 'QA', parentTenantId }), status(code));
  assert.throws(() => store.updateTenantIdentity(admin, matrix.id, { version: 1, name: 'Matriz', segment: 'QA', parentTenantId: matrix.id }), status(400));
  assert.throws(() => store.updateTenantIdentity(admin, matrix.id, { version: 1, name: 'Matriz', segment: 'QA', parentTenantId: branch.id }), error => [400, 409].includes(error.status));
  assert.equal(store.list(admin).length, before); assert.equal(store.tenant(admin, matrix.id).parentTenantId, null); assert.equal(store.tenant(admin, branch.id).parentTenantId, matrix.id);
});

test('matriz com filiais não vira filial de outra matriz; filial sem filhos pode virar matriz por edição explícita', async t => {
  const { store, admin, matrix, branch } = await fixture(t), another = store.createTenant(admin, { name: 'Outra matriz', segment: 'QA' });
  assert.throws(() => store.updateTenantIdentity(admin, matrix.id, { version: 1, name: 'Matriz', segment: 'QA', parentTenantId: another.id }), status(409));
  const detached = store.updateTenantIdentity(admin, branch.id, { version: 1, name: 'Filial agora matriz', segment: 'QA', parentTenantId: null });
  assert.equal(detached.parentTenantId, null); assert.equal(detached.identityVersion, 2);
  assert.equal(store.createTenant(admin, { name: 'Filha nova', segment: 'QA', parentTenantId: branch.id }).parentTenantId, branch.id);
});

test('CAS de identidade conserva mensagens, canais, agentes e grants humanos granulares por IDs', async t => {
  const { store, auth, db, admin, branch, matrix } = await fixture(t);
  store.mutate(admin, branch.id, 'Dados sintéticos', state => {
    state.channels = [{ id: 'unit-channel', kind: 'telegram', state: 'planned', name: 'Canal QA' }]; state.agents = [{ id: 'agent-qa', state: 'planned' }];
    state.conversations = [{ id: 'conversation-qa', version: 7, channelId: 'unit-channel', messages: [{ id: 'message-qa', text: 'Mensagem preservada' }] }];
  });
  const user = await auth.createUser(admin, { name: 'Operador QA', username: 'units.operator', password: password(), role: 'operator', tenantIds: [branch.id], permissions: ['inbox.read'], scopeRules: { [branch.id]: { channelIds: ['unit-channel'] } } });
  const original = store.tenant(admin, branch.id), beforeGrants = db.prepare('SELECT role,tenant_ids,permissions,scope_rules FROM auth_users WHERE id=?').get(user.id);
  const updated = store.updateTenantIdentity(admin, branch.id, { version: 1, name: 'Filial renomeada', segment: 'Suporte atualizado', parentTenantId: matrix.id });
  assert.equal(updated.identityVersion, 2); const after = store.tenant(admin, branch.id);
  for (const field of ['channels', 'agents', 'conversations', 'brand', 'resellerId', 'id']) assert.deepEqual(after[field], original[field]);
  assert.deepEqual(db.prepare('SELECT role,tenant_ids,permissions,scope_rules FROM auth_users WHERE id=?').get(user.id), beforeGrants);
  const operator = auth.resolveActor({ userId: user.id, resellerId: admin.resellerId });
  assert.equal(auth.can(operator, 'inbox.read', { tenantId: branch.id, channelId: 'unit-channel' }), true); assert.equal(auth.can(operator, 'inbox.read', { tenantId: matrix.id }), false);
  assert.throws(() => store.updateTenantIdentity(admin, branch.id, { version: 1, name: 'Edição atrasada', segment: 'QA', parentTenantId: matrix.id }), status(409));
  assert.equal(store.tenant(admin, branch.id).name, 'Filial renomeada'); assert.equal(store.tenant(admin, branch.id).identityVersion, 2);
});

test('edição inválida ou falha na fila reverte identidade, versão, dados e auditoria', async t => {
  const { store, db, admin, branch, matrix } = await fixture(t), before = db.prepare('SELECT data FROM tenants WHERE id=?').get(branch.id).data, audit = db.prepare('SELECT count(*) n FROM audit').get().n;
  for (const extra of [{ channels: [] }, { accountKind: 'platform' }, { permissions: [] }, { version: 0 }, { name: '' }, { segment: '' }]) assert.throws(() => store.updateTenantIdentity(admin, branch.id, { version: 1, name: 'Filial', segment: 'QA', parentTenantId: matrix.id, ...extra }), error => [400, 409].includes(error.status));
  store.queuePostgres = () => { throw new Error('Fila sintética negada'); };
  assert.throws(() => store.updateTenantIdentity(admin, branch.id, { version: 1, name: 'Falha QA', segment: 'QA', parentTenantId: null }));
  assert.equal(db.prepare('SELECT data FROM tenants WHERE id=?').get(branch.id).data, before); assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n, audit);
});

test('operador de matriz não recebe filiais e operador de filial não recebe matriz ou administração', async t => {
  const { store, auth, admin, matrix, branch } = await fixture(t);
  for (const [tenant, hidden] of [[matrix, branch], [branch, matrix]]) {
    const user = await auth.createUser(admin, { name: 'Atendente QA', username: 'unit.' + randomBytes(6).toString('hex'), password: password(), role: 'operator', tenantIds: [tenant.id], permissions: ['inbox.read'] });
    const actor = auth.resolveActor({ userId: user.id, resellerId: admin.resellerId });
    assert.deepEqual(store.list(actor).map(item => item.id), [tenant.id]); assert.equal(store.list(actor)[0].parentTenantId, null);
    assert.throws(() => store.tenant(actor, hidden.id), status(403)); assert.throws(() => store.createTenant(actor, { name: 'Intrusa', segment: 'QA' }), status(403));
    assert.throws(() => store.updateTenantIdentity(actor, tenant.id, { version: 1, name: 'Intrusa', segment: 'QA', parentTenantId: null }), status(403));
  }
});

test('cadastro público default business e escolha reseller não aceitam plataforma, parent ou grants fornecidos', async t => {
  const { store, auth } = await fixture(t), provision = value => store.provisionReseller(value);
  for (const [kind, expected] of [[undefined, 'business'], ['reseller', 'reseller']]) {
    const session = await auth.register({ name: 'Pessoa QA', email: randomUUID() + '@example.test', password: password(), ...(kind ? { accountKind: kind } : {}) }, { provision });
    assert.equal(store.reseller(session.actor).accountKind, expected); assert.equal(store.reseller(session.actor).parentWorkspaceId, 'mep-demo'); assert.equal(session.actor.platformAdmin, false);
  }
  for (const extra of [{ accountKind: 'platform' }, { role: 'operator' }, { parentWorkspaceId: 'mep-demo' }, { tenantIds: [] }, { platformAdmin: true }]) await assert.rejects(auth.register({ name: 'Pessoa QA', email: randomUUID() + '@example.test', password: password(), ...extra }, { provision }), status(400));
});

test('Google validado cria business com admin próprio sem privilégios principais ou convite a outra conta', async t => {
  const { store, auth, db } = await fixture(t), beforeInvites = db.prepare('SELECT count(*) n FROM auth_invitations').get().n;
  const session = await auth.googleLogin({ sub: 'synthetic-google-commercial', name: 'Pessoa Google QA', email: 'google-units@example.test', email_verified: true }, { provision: value => store.provisionReseller(value) });
  assert.equal(store.reseller(session.actor).accountKind, 'business'); assert.equal(store.reseller(session.actor).parentWorkspaceId, 'mep-demo'); assert.equal(session.actor.platformAdmin, false); assert.equal(session.actor.role, 'reseller');
  assert.deepEqual(auth.workspaces(session.actor).map(row => row.id), [session.actor.resellerId]); assert.equal(db.prepare('SELECT count(*) n FROM auth_invitations').get().n, beforeInvites);
});
