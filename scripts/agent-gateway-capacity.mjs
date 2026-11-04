// Real application/WhatsApp journey with disposable synthetic state and an in-process provider socket only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import net from 'node:net';
import { journalStatus, materializeForLegacy } from '../src/conversation-journal.js';
import { measureMaterialization } from './measure-materialization.mjs';

const args = process.argv.slice(2);
if (process.platform !== 'linux' || process.env.CI !== 'true' || !args.includes('--synthetic')) throw new Error('Execute somente no CI Linux autorizado: CI=true node scripts/agent-gateway-capacity.mjs --synthetic [--out caminho.json]');
if (args.some((value, index) => value !== '--synthetic' && value !== '--out' && args[index - 1] !== '--out') || args.includes('--out') && !args[args.indexOf('--out') + 1]) throw new Error('Somente --synthetic e --out são permitidos; perfil e critérios são fixos.');
const output = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : null;
const profile = { tenants: 2, contexts: 10000, contextsPerTenant: 5000, messagesPerContext: 20, turns: 90, arrivalRatePerSecond: 3,
  offeredWindowMs: 30000, concurrency: 4, repeatedEvery: 11, inventoryDeadlineMs: 120000, turnP95LimitMs: 1000,
  authorizationP95LimitMs: 100, reservationP95LimitMs: 100, modelMs: 0, gateway: 'in-process-fake-Baileys', httpListener: false,
  agentProvider: 'mcp', agentMode: 'copilot', principalMaxConcurrent: 8 };
const directory = mkdtempSync(join(tmpdir(), 'elozi-gateway-capacity-')), databasePath = join(directory, 'canonical.sqlite');
const clock = () => performance.now(), settle = () => new Promise(resolve => setImmediate(resolve));
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const stats = values => {
  const sorted = [...(values || [])].sort((a, b) => a - b), quantile = fraction => sorted.length ? round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]) : null;
  return { count: sorted.length, p50Ms: quantile(.5), p95Ms: quantile(.95), p99Ms: quantile(.99), maxMs: sorted.length ? round(sorted.at(-1)) : null };
};
const size = path => { try { return statSync(path).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const historyHash = conversations => {
  const hash = createHash('sha256');
  for (const conversation of conversations) hash.update(JSON.stringify([conversation.id, conversation.messages.slice(0, profile.messagesPerContext)]));
  return hash.digest('hex');
};
const timings = {}, calls = {}, failures = [], products = [], sockets = new Map(), effects = new Map(), inventories = [], jobs = [];
const scopedWriteCounts = {};
let restoreScopedWriteSql = () => {};
let trafficTelemetry, trafficEventLoop;
let app, openingProduct, phase = 'setup', report, networkAttempts = 0, modelAttempts = 0, duplicateEffects = 0, outOfScope = 0, peakRss = process.memoryUsage().rss;
let eventCount = 0, trafficEvents = 0, incomingEvents = 0, outgoingEvents = 0;
const sample = (name, elapsed) => { (timings[name] ||= []).push(elapsed); peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const countCall = name => { const key = `${phase}:${name}`; calls[key] = (calls[key] || 0) + 1; };
const instrument = (object, method, label = method) => {
  const original = object[method];
  if (typeof original !== 'function') return;
  object[method] = function (...values) { const started = clock(); countCall(label); try { return original.apply(this, values); } finally { sample(`${phase}:${label}`, clock() - started); } };
};
const instrumentScopedWriteSql = store => {
  const db = store.db, prepare = db.prepare, exec = db.exec, mutateConversation = store.mutateConversation;
  let active = null;
  db.prepare = function (sql, ...values) {
    const statement = prepare.call(this, sql, ...values), context = active;
    const journalWrite = typeof sql === 'string' && /^\s*INSERT\s+INTO\s+conversation_journal\s*\(/i.test(sql);
    if (!context || typeof sql !== 'string' || !journalWrite && !/^\s*UPDATE\s+tenants\s+SET\s+data\s*=/i.test(sql)) return statement;
    const run = statement.run;
    statement.run = function (...parameters) {
      if (active !== context) return run.apply(this, parameters);
      context.updates++; context.counts.updateAttempts++;
      const started = clock();
      try {
        const result = run.apply(this, parameters);
        if (result.changes === 1) context.counts[journalWrite ? 'journalUpdates' : 'canonicalUpdates']++;
        return result;
      } finally { sample(`${context.phase}:store.mutateConversation.${journalWrite ? 'sqliteJournalUpdate' : 'sqliteUpdate'}`, clock() - started); }
    };
    return statement;
  };
  db.exec = function (sql, ...values) {
    const context = active;
    if (!context || typeof sql !== 'string' || !/^\s*COMMIT\s*;?\s*$/i.test(sql)) return exec.call(this, sql, ...values);
    context.counts.commitAttempts++;
    const started = clock();
    try { const result = exec.call(this, sql, ...values); context.counts.commits++; return result; }
    finally { sample(`${context.phase}:store.mutateConversation.sqliteCommit`, clock() - started); }
  };
  store.mutateConversation = function (...values) {
    const parent = active, counts = scopedWriteCounts[phase] ||= { calls: 0, withUpdate: 0, conversationNoop: 0, failed: 0, updateAttempts: 0, canonicalUpdates: 0, journalUpdates: 0, commitAttempts: 0, commits: 0 };
    const context = { phase, counts, updates: 0 };
    active = context; counts.calls++;
    try { const result = mutateConversation.apply(this, values); if (!context.updates) counts.conversationNoop++; return result; }
    catch (error) { counts.failed++; throw error; }
    finally { if (context.updates) counts.withUpdate++; active = parent; }
  };
  return () => { db.prepare = prepare; db.exec = exec; store.mutateConversation = mutateConversation; };
};
const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect;
const denyNetwork = () => { networkAttempts++; throw new Error('Rede externa/loopback proibida na fixture sintética.'); };
const denyModel = () => { modelAttempts++; throw new Error('Modelo proibido na fixture sintética.'); };
globalThis.fetch = denyNetwork; net.Socket.prototype.connect = denyNetwork;
const cpuBefore = process.cpuUsage(), wallBefore = clock(), utilizationBefore = performance.eventLoopUtilization(), eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
try {
  // Import after the CI guard and network fencing. No production entrypoint, config loader or listener is invoked.
  const [{ createApp }, { proto }, { boundConversationContact }] = await Promise.all([import('../src/server.js'), import('@whiskeysockets/baileys'), import('../src/contacts.js')]);
  const key = Buffer.alloc(32, 61), vault = { get: () => undefined, set: () => { throw new Error('A fixture não grava configuração privada de integrações.'); } };
  const socketFactory = config => {
    const product = openingProduct; assert.ok(product, 'a conexão sintética precisa ter um tenant explícito');
    const socket = { config, ev: new EventEmitter(), user: { id: `${product.ownNumber}:1@s.whatsapp.net` }, end() {}, async logout() {} };
    socket.sendMessage = async (remoteJid, content, options) => {
      const conversationId = product.byJid.get(remoteJid);
      if (!conversationId || typeof content.text !== 'string' || !options?.messageId) { outOfScope++; throw new Error('Disparo fora da identidade/canal sintéticos.'); }
      const count = (effects.get(options.messageId)?.count || 0) + 1;
      effects.set(options.messageId, { count, tenantId: product.tenantId, conversationId, channelId: product.channelId });
      if (count !== 1) duplicateEffects++;
      // Exercise both the normal echo dedupe and the installed ACK handler; never set delivery in the fake provider.
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: options.messageId, remoteJid, fromMe: true }, message: { conversation: content.text } }] });
      socket.ev.emit('messages.update', [{ key: { id: options.messageId, remoteJid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ } }]);
      await settle();
      return { key: { id: options.messageId, remoteJid, fromMe: true } };
    };
    sockets.set(product.channelId, socket); return socket;
  };
  app = createApp({ databasePath, conversationJournal: true, serviceKey: key, providerCall: denyModel, mcpFetchImpl: denyNetwork, postgres: false,
    publicOrigin: '', releaseRevision: '', allowDemo: false, allowRegistration: false, publicTrialEnabled: false,
    agentOrigins: [], agentProfileOrigins: [], mcpOrigins: [], mcpPrivateOrigins: [], trustedProxies: [], serviceReplyLimits: [], serviceMediaPolicy: [],
    gatewayOptions: { authKey: key, socketFactory, fetchImpl: denyNetwork }, telegramOptions: { authKey: key, polling: false, fetchImpl: denyNetwork },
    telegramUserOptions: { authKey: key, clientFactory: denyNetwork }, googleOptions: { clientId: '', jwks: denyNetwork },
    emailOptions: { apiKey: '', from: '', fetchImpl: denyNetwork, key }, mediaOptions: { directory: join(directory, 'media'), authKey: key, keyLoader: async () => key },
    emailChannelOptions: { fetchImpl: denyNetwork, loadSecrets: async () => vault, getDeliveryConfiguration: async () => ({ apiKey: '', from: '' }) },
    metaOptions: { fetchImpl: denyNetwork, secretLoader: async () => vault }, domainOptions: { canonicalHost: 'gateway-capacity.example.com', inspectDeployment: null,
      resolver: { resolveTxt: denyNetwork, resolveCname: denyNetwork } },
    webhookOptions: { post: denyNetwork, loadSecrets: async () => vault }, voiceNormalizer: denyNetwork });
  assert.equal(app.server.listening, false);
  const { store, auth, servicePrincipals: principals, serviceApi: api } = app;
  for (const method of ['tenant', 'conversationTenant', 'readonlyConversationTenant', 'serviceTenant', 'mutate', 'mutateConversation', 'queuePostgres']) instrument(store, method, `store.${method}`);
  restoreScopedWriteSql = instrumentScopedWriteSql(store);
  for (const method of ['authorize', 'revalidate', 'reserve', 'beginDispatch']) instrument(principals, method, `principals.${method}`);
  const originalEventError = store.onEventError;
  store.onEventError = error => { failures.push({ phase, kind: 'event-publication', message: error.message }); originalEventError?.(error); };
  app.events.subscribe(event => {
    eventCount++;
    if (phase !== 'traffic') return;
    trafficEvents++;
    const product = products.find(item => item.tenantId === event.tenantId);
    if (!product || event.conversationId && !product.expectedIds.has(event.conversationId) || event.channelId && event.channelId !== product?.channelId) outOfScope++;
    if (event.type === 'conversation.message' && event.kind === 'customer') incomingEvents++;
    if (event.type === 'conversation.message' && event.kind === 'agent') outgoingEvents++;
  });
  for (const [productIndex, label] of ['fp', 'fc'].entries()) {
    const workspaceId = `gateway-${label}`, tenantId = `gateway-${label}-tenant`, channelId = `gateway-${label}-channel`, agentId = `gateway-${label}-agent`;
    const product = { label, workspaceId, tenantId, channelId, agentId, ownNumber: `551199999000${productIndex}`, expectedIds: new Set(), byJid: new Map(), byId: new Map() };
    store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspaceId, JSON.stringify({ name: `Produto sintético ${label}`, accountKind: 'business', version: 1 }));
    const user = auth.insertUser({ username: `gateway.capacity.${label}`, name: `Administrador sintético ${label}` }, Buffer.alloc(16, 9), Buffer.alloc(64, 9), 'reseller', [], workspaceId);
    product.admin = auth.session(user).actor;
    const contacts = [], conversations = Array.from({ length: profile.contextsPerTenant }, (_, index) => {
      const id = `${label}-conversation-${String(index).padStart(5, '0')}`, remoteJid = `55119${productIndex ? '7' : '8'}${String(index).padStart(7, '0')}@s.whatsapp.net`, contactId = `${label}-contact-${index}`;
      product.expectedIds.add(id); product.byJid.set(remoteJid, id); product.byId.set(id, remoteJid);
      contacts.push({ id: contactId, name: `Contato sintético ${index}`, type: 'person', phone: remoteJid.split('@')[0], email: '', notes: '', tags: [],
        identities: [{ channelId, kind: 'person', externalId: remoteJid }], version: 1, createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '2026-10-22T12:00:00.000Z' });
      return { id, channelId, remoteJid, remoteAliases: [remoteJid], contactId, contactSyncStatus: 'linked', contact: `Contato sintético ${index}`, conversationKind: 'direct', departmentId: 'support', department: 'Suporte',
        owner: 'agent', agentId, assignedUserId: null, status: 'open', version: 1, unread: 0, tags: [], updatedAt: '2026-10-22T12:00:00.000Z', privateState: { synthetic: true },
        messages: Array.from({ length: profile.messagesPerContext }, (_, number) => ({ id: `${label}-old-${index}-${number}`, externalId: `${label}-old-provider-${index}-${number}`, kind: 'customer', text: `Solicitação sintética ${index}/${number}.`,
          delivery: 'received', transport: 'whatsapp', createdAt: '2026-10-22T12:00:00.000Z' })) };
    });
    product.originalHash = historyHash(conversations); product.contactsHash = digest(contacts);
    const value = { name: `Produto sintético ${label}`, contacts, conversations,
      channels: [{ id: channelId, name: 'WhatsApp inteiramente sintético', kind: 'whatsapp_qr', transport: 'baileys', expectedNumber: product.ownNumber, state: 'disconnected', defaultAgentId: agentId }],
      agents: [{ id: agentId, name: 'Agente MCP sintético', provider: 'mcp', mode: 'copilot', version: 1, configured: true, tools: [] }],
      departments: [{ id: 'support', name: 'Suporte', active: true, distribution: 'manual', memberIds: [], cursor: 0, version: 1 }], defaultDepartmentId: 'support', automation: { version: 1, bindings: [] },
      privateHeader: { synthetic: `preserved-${label}` }, flows: [], runs: [] };
    let started = clock(); store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(tenantId, workspaceId, JSON.stringify(value)); sample('setup:canonicalInsert', clock() - started);
    products.push(product); openingProduct = product;
    await app.gateway.start(product.admin, tenantId, channelId);
    const socket = sockets.get(channelId); socket.config.auth.creds.me = { id: `${product.ownNumber}:1@s.whatsapp.net` };
    socket.ev.emit('creds.update', {}); socket.ev.emit('connection.update', { connection: 'open' }); await settle(); await settle(); openingProduct = null;
    const entry = app.gateway.entries.get(channelId); assert.equal(entry.state, 'connected'); assert.equal(entry.matched, true);
    // Construct deterministic identity bindings once, then prove samples through the real read-only CRM guard.
    // Calling syncContact inside 10k full Store.mutate operations would benchmark setup rather than this journey.
    for (const index of [0, Math.floor(profile.contextsPerTenant / 2), profile.contextsPerTenant - 1]) {
      const selected = store.conversationTenant(product.admin, tenantId, `${label}-conversation-${String(index).padStart(5, '0')}`);
      assert.equal(boundConversationContact(selected, selected.conversations[0]).id, `${label}-contact-${index}`);
    }
    const created = principals.create(product.admin, tenantId, { name: `Serviço sintético ${label}`, agentId, capabilities: ['conversation.read', 'events.read', 'reply.send'], channelIds: [channelId], departmentIds: ['support'], dailyRequests: 10000, maxConcurrent: profile.principalMaxConcurrent, ttlHours: 1 });
    product.actor = principals.authenticate('Bearer ' + created.token);
    product.headerHash = digest(JSON.parse(store.db.prepare("SELECT json_remove(data,'$.conversations') AS data FROM tenants WHERE id=?").get(tenantId).data));
  }
  phase = 'inventory';
  const allIds = new Set();
  for (const product of products) {
    let cursor, pages = 0, duplicates = 0, unexpected = 0; const ids = new Set(), started = clock();
    try {
      do {
        const before = clock(), page = api.inbox(product.actor, { requestId: `gateway-inventory-${product.label}-${pages}`, limit: 50, ...(cursor ? { cursor } : {}) });
        sample('inventory:page', clock() - before);
        for (const conversation of page.conversations) {
          if (!product.expectedIds.has(conversation.id)) { unexpected++; outOfScope++; }
          if (ids.has(conversation.id) || allIds.has(conversation.id)) duplicates++;
          ids.add(conversation.id); allIds.add(conversation.id);
        }
        cursor = page.nextCursor; pages++;
        if (clock() - started > profile.inventoryDeadlineMs || pages > Math.ceil(profile.contextsPerTenant / 50) + 1) throw new Error('Inventário excedeu o prazo ou repetiu páginas.');
        await settle();
      } while (cursor);
    } catch (error) { failures.push({ phase, product: product.label, message: error.message }); }
    inventories.push({ product: product.label, pages, ids: ids.size, duplicates, unexpected, durationMs: round(clock() - started), complete: !cursor && ids.size === product.expectedIds.size && [...product.expectedIds].every(id => ids.has(id)) });
  }
  phase = 'traffic';
  const queue = [], trafficStarted = clock(); let active = 0, completed = 0, peakQueue = 0, peakActive = 0, repeats = 0, complete;
  const trafficCpuBefore = process.cpuUsage(), trafficUtilizationBefore = performance.eventLoopUtilization();
  trafficEventLoop = monitorEventLoopDelay({ resolution: 10 }); trafficEventLoop.enable();
  const done = new Promise(resolve => { complete = resolve; });
  const execute = async job => {
    job.started = clock(); sample('traffic:queue', job.started - job.planned);
    const product = products[job.index % products.length], conversationId = `${product.label}-conversation-${String(job.index).padStart(5, '0')}`, remoteJid = product.byId.get(conversationId);
    try {
      let started = clock();
      await app.gateway.receive(app.gateway.entries.get(product.channelId), { key: { id: `gateway-inbound-${job.index}`, remoteJid, fromMe: false },
        message: { conversation: 'Nova solicitação exclusivamente sintética.' }, messageTimestamp: Math.floor(Date.now() / 1000) });
      // Keep real asynchronous bus consumers in the offered workload; do not disable the autopilot or support.
      await settle(); sample('traffic:incomingHandler', clock() - started);
      const current = store.serviceTenant(product.workspaceId, product.tenantId, { conversationId }).conversations[0];
      assert.ok(current); const input = { requestId: `gateway-turn-${String(job.index).padStart(5, '0')}`, conversationId, version: current.version, text: 'Resposta exclusivamente sintética.' };
      started = clock(); const result = await api.sendReply(product.actor, input); sample('traffic:sendReply', clock() - started);
      assert.equal(result.receipt.state, 'confirmed');
      if (job.index % profile.repeatedEvery === 0) {
        const count = effects.size, replay = await api.sendReply(product.actor, input); repeats++;
        assert.equal(replay.receipt.id, result.receipt.id); assert.equal(effects.size, count, 'replay não pode disparar novamente');
      }
      job.ok = true;
    } catch (error) { job.ok = false; failures.push({ phase, turn: job.index, message: error.message }); }
    finally { job.ended = clock(); job.elapsedMs = job.ended - job.planned; sample('traffic:turn', job.elapsedMs); }
  };
  const pump = () => {
    while (queue.length && active < profile.concurrency) {
      active++; peakActive = Math.max(peakActive, active);
      execute(queue.shift()).finally(() => { active--; completed++; if (completed === profile.turns) complete(); else pump(); }).catch(error => failures.push({ phase, message: error.message }));
    }
  };
  for (let index = 0; index < profile.turns; index++) {
    const job = { index, planned: trafficStarted + index * 1000 / profile.arrivalRatePerSecond }; jobs.push(job);
    setTimeout(() => { job.arrived = clock(); sample('traffic:arrivalLag', job.arrived - job.planned); queue.push(job); peakQueue = Math.max(peakQueue, queue.length); pump(); }, Math.max(0, job.planned - clock()));
  }
  await Promise.all([done, new Promise(resolve => setTimeout(resolve, Math.max(0, trafficStarted + profile.offeredWindowMs - clock())))]);
  await settle(); await settle();
  const trafficEnded = clock(), trafficDurationMs = trafficEnded - trafficStarted;
  const trafficCpu = process.cpuUsage(trafficCpuBefore), trafficUtilization = performance.eventLoopUtilization(trafficUtilizationBefore);
  trafficEventLoop.disable();
  trafficTelemetry = { schemaVersion: 1,
    startedAtUtc: new Date(performance.timeOrigin + trafficStarted).toISOString(), endedAtUtc: new Date(performance.timeOrigin + trafficEnded).toISOString(),
    durationMs: round(trafficDurationMs), cpuUserMs: round(trafficCpu.user / 1000), cpuSystemMs: round(trafficCpu.system / 1000),
    eventLoopUtilization: round(trafficUtilization.utilization),
    eventLoopDelay: { meanMs: round(trafficEventLoop.mean / 1e6), p50Ms: round(trafficEventLoop.percentile(50) / 1e6),
      p95Ms: round(trafficEventLoop.percentile(95) / 1e6), p99Ms: round(trafficEventLoop.percentile(99) / 1e6), maxMs: round(trafficEventLoop.max / 1e6) },
    jobs: jobs.map(job => ({ index: job.index, plannedOffsetMs: round(job.planned - trafficStarted), arrivalOffsetMs: round(job.arrived - trafficStarted),
      startOffsetMs: round(job.started - trafficStarted), endOffsetMs: round(job.ended - trafficStarted) })),
    method: 'Traffic window through the existing final settles, before materialization/audit. UTC uses performance.timeOrigin plus monotonic bounds; job offsets use the same clock. Whole-process resources remain separate. GC, host pressure and cgroup throttling are not measured.' };
  phase = 'audit';
  const journalBefore = journalStatus(store.db), materializeStarted = clock();
  const { receipt: materialization, diagnostics: materializationDiagnostics } = measureMaterialization(store.db, () => materializeForLegacy(store.db));
  sample('audit:materializeForLegacy', clock() - materializeStarted);
  const journalAfter = journalStatus(store.db);
  const journalAudit = { before: journalBefore, after: journalAfter, materialization, materializationDiagnostics };
  const messageAudit = { originalCount: profile.contexts * profile.messagesPerContext, total: 0, incoming: 0, outgoing: 0, readDeliveries: 0, uniqueCommands: 0, duplicates: 0, hashes: [] }, commands = new Map(), externalIds = new Set();
  for (const product of products) {
    const value = JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=? AND reseller_id=?').get(product.tenantId, product.workspaceId).data);
    const { conversations: ignored, ...header } = value;
    messageAudit.hashes.push({ product: product.label, before: product.originalHash, after: historyHash(value.conversations), contactsUnchanged: product.contactsHash === digest(value.contacts), headersUnchanged: product.headerHash === digest(header) });
    assert.equal(value.conversations.length, product.expectedIds.size);
    assert.ok(value.conversations.every(conversation => product.expectedIds.has(conversation.id)));
    for (const conversation of value.conversations) for (const message of conversation.messages) {
      messageAudit.total++;
      if (message.externalId?.startsWith('gateway-inbound-')) messageAudit.incoming++;
      if (message.serviceCommandId) {
        messageAudit.outgoing++; if (message.delivery === 'read') messageAudit.readDeliveries++;
        commands.set(message.serviceCommandId, (commands.get(message.serviceCommandId) || 0) + 1); externalIds.add(message.externalId);
        const effect = effects.get(message.externalId);
        if (message.authorServiceId !== product.actor.principalId || !effect || effect.tenantId !== product.tenantId || effect.conversationId !== conversation.id || conversation.channelId !== product.channelId) outOfScope++;
      }
    }
  }
  messageAudit.uniqueCommands = commands.size; messageAudit.duplicates = [...commands.values()].filter(count => count !== 1).length;
  const commandsRows = store.db.prepare('SELECT tenant_id,conversation_id,idempotency_key,state,attempts FROM outbound_commands').all();
  const receipts = store.db.prepare("SELECT id,tenant_id,principal_id,state FROM service_principal_receipts WHERE capability='reply.send'").all();
  const waSeen = store.db.prepare('SELECT channel_id,count(*) AS count FROM wa_seen GROUP BY channel_id').all();
  const auditActions = store.db.prepare("SELECT action,count(*) AS count FROM audit WHERE tenant_id IN (SELECT value FROM json_each(?)) GROUP BY action").all(JSON.stringify(products.map(product => product.tenantId))).map(row => ({ ...row }));
  const actionCount = action => auditActions.find(row => row.action === action)?.count || 0;
  const expectedActions = ['WhatsApp: mensagem recebida', 'Entrada avaliada pela automação', 'WhatsApp: envio solicitado', 'WhatsApp: recibo de mensagem', 'WhatsApp: envio aceito'];
  const queues = { offered: queue.length, active, autopilotIncoming: app.autopilot.incoming.size, autopilotActive: app.autopilot.active.size, autopilotTasks: app.autopilot.tasks.size,
    media: app.gateway.mediaTasks.size, receipts: store.db.prepare("SELECT count(*) AS n FROM service_principal_receipts WHERE state IN ('reserved','dispatched')").get().n,
    outbound: store.db.prepare("SELECT count(*) AS n FROM outbound_commands WHERE state IN ('pending','in_flight')").get().n,
    webhooks: store.db.prepare("SELECT count(*) AS n FROM service_webhook_deliveries WHERE state='pending'").get().n,
    conversationWriteGuards: store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n,
    experimentalWriteProofObjects: store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='service_conversation_write_proof'").get().n };
  const turns = stats(timings['traffic:turn']), authorization = stats(timings['traffic:principals.revalidate']), reservation = stats(timings['traffic:principals.reserve']);
  const checks = {
    inventoryComplete: inventories.length === 2 && inventories.every(value => value.complete && value.duplicates === 0 && value.unexpected === 0 && value.durationMs <= profile.inventoryDeadlineMs) && allIds.size === profile.contexts,
    trafficComplete: completed === profile.turns && jobs.every(job => job.ok), turnP95: turns.p95Ms !== null && turns.p95Ms <= profile.turnP95LimitMs,
    authorizationP95: authorization.p95Ms !== null && authorization.p95Ms <= profile.authorizationP95LimitMs, reservationP95: reservation.p95Ms !== null && reservation.p95Ms <= profile.reservationP95LimitMs,
    effects: effects.size === profile.turns && duplicateEffects === 0 && outOfScope === 0 && repeats === Math.ceil(profile.turns / profile.repeatedEvery),
    persistedMessages: messageAudit.total === messageAudit.originalCount + 2 * profile.turns && messageAudit.incoming === profile.turns && messageAudit.outgoing === profile.turns && messageAudit.readDeliveries === profile.turns
      && messageAudit.uniqueCommands === profile.turns && messageAudit.duplicates === 0 && messageAudit.hashes.every(value => value.before === value.after && value.contactsUnchanged && value.headersUnchanged),
    confirmedDispatches: commandsRows.length === profile.turns && commandsRows.every(row => row.state === 'confirmed' && row.attempts === 1 && commands.has(row.idempotency_key)
      && products.some(product => product.tenantId === row.tenant_id && product.expectedIds.has(row.conversation_id)))
      && receipts.length === profile.turns && receipts.every(row => row.state === 'confirmed' && commands.has('service_' + row.id)
        && products.some(product => product.tenantId === row.tenant_id && product.actor.principalId === row.principal_id)) && externalIds.size === effects.size,
    realMutations: expectedActions.every(action => actionCount(action) === profile.turns),
    realEvents: incomingEvents === profile.turns && outgoingEvents === profile.turns && trafficEvents >= 2 * profile.turns,
    waSeen: waSeen.reduce((total, row) => total + row.count, 0) === 2 * profile.turns && waSeen.every(row => products.some(product => product.channelId === row.channel_id)),
    writeGuardEmpty: queues.conversationWriteGuards === 0 && queues.experimentalWriteProofObjects === 0, queuesDrained: Object.values(queues).every(count => count === 0), noNetworkOrModel: networkAttempts === 0 && modelAttempts === 0 && !app.server.listening && app.bridge.enabled === false,
    journalPreserved: journalBefore.active && journalBefore.rows === profile.turns && !journalAfter.active && journalAfter.rows === 0
      && materialization.before.logicalHash === materialization.after.logicalHash && Object.values(materialization.checks).every(value => value === true)
  };
  const sqliteSettings = Object.fromEntries(['cache_size', 'synchronous', 'page_size', 'wal_autocheckpoint', 'cache_spill', 'journal_mode'].map(name => [name, Object.values(store.db.prepare(`PRAGMA main.${name}`).get())[0]]));
  sqliteSettings.version = store.db.prepare('SELECT sqlite_version() AS version').get().version;
  const cpu = process.cpuUsage(cpuBefore), utilization = performance.eventLoopUtilization(utilizationBefore);
  report = { schemaVersion: 1, synthetic: true, revision: process.env.GITHUB_SHA || null, accepted: Object.values(checks).every(Boolean) && failures.length === 0, profile, checks, inventories,
    networkAttempts, modelAttempts, traffic: { completed, succeeded: jobs.filter(job => job.ok).length, durationMs: round(trafficDurationMs), peakQueue, peakActive, repeats, uniqueEffects: effects.size, duplicateEffects, outOfScope,
      deadlineMisses: jobs.filter(job => job.elapsedMs > profile.turnP95LimitMs).length }, trafficTelemetry, queues, auditActions, waSeen: waSeen.map(row => ({ ...row })), messageAudit, journalAudit, eventCount, trafficEvents, incomingEvents, outgoingEvents, calls,
    timings: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, stats(values)])),
    scopedWrites: { counts: scopedWriteCounts, method: 'Dynamic canonical UPDATE.run and journal UPSERT.run include SQLite triggers; COMMIT.exec is measured separately inside synchronous mutateConversation calls. conversationNoop means a completed call without either payload write attempt. Timings are subsets of method timings; no sum or residual is inferred.' },
    resources: { maxRssBytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024), cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000), wallMs: round(clock() - wallBefore),
      eventLoopUtilization: round(utilization.utilization), eventLoopDelay: { meanMs: round(eventLoop.mean / 1e6), p50Ms: round(eventLoop.percentile(50) / 1e6), p95Ms: round(eventLoop.percentile(95) / 1e6), p99Ms: round(eventLoop.percentile(99) / 1e6), maxMs: round(eventLoop.max / 1e6) },
      databaseBytes: size(databasePath), walBytes: size(databasePath + '-wal'), sourceBytes: store.db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS n FROM tenants WHERE id IN (SELECT value FROM json_each(?))').get(JSON.stringify(products.map(product => product.tenantId))).n, sqliteSettings },
    limitations: ['10 mil contextos persistidos; não representa 10 mil usuários simultâneos.', 'Modelo, provedor WhatsApp e rede reais ausentes; ACK é emitido pelo socket sintético e processado pelo handler real.',
      'createApp, listeners, autorização, entrada, automação, outbox e cinco mutações por turno são exercitados; não há HTTP nem frontend.',
      'Agentes são MCP/copilot, como os conectores externos. Hermes interno/autopilot continua usando o caminho completo e sua inferência não é medida.',
      'Identidades sintéticas usam concorrência8; as cotas produtivas FP1/FC5 não são exercitadas nem alteradas.', 'PostgreSQL bridge está desabilitado explicitamente; sua cópia integral e a sincronização remota não foram medidas.',
      'Recursos do processo incluem setup, inventário e auditoria dos 200 mil históricos; latência do turno começa na chegada planejada.',
      'O journal é opt-in apenas nesta fixture; a materialização com provas ocorre depois da janela de tráfego.'], failures: failures.slice(0, 20) };
} catch (error) { report = { schemaVersion: 1, synthetic: true, accepted: false, profile, phase, networkAttempts, modelAttempts, trafficTelemetry, setupFailure: error.message, failures: failures.slice(0, 20) }; }
finally {
  try {
    restoreScopedWriteSql();
    if (app) {
      // No listener was opened. Run createApp's normal shutdown listeners to clear its own timers as well.
      app.server.emit('close'); await app.autopilot.close(); await app.centralSupport.close(); await app.serviceWebhooks.close();
      await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.telegramUser.close(), app.bridge.close()]);
      app.store.close();
    }
  } catch (error) { report.accepted = false; (report.failures ||= []).push({ phase: 'cleanup', message: error.message }); }
  finally { trafficEventLoop?.disable(); eventLoop.disable(); globalThis.fetch = originalFetch; net.Socket.prototype.connect = originalConnect; rmSync(directory, { recursive: true, force: true }); }
}
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
if (!report.accepted) process.exitCode = 1;
