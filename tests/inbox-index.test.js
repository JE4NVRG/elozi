import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { createConsolidatedInbox } from '../src/consolidated-inbox.js';
import { Operations } from '../src/operations.js';
import { tenantIndex } from '../src/inbox-index.js';
import { createConsolidatedInbox as createReferenceInbox } from './fixtures/consolidated-inbox-reference.js';
import { referenceMetrics } from './fixtures/operations-metrics-reference.js';

// Deterministic PRNG (mulberry32) so a failure reproduces from its seed.
function random(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash = value => parseInt(createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8), 16);
const NOW = Date.parse('2026-11-03T12:00:00Z');

function company(rand, index, { demo = false } = {}) {
  const pick = list => list[Math.floor(rand() * list.length)];
  const date = () => rand() < 0.05 ? 'not-a-date' : rand() < 0.05 ? undefined : new Date(NOW - Math.floor(rand() * 20 * 86400000)).toISOString();
  const channels = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, n) => ({ id: `ch-${n}`, name: `Canal ${index}.${n}`, kind: pick(['whatsapp_qr', 'webchat', 'telegram']), state: pick(['connected', 'sandbox', 'failed']), ...(rand() < 0.5 ? { transport: pick(['baileys', 'telegram-bot', 'none']) } : {}) }));
  if (rand() < 0.2) channels.push({ ...channels[0], name: 'Duplicado' });
  const departments = [{ id: 'dep-a', name: 'Suporte' }, { id: 'dep-b', name: 'Vendas', active: rand() < 0.5 }];
  const users = ['u-1', 'u-2', 'u-3'];
  const conversations = Array.from({ length: 5 + Math.floor(rand() * 25) }, (_, n) => {
    const messages = Array.from({ length: Math.floor(rand() * 8) }, (_, m) => ({ id: rand() < 0.1 ? `dup-${m}` : `m-${index}-${n}-${m}`, kind: pick(['customer', 'human', 'agent', 'note', 'system']),
      text: pick(['Olá, preciso de ajuda', 'Pedido 123 atrasado', 'Obrigado!', 'Boleto vencido', 'Ação']), createdAt: date(), delivery: pick([undefined, 'sent', 'failed', 'pending', 'delivered']),
      authorUserId: pick([undefined, ...users]), authorName: pick([undefined, 'Ana', 'Bruno']), ...(rand() < 0.1 ? { attachments: [{ kind: 'image', name: 'foto.png' }] } : {}) }));
    const owner = pick(['human', 'queue', 'agent']);
    return { id: `c-${n}`, contact: pick(['Marina', 'Rafael', 'Camila', '']), initials: 'XX', channelId: pick([...channels.map(channel => channel.id), 'gone']),
      ...(rand() < 0.6 ? { departmentId: pick(['dep-a', 'dep-b', 'dep-x']) } : { department: pick(['Suporte', 'Vendas', 'Outro']) }),
      owner, status: pick(['open', 'pending', 'closed']), unread: pick([0, 1, 3, '2', -1, null]), version: 1 + Math.floor(rand() * 4),
      ...(owner === 'human' ? { assignedUserId: pick(users), assignedUserName: pick(['Ana', 'Bruno', undefined]) } : {}), tags: rand() < 0.3 ? ['VIP', 7, 'Cliente'] : ['Cliente'],
      agentId: owner === 'agent' ? 'agent-1' : null, conversationKind: pick(['direct', 'group', undefined]), ...(rand() < 0.1 ? { replyExempt: true } : {}),
      contactId: rand() < 0.5 ? `contact-${n % 4}` : undefined, updatedAt: date(), createdAt: date(), messages,
      attendantEvents: Array.from({ length: Math.floor(rand() * 4) }, (_, e) => ({ id: rand() < 0.1 ? 'ev-dup' : `ev-${index}-${n}-${e}`, type: pick(['assignment', 'closed', 'reopened', 'note']), createdAt: date(),
        actorId: pick(users), actorName: 'Ana', from: { assignedUserId: pick([null, ...users]), status: pick(['open', 'pending', 'closed']) }, to: { assignedUserId: pick(users), assignedUserName: 'Bruno', status: pick(['open', 'closed']) } })) };
  });
  const runs = conversations.filter(() => rand() < 0.3).map((conversation, n) => ({ id: `run-${n}`, conversationId: conversation.id, agentName: 'Hermes', state: pick(['waiting_approval', 'running', 'queued', 'draft', 'done']),
    draft: rand() < 0.7 ? 'texto' : '', stale: rand() < 0.2, conversationVersion: conversation.version - (rand() < 0.3 ? 1 : 0),
    toolProposal: { expiresAt: new Date(NOW + (rand() < 0.5 ? 1 : -1) * 3600000).toISOString(), title: 'Ferramenta', readOnly: rand() < 0.5 } }));
  return { name: `Empresa ${index}`, segment: 'Teste', plan: 'Pilot', brand: { name: 'X', initials: 'X', accent: '#3157d5', domain: '' }, channels, departments, runs,
    agents: [{ id: 'agent-1', name: 'Hermes', provider: 'hermes', mode: 'copilot' }], agentAdminProposals: rand() < 0.5 ? [{ state: 'pending' }, { state: 'done' }] : [],
    contacts: [0, 1, 2, 3].map(n => ({ id: `contact-${n}`, name: `Contato ${n}`, phone: `55119999000${n}`, email: `c${n}@example.test`, tags: ['Atacado'] })),
    conversations, ...(demo ? { demo: { createdAt: '2026-11-01T00:00:00.000Z', createdBy: null } } : {}) };
}

function seed(store, seedValue, tenants = 6) {
  const rand = random(seedValue);
  store.db.prepare('INSERT OR IGNORE INTO resellers VALUES (?,?)').run('ws-a', JSON.stringify({ name: 'WS A' }));
  for (let index = 0; index < tenants; index++) store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(`t-${index}`, index === tenants - 1 ? 'mep-demo' : 'ws-a', JSON.stringify(company(rand, index, { demo: index === 2 })));
  return rand;
}

function options(seedValue) {
  const can = (actor, permission, context) => context.aggregate || hash([seedValue, permission, context.tenantId, context.channelId, context.departmentId]) % 5 !== 0;
  const channelState = (tenantId, channel) => channel.transport === 'baileys' ? (hash([tenantId, channel.id]) % 2 ? 'connected' : 'disconnected') : channel.state || 'configured';
  return { can, channelState, now: () => NOW };
}
const QUERIES = ['', 'status=all', 'status=closed', 'tab=mine', 'tab=queue&sort=oldest', 'tab=agent', 'unread=1', 'unread=0&sort=unread', 'q=pedido', 'q=contato%201', 'q=foto', 'tag=vip',
  'channelId=ch-0', 'departmentId=unassigned', 'departmentId=dep-a', 'assignedUserId=u-1', 'kind=group', 'offset=3&limit=4', 'tenantId=t-1', 'tenantId=t-2', 'owner=human', 'limit=200&status=all'];

function compareAll(store, seedValue, current, reference, label) {
  const actors = [{ userId: 'u-1', role: 'reseller', resellerId: 'ws-a', name: 'Admin' }, { userId: 'u-2', role: 'operator', resellerId: 'ws-a', tenantIds: ['t-0', 't-2', 't-3'], tenantId: 't-0', name: 'Op' }];
  for (const actor of actors) for (const query of QUERIES) {
    const params = () => new URLSearchParams(query);
    let expected, actual, expectedError, actualError;
    try { expected = reference.list(actor, params()); } catch (error) { expectedError = error; }
    try { actual = current.list(actor, params()); } catch (error) { actualError = error; }
    if (expectedError || actualError) { assert.equal(actualError?.status, expectedError?.status, `${label} ${query}`); continue; }
    assert.deepStrictEqual(actual, expected, `${label} seed=${seedValue} role=${actor.role} query=${query}`);
    // delta paging carries the same rows, removals and order.
    const deltaQuery = `${query}${query ? '&' : ''}delta=1&since=${expected.revision}`;
    assert.deepStrictEqual(current.list(actor, new URLSearchParams(deltaQuery)), reference.list(actor, new URLSearchParams(deltaQuery)), `${label} delta ${query}`);
  }
  for (const actor of actors) {
    const hooks = { admin: actor.role === 'reseller', canDecide: (tenantId, conversation) => hash([tenantId, conversation.id]) % 2 === 0, handoffs: tenantId => new Map([['c-1', 2], ['c-9', 1], [tenantId, 1]]),
      quota: (tenantId, tenant) => ({ used: tenant.conversations.length * 10, limit: 100 }), automatic: (tenantId, tenant, conversation) => hash([conversation.id, tenant.name]) % 3 === 0,
      queueAgent: (tenantId, tenant, conversation) => hash([tenantId, conversation.id]) % 4 === 0 ? { name: tenant.agents[0].name, lastSeenAt: null } : null };
    assert.deepStrictEqual(current.attention(actor, hooks), reference.attention(actor, hooks), `${label} attention ${actor.role}`);
  }
}

function metricsPair(store, seedValue) {
  const auth = { can: (actor, permission, context) => hash([seedValue, permission, context.channelId, context.departmentId]) % 4 !== 0 };
  const self = () => ({ permission() {}, now: () => NOW, store, auth, currentDepartment: Operations.prototype.currentDepartment });
  const current = self(), reference = self();
  return (actor, tenantId, period) => assert.deepStrictEqual(Operations.prototype.metrics.call(current, actor, tenantId, period), referenceMetrics.call(reference, actor, tenantId, period), `metrics ${tenantId} ${JSON.stringify(period)}`);
}

test('índice da caixa única: mesmas respostas do código anterior em dados aleatórios, antes e depois de escritas', () => {
  for (const seedValue of [1, 7, 42, 2026]) {
    const store = new Store(':memory:'), rand = seed(store, seedValue), opts = options(seedValue);
    const current = createConsolidatedInbox(store, opts), reference = createReferenceInbox(store, opts), index = tenantIndex(store);
    assert.equal(index.enabled, true, index.disabledReason);
    compareAll(store, seedValue, current, reference, 'inicial');
    const hits = index.stats.hits;
    compareAll(store, seedValue, current, reference, 'cache');
    assert.ok(index.stats.hits > hits, 'repeated reads must reuse the company model');
    const admin = { userId: 'u-1', role: 'reseller', resellerId: 'ws-a', name: 'Admin' };
    // Writes through every path: whole document, one conversation, raw SQL, insert and delete.
    store.mutate(admin, 't-0', 'teste', tenant => { tenant.conversations[0].unread = 5; tenant.conversations[1].messages.push({ id: 'new', kind: 'customer', text: 'Novo pedido', createdAt: new Date(NOW - 1000).toISOString() }); tenant.conversations.pop(); tenant.name = 'Renomeada'; });
    compareAll(store, seedValue, current, reference, 'mutate');
    store.mutateConversation(admin, 't-1', 'c-0', 'teste', conversation => { conversation.status = 'closed'; conversation.messages.push({ kind: 'human', text: 'Pedido resolvido', createdAt: new Date(NOW - 500).toISOString() }); });
    compareAll(store, seedValue, current, reference, 'mutateConversation');
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].owner','queue','$.channels[0].name','SQL') WHERE id='t-3'").run();
    compareAll(store, seedValue, current, reference, 'sql');
    store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('t-new', 'ws-a', JSON.stringify(company(rand, 99)));
    store.db.prepare("DELETE FROM tenants WHERE id='t-4'").run();
    compareAll(store, seedValue, current, reference, 'insert-delete');
    // A rolled-back write never leaves stale or uncommitted data behind.
    store.db.exec('BEGIN IMMEDIATE');
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.name','Temporária') WHERE id='t-0'").run();
    compareAll(store, seedValue, current, reference, 'in-transaction');
    store.db.exec('ROLLBACK');
    compareAll(store, seedValue, current, reference, 'rollback');
    // Metrics: same indicators for several periods, cached and after a write.
    const metrics = metricsPair(store, seedValue);
    for (const tenantId of ['t-0', 't-1', 't-3', 't-new']) for (const period of [{}, { from: new Date(NOW - 3 * 86400000).toISOString() }, { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }]) { metrics(admin, tenantId, period); metrics(admin, tenantId, period); }
    store.mutate(admin, 't-0', 'teste', tenant => { tenant.conversations[0].messages.push({ id: 'h1', kind: 'human', text: 'ok', createdAt: new Date(NOW - 100).toISOString(), authorUserId: 'u-9' }); });
    metrics(admin, 't-0', {});
    assert.throws(() => Operations.prototype.metrics.call({ permission() {}, now: () => NOW, store, auth: { can: () => true } }, admin, 't-0', { from: 'x' }), error => error.status === 400);
    store.close();
  }
});

test('índice: commit de outra conexão invalida tudo; isolamento por workspace e operador continua igual', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elozi-inbox-index-'));
  try {
    const path = join(dir, 'store.db'), store = new Store(path); seed(store, 5);
    const opts = options(5), current = createConsolidatedInbox(store, opts), reference = createReferenceInbox(store, opts);
    compareAll(store, 5, current, reference, 'arquivo');
    const other = new DatabaseSync(path);
    other.prepare("UPDATE tenants SET data=json_set(data,'$.name','Outra conexão','$.conversations[0].unread',9) WHERE id='t-0'").run();
    other.close();
    const admin = { userId: 'u-1', role: 'reseller', resellerId: 'ws-a', name: 'Admin' };
    assert.ok(current.list(admin, new URLSearchParams('status=all&limit=200')).tenants.some(tenant => tenant.name === 'Outra conexão'));
    compareAll(store, 5, current, reference, 'outra-conexao');
    // A cached company of another workspace is never served: same 403/404 as Store.tenant().
    const stranger = { userId: 'x', role: 'reseller', resellerId: 'mep-demo', name: 'X' };
    assert.deepStrictEqual(current.list(stranger, new URLSearchParams('')), reference.list(stranger, new URLSearchParams('')));
    assert.throws(() => current.list(stranger, new URLSearchParams('tenantId=t-0')), error => error.status === 403);
    // The TEMP triggers are connection-local: the database schema is unchanged.
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name LIKE 'elozi_index_%'").get().n, 0);
    const reopened = new DatabaseSync(path);
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'elozi_index_%'").get().n, 0);
    reopened.close(); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('índice: documento completo só entra no cache dentro do orçamento, sem varredura destrutiva', () => {
  const store = new Store(':memory:'); seed(store, 11);
  const sizes = store.db.prepare("SELECT id,length(CAST(data AS BLOB)) AS n FROM tenants WHERE reseller_id='ws-a' ORDER BY id").all();
  const index = tenantIndex(store, { fullBudgetBytes: sizes[0].n + sizes[1].n });
  const admin = { userId: 'u-1', role: 'reseller', resellerId: 'ws-a', name: 'Admin' };
  for (let round = 0; round < 3; round++) for (const { id } of sizes) index.read(admin, id, 'full', tenant => tenant, { full: true });
  assert.ok(index.fullBytes <= sizes[0].n + sizes[1].n);
  assert.equal(index.stats.hits, 4, 'the two documents within the budget are reused on later rounds');
  assert.ok(Object.isFrozen(index.read(admin, sizes[0].id, 'full', tenant => tenant, { full: true }).conversations));
  store.mutate(admin, sizes[0].id, 'teste', tenant => { tenant.name = 'Nova'; });
  assert.equal(index.read(admin, sizes[0].id, 'full', tenant => tenant, { full: true }).name, 'Nova');
  store.close();
});
