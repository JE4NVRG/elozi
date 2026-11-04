import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { McpManager } from '../src/mcp.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { randomBytes } from 'node:crypto';

const status = value => error => error.status === value;
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, provider = async () => 'Rascunho sintético para aprovação humana') {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); new Outbox(store);
  const admin = auth.actor(auth.insertUser({ username: 'service.api.owner', name: 'Admin sintético da API' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Empresa API QA', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Fixture: contexto serviço', state => {
    state.agents = [{ id: 'hermes', name: 'Hermes QA', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Prepare uma resposta para revisão humana.', tools: [], endpoint: 'http://remote-do-not-call.invalid' }];
    state.channels = [{ id: 'wa', name: 'WhatsApp QA', kind: 'whatsapp_qr', state: 'planned' }, { id: 'other', name: 'Canal fora do escopo', kind: 'telegram', state: 'planned' }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'Departamento fora do escopo', active: true }];
    state.conversations = [{ id: 'conversation', contact: 'Cliente QA', version: 1, channelId: 'wa', departmentId: 'support', status: 'open', owner: 'human', assignedUserId: admin.userId, participants: [], messages: [
      { id: 'customer-a', kind: 'customer', text: 'Mensagem pública do cliente', attachments: [{ id: 'file-a', kind: 'image', name: 'qa.png', mime: 'image/png', size: 4, url: 'http://remote-do-not-call.invalid/file', preview: 'private-attachment-data' }] },
      { id: 'human-a', kind: 'human', text: 'Resposta pública da equipe' },
      { id: 'note-a', kind: 'internal', text: 'internal-note-do-not-expose' },
      { id: 'system-a', kind: 'system', text: 'internal-system-do-not-expose' }
    ] }, { id: 'forbidden', contact: 'Outro cliente', version: 1, channelId: 'other', departmentId: 'sales', status: 'open', owner: 'queue', messages: [] }];
  });
  let runtime, clock = Date.now(); const calls = [];
  const principals = new ServicePrincipals(store, auth, { now: () => clock, onChange: serviceId => runtime?.invalidateInitiator(admin, tenant.id, { serviceId }) });
  runtime = new AgentRuntime(store, { validateInitiator: run => !run.serviceId || principals.runCurrent(run), providerCall: async context => { calls.push(context); return provider(context); } });
  const api = new ServiceApi(store, principals, runtime);
  const created = principals.create(admin, tenant.id, { name: 'Hermes externo QA', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft', 'handoff.request'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 50, dailyBudgetMicros: 4000, estimatedRequestMicros: 400, maxConcurrent: 2, ttlHours: 24 });
  const actor = principals.authenticate('Bearer ' + created.token);
  const oldFetch = globalThis.fetch; globalThis.fetch = () => assert.fail('Este teste não autoriza transporte externo');
  t.after(() => { globalThis.fetch = oldFetch; store.close(); });
  return { store, auth, admin, tenant, principals, runtime, api, created, actor, calls,
    input: extra => ({ requestId: 'synthetic_request_001', conversationId: 'conversation', version: 1, instruction: 'Prepare uma resposta objetiva.', ...extra }),
    current: () => store.tenant(admin, tenant.id), receipts: () => principals.receipts(admin, tenant.id, created.principal.id).receipts,
    quota: () => principals.list(admin, tenant.id).principals[0].usage,
    advance(milliseconds) { clock += milliseconds; },
    assertNoSend() { assert.equal(store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0); assert.equal(store.tenant(admin, tenant.id).conversations[0].messages.length, 4); }
  };
}

test('inventário pagina mais de50 conversas com conjunto estável enquanto mensagens e ordem mudam', t => {
  const f = fixture(t);
  f.store.mutate(f.admin, f.tenant.id, '151 contextos sintéticos', state => {
    state.conversations = Array.from({ length: 151 }, (_, i) => ({ id: `context_${String(i).padStart(3, '0')}`, contact: `Contexto ${i}`, channelId: 'wa', departmentId: 'support', status: 'open', owner: 'human', version: 1, updatedAt: '2026-10-01T12:00:00Z', messages: [{ id: `message_${i}`, kind: 'customer', text: 'Nunca incluir no inventário' }] }));
    state.conversations.push({ id: 'forbidden_context', contact: 'Nome secreto', channelId: 'other', departmentId: 'sales', status: 'open', owner: 'queue', version: 1, messages: [] });
  });
  const first = f.api.inbox(f.actor, { requestId: 'page_first_001', limit: 50 });
  assert.match(first.snapshot, /^[a-f0-9]{64}$/); assert.equal(first.conversations.length, 50); assert.ok(first.nextCursor);
  const repeated = f.api.inbox(f.actor, { requestId: 'page_first_001', limit: 50 });
  assert.equal(repeated.receipt, first.receipt); assert.equal(repeated.snapshot, first.snapshot);
  f.store.mutate(f.admin, f.tenant.id, 'Tráfego durante inventário', state => {
    const changed = state.conversations.find(c => c.id === 'context_120'); changed.updatedAt = '2026-10-22T12:00:00Z'; changed.version++;
    state.conversations.push({ ...state.conversations[0], id: 'created_after_snapshot' });
  });
  const all = [...first.conversations], cursors = new Set(); let next = first.nextCursor, page = 1;
  while (next) {
    assert.equal(cursors.has(next), false); cursors.add(next);
    const result = f.api.inbox(f.actor, { requestId: `page_next_00${page++}`, limit: 50, cursor: next });
    assert.equal(result.snapshot, first.snapshot); all.push(...result.conversations); next = result.nextCursor;
  }
  assert.equal(all.length, 151); assert.equal(new Set(all.map(c => c.id)).size, 151);
  assert.equal(all.find(c => c.id === 'context_120').version, 2);
  for (const forbidden of ['created_after_snapshot', 'forbidden_context', 'Nome secreto', 'Nunca incluir']) assert.equal(JSON.stringify(all).includes(forbidden), false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0); assert.equal(f.calls.length, 0);
});

test('cursor de inventário recusa adulteração, outro escopo, filtro e snapshot expirado sem efeitos', t => {
  const f = fixture(t);
  f.api.inventory.ttlMs = 10;
  f.store.mutate(f.admin, f.tenant.id, 'Mais um contexto permitido', state => { state.conversations.push({ ...state.conversations[0], id: 'second_context' }); });
  const first = f.api.inbox(f.actor, { requestId: 'cursor_first_001', limit: 1 });
  const quota = f.quota().requests;
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'cursor_bad_0001', limit: 1, cursor: first.nextCursor.slice(0, -4) + 'aaaa' }), status(400));
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'cursor_bad_0002', limit: 2, cursor: first.nextCursor }), status(409));
  const other = f.principals.create(f.admin, f.tenant.id, { name: 'Outra identidade sintética', agentId: 'hermes', capabilities: ['conversation.read'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 50, maxConcurrent: 1, ttlHours: 24 });
  const otherActor = f.principals.authenticate('Bearer ' + other.token);
  assert.throws(() => f.api.inbox(otherActor, { requestId: 'cursor_other_001', limit: 1, cursor: first.nextCursor }), status(409));
  f.advance(11);
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'cursor_bad_0003', limit: 1, cursor: first.nextCursor }), status(409));
  assert.equal(f.store.db.prepare('SELECT requests FROM service_principal_usage WHERE principal_id=?').get(f.created.principal.id).requests, quota);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
});

test('inventário cancelado por transferência não libera página fora do grant', t => {
  const f = fixture(t);
  f.store.mutate(f.admin, f.tenant.id, 'Segundo contexto', state => { state.conversations[0].updatedAt = '2026-10-01T00:00:00Z'; state.conversations.push({ ...state.conversations[0], id: 'second_context', updatedAt: '2000-01-01T00:00:00Z' }); });
  const first = f.api.inbox(f.actor, { requestId: 'transfer_page_001', limit: 1 });
  f.store.mutate(f.admin, f.tenant.id, 'Transferência para outro canal', state => { state.conversations.find(c => c.id === 'second_context').channelId = 'other'; });
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'transfer_page_002', limit: 1, cursor: first.nextCursor }), status(403));
});

test('limite do cache de inventário recusa cobertura sem truncamento silencioso', t => {
  const f = fixture(t); f.api.inventory.maxRows = 0;
  f.store.mutate(f.admin, f.tenant.id, 'Inventário que precisa de cursor', state => { const base = state.conversations[0]; state.conversations = Array.from({ length: 51 }, (_, i) => ({ ...base, id: `limited_${i}` })); });
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'cache_limit_001' }), status(503));
  assert.equal(f.receipts().length, 0); assert.equal(f.calls.length, 0);
});

test('solicitações sem cota ou com requestId conflitante não ocupam o cache global de snapshots', t => {
  const f = fixture(t);
  f.store.mutate(f.admin, f.tenant.id, 'Duas conversas permitidas', state => { state.conversations.push({ ...state.conversations[0], id: 'another_allowed' }); });
  f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, dailyRequests: 1 });
  const actor = f.principals.authenticate('Bearer ' + f.created.token);
  f.api.inbox(actor, { requestId: 'quota_snapshot_001', limit: 1 });
  for (let i = 0; i < 40; i++) assert.throws(() => f.api.inbox(actor, { requestId: `quota_denied_${String(i).padStart(3, '0')}`, limit: 1 }), status(429));
  assert.equal(f.api.inventory.snapshots.size, 1);
  const other = f.principals.create(f.admin, f.tenant.id, { name: 'Outra cota sintética', agentId: 'hermes', capabilities: ['conversation.read'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 50, maxConcurrent: 1, ttlHours: 24 });
  const otherActor = f.principals.authenticate('Bearer ' + other.token);
  assert.equal(f.api.inbox(otherActor, { requestId: 'quota_other_0001', limit: 1 }).conversations.length, 1);
  assert.throws(() => f.api.inbox(otherActor, { requestId: 'quota_other_0001', limit: 2 }), status(409));
  assert.equal(f.api.inventory.snapshots.size, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
});

test('consultas curtas e grupos vazios não retêm snapshot nem ficam bloqueados pelo cache cheio', t => {
  const f = fixture(t); f.api.inventory.maxSnapshots = 1;
  f.store.mutate(f.admin, f.tenant.id, 'Dois contextos permitidos', state => { state.conversations.push({ ...state.conversations[0], id: 'second_allowed' }); });
  f.api.inbox(f.actor, { requestId: 'retained_multi_001', limit: 1 });
  assert.equal(f.api.inventory.snapshots.size, 1);
  for (let i = 0; i < 10; i++) {
    const page = f.api.inbox(f.actor, { requestId: `single_page_${i}`, limit: 50 });
    assert.equal(page.nextCursor, null); assert.equal(page.conversations.length, 2);
    const groups = f.api.listGroups(f.actor, { requestId: `empty_groups_${i}` });
    assert.equal(groups.nextCursor, null); assert.deepEqual(groups.groups, []);
  }
  assert.equal(f.api.inventory.snapshots.size, 1);
});

test('lote de leitura não conserva autorização através de escrita ou await', t => {
  const f = fixture(t);
  assert.throws(() => f.api.withReadScope(f.actor, () => Promise.resolve()), /síncrona/);
  let delayed;
  f.api.withReadScope(f.actor, scope => { delayed = () => scope.check(scope.tenant.conversations[0]); });
  assert.throws(delayed, status(409));
  assert.throws(() => f.api.withReadScope(f.actor, scope => {
    f.store.mutate(f.admin, f.tenant.id, 'Mudança dentro da leitura', state => { state.conversations[0].version++; });
    return scope.check(scope.tenant.conversations[0]);
  }), status(409));
});

test('me devolve só o adaptador próprio atual sem gastar cota nem expor configuração privada', t => {
  const f = fixture(t), before = f.quota();
  const first = f.api.me(f.actor);
  assert.deepEqual(first.agent, {id:'hermes',version:1,provider:'hermes',mode:'copilot',configured:true,adapterMode:'copilot'});
  assert.equal(first.apiVersion,2); assert.equal(first.humanApprovalRequired,true);
  for(let i=0;i<5;i++) f.api.me(f.actor);
  assert.deepEqual(f.quota(),before); assert.equal(f.receipts().length,0); assert.equal(f.calls.length,0);
  const text=JSON.stringify(first.agent);
  for(const value of ['endpoint','description','tools','token','remote-do-not-call','Prepare uma resposta']) assert.equal(text.includes(value),false);
  f.store.mutate(f.admin,f.tenant.id,'Alteração controlada do adaptador',tenant=>{tenant.agents[0].version++;});
  const fresh=f.principals.authenticate('Bearer '+f.created.token);
  assert.equal(f.api.me(fresh).agent.version,2);
});

test('leitura expõe mensagens públicas e metadados de anexos do escopo, sem notas ou endereços remotos', t => {
  const f = fixture(t), result = f.api.read(f.actor, 'conversation', 'synthetic_read_001');
  assert.deepEqual(result.conversation.messages.map(message => message.id), ['customer-a', 'human-a']);
  assert.deepEqual(result.conversation.messages[0].attachments, [{ id: 'file-a', kind: 'image', name: 'qa.png', mime: 'image/png', size: 4 }]);
  const serialized = JSON.stringify(result); for (const value of ['internal-note', 'internal-system', 'remote-do-not-call', 'private-attachment-data']) assert.equal(serialized.includes(value), false);
  assert.equal(f.api.read(f.actor, 'conversation', 'synthetic_read_001').receipt, result.receipt); assert.equal(f.quota().requests, 1); assert.equal(f.quota().budgetMicros, 0);
  assert.throws(() => f.api.read(f.actor, 'forbidden', 'synthetic_read_002'), status(403)); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('runtime real mantém serviço distinto do humano responsável e não envia nem fornece notas ao provedor', async t => {
  const f = fixture(t), before = f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, result = await f.api.draft(f.actor, f.input());
  assert.equal(result.run.state, 'draft'); assert.equal(result.humanApprovalRequired, true); assert.equal(result.run.draft, 'Rascunho sintético para aprovação humana');
  const run = f.current().runs.find(run => run.id === result.run.id); assert.equal(run.initiatorKind, 'service'); assert.equal(run.serviceId, f.created.principal.id); assert.equal(run.actorUserId, null); assert.equal(run.actor, f.created.principal.id); assert.equal(run.assignedUserIdAtStart, f.admin.userId);
  assert.equal(run.serviceRevision, 1); assert.equal(run.serviceKeyRevision, 1); assert.ok(run.serviceAdapterHash); assert.equal(f.current().conversations[0].assignedUserId, f.admin.userId);
  const payload = JSON.stringify(f.calls[0]); for (const value of ['internal-note', 'internal-system', 'remote-do-not-call', 'private-attachment-data']) assert.equal(payload.includes(value), false); assert.equal(f.calls[0].endpoint, undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, before); assert.equal(f.store.db.prepare('SELECT count(*) n FROM auth_sessions').get().n, 0); f.assertNoSend();
});

test('rascunho Unicode de 20 mil caracteres não estoura recibo, perde texto ou reembolsa chamada conhecida', async t => {
  const text = '界'.repeat(20000), f = fixture(t, async () => text), result = await f.api.draft(f.actor, f.input());
  assert.equal(Buffer.byteLength(text), 60000); assert.equal(result.run.draft, text); assert.equal(result.receipt.state, 'confirmed'); assert.equal(result.receipt.chargedCostMicros, 400); assert.equal(f.quota().budgetMicros, 400);
  const receipt = f.receipts()[0], row = f.store.db.prepare('SELECT result FROM service_principal_receipts WHERE id=?').get(receipt.id);
  assert.ok(Buffer.byteLength(row.result) < 32768); assert.equal(JSON.stringify(receipt).includes(text), false); assert.equal(receipt.result?.run?.draft ?? null, null);
  assert.equal(f.current().runs.find(run => run.id === result.run.id).draft, text); f.assertNoSend();
});

test('replay busca rascunho atual no runtime sem armazenar texto em recibos ou chamar o provedor de novo', async t => {
  const f = fixture(t), first = await f.api.draft(f.actor, f.input()), again = await f.api.draft(f.actor, f.input());
  assert.equal(again.receipt.id, first.receipt.id); assert.equal(again.run.id, first.run.id); assert.equal(again.run.draft, first.run.draft); assert.equal(f.calls.length, 1); assert.equal(f.quota().requests, 1); assert.equal(f.quota().budgetMicros, 400);
  assert.equal(f.principals.getReceipt(f.actor, first.receipt.id).result?.run?.draft ?? null, null); assert.equal(JSON.stringify(f.receipts()).includes(first.run.draft), false); f.assertNoSend();
});

test('revogação depois de start resolver preserva recibo conhecido mas não devolve rascunho ao bearer antigo', async t => {
  const secretDraft = 'draft-after-revocation-do-not-expose', f = fixture(t, async () => secretDraft), start = f.runtime.start.bind(f.runtime); let completed;
  f.runtime.start = async (...args) => { completed = await start(...args); assert.equal(completed.state, 'draft'); f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 }); return completed; };
  await assert.rejects(f.api.draft(f.actor, f.input()), error => [401, 409].includes(error.status));
  const receipt = f.receipts()[0]; assert.equal(receipt.state, 'confirmed'); assert.equal(receipt.stale, true); assert.equal(receipt.chargedCostMicros, 400); assert.equal(JSON.stringify(receipt).includes(secretDraft), false);
  assert.equal(f.current().runs.find(run => run.id === completed.id).draft, null); assert.equal(f.calls.length, 1); f.assertNoSend();
});

test('rotação após conclusão invalida replay antigo, key/stamps e rascunho sem alterar recibo confirmado', async t => {
  const f = fixture(t), first = await f.api.draft(f.actor, f.input()), rotated = f.principals.rotate(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
  const fresh = f.principals.authenticate('Bearer ' + rotated.token); assert.throws(() => f.principals.authenticate('Bearer ' + f.created.token), status(401)); await assert.rejects(f.api.draft(f.actor, f.input()), status(401));
  await assert.rejects(f.api.draft(fresh, f.input()), status(409)); assert.throws(() => f.principals.getReceipt(fresh, first.receipt.id), status(409));
  const receipt = f.receipts()[0]; assert.equal(receipt.state, 'confirmed'); assert.equal(receipt.chargedCostMicros, 400); assert.equal(receipt.keyRevision, 1); assert.equal(receipt.result?.run?.draft ?? null, null);
  assert.equal(f.runtime.list(f.admin, f.tenant.id).find(run => run.id === first.run.id).draft, null); assert.equal(f.calls.length, 1); f.assertNoSend();
});

test('replay concorrente mantém uma chamada e reserva; nova solicitação não ultrapassa simultaneidade', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, maxConcurrent: 1 }); const actor = f.principals.authenticate('Bearer ' + f.created.token);
  const pending = f.api.draft(actor, f.input()); await settle(); const repeated = await f.api.draft(actor, f.input());
  assert.equal(repeated.receipt.state, 'dispatched'); assert.equal(repeated.run?.draft ?? null, null); assert.equal(f.calls.length, 1); assert.equal(f.quota().requests, 1); assert.equal(f.quota().budgetMicros, 400);
  await assert.rejects(f.api.draft(actor, f.input({ requestId: 'synthetic_request_002' })), status(429));
  finish('Resultado único'); const completed = await pending; assert.equal(completed.run.draft, 'Resultado único'); assert.equal(f.calls.length, 1); assert.equal(f.quota().requests, 1); f.assertNoSend();
});

test('conflito do runtime na mesma conversa devolve só reserva da segunda solicitação sem confundir chamada em voo', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; })), pending = f.api.draft(f.actor, f.input()); await settle();
  await assert.rejects(f.api.draft(f.actor, f.input({ requestId: 'synthetic_request_002' })), status(409));
  const failed = f.receipts().find(receipt => receipt.requestId === 'synthetic_request_002'); assert.equal(failed.state, 'failed'); assert.equal(failed.chargedCostMicros, 0); assert.equal(f.quota().requests, 2); assert.equal(f.quota().budgetMicros, 400); assert.equal(f.calls.length, 1);
  finish('Resultado único da origem'); const completed = await pending; assert.equal(completed.receipt.state, 'confirmed'); assert.equal(completed.receipt.chargedCostMicros, 400); f.assertNoSend();
});

test('falha depois de chamar provedor é unknown com reserva preservada e replay não repete transporte', async t => {
  const f = fixture(t, async () => { throw new Error('provider-private-detail-do-not-expose'); }), result = await f.api.draft(f.actor, f.input());
  assert.equal(result.receipt.state, 'unknown'); assert.equal(result.receipt.chargedCostMicros, 400); assert.equal(result.run?.draft ?? null, null); assert.equal(f.quota().budgetMicros, 400); assert.equal(JSON.stringify(result).includes('provider-private-detail'), false);
  const replay = await f.api.draft(f.actor, f.input()); assert.equal(replay.receipt.id, result.receipt.id); assert.equal(replay.run?.draft ?? null, null); assert.equal(f.calls.length, 1); f.assertNoSend();
});

test('falha de armazenamento após resultado do provedor conserva unknown e orçamento sem repetir chamada', async t => {
  const f = fixture(t), complete = f.principals.complete.bind(f.principals); let first = true;
  f.principals.complete = (actor, id, input) => { if (first && input.state === 'confirmed') { first = false; throw Object.assign(new Error('Persistência sintética temporariamente indisponível'), { status: 503 }); } return complete(actor, id, input); };
  await assert.rejects(f.api.draft(f.actor, f.input()), status(503)); const receipt = f.receipts()[0];
  assert.equal(receipt.state, 'unknown'); assert.equal(receipt.chargedCostMicros, 400); assert.equal(f.quota().budgetMicros, 400); assert.equal(f.calls.length, 1);
  await f.api.draft(f.actor, f.input()); assert.equal(f.calls.length, 1); assert.equal(f.quota().requests, 1); f.assertNoSend();
});

test('recusa antes de chamar provedor encerra failed e devolve só orçamento reservado', async t => {
  const f = fixture(t); f.runtime.providerCall = null; await assert.rejects(f.api.draft(f.actor, f.input()), status(503));
  assert.equal(f.receipts()[0].state, 'failed'); assert.equal(f.receipts()[0].chargedCostMicros, 0); assert.equal(f.quota().requests, 1); assert.equal(f.quota().budgetMicros, 0); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('caller não configura custo, unidades, endpoint nem escopo ou identidade humana pela API', async t => {
  const f = fixture(t);
  for (const extra of [{ costMicros: 0 }, { units: 0 }, { endpoint: 'http://remote.invalid' }, { userId: f.admin.userId }, { tenantId: 'other-company' }, { instruction: 'x'.repeat(1001) }]) await assert.rejects(f.api.draft(f.actor, f.input(extra)), status(400));
  assert.equal(f.calls.length, 0); assert.equal(f.quota().requests, 0); assert.equal(f.receipts().length, 0); f.assertNoSend();
});

test('pedido de encaminhamento é proposta idempotente e auditável, sem assumir ou escrever ao cliente', t => {
  const f = fixture(t), input = { requestId: 'synthetic_handoff_001', conversationId: 'conversation', version: 1, reason: 'Preciso de apoio humano.' }, first = f.api.handoff(f.actor, input), replay = f.api.handoff(f.actor, input);
  assert.equal(first.request.state, 'pending'); assert.equal(first.request.serviceId, f.created.principal.id); assert.equal(replay.request.id, first.request.id); assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_handoff_requests').get().n, 1); assert.equal(f.current().conversations[0].assignedUserId, f.admin.userId); assert.equal(f.calls.length, 0);
  const decided = f.api.decide(f.admin, f.tenant.id, 'conversation', first.request.id, { version: 1, action: 'acknowledge', reason: 'Revisão humana sintética' }); assert.equal(decided.request.decidedBy, f.admin.userId); assert.equal(decided.request.state, 'acknowledged'); f.assertNoSend();
});

test('serviço autorizado executa consulta interna automática sem responsável humano e conclui o rascunho no mesmo despacho', async t => {
  const f = fixture(t), vault = encryptedChannelSecrets(f.store.db, randomBytes(32)), queries = [], requests = [];
  const mcp = new McpManager(f.store, { vault: () => vault, internalContext(actor, tenantId, conversationId, request) {
    // Service initiators are authorized by their persisted principal, never by a human responsible.
    const run = f.store.tenant(f.admin, tenantId).runs.find(item => item.id === request.runId);
    assert.equal(actor.serviceId, run.serviceId); assert.equal(f.principals.runCurrent(run), true); assert.equal(actor.userId, undefined);
    queries.push(request.tool);
    const conversation = f.store.getConversation(f.store.tenant(f.admin, tenantId), conversationId);
    return { attendance: { id: conversation.id, status: conversation.status, owner: conversation.owner } };
  } });
  const server = mcp.create(f.admin, f.tenant.id, { name: 'Elozi interna', kind: 'internal', enabled: true });
  const discovered = await mcp.discover(f.admin, f.tenant.id, server.id, { version: server.version }), tool = discovered.tools.find(item => item.name === 'elozi_attendance_status');
  mcp.setGrants(f.admin, f.tenant.id, 'hermes', { version: 1, grants: [{ serverId: discovered.id, serverVersion: discovered.version, toolName: tool.name, toolHash: tool.hash }] });
  const runtime = new AgentRuntime(f.store, { mcp, validateInitiator: run => !run.serviceId || f.principals.runCurrent(run), providerCall: async context => {
    requests.push(structuredClone(context.messages));
    if (String(context.messages.at(-1).content).startsWith('Resultados de consultas')) return { text: 'Seu atendimento está aberto e será revisado.' };
    const name = context.tools[0].function.name;
    return { toolCall: { id: 'call_service_lookup', name, arguments: {} }, assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'call_service_lookup', type: 'function', function: { name, arguments: '{}' } }] } };
  } });
  const api = new ServiceApi(f.store, f.principals, runtime);
  const created = f.principals.create(f.admin, f.tenant.id, { name: 'Hermes com consulta', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 10, maxConcurrent: 1, ttlHours: 1 });
  const actor = f.principals.authenticate('Bearer ' + created.token), result = await api.draft(actor, f.input({ requestId: 'synthetic_lookup_001' }));
  assert.equal(result.run.state, 'draft'); assert.equal(result.run.draft, 'Seu atendimento está aberto e será revisado.'); assert.equal(result.receipt.state, 'confirmed');
  const run = f.current().runs.find(item => item.id === result.run.id);
  assert.equal(run.serviceId, created.principal.id); assert.equal(run.toolReceipt.autoApproved, true); assert.equal(run.toolReceipt.approvedUserId, null);
  assert.equal(run.toolReceipt.result.structuredContent.owner, 'human'); assert.deepEqual(queries, ['elozi_attendance_status']); assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests).includes('internal-note-do-not-expose'), false);
  assert.equal(runtime.controllers.size, 0); assert.deepEqual(vault.get(`mcp-run:${f.tenant.id}:${run.id}`), {}); f.assertNoSend();
});
