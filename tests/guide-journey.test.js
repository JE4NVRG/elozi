import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideMarkup } from '../public/guide-ui.js';
import { getLocale, setLocale } from '../public/i18n.js';
import { parseHash } from '../public/router.js';
import { hashForView, legacyRouteAllowed, navContext, viewForRoute } from '../public/nav-config.js';

const section = (html, id) => html.split(`id="guide-${id}"`)[1]?.split('</section>')[0] || '';
const admin = { role: 'reseller', kind: 'human' };
const cases = [
  ['owner', { session: { ...admin, platformOwner: true } }, true, true, true],
  ['business', { session: admin, accountKind: 'business' }, true, true, false],
  ['reseller', { session: admin, accountKind: 'reseller' }, true, true, false],
  ['reader', { session: { role: 'operator', permissions: ['inbox.read'] } }, false, true, false],
  ['no-read', { session: { role: 'operator', permissions: ['contacts.read'] } }, false, false, false],
  ['support', { session: { ...admin, platformOwner: true }, supportGrantId: 'DO_NOT_EXPOSE' }, false, true, false],
  ['no-company', { session: admin, hasTenant: false }, false, false, false],
  ['service', { session: { ...admin, kind: 'service', platformOwner: true } }, false, false, false],
];
for (const locale of ['pt-BR', 'en']) for (const host of ['panel.example.invalid', 'brand.customer.invalid']) {
  for (const [name, options, configure, read, owner] of cases) test(`first-value ${locale} ${host} ${name}`, () => {
    const previous = getLocale(), location = Object.getOwnPropertyDescriptor(globalThis, 'location'), fetch = globalThis.fetch;
    let networkCalls = 0;
    try {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(`https://${host}/`) });
      globalThis.fetch = () => { networkCalls++; throw new Error('Help must never grant, send or query'); };
      setLocale(locale, { persist: false, notify: false });
      const html = createGuideMarkup(options), start = section(html, 'start');
      const steps = locale === 'en' ? ['Find the authorized channel and conversation', 'Read before asking for help', 'Ask for focused help or prepare a draft', 'Confirm the result in the right place'] : ['Localize o canal e a conversa autorizados', 'Leia antes de pedir ajuda', 'Peça ajuda pontual ou prepare um rascunho', 'Confirme o resultado no lugar certo'];
      let position = -1;
      for (const step of steps) { const next = start.indexOf(step); assert.ok(next > position, step); position = next; }
      assert.ok(html.indexOf('id="guide-start"') < html.indexOf('id="guide-structure"'));
      assert.equal(start.includes('href="#agents"'), configure);
      assert.equal(start.includes('href="#agents/connect"'), configure);
      assert.equal(start.includes('href="#inbox"'), read);
      assert.equal(start.includes('href="#setup"'), name !== 'service');
      assert.ok(start.includes(locale === 'en' ? 'Set up managed assistant' : 'Configurar assistente gerenciado') === configure);
      assert.ok(start.includes(locale === 'en' ? 'does not start an autonomous agent' : 'não inicia um agente autônomo'));
      assert.ok(start.includes(locale === 'en' ? 'personal use is not support access' : 'uso pessoal não é acesso de suporte'));
      if (!configure && name !== 'no-company') assert.ok(start.includes(locale === 'en' ? 'ask the company administrator' : 'peça ao administrador da empresa'));
      if (name === 'no-company') {
        const hint=locale==='en'?'Select or set up a company':'Selecione ou prepare uma empresa';
        assert.ok(start.includes(hint),'admin without selected company needs selection, not a request to itself');
        assert.equal(start.split(hint).length-1,1,'context hint is not repeated');
      }
      assert.ok(html.includes(locale === 'en' ? 'How to connect my products' : 'Como conectar meus produtos'));
      assert.equal(html.includes('scripts/elozi-agent-mcp.mjs'), owner);
      assert.equal(html.includes('deepseek/deepseek-v4.1-flash'), owner);
      if (!owner) for (const value of ['ELOZI_MCP_CONFIG_PATH', 'product-agent-connections', 'DO_NOT_EXPOSE', 'CommandCode', 'https://os.je4ndev.com']) assert.ok(!html.includes(value), value);
      assert.equal(networkCalls, 0);
      assert.doesNotMatch(start, /<form|<input|data-action=|onclick=|href="https?:/);
      for (const [, href] of start.matchAll(/href="(#[^"]+)"/g)) {
        const route = parseHash(href), view = viewForRoute(route);
        assert.ok(view, href);
        const ctx = navContext({ session: options.session, hasTenant: options.hasTenant !== false, supportGrantId: options.supportGrantId, accountKind: options.accountKind });
        assert.ok(legacyRouteAllowed(view, ctx), href);
        assert.equal(hashForView(view), href);
      }
    } finally {
      globalThis.fetch = fetch;
      if (location) Object.defineProperty(globalThis, 'location', location); else delete globalThis.location;
      setLocale(previous, { persist: false, notify: false });
    }
  });
}

test('owner EN connector is translated and switches back without changing technical identifiers', () => {
  const previous = getLocale();
  try {
    const options = { session: { ...admin, platformOwner: true } };
    for (const locale of ['en', 'pt-BR', 'en']) {
      setLocale(locale, { persist: false, notify: false });
      const html = createGuideMarkup(options);
      for (const token of ['scripts/elozi-agent-mcp.mjs', 'elozi_connections', 'elozi_search_all', 'elozi_read_context', 'ELOZI_MCP_CONFIG_PATH']) assert.ok(html.includes(token), token);
      assert.equal(html.includes('The central connector brings together up to eight existing identities'), locale === 'en');
      assert.equal(html.includes('O conector central reúne até oito identidades existentes'), locale === 'pt-BR');
      assert.equal(html.includes('in the MCP client’s private environment'), locale === 'en');
    }
  } finally { setLocale(previous, { persist: false, notify: false }); }
});

test('first-value guide never reads private account DTOs or claims completion', () => {
  const session = { ...admin };
  for (const key of ['name', 'email', 'token', 'password', 'messages', 'tenantIds', 'scopeRules', 'csrfToken']) Object.defineProperty(session, key, { get() { throw new Error(`Private read: ${key}`); } });
  const html = createGuideMarkup({ session }), start = section(html, 'start');
  assert.ok(start.includes('Conectado não significa primeira utilidade concluída'));
  assert.ok(start.indexOf('Confirme o resultado no lugar certo') < start.indexOf('Preparação administrativa, marca e domínio'));
  assert.doesNotMatch(start, /data-state="done"|ativado|>Ligar</);
});
