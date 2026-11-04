// Disposable synthetic benchmark: no application server, gateway, provider, real database path or customer data.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { SCOPED_REPLACEMENT_PROOF_ERROR } from '../src/service-read-model.js';
import { Outbox, automatedFields } from '../src/outbox.js';
import { createEventBus } from '../src/events.js';
import { journalStatus, materializeForLegacy } from '../src/conversation-journal.js';
import { measureMaterialization } from './measure-materialization.mjs';

const args = process.argv.slice(2);
if (!args.includes('--synthetic') || process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Execute somente no pool CI Linux autorizado: CI=true node scripts/agent-capacity.mjs --synthetic [--out caminho.json]');
if (args.some((value, index) => value !== '--synthetic' && value !== '--out' && args[index - 1] !== '--out') || args.includes('--out') && !args[args.indexOf('--out') + 1]) throw new Error('Opções permitidas: --synthetic e --out caminho.json. O perfil e seus limites são fixos.');
const output = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : null;
const profile = { tenants: 2, contexts: 10000, contextsPerTenant: 5000, messagesPerContext: 20, turns: 90, arrivalRatePerSecond: 3, offeredWindowMs: 30000, concurrency: 4, repeatedEvery: 11,
  inventoryDeadlineMs: 120000, turnP95LimitMs: 1000, authorizationP95LimitMs: 100, reservationP95LimitMs: 100, modelMs: 0, writeSamples: 30 };
const directory = mkdtempSync(join(tmpdir(), 'elozi-capacity-synthetic-')), path = join(directory, 'fixture.sqlite');
const timings = {}, failures = [], effects = new Map(), inventories = [], jobs = [];
let store, phase = 'setup', networkAttempts = 0, peakRss = process.memoryUsage().rss, duplicateEffects = 0, outOfScope = 0;
let eventCount = 0;
const clock = () => performance.now(), settle = () => new Promise(resolve => setImmediate(resolve));
const sample = (name, elapsed) => { (timings[name] ||= []).push(elapsed); peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const stats = values => {
  const sorted = [...(values || [])].sort((a, b) => a - b), percentile = value => sorted.length ? round(sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]) : null;
  return { count: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.length ? round(sorted.at(-1)) : null };
};
const size = file => { try { return statSync(file).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
const originalMessagesHash = conversations => {
  const hash = createHash('sha256');
  for (const conversation of conversations) hash.update(JSON.stringify([conversation.id, conversation.messages.slice(0, profile.messagesPerContext)]));
  return hash.digest('hex');
};
const oldFetch = globalThis.fetch, oldConnect = net.Socket.prototype.connect;
const denyNetwork = () => { networkAttempts++; throw new Error('Rede proibida na fixture de capacidade.'); };
globalThis.fetch = denyNetwork; net.Socket.prototype.connect = denyNetwork;
const cpuBefore = process.cpuUsage(), wallBefore = clock(), eventLoop = monitorEventLoopDelay({ resolution: 10 }), utilizationBefore = performance.eventLoopUtilization();
eventLoop.enable();
let report;
try {
  store = new Store(path, { conversationJournal: true });
  store.events = createEventBus({ onError: error => failures.push({ phase, message: error.message }) });
  store.events.subscribe(() => { eventCount++; });
  store.onEventError = error => failures.push({ phase, message: error.message });
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const principals = new ServicePrincipals(store, auth), outbox = new Outbox(store, { authorize: () => true });
  const products = [];
  for (const label of ['fp', 'fc']) {
    const workspaceId = `capacity-${label}`, tenantId = `capacity-${label}-tenant`, agentId = `capacity-${label}-agent`, channelId = `capacity-${label}-channel`;
    store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspaceId, JSON.stringify({ name: `Produto sintético ${label}` }));
    const admin = auth.actor(auth.insertUser({ username: `capacity.${label}`, name: `Admin sintético ${label}` }, Buffer.alloc(16, 8), Buffer.alloc(64, 8), 'reseller', [], workspaceId));
    const conversations = Array.from({ length: profile.contextsPerTenant }, (_, index) => ({ id: `${label}-conversation-${String(index).padStart(5, '0')}`, contact: `Contato sintético ${index}`, channelId, departmentId: 'support',
      conversationKind: 'direct', owner: 'agent', agentId, version: 1, status: 'open', unread: 1, updatedAt: '2026-10-22T12:00:00.000Z',
      messages: Array.from({ length: profile.messagesPerContext }, (_, message) => ({ id: `${label}-${index}-message-${message}`, kind: 'customer', text: `Solicitação sintética ${message}; produto ${label}; contexto ${index}.`, createdAt: '2026-10-22T12:00:00.000Z' })) }));
    const value = { name: `Produto sintético ${label}`, channels: [{ id: channelId, name: 'Canal sintético sem conexão', kind: 'webchat', state: 'planned' }],
      agents: [{ id: agentId, name: 'Agente MCP sintético', provider: 'mcp', mode: 'copilot', configured: true, version: 1, description: 'Nenhum modelo é chamado.', tools: [] }],
      departments: [{ id: 'support', name: 'Suporte', active: true }], conversations };
    const started = clock(); store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(tenantId, workspaceId, JSON.stringify(value)); sample('setupTenantInsert', clock() - started);
    const created = principals.create(admin, tenantId, { name: `Serviço sintético ${label}`, agentId, capabilities: ['conversation.read', 'reply.send'], channelIds: [channelId], departmentIds: ['support'], dailyRequests: 10000, maxConcurrent: 8, ttlHours: 1 });
    products.push({ label, workspaceId, tenantId, channelId, admin, originalHash: originalMessagesHash(conversations), actor: principals.authenticate('Bearer ' + created.token) });
    await settle();
  }
  for (const method of ['authorize', 'revalidate', 'reserve', 'beginDispatch']) {
    const original = principals[method];
    principals[method] = function (...values) { const started = clock(); try { return original.apply(this, values); } finally { sample(`${phase}:${method}`, clock() - started); } };
  }
  const api = new ServiceApi(store, principals, {}, { sendPrivate: async (_actor, { context, input, idempotencyKey, internalActor, reauthorize }) => {
    const started = clock(), product = products.find(value => value.tenantId === context.tenantId);
    if (!product || !input.conversationId.startsWith(`${product.label}-`) || internalActor.tenantId !== product.tenantId) { outOfScope++; throw new Error('Efeito sintético fora do tenant.'); }
    await outbox.dispatch(internalActor, context.tenantId, context.conversationId, { ...input, channelId: context.channelId, idempotencyKey }, async () => {
      reauthorize(); const writeStarted = clock();
      store.mutateConversation(internalActor, context.tenantId, context.conversationId, 'Capacidade: saída do provedor exclusivamente sintético', conversation => {
        reauthorize(); store.getConversation({ conversations: [conversation] }, context.conversationId, input.version);
        assert.equal(conversation.channelId, context.channelId); assert.equal(conversation.agentId, internalActor.agentId);
        conversation.messages.push({ id: `fake-${idempotencyKey}`, kind: 'agent', text: input.text, ...automatedFields(internalActor, { idempotencyKey }),
          createdAt: new Date().toISOString(), delivery: 'sent', transport: 'synthetic' });
        conversation.version++; conversation.unread = 0; conversation.updatedAt = new Date().toISOString();
      });
      sample('traffic:outgoingWrite', clock() - writeStarted);
      const count = (effects.get(idempotencyKey) || 0) + 1; effects.set(idempotencyKey, count); if (count > 1) duplicateEffects++;
      await settle(); return store.serviceTenant(product.workspaceId, product.tenantId, { conversationId: context.conversationId }).conversations[0];
    }, { reauthorize });
    sample('traffic:fakeDispatch', clock() - started);
    return { state: 'confirmed', messageId: `fake-${idempotencyKey}` };
  } });

  phase = 'inventory';
  const allIds = new Set();
  for (const product of products) {
    let cursor, pages = 0, duplicates = 0; const ids = new Set(), started = clock();
    try {
      do {
        const pageStarted = clock(), page = api.inbox(product.actor, { requestId: `capacity-inventory-${product.label}-${pages}`, limit: 50, ...(cursor ? { cursor } : {}) });
        sample('inventory:page', clock() - pageStarted);
        for (const conversation of page.conversations) {
          if (!conversation.id.startsWith(`${product.label}-`)) outOfScope++;
          if (ids.has(conversation.id) || allIds.has(conversation.id)) duplicates++;
          ids.add(conversation.id); allIds.add(conversation.id);
        }
        cursor = page.nextCursor; pages++;
        if (pages > Math.ceil(profile.contextsPerTenant / 50) + 1 || clock() - started > profile.inventoryDeadlineMs) throw new Error('Inventário excedeu o prazo ou repetiu páginas.');
        await settle();
      } while (cursor);
    } catch (error) { failures.push({ phase, product: product.label, message: error.message }); }
    inventories.push({ product: product.label, ids: ids.size, duplicates, pages, complete: !cursor && ids.size === profile.contextsPerTenant, durationMs: round(clock() - started) });
  }

  phase = 'history';
  for (let index = 0; index < 30; index++) {
    const product = products[index % products.length], started = clock();
    const history = store.serviceTenant(product.workspaceId, product.tenantId, { conversationId: `${product.label}-conversation-${String(index).padStart(5, '0')}`, includeMessages: true });
    sample('history:singleConversation', clock() - started); assert.equal(history.conversations.length, 1); assert.equal(history.conversations[0].messages.length, profile.messagesPerContext); await settle();
  }
  phase = 'traffic';
  const queue = [], trafficStarted = clock(); let active = 0, completed = 0, peakQueue = 0, peakActive = 0, repeats = 0, complete;
  const done = new Promise(resolve => { complete = resolve; });
  const execute = async job => {
    const product = products[job.index % products.length], conversationId = `${product.label}-conversation-${String(job.index).padStart(5, '0')}`;
    job.startedMs = clock() - trafficStarted; sample('traffic:queue', clock() - job.planned);
    try {
      const writeStarted = clock();
      store.mutateConversation(product.admin, product.tenantId, conversationId, 'Capacidade: entrada exclusivamente sintética', conversation => {
        conversation.messages.push({ id: `capacity-inbound-${job.index}`, kind: 'customer', text: 'Nova solicitação exclusivamente sintética.', createdAt: new Date().toISOString(), transport: 'synthetic' });
        conversation.version++; conversation.unread++; conversation.updatedAt = new Date().toISOString();
      });
      sample('traffic:incomingWrite', clock() - writeStarted);
      const current = store.serviceTenant(product.workspaceId, product.tenantId, { conversationId }).conversations[0];
      const input = { requestId: `capacity-turn-${String(job.index).padStart(5, '0')}`, conversationId, version: current.version, text: 'Resposta exclusivamente sintética.' };
      const result = await api.sendReply(product.actor, input); assert.equal(result.receipt.state, 'confirmed');
      if (job.index % profile.repeatedEvery === 0) {
        const before = effects.size, replay = await api.sendReply(product.actor, input); repeats++;
        assert.equal(replay.receipt.id, result.receipt.id); assert.equal(effects.size, before, 'o replay não produz outro efeito');
      }
      job.ok = true;
    } catch (error) { job.ok = false; failures.push({ phase, turn: job.index, message: error.message }); }
    finally { job.elapsedMs = clock() - job.planned; sample('traffic:turn', job.elapsedMs); }
  };
  const pump = () => {
    while (queue.length && active < profile.concurrency) {
      const job = queue.shift(); active++; peakActive = Math.max(peakActive, active);
      execute(job).finally(() => { active--; completed++; if (completed === profile.turns) complete(); else pump(); }).catch(error => { failures.push({ phase, message: error.message }); });
    }
  };
  // Schedule all arrivals against one clock. Never await the previous turn to determine the next offered arrival.
  for (let index = 0; index < profile.turns; index++) {
    const planned = trafficStarted + index * 1000 / profile.arrivalRatePerSecond, job = { index, planned }; jobs.push(job);
    setTimeout(() => { sample('traffic:arrivalLag', clock() - planned); queue.push(job); peakQueue = Math.max(peakQueue, queue.length); pump(); }, Math.max(0, planned - clock()));
  }
  await Promise.all([done, new Promise(resolve => setTimeout(resolve, Math.max(0, trafficStarted + profile.offeredWindowMs - clock())))]);
  const trafficDurationMs = clock() - trafficStarted;

  // Journal rows are durable authority, not queued work. Prove and materialize their
  // effective data after the measured traffic window, before the legacy reference samples.
  const journalBefore = journalStatus(store.db), materializeStarted = clock();
  const { receipt: materialization, diagnostics: materializationDiagnostics } = measureMaterialization(store.db, () => materializeForLegacy(store.db));
  sample('audit:materializeForLegacy', clock() - materializeStarted);
  const journalAfter = journalStatus(store.db);
  const journalAudit = { before: journalBefore, after: journalAfter, materialization, materializationDiagnostics };

  phase = 'writes';
  const rawUpdate = store.db.prepare('UPDATE tenants SET data=? WHERE id=?'), writes = {};
  for (const projected of [true, false]) {
    const name = projected ? 'projected' : 'sourceOnly', durations = [], serialization = [], changedRows = [];
    // Compare individual UPDATE costs inside equivalent transactions. Commit/fsync remains part of traffic above,
    // but is deliberately outside these samples; otherwise sourceOnly rollback would unfairly avoid autocommit.
    store.db.exec('SAVEPOINT capacity_write_sample');
    if (!projected) store.db.exec('DROP TRIGGER service_read_insert_v1; DROP TRIGGER service_read_before_update_v1; DROP TRIGGER service_read_update_v1; DROP TRIGGER service_read_noop_update_v1; DROP TRIGGER service_read_delete_v1;');
    try {
      const value = JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get(products[0].tenantId).data);
      for (let index = 0; index < profile.writeSamples; index++) {
        value.conversations[0].version++; value.conversations[0].updatedAt = new Date(Date.now() + index).toISOString();
        let started = clock(); const encoded = JSON.stringify(value); serialization.push(clock() - started);
        const before = store.db.prepare('SELECT total_changes() AS n').get().n; started = clock(); rawUpdate.run(encoded, products[0].tenantId); durations.push(clock() - started);
        changedRows.push(store.db.prepare('SELECT total_changes() AS n').get().n - before); peakRss = Math.max(peakRss, process.memoryUsage().rss); await settle();
      }
    } finally {
      if (!projected) store.db.exec('ROLLBACK TO capacity_write_sample');
      store.db.exec('RELEASE capacity_write_sample');
    }
    writes[name] = { sqlite: stats(durations), serialization: stats(serialization), changedRows: { min: Math.min(...changedRows), max: Math.max(...changedRows) } };
  }
  // Same canonical tenant and equivalent transaction boundary, now exercising the verified scoped writer.
  // Keep the legacy full UPDATE measurements above: old writers still pay their real projection cost.
  {
    const durations = [], serialization = [], changedRows = [], value = JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get(products[0].tenantId).data).conversations[0];
    let spliceAttempts = 0, proofFallbacks = 0, zeroRowUpdates = 0;
    store.db.exec('SAVEPOINT capacity_scoped_sample');
    try {
      for (let index = 0; index < profile.writeSamples; index++) {
        value.version++; value.updatedAt = new Date(Date.now() + index).toISOString();
        let started = clock(); const encoded = JSON.stringify(value); serialization.push(clock() - started);
        const before = store.db.prepare('SELECT total_changes() AS n').get().n; started = clock();
        store.serviceReadModel.withConversationWrite({ tenantId: products[0].tenantId, workspaceId: products[0].workspaceId, position: 0, conversationId: value.id, data: encoded, strict: true },
          ({ expectedSql, replacementSql }) => {
            let updated;
            spliceAttempts++;
            try { updated = store.db.prepare(`UPDATE tenants SET data=${replacementSql} WHERE id=?`).run(products[0].tenantId); }
            catch (error) {
              if (error.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 1811 || error.message !== SCOPED_REPLACEMENT_PROOF_ERROR) throw error;
              proofFallbacks++;
              updated = store.db.prepare(`UPDATE tenants SET data=${expectedSql} WHERE id=?`).run(products[0].tenantId);
            }
            if (updated.changes === 0) zeroRowUpdates++;
            return updated;
          });
        durations.push(clock() - started); changedRows.push(store.db.prepare('SELECT total_changes() AS n').get().n - before); await settle();
      }
    } finally { store.db.exec('RELEASE capacity_scoped_sample'); }
    writes.scoped = { sqlite: stats(durations), serialization: stats(serialization), changedRows: { min: Math.min(...changedRows), max: Math.max(...changedRows) },
      spliceAttempts, proofFallbacks, zeroRowUpdates,
      method: 'Strict replacementSql; only the exact proof error retries expectedSql within the same guard. Attempts include the expression\'s internal fallback; zeroRowUpdates does not count missing fragments.' };
  }
  const walBytes = size(path + '-wal'), databaseBytes = size(path);
  const sourceBytes = store.db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS n FROM tenants WHERE id LIKE ?').get('capacity-%').n;
  const projectionBytes = store.db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS n FROM service_conversation_read WHERE tenant_id LIKE ?').get('capacity-%').n;
  const messageAudit = { originalCount: profile.contexts * profile.messagesPerContext, total: 0, incoming: 0, outgoing: 0, uniqueCommands: 0, duplicates: 0, hashes: [] }, commands = new Map();
  for (const product of products) {
    const value = JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get(product.tenantId).data);
    messageAudit.hashes.push({ product: product.label, before: product.originalHash, after: originalMessagesHash(value.conversations) });
    for (const conversation of value.conversations) for (const message of conversation.messages) {
      messageAudit.total++;
      if (message.id.startsWith('capacity-inbound-')) messageAudit.incoming++;
      if (message.serviceCommandId) {
        messageAudit.outgoing++; commands.set(message.serviceCommandId, (commands.get(message.serviceCommandId) || 0) + 1);
        if (message.authorServiceId !== product.actor.principalId || !conversation.id.startsWith(`${product.label}-`)) outOfScope++;
      }
    }
  }
  messageAudit.uniqueCommands = commands.size; messageAudit.duplicates = [...commands.values()].filter(value => value !== 1).length;
  const trafficTurn = stats(timings['traffic:turn']), authorization = stats(timings['traffic:revalidate']), reservation = stats(timings['traffic:reserve']);
  const checks = {
    inventoryComplete: inventories.length === 2 && inventories.every(value => value.complete && value.duplicates === 0 && value.durationMs <= profile.inventoryDeadlineMs) && allIds.size === profile.contexts,
    trafficComplete: completed === profile.turns && jobs.every(value => value.ok) && queue.length === 0 && active === 0,
    turnP95: trafficTurn.p95Ms !== null && trafficTurn.p95Ms <= profile.turnP95LimitMs,
    authorizationP95: authorization.p95Ms !== null && authorization.p95Ms <= profile.authorizationP95LimitMs,
    reservationP95: reservation.p95Ms !== null && reservation.p95Ms <= profile.reservationP95LimitMs,
    effects: effects.size === profile.turns && duplicateEffects === 0 && outOfScope === 0 && repeats === Math.ceil(profile.turns / profile.repeatedEvery),
    persistedMessages: messageAudit.total === messageAudit.originalCount + 2 * profile.turns && messageAudit.incoming === profile.turns && messageAudit.outgoing === profile.turns
      && messageAudit.uniqueCommands === profile.turns && messageAudit.duplicates === 0 && messageAudit.hashes.every(value => value.before === value.after),
    confirmedDispatches: store.db.prepare("SELECT count(*) AS n FROM outbound_commands WHERE state='confirmed'").get().n === profile.turns
      && store.db.prepare("SELECT count(*) AS n FROM service_principal_receipts WHERE capability='reply.send' AND state='confirmed'").get().n === profile.turns,
    committedEvents: eventCount >= 2 * profile.turns,
    noNetwork: networkAttempts === 0,
    journalPreserved: journalBefore.active && journalBefore.rows === profile.turns && !journalAfter.active && journalAfter.rows === 0
      && materialization.before.logicalHash === materialization.after.logicalHash && Object.values(materialization.checks).every(value => value === true),
    queuesDrained: queue.length === 0 && active === 0 && store.db.prepare("SELECT count(*) AS n FROM service_principal_receipts WHERE state IN ('reserved','dispatched')").get().n === 0
      && store.db.prepare("SELECT count(*) AS n FROM outbound_commands WHERE state IN ('pending','in_flight')").get().n === 0
      && store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n === 0
      && store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='service_conversation_write_proof'").get().n === 0
  };
  const sqliteSettings = Object.fromEntries(['cache_size', 'synchronous', 'page_size', 'wal_autocheckpoint', 'cache_spill', 'journal_mode'].map(name => [name, Object.values(store.db.prepare(`PRAGMA main.${name}`).get())[0]]));
  sqliteSettings.version = store.db.prepare('SELECT sqlite_version() AS version').get().version;
  const cpu = process.cpuUsage(cpuBefore), utilization = performance.eventLoopUtilization(utilizationBefore);
  report = { schemaVersion: 1, synthetic: true, revision: process.env.GITHUB_SHA || null, accepted: Object.values(checks).every(Boolean) && failures.length === 0, profile, checks, inventories,
    traffic: { completed, succeeded: jobs.filter(value => value.ok).length, durationMs: round(trafficDurationMs), peakQueue, peakActive, remainingQueue: queue.length, repeats, uniqueEffects: effects.size, duplicateEffects, outOfScope,
      deadlineMisses: jobs.filter(value => value.elapsedMs > profile.turnP95LimitMs).length },
    messageAudit, journalAudit, eventCount, timings: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, stats(values)])), writes: { ...writes,
      method: 'Traffic uses the opt-in durable conversation journal. After measured traffic, hash/count/FK/side-effect-verified materialization precedes the unchanged legacy UPDATE reference loops. Reference samples run within SAVEPOINTs and exclude commit/fsync.',
      projectionToSourceOnlyWithinTransactionP95: round(writes.projected.sqlite.p95Ms / writes.sourceOnly.sqlite.p95Ms) },
    resources: { maxRssBytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024), cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000), wallMs: round(clock() - wallBefore), eventLoopUtilization: round(utilization.utilization),
      eventLoopDelay: { meanMs: round(eventLoop.mean / 1e6), p50Ms: round(eventLoop.percentile(50) / 1e6), p95Ms: round(eventLoop.percentile(95) / 1e6), p99Ms: round(eventLoop.percentile(99) / 1e6), maxMs: round(eventLoop.max / 1e6) }, walBytes, databaseBytes, sourceBytes, projectionBytes, sqliteSettings },
    limitations: ['Modelo e canal reais ausentes; este ensaio não demonstra 10 mil usuários simultâneos.', 'EventBus, snapshot/diff, entrada/saída e outbox reais; não há fanout externo nem sessão de gateway.', 'Tráfego oferecido é hipótese explícita de 3 turnos/s; escrita e leitura têm métricas separadas.', 'O journal é opt-in nesta fixture; tenants.data recebe a materialização verificada fora da janela de tráfego.'], failures: failures.slice(0, 20) };
} catch (error) { report = { schemaVersion: 1, synthetic: true, accepted: false, profile, setupFailure: error.message, failures: failures.slice(0, 20) }; }
finally {
  eventLoop.disable(); globalThis.fetch = oldFetch; net.Socket.prototype.connect = oldConnect;
  try { store?.events?.close(); store?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
if (!report.accepted) process.exitCode = 1;
