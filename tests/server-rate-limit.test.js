import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createApp, clientAddress, trustedProxyCheck, rateLimitKey, defaultGateway, createAccessLimiter } from '../src/server.js';

const fakeRequest = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('cabeçalhos encaminhados só valem quando o par TCP é um proxy local confiável', () => {
  const spoofed = { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.8, 198.51.100.9', 'cf-connecting-ip': '198.51.100.10' };
  assert.equal(clientAddress(fakeRequest('203.0.113.5', spoofed)), '203.0.113.5', 'par público direto não escolhe o próprio endereço');
  assert.equal(clientAddress(fakeRequest('::ffff:203.0.113.5', spoofed)), '203.0.113.5');
  assert.equal(clientAddress(fakeRequest('172.18.0.1', spoofed)), '172.18.0.1', 'rede privada não é confiável sem configuração explícita');
  assert.equal(clientAddress(fakeRequest('127.0.0.1', { 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientAddress(fakeRequest('::ffff:127.0.0.1', { 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientAddress(fakeRequest('::1', { 'x-forwarded-for': '198.51.100.1, 198.51.100.2' })), '198.51.100.2', 'último salto é o par visto pelo nginx');
  assert.equal(clientAddress(fakeRequest('127.0.0.1', { 'x-real-ip': 'não-é-ip', 'x-forwarded-for': 'lixo' })), '127.0.0.1');
  assert.equal(clientAddress(fakeRequest('127.0.0.1', { 'x-real-ip': '[2001:db8::7]' })), '2001:db8::7');
  // CF-Connecting-IP only counts when nginx saw a published Cloudflare edge; a direct client cannot inject it.
  assert.equal(clientAddress(fakeRequest('127.0.0.1', { 'x-real-ip': '172.70.10.20', 'cf-connecting-ip': '198.51.100.44' })), '198.51.100.44');
  assert.equal(clientAddress(fakeRequest('127.0.0.1', { 'x-real-ip': '2606:4700:10::1', 'cf-connecting-ip': '2001:db8:aa::1' })), '2001:db8:aa::1');
  assert.equal(clientAddress(fakeRequest('127.0.0.1', { 'x-real-ip': '198.51.100.7', 'cf-connecting-ip': '198.51.100.44' })), '198.51.100.7');
  assert.equal(clientAddress(fakeRequest('127.0.0.1', { 'x-real-ip': '172.70.10.20', 'cf-connecting-ip': 'inválido' })), '172.70.10.20');
  assert.equal(clientAddress(fakeRequest('203.0.113.5', { 'x-real-ip': '172.70.10.20', 'cf-connecting-ip': '198.51.100.44' })), '203.0.113.5');
  assert.equal(clientAddress(fakeRequest(undefined, spoofed)), 'unknown');
});

test('proxies adicionais são IPs ou CIDRs explícitos e configuração inválida é recusada', () => {
  const docker = trustedProxyCheck(['172.18.0.1', '10.20.0.0/16']);
  assert.equal(docker('172.18.0.1'), true); assert.equal(docker('10.20.3.4'), true); assert.equal(docker('172.18.0.2'), false);
  assert.equal(docker('127.0.0.1'), true); assert.equal(docker('::1'), true); assert.equal(docker('203.0.113.5'), false);
  assert.equal(clientAddress(fakeRequest('172.18.0.1', { 'x-real-ip': '198.51.100.7' }), docker), '198.51.100.7');
  assert.equal(clientAddress(fakeRequest('172.18.0.2', { 'x-real-ip': '198.51.100.7' }), docker), '172.18.0.2');
  for (const invalid of ['nginx', '10.0.0.0/33', '10.0.0.0/8/1', '10.0.0.0/x', '::1/129']) assert.throws(() => trustedProxyCheck([invalid]), /MEPCHAT_TRUSTED_PROXIES/, invalid);
  assert.throws(() => createApp({ databasePath: ':memory:', trustedProxies: ['proxy.local'] }), /MEPCHAT_TRUSTED_PROXIES/);
});

// Production: nginx on the host proxies to 127.0.0.1:4318, a port Docker publishes into a container on supabase_default.
// The container sees the bridge gateway (for example 172.18.0.1), never loopback, so the image trusts exactly that address.
const ROUTES = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
  + 'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n'
  + 'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';

test('gateway do container é lido da tabela de rotas como um único endereço exato', () => {
  assert.equal(defaultGateway(ROUTES), '172.18.0.1');
  assert.equal(defaultGateway('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n'), '', 'sem rota padrão (network none)');
  assert.equal(defaultGateway('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\n'), '', 'rota padrão sem gateway');
  assert.equal(defaultGateway('lixo'), ''); assert.equal(defaultGateway(''), '');
  assert.equal(typeof defaultGateway(), 'string', 'fora do Linux (ou sem /proc) não lança');
});

test('"gateway" confia somente no gateway exato; o restante da rede do container continua não confiável', () => {
  const trusted = trustedProxyCheck(['gateway'], () => defaultGateway(ROUTES));
  assert.equal(trusted('172.18.0.1'), true); assert.equal(trusted('::ffff:172.18.0.1'), true);
  for (const other of ['172.18.0.2', '172.18.0.254', '172.18.1.1', '10.0.0.1']) assert.equal(trusted(other), false, other);
  assert.equal(trusted('127.0.0.1'), true, 'loopback continua confiável');
  assert.equal(clientAddress(fakeRequest('172.18.0.1', { 'x-real-ip': '198.51.100.7' }), trusted), '198.51.100.7', 'nginx do host via Docker');
  assert.equal(clientAddress(fakeRequest('172.18.0.1', { 'x-real-ip': '172.70.10.20', 'cf-connecting-ip': '198.51.100.44' }), trusted), '198.51.100.44', 'nginx atrás do Cloudflare');
  assert.equal(clientAddress(fakeRequest('172.18.0.5', { 'x-real-ip': '198.51.100.7' }), trusted), '172.18.0.5', 'outro container não escolhe o endereço');
  const unresolved = trustedProxyCheck(['GATEWAY'], () => '');
  assert.equal(unresolved('172.18.0.1'), false, 'sem rota padrão nada além de loopback é confiável');
  assert.equal(clientAddress(fakeRequest('172.18.0.1', { 'x-real-ip': '198.51.100.7' }), unresolved), '172.18.0.1');
  assert.doesNotThrow(() => trustedProxyCheck(['gateway', '10.20.0.0/16'], () => '172.18.0.1'));
});

test('imagem confia no gateway exato do container, nunca numa faixa', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^\s*MEPCHAT_TRUSTED_PROXIES=gateway \\$/m);
  assert.doesNotMatch(dockerfile, /MEPCHAT_TRUSTED_PROXIES=[^\n]*\//, 'nenhum CIDR');
});

test('tabela de limites cheia não varre o mapa inteiro e descarta primeiro a janela mais antiga', () => {
  let clock = 1000;
  const limiter = createAccessLimiter({ capacity: 50000, windowMs: 60000, now: () => clock });
  for (let index = 0; index < 50000; index++) limiter.hit('k' + index, 20, 'Limite');
  assert.equal(limiter.size, 50000);
  // Before, every hit at capacity scanned all 50 000 windows: 20 000 hits meant about a billion iterations.
  const started = performance.now();
  for (let index = 0; index < 20000; index++) { clock++; limiter.hit('n' + index, 20, 'Limite'); }
  assert.ok(performance.now() - started < 1500, 'inserções na capacidade são O(1) amortizado');
  assert.equal(limiter.size, 50000);
  for (let index = 0; index < 19; index++) limiter.hit('n19999', 20, 'Limite');
  assert.throws(() => limiter.hit('n19999', 20, 'Limite'), error => error.status === 429 && error.retryAfter >= 1 && error.retryAfter <= 60, 'janela recente preservada');
  // Once every window expires the table empties at the next hit, without keeping stale entries.
  clock += 60001; limiter.hit('novo', 20, 'Limite');
  assert.equal(limiter.size, 1);
});

test('janela vencida recomeça a contagem e a capacidade descarta a janela mais antiga', () => {
  let clock = 0;
  const limiter = createAccessLimiter({ capacity: 3, windowMs: 1000, now: () => clock });
  for (let index = 0; index < 2; index++) limiter.hit('a', 2, 'Limite');
  assert.throws(() => limiter.hit('a', 2, 'Limite'), /Limite/);
  clock = 1000; limiter.hit('a', 2, 'Limite'); limiter.hit('a', 2, 'Limite');
  clock = 1100; limiter.hit('b', 2, 'Limite'); limiter.hit('c', 2, 'Limite');
  assert.equal(limiter.size, 3);
  clock = 1200; limiter.hit('d', 2, 'Limite');
  assert.equal(limiter.size, 3, 'capacidade respeitada');
  assert.doesNotThrow(() => limiter.hit('a', 2, 'Limite'), 'a janela mais antiga (a) foi descartada e recomeça');
});

test('chave de limite agrupa IPv6 por /64 e mantém IPv4 exato', () => {
  assert.equal(rateLimitKey('203.0.113.5'), '203.0.113.5');
  assert.equal(rateLimitKey('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(rateLimitKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:0db8:0001:0002:ffff::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.notEqual(rateLimitKey('2001:db8:1:3::1'), rateLimitKey('2001:db8:1:2::1'));
});

async function fixture(t, options = {}) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido na fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny }, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const request = (path, { headers = {}, body = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const forgot = headers => request('/api/auth/password/forgot', { headers, body: { email: 'pessoa@example.invalid' } });
  return { app, request, forgot };
}

test('atrás do nginx local cada cliente tem a própria janela: um atacante não bloqueia os demais', async t => {
  const { forgot } = await fixture(t);
  for (let index = 0; index < 10; index++) assert.equal((await forgot({ 'X-Real-IP': '198.51.100.20' })).status, 200);
  const blocked = await forgot({ 'X-Real-IP': '198.51.100.20' });
  assert.equal(blocked.status, 429); assert.equal(blocked.data.error, 'Aguarde um minuto antes de tentar novamente.');
  assert.ok(Number(blocked.headers['retry-after']) >= 1 && Number(blocked.headers['retry-after']) <= 60);
  assert.equal(blocked.data.requestId, undefined, 'limite não é falha interna');
  assert.equal((await forgot({ 'X-Real-IP': '198.51.100.21' })).status, 200, 'outro cliente continua atendido');
  assert.equal((await forgot({ 'X-Forwarded-For': '198.51.100.20, 198.51.100.22' })).status, 200, 'sem X-Real-IP vale o último salto');
  // Through Cloudflare, nginx sees the edge; the visitor is CF-Connecting-IP.
  for (let index = 0; index < 10; index++) assert.equal((await forgot({ 'X-Real-IP': '162.158.1.1', 'CF-Connecting-IP': '198.51.100.30' })).status, 200);
  assert.equal((await forgot({ 'X-Real-IP': '162.158.1.1', 'CF-Connecting-IP': '198.51.100.30' })).status, 429);
  assert.equal((await forgot({ 'X-Real-IP': '162.158.1.1', 'CF-Connecting-IP': '198.51.100.31' })).status, 200, 'outro visitante pela mesma borda');
});

test('par não confiável não troca de chave por cabeçalhos forjados', async t => {
  // Simulates a peer outside the trusted proxies (the socket is loopback only because the test cannot open another interface).
  const { forgot } = await fixture(t, { trustedProxies: () => false });
  for (let index = 0; index < 10; index++) {
    const response = await forgot({ 'X-Real-IP': `198.51.100.${index + 1}`, 'X-Forwarded-For': `203.0.113.${index + 1}`, 'CF-Connecting-IP': `192.0.2.${index + 1}` });
    assert.equal(response.status, 200);
  }
  const rotated = await forgot({ 'X-Real-IP': '198.51.100.99', 'X-Forwarded-For': '203.0.113.99', 'CF-Connecting-IP': '192.0.2.99' });
  assert.equal(rotated.status, 429, 'rotação de cabeçalhos continua na mesma janela do socket');
});

test('login usa o mesmo cliente real e mantém o limite de 20 tentativas por minuto', async t => {
  const { request } = await fixture(t);
  const login = ip => request('/api/auth/login', { headers: { 'X-Real-IP': ip }, body: {} });
  for (let index = 0; index < 20; index++) assert.equal((await login('198.51.100.40')).status, 400);
  const blocked = await login('198.51.100.40');
  assert.equal(blocked.status, 429); assert.equal(blocked.data.error, 'Muitas tentativas. Aguarde um minuto.'); assert.ok(blocked.headers['retry-after']);
  assert.equal((await login('198.51.100.41')).status, 400, 'outra pessoa ainda consegue tentar');
});
