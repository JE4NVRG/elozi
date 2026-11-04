// Public presentation and pricing of Elozi (src/public-site.js, audit point 8 of 27/10/2026): served only on Elozi's own
// public host: anonymous HTML/wildcard root serves marketing; sessions and explicit JSON keep the app shell.
// Resellers' custom domains (white label) never see Elozi's name or prices. Both explicit synthetic overrides
// and the approved public default are exercised; no session, login, API or static response is cached here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createPublicSite, PUBLIC_SITE_PRICING } from '../src/public-site.js';
import { publicSiteHtmlHint, publicRootVary, publicSiteCsp, PUBLIC_BEACON_SCRIPTS } from '../src/public-site-http.js';

const canonicalHost = 'elozi.je4ndev.com', canonicalOrigin = `https://${canonicalHost}`;
const navigate = { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const crawler = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' };
const PRICING = Object.freeze({
  plans: [{ name: 'Plano Sintético A', price: 10, audience: 'Plano fictício de teste.', limits: ['1 número de WhatsApp', 'Até 2 usuários'] },
    { name: 'Plano Sintético B', price: 1234, audience: 'Outro plano fictício.', limits: ['5 números de WhatsApp'], featured: true }],
  extraWhatsapp: 7, included: ['Item incluído sintético']
});

/** pricing: null hides prices, an object replaces them, undefined keeps the published ones (src/public-site.js). */
async function siteFixture(t, { publicOrigin = canonicalOrigin, allowRegistration = true, publicTrialEnabled = false, ...site } = {}) {
  const key = randomBytes(32), deny = async () => assert.fail('Nenhum transporte externo neste teste.');
  const app = createApp({ databasePath: ':memory:', publicOrigin, allowRegistration, publicTrialEnabled, serviceKey: key, siteOptions: { pricing: null, ...site },
    googleOptions: { clientId: '' }, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: deny },
    domainOptions: { canonicalHost, resolver: { resolveTxt: deny, resolveCname: deny }, inspectDeployment: null } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.meta.close(), app.webchat.close(), app.bridge.close()]); app.store.close();
  });
  const request = (path, { method = 'GET', host = publicOrigin ? canonicalHost : '127.0.0.1', headers = {} } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method, headers: { Host: host, ...headers } }, response => {
      const chunks = []; response.on('error', reject); response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject); outgoing.end();
  });
  /** A workspace with an active custom domain, written as domains.resolve reads it (see brand-css-http.test.js). */
  const bindDomain = (id, host) => {
    const at = offset => new Date(Date.now() + offset).toISOString();
    app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(id, JSON.stringify({ name: 'Revenda sintética QA', brand: { name: 'Acme Atendimento', accent: '#e11d48' }, version: 1,
      workspaceDomain: { host, state: 'active', challenge: 'a'.repeat(64), configuredAt: at(-7200000), verifiedAt: at(-3600000), lastCheck: null,
        deployment: { host, httpsOrigin: `https://${host}`, canonicalHost, tlsValid: true, proxyVerified: true, observedAt: at(-1800000), certificateExpiresAt: at(86400000) } } }));
  };
  return { app, request, bindDomain };
}

const meta = (html, attribute, name) => new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`).exec(html)?.[1];
const sitemapPaths = body => [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);

test('public negotiation respects quality and preserves explicit JSON/mixed preferences', () => {
  for (const accept of [undefined, '', '*/*', '*/*;q=0.5', 'text/html', 'TEXT/HTML; charset=utf-8', 'text/html,application/json;q=0.9']) assert.equal(publicSiteHtmlHint('/', accept), true, String(accept));
  for (const accept of ['application/json', 'application/json, */*;q=0.8', 'text/html;q=0', 'text/html;q=0,*/*', '*/*;q=0', '*/*;q=invalid', 'text/html;q=2']) assert.equal(publicSiteHtmlHint('/', accept), false, accept);
  assert.equal(publicSiteHtmlHint('/api/health', '*/*'), false);
  assert.equal(publicSiteHtmlHint('/login', undefined), false);
  assert.equal(publicRootVary('Accept-Encoding, cookie'), 'Accept-Encoding, cookie, Accept');
  assert.equal(publicRootVary(publicRootVary('Accept-Encoding')), 'Accept-Encoding, Accept, Cookie');
  assert.equal(publicRootVary('*'), '*');
  const base = "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/; connect-src 'self'; object-src 'none';";
  const publicPolicy = publicSiteCsp(base);
  assert.equal(publicSiteCsp(publicPolicy), publicPolicy);
  assert.ok(publicPolicy.includes("connect-src 'self'; object-src 'none';"));
  for (const source of PUBLIC_BEACON_SCRIPTS) assert.ok(publicPolicy.includes(source));
});

test('anonymous root GET/HEAD supplies marketing and OG to empty and wildcard preview clients', async t => {
  const f = await siteFixture(t);
  for (const accept of [undefined, '', '*/*', '*/*;q=0.8', 'text/html']) {
    const headers = { 'User-Agent': 'facebookexternalhit/1.1', ...(accept === undefined ? {} : { Accept: accept }) };
    const get = await f.request('/', { headers });
    const head = await f.request('/', { method: 'HEAD', headers });
    assert.equal(get.status, 200); assert.equal(head.status, 200);
    assert.match(get.body, /<h1[^>]*>Seu cliente chamou/); assert.equal(meta(get.body, 'property', 'og:locale'), 'pt_BR');
    assert.doesNotMatch(get.body, /app-entry\.js/); assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    for (const response of [get, head]) {
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(new Set(response.headers.vary.toLowerCase().split(/,\s*/)), new Set(['accept', 'cookie']));
    }
  }
});

test('root session and explicit non-HTML negotiation retain private app/HEAD contracts', async t => {
  const f = await siteFixture(t);
  for (const accept of ['', '*/*', 'text/html', 'application/json']) {
    const result = await f.request('/', { headers: { Accept: accept, Cookie: 'mep_session=synthetic-session' } });
    assert.equal(result.status, 200); assert.match(result.body, /app-entry\.js/); assert.doesNotMatch(result.body, /Seu cliente chamou/);
    assert.doesNotMatch(result.headers['content-security-policy'], /cloudflareinsights/);
    assert.equal(result.headers['cache-control'], 'no-store'); assert.match(result.headers.vary, /Cookie/);
  }
  for (const accept of ['application/json', 'application/json, */*;q=0.8', 'text/html;q=0', '*/*;q=0']) {
    const get = await f.request('/', { headers: { Accept: accept } });
    const head = await f.request('/', { method: 'HEAD', headers: { Accept: accept } });
    assert.equal(get.status, 200); assert.match(get.body, /app-entry\.js/);
    assert.equal(head.status, 404); assert.equal(head.body, ''); assert.match(head.headers['content-type'], /application\/json/);
    assert.doesNotMatch(get.headers['content-security-policy'], /cloudflareinsights/);
  }
});

test('only real public HTML gets exact automatic-beacon script paths, without changing connect/API/login policies', async t => {
  const f = await siteFixture(t, { pricing: undefined });
  for (const path of ['/', '/precos', '/contato', '/termos', '/privacidade', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy']) {
    const result = await f.request(path, { headers: navigate });
    assert.equal(result.status, 200, path);
    const csp = result.headers['content-security-policy'];
    const scripts = csp.split(';').find(value => value.trim().startsWith('script-src ')).trim().split(/\s+/).slice(1);
    assert.deepEqual(new Set(scripts), new Set(["'self'", ...PUBLIC_BEACON_SCRIPTS]), path);
    assert.match(csp, /connect-src 'self';/); assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  for (const path of ['/login', '/api/nonexistent', '/mark.svg', '/robots.txt', '/sitemap.xml', '/missing-page']) {
    const result = await f.request(path, { headers: navigate });
    assert.doesNotMatch(result.headers['content-security-policy'], /cloudflareinsights/, path);
  }
  for (const method of ['POST', 'OPTIONS']) {
    const result = await f.request('/', { method, headers: { Accept: 'text/html' } });
    assert.notEqual(result.status, 200); assert.doesNotMatch(result.body, /Seu cliente chamou/);
    assert.doesNotMatch(result.headers['content-security-policy'], /cloudflareinsights/);
  }
});

test('host próprio: visitante e buscador recebem a apresentação indexável em /, com Open Graph, entrada e cadastro', async t => {
  const f = await siteFixture(t);
  for (const headers of [navigate, crawler]) {
    const home = await f.request('/', { headers });
    assert.equal(home.status, 200); assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(Number(home.headers['content-length']), Buffer.byteLength(home.body));
    assert.match(home.body, /<title>Elozi · Sua equipe no mesmo atendimento<\/title>/);
    assert.ok(meta(home.body, 'name', 'description').length > 80);
    assert.equal(meta(home.body, 'name', 'robots'), 'index,follow');
    assert.match(home.body, new RegExp(`<link rel="canonical" href="${canonicalOrigin}/">`));
    assert.equal(meta(home.body, 'property', 'og:url'), `${canonicalOrigin}/`); assert.equal(meta(home.body, 'property', 'og:image'), `${canonicalOrigin}/social-pt.png`);
    assert.equal(meta(home.body, 'property', 'og:title'), 'Elozi · Sua equipe no mesmo atendimento');
    assert.match(home.body, /<h1[^>]*>Seu cliente chamou\. Sua equipe sabe quem responde\.<\/h1>/);
    assert.match(home.body, /<strong>Conecte seu próprio agente<\/strong> por MCP/);
    assert.match(meta(home.body, 'name', 'description'), /seu próprio agente via MCP/);
    for (const link of ['/login', '/login?cadastro=1']) assert.match(home.body, new RegExp(`href="${link.replace('?', '\\?')}"`), link);
    assert.match(home.body, />Criar minha conta</); assert.doesNotMatch(home.body, /7 dias/, 'the trial is off on this server');
    assert.doesNotMatch(home.body, /R\$|\/precos/, 'explicit null hides all pricing');
    assert.deepEqual([...home.body.matchAll(/<script\b[^>]*>/g)].map(match => match[0]), ['<script src="/site.js">'], 'only the fragment hand-off, no inline script');
    assert.equal(home.headers['cache-control'], 'no-store', 'the same address opens the panel with a session');
  }
  const head = await f.request('/', { method: 'HEAD', headers: navigate });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.ok(Number(head.headers['content-length']) > 1000);
});

test('host próprio: sessão em / continua abrindo o painel; leitura programática recebe o app (scripts/verify.mjs)', async t => {
  const f = await siteFixture(t, { pricing: PRICING });
  for (const [label, headers] of [['session', { ...navigate, Cookie: 'tema=claro; mep_session=sintetico' }], ['json', { Accept: 'application/json' }], ['mixed JSON', { Accept: 'application/json, */*;q=0.8' }]]) {
    const shell = await f.request('/', { headers });
    assert.equal(shell.status, 200, label); assert.match(shell.body, /app-entry\.js/, label); assert.doesNotMatch(shell.body, /Seu cliente chamou|Conecte seu próprio agente|R\$/, label);
  }
});

test('sem preços aprovados não há página de preços: /precos e /pricing seguem 404 neutro e o sitemap lista só a apresentação', async t => {
  const f = await siteFixture(t, { pricing: null });
  for (const path of ['/precos', '/pricing']) {
    const page = await f.request(path, { headers: navigate });
    assert.equal(page.status, 404, path); assert.match(page.body, /Página não encontrada/); assert.doesNotMatch(page.body, /R\$/, path);
  }
  const robots = await f.request('/robots.txt');
  assert.equal(robots.status, 200); assert.equal(robots.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(robots.body, `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /billing/\nDisallow: /verify-email\nDisallow: /accept-invite\nDisallow: /reset-password\nSitemap: ${canonicalOrigin}/sitemap.xml\n`);
  const sitemap = await f.request('/sitemap.xml');
  assert.equal(sitemap.status, 200); assert.equal(sitemap.headers['content-type'], 'application/xml; charset=utf-8');
  assert.deepEqual(sitemapPaths(sitemap.body), ['/', '/contato', '/termos', '/privacidade', '/en/', '/en/contact', '/en/terms', '/en/privacy'].map(path => canonicalOrigin + path));
});

test('preços aprovados: /precos lista planos, adicional e inclusos; /pricing vira /precos; a apresentação aponta os planos', async t => {
  const f = await siteFixture(t, { pricing: PRICING });
  const pricing = await f.request('/precos', { headers: navigate });
  assert.equal(pricing.status, 200); assert.equal(pricing.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(pricing.body, /<title>Planos e preços · Elozi<\/title>/);
  assert.match(pricing.body, new RegExp(`<link rel="canonical" href="${canonicalOrigin}/precos">`));
  assert.match(meta(pricing.body, 'name', 'description'), /a partir de R\$ 10:/);
  assert.match(pricing.body, /<h2 id="plan-1">Plano Sintético A<\/h2>[\s\S]*R\$ 10<small>\/mês<\/small><\/p><ul><li>1 número de WhatsApp<\/li><li>Até 2 usuários<\/li><\/ul>/);
  assert.match(pricing.body, /<article class="plan featured" aria-labelledby="plan-2"><span class="plan-label">Para atender em equipe<\/span><h2 id="plan-2">Plano Sintético B<\/h2>[\s\S]*R\$ 1\.234<small>\/mês<\/small>/);
  assert.ok(pricing.body.includes('R$ 7<small>/mês por número</small>')); assert.ok(pricing.body.includes('<li>Item incluído sintético</li>'));
  assert.deepEqual([...pricing.body.matchAll(/<script\b[^>]*>/g)].map(match => match[0]), ['<script src="/site.js">'], 'only shared menu and fragment handoff');
  assert.equal((await f.request('/precos')).status, 200, 'any reader gets the pricing page');
  for (const headers of [navigate, {}]) {
    const moved = await f.request('/pricing', { headers });
    assert.equal(moved.status, 301); assert.equal(moved.headers.location, '/precos');
  }
  const home = (await f.request('/', { headers: navigate })).body;
  assert.match(home, /href="\/precos">Planos e preços</); assert.match(home, /Planos a partir de R\$ 10 por mês/);
  assert.deepEqual(sitemapPaths((await f.request('/sitemap.xml')).body), ['/', '/precos', '/contato', '/termos', '/privacidade', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy'].map(path => canonicalOrigin + path));
});

test('host próprio: todo link e recurso das páginas públicas responde 200 no mesmo host', async t => {
  for (const pricing of [null, PRICING, undefined]) {
    const f = await siteFixture(t, { pricing });
    const targets = new Set();
    for (const path of ['/', ...(pricing === null ? [] : ['/precos']), '/contato', '/termos', '/privacidade']) {
      const page = await f.request(path, { headers: navigate });
      for (const match of page.body.matchAll(/(?:href|src|url\()=?["']?(\/[^"')\s]*)/g)) targets.add(match[1]);
    }
    assert.ok(targets.has('/site.js') && targets.has('/mark.svg') && targets.has('/fonts/manrope-latin-wght-normal.woff2'));
    for (const target of targets) assert.equal((await f.request(target, { headers: navigate })).status, 200, target);
    const handoff = await f.request('/site.js');
    assert.equal(handoff.headers['content-type'], 'text/javascript; charset=utf-8'); assert.match(handoff.body, /\/login\?lang=en/);
    assert.match(handoff.body, /sections\[location\.pathname/, 'public anchors are page-scoped; source-bound behavior exercised by handoff tests');
  }
});

test('domínio de revenda: sem apresentação, preços, robots ou sitemap da Elozi; a raiz segue para o login da marca', async t => {
  for (const pricing of [PRICING, undefined]) {
    const f = await siteFixture(t, { pricing });
    f.bindDomain('workspace-acme', 'painel.acme.com.br');
    const host = 'painel.acme.com.br';
    const root = await f.request('/', { host, headers: navigate });
    assert.equal(root.status, 302); assert.equal(root.headers.location, '/login');
    for (const path of ['/precos', '/pricing', '/contato', '/termos', '/privacidade', '/en', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy']) {
      const page = await f.request(path, { host, headers: navigate });
      assert.equal(page.status, 404, path); assert.match(page.body, /Página não encontrada/); assert.doesNotMatch(page.body, /Elozi|R\$/, path);
    }
    for (const path of ['/robots.txt', '/sitemap.xml']) assert.equal((await f.request(path, { host })).status, 404, path);
    const crawled = await f.request('/', { host, headers: crawler });
    assert.equal(crawled.status, 200); assert.match(crawled.body, /app-entry\.js/); assert.doesNotMatch(crawled.body, /Seu cliente chamou|Conecte seu próprio agente|R\$/);
  }
});

test('sem origem pública (desenvolvimento local) nada muda: / vai ao login e /precos é 404', async t => {
  const f = await siteFixture(t, { publicOrigin: '', pricing: PRICING });
  const root = await f.request('/', { headers: navigate });
  assert.equal(root.status, 302); assert.equal(root.headers.location, '/login');
  assert.equal((await f.request('/precos', { headers: navigate })).status, 404);
  assert.equal((await f.request('/robots.txt')).status, 404);
});

test('cadastro e teste de 7 dias seguem a configuração do servidor', async t => {
  for (const pricing of [PRICING, undefined, null]) {
    for (const allowRegistration of [true, false]) {
      for (const publicTrialEnabled of [true, false]) {
        const f = await siteFixture(t, { allowRegistration, publicTrialEnabled, pricing });
        const status = JSON.parse((await f.request('/api/auth/status')).body);
        assert.deepEqual(status.publicTrial, allowRegistration && publicTrialEnabled ? { days: 7, documentRequired: true } : null);
        for (const path of ['/', ...(pricing === null ? [] : ['/precos']), '/contato', '/termos', '/privacidade']) {
          const page = (await f.request(path, { headers: navigate })).body;
          if (!allowRegistration) {
            assert.doesNotMatch(page, /cadastro=1|Criar minha conta|Criar conta e testar|7 dias|Sem cartão/, path);
            assert.match(page, /href="\/login"/, path);
          } else if (publicTrialEnabled) {
            assert.match(page, /href="\/login\?cadastro=1">Criar conta e testar por 7 dias</, path);
            assert.match(page, /dura 7 dias completos\. Sem cartão/, path);
          } else {
            assert.match(page, /href="\/login\?cadastro=1">Criar minha conta</, path);
            assert.doesNotMatch(page, /7 dias|Sem cartão/, path);
          }
        }
      }
    }
  }
});

test('o padrão real do servidor serve os três planos aprovados em 03/11, adicional de 29 e agente próprio com controle', async t => {
  assert.deepEqual(PUBLIC_SITE_PRICING.plans.map(({ name, price, limits }) => [name, price, limits[0], limits[1]]), [
    ['Conecta', 49, '1 número de WhatsApp', 'Até 2 usuários'], ['Equipe', 99, '2 números de WhatsApp', 'Até 5 usuários'],
    ['Operação', 199, '5 números de WhatsApp', 'Até 15 usuários']]);
  assert.equal(PUBLIC_SITE_PRICING.extraWhatsapp, 29);
  const f = await siteFixture(t, { pricing: undefined });
  for (const path of ['/', '/precos']) {
    const response = await f.request(path, { headers: navigate });
    assert.equal(response.status, 200);
    const html = response.body;
    const strips = html.match(/<section class="connections"[\s\S]*?<\/section>/)?.[0];
    assert.ok(strips, `${path}: channel/agent strips are served`);
    assert.deepEqual([...strips.matchAll(/data-brand="([^"]+)"/g)].map(m => m[1]), ['whatsapp', 'telegram', 'instagram', 'facebook', 'hermes', 'claude', 'openai', 'grok']);
    assert.equal((strips.match(/<svg /g) || []).length, 7);
    assert.equal((strips.match(/src="data:image\/png;base64,/g) || []).length, 1);
    assert.match(strips, /Instagram e Messenger dependem de configuração e permissões da Meta/);
    assert.match(strips, /Grok Bot exige integração personalizada via API\/webhook/);
    assert.match(strips, /Codex \/ MCP/);
    assert.doesNotMatch(strips, /src="https?:|<script|<use|href=/i);
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(html));
    for (const value of ['R$ 49<small>', 'R$ 99<small>', 'R$ 199<small>', 'R$ 29<small>/mês por número']) assert.ok(html.includes(value), value);
    for (const plan of PUBLIC_SITE_PRICING.plans) for (const limit of plan.limits) assert.ok(html.includes(`<li>${limit}</li>`), limit);
    assert.equal((html.match(/<article class="plan(?: featured)?"/g) || []).length, 3);
    assert.match(html, /proposta própria.*fora dos três planos/);
    assert.doesNotMatch(html, /R\$ 399|R\$ 799|R\$ 1\.499|R\$ 79/);
    assert.match(html, /Como conecto meu próprio agente\?/);
    assert.match(html, /cliente compatível com MCP, como o Hermes/);
    assert.match(html, /Persona, modelo e memória ficam no ambiente dele/);
    assert.match(html, /Os planos não incluem franquia de IA/);
    assert.match(html, /autonomia exige ativação e autorização explícitas/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalOrigin}${path}">`));
    assert.equal(meta(html, 'property', 'og:url'), `${canonicalOrigin}${path}`);
  }
  const home = (await f.request('/', { headers: navigate })).body;
  assert.match(home, /Planos a partir de R\$ 49 por mês/);
  assert.match(home, /<strong>Conecte seu próprio agente<\/strong> por MCP/);
  assert.match(home, /id="platform-agent-title"/);
  assert.match(home, /id="own-agent-title"/);
  const alias = await f.request('/pricing', { method: 'HEAD', headers: navigate });
  assert.equal(alias.status, 301); assert.equal(alias.headers.location, '/precos'); assert.equal(alias.body, '');
  const head = await f.request('/precos', { method: 'HEAD', headers: navigate });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.ok(Number(head.headers['content-length']) > 1000);
  assert.deepEqual(sitemapPaths((await f.request('/sitemap.xml')).body), ['/', '/precos', '/contato', '/termos', '/privacidade', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy'].map(path => canonicalOrigin + path));
});

test('contato e legal são SSR públicos no host próprio com canonical, HEAD e informação de contato real', async t => {
  const f = await siteFixture(t, { pricing: null });
  for (const path of ['/contato', '/termos', '/privacidade']) {
    const page = await f.request(path, { headers: navigate });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(page.body.includes(`<link rel="canonical" href="${canonicalOrigin}${path}">`));
    assert.equal(meta(page.body, 'property', 'og:url'), canonicalOrigin + path);
    assert.doesNotMatch(page.body, /R\$|\/precos|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/);
    const head = await f.request(path, { method: 'HEAD', headers: navigate });
    assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(page.body));
    assert.equal((await f.request(path, { headers: { ...navigate, Cookie: 'mep_session=sintetico' } })).status, 200);
  }
  const contact = (await f.request('/contato', { headers: navigate })).body;
  assert.match(contact, /href="mailto:jean@je4ndev\.com\?subject=Elozi"/);
});

test('English public HTTP: all ten pages, cookie-independent entry, canonical redirects, HEAD and language isolation', async t => {
  const f = await siteFixture(t, { pricing: undefined, publicTrialEnabled: true });
  const paths = ['/', '/precos', '/contato', '/termos', '/privacidade', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy'];
  for (const path of paths) {
    const en = path.startsWith('/en/');
    const response = await f.request(path, { headers: { ...navigate, 'Accept-Language': en ? 'pt-BR' : 'en-US' } });
    assert.equal(response.status, 200, path);
    assert.ok(response.body.includes(`<html lang="${en ? 'en' : 'pt-BR'}">`));
    assert.ok(response.body.includes(`<link rel="canonical" href="${canonicalOrigin}${path}">`));
    const head = await f.request(path, { method: 'HEAD', headers: navigate });
    assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(response.body));
    if (en) {
      assert.match(response.body, /href="\/login\?lang=en"/);
      assert.match(response.body, /href="\/login\?cadastro=1&lang=en"/);
      assert.match(response.body, /7 full days/);
      const cookie = await f.request(path, { headers: { ...navigate, Cookie: 'mep_session=sintetico' } });
      assert.equal(cookie.status, 200); assert.match(cookie.body, /<html lang="en">/);
    }
  }
  for (const method of ['GET', 'HEAD']) {
    const alias = await f.request('/en', { method, headers: navigate });
    assert.equal(alias.status, 301); assert.equal(alias.headers.location, '/en/');
  }
  assert.match((await f.request('/en/')).body, /<html lang="en">/, 'programmatic EN remains public');
  for (const path of ['/en/missing', '/en/pricing/']) assert.equal((await f.request(path, { headers: navigate })).status, 404);
});

test('preços malformados não sobem: valores inteiros positivos, textos sem marcação e nomes únicos', () => {
  const site = pricing => createPublicSite({ origin: canonicalOrigin, pricing });
  assert.equal(typeof site(null), 'function'); assert.equal(typeof site(PRICING), 'function');
  const plan = PRICING.plans[0];
  for (const [label, pricing] of [['empty', { ...PRICING, plans: [] }], ['cents', { ...PRICING, plans: [{ ...plan, price: 9.9 }] }], ['zero', { ...PRICING, plans: [{ ...plan, price: 0 }] }],
    ['markup', { ...PRICING, plans: [{ ...plan, name: '<b>A</b>' }] }], ['no limits', { ...PRICING, plans: [{ ...plan, limits: [] }] }], ['duplicate', { ...PRICING, plans: [plan, plan] }],
    ['extra', { ...PRICING, extraWhatsapp: -1 }], ['included', { ...PRICING, included: 'tudo' }], ['missing', {}]]) {
    assert.throws(() => site(pricing), /Preços do site público inválidos/, label);
  }
  assert.equal(typeof site({ ...PRICING, extraWhatsapp: null, included: [] }), 'function', 'the add-on and the included list are optional');
  assert.throws(() => createPublicSite({ origin: 'http://elozi.je4ndev.com' }), /Origem pública HTTPS inválida/);
});

test('SEO over HTTP: /favicon.ico points to the site icon on the own host only; robots/sitemap/login carry the crawl policy', async t => {
  const f = await siteFixture(t, { pricing: undefined });
  const favicon = await f.request('/favicon.ico');
  assert.equal(favicon.status, 301); assert.equal(favicon.headers.location, '/icon-192.png');
  const icon = await f.request('/icon-192.png');
  assert.equal(icon.status, 200); assert.equal(icon.headers['content-type'], 'image/png');
  const robots = (await f.request('/robots.txt')).body;
  for (const path of ['/api/', '/billing/', '/verify-email', '/accept-invite', '/reset-password']) assert.ok(robots.includes(`Disallow: ${path}\n`), path);
  assert.doesNotMatch(robots, /Disallow: \/login/);
  const sitemap = (await f.request('/sitemap.xml')).body;
  assert.equal((sitemap.match(/<lastmod>2026-11-03<\/lastmod>/g) || []).length, 10);
  for (const path of ['/login', '/login?lang=en', '/reset-password']) {
    const login = await f.request(path, { headers: navigate });
    assert.equal(login.status, 200, path); assert.match(login.body, /<meta name="robots" content="noindex">/, path);
  }
  f.bindDomain('workspace-acme', 'painel.acme.com.br');
  assert.equal((await f.request('/favicon.ico', { host: 'painel.acme.com.br' })).status, 404, 'white label: no Elozi redirect');
});
