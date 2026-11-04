import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setLocale } from '../public/i18n.js';
import { createSubscriptionUI, subscriptionTotalCents, readSubscription, SUBSCRIPTION_PLANS, EXTRA_NUMBER_CENTS, SUBSCRIPTION_ERROR_CODES } from '../public/subscription-ui.js';
import { subscriptionTranslations } from '../public/locales-subscription.js';
import { createDocument } from './helpers/mini-dom.js';
import { PANEL_ASSETS } from '../src/panel-assets.js';

const WS = 'biz-qa';
const dto = (over = {}) => ({ enabled: true, workspaceId: WS, state: 'none', plan: null, extraNumbers: 0, currentPeriodEnd: null, cancelAtPeriodEnd: false, trial: null, canManage: true, ...over });
const tick = () => new Promise(resolve => setImmediate(resolve));

// Fake fetch-like transport with the contract shapes; `responses` is a queue of subscription DTOs or errors.
function fixture(t, { responses = [dto()], checkout, portal, change, eligible = true, now } = {}) {
  const calls = [], assigned = [], ctx = { workspaceId: WS, eligible, authorityKey: 'qa' };
  let doc = createDocument(''), renders = 0;
  const queue = [...responses];
  const request = async (path, init = {}) => {
    calls.push({ path, init });
    if (path.startsWith('/api/billing/subscription?')) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(path) : structuredClone(next);
    }
    if (path === '/api/billing/checkout') { if (checkout instanceof Error) throw checkout; return checkout || { url: 'https://checkout.stripe.com/c/pay/cs_test_qa' }; }
    if (path === '/api/billing/portal') { if (portal instanceof Error) throw portal; return portal || { url: 'https://billing.stripe.com/p/session/qa' }; }
    if (path === '/api/billing/change') { if (change instanceof Error) throw change; const body = JSON.parse(init.body); return typeof change === 'function' ? change(body) : change || dto({ state: 'active', plan: body.plan, extraNumbers: body.extraNumbers, currentPeriodEnd: '2026-12-03T12:00:00.000Z' }); }
    throw Object.assign(new Error('unexpected ' + path), { status: 500 });
  };
  const ui = createSubscriptionUI({ getContext: () => ctx, request, onRender: () => { renders++; doc = createDocument(ui.markup()); }, assign: url => assigned.push(url), wait: async () => {}, pollAttempts: 3, getDocument: () => doc, ...(now ? { now } : {}) });
  t.after(() => setLocale('pt-BR', { persist: false, notify: false }));
  const view = () => { doc = createDocument(ui.markup()); return doc; };
  const posts = path => calls.filter(call => call.path === path).map(call => JSON.parse(call.init.body));
  return { ui, calls, assigned, ctx, view, posts, renders: () => renders };
}
const httpError = (status, message = 'Falha') => Object.assign(new Error(message), { status });

test('catálogo do contrato: preços, limites e total com números adicionais', () => {
  assert.deepEqual(SUBSCRIPTION_PLANS.map(plan => [plan.key, plan.cents, plan.numbers, plan.users]), [['conecta', 4900, 1, 2], ['equipe', 9900, 2, 5], ['operacao', 19900, 5, 15]]);
  assert.equal(EXTRA_NUMBER_CENTS, 2900);
  assert.equal(subscriptionTotalCents('equipe', 3), 9900 + 3 * 2900);
  assert.equal(subscriptionTotalCents('operacao', 21), null);
  assert.equal(subscriptionTotalCents('revenda', 0), null);
  assert.throws(() => readSubscription(dto({ workspaceId: 'outro' }), WS), /não confirmou/);
  assert.throws(() => readSubscription(dto({ state: 'paid' }), WS), /não confirmou/);
  assert.throws(() => readSubscription(dto({ trial: { expiresAt: 'x', daysRemaining: 2 } }), WS), /não confirmou/);
});

test('sem assinatura: escolhe plano, ajusta adicionais e redireciona ao Checkout com requestId por clique', async t => {
  const f = fixture(t);
  assert.ok(await f.ui.load());
  let doc = f.view();
  assert.equal(f.calls[0].path, `/api/billing/subscription?workspaceId=${WS}`);
  assert.equal(doc.querySelectorAll('[data-subscription-card]').length, 3);
  assert.match(doc.querySelector('[data-subscription-card="conecta"]').textContent, /R\$\s?49,00 por mês[\s\S]*1 número de WhatsApp[\s\S]*Até 2 usuários/);
  assert.match(doc.querySelector('[data-subscription-card="operacao"]').textContent, /Operação[\s\S]*R\$\s?199,00[\s\S]*5 números de WhatsApp[\s\S]*Até 15 usuários/);
  assert.match(doc.querySelector('[data-subscription-terms]').textContent, /cartão, processado pela Stripe[\s\S]*mensal recorrente[\s\S]*fim do período pago[\s\S]*IA e modelos é cobrado à parte/);
  assert.equal(doc.querySelector('[data-subscription-plan="equipe"]').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector('[data-action="subscription:extra-dec"]').disabled, true);
  await f.ui.act('subscription:plan', 'operacao');
  await f.ui.act('subscription:extra-inc'); await f.ui.act('subscription:extra-inc');
  doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-plan="operacao"]').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector('[data-subscription-total]').getAttribute('data-subscription-total'), String(19900 + 2 * 2900));
  assert.match(doc.querySelector('[data-subscription-total]').textContent, /Total mensal: R\$\s?257,00[\s\S]*2 × R\$\s?29,00[\s\S]*7 números de WhatsApp no total/);
  assert.equal(doc.querySelector('[data-action="subscription:extra-dec"]').getAttribute('aria-label'), 'Remover um número adicional');
  await f.ui.act('subscription:checkout');
  assert.deepEqual(f.assigned, ['https://checkout.stripe.com/c/pay/cs_test_qa']);
  const [first] = f.posts('/api/billing/checkout');
  assert.deepEqual({ ...first, requestId: 'x' }, { workspaceId: WS, plan: 'operacao', extraNumbers: 2, requestId: 'x', locale: 'pt-BR' });
  assert.match(first.requestId, /^[A-Za-z0-9_-]{8,120}$/);
  // Busy while leaving for Stripe: a second click does not post again; a new attempt gets a new requestId.
  await f.ui.act('subscription:checkout');
  assert.equal(f.posts('/api/billing/checkout').length, 1);
  assert.equal(f.view().querySelector('[data-subscription-root]').textContent.includes('Assinatura ativa'), false);
});

test('adicionais respeitam 0..20 e somente um checkout por clique válido', async t => {
  const f = fixture(t); await f.ui.load();
  await f.ui.act('subscription:extra-dec'); assert.equal(f.ui.selection.extra, 0);
  for (let i = 0; i < 25; i++) await f.ui.act('subscription:extra-inc');
  assert.equal(f.ui.selection.extra, 20);
  assert.equal(f.view().querySelector('[data-action="subscription:extra-inc"]').disabled, true);
  await f.ui.act('subscription:plan', 'revenda'); assert.equal(f.ui.selection.plan, 'equipe');
});

test('cada tentativa de checkout gera requestId novo e 409 orienta ao portal sem redirecionar', async t => {
  const f = fixture(t, { checkout: httpError(409, 'Já existe assinatura') }); await f.ui.load();
  await f.ui.act('subscription:checkout'); await f.ui.act('subscription:checkout'); await tick();
  const bodies = f.posts('/api/billing/checkout');
  assert.equal(bodies.length, 2); assert.notEqual(bodies[0].requestId, bodies[1].requestId);
  assert.deepEqual(f.assigned, []);
  assert.match(f.view().querySelector('[data-subscription-error]').textContent, /já tem uma assinatura[\s\S]*Gerenciar assinatura/);
  assert.equal(f.view().querySelector('[data-subscription-error]').getAttribute('role'), 'alert');
});

test('URL de redirecionamento não-https é recusada', async t => {
  const f = fixture(t, { checkout: { url: 'javascript:alert(1)' } }); await f.ui.load();
  await f.ui.act('subscription:checkout');
  assert.deepEqual(f.assigned, []);
  assert.match(f.view().querySelector('[data-subscription-error]').textContent, /não confirmou o endereço de pagamento/);
});

test('enabled:false mostra "em breve" com mailto ao comercial, nenhum plano selecionado e nenhum botão de compra (PT e EN)', async t => {
  const f = fixture(t, { responses: [dto({ enabled: false })] }); await f.ui.load();
  let doc = f.view();
  assert.match(doc.querySelector('[data-subscription-disabled]').textContent, /Assinatura online em breve[\s\S]*escreva para jean@je4ndev\.com/);
  assert.equal(doc.querySelector('[data-subscription-contact]').getAttribute('href'), 'mailto:jean@je4ndev.com?subject=Elozi%20-%20contratar%20plano');
  // No real subscription: no plan is shown as selected/current; each card opens a mailto naming the plan.
  assert.equal(doc.querySelectorAll('[data-state="selected"],[aria-current]').length, 0);
  assert.doesNotMatch(doc.querySelector('[data-subscription-root]').textContent, /Selecionado/);
  assert.equal(doc.querySelector('[data-subscription-contact-plan="equipe"]').getAttribute('href'), 'mailto:jean@je4ndev.com?subject=Elozi%20-%20contratar%20plano%20Equipe');
  assert.equal(doc.querySelector('[data-subscription-checkout]'), null);
  assert.equal(doc.querySelectorAll('[data-subscription-card]').length, 3);
  await f.ui.act('subscription:checkout'); assert.equal(f.posts('/api/billing/checkout').length, 0);
  setLocale('en', { persist: false, notify: false });
  doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-contact]').getAttribute('href'), 'mailto:jean@je4ndev.com?subject=Elozi%20-%20contratar%20plano');
  assert.match(doc.querySelector('[data-subscription-disabled]').textContent, /Online subscription coming soon[\s\S]*write to jean@je4ndev\.com/);
  assert.match(doc.querySelector('[data-subscription-contact-plan="operacao"]').getAttribute('href'), /contratar%20plano%20Operations$/);
  assert.match(doc.querySelector('[data-subscription-card="operacao"]').textContent, /Operations[\s\S]*R\$\s?199\.00 per month[\s\S]*5 WhatsApp numbers[\s\S]*Up to 15 users/);
  assert.match(doc.querySelector('[data-subscription-terms]').textContent, /AI and model usage is billed separately/);
});

test('retorno de sucesso consulta a API até ela confirmar active; nunca afirma antes', async t => {
  const seen = [];
  const f = fixture(t, { responses: [dto(), dto({ state: 'incomplete' }), dto({ state: 'active', plan: 'equipe', extraNumbers: 1, currentPeriodEnd: '2026-12-03T12:00:00.000Z' })] });
  const pending = f.ui.handleReturn('success', WS);
  seen.push(f.view().querySelector('[data-subscription-return]').getAttribute('data-subscription-return'));
  assert.match(f.view().body.textContent, /Retorno do checkout, confirmando assinatura…/);
  assert.equal(f.view().body.textContent.includes('Pagamento recebido'), false);
  assert.equal(f.view().body.textContent.includes('Assinatura ativa'), false);
  await pending;
  const doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-return]').getAttribute('data-subscription-return'), 'confirmed');
  assert.equal(doc.querySelector('[data-subscription-current]').getAttribute('data-subscription-current'), 'active');
  assert.match(doc.querySelector('[data-subscription-current]').textContent, /Plano Equipe[\s\S]*3 números de WhatsApp · 5 usuários[\s\S]*1 números adicionais[\s\S]*R\$\s?128,00 por mês[\s\S]*Próxima renovação em/);
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/billing/subscription')).length, 3);
  assert.deepEqual(seen, ['confirming']);
});

test('retorno de sucesso sem confirmação termina em aviso neutro, sem prometer ativação', async t => {
  const f = fixture(t, { responses: [dto({ state: 'incomplete' })] });
  await f.ui.handleReturn('success', WS);
  const doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-return]').getAttribute('data-subscription-return'), 'pending');
  assert.match(doc.body.textContent, /Ainda confirmando a assinatura[\s\S]*não é preciso pagar de novo/);
  assert.equal(doc.querySelector('[data-subscription-current]'), null);
  assert.equal(f.calls.length, 3);
});

test('retorno de cancelamento é neutro; retorno de outro workspace é ignorado', async t => {
  const f = fixture(t);
  assert.equal(await f.ui.handleReturn('success', 'outro-ws'), false);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.ui.handleReturn('cancel', WS), true); await tick();
  const doc = f.view();
  assert.match(doc.querySelector('[data-subscription-return]').textContent, /Assinatura não concluída[\s\S]*Nenhuma cobrança foi feita/);
  await f.ui.act('subscription:dismiss-return');
  assert.equal(f.view().querySelector('[data-subscription-return]'), null);
});

test('ativa: renovação, cancelamento agendado e portal com requestId', async t => {
  const f = fixture(t, { responses: [dto({ state: 'active', plan: 'conecta', currentPeriodEnd: '2026-12-10T12:00:00.000Z', cancelAtPeriodEnd: true })] });
  await f.ui.load();
  const doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-card]'), null);
  assert.match(doc.querySelector('[data-subscription-renewal]').textContent, /Cancelamento agendado: acesso até .*2026/);
  await f.ui.act('subscription:portal');
  const [body] = f.posts('/api/billing/portal');
  assert.deepEqual(Object.keys(body).sort(), ['locale', 'requestId', 'workspaceId']);
  assert.equal(body.workspaceId, WS); assert.match(body.requestId, /^[A-Za-z0-9_-]{8,120}$/);
  assert.deepEqual(f.assigned, ['https://billing.stripe.com/p/session/qa']);
});

test('teste com dias restantes oferece assinar; past_due alerta e leva ao portal', async t => {
  const f = fixture(t, { responses: [dto({ state: 'trialing', trial: { expiresAt: '2026-11-10T12:00:00.000Z', daysRemaining: 7 } })] });
  await f.ui.load(); let doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-trial]').getAttribute('data-subscription-trial'), '7');
  assert.match(doc.querySelector('[data-subscription-trial]').textContent, /7 dias restantes[\s\S]*Assinar agora/);
  assert.equal(doc.querySelectorAll('[data-subscription-card]').length, 3);
  const g = fixture(t, { responses: [dto({ state: 'past_due', plan: 'equipe', currentPeriodEnd: '2026-11-20T12:00:00.000Z' })] });
  await g.ui.load(); doc = g.view();
  assert.match(doc.querySelector('[data-subscription-alert="past_due"]').textContent, /Pagamento pendente[\s\S]*Atualize o cartão/);
  assert.equal(doc.querySelector('[data-subscription-alert="past_due"] [data-action="subscription:portal"]') !== null, true);
  assert.equal(doc.querySelector('[data-subscription-checkout]'), null);
});

test('sem permissão de gestão não oferece compra nem portal; conta não elegível não consulta', async t => {
  const f = fixture(t, { responses: [dto({ canManage: false })] }); await f.ui.load();
  const doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-checkout]'), null);
  assert.match(doc.body.textContent, /Somente o administrador da conta pode assinar/);
  const g = fixture(t, { eligible: false });
  assert.equal(g.ui.markup(), ''); assert.equal(await g.ui.load(), false); await g.ui.act('subscription:checkout');
  assert.equal(g.calls.length, 0);
});

test('403 e resposta de outro acesso não vazam para a tela atual', async t => {
  const f = fixture(t, { responses: [httpError(403, 'Proibido')] }); await f.ui.load();
  assert.match(f.view().body.textContent, /exclusiva do administrador de uma conta de empresa/);
  let release;
  const g = fixture(t, { responses: [() => new Promise(resolve => { release = resolve; })] });
  const loading = g.ui.load(); g.ctx.workspaceId = 'outro-ws';
  release(dto()); assert.equal(await loading, false);
  g.ctx.workspaceId = WS; assert.equal(g.view().querySelector('[data-subscription-card]'), null);
});

test('carrega sozinho ao montar e o catálogo EN cobre a cópia; arquivos registrados no allowlist', async t => {
  const f = fixture(t);
  assert.match(f.ui.markup(), /Carregando a assinatura…/);
  await tick(); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.view().querySelectorAll('[data-subscription-card]').length, 3);
  const source = await readFile(new URL('../public/subscription-ui.js', import.meta.url), 'utf8');
  for (const [, key] of source.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) assert.ok(Object.hasOwn(subscriptionTranslations, key), key);
  assert.ok(PANEL_ASSETS.includes('subscription-ui.js')); assert.ok(PANEL_ASSETS.includes('locales-subscription.js'));
});

// ---------- D2 / D3 / D5 (contract addendum 2) ----------
const live = (over = {}) => dto({ state: 'active', plan: 'equipe', extraNumbers: 1, currentPeriodEnd: '2026-12-03T12:00:00.000Z', ...over });
const codeError = (status, code, message = 'Mensagem do servidor em PT') => Object.assign(new Error(message), { status, code });

test('assinatura ativa: Alterar plano ou números abre cards + stepper com a seleção atual e confirmação desabilitada', async t => {
  const f = fixture(t, { responses: [live()] }); await f.ui.load();
  let doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-change]'), null);
  assert.match(doc.querySelector('[data-subscription-current]').textContent, /Alterar plano ou números[\s\S]*Gerenciar assinatura/);
  assert.equal(doc.querySelector('[data-subscription-current]').textContent.includes('troca de plano'), false);
  await f.ui.act('subscription:change-open');
  doc = f.view();
  assert.ok(doc.querySelector('[data-subscription-change]'));
  assert.equal(doc.querySelector('[data-subscription-change-open]'), null);
  assert.equal(doc.querySelectorAll('[data-subscription-change] [data-subscription-card]').length, 3);
  assert.equal(doc.querySelector('[data-subscription-plan="equipe"]').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector('[data-subscription-extra-count]').getAttribute('data-subscription-extra-count'), '1');
  assert.equal(doc.querySelector('[data-subscription-change-confirm]').disabled, true);
  assert.match(doc.querySelector('[data-subscription-delta]').textContent, /Nenhuma alteração selecionada/);
  assert.match(doc.querySelector('[data-subscription-proration]').textContent, /A diferença é calculada proporcionalmente na próxima fatura/);
  assert.equal(doc.querySelector('[data-subscription-checkout]'), null);
  assert.deepEqual(f.ui.selection, { plan: 'equipe', extra: 1 });
  // Same order is never posted, even if the action is forced.
  await f.ui.act('subscription:change');
  assert.equal(f.posts('/api/billing/change').length, 0);
  assert.match(f.view().querySelector('[data-subscription-error]').textContent, /Esse já é o seu plano atual/);
  await f.ui.act('subscription:change-close');
  assert.equal(f.view().querySelector('[data-subscription-change]'), null);
});

test('upgrade: novo total vs atual, POST /api/billing/change e re-render pela resposta', async t => {
  const f = fixture(t, { responses: [live()] }); await f.ui.load();
  await f.ui.act('subscription:change-open');
  await f.ui.act('subscription:plan', 'operacao'); await f.ui.act('subscription:extra-inc');
  let doc = f.view();
  const total = doc.querySelector('[data-subscription-total]');
  assert.equal(total.getAttribute('data-subscription-total'), String(19900 + 2 * 2900));
  assert.equal(total.getAttribute('data-subscription-current-total'), String(9900 + 2900));
  assert.match(total.textContent, /Novo total mensal: R\$\s?257,00[\s\S]*atual: R\$\s?128,00/);
  assert.match(doc.querySelector('[data-subscription-delta]').textContent, /Aumento de R\$\s?129,00 por mês/);
  assert.equal(doc.querySelector('[data-subscription-change-confirm]').disabled, false);
  await f.ui.act('subscription:change');
  const [body] = f.posts('/api/billing/change');
  assert.deepEqual({ ...body, requestId: 'x' }, { workspaceId: WS, plan: 'operacao', extraNumbers: 2, requestId: 'x', locale: 'pt-BR' });
  assert.match(body.requestId, /^[A-Za-z0-9_-]{8,120}$/);
  assert.deepEqual(f.assigned, []);
  doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-change]'), null);
  assert.equal(doc.querySelector('[data-subscription-return]').getAttribute('data-subscription-return'), 'changed');
  assert.match(doc.querySelector('[data-subscription-return]').textContent, /Assinatura alterada[\s\S]*proporcionalmente/);
  assert.match(doc.querySelector('[data-subscription-current]').textContent, /Plano Operação[\s\S]*7 números de WhatsApp · 15 usuários[\s\S]*R\$\s?257,00 por mês/);
  // No extra GET was needed: the response itself is the new state.
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/billing/subscription')).length, 1);
});

test('downgrade: redução, aviso de que nada é desconectado e EN equivalente', async t => {
  const f = fixture(t, { responses: [live({ plan: 'operacao', extraNumbers: 2 })] }); await f.ui.load();
  await f.ui.act('subscription:change-open');
  await f.ui.act('subscription:plan', 'conecta'); await f.ui.act('subscription:extra-dec'); await f.ui.act('subscription:extra-dec');
  let doc = f.view();
  assert.match(doc.querySelector('[data-subscription-delta]').textContent, /Redução de R\$\s?208,00 por mês/);
  assert.match(doc.querySelector('[data-subscription-downgrade]').textContent, /nada é desconectado/);
  setLocale('en', { persist: false, notify: false });
  doc = f.view();
  assert.match(doc.querySelector('[data-subscription-change]').textContent, /Change plan or numbers[\s\S]*New monthly total: R\$\s?49\.00[\s\S]*current: R\$\s?257\.00[\s\S]*Decrease of R\$\s?208\.00 per month[\s\S]*nothing is disconnected[\s\S]*prorated on your next invoice[\s\S]*Confirm change/);
  await f.ui.act('subscription:change');
  assert.deepEqual(f.posts('/api/billing/change').map(body => [body.plan, body.extraNumbers, body.locale]), [['conecta', 0, 'en']]);
  assert.match(f.view().querySelector('[data-subscription-return]').textContent, /Subscription changed/);
});

test('cada código de erro tem mensagem própria em PT e EN, com role=alert', async t => {
  const expected = {
    subscription_exists: [/já tem uma assinatura[\s\S]*Alterar plano ou números/, /already has a subscription[\s\S]*Change plan or numbers/],
    manual_contract: [/contrato comercial[\s\S]*fale com o comercial/, /sales contract[\s\S]*contact sales/],
    not_owner: [/Somente o administrador da conta pode alterar a assinatura/, /Only the account administrator can change the subscription/],
    same_order: [/Esse já é o seu plano atual/, /already your current plan/],
    subscription_pending: [/pagamento pendente[\s\S]*portal de cobrança/, /pending payment[\s\S]*billing portal/],
    plan_limit: [/limite do plano[\s\S]*Aumente o plano ou adicione números/, /exceeds the plan limit[\s\S]*Upgrade the plan or add numbers/],
    billing_checkout_pending: [/pagamento em andamento/, /payment is already in progress/],
    billing_unsupported_items: [/itens que o painel não altera[\s\S]*fale com o comercial/, /items the panel cannot change[\s\S]*contact sales/]
  };
  assert.deepEqual(Object.keys(expected).sort(), [...SUBSCRIPTION_ERROR_CODES].sort());
  for (const locale of ['pt-BR', 'en']) for (const [code, patterns] of Object.entries(expected)) {
    setLocale(locale, { persist: false, notify: false });
    const f = fixture(t, { responses: [live()], change: codeError(code === 'same_order' ? 400 : 409, code) }); await f.ui.load();
    await f.ui.act('subscription:change-open'); await f.ui.act('subscription:plan', 'conecta');
    await f.ui.act('subscription:change'); await tick();
    const error = f.view().querySelector('[data-subscription-error]');
    assert.ok(error, `${locale} ${code}`);
    assert.equal(error.getAttribute('role'), 'alert');
    assert.match(error.textContent, patterns[locale === 'en' ? 1 : 0], `${locale} ${code}`);
    assert.equal(error.textContent.includes('Mensagem do servidor em PT'), false, `${locale} ${code}`);
    if (code === 'manual_contract') assert.equal(error.querySelector('[data-subscription-contact]').getAttribute('href'), locale === 'en' ? '/en/contact' : '/contato');
    if (code === 'subscription_pending') assert.ok(error.querySelector('[data-action="subscription:portal"]'));
  }
});

test('checkout com subscription_pending (incomplete) orienta ao portal; 409 sem código não promete troca no portal', async t => {
  const f = fixture(t, { responses: [dto({ state: 'incomplete', plan: 'equipe' })], checkout: codeError(409, 'subscription_pending') }); await f.ui.load();
  let doc = f.view();
  assert.match(doc.querySelector('[data-subscription-alert="incomplete"]').textContent, /Conclua o pagamento no portal de cobrança/);
  assert.ok(doc.querySelector('[data-subscription-alert="incomplete"] [data-action="subscription:portal"]'));
  await f.ui.act('subscription:checkout'); await tick();
  doc = f.view();
  assert.match(doc.querySelector('[data-subscription-error]').textContent, /pagamento pendente[\s\S]*não é preciso assinar de novo/);
  assert.deepEqual(f.assigned, []);
  const g = fixture(t, { responses: [live()], change: httpError(409, 'x') }); await g.ui.load();
  await g.ui.act('subscription:change-open'); await g.ui.act('subscription:extra-inc'); await g.ui.act('subscription:change'); await tick();
  assert.match(g.view().querySelector('[data-subscription-error]').textContent, /Não há uma assinatura ativa para alterar/);
});

test('retorno de sucesso confirma trialing com plano, para o polling e nunca diz Pagamento recebido (PT/EN)', async t => {
  const trialing = dto({ state: 'trialing', plan: 'conecta', currentPeriodEnd: '2026-11-17T12:00:00.000Z', trial: { expiresAt: '2026-11-17T12:00:00.000Z', daysRemaining: 14 } });
  const f = fixture(t, { responses: [dto({ state: 'trialing', trial: { expiresAt: '2026-11-17T12:00:00.000Z', daysRemaining: 14 } }), trialing, live()] });
  await f.ui.handleReturn('success', WS);
  const doc = f.view(), banner = doc.querySelector('[data-subscription-return]');
  assert.equal(banner.getAttribute('data-subscription-return'), 'confirmed');
  assert.equal(banner.getAttribute('data-subscription-confirmed'), 'trialing');
  assert.match(banner.textContent, /Assinatura confirmada\.[\s\S]*Seu teste segue até 17 de novembro de 2026; a primeira cobrança acontece nessa data/);
  assert.equal(doc.body.textContent.includes('Pagamento recebido'), false);
  // Polling stopped at the trialing+plan answer (2 GETs, the active response was never requested).
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/billing/subscription')).length, 2);
  setLocale('en', { persist: false, notify: false });
  assert.match(f.view().querySelector('[data-subscription-return]').textContent, /Subscription confirmed\.[\s\S]*Your trial continues until November 17, 2026; the first charge happens on that date/);
  assert.equal(f.view().body.textContent.includes('Payment received'), false);
});

test('teste encerrado: trial null + trialExpired ou trial.expired mostra Teste encerrado — assine para continuar', async t => {
  for (const shape of [{ trial: null, trialExpired: true }, { trial: { expiresAt: '2026-11-01T12:00:00.000Z', daysRemaining: 0, expired: true } }]) {
    const f = fixture(t, { responses: [dto(shape)] }); await f.ui.load();
    const doc = f.view(), banner = doc.querySelector('[data-subscription-trial]');
    assert.equal(banner.getAttribute('data-subscription-trial'), 'expired');
    assert.match(banner.textContent, /Teste encerrado — assine para continuar[\s\S]*Assinar agora/);
    assert.equal(doc.body.textContent.includes('Seu período de teste termina hoje'), false);
    assert.equal(doc.querySelectorAll('[data-subscription-card]').length, 3);
    setLocale('en', { persist: false, notify: false });
    assert.match(f.view().querySelector('[data-subscription-trial]').textContent, /Trial ended — subscribe to continue/);
    setLocale('pt-BR', { persist: false, notify: false });
  }
  // A past expiry date without a flag (state none) is also treated as ended; trial null without a flag shows no trial banner.
  const g = fixture(t, { responses: [dto({ trial: { expiresAt: '2026-11-01T12:00:00.000Z', daysRemaining: 0 } })], now: () => Date.parse('2026-11-03T12:00:00.000Z') }); await g.ui.load();
  assert.equal(g.view().querySelector('[data-subscription-trial]').getAttribute('data-subscription-trial'), 'expired');
  const h = fixture(t, { responses: [dto()] }); await h.ui.load();
  assert.equal(h.view().querySelector('[data-subscription-trial]'), null);
  assert.throws(() => readSubscription(dto({ trialExpired: 'yes' }), WS), /não confirmou/);
});

test('retorno do portal é neutro e recarrega a assinatura (PT/EN)', async t => {
  const f = fixture(t, { responses: [live({ cancelAtPeriodEnd: true })] });
  assert.equal(await f.ui.handleReturn('portal', WS), true); await tick(); await tick();
  const doc = f.view();
  assert.equal(doc.querySelector('[data-subscription-return]').getAttribute('data-subscription-return'), 'portal');
  assert.match(doc.querySelector('[data-subscription-return]').textContent, /Voltou do portal de cobrança/);
  assert.match(doc.querySelector('[data-subscription-renewal]').textContent, /Cancelamento agendado/);
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/billing/subscription')).length, 1);
  setLocale('en', { persist: false, notify: false });
  assert.match(f.view().querySelector('[data-subscription-return]').textContent, /Back from the billing portal/);
  assert.equal(await f.ui.handleReturn('other', WS), false);
});

test('N4/N5: códigos de checkout pendente e itens não suportados têm mensagem própria; contrato manual explica o motivo', async t => {
  assert.ok(SUBSCRIPTION_ERROR_CODES.includes('billing_checkout_pending') && SUBSCRIPTION_ERROR_CODES.includes('billing_unsupported_items'));
  const pending = fixture(t, { checkout: Object.assign(httpError(409, 'x'), { code: 'billing_checkout_pending' }) });
  await pending.ui.load(); await pending.ui.act('subscription:checkout');
  assert.match(pending.view().querySelector('[data-subscription-error]').textContent, /pagamento em andamento/);
  assert.doesNotMatch(pending.view().querySelector('[data-subscription-error]').textContent, /Alterar plano ou números/);
  const items = fixture(t, { responses: [dto({ state: 'active', plan: 'equipe', currentPeriodEnd: '2026-12-03T12:00:00.000Z' })], change: Object.assign(httpError(409, 'x'), { code: 'billing_unsupported_items' }) });
  await items.ui.load(); await items.ui.act('subscription:change-open'); await items.ui.act('subscription:plan', 'operacao'); await items.ui.act('subscription:change');
  const itemsText = items.view().querySelector('[data-subscription-error]').textContent;
  assert.match(itemsText, /itens que o painel não altera/); assert.doesNotMatch(itemsText, /Não há uma assinatura ativa/);
  const manual = fixture(t, { responses: [dto({ canManage: false, manualContract: true })] });
  await manual.ui.load();
  const doc = manual.view();
  assert.ok(doc.querySelector('[data-subscription-manual-contract]'));
  assert.doesNotMatch(doc.querySelector('[data-subscription-root]').textContent, /Somente o administrador da conta pode assinar/);
  for (const key of ['Já existe um pagamento em andamento para esta conta. Conclua o checkout aberto ou aguarde alguns minutos e tente de novo.', 'Esta assinatura tem itens que o painel não altera sozinho. Para mudar o plano ou os números,', 'Esta conta tem um contrato comercial.', 'Para mudar o plano ou os números,'])
    assert.equal(typeof subscriptionTranslations[key], 'string', key);
});
