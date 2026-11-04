import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { createLocalBackup, validateBackup } from '../src/backup.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const privateTables = ['webchat_sessions', 'webchat_inbound_receipts', 'webchat_visitor_profiles', 'webchat_identity_jti', 'webchat_identity_sessions', 'channel_email_seen', 'meta_channel_bindings', 'meta_inbound_receipts'];
const origin = 'https://private-backup.example.test';
const digest = value => createHash('sha256').update(value).digest('hex');
function rows(db, table) {
  return db.prepare('SELECT * FROM "' + table.replaceAll('"', '""') + '"').all().map(row => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key] instanceof Uint8Array ? Buffer.from(row[key]).toString('hex') : row[key]])))).sort();
}
function assertNoSecrets(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'secret is absent from public metadata');
}
async function restoreArtifact(file, key, target) {
  const blob = await readFile(file); assert.equal(blob.subarray(0, 8).toString(), 'MEPCHATB'); assert.equal(blob[8], 1); assert.equal(blob[9], 1);
  const decrypt = createDecipheriv('aes-256-gcm', key, blob.subarray(10, 22)); decrypt.setAAD(blob.subarray(0, 10)); decrypt.setAuthTag(blob.subarray(22, 38));
  const restored = Buffer.concat([decrypt.update(blob.subarray(38)), decrypt.final()]);
  try { await writeFile(target, restored, { flag: 'wx', mode: 0o600 }); } finally { restored.fill(0); }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-channel-private-backup-')), key = randomBytes(32), applications = [], closed = new Set(), external = [];
  const deny = async () => { external.push(true); throw new Error('External transport forbidden in private backup fixture'); };
  const application = (databasePath = ':memory:') => {
    const app = createApp({ databasePath, serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
      gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
      googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', key, fetchImpl: deny },
      emailChannelOptions: { fetchImpl: deny, getDeliveryConfiguration: async () => ({ apiKey: 'ms_synthetic_backup_delivery_key', from: 'support@example.test' }) },
      metaOptions: { fetchImpl: deny } });
    applications.push(app); return app;
  };
  const close = async app => {
    if (closed.has(app)) return; closed.add(app);
    for (const controller of app.runtime.controllers.values()) controller.abort();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    if (app.server.listening) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); } else app.server.emit('close');
    app.store.close();
  };
  t.after(async () => {
    for (const app of applications) await close(app);
    assert.equal(external.length, 0);
    const absolute = resolve(directory); assert.equal(dirname(absolute), resolve(tmpdir())); assert.ok(basename(absolute).startsWith('elozi-channel-private-backup-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const app = application(), ownerRow = app.auth.insertUser({ username: 'channel.backup.owner', name: 'Synthetic backup administrator' }, randomBytes(16), randomBytes(64), 'reseller', [], 'mep-demo', { platformAdmin: true });
  const ownerSession = app.auth.session(ownerRow), owner = ownerSession.actor, contexts = [], secrets = [key.toString('hex'), key.toString('base64')];
  for (const [index, kind] of ['messenger', 'instagram'].entries()) {
    const tenant = app.store.createTenant(owner, { name: 'Private backup company ' + index, segment: 'Synthetic RAM restore' });
    const webchatId = randomUUID(), emailId = randomUUID(), metaId = randomUUID(), address = `support-${index}@example.test`, resourceId = '12345678900' + index, senderId = '98765432100' + index;
    const relaySecret = 'synthetic-backup-relay-' + randomBytes(18).toString('hex'), credentials = { accessToken: 'synthetic-backup-access-' + randomBytes(16).toString('hex'), appSecret: 'synthetic-backup-app-' + randomBytes(16).toString('hex'), verifyToken: 'synthetic-backup-verify-' + randomBytes(16).toString('hex') };
    app.store.mutate(owner, tenant.id, 'Synthetic channel restore fixture', state => { state.channels.push(...[
      { id: webchatId, name: 'Widget restore', kind: 'webchat', state: 'planned' }, { id: emailId, name: 'Email restore', kind: 'email', state: 'planned' }, { id: metaId, name: 'Social restore', kind, state: 'planned' }
    ]); });
    app.webchat.configure(owner, tenant.id, webchatId, { version: 0, origins: [origin] });
    // The published connector path initializes the app's lazy encrypted custody.
    await app.emailChannel.configure(owner, tenant.id, emailId, { version: 0, address, ingressSecret: relaySecret });
    await app.meta.configure(owner, tenant.id, metaId, { version: 0, enabled: true, resourceId, apiVersion: 'v23.0', ...credentials });
    const authority = { reauthorize: () => app.auth.authenticate(ownerSession.token) };
    app.webchat.identity.configure(owner, tenant.id, webchatId, { version: 0, enabled: true, issuer: origin, externalIdPrefix: 'mepmail' }, authority);
    const identityKey = app.webchat.identity.createKey(owner, tenant.id, webchatId, { version: 1 }, authority), issuedAt = Math.floor(Date.now() / 1000);
    const identityHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: identityKey.kid })).toString('base64url');
    const identityPayload = Buffer.from(JSON.stringify({ iss: origin, aud: 'elozi:webchat:' + webchatId, sub: 'same-synthetic-app-account', email: 'verified@example.test', email_verified: true, name: 'Synthetic restored visitor ' + index, locale: 'pt-BR', iat: issuedAt - 1, exp: issuedAt + 599, jti: randomUUID(), ctx: { teamId: 'synthetic-team-' + index, mailboxes: 2 } })).toString('base64url');
    const identityToken = identityHeader + '.' + identityPayload + '.' + createHmac('sha256', identityKey.secret).update(identityHeader + '.' + identityPayload).digest('base64url');
    const challenge = app.webchat.challenge({ tenantId: tenant.id, channelId: webchatId, origin }), visitor = app.webchat.openSession({ tenantId: tenant.id, channelId: webchatId, origin, challenge: challenge.challenge, identityToken });
    const webInput = { tenantId: tenant.id, channelId: webchatId, origin, token: visitor.token, clientMessageId: randomUUID(), text: 'Webchat content ' + index };
    const webReceipt = await app.webchat.receive(webInput), pendingChallenge = app.webchat.challenge({ tenantId: tenant.id, channelId: webchatId, origin });
    const envelope = { id: 'shared-backup-email-event', from: 'customer@example.test', to: address, subject: 'Synthetic backup request', text: 'Email content ' + index }, rawEmail = Buffer.from(JSON.stringify(envelope)), timestamp = String(Math.floor(Date.now() / 1000));
    const emailInput = { tenantId: tenant.id, channelId: emailId, rawBody: rawEmail, timestamp, signature: createHmac('sha256', relaySecret).update(timestamp + '.').update(rawEmail).digest('hex') };
    const emailReceipt = await app.emailChannel.receiveWebhook(emailInput);
    const social = { object: kind === 'messenger' ? 'page' : 'instagram', entry: [{ id: resourceId, messaging: [{ sender: { id: senderId }, recipient: { id: resourceId }, timestamp: Date.now(), message: { mid: 'shared-backup-meta-message', text: 'Social content ' + index } }] }] };
    const rawMeta = Buffer.from(JSON.stringify(social)), metaSignature = 'sha256=' + createHmac('sha256', credentials.appSecret).update(rawMeta).digest('hex');
    const metaReceipt = await app.meta.receiveWebhook(tenant.id, metaId, rawMeta, metaSignature);
    contexts.push({ tenantId: tenant.id, webchatId, emailId, metaId, address, resourceId, kind, relaySecret, credentials, identityKey, identityToken, visitor, challenge, pendingChallenge, webInput, webReceipt, emailInput, emailReceipt, rawMeta, metaSignature, metaReceipt });
    secrets.push(relaySecret, ...Object.values(credentials), identityKey.secret, identityToken, visitor.token, challenge.challenge, pendingChallenge.challenge);
  }
  const operatorRow = app.auth.insertUser({ username: 'channel.backup.operator', name: 'Synthetic restored operator' }, randomBytes(16), randomBytes(64), 'operator', contexts.map(context => context.tenantId), 'mep-demo'), operatorSession = app.auth.session(operatorRow);
  return { app, key, directory, owner, ownerSession, operatorSession, contexts, secrets, application, close };
}

test('encrypted backup restores all eight private connector tables and encrypted credentials after losing the RAM app', async t => {
  const c = await fixture(t), before = Object.fromEntries([...privateTables, 'channel_secrets'].map(table => [table, rows(c.app.store.db, table)]));
  for (const table of privateTables) assert.equal(before[table].length, 2, table + ' has actual operational data');
  const backup = await createLocalBackup(c.app.store.db, { destination: c.directory, key: c.key });
  assert.equal(backup.verification.integrity, 'ok'); assert.equal(backup.verification.foreignKeys, 'ok'); assert.equal(backup.verification.restoreVerified, true);
  for (const table of privateTables) assert.ok(backup.verification.tables.includes(table));
  assertNoSecrets(await readFile(backup.metadataFile, 'utf8'), c.secrets);
  const encrypted = await readFile(backup.file); for (const secret of c.secrets) assert.equal(encrypted.includes(Buffer.from(secret)), false);
  const verified = await validateBackup(backup.file, { key: c.key }); assert.equal(verified.integrity, 'ok'); assert.equal(verified.foreignKeys, 'ok');
  await c.close(c.app); // The authoritative RAM database is now gone.
  const recoveredFile = join(c.directory, 'synthetic-recovered.sqlite'); await restoreArtifact(backup.file, c.key, recoveredFile);
  const restored = c.application(recoveredFile); assert.equal(restored.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.deepEqual(restored.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  for (const table of [...privateTables, 'channel_secrets']) assert.deepEqual(rows(restored.store.db, table), before[table], table + ' survives restore byte for byte');
  assert.equal(restored.auth.authenticate(c.operatorSession.token).userId, c.operatorSession.actor.userId);
  const owner = restored.auth.authenticate(c.ownerSession.token), vault = encryptedChannelSecrets(restored.store.db, c.key);
  for (const context of c.contexts) {
    assert.equal(await restored.meta.verifyWebhook(context.tenantId, context.metaId, { 'hub.mode': 'subscribe', 'hub.verify_token': context.credentials.verifyToken, 'hub.challenge': '120034' }), '120034');
    const tenant = restored.store.tenant(owner, context.tenantId), emailChannel = tenant.channels.find(channel => channel.id === context.emailId);
    const emailCredentials = vault.get(`elozi:email-channel:${context.tenantId}:${context.emailId}:${emailChannel.email.epoch}`);
    assert.equal(emailCredentials.ingressSecret === context.relaySecret, true); assert.equal(vault.get(context.metaId).meta.accessToken === context.credentials.accessToken, true);
    assert.equal(vault.get(context.webchatId).webchatIdentity.keys[0].secret, context.identityKey.secret);
    const session = restored.store.db.prepare('SELECT token_hash FROM webchat_sessions WHERE tenant_id=?').get(context.tenantId); assert.equal(session.token_hash, digest(context.visitor.token));
    const history = restored.webchat.history({ tenantId: context.tenantId, channelId: context.webchatId, token: context.visitor.token, origin }); assert.deepEqual(history.messages.map(message => message.text), [context.webInput.text]); assert.equal(history.contact.verified, true); assert.equal(history.contact.externalId, 'mepmail:same-synthetic-app-account');
    assert.equal((await restored.webchat.receive(context.webInput)).replayed, true);
    const emailReplay = await restored.emailChannel.receiveWebhook(context.emailInput); assert.equal(emailReplay.replayed, true); assert.equal(emailReplay.messageId, context.emailReceipt.messageId);
    assert.equal((await restored.meta.receiveWebhook(context.tenantId, context.metaId, context.rawMeta, context.metaSignature)).replayed, 1);
    assert.throws(() => restored.webchat.openSession({ tenantId: context.tenantId, channelId: context.webchatId, origin, challenge: context.pendingChallenge.challenge }), error => error.status === 403);
    const renewedChallenge = restored.webchat.challenge({ tenantId: context.tenantId, channelId: context.webchatId, origin });
    assert.throws(() => restored.webchat.openSession({ tenantId: context.tenantId, channelId: context.webchatId, origin, challenge: renewedChallenge.challenge, identityToken: context.identityToken }), error => error.code === 'identity_replay');
  }
  for (const table of privateTables) assert.deepEqual(rows(restored.store.db, table), before[table], 'replays do not create duplicate private rows');
  const other = c.contexts[1], first = c.contexts[0];
  assert.throws(() => restored.webchat.history({ tenantId: other.tenantId, channelId: other.webchatId, token: first.visitor.token, origin }), error => error.status === 403);
  const binding = restored.store.db.prepare('SELECT session_id FROM webchat_identity_sessions WHERE tenant_id=? AND channel_id=?').get(first.tenantId, first.webchatId);
  assert.throws(() => restored.webchat.identity.sessionIdentity(binding.session_id, { tenantId: other.tenantId, channelId: other.webchatId, origin }), error => error.code === 'identity_invalid');
  assert.equal((await readdir(c.directory)).some(name => name.startsWith('.mepchat-backup-')), false);
});

test('operator DTOs, visitor history, audit, backup receipt and queued projection contain no connector secrets or session tokens', async t => {
  const c = await fixture(t); await new Promise(resolve => c.app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${c.app.server.address().port}`, dto = [];
  const get = async (path, token = c.operatorSession.token) => {
    const response = await fetch(base + path, { headers: { Cookie: 'mep_session=' + token } }); assert.equal(response.status, 200);
    const value = await response.json(); dto.push(value); return value;
  };
  await get('/api/bootstrap');
  for (const context of c.contexts) {
    await get('/api/tenants/' + context.tenantId);
    for (const channelId of [context.webchatId, context.emailId, context.metaId]) await get(`/api/tenants/${context.tenantId}/channels/${channelId}/configuration`, c.ownerSession.token);
    const response = await fetch(`${base}/api/public/webchat/${context.tenantId}/${context.webchatId}/history`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: context.visitor.token }) }); assert.equal(response.status, 200); dto.push(await response.json());
    dto.push(c.app.webchat.publicAccess(context.tenantId, context.webchatId, origin), c.app.store.audit(c.owner, context.tenantId), c.app.outbox.list(c.owner, context.tenantId));
    dto.push(context.webReceipt, context.emailReceipt, context.metaReceipt);
    const rawTenant = c.app.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(context.tenantId).data; assertNoSecrets(rawTenant, c.secrets);
    // queue() produces the actual PostgreSQL payload, with no transport or live DB.
    c.app.bridge.enabled = true; c.app.bridge.queue(context.tenantId); c.app.bridge.enabled = false;
    const projection = c.app.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(context.tenantId).payload; assertNoSecrets(projection, c.secrets);
    for (const table of privateTables) assert.equal(Object.hasOwn(JSON.parse(projection), table), false);
    assert.equal(projection.includes('token_hash'), false); assert.equal(projection.includes('ingressSecret'), false); assert.equal(projection.includes('accessToken'), false);
  }
  const backup = await createLocalBackup(c.app.store.db, { destination: c.directory, key: c.key }); dto.push(backup.verification, JSON.parse(await readFile(backup.metadataFile, 'utf8')));
  assertNoSecrets(dto, c.secrets); assert.equal(JSON.stringify(dto).includes('token_hash'), false);
  for (const row of c.app.store.db.prepare('SELECT payload FROM channel_secrets').all()) for (const secret of c.secrets) assert.equal(Buffer.from(row.payload).includes(Buffer.from(secret)), false);
});
