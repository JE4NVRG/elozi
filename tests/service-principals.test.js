import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { Outbox } from '../src/outbox.js';

const status = code => error => error.status === code;
async function fixture(t) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); new Outbox(store);
  const owner = await auth.setup({ name: 'Admin sintético', username: 'service.admin', password: 'Synthetic-admin-4567' });
  const actor = owner.actor; let clock = Date.UTC(2026, 9, 3, 12), notifications = [];
  store.mutate(actor, 'playtech-demo', 'Fixture de serviços', state => {
    state.agents = [{ id: 'hermes', name: 'Hermes sintético', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Sintético', tools: [] }];
    state.channels = [{ id: 'wa', name: 'WhatsApp sintético', kind: 'whatsapp_qr', state: 'planned' }, { id: 'tg', name: 'Telegram sintético', kind: 'telegram', state: 'planned' }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'Vendas', active: true }];
    state.conversations = [{ id: 'conv', channelId: 'wa', departmentId: 'support', version: 1, status: 'open', owner: 'human', assignedUserId: actor.userId, messages: [] }];
  });
  const services = new ServicePrincipals(store, auth, { now: () => clock, onChange: id => notifications.push(id) });
  t.after(() => store.close());
  const config = extra => ({ name: 'Hermes de atendimento', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft', 'handoff.request'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 10, dailyBudgetMicros: 1000, estimatedRequestMicros: 400, maxConcurrent: 2, ttlHours: 24, ...extra });
  const input = extra => ({ requestId: 'request_synthetic_001', capability: 'reply.draft', context: { tenantId: 'playtech-demo', agentId: 'hermes', conversationId: 'conv', conversationVersion: 1, channelId: 'wa', departmentId: 'support' }, costMicros: 400, payload: { instruction: 'Resumo sintético' }, ...extra });
  return { store, auth, actor, services, config, input, notifications, advance(ms) { clock += ms; }, create(extra) { const result = services.create(actor, 'playtech-demo', config(extra)); return { ...result, service: services.authenticate('Bearer ' + result.token) }; } };
}

test('identidade de serviço não cria humano, sessão, atribuição, outbox ou projeção; chave é hash e exibição única', async t => {
  const f = await fixture(t), { store, services, actor } = f;
  const before = JSON.stringify(store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all()), humans = store.db.prepare('SELECT count(*) n FROM auth_users').get().n, sessions = store.db.prepare('SELECT count(*) n FROM auth_sessions').get().n;
  const created = f.create(), listed = services.list(actor, 'playtech-demo');
  assert.match(created.token, /^elozi_svc_[A-Za-z0-9_-]{43}$/); assert.equal(created.service.kind, 'service');
  assert.equal(created.service.userId, undefined); assert.equal(created.service.role, undefined); assert.equal(created.service.principalId, created.principal.id);
  assert.equal(store.db.prepare('SELECT token_hash FROM service_principals').get().token_hash, createHash('sha256').update(created.token).digest('hex'));
  assert.equal(JSON.stringify(listed).includes(created.token), false); assert.equal(listed.principals[0].token_hash, undefined); assert.equal(listed.principals[0].budgetKind, 'estimated');
  assert.equal(store.db.prepare('SELECT count(*) n FROM auth_users').get().n, humans); assert.equal(store.db.prepare('SELECT count(*) n FROM auth_sessions').get().n, sessions);
  assert.equal(JSON.stringify(store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all()), before); assert.equal(store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM service_principals').all()).includes(created.token), false);
});

test('admin e workspace são confirmados no banco, sem confiar em flags do ator ou identificadores de outra empresa', async t => {
  const f = await fixture(t), user = await f.auth.createUser(f.actor, { username: 'service.operator', name: 'Pessoa sintética', password: 'Synthetic-person-4567', role: 'operator', tenantIds: ['playtech-demo'] });
  const operator = f.auth.actor(f.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(user.id));
  assert.throws(() => f.services.create({ ...operator, role: 'reseller', platformAdmin: true }, 'playtech-demo', f.config()), status(403));
  assert.throws(() => f.services.list({ ...f.actor, resellerId: 'forged-workspace' }, 'playtech-demo'), status(403));
  const created = f.create(); assert.throws(() => f.services.update(f.actor, 'studio-demo', created.principal.id, { revision: 1, name: 'Wrong company' }), status(404));
  f.store.db.prepare('UPDATE auth_users SET role=? WHERE id=?').run('operator', f.actor.userId);
  assert.throws(() => f.services.rotate(f.actor, 'playtech-demo', created.principal.id, { revision: 1 }), status(403));
});

test('token, TTL, capacidades e atores forjados são bloqueados sem elevar direitos humanos', async t => {
  const f = await fixture(t), created = f.create({ capabilities: ['conversation.read'] });
  for (const value of [created.token, 'Bearer wrong', 'Bearer ' + created.token + ' extra', '', undefined]) assert.throws(() => f.services.authenticate(value), status(401));
  assert.throws(() => f.services.revalidate({ ...created.service }, 'conversation.read', { channelId: 'wa', departmentId: 'support' }), status(401));
  assert.throws(() => f.services.revalidate(created.service, 'reply.draft', { channelId: 'wa', departmentId: 'support' }), status(403));
  assert.throws(() => f.create({ capabilities: ['autonomous.reply'] }), status(400));
  assert.throws(() => f.create({ capabilities: ['reply.draft'] }), status(400));
  f.advance(86400000); assert.throws(() => f.services.authenticate('Bearer ' + created.token), status(401));
  assert.throws(() => f.services.reserve(created.service, f.input({ capability: 'conversation.read' })), status(401));
});

test('escopo usa conversa atual; canal/departamento forjados ou outra empresa não liberam leitura e rascunho', async t => {
  const f = await fixture(t), created = f.create(), read = context => f.services.revalidate(created.service, 'conversation.read', context);
  read(f.input().context);
  for (const context of [{ ...f.input().context, tenantId: 'studio-demo' }, { ...f.input().context, agentId: 'other' }, { ...f.input().context, channelId: 'tg' }, { ...f.input().context, departmentId: 'sales' }, { ...f.input().context, conversationId: 'unknown' }]) assert.throws(() => read(context), status(403));
  f.store.mutate(f.actor, 'playtech-demo', 'Transferência sintética', state => { state.conversations[0].channelId = 'tg'; state.conversations[0].version = 2; });
  assert.throws(() => read(f.input().context), status(403));
});

test('reserva atômica e replay não duplicam cota/orçamento; payload diferente dá conflito', async t => {
  const f = await fixture(t), created = f.create(), before = f.services.reserve(created.service, f.input());
  const results = await Promise.all([Promise.resolve().then(() => f.services.reserve(created.service, f.input())), Promise.resolve().then(() => f.services.reserve(created.service, f.input()))]);
  assert.equal(before.replayed, false); assert.ok(results.every(result => result.replayed && result.receipt.id === before.receipt.id));
  assert.equal(f.services.list(f.actor, 'playtech-demo').principals[0].usage.requests, 1); assert.equal(f.services.list(f.actor, 'playtech-demo').principals[0].usage.budgetMicros, 400);
  assert.throws(() => f.services.reserve(created.service, f.input({ payload: { instruction: 'Different request' } })), status(409));
  const claims = await Promise.all([Promise.resolve().then(() => f.services.beginDispatch(created.service, before.receipt.id)), Promise.resolve().then(() => f.services.beginDispatch(created.service, before.receipt.id))]);
  assert.equal(claims.filter(result => result.dispatched).length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_principal_receipts').get().n, 1);
});

test('limites de simultaneidade e orçamento são persistidos e custo final só reduz a reserva', async t => {
  const f = await fixture(t), created = f.create({ maxConcurrent: 1 }), first = f.services.reserve(created.service, f.input());
  assert.throws(() => f.services.reserve(created.service, f.input({ requestId: 'request_synthetic_002' })), status(429));
  f.services.beginDispatch(created.service, first.receipt.id);
  assert.throws(() => f.services.complete(created.service, first.receipt.id, { state: 'confirmed', actualCostMicros: 401 }), status(400));
  const complete = f.services.complete(created.service, first.receipt.id, { state: 'confirmed', result: { runId: 'synthetic-run' }, actualCostMicros: 100 });
  assert.equal(complete.chargedCostMicros, 100); assert.equal(complete.stale, false);
  f.services.reserve(created.service, f.input({ requestId: 'request_synthetic_002', costMicros: 900 }));
  assert.equal(f.services.list(f.actor, 'playtech-demo').principals[0].usage.budgetMicros, 1000);
});

test('cota e dia UTC impedem excesso concorrente; virar o dia não altera recibo anterior', async t => {
  const f = await fixture(t), created = f.create({ dailyRequests: 1, dailyBudgetMicros: 1000 });
  const first = f.services.reserve(created.service, f.input()); f.services.beginDispatch(created.service, first.receipt.id); f.services.complete(created.service, first.receipt.id, { state: 'confirmed' });
  assert.throws(() => f.services.reserve(created.service, f.input({ requestId: 'request_synthetic_002', costMicros: 0 })), status(429));
  f.advance(12 * 3600000); const second = f.services.reserve(created.service, f.input({ requestId: 'request_synthetic_002', costMicros: 0 }));
  assert.notEqual(second.receipt.id, first.receipt.id); assert.equal(f.services.list(f.actor, 'playtech-demo').principals[0].usage.requests, 1);
  assert.equal(f.services.getReceipt(created.service, first.receipt.id).chargedCostMicros, 400);
});

test('revogação invalida reserva sem despacho, devolve orçamento e mantém recibos existentes', async t => {
  const f = await fixture(t), created = f.create(), receipt = f.services.reserve(created.service, f.input()).receipt;
  const revoked = f.services.revoke(f.actor, 'playtech-demo', created.principal.id, { revision: 1 }); assert.equal(revoked.state, 'revoked');
  assert.throws(() => f.services.authenticate('Bearer ' + created.token), status(401));
  assert.throws(() => f.services.beginDispatch(created.service, receipt.id), status(401));
  assert.throws(() => f.services.reserve(created.service, f.input()), status(401));
  const historical = f.services.receipts(f.actor, 'playtech-demo', created.principal.id).receipts[0]; assert.equal(historical.state, 'invalidated'); assert.equal(historical.chargedCostMicros, 0);
  assert.equal(revoked.usage.requests, 1); assert.equal(revoked.usage.budgetMicros, 0); assert.deepEqual(f.notifications, [created.principal.id]);
  assert.throws(() => f.services.update(f.actor, 'playtech-demo', created.principal.id, { revision: 2, active: true }), status(409));
});

test('rotação bloqueia chave anterior e todos os replays de configuração antiga; nova chave é exibida uma vez', async t => {
  const f = await fixture(t), created = f.create(), receipt = f.services.reserve(created.service, f.input()).receipt;
  const rotated = f.services.rotate(f.actor, 'playtech-demo', created.principal.id, { revision: 1 });
  assert.notEqual(rotated.token, created.token); assert.equal(rotated.principal.revision, 2); assert.equal(rotated.principal.keyRevision, 2);
  assert.throws(() => f.services.authenticate('Bearer ' + created.token), status(401));
  const fresh = f.services.authenticate('Bearer ' + rotated.token);
  assert.throws(() => f.services.reserve(fresh, f.input()), status(409));
  assert.throws(() => f.services.beginDispatch(fresh, receipt.id), status(409));
  assert.equal(JSON.stringify(f.services.list(f.actor, 'playtech-demo')).includes(rotated.token), false);
});

test('mudança de configuração revoga atores antigos e callbacks rodam após commit', async t => {
  const f = await fixture(t), created = f.create();
  f.services.onChange = id => { const manager = new ServicePrincipals(f.store, f.auth); assert.equal(manager.list(f.actor, 'playtech-demo').principals[0].revision, 2); f.notifications.push(id); };
  const updated = f.services.update(f.actor, 'playtech-demo', created.principal.id, { revision: 1, dailyRequests: 5 }); assert.equal(updated.revision, 2);
  assert.throws(() => f.services.revalidate(created.service, 'conversation.read', f.input().context), status(409));
  assert.throws(() => f.services.update(f.actor, 'playtech-demo', created.principal.id, { revision: 1, name: 'Stale edit' }), status(409));
  const fresh = f.services.authenticate('Bearer ' + created.token); f.services.reserve(fresh, f.input()); assert.equal(f.notifications.length, 1);
});

test('configuração do adaptador também invalida ator e replay anteriores sem usar administrador técnico público', async t => {
  const f = await fixture(t), created = f.create(), receipt = f.services.reserve(created.service, f.input()).receipt;
  f.store.mutate(f.actor, 'playtech-demo', 'Configuração sintética', state => { state.agents[0].version++; });
  assert.throws(() => f.services.beginDispatch(created.service, receipt.id), status(409));
  const fresh = f.services.authenticate('Bearer ' + created.token); assert.throws(() => f.services.getReceipt(fresh, receipt.id), status(409));
});

test('resultado conhecido após revogação é preservado com stale e nunca autoriza novo despacho', async t => {
  const f = await fixture(t), created = f.create(), receipt = f.services.reserve(created.service, f.input()).receipt;
  f.services.beginDispatch(created.service, receipt.id); f.services.revoke(f.actor, 'playtech-demo', created.principal.id, { revision: 1 });
  assert.throws(() => f.services.assertDispatchCurrent(created.service, receipt.id), status(401));
  const finished = f.services.complete(created.service, receipt.id, { state: 'confirmed', result: { draft: 'Resultado sintético conhecido' } });
  assert.equal(finished.state, 'confirmed'); assert.equal(finished.stale, true); assert.equal(finished.result.draft, 'Resultado sintético conhecido');
  assert.deepEqual(f.services.complete(created.service, receipt.id, { state: 'confirmed', result: { draft: 'Resultado sintético conhecido' } }), finished);
  assert.throws(() => f.services.complete(created.service, receipt.id, { state: 'failed' }), status(409));
});

test('resultado incerto conserva orçamento e recibo; nunca pode ser despachado de novo', async t => {
  const f = await fixture(t), created = f.create(), receipt = f.services.reserve(created.service, f.input()).receipt;
  f.services.beginDispatch(created.service, receipt.id); const unknown = f.services.complete(created.service, receipt.id, { state: 'unknown', actualCostMicros: 0, reason: 'Resposta sintética perdida.' });
  assert.equal(unknown.chargedCostMicros, 400); assert.equal(unknown.state, 'unknown');
  assert.equal(f.services.beginDispatch(created.service, receipt.id).dispatched, false);
  assert.equal(f.services.reserve(created.service, f.input()).replayed, true);
});

test('reserva expirada libera orçamento sem reutilizar a chave original', async t => {
  const f = await fixture(t), created = f.create({ maxConcurrent: 1 }), receipt = f.services.reserve(created.service, f.input()).receipt;
  f.advance(300000); assert.throws(() => f.services.beginDispatch(created.service, receipt.id), status(409));
  const next = f.services.reserve(created.service, f.input({ requestId: 'request_synthetic_002', costMicros: 900 })); assert.equal(next.replayed, false);
  assert.equal(f.services.getReceipt(created.service, receipt.id).state, 'invalidated'); assert.equal(f.services.list(f.actor, 'playtech-demo').principals[0].usage.budgetMicros, 900);
});

test('orçamento estimado exige preço definido; sem estimativa, limite de chamadas continua efetivo', async t => {
  const f = await fixture(t);
  assert.throws(() => f.create({ estimatedRequestMicros: 0, dailyBudgetMicros: 1000 }), status(400));
  const created = f.create({ estimatedRequestMicros: 0, dailyBudgetMicros: 0, dailyRequests: 1 });
  assert.equal(created.principal.budgetEnabled, false); assert.equal(created.principal.estimatedRequestMicros, 0);
  const receipt = f.services.reserve(created.service, f.input({ costMicros: 0 })).receipt;
  f.services.beginDispatch(created.service, receipt.id); f.services.complete(created.service, receipt.id, { state: 'confirmed' });
  assert.throws(() => f.services.reserve(created.service, f.input({ requestId: 'request_synthetic_002', costMicros: 0 })), status(429));
});

test('rascunho persistido revalida identidade e escopo depois de restart sem depender de token ou WeakMap', async t => {
  const f = await fixture(t), created = f.create(), authority = f.services.revalidate(created.service, 'reply.draft', f.input().context);
  const run = { serviceId: created.principal.id, serviceRevision: 1, serviceKeyRevision: 1, serviceAdapterHash: authority.adapterHash, tenantId: 'playtech-demo', agentId: 'hermes', conversationId: 'conv', conversationVersion: 1, channelIdAtStart: 'wa', departmentIdAtStart: 'support' };
  const restarted = new ServicePrincipals(f.store, f.auth, { now: f.services.now });
  assert.equal(restarted.runCurrent(run), true);
  for (const fields of [{ serviceId: 'unknown' }, { serviceRevision: 2 }, { serviceKeyRevision: 2 }, { serviceAdapterHash: 'forged' }, { tenantId: 'studio-demo' }, { channelIdAtStart: 'tg' }, { departmentIdAtStart: 'sales' }, { conversationVersion: 2 }]) assert.equal(restarted.runCurrent({ ...run, ...fields }), false);
  f.services.rotate(f.actor, 'playtech-demo', created.principal.id, { revision: 1 }); assert.equal(restarted.runCurrent(run), false);
});

test('despacho sem resposta perde lease por TTL e libera concorrência sem devolver orçamento ou repetir efeito', async t => {
  const f = await fixture(t), created = f.create({ maxConcurrent: 1 }), first = f.services.reserve(created.service, f.input()).receipt;
  f.services.beginDispatch(created.service, first.id); f.advance(300000);
  const replay = f.services.reserve(created.service, f.input()); assert.equal(replay.replayed, true); assert.equal(replay.receipt.state, 'unknown'); assert.equal(replay.receipt.stale, true); assert.equal(replay.receipt.chargedCostMicros, 400);
  assert.equal(f.services.beginDispatch(created.service, first.id).dispatched, false);
  const next = f.services.reserve(created.service, f.input({ requestId: 'request_synthetic_002', costMicros: 400 })); assert.equal(next.replayed, false);
  assert.equal(f.services.list(f.actor, 'playtech-demo').principals[0].usage.budgetMicros, 800);
  const uncertain = f.services.complete(created.service, first.id, { state: 'unknown', result: { run: 'Informação tardia sem confirmação' } }); assert.equal(uncertain.state, 'unknown'); assert.equal(uncertain.stale, true); assert.equal(uncertain.chargedCostMicros, 400);
  const finished = f.services.complete(created.service, first.id, { state: 'confirmed', result: { known: 'Resposta tardia sintética' } }); assert.equal(finished.state, 'confirmed'); assert.equal(finished.stale, true); assert.equal(finished.chargedCostMicros, 400);
  assert.equal(f.services.beginDispatch(created.service, first.id).dispatched, false);
});

test('despacho expirado de chave anterior não bloqueia a nova chave e resultado tardio conserva autoria antiga', async t => {
  const f = await fixture(t), created = f.create({ maxConcurrent: 1 }), first = f.services.reserve(created.service, f.input()).receipt;
  f.services.beginDispatch(created.service, first.id); const rotated = f.services.rotate(f.actor, 'playtech-demo', created.principal.id, { revision: 1 }), fresh = f.services.authenticate('Bearer ' + rotated.token);
  assert.throws(() => f.services.reserve(fresh, f.input({ requestId: 'request_synthetic_002', costMicros: 0 })), status(429));
  f.advance(300000); const next = f.services.reserve(fresh, f.input({ requestId: 'request_synthetic_002', costMicros: 0 })); assert.equal(next.replayed, false);
  const historical = f.services.receipts(f.actor, 'playtech-demo', created.principal.id).receipts.find(receipt => receipt.id === first.id); assert.equal(historical.state, 'unknown'); assert.equal(historical.keyRevision, 1);
  assert.throws(() => f.services.complete(fresh, first.id, { state: 'confirmed' }), status(409));
  const finished = f.services.complete(created.service, first.id, { state: 'confirmed', result: { known: true } }); assert.equal(finished.stale, true); assert.equal(finished.keyRevision, 1);
});

test('somente consultar recibo expira despacho incerto sem outra reserva, cobrança nova ou reenvio', async t => {
  const f = await fixture(t), created = f.create({ maxConcurrent: 1 }), first = f.services.reserve(created.service, f.input()).receipt;
  f.services.beginDispatch(created.service, first.id);
  const usage = f.services.list(f.actor, 'playtech-demo').principals[0].usage;
  const restarted = new ServicePrincipals(f.store, f.auth, { now: f.services.now });
  const actor = restarted.authenticate('Bearer ' + created.token);
  f.advance(300000);
  const result = restarted.getReceiptByRequestId(actor, 'request_synthetic_001');
  assert.equal(result.id, first.id); assert.equal(result.state, 'unknown'); assert.equal(result.stale, true);
  assert.equal(result.chargedCostMicros, 400);
  assert.deepEqual(restarted.list(f.actor, 'playtech-demo').principals[0].usage, usage);
  assert.equal(restarted.beginDispatch(actor, first.id).dispatched, false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_principal_receipts').get().n, 1);
});

test('consulta do recibo antigo continua recusada após alteração de grant, mesmo expirado', async t => {
  const f = await fixture(t), created = f.create(), first = f.services.reserve(created.service, f.input()).receipt;
  f.services.beginDispatch(created.service, first.id);
  f.services.update(f.actor, 'playtech-demo', created.principal.id, { revision: 1, channelIds: ['tg'] });
  f.advance(300000);
  const fresh = f.services.authenticate('Bearer ' + created.token);
  assert.throws(() => f.services.getReceipt(fresh, first.id), error => [403, 409].includes(error.status));
  assert.equal(f.store.db.prepare('SELECT state FROM service_principal_receipts WHERE id=?').get(first.id).state, 'dispatched');
});
