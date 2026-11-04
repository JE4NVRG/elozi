import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp, describeError, redactLog, routePattern, isRecoverableProcessError, installProcessGuards } from '../src/server.js';

async function fixture(t) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido na fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, request };
}

test('500 inesperado responde mensagem neutra com requestId e registra rota, método e pilha sem corpo, cookie ou token', async t => {
  const { app, request } = await fixture(t), logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  app.auth.status = () => { throw new TypeError('Unexpected token "corpo-privado-do-cliente" token=segredo-do-token'); };
  const response = await request('/api/auth/status?token=consulta-secreta', { headers: { Cookie: 'mep_session=cookie-secreto-sintetico', Authorization: 'Bearer portador-secreto' } });
  assert.equal(response.status, 500);
  assert.equal(response.data.error, 'Falha interna inesperada. Tente novamente em instantes.');
  assert.doesNotMatch(response.data.error, /sandbox/i);
  assert.match(response.data.requestId, /^[0-9a-f-]{36}$/); assert.equal(response.headers['x-request-id'], response.data.requestId);
  assert.equal(logs.length, 1);
  const [message, json] = [logs[0].slice(0, logs[0].indexOf(' {')), JSON.parse(logs[0].slice(logs[0].indexOf(' {') + 1))];
  assert.equal(message, 'Falha interna na requisição.');
  assert.equal(json.requestId, response.data.requestId); assert.equal(json.method, 'GET'); assert.equal(json.route, '/api/auth/status');
  assert.equal(json.name, 'TypeError'); assert.ok(json.stack.length > 0 && json.stack.every(line => line.startsWith('at ')));
  for (const secret of ['corpo-privado-do-cliente', 'segredo-do-token', 'consulta-secreta', 'cookie-secreto-sintetico', 'portador-secreto']) {
    assert.equal(logs[0].includes(secret), false, secret); assert.equal(JSON.stringify(response.data).includes(secret), false, secret);
  }
});

test('erros esperados mantêm a mensagem própria, sem requestId nem registro de pilha', async t => {
  const { request } = await fixture(t), logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const missing = await request('/api/bootstrap');
  assert.equal(missing.status, 401); assert.equal(missing.data.requestId, undefined); assert.equal(missing.headers['x-request-id'], undefined);
  const notFound = await request('/api/nao-existe');
  assert.equal(notFound.status, 404); assert.equal(notFound.data.error, 'Recurso não encontrado.'); assert.equal(notFound.data.requestId, undefined);
  assert.equal(logs.length, 0);
});

test('500 explícito preserva a mensagem de domínio e acrescenta requestId para correlação', async t => {
  const { app, request } = await fixture(t), logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  app.auth.status = () => { throw Object.assign(new Error('A validação de empresas precisa concluir na mesma operação.'), { status: 500 }); };
  const response = await request('/api/auth/status');
  assert.equal(response.status, 500); assert.equal(response.data.error, 'A validação de empresas precisa concluir na mesma operação.');
  assert.match(response.data.requestId, /^[0-9a-f-]{36}$/); assert.equal(logs.length, 1); assert.ok(logs[0].includes(response.data.requestId));
});

test('padrão de rota troca identificadores por :id e nunca inclui a consulta', () => {
  assert.equal(routePattern('/api/tenants/playtech-demo/conversations/123e4567-e89b-12d3-a456-426614174000/messages?token=x'), '/api/tenants/:id/conversations/:id/messages');
  assert.equal(routePattern('/api/tenants/tenant_9f/agents/usage/limit'), '/api/tenants/:id/agents/usage/limit');
  assert.equal(routePattern('/api/tenants/t1/contacts/import/preview'), '/api/tenants/:id/contacts/import/preview');
  assert.equal(routePattern('/api/service/v1/conversations/abc'), '/api/service/v1/conversations/:id');
  assert.equal(routePattern('/api/public/webchat/tenant_1/channel-9/messages'), '/api/public/webchat/:id/:id/messages');
  assert.equal(routePattern('/api/users/invitations/0f9a/revoke'), '/api/users/invitations/:id/revoke');
  assert.equal(routePattern('/api/auth/password/reset?token=segredo'), '/api/auth/password/reset');
  assert.equal(routePattern('/../../etc/passwd'), '/:arquivo');
});

test('diagnóstico oculta tokens, credenciais, consultas e trechos de dados das mensagens', () => {
  const text = redactLog('GET https://api.telegram.org/bot123456789:AAHsyntheticTokenValue_0123456789abcdef/getUpdates?offset=9&secret=x Authorization: Bearer abc.def apiKey=k-123 csrfToken=t-1 password: p@ss postgres://user:pw@db:5432/x Unexpected token "mensagem do cliente" ' + 'z'.repeat(48));
  for (const hidden of ['AAHsyntheticTokenValue', 'offset=9', 'abc.def', 'k-123', 't-1', 'p@ss', 'user:pw', 'mensagem do cliente', 'z'.repeat(48)]) assert.equal(text.includes(hidden), false, hidden);
  assert.match(text, /bot\[oculto\]/); assert.match(text, /postgres:\/\/\[oculto\]@db/);
  const error = Object.assign(new Error('Falha com token=segredo'), { code: 'ECONNRESET' });
  const described = describeError(error);
  assert.equal(described.name, 'Error'); assert.equal(described.code, 'ECONNRESET'); assert.equal(described.message, 'Falha com token=[oculto]');
  assert.ok(described.stack.length <= 12);
  assert.deepEqual(describeError('texto solto com segredo'), { type: 'string' }); assert.deepEqual(describeError(null), { type: 'null' });
  const hostile = { get message() { throw Error('getter'); } };
  assert.deepEqual(describeError(hostile), { type: 'object' });
});

test('falhas de transporte são recuperáveis; erros de programação não', () => {
  for (const error of [Object.assign(Error('reset'), { code: 'ECONNRESET' }), Object.assign(Error('Connection Closed'), { isBoom: true, output: { statusCode: 428 } }),
    Object.assign(Error('socket'), { code: 'UND_ERR_SOCKET' }), Object.assign(Error('timeout'), { name: 'TimeoutError' }), Object.assign(Error('aborted'), { name: 'AbortError' })]) assert.equal(isRecoverableProcessError(error), true, error.message);
  for (const error of [new TypeError('x is not a function'), new RangeError('stack'), Object.assign(Error('sql'), { code: 'ERR_SQLITE_ERROR' }), 'string', null]) assert.equal(isRecoverableProcessError(error), false, String(error));
});

test('guardas do processo tratam rejeições como exceções: transporte mantém sessões e o restante encerra com segurança', () => {
  // Rejections used to be only logged. A programming error in an async path now stops the process like Node's default and
  // like uncaughtException, so the container restarts it instead of running in an unknown state.
  const target = new EventEmitter(), logs = [], fatal = [];
  const remove = installProcessGuards({ target, log: (...args) => logs.push(args.join(' ')), onFatal: error => fatal.push(error), maxRecoverable: 2, windowMs: 60000 });
  try {
    target.emit('unhandledRejection', Object.assign(new Error('Promessa perdida token=segredo-rejeicao'), { code: 'ECONNRESET' }));
    assert.equal(fatal.length, 0); assert.match(logs.at(-1), /^Promessa rejeitada por falha de transporte; conexões e sessões mantidas\./);
    assert.equal(logs.join('\n').includes('segredo-rejeicao'), false);
    target.emit('uncaughtException', Object.assign(new Error('Connection Closed'), { isBoom: true }));
    assert.equal(fatal.length, 0); assert.match(logs.at(-1), /^Falha de transporte sem tratamento; conexões e sessões mantidas\./);
    // Rejections and exceptions share one budget: a storm of transport errors stops safely instead of looping.
    target.emit('unhandledRejection', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    assert.equal(fatal.length, 1); assert.match(logs.at(-1), /^Promessa rejeitada sem tratamento; encerrando com segurança/);
    const programming = new TypeError('Cannot read properties of undefined');
    target.emit('unhandledRejection', programming);
    assert.equal(fatal.at(-1), programming); assert.match(logs.at(-1), /^Promessa rejeitada sem tratamento; encerrando com segurança/);
    target.emit('unhandledRejection', 'motivo textual secreto');
    assert.equal(fatal.at(-1), 'motivo textual secreto'); assert.equal(logs.join('\n').includes('motivo textual secreto'), false);
    const exception = new TypeError('x is not a function');
    target.emit('uncaughtException', exception);
    assert.equal(fatal.at(-1), exception); assert.match(logs.at(-1), /^Exceção sem tratamento; encerrando com segurança/);
  } finally { remove(); }
  assert.equal(target.listenerCount('unhandledRejection'), 0); assert.equal(target.listenerCount('uncaughtException'), 0);
});

test('rejeição fora de transporte encerra mesmo com orçamento livre; fetch com causa de socket é transporte', () => {
  const target = new EventEmitter(), fatal = [];
  const remove = installProcessGuards({ target, log: () => {}, onFatal: error => fatal.push(error) });
  try {
    target.emit('unhandledRejection', Object.assign(new Error('sql'), { code: 'ERR_SQLITE_ERROR' }));
    assert.equal(fatal.length, 1);
    target.emit('unhandledRejection', new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
    assert.equal(fatal.length, 1, 'falha de rede embrulhada pelo fetch mantém o processo');
  } finally { remove(); }
  assert.equal(isRecoverableProcessError(new TypeError('fetch failed', { cause: new TypeError('x is not a function') })), false);
  assert.equal(isRecoverableProcessError({ get code() { throw Error('getter'); } }), false);
});

test('diagnóstico corta antes de redigir e permanece linear com mensagens hostis de bibliotecas', () => {
  // The previous keyword pattern backtracked polynomially (4 KB took 1.2 s, 16 KB 95 s) on the single event loop.
  const hostile = ['token-'.repeat(200000), 'session-' + 'a-'.repeat(100000) + 'token', 'a:'.repeat(200000), 'x.'.repeat(200000) + '://',
    '?'.repeat(200000), '"' + 'b'.repeat(200000), 'bot' + '1'.repeat(200000), '1'.repeat(100000) + ':' + 'c-'.repeat(50000), 'a'.repeat(39).concat(' ').repeat(20000)];
  for (const value of hostile) {
    const started = performance.now(), text = redactLog(value), elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `redação levou ${elapsed.toFixed(0)} ms para ${value.slice(0, 12)}…`);
    assert.ok(text.length <= 2100, 'saída limitada');
  }
  const started = performance.now(), described = describeError(Object.assign(new Error('session-' + 'token-'.repeat(50000) + '=segredo'), { stack: 'Error\n    at ' + 'token-'.repeat(50000) }));
  assert.ok(performance.now() - started < 500); assert.ok(described.message.length <= 300); assert.ok(described.stack.every(line => line.length <= 300));
  assert.equal(JSON.stringify(described).includes('segredo'), false);
});

test('corte nunca deixa meio segredo nem trecho entre aspas visível', () => {
  const padding = 'texto '.repeat(330);
  const cutToken = redactLog(padding + 'https://api.telegram.org/bot123456789:AAHsyntheticTokenValue_0123456789abcdef/getUpdates');
  assert.equal(cutToken.includes('bot123'), false); assert.equal(cutToken.includes('AAH'), false); assert.ok(cutToken.endsWith('…'));
  const cutQuote = redactLog(padding + 'Unexpected token "mensagem privada do cliente que continua por muito tempo"');
  assert.equal(cutQuote.includes('mensagem privada'), false);
  assert.equal(redactLog('Falha "aberta sem fechar com dado do cliente\nlinha seguinte'), 'Falha "…"\nlinha seguinte');
  assert.equal(redactLog('a=token=segredo-interno session-id: s-1 nada=neutro'), 'a=token=[oculto] session-id: [oculto] nada=neutro');
  assert.equal(redactLog('x'.repeat(10), 5), '…', 'palavra única cortada some inteira');
});
