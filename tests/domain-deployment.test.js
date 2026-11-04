import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';
import { createHmac } from 'node:crypto';
import { createDomainDeploymentInspector, signDomainProbe, isPublicDeploymentAddress, DOMAIN_CHECK_HEADER, DOMAIN_CHECK_HEADER_VALUE, DOMAIN_NONCE_HEADER } from '../src/domain-deployment.js';

const host = 'chat.cliente.com.br', canonicalHost = 'elozi.je4ndev.com', sourceRevision = 'a'.repeat(40);
const context = { workspaceId: 'workspace-qa', canonicalHost, challenge: 'c'.repeat(64), version: 2 };
const privateKey = Buffer.alloc(32, 17);
const instant = Date.parse('2026-10-03T12:00:00.000Z');
const rejectStatus = status => error => error.status === status;
const proof = { workspaceId: context.workspaceId, host, canonicalHost, sourceRevision };

function fixture(options = {}) {
  const calls = [], dns = [], requests = [], responses = [], keyCalls = [];
  let destroyedRequests = 0, destroyedResponses = 0;
  const lookupImpl = options.lookupImpl || (async (hostname, args) => { dns.push([hostname, args]); return options.records || [{ address: '1.1.1.1', family: 4 }]; });
  const requestImpl = options.requestImpl || ((url, args, onResponse) => {
    calls.push([url, args]);
    const outgoing = new EventEmitter(); requests.push(outgoing);
    outgoing.destroy = () => { destroyedRequests++; };
    outgoing.end = () => queueMicrotask(() => {
      if (options.hang) return;
      if (options.requestError) { outgoing.emit('error', new Error('synthetic-private-request-error')); return; }
      const nonce = args.headers[DOMAIN_NONCE_HEADER], signed = (value = proof, signingContext = {}) => ({ ...value, nonce, signature: signDomainProbe(value, { ...context, nonce, ...signingContext }, privateKey) });
      const body = options.body ?? (options.bodyImpl ? options.bodyImpl({ args, nonce, signed }) : JSON.stringify(signed()));
      const incoming = Readable.from(typeof options.chunks === 'function' ? options.chunks(body, args) : options.chunks || [body]);
      incoming.statusCode = options.statusCode ?? 200;
      incoming.headers = { 'content-type': 'application/json; charset=utf-8', [DOMAIN_CHECK_HEADER]: DOMAIN_CHECK_HEADER_VALUE, ...options.headers };
      const peer = { subjectaltname: `DNS:${host}`, subject: { CN: host }, valid_from: 'Oct 01 00:00:00 2026 GMT', valid_to: 'Oct 04 00:00:00 2026 GMT', ...options.peer };
      incoming.socket = { encrypted: true, authorized: true, remoteAddress: options.records?.[0]?.address || '1.1.1.1', getPeerCertificate: () => peer, ...options.socket };
      const originalDestroy = incoming.destroy.bind(incoming);
      incoming.destroy = (...args) => { destroyedResponses++; return originalDestroy(...args); };
      responses.push(incoming); onResponse(incoming);
      if (options.aborted) incoming.emit('aborted');
    });
    return outgoing;
  });
  const inspector = createDomainDeploymentInspector({ sourceRevision, keyLoader: async () => { keyCalls.push(true); return privateKey; }, lookupImpl, requestImpl, now: () => instant, ...options.factory });
  return { inspector, calls, dns, requests, responses, keyCalls, destruction: () => ({ requests: destroyedRequests, responses: destroyedResponses }) };
}

test('IP público exclui redes privadas, reservadas, documentais e transições IPv4/IPv6', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '172.15.1.1', '192.169.1.1', '100.128.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1', '::ffff:8.8.8.8', '::ffff:808:808']) assert.equal(isPublicDeploymentAddress(address), true, address);
  for (const address of [null, 1, '', 'not-an-ip', '127.0.0.1', '127.1', '0.0.0.0', '0.1.2.3', '10.1.2.3', '169.254.1.1', '172.16.1.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.1.1', '198.19.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2001:0db8::1', '2001::1', '2001:20::1', '2002:7f00::1', '3fff::1', '64:ff9b::808:808', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::8.8.8.8']) assert.equal(isPublicDeploymentAddress(address), false, String(address));
});

test('probe usa DNS all, IP pin, SNI, CA padrão e resposta mínima da revisão corrente', async () => {
  const c = fixture(), result = await c.inspector(host.toUpperCase(), context);
  assert.deepEqual(result, { host, httpsOrigin: `https://${host}`, tlsValid: true, proxyVerified: true,signedRouteVerified:true, certificateExpiresAt: '2026-10-04T00:00:00.000Z', sourceRevision });
  assert.deepEqual(c.dns, [[host, { all: true, verbatim: true }]]); assert.equal(c.calls.length, 1);
  const [url, args] = c.calls[0]; assert.equal(url.href, `https://${host}/api/domain-check`); assert.equal(args.method, 'GET');
  assert.equal(args.headers[DOMAIN_CHECK_HEADER], DOMAIN_CHECK_HEADER_VALUE, 'A inspeção precisa solicitar explicitamente a prova mínima no hostname ainda inativo.');
  assert.match(args.headers[DOMAIN_NONCE_HEADER], /^[a-f0-9]{64}$/); assert.equal(c.keyCalls.length, 1);
  assert.equal(args.rejectUnauthorized, true); assert.equal(args.checkServerIdentity, checkServerIdentity); assert.equal(args.servername, host); assert.equal(args.agent, false); assert.equal(args.autoSelectFamily, false);
  assert.equal(args.family, 4); assert.equal(args.maxHeaderSize, 8192); assert.equal(args.timeout, 5000);
  for (const field of ['ca', 'cert', 'key', 'pfx', 'auth', 'hostname', 'port', 'path']) assert.equal(Object.hasOwn(args, field), false);
  assert.equal(Object.hasOwn(args.headers, 'authorization'), false); assert.equal(Object.hasOwn(args.headers, 'cookie'), false); assert.equal(Object.hasOwn(args.headers, 'host'), false);
  args.lookup(host, { all: true }, (error, records) => { assert.equal(error, null); assert.deepEqual(records, [{ address: '1.1.1.1', family: 4 }]); });
  args.lookup(host, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
  args.lookup('different.cliente.com.br', {}, error => assert.equal(error.status, 502));
});

test('IPv6 público e remoteAddress IPv4 mapeado conservam o endereço pinado', async () => {
  const v6 = fixture({ records: [{ address: '2606:4700:4700::1111', family: 6 }], socket: { remoteAddress: '2606:4700:4700:0:0:0:0:1111' } });
  assert.equal((await v6.inspector(host, context)).tlsValid, true); assert.equal(v6.calls[0][1].family, 6);
  const mapped = fixture({ socket: { remoteAddress: '::ffff:101:101' } }); assert.equal((await mapped.inspector(host, context)).proxyVerified, true);
});

test('hostname/contexto/revisão inválidos recusam antes de DNS ou HTTPS', async () => {
  const c = fixture();
  for (const value of ['127.0.0.1', 'localhost', 'chat.local', '*.cliente.com.br', `${host}:443`, `https://${host}`, `${host}/path`, canonicalHost]) await assert.rejects(c.inspector(value, context), rejectStatus(400));
  for (const value of [null, {}, { ...context, workspaceId: '' }, { ...context, workspaceId: 'invalid\nworkspace' }, { ...context, canonicalHost: 'localhost' }, { ...context, challenge: undefined }, { ...context, challenge: 'C'.repeat(64) }, { ...context, challenge: 'c'.repeat(63) }, { ...context, challenge: 1 }, { ...context, version: undefined }, { ...context, version: 0 }, { ...context, version: '2' }, { ...context, version: 1.5 }, { ...context, version: Number.MAX_SAFE_INTEGER + 1 }]) await assert.rejects(c.inspector(host, value), rejectStatus(400));
  assert.equal(c.dns.length, 0); assert.equal(c.calls.length, 0); assert.equal(c.keyCalls.length, 0);
  for (const value of [undefined, '', 'bad-sha', 'a'.repeat(64), 'A'.repeat(40)]) assert.throws(() => createDomainDeploymentInspector({ sourceRevision: value }), /SHA40/);
});

test('qualquer IP privado, família divergente ou DNS excessivo bloqueia antes da conexão', async () => {
  for (const records of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '1.1.1.1', family: 6 }], [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '2001:0db8::1', family: 6 }], [{ address: '::ffff:7f00:1', family: 6 }], Array.from({ length: 17 }, () => ({ address: '1.1.1.1', family: 4 }))]) {
    const c = fixture({ records }); await assert.rejects(c.inspector(host, context), rejectStatus(502)); assert.equal(c.calls.length, 0);
  }
});

test('DNS rebinding não muda o pin e socket divergente é rejeitado', async () => {
  let dnsCalls = 0;
  const c = fixture({ lookupImpl: async () => { dnsCalls++; return dnsCalls === 1 ? [{ address: '1.1.1.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; }, socket: { remoteAddress: '8.8.8.8' } });
  await assert.rejects(c.inspector(host, context), rejectStatus(502)); assert.equal(dnsCalls, 1); assert.equal(c.calls.length, 1);
  c.calls[0][1].lookup(host, {}, (error, address) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); });
  assert.equal(dnsCalls, 1); assert.ok(c.destruction().requests > 0); assert.ok(c.destruction().responses > 0);
});

test('redirecionamentos, respostas sem proof header/JSON e compressão não seguem outra URL', async () => {
  for (const options of [{ statusCode: 301, headers: { location: 'http://127.0.0.1/' } }, { statusCode: 302, headers: { location: 'https://outro.cliente.com.br/' } }, { statusCode: 403 }, { headers: { [DOMAIN_CHECK_HEADER]: undefined } }, { headers: { [DOMAIN_CHECK_HEADER]: '1, 1' } }, { headers: { 'content-type': 'text/html' } }, { headers: { 'content-encoding': 'gzip' } }]) {
    const c = fixture(options); await assert.rejects(c.inspector(host, context), rejectStatus(502)); assert.equal(c.calls.length, 1); assert.ok(c.destruction().requests > 0);
  }
});

test('TLS exige autorização, certificado vigente e identidade do hostname', async () => {
  for (const options of [{ socket: { encrypted: false } }, { socket: { authorized: false, authorizationError: 'synthetic-private-tls-error' } }, { socket: { getPeerCertificate: () => null } }, { peer: { subjectaltname: 'DNS:outro.cliente.com.br', subject: { CN: 'outro.cliente.com.br' } } }, { peer: { valid_to: 'Oct 03 12:00:00 2026 GMT' } }, { peer: { valid_to: 'invalid' } }, { peer: { valid_from: 'Oct 04 00:00:00 2026 GMT' } }]) {
    const c = fixture(options); await assert.rejects(c.inspector(host, context), error => error.status === 502 && !error.message.includes('synthetic-private-tls-error'));
    assert.equal(c.calls[0][1].rejectUnauthorized, true);
  }
});

test('prova exige owner, host, origem canônica e SHA exatos sem campos adicionais', async () => {
  for (const value of [{ ...proof, workspaceId: 'other-workspace' }, { ...proof, host: 'outro.cliente.com.br' }, { ...proof, canonicalHost: 'outra.origem.com.br' }, { ...proof, sourceRevision: 'b'.repeat(40) }, { ...proof, credential: 'synthetic-secret' }, {}, null, []]) {
    const c = fixture({ body: JSON.stringify(value) }); await assert.rejects(c.inspector(host, context), error => error.status === 502 && !error.message.includes('synthetic-secret'));
  }
  for (const body of ['{invalid json', Buffer.from([0xc3, 0x28])]) await assert.rejects(fixture({ body }).inspector(host, context), rejectStatus(502));
});

test('corpo/header de tamanho excessivo e interrupção destroem request e response', async () => {
  for (const options of [{ headers: { 'content-length': '32769' } }, { headers: { 'content-length': ['1', '1'] } }, { headers: { 'content-length': '-1' } }, { chunks: [Buffer.alloc(16384), Buffer.alloc(16385)] }, { aborted: true }]) {
    const c = fixture(options); await assert.rejects(c.inspector(host, context), rejectStatus(502)); assert.ok(c.destruction().requests > 0); assert.ok(c.destruction().responses > 0);
  }
  await assert.rejects(fixture({ factory: { maxBytes: 10 } }).inspector(host, context), rejectStatus(502));
});

test('deadline cobre DNS e HTTPS pendentes; erros de transporte não vazam conteúdo', async () => {
  const dns = fixture({ lookupImpl: () => new Promise(() => {}), factory: { timeoutMs: 10 } });
  await assert.rejects(dns.inspector(host, context), rejectStatus(504)); assert.equal(dns.calls.length, 0);
  const https = fixture({ hang: true, factory: { timeoutMs: 10 } });
  await assert.rejects(https.inspector(host, context), rejectStatus(504)); assert.ok(https.destruction().requests > 0);
  const failed = fixture({ requestError: true }); await assert.rejects(failed.inspector(host, context), error => error.status === 502 && !error.message.includes('synthetic-private-request-error'));
  const failedDNS = fixture({ lookupImpl: async () => { throw new Error('synthetic-private-dns-error'); } });
  await assert.rejects(failedDNS.inspector(host, context), error => error.status === 502 && !error.message.includes('synthetic-private-dns-error')); assert.equal(failedDNS.calls.length, 0);
});

test('body dividido em chunks valida uma vez e não deixa timeout após sucesso', async () => {
  const c = fixture({ chunks: value => { const body = Buffer.from(value); return [body.subarray(0, 10), body.subarray(10, 50), body.subarray(50)]; }, factory: { timeoutMs: 25 } });
  const result = await c.inspector(host, context); assert.equal(result.sourceRevision, sourceRevision); assert.equal(c.calls.length, 1);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(c.destruction().requests, 0); assert.equal(c.calls[0][1].signal.aborted, false);
});

test('HMAC usa namespace isolado e campos exatos do hostname/conta/revisão/nonce/challenge/CAS', () => {
  const nonce = 'e'.repeat(64), signingContext = { ...context, nonce };
  const expected = createHmac('sha256', privateKey).update(JSON.stringify(['elozi-domain-proof-v1', host, context.workspaceId, canonicalHost, sourceRevision, nonce, context.challenge, context.version])).digest('hex');
  assert.equal(signDomainProbe(proof, signingContext, privateKey), expected);
  assert.notEqual(signDomainProbe(proof, { ...signingContext, nonce: 'f'.repeat(64) }, privateKey), expected);
  assert.notEqual(signDomainProbe(proof, { ...signingContext, challenge: 'd'.repeat(64) }, privateKey), expected);
  assert.notEqual(signDomainProbe(proof, { ...signingContext, version: 3 }, privateKey), expected);
  assert.notEqual(signDomainProbe({ ...proof, sourceRevision: 'b'.repeat(40) }, signingContext, privateKey), expected);
  assert.notEqual(signDomainProbe({ ...proof, workspaceId: 'other' }, signingContext, privateKey), expected);
  assert.notEqual(signDomainProbe({ ...proof, host: 'outro.cliente.com.br' }, signingContext, privateKey), expected);
  assert.notEqual(signDomainProbe({ ...proof, canonicalHost: 'outra.origem.com.br' }, signingContext, privateKey), expected);
});

test('assinador recusa contexto público inválido e chave imprópria sem ecoar material privado', () => {
  const signingContext = { ...context, nonce: 'e'.repeat(64) };
  for (const value of [null, {}, { ...proof, host: '127.0.0.1' }, { ...proof, host: 'CHAT.CLIENTE.COM.BR' }, { ...proof, canonicalHost: 'localhost' }, { ...proof, host: canonicalHost }, { ...proof, workspaceId: '\ninvalid' }, { ...proof, sourceRevision: 'a'.repeat(64) }, { ...proof, sourceRevision: Buffer.from(sourceRevision) }]) assert.throws(() => signDomainProbe(value, signingContext, privateKey), rejectStatus(400));
  for (const value of [null, {}, { ...signingContext, nonce: '' }, { ...signingContext, nonce: 'e'.repeat(63) }, { ...signingContext, nonce: 'E'.repeat(64) }, { ...signingContext, challenge: Buffer.from(context.challenge) }, { ...signingContext, version: '2' }, { ...signingContext, version: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => signDomainProbe(proof, value, privateKey), rejectStatus(400));
  for (const key of [undefined, 'synthetic-private-key', Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32)]) assert.throws(() => signDomainProbe(proof, signingContext, key), error => error.status === 502 && !error.message.includes('synthetic-private-key'));
  assert.throws(() => createDomainDeploymentInspector({ sourceRevision }), /keyLoader/);
});

test('JSON público copiável, nonce divergente/replay, assinatura errada e assinatura com outro CAS são recusados', async () => {
  const variants = [
    () => JSON.stringify(proof),
    ({ nonce }) => JSON.stringify({ ...proof, nonce, signature: '0'.repeat(64) }),
    ({ signed }) => JSON.stringify({ ...signed(), nonce: '0'.repeat(64) }),
    ({ nonce }) => JSON.stringify({ ...proof, nonce, signature: signDomainProbe(proof, { ...context, nonce }, Buffer.alloc(32, 18)) }),
    ({ signed }) => JSON.stringify(signed(proof, { challenge: 'd'.repeat(64) })),
    ({ signed }) => JSON.stringify(signed(proof, { version: 3 })),
    ({ signed }) => JSON.stringify({ ...signed(), signature: 'bad' }),
    ({ signed }) => JSON.stringify({ ...signed(), extra: 'synthetic-private-secret' }),
    ({ signed }) => JSON.stringify(signed({ ...proof, workspaceId: 'another-workspace' })),
    ({ signed }) => JSON.stringify(signed({ ...proof, host: 'outro.cliente.com.br' })),
    ({ signed }) => JSON.stringify(signed({ ...proof, canonicalHost: 'outra.origem.com.br' })),
    ({ signed }) => JSON.stringify(signed({ ...proof, sourceRevision: 'b'.repeat(40) }))
  ];
  for (const bodyImpl of variants) { const c = fixture({ bodyImpl }); await assert.rejects(c.inspector(host, context), error => error.status === 502 && !error.message.includes('synthetic-private-secret')); assert.equal(c.calls.length, 1); assert.ok(c.destruction().requests > 0); }
  let prior, probes = 0;
  const replay = fixture({ bodyImpl: ({ signed }) => { if (++probes === 1) prior = signed(); return JSON.stringify(prior); } });
  await replay.inspector(host, context); await assert.rejects(replay.inspector(host, context), rejectStatus(502));
  assert.notEqual(replay.calls[0][1].headers[DOMAIN_NONCE_HEADER], replay.calls[1][1].headers[DOMAIN_NONCE_HEADER]);
});

test('keyLoader privado participa do mesmo orçamento, falha antes de DNS e não modifica chave compartilhada', async () => {
  const original = Buffer.from(privateKey), hanging = fixture({ factory: { keyLoader: () => new Promise(() => {}), timeoutMs: 10 } });
  await assert.rejects(hanging.inspector(host, context), rejectStatus(504)); assert.equal(hanging.dns.length, 0); assert.equal(hanging.calls.length, 0);
  const slow = fixture({ factory: { timeoutMs: 15, keyLoader: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return privateKey; } }, lookupImpl: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return [{ address: '1.1.1.1', family: 4 }]; } });
  await assert.rejects(slow.inspector(host, context), rejectStatus(504)); assert.equal(slow.calls.length, 0);
  for (const value of [null, 'synthetic-private-key', Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32)]) { const c = fixture({ factory: { keyLoader: async () => value } }); await assert.rejects(c.inspector(host, context), error => error.status === 502 && !error.message.includes('synthetic-private-key')); assert.equal(c.dns.length, 0); assert.equal(c.calls.length, 0); }
  const failed = fixture({ factory: { keyLoader: async () => { throw new Error('synthetic-private-key-loader-secret'); } } }); await assert.rejects(failed.inspector(host, context), error => error.status === 502 && !error.message.includes('synthetic-private-key-loader-secret'));
  const c = fixture(); await c.inspector(host, context); assert.deepEqual(privateKey, original);
});

test('challenge/versão são capturados antes de awaits e nunca enviados em headers/corpo nem retornados', async () => {
  const mutable = { ...context }, copiedKey = Buffer.from(privateKey);
  const c = fixture({ factory: { keyLoader: async () => { mutable.challenge = 'd'.repeat(64); mutable.version = 99; return copiedKey; } } });
  const result = await c.inspector(host, mutable);
  assert.deepEqual(Object.keys(result).sort(), ['certificateExpiresAt', 'host', 'httpsOrigin', 'proxyVerified','signedRouteVerified', 'sourceRevision', 'tlsValid']);
  const args = c.calls[0][1]; assert.equal(args.headers['x-elozi-domain-challenge'], undefined); assert.equal(args.headers['x-elozi-domain-version'], undefined); assert.equal(Object.hasOwn(args, 'body'), false); assert.equal(Object.hasOwn(args, 'key'), false); assert.deepEqual(copiedKey, privateKey);
});
