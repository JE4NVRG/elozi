import { t, h, raw, getLocale, translateError } from './i18n.js';
import './locales-subscription.js';
import { button as uiButton, badge as uiBadge, banner, skeleton } from './ui.js';

// Assinatura Elozi (self-service, Stripe-hosted). Mounted at the top of Configurações › Financeiro for
// the administrator of a business workspace. The browser never decides the subscription state: it shows
// what GET /api/billing/subscription returns, sends the owner to Stripe Checkout / Billing Portal with a
// fresh requestId per click, changes plan / extra numbers of a live subscription through
// POST /api/billing/change (re-rendering from the server response), and after the success return polls the
// API until it reports a subscription (active, or trialing with a plan) or gives up with a neutral
// "still confirming" message. Errors are translated by backend `code`. Manual contracts and invoices stay
// in billing-ui.js, untouched.

/** Approved commercial terms (contract 03/11/2026). Display only: the server owns the Stripe prices. */
export const SUBSCRIPTION_PLANS = Object.freeze([
  Object.freeze({ key: 'conecta', cents: 4900, numbers: 1, users: 2 }),
  Object.freeze({ key: 'equipe', cents: 9900, numbers: 2, users: 5 }),
  Object.freeze({ key: 'operacao', cents: 19900, numbers: 5, users: 15 })
]);
export const EXTRA_NUMBER_CENTS = 2900;
export const MAX_EXTRA_NUMBERS = 20;
const PLAN_KEYS = SUBSCRIPTION_PLANS.map(plan => plan.key);
const STATES = ['none', 'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid'];
const planName = key => key === 'operacao' ? (getLocale() === 'en' ? 'Operations' : 'Operação') : key === 'equipe' ? 'Equipe' : key === 'conecta' ? 'Conecta' : '';
const planOf = key => SUBSCRIPTION_PLANS.find(plan => plan.key === key) || null;

export function subscriptionTotalCents(planKey, extraNumbers = 0) {
  const plan = planOf(planKey);
  if (!plan || !Number.isSafeInteger(extraNumbers) || extraNumbers < 0 || extraNumbers > MAX_EXTRA_NUMBERS) return null;
  return plan.cents + extraNumbers * EXTRA_NUMBER_CENTS;
}
export function formatSubscriptionMoney(cents) {
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}
const formatDate = iso => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(getLocale(), { day: '2-digit', month: 'long', year: 'numeric' }) : '';
};
const contactHref = () => getLocale() === 'en' ? '/en/contact' : '/contato';
/** Public sales contact while online subscription is off: a mailto that names the chosen plan. */
export const SALES_EMAIL = 'jean@je4ndev.com';
export function salesMailto(planLabel = '') {
  const subject = planLabel ? `Elozi - contratar plano ${planLabel}` : 'Elozi - contratar plano';
  return `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
const apiLocale = () => getLocale() === 'en' ? 'en' : 'pt-BR';
const isoOrNull = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalBoolean = value => value === undefined || typeof value === 'boolean';

/** Strict reading of the subscription DTO; anything else is "not confirmed". */
export function readSubscription(result, workspaceId) {
  const ok = result && typeof result === 'object' && typeof result.enabled === 'boolean' && result.workspaceId === workspaceId && STATES.includes(result.state)
    && (result.plan === null || PLAN_KEYS.includes(result.plan)) && Number.isSafeInteger(result.extraNumbers) && result.extraNumbers >= 0 && result.extraNumbers <= 1000
    && isoOrNull(result.currentPeriodEnd) && typeof result.cancelAtPeriodEnd === 'boolean' && typeof result.canManage === 'boolean'
    && (result.trial === null || result.trial && typeof result.trial === 'object' && isoOrNull(result.trial.expiresAt) && typeof result.trial.expiresAt === 'string' && Number.isSafeInteger(result.trial.daysRemaining) && result.trial.daysRemaining >= 0 && optionalBoolean(result.trial.expired))
    && optionalBoolean(result.trialExpired);
  if (!ok) throw new Error('O servidor não confirmou a assinatura.');
  return { enabled: result.enabled, workspaceId: result.workspaceId, state: result.state, plan: result.plan, extraNumbers: result.extraNumbers, currentPeriodEnd: result.currentPeriodEnd, cancelAtPeriodEnd: result.cancelAtPeriodEnd, trial: result.trial ? { expiresAt: result.trial.expiresAt, daysRemaining: result.trial.daysRemaining, expired: result.trial.expired === true } : null, trialExpired: result.trialExpired === true || result.trial?.expired === true, canManage: result.canManage, manualContract: result.manualContract === true };
}
/** A Stripe subscription exists (manage it in the portal instead of a new checkout). */
const subscribed = data => ['active', 'past_due'].includes(data.state) || data.state === 'trialing' && data.plan !== null;
/** Success return is confirmed by any subscribed state except past_due (addendum D3). */
const confirmedSubscription = data => data?.state === 'active' || data?.state === 'trialing' && data.plan !== null;
/** Backend error codes of the billing routes (addendum D5), translated here so EN never shows PT copy. */
export const SUBSCRIPTION_ERROR_CODES = Object.freeze(['subscription_exists', 'manual_contract', 'not_owner', 'same_order', 'subscription_pending', 'plan_limit', 'billing_checkout_pending', 'billing_unsupported_items']);

const safeRedirect = value => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
};

export function createSubscriptionUI({
  getContext, request, onRender = () => {}, toast = () => {},
  assign = url => globalThis.location.assign(url),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  randomId = () => globalThis.crypto.randomUUID(),
  pollAttempts = 6, pollIntervalMs = 2500,
  getDocument = () => globalThis.document,
  now = () => Date.now()
}) {
  let snapshot = null, page = { key: '', loading: false, error: '' }, busy = '', actionError = null, sequence = 0, controller = null;
  let selection = { plan: 'equipe', extra: 0 }, returnState = null; // returnState: { key, kind: 'confirming'|'confirmed'|'pending'|'cancel'|'portal'|'changed' }
  let changing = ''; // authority key while the "Alterar plano ou números" panel is open
  const context = () => getContext() || {};
  const key = () => { const c = context(); return JSON.stringify([c.workspaceId || null, Boolean(c.eligible), c.authorityKey || null]); };
  const eligible = () => Boolean(context().eligible && context().workspaceId);
  const data = () => snapshot?.key === key() ? snapshot.data : null;
  const render = focus => { onRender(); if (focus) getDocument()?.querySelector?.(focus)?.focus?.({ preventScroll: true }); };

  async function load({ force = false } = {}) {
    if (!eligible()) return false;
    const origin = key();
    if (!force && (snapshot?.key === origin || page.key === origin && (page.loading || page.error))) return false;
    controller?.abort(); controller = typeof AbortController === 'function' ? new AbortController() : null;
    const ticket = ++sequence, workspaceId = context().workspaceId;
    page = { key: origin, loading: true, error: '' };
    try {
      const result = await request('/api/billing/subscription?' + new URLSearchParams({ workspaceId }), { signal: controller?.signal });
      if (origin !== key() || ticket !== sequence) return false;
      const value = readSubscription(result, workspaceId);
      snapshot = { key: origin, data: value };
      if (value.plan && !subscribed(value)) selection = { plan: value.plan, extra: Math.min(MAX_EXTRA_NUMBERS, value.extraNumbers) };
      return true;
    } catch (error) {
      if (origin !== key() || ticket !== sequence || error?.name === 'AbortError') return false;
      page.error = error?.status === 403 ? t('A assinatura online é exclusiva do administrador de uma conta de empresa.') : translateError(error?.message || 'O servidor não confirmou a assinatura.');
      return false;
    } finally { if (page.key === origin && ticket === sequence) { page.loading = false; render(); } }
  }

  /** Called by app.js once after start when the URL carries ?billing=success|cancel|portal&workspace=<id>. */
  async function handleReturn(kind, workspaceId) {
    if (!['success', 'cancel', 'portal'].includes(kind) || !eligible() || workspaceId !== context().workspaceId) return false;
    const origin = key();
    if (kind === 'cancel' || kind === 'portal') { returnState = { key: origin, kind }; render(); void load({ force: true }); return true; }
    returnState = { key: origin, kind: 'confirming' }; render();
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      if (attempt) await wait(pollIntervalMs);
      if (origin !== key() || returnState?.key !== origin || returnState.kind !== 'confirming') return true;
      await load({ force: true });
      if (origin !== key() || returnState?.key !== origin) return true;
      if (confirmedSubscription(data())) { returnState = { key: origin, kind: 'confirmed' }; render(); return true; }
      if (data()?.state === 'past_due') break;
    }
    if (origin === key() && returnState?.key === origin && returnState.kind === 'confirming') { returnState = { key: origin, kind: 'pending' }; render(); }
    return true;
  }

  /** Message for a failed billing call: backend `code` first, then HTTP status, then the translated server text. */
  function errorView(error, kind) {
    const code = SUBSCRIPTION_ERROR_CODES.includes(error?.code) ? error.code : '';
    const value = data(), portal = value?.enabled && value.canManage ? { label: t('Gerenciar assinatura'), action: 'subscription:portal' } : null;
    if (code === 'subscription_exists') return { message: t('Esta conta já tem uma assinatura. Use Alterar plano ou números para mudar o plano ou a quantidade de números.'), reload: true };
    if (code === 'manual_contract') return { message: h`${t('Esta conta tem um contrato comercial. Para mudar o plano ou os números,')} <a href="${contactHref()}" data-subscription-contact>${t('fale com o comercial')}</a>.` };
    if (code === 'not_owner') return { message: t('Somente o administrador da conta pode alterar a assinatura.'), reload: true };
    if (code === 'same_order') return { message: t('Esse já é o seu plano atual. Escolha outro plano ou outra quantidade de números.') };
    if (code === 'subscription_pending') return { message: t('Há um pagamento pendente nesta assinatura. Conclua ou atualize o pagamento no portal de cobrança; não é preciso assinar de novo.'), action: portal, reload: true };
    if (code === 'plan_limit') return { message: t('O pedido ultrapassa o limite do plano. Aumente o plano ou adicione números.') };
    if (code === 'billing_checkout_pending') return { message: t('Já existe um pagamento em andamento para esta conta. Conclua o checkout aberto ou aguarde alguns minutos e tente de novo.'), reload: true };
    if (code === 'billing_unsupported_items') return { message: h`${t('Esta assinatura tem itens que o painel não altera sozinho. Para mudar o plano ou os números,')} <a href="${contactHref()}" data-subscription-contact>${t('fale com o comercial')}</a>.` };
    const status = error?.status;
    if (status === 409) return { message: kind === 'change' ? t('Não há uma assinatura ativa para alterar nesta conta.') : t('Esta conta já tem uma assinatura. Use Alterar plano ou números ou Gerenciar assinatura.'), reload: true };
    if (status === 503) return { message: t('A assinatura online está indisponível no momento. Fale com o comercial.'), reload: true };
    if (status === 404 && kind === 'portal') return { message: t('Ainda não há uma assinatura com cartão para gerenciar nesta conta.') };
    if (status === 403) return { message: t('A assinatura online é exclusiva do administrador de uma conta de empresa.') };
    if (status === 400 && kind === 'change') return { message: t('Não foi possível alterar a assinatura. Confira o plano e a quantidade de números.') };
    return { message: translateError(error?.message || '') };
  }
  function fail(error, kind) {
    busy = '';
    const view = errorView(error, kind);
    actionError = { message: view.message, action: view.action || null };
    render('[data-subscription-error]');
    if (view.reload) void load({ force: true });
  }
  const sameOrder = value => Boolean(value) && selection.plan === value.plan && selection.extra === value.extraNumbers;

  async function change() {
    const value = data();
    if (busy || !value || !value.enabled || !value.canManage || !subscribed(value) || changing !== key()) return;
    if (subscriptionTotalCents(selection.plan, selection.extra) === null) { actionError = { message: t('Escolha um plano válido antes de assinar.') }; render('[data-subscription-error]'); return; }
    if (sameOrder(value)) { actionError = { message: t('Esse já é o seu plano atual. Escolha outro plano ou outra quantidade de números.') }; render('[data-subscription-error]'); return; }
    const origin = key(), workspaceId = context().workspaceId;
    const body = { workspaceId, plan: selection.plan, extraNumbers: selection.extra, requestId: randomId(), locale: apiLocale() };
    busy = 'change'; actionError = null; render();
    try {
      const result = await request('/api/billing/change', { method: 'POST', body: JSON.stringify(body) });
      if (origin !== key()) return;
      let next;
      try { next = readSubscription(result, workspaceId); } catch { throw new Error('O servidor não confirmou a alteração da assinatura.'); }
      busy = ''; sequence++; controller?.abort(); page = { key: origin, loading: false, error: '' };
      snapshot = { key: origin, data: next }; changing = ''; returnState = { key: origin, kind: 'changed' };
      render('[data-subscription-return="changed"]');
    } catch (error) {
      if (origin !== key()) return;
      fail(error, 'change');
      if (error?.message === 'O servidor não confirmou a alteração da assinatura.') void load({ force: true });
    }
  }

  async function redirect(kind) {
    const value = data();
    if (busy || !value || !value.enabled || !value.canManage) return;
    const origin = key(), workspaceId = context().workspaceId;
    const body = kind === 'checkout'
      ? { workspaceId, plan: selection.plan, extraNumbers: selection.extra, requestId: randomId(), locale: apiLocale() }
      : { workspaceId, requestId: randomId(), locale: apiLocale() };
    if (kind === 'checkout' && subscriptionTotalCents(body.plan, body.extraNumbers) === null) { actionError = { message: t('Escolha um plano válido antes de assinar.') }; render('[data-subscription-error]'); return; }
    busy = kind; actionError = null; render();
    let url = '';
    try {
      const result = await request(kind === 'checkout' ? '/api/billing/checkout' : '/api/billing/portal', { method: 'POST', body: JSON.stringify(body) });
      if (origin !== key()) return;
      url = safeRedirect(result?.url);
      if (!url) throw new Error('O servidor não confirmou o endereço de pagamento.');
    } catch (error) {
      if (origin !== key()) return;
      fail(error, kind);
      return;
    }
    // Keep the button busy while the browser leaves for Stripe; nothing is granted here.
    assign(url);
  }

  async function act(name, id) {
    if (!name?.startsWith('subscription:')) return false;
    if (!eligible()) return true;
    if (name === 'subscription:refresh') { actionError = null; await load({ force: true }); return true; }
    if (name === 'subscription:dismiss-return') { returnState = null; render('#subscription-title'); return true; }
    if (busy) return true;
    if (name === 'subscription:plan' && PLAN_KEYS.includes(id)) { selection = { ...selection, plan: id }; actionError = null; render(`[data-subscription-plan="${id}"]`); return true; }
    if (name === 'subscription:change-open') {
      const value = data();
      if (!value || !subscribed(value) || !value.enabled || !value.canManage) return true;
      selection = { plan: value.plan, extra: Math.min(MAX_EXTRA_NUMBERS, value.extraNumbers) }; changing = key(); actionError = null;
      if (returnState?.kind === 'changed') returnState = null;
      render('#subscription-change-title'); return true;
    }
    if (name === 'subscription:change-close') { changing = ''; actionError = null; render('[data-action="subscription:change-open"]'); return true; }
    if (name === 'subscription:change') { await change(); return true; }
    if (name === 'subscription:extra-inc' || name === 'subscription:extra-dec') {
      const next = selection.extra + (name === 'subscription:extra-inc' ? 1 : -1);
      if (next >= 0 && next <= MAX_EXTRA_NUMBERS) selection = { ...selection, extra: next };
      render(`[data-action="${name}"]:not([disabled])`); return true;
    }
    if (name === 'subscription:subscribe-focus') { render('#subscription-plans-title'); return true; }
    if (name === 'subscription:checkout') { await redirect('checkout'); return true; }
    if (name === 'subscription:portal') { await redirect('portal'); return true; }
    return true;
  }

  // ---------- Markup ----------
  function returnBanner() {
    if (returnState?.key !== key()) return '';
    const dismiss = { label: t('Fechar aviso da assinatura'), action: 'subscription:dismiss-return' };
    if (returnState.kind === 'confirming') return banner({ tone: 'info', live: 'polite', title: t('Retorno do checkout, confirmando assinatura…'), body: t('A assinatura só aparece como ativa depois da confirmação da Stripe. Isso costuma levar alguns segundos.'), attrs: { 'data-subscription-return': 'confirming' } });
    if (returnState.kind === 'confirmed') {
      const value = data(), date = value?.state === 'trialing' && value.trial?.expiresAt ? formatDate(value.trial.expiresAt) : '';
      const body = value?.state !== 'trialing' ? t('Os limites do plano já valem para esta conta.')
        : date ? t('Seu teste segue até {date}; a primeira cobrança acontece nessa data.', { date }) : t('Seu teste continua; a primeira cobrança acontece ao fim do teste.');
      return banner({ tone: 'success', live: 'polite', title: t('Assinatura confirmada.'), body, action: dismiss, attrs: { 'data-subscription-return': 'confirmed', 'data-subscription-confirmed': value?.state || '' } });
    }
    if (returnState.kind === 'changed') return banner({ tone: 'success', live: 'polite', title: t('Assinatura alterada.'), body: t('O novo plano e os números já aparecem abaixo. A diferença é calculada proporcionalmente na próxima fatura.'), action: dismiss, attrs: { 'data-subscription-return': 'changed', tabindex: '-1' } });
    if (returnState.kind === 'portal') return banner({ tone: 'info', live: 'polite', title: t('Voltou do portal de cobrança.'), body: t('Atualizamos os dados da assinatura com o que a Stripe informou.'), action: dismiss, attrs: { 'data-subscription-return': 'portal' } });
    if (returnState.kind === 'pending') return banner({ tone: 'warning', live: 'polite', title: t('Ainda confirmando a assinatura.'), body: t('A confirmação da Stripe ainda não chegou. Atualize em alguns minutos; não é preciso pagar de novo.'), action: { label: t('Atualizar assinatura'), action: 'subscription:refresh' }, attrs: { 'data-subscription-return': 'pending' } });
    return banner({ tone: 'info', live: 'polite', title: t('Assinatura não concluída.'), body: t('Nenhuma cobrança foi feita. Você pode escolher um plano quando quiser.'), action: dismiss, attrs: { 'data-subscription-return': 'cancel' } });
  }
  function statusBanner(value) {
    const banners = [];
    const expired = !subscribed(value) && (value.trialExpired || value.state === 'none' && value.trial && Date.parse(value.trial.expiresAt) <= now());
    if (expired) banners.push(banner({ tone: 'warning', title: t('Teste encerrado — assine para continuar.'), body: t('Escolha um plano abaixo para retomar a operação desta conta.'), action: value.enabled && value.canManage ? { label: t('Assinar agora'), action: 'subscription:subscribe-focus' } : null, attrs: { 'data-subscription-trial': 'expired' } }));
    else if (value.trial && !subscribed(value)) {
      const days = value.trial.daysRemaining, date = formatDate(value.trial.expiresAt);
      const title = days === 0 ? t('Seu período de teste termina hoje.') : days === 1 ? t('Último dia do período de teste.') : t('{days} dias restantes no seu período de teste.', { days });
      banners.push(banner({ tone: days <= 3 ? 'warning' : 'info', title, body: date ? t('Teste até {date}. Assine para continuar sem interrupção.', { date }) : t('Assine para continuar sem interrupção.'), action: value.enabled && value.canManage ? { label: t('Assinar agora'), action: 'subscription:subscribe-focus' } : null, attrs: { 'data-subscription-trial': String(days) } }));
    }
    if (value.state === 'past_due') banners.push(banner({ tone: 'danger', title: t('Pagamento pendente.'), body: t('A última cobrança não foi aprovada. Atualize o cartão no portal de cobrança para manter a assinatura.'), action: value.enabled && value.canManage ? { label: t('Gerenciar assinatura'), action: 'subscription:portal', busy: busy === 'portal' } : null, attrs: { 'data-subscription-alert': 'past_due' } }));
    if (value.state === 'incomplete') banners.push(banner({ tone: 'warning', title: t('Pagamento não concluído.'), body: t('A primeira cobrança não foi confirmada. Conclua o pagamento no portal de cobrança; não é preciso assinar de novo.'), action: value.enabled && value.canManage ? { label: t('Gerenciar assinatura'), action: 'subscription:portal', busy: busy === 'portal' } : null, attrs: { 'data-subscription-alert': 'incomplete' } }));
    if (value.state === 'unpaid' || value.state === 'canceled') banners.push(banner({ tone: 'warning', title: value.state === 'unpaid' ? t('Assinatura sem pagamento.') : t('Assinatura encerrada.'), body: t('Assine um plano para retomar a operação desta conta.'), attrs: { 'data-subscription-alert': value.state } }));
    return banners;
  }
  function currentCard(value) {
    const plan = planOf(value.plan);
    const stateLabel = { active: t('Assinatura ativa'), past_due: t('Pagamento pendente'), trialing: t('Assinatura em teste') }[value.state] || '';
    const numbers = plan ? plan.numbers + value.extraNumbers : 0;
    const total = plan ? subscriptionTotalCents(value.plan, Math.min(MAX_EXTRA_NUMBERS, value.extraNumbers)) : null;
    const date = value.currentPeriodEnd ? formatDate(value.currentPeriodEnd) : '';
    const renewal = !date ? '' : value.cancelAtPeriodEnd ? t('Cancelamento agendado: acesso até {date}.', { date }) : t('Próxima renovação em {date}.', { date });
    return h`<article class="pg-settings__card" data-subscription-current="${value.state}"><div class="pg-settings__card-head"><h3 class="pg-settings__h3">${t('Plano {name}', { name: planName(value.plan) })}</h3>${uiBadge(stateLabel, value.state === 'active' ? 'success' : value.state === 'past_due' ? 'danger' : 'info')}</div>
      <p class="pg-settings__text">${t('{numbers} números de WhatsApp · {users} usuários', { numbers, users: plan?.users ?? 0 })}${value.extraNumbers ? h` · ${t('{count} números adicionais', { count: value.extraNumbers })}` : ''}</p>
      ${total !== null && value.extraNumbers <= MAX_EXTRA_NUMBERS ? h`<p class="pg-settings__muted">${t('{total} por mês', { total: formatSubscriptionMoney(total) })}</p>` : ''}
      ${renewal ? h`<p class="pg-settings__muted" data-subscription-renewal>${renewal}</p>` : ''}
      ${value.enabled && value.canManage ? h`<div class="pg-settings__cluster">${changing === key() ? '' : uiButton({ label: t('Alterar plano ou números'), action: 'subscription:change-open', variant: 'primary', size: 'lg', disabled: Boolean(busy), attrs: { 'aria-expanded': 'false', 'aria-controls': 'subscription-change', 'data-subscription-change-open': '' } })}${uiButton({ label: t('Gerenciar assinatura'), action: 'subscription:portal', variant: 'secondary', size: 'lg', busy: busy === 'portal', disabled: Boolean(busy) && busy !== 'portal' })}</div><p class="pg-settings__hint">${t('No portal da Stripe você altera o cartão, vê recibos ou cancela. Para mudar o plano ou os números, use Alterar plano ou números.')}</p>` : ''}
    </article>`;
  }
  function planCards(canBuy) {
    return SUBSCRIPTION_PLANS.map(plan => {
      // Without online subscription (or permission to buy) nothing is chosen in this form: no plan is shown as
      // selected/current unless a real subscription exists (currentCard) or the owner is filling the checkout form.
      const selected = canBuy && selection.plan === plan.key;
      return h`<li class="pg-settings__card" data-subscription-card="${plan.key}"${raw(selected ? ' data-state="selected" aria-current="true"' : '')}><div class="pg-settings__card-head"><h4 class="pg-settings__h3">${planName(plan.key)}</h4>${selected ? uiBadge(t('Selecionado'), 'accent') : ''}</div>
        <p class="pg-settings__strong">${t('{price} por mês', { price: formatSubscriptionMoney(plan.cents) })}</p>
        <ul class="pg-settings__list"><li class="pg-settings__sub">${plan.numbers === 1 ? t('1 número de WhatsApp') : t('{count} números de WhatsApp', { count: plan.numbers })}</li><li class="pg-settings__sub">${t('Até {count} usuários', { count: plan.users })}</li></ul>
        ${canBuy ? uiButton({ label: selected ? t('Plano {name} selecionado', { name: planName(plan.key) }) : t('Escolher {name}', { name: planName(plan.key) }), action: 'subscription:plan', size: 'lg', variant: selected ? 'primary' : 'secondary', disabled: Boolean(busy), attrs: { 'data-id': plan.key, 'data-subscription-plan': plan.key, 'aria-pressed': selected ? 'true' : 'false' } })
          : !data()?.enabled ? h`<a class="ui-btn ui-btn--secondary ui-btn--md" href="${salesMailto(planName(plan.key))}" data-subscription-contact-plan="${plan.key}">${t('Contratar {name} com o comercial', { name: planName(plan.key) })}</a>` : ''}
      </li>`;
    });
  }
  function stepperMarkup() {
    return h`<fieldset class="pg-settings__fieldset" data-subscription-extra><legend id="subscription-extra-label">${t('Números adicionais de WhatsApp')}</legend>
        <p class="pg-settings__muted">${t('{price} por número adicional, por mês. Até {max}.', { price: formatSubscriptionMoney(EXTRA_NUMBER_CENTS), max: MAX_EXTRA_NUMBERS })}</p>
        <div class="pg-settings__cluster" role="group" aria-labelledby="subscription-extra-label">${uiButton({ label: '−', action: 'subscription:extra-dec', size: 'lg', disabled: selection.extra <= 0 || Boolean(busy), attrs: { 'aria-label': t('Remover um número adicional') } })}<output class="pg-settings__strong" id="subscription-extra-count" aria-live="polite" aria-atomic="true" data-subscription-extra-count="${selection.extra}">${t('{count} adicionais', { count: selection.extra })}</output>${uiButton({ label: '+', action: 'subscription:extra-inc', size: 'lg', disabled: selection.extra >= MAX_EXTRA_NUMBERS || Boolean(busy), attrs: { 'aria-label': t('Adicionar um número adicional') } })}</div>
      </fieldset>`;
  }
  function composition() {
    const plan = planOf(selection.plan);
    const extras = selection.extra ? t(' + {count} × {price} (números adicionais)', { count: selection.extra, price: formatSubscriptionMoney(EXTRA_NUMBER_CENTS) }) : '';
    return h`<p class="pg-settings__muted">${planName(plan.key)} ${formatSubscriptionMoney(plan.cents)}${extras} · ${t('{count} números de WhatsApp no total', { count: plan.numbers + selection.extra })}</p>`;
  }
  /** "Alterar plano ou números" for a live subscription: same cards + stepper, new vs current total, confirm. */
  function changePanel(value) {
    if (changing !== key() || !value.enabled || !value.canManage) return '';
    const total = subscriptionTotalCents(selection.plan, selection.extra);
    const current = subscriptionTotalCents(value.plan, Math.min(MAX_EXTRA_NUMBERS, value.extraNumbers));
    const same = sameOrder(value), delta = total !== null && current !== null ? total - current : null;
    const deltaCopy = same || delta === null ? t('Nenhuma alteração selecionada.') : delta > 0 ? t('Aumento de {amount} por mês.', { amount: formatSubscriptionMoney(delta) }) : delta < 0 ? t('Redução de {amount} por mês.', { amount: formatSubscriptionMoney(-delta) }) : t('Mesmo valor mensal, com outra composição.');
    const numbersNow = planOf(selection.plan).numbers + selection.extra, numbersBefore = planOf(value.plan).numbers + value.extraNumbers;
    return h`<section class="pg-settings__section" id="subscription-change" aria-labelledby="subscription-change-title" data-subscription-change><h3 class="pg-settings__section-title" id="subscription-change-title" tabindex="-1">${t('Alterar plano ou números')}</h3>
      <ul class="pg-settings__cards">${planCards(true)}</ul>
      ${stepperMarkup()}
      <div class="pg-settings__card" data-subscription-total="${total}" data-subscription-current-total="${current}"><p class="pg-settings__text" aria-live="polite" aria-atomic="true"><strong class="pg-settings__strong">${t('Novo total mensal: {total}', { total: formatSubscriptionMoney(total) })}</strong> · ${t('atual: {total}', { total: formatSubscriptionMoney(current) })}</p>${composition()}
        <p class="pg-settings__muted" data-subscription-delta>${deltaCopy}</p>
        ${numbersNow < numbersBefore ? h`<p class="pg-settings__hint" data-subscription-downgrade>${t('Com menos números, nada é desconectado; novas conexões ficam bloqueadas até a conta caber no limite.')}</p>` : ''}
        <p class="pg-settings__hint" data-subscription-proration>${t('A diferença é calculada proporcionalmente na próxima fatura.')}</p>
        <div class="pg-settings__cluster">${uiButton({ label: t('Confirmar alteração'), action: 'subscription:change', variant: 'primary', size: 'lg', busy: busy === 'change', disabled: same || Boolean(busy) && busy !== 'change', attrs: { 'data-subscription-change-confirm': '' } })}${uiButton({ label: t('Cancelar alteração'), action: 'subscription:change-close', variant: 'ghost', size: 'lg', disabled: Boolean(busy) })}</div>
      </div>
    </section>`;
  }
  function planPicker(value) {
    const canBuy = value.enabled && value.canManage;
    const cards = planCards(canBuy);
    const total = subscriptionTotalCents(selection.plan, selection.extra);
    const stepper = canBuy ? h`${stepperMarkup()}
      <div class="pg-settings__card" data-subscription-total="${total}"><p class="pg-settings__text" aria-live="polite" aria-atomic="true"><strong class="pg-settings__strong">${t('Total mensal: {total}', { total: formatSubscriptionMoney(total) })}</strong></p>${composition()}
        <div class="pg-settings__cluster">${uiButton({ label: t('Assinar com cartão'), action: 'subscription:checkout', variant: 'primary', size: 'lg', busy: busy === 'checkout', disabled: Boolean(busy) && busy !== 'checkout', attrs: { 'data-subscription-checkout': '' } })}</div>
      </div>` : '';
    const unavailable = !value.enabled ? banner({ tone: 'info', title: t('Assinatura online em breve.'), body: h`${t('Para contratar agora, escolha um plano abaixo ou')} <a href="${salesMailto()}" data-subscription-contact>${t('escreva para {email}', { email: SALES_EMAIL })}</a>.`, attrs: { 'data-subscription-disabled': '' } })
      : !value.canManage && value.manualContract ? banner({ tone: 'info', title: t('Esta conta tem um contrato comercial.'), body: h`${t('Para mudar o plano ou os números,')} <a href="${contactHref()}" data-subscription-contact>${t('fale com o comercial')}</a>.`, attrs: { 'data-subscription-manual-contract': '' } })
      : !value.canManage ? banner({ tone: 'info', title: t('Somente o administrador da conta pode assinar.'), body: t('Peça ao responsável pela conta para escolher o plano.') }) : '';
    return h`<section class="pg-settings__section" aria-labelledby="subscription-plans-title"><h3 class="pg-settings__section-title" id="subscription-plans-title" tabindex="-1">${t('Escolha seu plano')}</h3>
      ${unavailable}
      <ul class="pg-settings__cards">${cards}</ul>
      ${stepper}
    </section>`;
  }
  function terms() {
    return h`<ul class="pg-settings__list" data-subscription-terms><li class="pg-settings__hint">${t('Pagamento com cartão, processado pela Stripe.')}</li><li class="pg-settings__hint">${t('Cobrança mensal recorrente.')}</li><li class="pg-settings__hint">${t('Cancele quando quiser no portal de cobrança; o acesso continua até o fim do período pago.')}</li><li class="pg-settings__hint">${t('O consumo de IA e modelos é cobrado à parte e não está incluído nos planos.')}</li></ul>`;
  }
  function markup() {
    if (!eligible()) return '';
    const value = data(), origin = key();
    if (!value && page.key !== origin && !page.loading) queueMicrotask(() => { void load(); });
    const header = h`<div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="subscription-title" tabindex="-1">${t('Assinatura Elozi')}</h2><p class="pg-settings__muted">${t('Plano mensal da sua conta, pago com cartão.')}</p></div>${uiButton({ label: t('Atualizar assinatura'), action: 'subscription:refresh', icon: 'refresh', size: 'sm', busy: page.key === origin && page.loading })}</div>`;
    const error = actionError ? h`<div class="form-error pg-settings__error" role="alert" tabindex="-1" data-subscription-error><p class="pg-settings__text">${actionError.message}</p>${actionError.action ? h`<div class="pg-settings__cluster">${uiButton({ label: actionError.action.label, action: actionError.action.action, size: 'lg', busy: busy === 'portal' })}</div>` : ''}</div>` : '';
    let body;
    if (!value) body = page.key === origin && page.error ? banner({ tone: 'warning', title: t('Não foi possível carregar a assinatura.'), body: page.error, action: { label: t('Tentar carregar a assinatura de novo'), action: 'subscription:refresh' } }) : skeleton({ lines: 3, label: t('Carregando a assinatura…') });
    else body = h`${statusBanner(value)}${subscribed(value) ? h`${currentCard(value)}${changePanel(value)}` : planPicker(value)}${terms()}`;
    return String(h`<section class="pg-settings pg-settings--subscription" aria-labelledby="subscription-title" data-subscription-root>${header}${returnBanner()}${error}${body}</section>`);
  }
  function reset() { controller?.abort(); sequence++; snapshot = null; page = { key: '', loading: false, error: '' }; busy = ''; actionError = null; returnState = null; changing = ''; selection = { plan: 'equipe', extra: 0 }; }
  return { load, markup, act, handleReturn, reset, get selection() { return { ...selection }; } };
}
