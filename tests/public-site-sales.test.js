import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicSite, PUBLIC_SITE_PRICING } from '../src/public-site.js';
import { publicSiteIcon } from '../src/public-site-icons.js';
import { createHash } from 'node:crypto';

const origin = 'https://elozi.je4ndev.com';
const site = options => createPublicSite({ origin, ...options });
const page = (route, path = '/') => route(path, { html: true }).body.toString('utf8');

test('fixed icon helper preserves authentic PNG bytes and exposes no dynamic markup or remote assets', () => {
  for (const name of ['whatsapp', 'telegram', 'instagram', 'facebook', 'claude', 'openai', 'grok']) {
    const svg = publicSiteIcon(name);
    assert.match(svg, /^<svg width="36" height="36" aria-hidden="true" focusable="false"/);
    assert.match(svg, /viewBox="[^"]+"/);
    assert.match(svg, /<path /);
    assert.doesNotMatch(svg, /<script|<image|<use|onload=|href=/i);
  }
  const encoded = publicSiteIcon('hermes').match(/base64,([^"]+)/)[1];
  const png = Buffer.from(encoded, 'base64');
  assert.equal(createHash('sha256').update(png).digest('hex'), '5fbced606189c9bfc2925a16f8903333041cabbf1f8699fe9fe9b3e24504048f');
  for (const name of ['__proto__', 'constructor', '<script>', '', undefined]) assert.throws(() => publicSiteIcon(name), /Unknown public-site brand icon/);
});

test('eight authentic channel and agent marks appear in separate near-hero strips on both public pages', () => {
  for (const path of ['/', '/precos']) {
    const html = page(site(), path);
    const strips = html.match(/<section class="connections"[\s\S]*?<\/section>/)?.[0];
    assert.ok(strips, `${path}: visible connections section`);
    assert.equal((strips.match(/data-brand="/g) || []).length, 8);
    for (const brand of ['whatsapp', 'telegram', 'instagram', 'facebook', 'hermes', 'claude', 'openai', 'grok']) assert.match(strips, new RegExp(`data-brand="${brand}"`));
    for (const label of ['Seus canais', 'Seus agentes e modelos', 'QR Code', 'Bot/conta', 'Via Meta', 'Facebook Messenger', 'Cliente MCP', 'Codex / MCP', 'Integração personalizada']) assert.ok(strips.includes(label), label);
    assert.match(strips, /Instagram e Messenger dependem de configuração e permissões da Meta/);
    assert.match(strips, /Grok Bot exige integração personalizada via API\/webhook/);
    assert.match(strips, /<img[^>]+width="36" height="36"[^>]+src="data:image\/png;base64,/);
    assert.doesNotMatch(strips, /src="https?:|<script|<use|conectados hoje|parceria|certificad|em breve|plug.and.play/i);
    if (path === '/') assert.ok(html.indexOf(strips) < html.indexOf('id="como-funciona"'));
    else {
      assert.ok(html.indexOf(strips) > html.indexOf('id="planos"'), 'pricing keeps the offer before the logo gallery');
      assert.ok(html.indexOf(strips) < html.indexOf('class="section faq"'), 'connections remain visible before the FAQ');
    }
  }
});

test('commercial home explains shared ownership with an honestly labelled example', () => {
  const home = page(site());
  assert.ok(/<h1[^>]*>Seu cliente chamou\. Sua equipe sabe quem responde\.<\/h1>/.test(home), 'home must lead with ownership benefit');
  assert.match(home, /Exemplo ilustrativo/);
  assert.match(home, /Responsável/);
  assert.match(home, /Nota interna/);
  assert.match(home, /<figure/);
});

test('pricing shows the buying decision before the connection gallery', () => {
  const html = page(site(), '/precos');
  assert.ok(html.indexOf('class="plans"') >= 0);
  assert.ok(html.indexOf('class="plans"') < html.indexOf('class="connections"'), 'connection marks must not push plan prices below the first buying screen');
});

test('factory preserves HTML-read/session fallthrough and immutable response contract', () => {
  const route = site();
  assert.equal(route('/'), null);
  assert.equal(route('/', { html: false }), null);
  assert.equal(route('/', { signedIn: true, html: true }), null);
  assert.equal(route('/', { signedIn: true }), null);
  const home = route('/', { html: true });
  assert.equal(home.status, 200);
  assert.equal(home.type, 'text/html; charset=utf-8');
  assert.ok(Buffer.isBuffer(home.body));
  assert.ok(Object.isFrozen(home));
  for (const path of ['/login', '/api/health', '/missing', '/precos/']) assert.equal(route(path), null, path);
  assert.equal(route('/precos', { signedIn: true }).status, 200);
  assert.equal(route('/precos').type, 'text/html; charset=utf-8');
  assert.deepEqual(route('/pricing'), { status: 301, location: '/precos' });
  assert.ok(Object.isFrozen(route('/pricing')));
});

test('approved November default is exactly three plans with approved quotas and frozen values', () => {
  assert.deepEqual(PUBLIC_SITE_PRICING.plans.map(({ name, price, limits }) => [name, price, ...limits]), [
    ['Conecta', 49, '1 número de WhatsApp', 'Até 2 usuários'],
    ['Equipe', 99, '2 números de WhatsApp', 'Até 5 usuários'],
    ['Operação', 199, '5 números de WhatsApp', 'Até 15 usuários']
  ]);
  assert.equal(PUBLIC_SITE_PRICING.extraWhatsapp, 29);
  assert.deepEqual(PUBLIC_SITE_PRICING.included, ['Telegram e chat no seu site', 'Filas, transferência, notas internas e histórico', 'IA opcional: consumo e execução à parte']);
  assert.ok(Object.isFrozen(PUBLIC_SITE_PRICING));
  assert.ok(Object.isFrozen(PUBLIC_SITE_PRICING.plans));
  assert.ok(Object.isFrozen(PUBLIC_SITE_PRICING.included));
  for (const plan of PUBLIC_SITE_PRICING.plans) {
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.limits));
  }
  const route = site();
  for (const path of ['/', '/precos']) {
    const html = page(route, path);
    for (const plan of PUBLIC_SITE_PRICING.plans) for (const limit of plan.limits) assert.ok(html.includes(`<li>${limit}</li>`), `${path}: ${limit}`);
    for (const value of ['R$ 49<small>', 'R$ 99<small>', 'R$ 199<small>', 'R$ 29<small>/mês por número']) assert.ok(html.includes(value), `${path}: ${value}`);
    assert.equal((html.match(/<article class="plan(?: featured)?"/g) || []).length, 3);
    assert.equal((html.match(/<article class="reseller"/g) || []).length, 0);
    const reseller = html.match(/<aside class="reseller reseller-inquiry"[\s\S]*?<\/aside>/)[0];
    assert.match(reseller, /Revenda com a sua marca/);
    assert.match(reseller, /proposta própria.*fora dos três planos/);
    assert.doesNotMatch(reseller, /R\$|<a |class="price"/);
    assert.doesNotMatch(html, /R\$ 399|R\$ 799|R\$ 1\.499|R\$ 79/);
    assert.match(html, /Para quem atende outras empresas/);
  }
  assert.match(page(route), /Planos a partir de R\$ 49 por mês/);
  assert.match(page(route, '/precos'), /a partir de R\$ 49:/);
});

const override = {
  plans: [
    { name: 'Plano sintético grande', price: 1234, audience: 'Oferta fictícia para teste.', limits: ['9 números de WhatsApp', 'Até 17 usuários'] },
    { name: 'Plano sintético menor', price: 31, audience: 'Outra oferta fictícia para teste.', limits: ['2 números de WhatsApp'], featured: true }
  ], extraWhatsapp: 9, included: ['Recurso de teste']
};

test('explicit pricing override renders every arbitrary plan and dynamic lowest without mutating defaults', () => {
  const before = JSON.stringify(override);
  const route = site({ pricing: override });
  for (const path of ['/', '/precos']) {
    const html = page(route, path);
    for (const plan of override.plans) {
      assert.ok(html.includes(plan.name));
      for (const limit of plan.limits) assert.ok(html.includes(limit));
    }
    assert.ok(html.includes('R$ 1.234<small>/mês'));
    assert.ok(html.includes('R$ 31'));
    assert.ok(html.includes('R$ 9<small>/mês por número'));
    assert.ok(html.includes('Recurso de teste'));
    assert.equal((html.match(/<article class="plan(?: featured)?"/g) || []).length, 2);
    assert.doesNotMatch(html, /<article class="reseller"|R\$ 49|R\$ 99|R\$ 199|R\$ 29/);
    assert.match(html, /proposta própria.*fora dos planos acima/);
    assert.doesNotMatch(html, /fora dos três planos/, 'override with two plans must not inherit a three-plan count');
  }
  assert.match(page(route), /Planos a partir de R\$ 31 por mês/);
  assert.match(page(route, '/precos'), /a partir de R\$ 31:/);
  assert.equal(JSON.stringify(override), before);
  assert.equal(PUBLIC_SITE_PRICING.plans[0].price, 49);
});

test('explicit reseller override retains its approved values but never masquerades as a customer plan or quick purchase', () => {
  const reseller = { name: 'Revenda', price: 567, audience: 'Revenda sintética autorizada para teste.', limits: ['12 números sintéticos', 'Até 40 usuários'] };
  const pricing = { ...override, plans: [override.plans[0], reseller, override.plans[1]] };
  const before = JSON.stringify(pricing);
  for (const path of ['/', '/precos']) {
    const html = page(site({ pricing }), path);
    assert.equal((html.match(/<article class="plan(?: featured)?"/g) || []).length, 2);
    const section = html.match(/<article class="reseller" aria-labelledby="plan-2">[\s\S]*?<\/article>/)[0];
    for (const value of ['Revenda com a sua marca', 'R$ 567<small>/mês', ...reseller.limits]) assert.ok(section.includes(value));
    assert.match(section, /proposta própria/);
    assert.doesNotMatch(section, /<a |cadastro=1|Comprar|Assinar/);
    assert.ok(html.includes('id="plan-3"'), 'non-reseller override after reseller must remain visible');
  }
  assert.equal(JSON.stringify(pricing), before);
});

test('optional add-on and included list may be absent without invented prices', () => {
  const route = site({ pricing: { ...override, extraWhatsapp: null, included: [] } });
  for (const path of ['/', '/precos']) {
    const html = page(route, path);
    assert.doesNotMatch(html, /Em todos os planos|\/mês por número|R\$ 79/);
    assert.match(html, /Condições de contratação/);
  }
});

test('pricing null removes every price, pricing route, link and sitemap entry', () => {
  const route = site({ pricing: null });
  const home = page(route);
  assert.doesNotMatch(home, /R\$|\/precos|href="#planos"|id="planos"/);
  assert.equal(route('/precos'), null);
  assert.equal(route('/pricing'), null);
  assert.deepEqual([...page(route, '/sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]), ['/', '/contato', '/termos', '/privacidade', '/en/', '/en/contact', '/en/terms', '/en/privacy'].map(path => origin + path));
  assert.match(home, /href="\/login\?cadastro=1"/);
});

test('hero has one primary next step and one secondary plans action, not a fake checkout', () => {
  const home = page(site());
  const hero = home.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
  assert.equal((hero.match(/class="button primary"/g) || []).length, 1);
  assert.equal((hero.match(/<a /g) || []).length, 2);
  assert.match(hero, /href="\/login\?cadastro=1">Criar minha conta</);
  assert.match(hero, /href="\/precos">Ver planos</);
  assert.doesNotMatch(hero, /href="\/login">Entrar/);
  const pricing = page(site(), '/precos');
  assert.match(pricing, /cadastro não é uma contratação automática/);
  assert.doesNotMatch(pricing, /href="[^\"]*(?:checkout|payment)|>Assinar agora<|>Comprar agora</i);
  const primaryActions = [...pricing.matchAll(/<a class="button primary" href="([^\"]+)"/g)];
  assert.equal(primaryActions.length, 4, 'three plan entries and the final account action');
  for (const [, href] of primaryActions) assert.equal(href, '/login?cadastro=1');
  const secondaryActions = [...pricing.matchAll(/<a class="button" href="([^\"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => ({ href, label }));
  assert.deepEqual(secondaryActions, [{ href: '/contato', label: 'Falar com o comercial' }]);
});

for (const pricing of [undefined, null, override]) {
  for (const registration of [true, false]) {
    for (const trial of [true, false]) {
      test(`signup/trial visibility is scoped: registration=${registration}, trial=${trial}, pricing=${pricing === null ? 'null' : pricing === undefined ? 'default' : 'override'}`, () => {
        const route = site({ registration, trial, pricing });
        for (const path of ['/', ...(pricing === null ? [] : ['/precos']), '/contato', '/termos', '/privacidade']) {
          const html = page(route, path);
          if (registration) {
            assert.match(html, /href="\/login\?cadastro=1"/);
            if (trial) {
              assert.match(html, /Criar conta e testar por 7 dias/);
              assert.match(html, /dura 7 dias completos\. Sem cartão ou contratação automática; o cadastro pede CPF ou CNPJ/);
            } else {
              assert.match(html, /Criar minha conta/);
              assert.doesNotMatch(html, /7 dias|Sem cartão|teste gr[áa]tis/i);
            }
          } else {
            assert.doesNotMatch(html, /cadastro=1|Criar minha conta|Criar conta e testar|7 dias|Sem cartão/);
            assert.match(html, /href="\/login"/);
          }
        }
      });
    }
  }
}

test('own agent is a visible hero benefit and product offers two distinct controlled paths even without pricing', () => {
  for (const pricing of [undefined, null, override]) {
    const home = page(site({ pricing }));
    const hero = home.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
    assert.match(hero, /<strong>Conecte seu próprio agente<\/strong> por MCP/);
    assert.match(hero, /IA da plataforma/);
    assert.match(hero, /pessoas e agentes.*permissões/);
    const product = home.match(/<section class="ai-band"[\s\S]*?<\/section>/)[0];
    assert.equal((product.match(/<article /g) || []).length, 2);
    for (const claim of ['IA da plataforma, do seu jeito', 'Seu próprio agente, via MCP', 'clientes compatíveis com MCP, como o Hermes', 'consultar conversas autorizadas', 'rascunho para revisão', 'pedir apoio à equipe', 'Persona, modelo e memória continuam no ambiente do seu agente', 'credencial é revogável', 'ler contexto não concede permissão de enviar', 'Histórico, autoria e recibos', 'uma pessoa pode assumir', 'Não vêm ligadas para toda conta ou teste', 'mensalidade não inclui franquia de IA']) assert.ok(product.includes(claim), claim);
    assert.doesNotMatch(product, /Claude|Codex|instalado|24\s*horas|imediat[oa]/);
  }
});

test('native FAQ explains mechanism, costs and optional AI without unsupported sales promises', () => {
  for (const path of ['/', '/precos']) {
    const html = page(site(), path);
    const details = [...html.matchAll(/<details><summary>(.*?)<\/summary><p>(.*?)<\/p><\/details>/g)];
    assert.equal(details.length, 10);
    for (const [question, answer] of details.map(m => [m[1], m[2]])) {
      assert.ok(question.length > 10);
      assert.ok(answer.length > 80);
    }
    assert.match(html, /QR Code/);
    assert.match(html, /Histórico|histórico/);
    assert.match(html, /Notas internas|notas internas/);
    assert.match(html, /permissões/);
    assert.match(html, /BYOK/);
    assert.match(html, /à parte/);
    assert.match(html, /Como conecto meu próprio agente\?/);
    assert.match(html, /A mensalidade inclui consumo de IA\?/);
    assert.match(html, /Os planos não incluem franquia de IA/);
    assert.match(html, /valide a identidade e uma leitura autorizada/);
    assert.match(html, /Conectar um agente não instala um cliente/);
    assert.match(html, /autonomia exige ativação e autorização explícitas/);
    assert.match(html, /não é um checkout/);
    assert.doesNotMatch(html, /IA (?:incluída|gratuita|ilimitada)|zero banimentos|sem risco de banimento|respostas? autônomas? imediatas?|migração automática garantida|coexistência automática|clientes satisfeitos|empresas confiam|e-mail na mesma caixa|teste grátis|API oficial da Meta incluída/i);
    assert.doesNotMatch(html, /<button|role="button"|onclick=|aria-expanded=/, 'native details and honest anchor actions need no UI runtime');
  }
});

test('indexing resources remain canonical, local and static; footer credits the creator', () => {
  const route = site();
  for (const path of ['/', '/precos']) {
    const html = page(route, path);
    assert.match(html, /<html lang="pt-BR">/);
    assert.ok(html.includes(`<link rel="canonical" href="${origin}${path}">`));
    assert.ok(html.includes(`<meta property="og:url" content="${origin}${path}">`));
    assert.match(html, /<meta name="robots" content="index,follow">/);
    assert.match(html, /Criado por <a href="https:\/\/je4ndev\.com\/">Je4nDev<\/a>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:|@import|url\(['"]?https?:|<iframe|<form/);
    assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script src="/site.js">']);
    assert.match(html, /src:url\('\/fonts\/manrope-latin-wght-normal\.woff2'\)/);
  }
  assert.equal(route('/robots.txt').type, 'text/plain; charset=utf-8');
  assert.equal(page(route, '/robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /billing/\nDisallow: /verify-email\nDisallow: /accept-invite\nDisallow: /reset-password\nSitemap: ${origin}/sitemap.xml\n`);
  assert.equal(route('/sitemap.xml').type, 'application/xml; charset=utf-8');
  assert.deepEqual([...page(route, '/sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]), ['/', '/precos', '/contato', '/termos', '/privacidade', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy'].map(path => origin + path));
});

test('semantic anchors, unique ids and CSS safeguards are present (not a browser geometry claim)', () => {
  for (const path of ['/', '/precos']) {
    const html = page(site(), path);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'unique document IDs');
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(id), `anchor ${id}`);
    for (const [, id] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.includes(id), `label ${id}`);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /class="skip" href="#conteudo"/);
    assert.match(html, /<main id="conteudo">/);
    assert.match(html, /:focus-visible/);
    assert.match(html, /min-height:44px/);
    assert.match(html, /prefers-reduced-motion:reduce/);
    assert.match(html, /@media\(max-width:760px\)/);
    assert.match(html, /@media\(max-width:480px\)/);
    assert.match(html, /grid-template-columns:minmax\(0,1fr\)/);
    assert.match(html, /overflow-wrap:anywhere/);
    assert.doesNotMatch(html, /100vw|gradient\(/);
  }
});

test('origin protocol and exact-origin validation reject unsafe or noncanonical origins', () => {
  for (const value of ['http://elozi.je4ndev.com', `${origin}/`, `${origin}/path`, `${origin}?q=x`, `${origin}#fragment`, 'https://user:pass@elozi.je4ndev.com', 'https://ELOZI.je4ndev.com', 'javascript:alert(1)', 'not a url']) {
    assert.throws(() => createPublicSite({ origin: value }), undefined, value);
  }
  assert.equal(typeof createPublicSite({ origin: 'https://example.test:444' }), 'function');
});

test('pricing validation fails closed for unsafe text, invalid amounts, shapes and duplicates', () => {
  const plan = override.plans[0];
  const invalid = [undefined, {}, { ...override, plans: [] }, { ...override, plans: [null] },
    ...[0, -1, 1.5, NaN, Infinity, 1000000, '199'].map(price => ({ ...override, plans: [{ ...plan, price }] })),
    ...['<script>x</script>', 'A&B', 'A"B', 'A\nB', '', ' A', 'A ', 'a'.repeat(161)].map(name => ({ ...override, plans: [{ ...plan, name }] })),
    { ...override, plans: [plan, plan] }, { ...override, plans: [{ ...plan, limits: [] }] },
    { ...override, plans: [{ ...plan, limits: ['<b>x</b>'] }] }, { ...override, plans: [{ ...plan, audience: 'A&B' }] },
    { ...override, plans: [{ ...plan, featured: 'true' }] }, { ...override, extraWhatsapp: 0 },
    { ...override, extraWhatsapp: -1 }, { ...override, included: 'everything' }, { ...override, included: ['A&B'] }];
  // undefined intentionally selects the default through the factory default parameter, unlike malformed objects.
  for (const pricing of invalid.filter(value => value !== undefined)) assert.throws(() => site({ pricing }), /Preços do site público inválidos/);
  assert.equal(typeof site({ pricing: undefined }), 'function');
  assert.equal(typeof site({ pricing: null }), 'function');
});
