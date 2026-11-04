import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmailService } from '../src/email.js';

const syntheticKey = () => `ms_${randomBytes(24).toString('base64url')}`;
const verification = (overrides = {}) => ({ userId: 'fixture-user', email: 'fixture@example.test', name: 'Pessoa sintética', token: randomBytes(32).toString('base64url'), ...overrides });
const configured = key => ({ key, apiKey: syntheticKey(), from: 'Elozi <contato@je4ndev.com>', publicOrigin: 'https://elozi.je4ndev.com' });
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'), key = randomBytes(32);
  const service = new EmailService(db, { ...configured(key), ...options });
  t.after(async () => { await service.close(); db.close(); });
  return { db, key, service };
}

test('confirmação é cifrada e repetição do mesmo desafio conserva job sem expor token', async t => {
  const { db, service } = fixture(t), input = verification();
  const first = await service.enqueueVerification(input), repeated = await service.enqueueVerification({ ...input, name: 'Nome atualizado' });
  assert.deepEqual(repeated, first);
  assert.equal(db.prepare('SELECT count(*) AS n FROM email_outbox').get().n, 1);
  const row = db.prepare('SELECT * FROM email_outbox').get();
  assert.equal(Buffer.from(row.payload).includes(Buffer.from(input.token)), false);
  assert.equal(Buffer.from(row.payload).includes(Buffer.from(input.email)), false);
  assert.equal(Buffer.from(row.payload).includes(Buffer.from(input.name)), false);
  for (const value of [JSON.stringify(first), JSON.stringify(service.status()), JSON.stringify(row), JSON.stringify(service)]) assert.equal(value.includes(input.token), false);
  assert.equal(first.state, 'pending'); assert.equal(first.messageId, null);
});

test('sem credencial a fila permanece pendente; configurar não envia por conta própria', async t => {
  let calls = 0;
  const { db, service } = fixture(t, { apiKey: undefined, from: undefined, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ id: 'synthetic-email-1' }) }; } });
  const job = await service.enqueueVerification(verification());
  assert.equal(service.status().configured, false);
  assert.equal((await service.flush()).pending, 1); assert.equal(calls, 0);
  const apiKey = syntheticKey();
  service.configure({ apiKey, from: 'Elozi <contato@je4ndev.com>', publicOrigin: 'https://elozi.je4ndev.com' });
  assert.equal(calls, 0); assert.equal(service.status().configured, true);
  assert.equal(JSON.stringify(service.status()).includes(apiKey), false);
  await service.flush();
  assert.equal(calls, 1); assert.equal(db.prepare('SELECT state FROM email_outbox WHERE id=?').get(job.id).state, 'confirmed');
});

test('flush concorrente usa uma chamada com endpoint fixo, chave idempotente e HTML escapado', async t => {
  let release, reached, calls = 0, request;
  const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  const apiKey = syntheticKey();
  const { db, service } = fixture(t, { apiKey, fetchImpl: async (url, options) => { calls++; request = { url, ...options }; reached(); await barrier; return { ok: true, json: async () => ({ id: 'synthetic-email-2' }) }; } });
  const input = verification({ name: '<img src=x onerror="x"> & O\'QA' });
  const job = await service.enqueueVerification(input), first = service.flush();
  await started;
  assert.throws(() => service.configure({ from: 'outro@je4ndev.com' }), error => error.status === 409);
  const second = service.flush(); release(); await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(request.url, 'https://api-mepmail.je4ndev.com/emails');
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, `Bearer ${apiKey}`); assert.equal(request.headers['Idempotency-Key'], job.id);
  const body = JSON.parse(request.body);
  assert.deepEqual(body.to, [input.email]); assert.equal(body.from, 'Elozi <contato@je4ndev.com>');
  assert.match(body.text, new RegExp(`/verify-email\\?token=${input.token}`));
  assert.equal(body.html.includes('<img'), false); assert.match(body.html, /&lt;img/); assert.match(body.html, /&amp; O&#39;QA/);
  assert.match(body.html, /href="https:\/\/elozi\.je4ndev\.com\/verify-email\?token=/);
  assert.equal(body.reply_to, undefined);
  const row = db.prepare('SELECT * FROM email_outbox WHERE id=?').get(job.id);
  assert.equal(row.attempts, 1); assert.equal(row.state, 'confirmed'); assert.equal(row.message_id, 'synthetic-email-2');
  assert.equal((await service.enqueueVerification(input)).messageId, 'synthetic-email-2');
  await service.flush(); assert.equal(calls, 1);
});

test('erro de rede conserva estado incerto e nunca repete ou revela erro do provedor', async t => {
  let calls = 0;
  const input = verification(), apiKey = syntheticKey();
  const { db, service } = fixture(t, { apiKey, fetchImpl: async () => { calls++; throw new Error(`${apiKey} ${input.token}`); } });
  const job = await service.enqueueVerification(input);
  const result = await service.flush();
  assert.equal(result.unknown, 1); assert.equal(JSON.stringify(result).includes(apiKey), false); assert.equal(JSON.stringify(result).includes(input.token), false);
  assert.equal(db.prepare('SELECT state FROM email_outbox WHERE id=?').get(job.id).state, 'unknown');
  assert.equal((await service.enqueueVerification(input)).state, 'unknown');
  await service.flush(); assert.equal(calls, 1);
});

test('job em voo sobrevive no disco e passa a incerto após retomada sem reenvio cego', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-email-test-')), path = join(directory, 'fixture.sqlite'), key = randomBytes(32);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let db = new DatabaseSync(path), service = new EmailService(db, configured(key));
  const job = await service.enqueueVerification(verification());
  db.prepare("UPDATE email_outbox SET state='in_flight',attempts=1 WHERE id=?").run(job.id);
  await service.close(); db.close();
  let calls = 0;
  db = new DatabaseSync(path); service = new EmailService(db, { ...configured(key), fetchImpl: async () => { calls++; } });
  try {
    assert.equal(service.status().unknown, 1); await service.flush(); assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT attempts FROM email_outbox WHERE id=?').get(job.id).attempts, 1);
  } finally { await service.close(); db.close(); }
});

test('somente resposta de sucesso com id válido confirma aceitação pelo MepMail', async t => {
  for (const [response, expected] of [
    [{ ok: true, status: 201, json: async () => ({ id: 'synthetic-email-3' }) }, 'confirmed'],
    [{ ok: true, status: 201, json: async () => ({}) }, 'unknown'],
    [{ ok: true, status: 201, json: async () => ({ id: '<script>' }) }, 'unknown'],
    [{ ok: true, status: 201, json: async () => { throw new Error('corpo ilegível'); } }, 'unknown'],
    [{ ok: false, status: 403 }, 'failed'],
    [{ ok: false, status: 429 }, 'failed'],
    [{ ok: false, status: 503 }, 'unknown'],
    [{ ok: false, status: 302 }, 'unknown']
  ]) {
    const db = new DatabaseSync(':memory:'), service = new EmailService(db, { ...configured(randomBytes(32)), fetchImpl: async () => response });
    try {
      const job = await service.enqueueVerification(verification()); await service.flush();
      const row = db.prepare('SELECT state,message_id FROM email_outbox WHERE id=?').get(job.id);
      assert.equal(row.state, expected); assert.equal(row.message_id, expected === 'confirmed' ? 'synthetic-email-3' : null);
    } finally { await service.close(); db.close(); }
  }
});

test('autenticação da cifra vincula payload ao job e bloqueia troca de conteúdo antes do transporte', async t => {
  let calls = 0;
  const { db, service } = fixture(t, { fetchImpl: async () => { calls++; } });
  const first = await service.enqueueVerification(verification()), second = await service.enqueueVerification(verification({ userId: 'fixture-outro' }));
  const payload = db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(first.id).payload;
  db.prepare('UPDATE email_outbox SET payload=? WHERE id=?').run(payload, second.id);
  db.prepare("UPDATE email_outbox SET state='confirmed' WHERE id=?").run(first.id);
  await service.flush();
  assert.equal(calls, 0); assert.equal(db.prepare('SELECT state FROM email_outbox WHERE id=?').get(second.id).state, 'failed');
});

test('origem pública exige TLS ou loopback e configuração rejeita injeção de cabeçalho', async t => {
  const { db, key, service } = fixture(t);
  for (const publicOrigin of ['http://elozi.je4ndev.com', 'http://127.0.0.1.evil.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?redirect=x', 'https://example.test/#fragment', 'file:///tmp/fixture']) {
    assert.throws(() => new EmailService(db, { ...configured(key), publicOrigin }), error => error.status === 400);
  }
  for (const publicOrigin of ['http://127.0.0.1:4318', 'http://localhost:4318', 'http://[::1]:4318', 'https://elozi.je4ndev.com']) assert.doesNotThrow(() => service.configure({ publicOrigin }));
  assert.throws(() => service.configure({ apiKey: 'ms_bad\nAuthorization: x' }), error => error.status === 400);
  assert.throws(() => service.configure({ from: 'qa@example.test\r\nBcc: outro@example.test' }), error => error.status === 400);
  await assert.rejects(service.enqueueVerification(verification({ email: 'fixture@example.test\nBcc:x' })), error => error.status === 400);
  await assert.rejects(service.enqueueVerification(verification({ name: 'Teste\nOutro' })), error => error.status === 400);
  await assert.rejects(service.enqueueVerification(verification({ token: '<invalid>' })), error => error.status === 400);
  const unconfigured = new EmailService(db, { key, apiKey: 'token-inválido', from: 'nome sem email' });
  assert.equal(unconfigured.status().configured, false);
});

test('encerramento aborta chamada em andamento e impede novos jobs sem fechar banco compartilhado', async t => {
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const { db, service } = fixture(t, { fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => { reached(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
  await service.enqueueVerification(verification());
  const running = service.flush(); await started; await service.close(); await running;
  assert.equal(service.status().unknown, 1); assert.equal(db.prepare('SELECT 1 AS n').get().n, 1);
  await assert.rejects(service.enqueueVerification(verification()), error => error.status === 409);
  assert.throws(() => service.configure({ from: '' }), error => error.status === 409);
});
