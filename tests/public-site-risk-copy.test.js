import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicSite } from '../src/public-site.js';
import { PUBLIC_SITE_INFO } from '../src/public-site-info.js';
import { PUBLIC_SITE_INFO_EN } from '../src/public-site-info-en.js';

const origin = 'https://elozi.je4ndev.com';
const page = (site, path) => site(path, { html: true }).body.toString();

test('FAQ and terms carry the unofficial WhatsApp QR risk in PT-BR and EN', () => {
  const site = createPublicSite({ origin });
  const pt = page(site, '/'), en = page(site, '/en/');
  for (const fact of [/sessão não oficial do WhatsApp Web \(biblioteca Baileys\)/, /não é a API oficial da Meta\/WhatsApp Business/, /O WhatsApp pode bloquear meu número\?/, /não consegue recuperar um número banido/, /sem envio em massa nem spam/]) assert.match(pt, fact);
  for (const fact of [/unofficial WhatsApp Web session \(the Baileys library\)/, /not the official Meta\/WhatsApp Business API/, /Can WhatsApp block my number\?/, /cannot recover a banned number/, /no bulk messaging or spam/]) assert.match(en, fact);
  const termsPt = page(site, '/termos'), termsEn = page(site, '/en/terms');
  assert.match(termsPt, /<section class="info-section" id="whatsapp-qr"><h2>WhatsApp por QR Code: riscos e responsabilidades<\/h2>/);
  assert.match(termsEn, /<section class="info-section" id="whatsapp-qr"><h2>WhatsApp via QR Code: risks and responsibilities<\/h2>/);
  assert.match(termsPt, /a Meta pode limitar, suspender ou banir o número conectado a qualquer momento, a critério dela/);
  assert.match(termsEn, /Meta may limit, suspend, or ban the connected number at any time, at its discretion/);
  const shape = info => info.map(entry => entry.sections.map(([id, , body]) => [id, (body.match(/<p>/g) || []).length, (body.match(/<a /g) || []).length]));
  assert.deepEqual(shape(PUBLIC_SITE_INFO_EN), shape(PUBLIC_SITE_INFO));
});

test('terms describe Stripe card billing, portal cancellation and paid-period access; reseller stays by proposal', () => {
  const site = createPublicSite({ origin });
  const pt = page(site, '/termos'), en = page(site, '/en/terms');
  for (const fact of [/cobrada de forma recorrente no cartão, com pagamento processado pela Stripe/, /cancelar quando quiser no portal de cobrança/, /o acesso continua até o fim do período já pago/, /Revenda, marca própria e condições específicas são combinadas com o responsável comercial, por proposta/, /consumo de IA[^<]*não está incluído/]) assert.match(pt, fact);
  for (const fact of [/billed monthly to your card, with payments processed by Stripe/, /cancel anytime in the billing portal/, /keep access until the end of the period you already paid for/, /Reseller plans, white-label branding, and custom terms are arranged with the sales representative through a proposal/]) assert.match(en, fact);
  assert.doesNotMatch(pt + en, /manualmente com o responsável comercial|arranged manually|Pix|boleto/i);
});

test('checkout:true switches pricing and FAQ to Stripe self-serve wording; default keeps sales wording', () => {
  for (const trial of [false, true]) {
    const on = createPublicSite({ origin, trial, checkout: true }), off = createPublicSite({ origin, trial });
    const pt = page(on, '/precos'), en = page(on, '/en/pricing'), legacy = page(off, '/precos');
    assert.match(pt, /Assinatura mensal no cartão, pela Stripe\. Cancele quando quiser\./);
    assert.match(pt, /Como funcionam a cobrança e o cancelamento\?/);
    assert.match(pt, /o acesso continua até o fim do período já pago/);
    assert.match(pt, /Revenda com a sua marca/); assert.match(pt, /proposta própria com o responsável comercial/);
    assert.match(pt, /R\$\s49\b/); assert.match(pt, /R\$\s199\b/);
    assert.doesNotMatch(pt, /Cadastro não contrata o plano automaticamente|A contratação e os limites da operação são combinados/);
    assert.match(en, /Monthly card subscription through Stripe\. Cancel anytime\./);
    assert.match(en, /How do billing and cancellation work\?/);
    assert.match(en, /keep access until the end of the period you already paid for/);
    assert.doesNotMatch(en, /Assinatura|cartão|Cancele/);
    assert.match(legacy, /Cadastro não contrata o plano automaticamente/);
    assert.doesNotMatch(legacy, /Stripe/);
  }
});
