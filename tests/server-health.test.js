import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const { version: packageVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

async function fixture(t, options = {}) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido na fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny }, healthOptions: { cacheMs: 0 }, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.stopScheduler(); app.gateway.entries.clear(); app.telegram.entries.clear(); app.gateway.closing = false; app.telegram.closing = false;
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const request = path => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), raw: Buffer.concat(chunks).toString() }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end();
  });
  return { app, request };
}

const until = async (condition, timeout = 3000) => { const end = Date.now() + timeout; while (!condition()) { if (Date.now() > end) throw Error('Condição não atingida a tempo'); await new Promise(resolve => setTimeout(resolve, 10)); } };

test('health mantém 200 e os campos anteriores e acrescenta level e checks sem empresa ou canal', async t => {
  const { request } = await fixture(t);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  for (const field of ['status', 'version', 'mode', 'authentication', 'storage', 'externalDelivery', 'whatsappConnections', 'telegramConnections']) assert.ok(Object.hasOwn(health.data, field), field);
  assert.equal(health.data.status, 'ok'); assert.equal(health.data.version, packageVersion); assert.equal(health.data.mode, 'local-pilot');
  // Previous fields unchanged; 0.68 adds the account-deletion media spool counters.
  assert.deepEqual(health.data.storage, { mode: 'local', state: 'disabled', pending: 0, pendingDeletions: 0, failedDeletions: 0, manualDeletions: 0, oldestDeletionAgeMs: null, syncedAt: null });
  assert.equal(health.data.externalDelivery, false); assert.equal(health.data.whatsappConnections, 0); assert.equal(health.data.telegramConnections, 0);
  assert.equal(health.data.level, 'ok');
  assert.deepEqual(health.data.checks, { whatsapp: { expected: 0, connected: 0 }, telegram: { expected: 0, connected: 0 },
    storage: { state: 'disabled', pending: 0, syncedAt: null, local: 'ok' }, scheduler: { state: 'stopped', lastTickAt: null } });
  const ready = await request('/api/health/ready');
  assert.equal(ready.status, 200); assert.equal(ready.data.level, 'ok');
});

test('conexões esperadas vêm do gateway e dos canais persistidos; faltando uma, o nível fica degradado sem expor IDs', async t => {
  const { app, request } = await fixture(t);
  const channels = [
    { id: 'wa-linked-secret-id', name: 'Número privado', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', linkedAt: '2026-10-01T10:00:00Z' },
    { id: 'wa-qr-pending', name: 'QR pendente', kind: 'whatsapp_qr', transport: 'baileys', state: 'qr' },
    { id: 'wa-logged-out', name: 'Desconectado', kind: 'whatsapp_qr', transport: 'baileys', state: 'logged_out', linkedAt: '2026-10-01T10:00:00Z' },
    { id: 'tg-live-secret-id', name: 'Bot privado', kind: 'telegram', transport: 'telegram-bot', state: 'connected' },
    { id: 'tg-failed', name: 'Bot revogado', kind: 'telegram', transport: 'telegram-bot', state: 'failed' }
  ];
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('health-tenant-secret', 'mep-demo', JSON.stringify({ name: 'Empresa Saúde Privada', channels, departments: [], conversations: [] }));
  let health = await request('/api/health');
  assert.equal(health.status, 200); assert.equal(health.data.status, 'ok'); assert.equal(health.data.level, 'degraded');
  assert.deepEqual(health.data.checks.whatsapp, { expected: 1, connected: 0 });
  assert.deepEqual(health.data.checks.telegram, { expected: 1, connected: 0 });
  for (const hidden of ['health-tenant-secret', 'Empresa Saúde Privada', 'wa-linked-secret-id', 'tg-live-secret-id', 'Número privado', 'Bot privado']) assert.equal(health.raw.includes(hidden), false, hidden);
  assert.equal((await request('/api/health/ready')).status, 200, 'degradado continua pronto para tráfego');

  app.gateway.entries.set('wa-linked-secret-id', { tenantId: 'health-tenant-secret', channelId: 'wa-linked-secret-id', state: 'connected', expected: true });
  app.telegram.entries.set('tg-live-secret-id', { tenantId: 'health-tenant-secret', channelId: 'tg-live-secret-id', state: 'connected' });
  health = await request('/api/health');
  assert.equal(health.data.level, 'ok'); assert.equal(health.data.whatsappConnections, 1); assert.equal(health.data.telegramConnections, 1); assert.equal(health.data.externalDelivery, true);
  assert.deepEqual(health.data.checks.whatsapp, { expected: 1, connected: 1 }); assert.deepEqual(health.data.checks.telegram, { expected: 1, connected: 1 });

  // A linked session the gateway is still retrying counts as expected even before it is persisted as live.
  app.gateway.entries.set('wa-qr-pending', { tenantId: 'health-tenant-secret', channelId: 'wa-qr-pending', state: 'reconnecting', expected: true });
  health = await request('/api/health');
  assert.deepEqual(health.data.checks.whatsapp, { expected: 2, connected: 1 }); assert.equal(health.data.level, 'degraded');
});

test('o cache do relatório público limita a leitura das empresas; com prazo zero lê o estado atual', async t => {
  const { app } = await fixture(t, { healthOptions: { cacheMs: 60000 } });
  assert.deepEqual(app.health().checks.telegram, { expected: 0, connected: 0 });
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('cached-tenant', 'mep-demo', JSON.stringify({ name: 'Cache', channels: [{ id: 'tg-cached', transport: 'telegram-bot', state: 'connected' }], conversations: [] }));
  assert.deepEqual(app.health().checks.telegram, { expected: 0, connected: 0 }, 'dentro da janela usa o mesmo retrato');
  const fresh = await fixture(t);
  fresh.app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('fresh-tenant', 'mep-demo', JSON.stringify({ name: 'Sem cache', channels: [{ id: 'tg-fresh', transport: 'telegram-bot', state: 'reconnecting' }], conversations: [] }));
  assert.deepEqual(fresh.app.health().checks.telegram, { expected: 1, connected: 0 });
});

test('ready responde 503 somente quando o nível é down; health continua 200 para monitores antigos', async t => {
  const { app, request } = await fixture(t);
  app.gateway.closing = true;
  const health = await request('/api/health'), ready = await request('/api/health/ready');
  assert.equal(health.status, 200); assert.equal(health.data.status, 'ok'); assert.equal(health.data.level, 'down');
  assert.equal(ready.status, 503); assert.equal(ready.data.level, 'down');
  app.gateway.closing = false;
  assert.equal((await request('/api/health/ready')).status, 200);

  const prepare = app.store.db.prepare.bind(app.store.db);
  app.store.db.prepare = sql => { if (sql === 'SELECT 1' || /postgres_spool/.test(sql)) throw Error('Fixture: SQLite indisponível'); return prepare(sql); };
  try { const report = app.health(); assert.equal(report.level, 'down'); assert.equal(report.checks.storage.local, 'unavailable'); }
  finally { app.store.db.prepare = prepare; }
  assert.equal(app.health().level, 'ok');
});

test('projeção PostgreSQL parada ou offline degrada o nível sem derrubar a prontidão', async t => {
  let failing = true;
  const pool = { on() {}, async end() {}, async connect() { return { async query(sql) { if (failing && sql.includes('sync_workspace')) throw Error('Fixture: PostgreSQL fora'); return { rows: [] }; }, release() {} }; } };
  const { app, request } = await fixture(t, { postgres: { pool } });
  app.store.mutate({ role: 'reseller', resellerId: 'mep-demo', name: 'Fixture' }, app.store.list({ role: 'reseller', resellerId: 'mep-demo' })[0].id, 'Fixture saúde', state => { state.segment = 'Saúde'; });
  let health = await request('/api/health');
  assert.equal(health.data.storage.state, 'starting'); assert.equal(health.data.level, 'degraded');
  await assert.rejects(app.bridge.flush());
  health = await request('/api/health');
  assert.equal(health.data.checks.storage.state, 'offline'); assert.ok(health.data.checks.storage.pending > 0); assert.equal(health.data.level, 'degraded');
  assert.equal((await request('/api/health/ready')).status, 200);
  failing = false; await app.bridge.flush();
  health = await request('/api/health');
  assert.equal(health.data.checks.storage.state, 'synced'); assert.equal(health.data.checks.storage.pending, 0); assert.match(health.data.checks.storage.syncedAt, /^\d{4}-\d\d-\d\dT/); assert.equal(health.data.level, 'ok');
});

test('agendador informa o último ciclo concluído e fica stale quando um ciclo não termina', async t => {
  const { app } = await fixture(t, { healthOptions: { cacheMs: 0, schedulerStaleMs: 80 } });
  app.startScheduler(10);
  await until(() => app.health().checks.scheduler.lastTickAt);
  let report = app.health();
  assert.equal(report.checks.scheduler.state, 'running'); assert.match(report.checks.scheduler.lastTickAt, /^\d{4}-\d\d-\d\dT/); assert.equal(report.level, 'ok');
  app.scheduled.tick = () => new Promise(() => {});
  await until(() => app.health().checks.scheduler.state === 'stale');
  report = app.health(); assert.equal(report.level, 'degraded');
  app.stopScheduler();
  assert.equal(app.health().checks.scheduler.state, 'stopped');
});

test('HEALTHCHECK da imagem usa a prontidão e falha somente em erro HTTP ou nível down', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const line = dockerfile.split('\n').find(item => item.includes('CMD node --input-type=module'));
  assert.ok(line, 'HEALTHCHECK presente');
  assert.match(line, /http:\/\/127\.0\.0\.1:4318\/api\/health\/ready/);
  assert.match(line, /if \(!response\.ok\) process\.exit\(1\)/);
  assert.match(line, /health\.level === 'down'/);
});

test('documento de empresa ilegível não derruba o nível: vale a visão viva dos gateways', async t => {
  const { app } = await fixture(t);
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('broken-health-tenant', 'mep-demo', '{"channels": [{"transport":"baileys","state":"connected"');
  app.gateway.entries.set('wa-live', { tenantId: 'broken-health-tenant', channelId: 'wa-live', state: 'reconnecting', expected: true });
  const report = app.health();
  assert.equal(report.checks.storage.local, 'ok'); assert.deepEqual(report.checks.whatsapp, { expected: 1, connected: 0 }); assert.equal(report.level, 'degraded');
  app.store.db.prepare('DELETE FROM tenants WHERE id=?').run('broken-health-tenant');
});

test('um documento ilegível não zera a contagem persistida das outras empresas', async t => {
  // Before, one malformed company made the single json_each query fail and every persisted count fell to zero: a linked
  // WhatsApp of another company that was never restored showed expected=0 and level ok, hiding the exact failure.
  const { app } = await fixture(t);
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('broken-a', 'mep-demo', '{"channels": [{"transport":"telegram-bot","state":"connected"}');
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('healthy-b', 'mep-demo', JSON.stringify({ name: 'Empresa Y', conversations: [], channels: [
    { id: 'wa-not-restored', transport: 'baileys', state: 'connected', linkedAt: '2026-10-01T10:00:00Z' }, { id: 'tg-b', transport: 'telegram-bot', state: 'reconnecting' }] }));
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('broken-c', 'mep-demo', 'baileys sem JSON');
  const report = app.health();
  assert.deepEqual(report.checks.whatsapp, { expected: 1, connected: 0 }); assert.deepEqual(report.checks.telegram, { expected: 1, connected: 0 });
  assert.equal(report.level, 'degraded'); assert.equal(report.checks.storage.local, 'ok');
});

test('sem configuração, a visão persistida é recalculada no máximo a cada 30 s', async t => {
  const { app } = await fixture(t, { healthOptions: {} });
  assert.deepEqual(app.health().checks.telegram, { expected: 0, connected: 0 });
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('later-tenant', 'mep-demo', JSON.stringify({ name: 'Depois', channels: [{ id: 'tg-later', transport: 'telegram-bot', state: 'connected' }], conversations: [] }));
  assert.deepEqual(app.health().checks.telegram, { expected: 0, connected: 0 }, 'chamadas anônimas seguidas não releem as empresas');
  app.telegram.entries.set('tg-later', { tenantId: 'later-tenant', channelId: 'tg-later', state: 'connected' });
  assert.deepEqual(app.health().checks.telegram, { expected: 1, connected: 1 }, 'a visão viva dos gateways continua atual');
});
