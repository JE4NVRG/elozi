import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail } from './store.js';
import { normalizeFiscalDocument } from './signup-trial.js';

/** Approved self-serve terms (do not change without the commercial owner). AI consumption is never included. */
export const STRIPE_PLANS = Object.freeze({
  conecta: Object.freeze({ whatsappNumbers: 1, users: 2, env: 'ELOZI_STRIPE_PRICE_CONECTA' }),
  equipe: Object.freeze({ whatsappNumbers: 2, users: 5, env: 'ELOZI_STRIPE_PRICE_EQUIPE' }),
  operacao: Object.freeze({ whatsappNumbers: 5, users: 15, env: 'ELOZI_STRIPE_PRICE_OPERACAO' })
});
export const STRIPE_EXTRA_NUMBER_ENV = 'ELOZI_STRIPE_PRICE_EXTRA_NUMBER';
/**
 * Pinned Stripe API version for every REST call (Stripe-Version header). The webhook destination must be a
 * Snapshot destination created with this same version. Handlers only trust ids from the event and re-read the
 * Subscription through this pinned version, so payload shape drift cannot change entitlement.
 */
export const STRIPE_API_VERSION = '2026-04-22.dahlia';
export const STRIPE_SIGNATURE_TOLERANCE_S = 300;
export const STRIPE_WEBHOOK_MAX_BYTES = 524288;
export const STRIPE_TEST_LIFECYCLE_ENV = 'ELOZI_STRIPE_TEST_LIFECYCLE_WORKSPACES';
const STATES = ['none', 'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid'];
const LIVE = ['active', 'trialing', 'past_due'];
// Stripe subscription.status -> contract state. Stripe "paused" means no payment method after a trial: no paid access.
const STATUS_MAP = { trialing: 'trialing', active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'unpaid',
  incomplete: 'incomplete', incomplete_expired: 'canceled', paused: 'unpaid' };
const HANDLED = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
const SYSTEM_USER = 'stripe-webhook';
const MIN_TRIAL_ALIGNMENT_MS = 48 * 3600 * 1000;
const REUSE_MARGIN_S = 120;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/\p{Cc}/u.test(value);
const stripeId = (value, prefix) => typeof value === 'string' && value.length <= 255 && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);
/** Billing e-mail sent to Stripe: same syntax gate as the account e-mail endpoints; anything else is omitted. */
const billingEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const idOf = value => typeof value === 'string' ? value : value && typeof value === 'object' && typeof value.id === 'string' ? value.id : null;
const fields = (value, allowed, required = allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => value[key] === undefined)) invalid('Informe somente os campos da assinatura.');
};
/** Billing errors carry a stable machine code (server whitelists them) so the panel translates by code. */
export const BILLING_ERROR_CODES = Object.freeze(['subscription_exists', 'subscription_pending', 'manual_contract', 'not_owner', 'same_order',
  'billing_unavailable', 'billing_invalid_request', 'billing_not_self_serve', 'billing_no_subscription', 'billing_no_customer',
  'billing_checkout_pending', 'billing_provider_error', 'billing_unsupported_items']);
const failCode = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const invalid = message => failCode(400, message, 'billing_invalid_request');
const unavailable = () => failCode(503, 'A assinatura online ainda não está disponível.', 'billing_unavailable');
/** Plan applied to self-serve signup workspaces without a paid Stripe subscription (D4). */
export const DEFAULT_SELF_SERVE_PLAN = 'conecta';
const RETURN_STATES = ['success', 'cancel', 'portal'];
const returnWorkspace = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/**
 * Stripe return target (D1): `/billing/return?state=success|cancel|portal&workspace=<id>` -> same-site
 * `/?billing=<state>&workspace=<id>#settings/billing`. Anything else (unknown/missing/repeated/extra params) -> `/`.
 */
export function billingReturnTarget(searchParams) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(String(searchParams || ''));
  const keys = [...params.keys()];
  if (keys.length !== 2 || keys.filter(key => key === 'state').length !== 1 || keys.filter(key => key === 'workspace').length !== 1) return '/';
  const state = params.get('state'), workspace = params.get('workspace');
  if (!RETURN_STATES.includes(state) || !returnWorkspace(workspace)) return '/';
  return `/?billing=${state}&workspace=${encodeURIComponent(workspace)}#settings/billing`;
}

/** Tiny no-store page: no app data, no script (CSP default-src 'self'); a meta refresh makes the next navigation same-site
 * so the SameSite=Strict session cookie is sent (the cross-site redirect from Stripe never carries it). */
export function billingReturnPage(searchParams) {
  const target = escapeHtml(billingReturnTarget(searchParams));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">`
    + `<meta http-equiv="refresh" content="0;url=${target}"><title>Elozi</title></head><body><p><a href="${target}">Continuar para o Elozi</a></p></body></html>`;
}

const requestIdOk = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(value);
const localeOf = value => { if (value !== 'pt-BR' && value !== 'en') invalid('Idioma inválido para a assinatura.'); return value; };
const sync = (fn, ...args) => { const value = fn(...args); if (value && typeof value.then === 'function') { value.catch?.(() => {}); fail(500, 'A assinatura exige persistência síncrona.'); } return value; };
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isoSeconds = value => Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
const pathLabel = path => String(path).split('/').slice(0, 3).join('/');

/** Reads configuration once; any missing or malformed value disables the feature. Secrets never leave this object. */
export function stripeConfig(env = process.env) {
  const secretKey = env.ELOZI_STRIPE_SECRET_KEY, webhookSecret = env.ELOZI_STRIPE_WEBHOOK_SECRET;
  const prices = Object.fromEntries(Object.entries(STRIPE_PLANS).map(([plan, terms]) => [plan, env[terms.env]]));
  const extraNumber = env[STRIPE_EXTRA_NUMBER_ENV];
  const ok = typeof secretKey === 'string' && /^(rk|sk)_(live|test)_[A-Za-z0-9]{8,}$/.test(secretKey)
    && typeof webhookSecret === 'string' && /^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(webhookSecret)
    && Object.values(prices).every(price => stripeId(price, 'price')) && stripeId(extraNumber, 'price')
    && new Set([...Object.values(prices), extraNumber]).size === 4;
  // Key mode decides which events are accepted: live keys only accept livemode:true events and vice versa.
  return ok ? { enabled: true, secretKey, webhookSecret, prices, extraNumber, livemode: /^(rk|sk)_live_/.test(secretKey) } : { enabled: false };
}

/** The canonical return origin: only the configured public origin (never the request Host). */
export function stripeReturnOrigin(publicOrigin) {
  if (typeof publicOrigin !== 'string' || !publicOrigin) return null;
  try { const url = new URL(publicOrigin); return ['https:', 'http:'].includes(url.protocol) && url.origin === publicOrigin.replace(/\/$/, '') ? url.origin : null; } catch { return null; }
}

/** Same switch for the billing API and the public site checkout copy: complete Stripe config + configured public origin. */
export function stripeCheckoutEnabled({ env = process.env, config, publicOrigin } = {}) {
  return (config || stripeConfig(env)).enabled === true && stripeReturnOrigin(publicOrigin) !== null;
}

/** Default REST transport: form-encoded Stripe API v1 over global fetch, pinned API version. Bodies never enter logs. */
export function stripeFetchTransport(secretKey, { fetchImpl = globalThis.fetch, timeoutMs = 15000, apiVersion = STRIPE_API_VERSION } = {}) {
  return async ({ method, path, form, idempotencyKey }) => {
    const response = await fetchImpl(`https://api.stripe.com${path}`, { method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': apiVersion,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  };
}

/** Verifies `Stripe-Signature` (t=, v1=) over the exact raw bytes. Returns the parsed JSON value or throws 400. */
export function verifyStripeSignature(rawBody, header, secret, nowSeconds, tolerance = STRIPE_SIGNATURE_TOLERANCE_S) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || header.length > 4096) fail(400, 'Assinatura do evento inválida.');
  if (!Number.isInteger(tolerance) || tolerance <= 0) fail(500, 'Tolerância de assinatura inválida.');
  let timestamp = null; const signatures = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('='); if (index < 1) continue;
    const key = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[a-f0-9]{64}$/.test(value)) signatures.push(Buffer.from(value, 'hex'));
  }
  if (timestamp === null || !signatures.length) fail(400, 'Assinatura do evento inválida.');
  // Rejects both stale and future-dated timestamps beyond the tolerance.
  if (Math.abs(nowSeconds - timestamp) > tolerance) fail(400, 'Assinatura do evento fora da janela de tempo.');
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  // Every candidate is compared (constant time per candidate); no early exit leaks which one matched.
  let valid = false;
  for (const signature of signatures) if (signature.length === expected.length && timingSafeEqual(signature, expected)) valid = true;
  if (!valid) fail(400, 'Assinatura do evento inválida.');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { fail(400, 'Evento inválido.'); }
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail(400, 'Evento inválido.');
  return event;
}

/**
 * Self-serve Stripe subscriptions for business workspaces billed directly by the platform.
 * The checkout return never grants anything: state comes only from verified webhooks, and every subscription or
 * invoice event re-reads the current Subscription from Stripe before applying it.
 * Entitlement = commercial lifecycle (the only access switch: the autopilot runs for `active` or an unexpired
 * `trial`) plus recorded plan quotas exposed through `subscriptionQuotas(workspaceId)` for quota enforcement.
 */
export class StripeBilling {
  constructor(accounts, { env = process.env, config, transport, now = Date.now, logger = console, publicOrigin = '', testLifecycle } = {}) {
    if (!accounts?.db || !accounts?.lifecycle || typeof accounts.lifecycle.applyBillingState !== 'function' || !identity(accounts.platformWorkspaceId)
      || ['actor', 'platform', 'accountRow', 'visible', 'transaction', 'audit'].some(name => typeof accounts[name] !== 'function') || typeof now !== 'function') throw new Error('A assinatura exige contas comerciais e relógio.');
    const settings = config || stripeConfig(env), origin = stripeReturnOrigin(publicOrigin);
    const allowList = new Set(String(env?.[STRIPE_TEST_LIFECYCLE_ENV] || '').split(',').map(item => item.trim()).filter(identity));
    Object.assign(this, { accounts, db: accounts.db, now, logger, origin, locks: new Map() });
    Object.defineProperty(this, 'config', { value: settings, enumerable: false });
    Object.defineProperty(this, 'transport', { value: settings.enabled ? transport || stripeFetchTransport(settings.secretKey) : null, enumerable: false });
    Object.defineProperty(this, 'testLifecycle', { value: typeof testLifecycle === 'function' ? testLifecycle : id => allowList.has(id), enumerable: false });
    this.mode = settings.enabled && settings.livemode ? 1 : 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS elozi_stripe_customers (
      workspace_id TEXT NOT NULL REFERENCES resellers(id), livemode INTEGER NOT NULL, customer_id TEXT NOT NULL UNIQUE,
      tax_id_kind TEXT, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, livemode)
    ); CREATE TABLE IF NOT EXISTS elozi_stripe_subscriptions (
      workspace_id TEXT NOT NULL REFERENCES resellers(id), livemode INTEGER NOT NULL, customer_id TEXT NOT NULL, subscription_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, plan TEXT, extra_numbers INTEGER NOT NULL DEFAULT 0, whatsapp_numbers INTEGER, users INTEGER,
      current_period_end TEXT, trial_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, payment_issue INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, livemode)
    ); CREATE TABLE IF NOT EXISTS elozi_stripe_ended (
      subscription_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, livemode INTEGER NOT NULL, ended_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS elozi_stripe_checkouts (
      workspace_id TEXT NOT NULL REFERENCES resellers(id), livemode INTEGER NOT NULL, session_id TEXT NOT NULL UNIQUE, plan TEXT NOT NULL,
      extra_numbers INTEGER NOT NULL, url TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, livemode)
    ); CREATE TABLE IF NOT EXISTS elozi_stripe_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS elozi_stripe_events (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, livemode INTEGER NOT NULL, workspace_id TEXT, outcome TEXT NOT NULL, received_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS elozi_stripe_audit (
      id TEXT PRIMARY KEY, workspace_id TEXT, event_id TEXT, actor_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS elozi_stripe_audit_workspace ON elozi_stripe_audit(workspace_id,created_at);`);
    if (!this.db.prepare('PRAGMA table_info(elozi_stripe_subscriptions)').all().some(column => column.name === 'provider_status')) {
      this.db.exec('ALTER TABLE elozi_stripe_subscriptions ADD COLUMN provider_status TEXT');
    }
  }

  get enabled() { return this.config.enabled === true && this.origin !== null; }
  timestamp() { const value = sync(this.now); if (!Number.isFinite(value)) fail(500, 'Relógio da assinatura inválido.'); return new Date(value).toISOString(); }
  nowSeconds() { return Math.floor(Date.parse(this.timestamp()) / 1000); }
  audit(workspaceId, eventId, actorId, action, detail = {}) {
    this.db.prepare('INSERT INTO elozi_stripe_audit VALUES (?,?,?,?,?,?,?)').run(randomUUID(), workspaceId ?? null, eventId ?? null, actorId ?? null, action, JSON.stringify(detail), this.timestamp());
  }
  /** In-process serialization per key (single runtime process): no interleaving of check-then-call sequences. */
  lock(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    const run = previous.then(task, task), tail = run.catch(() => {});
    this.locks.set(key, tail);
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  // --- Authorization ---------------------------------------------------------------------------------------------

  homeWorkspace(userId) {
    try { return this.db.prepare('SELECT reseller_id FROM auth_users WHERE id=?').get(userId)?.reseller_id ?? null; } catch { return null; }
  }
  manualContract(workspaceId) {
    try {
      return Boolean(this.db.prepare("SELECT 1 FROM billing_contracts WHERE target_workspace_id=? AND state='active' AND (ends_at IS NULL OR ends_at>=?) LIMIT 1").get(workspaceId, this.timestamp().slice(0, 10)));
    } catch { return false; }
  }
  /** Null when the actor may subscribe for this workspace; otherwise [status, message]. */
  denial(actor, account, { checkout = true } = {}) {
    if (account.accountKind === 'platform') return [403, 'A conta principal da plataforma não usa assinatura self-service.', 'billing_not_self_serve'];
    if (account.accountKind === 'reseller') return [403, 'Revendas e white-label seguem proposta comercial; a assinatura self-service é só para empresas.', 'billing_not_self_serve'];
    if (account.accountKind !== 'business' || account.parentWorkspaceId !== this.accounts.platformWorkspaceId) return [403, 'Esta empresa é cobrada pelo parceiro responsável, não pela assinatura self-service.', 'billing_not_self_serve'];
    // Own workspace only: no support grant, no service principal, no platform admin entering through workspace access.
    if (actor.role !== 'reseller' || actor.supportGrantId || actor.kind === 'service' || actor.resellerId !== account.id || this.homeWorkspace(actor.userId) !== account.id) {
      return [403, 'Somente o administrador da própria empresa gerencia a assinatura.', 'not_owner'];
    }
    if (checkout && this.manualContract(account.id)) return [409, 'Esta empresa tem um contrato comercial ativo. Fale com o comercial para alterar a contratação.', 'manual_contract'];
    return null;
  }
  scope(input, workspaceId, { manage, checkout = false }) {
    if (!identity(workspaceId)) invalid('Informe a empresa da assinatura.');
    const actor = this.accounts.actor(input, { admin: manage }), account = this.accounts.visible(actor, workspaceId);
    if (account.accountKind === 'platform' || account.accountKind === 'reseller') failCode(...this.denial(actor, account));
    const denied = this.denial(actor, account, { checkout: manage ? checkout : true });
    if (manage && denied) failCode(...denied);
    return { actor, account, canManage: !denied };
  }

  // --- Read model ------------------------------------------------------------------------------------------------

  subscriptionRow(workspaceId) { return this.db.prepare('SELECT * FROM elozi_stripe_subscriptions WHERE workspace_id=? AND livemode=?').get(workspaceId, this.mode) || null; }
  customerRow(workspaceId) { return this.db.prepare('SELECT * FROM elozi_stripe_customers WHERE workspace_id=? AND livemode=?').get(workspaceId, this.mode) || null; }
  customerId(workspaceId) { return this.customerRow(workspaceId)?.customer_id || null; }
  customerOwner(customerId) { return stripeId(customerId, 'cus') ? this.db.prepare('SELECT workspace_id FROM elozi_stripe_customers WHERE customer_id=? AND livemode=?').get(customerId, this.mode)?.workspace_id ?? null : null; }

  /** Persisted row even when the Stripe config is disabled (a missing env var must never switch enforcement off);
   * with a disabled config the live-mode row wins over a test-mode row. */
  storedSubscription(workspaceId) {
    if (this.config.enabled) return this.subscriptionRow(workspaceId);
    // Disabled config: only live rows, so a staging test subscription (shared database) never sets production limits;
    // test rows count only for workspaces explicitly allow-listed for test lifecycle.
    const live = this.db.prepare('SELECT * FROM elozi_stripe_subscriptions WHERE workspace_id=? AND livemode=1').get(workspaceId);
    if (live) return live;
    return this.testLifecycle(workspaceId) ? this.db.prepare('SELECT * FROM elozi_stripe_subscriptions WHERE workspace_id=? AND livemode=0').get(workspaceId) || null : null;
  }
  /** A row that ever reached a paid/trial state: incomplete (first payment pending) and incomplete_expired never did. */
  settled(row) { return Boolean(row && row.status !== 'incomplete' && row.provider_status !== 'incomplete_expired'); }
  signupWorkspace(workspaceId) {
    try { return Boolean(this.db.prepare('SELECT 1 FROM signup_trial_registrations WHERE workspace_id=?').get(workspaceId)); } catch { return false; }
  }

  /**
   * Quota contract for PlanQuotaGuard, synchronous: `{whatsappNumbers, users, plan, state}` or null.
   * - settled Stripe subscription with a known plan (any status, so canceled/unpaid keep the last plan): its quotas;
   * - public-signup workspace (signup_trial_registrations) without one (no row, incomplete, incomplete_expired):
   *   Conecta limits, during and after the trial, `default:true`;
   * - anything else (platform, partner-billed, legacy, manual contracts): null = unchanged.
   * Read regardless of the Stripe config switch.
   */
  subscriptionQuotas(workspaceId) {
    if (!identity(workspaceId)) return null;
    const row = this.storedSubscription(workspaceId);
    if (this.settled(row) && STRIPE_PLANS[row.plan] && Number.isSafeInteger(row.whatsapp_numbers) && Number.isSafeInteger(row.users)) {
      return { whatsappNumbers: row.whatsapp_numbers, users: row.users, plan: row.plan, state: row.status };
    }
    if (!this.signupWorkspace(workspaceId)) return null;
    // A signup that moved to a sales contract or under a partner is no longer self-serve: limits follow that contract.
    if (this.manualContract(workspaceId) || !this.selfServeAccount(workspaceId)) return null;
    const plan = STRIPE_PLANS[DEFAULT_SELF_SERVE_PLAN];
    return { whatsappNumbers: plan.whatsappNumbers, users: plan.users, plan: DEFAULT_SELF_SERVE_PLAN, state: row?.status === 'incomplete' ? 'incomplete' : this.defaultState(workspaceId), default: true };
  }
  selfServeAccount(workspaceId) {
    try { const account = this.accounts.accountRow(workspaceId); return account?.accountKind === 'business' && account.parentWorkspaceId === this.accounts.platformWorkspaceId; }
    catch { return false; }
  }
  defaultState(workspaceId) {
    try {
      const lifecycle = this.accounts.lifecycle.describe(this.accounts.accountRow(workspaceId), this.timestamp());
      return lifecycle.state === 'trial' && !lifecycle.trialExpired ? 'trialing' : 'none';
    } catch { return 'none'; }
  }

  overview(input, workspaceId) {
    const { account, canManage } = this.scope(input, workspaceId, { manage: false });
    const timestamp = this.timestamp(), stored = this.config.enabled ? this.subscriptionRow(account.id) : null;
    // incomplete_expired never became a subscription: shown as no subscription.
    const row = stored && stored.provider_status !== 'incomplete_expired' ? stored : null;
    const lifecycle = this.accounts.lifecycle.describe(account, timestamp);
    const live = Boolean(row && LIVE.includes(row.status));
    let state = row && STATES.includes(row.status) ? row.status : 'none';
    let trial = null;
    if (live && row.status === 'trialing' && row.trial_end) {
      trial = { expiresAt: row.trial_end, daysRemaining: Math.max(0, Math.ceil((Date.parse(row.trial_end) - Date.parse(timestamp)) / 86400000)) };
    } else if (!live && lifecycle.state === 'trial' && lifecycle.trialExpiresAt && !lifecycle.trialExpired) {
      trial = { expiresAt: lifecycle.trialExpiresAt, daysRemaining: lifecycle.daysRemaining };
      // Elozi trial without a Stripe subscription: trialing + plan:null (frontend contract).
      if (state === 'none' && !lifecycle.trialExpired) state = 'trialing';
    }
    return { enabled: this.enabled, workspaceId: account.id, state, plan: row && STRIPE_PLANS[row.plan] ? row.plan : null,
      extraNumbers: row && Number.isSafeInteger(row.extra_numbers) ? row.extra_numbers : 0,
      currentPeriodEnd: row?.current_period_end || null, cancelAtPeriodEnd: row?.cancel_at_period_end === 1, trial,
      trialExpired: !live && lifecycle.state === 'trial' && lifecycle.trialExpired === true,
      // Effective limits enforced by PlanQuotaGuard (same source), null = unlimited/unchanged.
      quotas: (quotas => quotas ? { whatsappNumbers: quotas.whatsappNumbers, users: quotas.users } : null)(this.subscriptionQuotas(account.id)),
      canManage: canManage && this.enabled, manualContract: this.manualContract(account.id) };
  }

  // --- Provider calls --------------------------------------------------------------------------------------------

  async call(request) {
    let response;
    try { response = await this.transport(request); } catch { this.logger?.error?.('Stripe indisponível.', { path: pathLabel(request.path) }); failCode(502, 'O provedor de pagamento não respondeu. Tente novamente.', 'billing_provider_error'); }
    if (!response || response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== 'object') {
      this.logger?.error?.('Stripe recusou a operação.', { path: pathLabel(request.path), status: response?.status ?? null, code: typeof response?.body?.error?.code === 'string' ? response.body.error.code.slice(0, 80) : null });
      failCode(502, 'O provedor de pagamento recusou a operação. Tente novamente ou fale com o suporte.', 'billing_provider_error');
    }
    if (typeof response.body.livemode === 'boolean' && response.body.livemode !== Boolean(this.mode)) failCode(502, 'O provedor de pagamento respondeu em outro modo.', 'billing_provider_error');
    return response.body;
  }
  key(kind, ...parts) { return `elozi-${kind}-${sha([kind, this.mode, ...parts])}`; }
  urls(workspaceId) {
    if (!this.origin) unavailable();
    const make = state => { const url = new URL('/billing/return', this.origin); url.searchParams.set('state', state); url.searchParams.set('workspace', workspaceId); return url.toString(); };
    return { success: make('success'), cancel: make('cancel'), portal: make('portal') };
  }

  /**
   * Billing e-mail = the workspace owner (first active admin registered in the workspace, i.e. the signup registrant),
   * falling back to the acting admin. Only syntactically valid addresses; null otherwise (never a placeholder).
   */
  ownerEmail(account, actor) {
    let owner = null;
    try {
      owner = this.db.prepare("SELECT email FROM auth_users WHERE reseller_id=? AND role='reseller' AND disabled_at IS NULL AND email IS NOT NULL AND email<>'' ORDER BY created_at, rowid LIMIT 1").get(account.id)?.email ?? null;
    } catch { owner = null; }
    return [owner, actor?.email].find(billingEmail) ?? null;
  }

  /**
   * Customers created before the e-mail was sent have none, and a Checkout bound to `customer` cannot take
   * customer_email: the address must be on the Customer. Set it once (never overwrite one already there); the
   * per-customer marker avoids repeating the read. Non-blocking: a failure keeps the checkout with an empty field.
   */
  async backfillCustomerEmail(account, customerId, email, actorId) {
    const marker = `customer_email:${customerId}`;
    if (!email || this.db.prepare('SELECT 1 FROM elozi_stripe_settings WHERE key=?').get(marker)) return;
    try {
      const current = await this.call({ method: 'GET', path: `/v1/customers/${encodeURIComponent(customerId)}` });
      if (current.id !== customerId || current.deleted === true) return;
      let state = 'present';
      if (!billingEmail(current.email)) {
        const updated = await this.call({ method: 'POST', path: `/v1/customers/${encodeURIComponent(customerId)}`, idempotencyKey: this.key('customer-email', customerId, email), form: { email } });
        if (updated.id !== customerId) return;
        state = 'set';
        this.audit(account.id, null, actorId, 'customer.email_set', {});
      }
      this.db.prepare('INSERT OR IGNORE INTO elozi_stripe_settings VALUES (?,?,?)').run(marker, state, this.timestamp());
    } catch { /* non-blocking; retried on the next new checkout */ }
  }

  /** Creates (once) and persists the Stripe Customer before any Checkout Session exists. */
  async ensureCustomer(account, actor) {
    const email = this.ownerEmail(account, actor), existing = this.customerId(account.id);
    if (existing) { await this.backfillCustomerEmail(account, existing, email, actor?.userId ?? SYSTEM_USER); return existing; }
    const customer = await this.call({ method: 'POST', path: '/v1/customers', idempotencyKey: email ? this.key('customer', account.id, email) : this.key('customer', account.id),
      form: { name: String(account.data?.name || 'Elozi').slice(0, 80), ...(email ? { email } : {}), 'metadata[elozi_workspace_id]': account.id, 'metadata[product]': 'elozi' } });
    if (!stripeId(customer.id, 'cus')) fail(502, 'O provedor de pagamento não retornou o cliente.');
    return this.accounts.transaction(() => {
      const raced = this.customerId(account.id);
      if (raced) return raced;
      const owner = this.db.prepare('SELECT workspace_id FROM elozi_stripe_customers WHERE customer_id=?').get(customer.id)?.workspace_id;
      if (owner && owner !== account.id) fail(409, 'O cadastro de cobrança pertence a outra empresa.');
      this.db.prepare('INSERT INTO elozi_stripe_customers (workspace_id,livemode,customer_id,tax_id_kind,created_at) VALUES (?,?,?,?,?)').run(account.id, this.mode, customer.id, null, this.timestamp());
      if (email) this.db.prepare('INSERT OR IGNORE INTO elozi_stripe_settings VALUES (?,?,?)').run(`customer_email:${customer.id}`, 'present', this.timestamp());
      this.audit(account.id, null, SYSTEM_USER, 'customer.created', { email: Boolean(email) });
      return customer.id;
    });
  }

  /** Signup trial with >=48h left: the Stripe trial ends exactly at the Elozi trial expiry (first charge then). */
  trialEnd(account) {
    const lifecycle = this.accounts.lifecycle.describe(account, this.timestamp()), raw = account.data?.commercialLifecycle;
    if (lifecycle.state !== 'trial' || lifecycle.trialExpired || !raw?.trialExpiresAt || lifecycle.trialExpiresAt !== raw.trialExpiresAt) return null;
    const expires = Date.parse(raw.trialExpiresAt);
    return expires - Date.parse(this.timestamp()) >= MIN_TRIAL_ALIGNMENT_MS ? Math.floor(expires / 1000) : null;
  }

  /** Shared validation of checkout/change orders. Never trusts client price ids: items derive from configured prices. */
  order(body) {
    fields(body, ['workspaceId', 'plan', 'extraNumbers', 'requestId', 'locale'], ['workspaceId', 'plan', 'requestId', 'locale']);
    if (typeof body.plan !== 'string' || !Object.hasOwn(STRIPE_PLANS, body.plan)) invalid('Escolha Conecta, Equipe ou Operação.');
    const extraNumbers = body.extraNumbers ?? 0;
    if (!Number.isInteger(extraNumbers) || extraNumbers < 0 || extraNumbers > 20) invalid('Escolha de 0 a 20 números adicionais.');
    if (!requestIdOk(body.requestId)) invalid('Identificador da solicitação inválido.');
    return { extraNumbers, locale: localeOf(body.locale) };
  }

  async checkout(input, body) {
    if (!this.enabled) unavailable();
    const { extraNumbers, locale } = this.order(body);
    this.scope(input, body.workspaceId, { manage: true, checkout: true });
    return this.lock(`checkout:${body.workspaceId}`, async () => {
      const { actor, account } = this.scope(input, body.workspaceId, { manage: true, checkout: true });
      const current = this.subscriptionRow(account.id);
      if (current && LIVE.includes(current.status)) failCode(409, 'Esta empresa já tem uma assinatura. Para mudar de plano ou de números, use “Alterar plano ou números” em Configurações › Financeiro.', 'subscription_exists');
      // A pending first payment (3DS/boleto-like confirmation) must finish before any second session: no double charge.
      if (current?.status === 'incomplete') failCode(409, 'Há um pagamento de assinatura pendente de confirmação. Conclua-o pela fatura enviada pela Stripe ou em Gerenciar assinatura, ou aguarde alguns minutos.', 'subscription_pending');
      const open = this.db.prepare('SELECT * FROM elozi_stripe_checkouts WHERE workspace_id=? AND livemode=?').get(account.id, this.mode);
      if (open && open.plan === body.plan && open.extra_numbers === extraNumbers && open.expires_at > this.nowSeconds() + REUSE_MARGIN_S) {
        this.audit(account.id, null, actor.userId, 'checkout.reused', { plan: body.plan, extraNumbers });
        return { url: open.url };
      }
      if (open) {
        const previous = await this.call({ method: 'GET', path: `/v1/checkout/sessions/${encodeURIComponent(open.session_id)}` });
        if (previous.status === 'complete') failCode(409, 'O pagamento anterior já foi concluído e está sendo confirmado. Aguarde alguns instantes.', 'billing_checkout_pending');
        if (previous.status === 'open') await this.call({ method: 'POST', path: `/v1/checkout/sessions/${encodeURIComponent(open.session_id)}/expire`, idempotencyKey: this.key('expire', open.session_id) });
        this.db.prepare('DELETE FROM elozi_stripe_checkouts WHERE workspace_id=? AND livemode=? AND session_id=?').run(account.id, this.mode, open.session_id);
        this.audit(account.id, null, actor.userId, 'checkout.replaced', { previousStatus: typeof previous.status === 'string' ? previous.status.slice(0, 20) : null });
      }
      const customer = await this.ensureCustomer(account, actor), urls = this.urls(account.id), trialEnd = this.trialEnd(account);
      const form = { mode: 'subscription', customer, client_reference_id: account.id, locale, currency: 'brl', 'payment_method_types[0]': 'card',
        success_url: urls.success, cancel_url: urls.cancel,
        'metadata[elozi_workspace_id]': account.id, 'subscription_data[metadata][elozi_workspace_id]': account.id,
        'custom_fields[0][key]': 'tax_id', 'custom_fields[0][type]': 'text', 'custom_fields[0][label][type]': 'custom',
        'custom_fields[0][label][custom]': locale === 'en' ? 'CPF or CNPJ (Brazilian tax ID)' : 'CPF ou CNPJ',
        'custom_fields[0][text][minimum_length]': '11', 'custom_fields[0][text][maximum_length]': '18',
        'line_items[0][price]': this.config.prices[body.plan], 'line_items[0][quantity]': '1',
        ...(extraNumbers > 0 ? { 'line_items[1][price]': this.config.extraNumber, 'line_items[1][quantity]': String(extraNumbers) } : {}),
        ...(trialEnd ? { 'subscription_data[trial_end]': String(trialEnd) } : {}) };
      const session = await this.call({ method: 'POST', path: '/v1/checkout/sessions', form,
        idempotencyKey: this.key('checkout', actor.userId, account.id, body.requestId, body.plan, extraNumbers, trialEnd) });
      if (!stripeId(session.id, 'cs') || typeof session.url !== 'string' || !session.url.startsWith('https://')) fail(502, 'O provedor de pagamento não retornou o checkout.');
      const expiresAt = Number.isSafeInteger(session.expires_at) ? session.expires_at : this.nowSeconds() + 1800;
      this.accounts.transaction(() => {
        this.db.prepare(`INSERT INTO elozi_stripe_checkouts VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,livemode) DO UPDATE SET session_id=excluded.session_id,
          plan=excluded.plan,extra_numbers=excluded.extra_numbers,url=excluded.url,expires_at=excluded.expires_at,created_at=excluded.created_at`)
          .run(account.id, this.mode, session.id, body.plan, extraNumbers, session.url, expiresAt, this.timestamp());
        this.audit(account.id, null, actor.userId, 'checkout.created', { plan: body.plan, extraNumbers, trialAligned: Boolean(trialEnd) });
      });
      return { url: session.url };
    });
  }

  /** Dedicated Elozi portal configuration, created lazily once per key mode. */
  async portalConfiguration() {
    const name = `portal_configuration:${this.mode}`, stored = this.db.prepare('SELECT value FROM elozi_stripe_settings WHERE key=?').get(name)?.value;
    if (stored) return stored;
    const configuration = await this.call({ method: 'POST', path: '/v1/billing_portal/configurations', idempotencyKey: this.key('portal-configuration', 'v1'),
      form: { 'features[invoice_history][enabled]': 'true', 'features[payment_method_update][enabled]': 'true',
        'features[subscription_cancel][enabled]': 'true', 'features[subscription_cancel][mode]': 'at_period_end',
        'features[subscription_cancel][proration_behavior]': 'none', 'features[subscription_update][enabled]': 'false',
        'features[customer_update][enabled]': 'false', 'metadata[elozi]': 'portal-v1' } });
    if (!stripeId(configuration.id, 'bpc')) fail(502, 'O provedor de pagamento não retornou a configuração do portal.');
    this.db.prepare('INSERT OR IGNORE INTO elozi_stripe_settings VALUES (?,?,?)').run(name, configuration.id, this.timestamp());
    return this.db.prepare('SELECT value FROM elozi_stripe_settings WHERE key=?').get(name).value;
  }

  async portal(input, body) {
    if (!this.enabled) unavailable();
    fields(body, ['workspaceId', 'requestId', 'locale']);
    if (!requestIdOk(body.requestId)) invalid('Identificador da solicitação inválido.');
    const locale = localeOf(body.locale), { actor, account } = this.scope(input, body.workspaceId, { manage: true });
    const customer = this.customerId(account.id);
    if (!customer) failCode(404, 'Esta empresa ainda não tem cadastro de cobrança. Assine um plano primeiro.', 'billing_no_customer');
    const configuration = await this.lock('portal-configuration', () => this.portalConfiguration());
    const session = await this.call({ method: 'POST', path: '/v1/billing_portal/sessions', form: { customer, configuration, return_url: this.urls(account.id).portal, locale },
      idempotencyKey: this.key('portal', actor.userId, account.id, body.requestId) });
    if (typeof session.url !== 'string' || !session.url.startsWith('https://')) fail(502, 'O provedor de pagamento não retornou o portal.');
    this.audit(account.id, null, actor.userId, 'portal.created', {});
    return { url: session.url };
  }

  /**
   * Plan / extra-number change of a live (active|trialing|past_due) subscription, by the workspace owner only (same
   * authz, per-workspace lock and idempotency discipline as checkout). Items derive from configured price ids and the
   * CURRENT Subscription re-read from Stripe; the provider answer is applied through the webhook path
   * (applySubscription). Downgrades below usage are allowed: nothing is disconnected, new connections stay blocked.
   * Response = GET /api/billing/subscription shape.
   */
  async change(input, body) {
    if (!this.enabled) unavailable();
    const { extraNumbers } = this.order(body);
    this.scope(input, body.workspaceId, { manage: true, checkout: true });
    return this.lock(`checkout:${body.workspaceId}`, async () => {
      const { actor, account } = this.scope(input, body.workspaceId, { manage: true, checkout: true });
      const current = this.subscriptionRow(account.id);
      if (!current || !LIVE.includes(current.status)) failCode(409, 'Esta empresa não tem uma assinatura ativa para alterar. Assine um plano em Configurações › Financeiro.', 'billing_no_subscription');
      const requestKey = this.key('change', actor.userId, account.id, body.requestId, body.plan, extraNumbers, current.subscription_id);
      const settingKey = `change:${this.mode}:${account.id}`;
      const same = current.plan === body.plan && current.extra_numbers === extraNumbers;
      // Replay of an already applied request (lost response, double click): same answer, no provider call.
      if (same && this.db.prepare('SELECT value FROM elozi_stripe_settings WHERE key=?').get(settingKey)?.value === requestKey) return this.overview(input, account.id);
      if (same) failCode(400, 'Esse já é o plano e a quantidade de números da assinatura atual.', 'same_order');
      const subscription = await this.call({ method: 'GET', path: `/v1/subscriptions/${encodeURIComponent(current.subscription_id)}` });
      if (subscription.id !== current.subscription_id || idOf(subscription.customer) !== current.customer_id || !LIVE.includes(STATUS_MAP[subscription.status])) {
        failCode(409, 'A assinatura mudou de situação. Atualize a página e tente novamente.', 'billing_no_subscription');
      }
      const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
      const planPrices = Object.values(this.config.prices), planItems = items.filter(item => planPrices.includes(idOf(item?.price)));
      const extraItems = items.filter(item => idOf(item?.price) === this.config.extraNumber);
      if (planItems.length !== 1 || extraItems.length > 1 || planItems.length + extraItems.length !== items.length || ![...planItems, ...extraItems].every(item => stripeId(item?.id, 'si'))) {
        failCode(409, 'Esta assinatura tem itens que não conseguimos alterar por aqui. Fale com o suporte.', 'billing_unsupported_items');
      }
      const form = { proration_behavior: 'create_prorations', 'metadata[elozi_workspace_id]': account.id,
        'items[0][id]': planItems[0].id, 'items[0][price]': this.config.prices[body.plan], 'items[0][quantity]': '1' };
      if (extraItems.length && extraNumbers > 0) Object.assign(form, { 'items[1][id]': extraItems[0].id, 'items[1][quantity]': String(extraNumbers) });
      else if (extraItems.length) Object.assign(form, { 'items[1][id]': extraItems[0].id, 'items[1][deleted]': 'true' });
      else if (extraNumbers > 0) Object.assign(form, { 'items[1][price]': this.config.extraNumber, 'items[1][quantity]': String(extraNumbers) });
      const updated = await this.call({ method: 'POST', path: `/v1/subscriptions/${encodeURIComponent(current.subscription_id)}`, form, idempotencyKey: requestKey });
      const event = { id: `change_${requestKey.slice(-32)}`, type: 'billing.change' };
      const result = this.accounts.transaction(() => {
        const applied = this.applySubscription(event, account, updated);
        this.db.prepare('INSERT INTO elozi_stripe_settings VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(settingKey, requestKey, this.timestamp());
        this.audit(account.id, null, actor.userId, 'subscription.changed', { from: { plan: current.plan, extraNumbers: current.extra_numbers }, to: { plan: body.plan, extraNumbers }, outcome: applied.outcome });
        return applied;
      });
      // A provider answer we could not apply is reconciled by the customer.subscription.updated webhook.
      if (!String(result.outcome).startsWith('subscription:')) this.logger?.error?.('Alteração de assinatura aguardando webhook.', { outcome: String(result.outcome).slice(0, 60) });
      return this.overview(input, account.id);
    });
  }

  // --- Webhook ---------------------------------------------------------------------------------------------------

  processed(eventId) { return Boolean(this.db.prepare('SELECT 1 FROM elozi_stripe_events WHERE id=?').get(eventId)); }

  async receiveWebhook(rawBody, signature) {
    // Disabled -> 503 so Stripe retries later instead of losing the event.
    if (!this.config.enabled) unavailable();
    const event = verifyStripeSignature(rawBody, signature, this.config.webhookSecret, this.nowSeconds());
    const eventId = stripeId(event.id, 'evt') ? event.id : null;
    // Snapshot events only: thin events (no data.object) are rejected so the destination gets fixed, not silently ignored.
    if (!eventId || event.object !== 'event' || typeof event.type !== 'string' || !event.data || typeof event.data.object !== 'object' || event.data.object === null || Array.isArray(event.data.object)) {
      this.audit(null, eventId, SYSTEM_USER, 'webhook.rejected', { reason: 'not-snapshot-event' });
      fail(400, 'Evento inválido: use um destino Snapshot.');
    }
    if (event.livemode !== Boolean(this.mode)) {
      this.audit(null, eventId, SYSTEM_USER, 'webhook.rejected', { reason: 'livemode-mismatch', type: event.type.slice(0, 120) });
      fail(400, 'Evento de outro modo da Stripe.');
    }
    return this.lock('webhook', async () => {
      if (this.processed(event.id)) return { received: true, duplicate: true };
      // Provider reads happen before the transaction; a failure (502) leaves the event unrecorded so Stripe retries.
      const context = HANDLED.includes(event.type) ? await this.prefetch(event) : {};
      // The event id is recorded in the same transaction as its effects: processed only after the effect commits.
      return this.accounts.transaction(() => {
        if (this.processed(event.id)) return { received: true, duplicate: true };
        const result = HANDLED.includes(event.type) ? this.dispatch(event, context) : { outcome: 'ignored' };
        this.db.prepare('INSERT INTO elozi_stripe_events VALUES (?,?,?,?,?,?)').run(event.id, event.type.slice(0, 120), this.mode, result.workspaceId ?? null, result.outcome, this.timestamp());
        return { received: true, outcome: result.outcome };
      });
    });
  }

  references(event) {
    const object = event.data.object;
    if (event.type === 'checkout.session.completed') return { customer: idOf(object.customer), subscription: idOf(object.subscription), metadata: object.metadata || null };
    if (event.type.startsWith('customer.subscription.')) return { customer: idOf(object.customer), subscription: idOf(object.id), metadata: object.metadata || null };
    return { customer: idOf(object.customer), subscription: idOf(object.subscription) || idOf(object.parent?.subscription_details?.subscription),
      metadata: object.subscription_details?.metadata || object.parent?.subscription_details?.metadata || null };
  }

  async prefetch(event) {
    const refs = this.references(event), owner = this.customerOwner(refs.customer);
    if (!owner) return { refs };
    const context = { refs, owner };
    // Proven divergence (event claims another workspace): ignored in dispatch without any provider call.
    if (refs.metadata?.elozi_workspace_id !== undefined && refs.metadata.elozi_workspace_id !== owner) return context;
    if (event.type === 'checkout.session.completed' && event.data.object.client_reference_id !== owner) return context;
    if (stripeId(refs.subscription, 'sub')) context.subscription = await this.call({ method: 'GET', path: `/v1/subscriptions/${encodeURIComponent(refs.subscription)}` });
    if (event.type === 'checkout.session.completed') context.taxId = await this.saveTaxId(event, owner, refs.customer);
    return context;
  }

  /** CPF/CNPJ from the Checkout custom field -> customer tax id (br_cpf/br_cnpj). Never logged or stored locally. */
  async saveTaxId(event, workspaceId, customer) {
    if (this.customerRow(workspaceId)?.tax_id_kind) return 'already-saved';
    const field = Array.isArray(event.data.object.custom_fields) ? event.data.object.custom_fields.find(item => item?.key === 'tax_id') : null;
    const value = field?.text?.value;
    if (typeof value !== 'string' || !value.trim()) return 'missing';
    let normalized;
    try { normalized = normalizeFiscalDocument(value); } catch { return 'invalid'; }
    const digits = normalized.document, formatted = normalized.kind === 'cpf'
      ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
      : `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
    // Non-blocking: a tax id failure must not hold back the subscription; it is audited for follow-up.
    try {
      await this.call({ method: 'POST', path: `/v1/customers/${encodeURIComponent(customer)}/tax_ids`, idempotencyKey: this.key('tax-id', event.id),
        form: { type: normalized.kind === 'cpf' ? 'br_cpf' : 'br_cnpj', value: formatted } });
    } catch { return 'failed'; }
    return `saved:${normalized.kind}`;
  }

  ignore(event, workspaceId, reason, detail = {}) {
    this.audit(workspaceId, event.id, SYSTEM_USER, 'webhook.ignored', { type: event.type, reason, ...detail });
    return { outcome: `ignored:${reason}`, workspaceId };
  }

  dispatch(event, context) {
    const { refs } = context, object = event.data.object;
    if (event.type === 'checkout.session.completed' && object.mode !== 'subscription') return { outcome: 'ignored' };
    if (!context.owner) {
      // Unknown customer (another product on a shared account, or never created by Elozi): recorded, never bound.
      const claimed = refs.metadata?.elozi_workspace_id ?? (event.type === 'checkout.session.completed' ? object.client_reference_id : undefined);
      if (claimed !== undefined && claimed !== null) return this.ignore(event, null, 'unbound-customer');
      return { outcome: 'ignored:unbound-customer' };
    }
    const account = this.accounts.accountRow(context.owner);
    if (refs.metadata?.elozi_workspace_id !== undefined && refs.metadata.elozi_workspace_id !== account.id) return this.ignore(event, account.id, 'metadata-mismatch');
    if (event.type === 'checkout.session.completed') {
      if (object.client_reference_id !== account.id) return this.ignore(event, account.id, 'metadata-mismatch');
      if (stripeId(idOf(object.id), 'cs')) this.db.prepare('DELETE FROM elozi_stripe_checkouts WHERE workspace_id=? AND livemode=? AND session_id=?').run(account.id, this.mode, idOf(object.id));
      if (context.taxId?.startsWith('saved:')) this.db.prepare('UPDATE elozi_stripe_customers SET tax_id_kind=? WHERE workspace_id=? AND livemode=?').run(context.taxId.slice(6), account.id, this.mode);
      this.audit(account.id, event.id, SYSTEM_USER, 'checkout.completed', { taxId: context.taxId ?? 'skipped' });
      if (!context.subscription) return { outcome: 'bound', workspaceId: account.id };
    }
    if (!context.subscription) return this.ignore(event, account.id, 'no-subscription');
    return this.applySubscription(event, account, context.subscription);
  }

  terms(subscription) {
    const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
    let plan = null, extraNumbers = 0;
    for (const item of items) {
      const price = idOf(item?.price), quantity = Number.isSafeInteger(item?.quantity) ? item.quantity : 1;
      const match = Object.entries(this.config.prices).find(([, id]) => id === price)?.[0];
      if (match) { if (plan || quantity !== 1) return null; plan = match; }
      else if (price === this.config.extraNumber) { if (quantity < 0 || quantity > 100) return null; extraNumbers += quantity; }
      else return null;
    }
    return plan ? { plan, extraNumbers } : null;
  }

  /** Applies the CURRENT Subscription (fetched from Stripe), never the event payload. Plan/extras come from price ids. */
  applySubscription(event, account, subscription) {
    if (!stripeId(subscription.id, 'sub')) return this.ignore(event, account.id, 'invalid-subscription');
    if (idOf(subscription.customer) !== this.customerId(account.id)) return this.ignore(event, account.id, 'customer-mismatch');
    if (subscription.metadata?.elozi_workspace_id !== undefined && subscription.metadata.elozi_workspace_id !== account.id) return this.ignore(event, account.id, 'metadata-mismatch');
    if (account.accountKind !== 'business' || account.parentWorkspaceId !== this.accounts.platformWorkspaceId) return this.ignore(event, account.id, 'not-self-serve');
    const status = STATUS_MAP[subscription.status];
    if (!status) return this.ignore(event, account.id, 'unknown-status');
    const owner = this.db.prepare('SELECT workspace_id FROM elozi_stripe_subscriptions WHERE subscription_id=?').get(subscription.id)?.workspace_id;
    if (owner && owner !== account.id) return this.ignore(event, account.id, 'subscription-mismatch');
    // canceled is terminal per subscription id.
    if (status !== 'canceled' && this.db.prepare('SELECT 1 FROM elozi_stripe_ended WHERE subscription_id=?').get(subscription.id)) return this.ignore(event, account.id, 'terminal-subscription');
    if (status === 'canceled') this.db.prepare('INSERT OR IGNORE INTO elozi_stripe_ended VALUES (?,?,?,?)').run(subscription.id, account.id, this.mode, this.timestamp());
    const current = this.subscriptionRow(account.id);
    if (current && current.subscription_id !== subscription.id) {
      // A second subscription never replaces or adds to the one in force: alert, no entitlement change.
      if (LIVE.includes(current.status) && LIVE.includes(status)) { this.audit(account.id, event.id, SYSTEM_USER, 'subscription.duplicate-alert', { status }); return this.ignore(event, account.id, 'second-subscription'); }
      if (!LIVE.includes(status)) return this.ignore(event, account.id, 'other-subscription-ended');
    }
    const terms = this.terms(subscription);
    if (!terms) return this.ignore(event, account.id, 'unknown-price');
    const plan = STRIPE_PLANS[terms.plan], periodEnd = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
    const cancelAtPeriodEnd = subscription.cancel_at_period_end === true || (Number.isSafeInteger(subscription.cancel_at) && status !== 'canceled');
    this.db.prepare(`INSERT INTO elozi_stripe_subscriptions (workspace_id,livemode,customer_id,subscription_id,status,plan,extra_numbers,whatsapp_numbers,users,current_period_end,trial_end,cancel_at_period_end,payment_issue,updated_at,provider_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,livemode) DO UPDATE SET customer_id=excluded.customer_id,subscription_id=excluded.subscription_id,status=excluded.status,plan=excluded.plan,
      extra_numbers=excluded.extra_numbers,whatsapp_numbers=excluded.whatsapp_numbers,users=excluded.users,current_period_end=excluded.current_period_end,trial_end=excluded.trial_end,
      cancel_at_period_end=excluded.cancel_at_period_end,payment_issue=excluded.payment_issue,updated_at=excluded.updated_at,provider_status=excluded.provider_status`)
      .run(account.id, this.mode, idOf(subscription.customer), subscription.id, status, terms.plan, terms.extraNumbers, plan.whatsappNumbers + terms.extraNumbers, plan.users,
        isoSeconds(periodEnd), status === 'trialing' ? isoSeconds(subscription.trial_end) : null, cancelAtPeriodEnd ? 1 : 0, status === 'past_due' ? 1 : 0, this.timestamp(), subscription.status);
    this.audit(account.id, event.id, SYSTEM_USER, 'subscription.synced', { status, plan: terms.plan, extraNumbers: terms.extraNumbers });
    // incomplete_expired never started (first payment abandoned): no pause of the workspace (e.g. a running signup trial).
    if (subscription.status !== 'incomplete_expired') this.applyEntitlement(event, account.id, status);
    return { outcome: `subscription:${status}`, workspaceId: account.id };
  }

  /**
   * active/trialing/past_due -> lifecycle active; canceled/unpaid -> paused; incomplete -> unchanged. Written through
   * CommercialLifecycle.applyBillingState (CAS, version, Postgres projection, audit), which never overrides archived
   * or a pause recorded by a person. Test-mode keys only touch allow-listed workspaces (staging shares real data).
   */
  applyEntitlement(event, workspaceId, status) {
    const target = LIVE.includes(status) ? 'active' : ['canceled', 'unpaid'].includes(status) ? 'paused' : null;
    if (!target) return;
    if (!this.mode && !this.testLifecycle(workspaceId)) { this.audit(workspaceId, event.id, SYSTEM_USER, 'entitlement.skipped', { reason: 'test-mode', target }); return; }
    const result = this.accounts.lifecycle.applyBillingState(workspaceId, target, { source: 'stripe', status, eventId: event.id });
    this.audit(workspaceId, event.id, SYSTEM_USER, result.applied ? 'entitlement.applied' : 'entitlement.skipped', { target, status, reason: result.reason ?? null });
  }
}
