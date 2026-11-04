import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicSite } from '../src/public-site.js';

const render = () => createPublicSite({ origin: 'https://elozi.je4ndev.com' });
const html = path => render()(path, { html: true })?.body.toString('utf8');

test('header explains the product navigation and exposes a real mobile disclosure', () => {
  const home = html('/');
  const header = home.match(/<header[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  for (const label of ['Recursos', 'Canais', 'Agentes', 'Planos', 'Entrar']) assert.ok(header.includes(label), label);
  assert.match(header, /<details[^>]+(?:data-site-menu|id="site-menu")/);
  assert.match(header, /<summary[^>]*>[\s\S]*?Menu/);
});

test('footer gives product, help, legal and attribution information, not just login links', () => {
  for (const path of ['/', '/precos']) {
    const footer = html(path).match(/<footer[\s\S]*?<\/footer>/)?.[0];
    assert.ok(footer);
    for (const label of ['Produto', 'Ajuda', 'Legal', 'Elozi', 'Criado por', 'Je4nDev']) assert.ok(footer.includes(label), `${path}: ${label}`);
    for (const href of ['/contato', '/termos', '/privacidade', 'https://je4ndev.com/']) assert.ok(footer.includes(`href="${href}"`), href);
    assert.doesNotMatch(footer, /href="#"|href="javascript:/);
  }
});

test('footer destinations are actual branded public pages with useful information', () => {
  for (const [path, word] of [['/contato', 'contato'], ['/termos', 'uso'], ['/privacidade', 'dados']]) {
    const page = render()(path, { html: true });
    assert.equal(page?.status, 200, path);
    assert.equal(page?.type, 'text/html; charset=utf-8');
    const text = page.body.toString('utf8');
    assert.match(text, /<h1/);
    assert.ok(text.toLowerCase().includes(word));
    assert.ok(text.includes(`href="https://elozi.je4ndev.com${path}"`));
    assert.doesNotMatch(text, /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/);
  }
});

test('terms and privacy identify real service boundaries without inventing a checkout or SLA', () => {
  const terms = html('/termos');
  const privacy = html('/privacidade');
  assert.ok(terms && privacy);
  assert.match(terms, /contrata|contrato/i);
  assert.match(terms, /terceiros|provedores/i);
  assert.match(privacy, /permiss|acesso/i);
  assert.match(privacy, /contato|direitos|solicita/i);
  assert.doesNotMatch(terms + privacy, /99[,.]9%|sem risco de banimento|segurança absoluta|criptografia ponta a ponta em todos/);
});
