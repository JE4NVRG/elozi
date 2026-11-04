import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { SshPostgresTransport, sshPostgresArgs, postgresSshTarget, PostgresSshConfigError } from '../src/ssh-postgres.js';

const env = Object.freeze({ MEPCHAT_POSTGRES_SSH_HOST: 'db-host.example.test' });

const password = 'fixture-only-password-ssh';
const input = () => ({ tenantId: 'tenant-qa', sourceId: 'source-qa', revision: 42,
  payload: JSON.stringify({ id: 'tenant-qa', resellerId: 'mep-demo', channels: [], conversations: [] }) });
function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter(), chunks = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
    child.stdin = new Writable({
      write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) { callback(); queueMicrotask(() => handler?.(child, Buffer.concat(chunks).toString('utf8'))); }
    });
    calls.push({ command, args, options, child, chunks }); return child;
  };
  return { calls, spawnImpl };
}
function succeed(child, revision = '42', state = 'synced') {
  child.stdout.end(JSON.stringify({ state, revision })); child.emit('close', 0, null);
}
const decodedValues = sql => [...sql.matchAll(/convert_from\(decode\('([A-Za-z0-9+/=]+)','base64'\),'UTF8'\)/g)].map(match => Buffer.from(match[1], 'base64').toString('utf8'));

test('SSH fixo recebe senha somente stdin; SQL usa transação, identidade, contexto e valores codificados', async t => {
  let received;
  const fixture = fakeSpawn((child, text) => { received = text; succeed(child); });
  const transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl }); t.after(() => transport.close());
  const request = input(); request.tenantId = "tenant'\\; DROP TABLE x;--"; request.sourceId = "source'\\; COMMIT;--";
  request.payload = JSON.stringify({ id: request.tenantId, resellerId: 'mep-demo', text: "Cliente d'água \\ QR 🙂\nCOMMIT;--", channels: [], conversations: [] });
  assert.deepEqual(await transport.sync(request), { state: 'synced', revision: '42' });
  const call = fixture.calls[0]; assert.equal(call.command, 'ssh');
  assert.deepEqual(call.args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'db-host.example.test', "docker exec -i supabase-db sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -h 127.0.0.1 -X -q -At -v ON_ERROR_STOP=1 -U mepchat_app -d mepchat'"]);
  assert.deepEqual(call.args, [...sshPostgresArgs(env)]); assert.equal(Object.isFrozen(transport.args), true); assert.deepEqual([...transport.args], call.args);
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(JSON.stringify({ args: call.args, options: call.options, transport }).includes(password), false);
  assert.equal(received.slice(0, received.indexOf('\n')), password);
  const sql = received.slice(received.indexOf('\n') + 1);
  assert.match(sql, /^BEGIN;\n/); assert.match(sql, /COMMIT;\n$/);
  assert.match(sql, /current_user IS DISTINCT FROM 'mepchat_app' OR current_database\(\) IS DISTINCT FROM 'mepchat'/);
  assert.match(sql, /RAISE EXCEPTION 'Database identity denied'/);
  assert.match(sql, /set_config\('mepchat.user_id','mepchat-local-bridge',true\)/);
  assert.match(sql, /set_config\('mepchat.reseller_id','mep-demo',true\)/);
  assert.deepEqual(decodedValues(sql), [request.tenantId, request.payload, request.sourceId]);
  assert.equal(sql.includes(request.tenantId), false); assert.equal(sql.includes(request.sourceId), false); assert.equal(sql.includes(password), false);
  assert.match(sql, /42::bigint/); assert.match(sql, /result->>'state','revision',result->>'revision'/);
  assert.equal(call.child.kills.length, 0);
});

test('revisão decimal bigint e replay retornam só metadados, sem arredondar ou expor payload', async t => {
  const fixture = fakeSpawn(child => succeed(child, '9223372036854775807', 'already_synced'));
  const transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl }); t.after(() => transport.close());
  const request = input(); request.revision = '9223372036854775807'; request.payload = JSON.parse(request.payload);
  assert.deepEqual(await transport.sync(request), { state: 'already_synced', revision: '9223372036854775807' });
  assert.match(Buffer.concat(fixture.calls[0].chunks).toString(), /9223372036854775807::bigint/);
});

test('onboarding UUID provisiona e sincroniza na mesma transação com GUC da própria revenda', async t => {
  let received;
  const fixture = fakeSpawn((child, text) => { received = text; succeed(child); });
  const transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl }); t.after(() => transport.close());
  const request = input(), resellerId = `reseller_${randomUUID()}`; request.tenantId = `tenant_${randomUUID()}`;
  request.payload = JSON.stringify({ id: request.tenantId, resellerId, channels: [], conversations: [] });
  await transport.sync(request);
  const sql = received.slice(received.indexOf('\n') + 1);
  assert.match(sql, /PERFORM mepchat_private.provision_reseller\(/);
  assert.ok(sql.indexOf('provision_reseller') < sql.indexOf('sync_workspace'));
  assert.deepEqual(decodedValues(sql), [resellerId, request.tenantId, resellerId, request.tenantId, request.sourceId, request.payload, request.sourceId]);
  assert.equal(sql.match(/BEGIN;/g).length, 1); assert.equal(sql.match(/COMMIT;/g).length, 1);
  const legacyTenant = { ...request, tenantId: 'existing-local-tenant', payload: { id: 'existing-local-tenant', resellerId, channels: [], conversations: [] } };
  await transport.sync(legacyTenant);
  assert.equal(received.includes('provision_reseller'), false);
});

test('escopo, JSON, credencial, limite UTF-8 e revisão inválidos falham antes de spawn', async t => {
  const fixture = fakeSpawn(), transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl }); t.after(() => transport.close());
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', '1;COMMIT', '9223372036854775808', '1e3', '', null]) await assert.rejects(transport.sync({ ...input(), revision }), /Revisão/);
  for (const tenantId of ['', 'x'.repeat(101), 'qa\nother', 'qa\0other']) await assert.rejects(transport.sync({ ...input(), tenantId }), /Escopo/);
  await assert.rejects(transport.sync({ ...input(), sourceId: 'x'.repeat(101) }), /Escopo/);
  for (const payload of ['invalid JSON', 'null', '[]', '{}', JSON.stringify({ id: 'another', resellerId: 'mep-demo' }), JSON.stringify({ id: 'tenant-qa', resellerId: 'another' })]) await assert.rejects(transport.sync({ ...input(), payload }));
  const circular = {}; circular.self = circular; await assert.rejects(transport.sync({ ...input(), payload: circular }), /Snapshot/);
  const tooLarge = JSON.stringify({ id: 'tenant-qa', resellerId: 'mep-demo', text: 'é'.repeat(2 * 1024 * 1024) });
  await assert.rejects(transport.sync({ ...input(), payload: tooLarge }), /4 MiB/);
  for (const invalid of ['', 'secret\nSQL', 'secret\rSQL', 'secret\0SQL']) assert.throws(() => new SshPostgresTransport({ env, password: invalid }), /Credencial/);
  assert.throws(() => new SshPostgresTransport({ env, password, timeoutMs: 30001 }), /Configuração/);
  assert.equal(fixture.calls.length, 0);
});

test('exit não zero e erros do processo/stdin não vazam stderr, senha nem snapshot', async t => {
  const privateMessage = `${password} snapshot cliente fixture`;
  const modes = [child => { child.stderr.write(privateMessage); child.emit('close', 3, null); },
    child => child.emit('error', new Error(privateMessage)), child => child.stdin.emit('error', new Error(privateMessage))];
  for (const handler of modes) {
    const fixture = fakeSpawn(handler), transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl }); t.after(() => transport.close());
    await assert.rejects(transport.sync(input()), error => error.message === 'Sincronização PostgreSQL por SSH indisponível.' && error.cause === undefined);
  }
  const throwing = new SshPostgresTransport({ env, password, spawnImpl() { throw new Error(privateMessage); } }); t.after(() => throwing.close());
  await assert.rejects(throwing.sync(input()), error => !String(error.stack).includes(privateMessage));
});

test('stdout malformado, estado desconhecido ou excessivo não são aceitos', async t => {
  for (const output of ['not json', JSON.stringify({ state: 'unknown', revision: '42', payload: 'fixture' }), JSON.stringify({ state: 'synced', revision: '42;COMMIT' }), JSON.stringify({ state: 'synced', revision: '41' }), 'x'.repeat(64 * 1024 + 1)]) {
    const fixture = fakeSpawn(child => { child.stdout.write(output); child.emit('close', 0, null); });
    const transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl }); t.after(() => transport.close());
    await assert.rejects(transport.sync(input()), error => !error.message.includes(output));
    if (output.length > 64 * 1024) assert.deepEqual(fixture.calls[0].child.kills, ['SIGKILL']);
  }
});

test('timeout aborta somente o filho próprio, sem retry automático', async t => {
  const fixture = fakeSpawn(), transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl, timeoutMs: 10 }); t.after(() => transport.close());
  await assert.rejects(transport.sync(input()), /Tempo limite/);
  assert.equal(fixture.calls.length, 1); assert.deepEqual(fixture.calls[0].child.kills, ['SIGKILL']);
});

test('close aborta filhos próprios pendentes e impede novas sincronizações', async () => {
  const fixture = fakeSpawn(), transport = new SshPostgresTransport({ env, password, spawnImpl: fixture.spawnImpl });
  const first = transport.sync(input()), second = transport.sync({ ...input(), sourceId: 'source-second' });
  const rejected = [assert.rejects(first, /encerrado/), assert.rejects(second, /encerrado/)];
  transport.close(); await Promise.all(rejected);
  assert.equal(fixture.calls.length, 2); for (const call of fixture.calls) assert.deepEqual(call.child.kills, ['SIGKILL']);
  await assert.rejects(transport.sync(input()), /encerrado/); assert.equal(fixture.calls.length, 2);
  transport.close();
});

test('SSH host is deployment configuration: unset disables the transport, container is configurable and validated', () => {
  for (const disabled of [{}, { MEPCHAT_POSTGRES_SSH_HOST: '' }, { MEPCHAT_POSTGRES_SSH_HOST: '   ' }]) {
    assert.throws(() => new SshPostgresTransport({ password, env: disabled, spawnImpl: () => assert.fail('spawned') }),
      error => error instanceof PostgresSshConfigError && error.code === 'POSTGRES_SSH_NOT_CONFIGURED' && /MEPCHAT_POSTGRES_SSH_HOST/.test(error.message));
  }
  assert.deepEqual({ ...postgresSshTarget(env) }, { host: 'db-host.example.test', container: 'supabase-db' });
  const custom = sshPostgresArgs({ MEPCHAT_POSTGRES_SSH_HOST: 'ops@db-host.example.test', MEPCHAT_POSTGRES_CONTAINER: 'pg_main-1' });
  assert.equal(custom[4], 'ops@db-host.example.test'); assert.match(custom[5], /^docker exec -i pg_main-1 sh -c /);
  for (const host of ['-oProxyCommand=x', 'host name', 'host;rm', 'a\nb', '@host'])
    assert.throws(() => sshPostgresArgs({ MEPCHAT_POSTGRES_SSH_HOST: host }), PostgresSshConfigError, host);
  for (const container of ['-it', "db' ; id", 'db name', '../x'])
    assert.throws(() => sshPostgresArgs({ MEPCHAT_POSTGRES_SSH_HOST: 'db-host.example.test', MEPCHAT_POSTGRES_CONTAINER: container }), PostgresSshConfigError, container);
});
