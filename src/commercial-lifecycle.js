import { fail } from './store.js';

export const COMMERCIAL_STATES = Object.freeze(['active', 'trial', 'paused', 'archived']);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/\p{Cc}/u.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sync = (fn, ...args) => {
  const value = fn(...args);
  if (value && typeof value.then === 'function') { value.catch?.(() => {}); fail(500, 'A atualização comercial exige persistência síncrona.'); }
  return value;
};

/** Commercial state records an agreement; it never changes access, billing, channels or customer data. */
export class CommercialLifecycle {
  constructor(accounts) {
    if (!accounts?.db || !accounts?.store || ['actor', 'platform', 'accountRow', 'visible', 'transaction', 'audit', 'timestamp'].some(name => typeof accounts[name] !== 'function')) {
      throw new Error('O ciclo comercial exige a gestão de contas e sua autorização síncrona.');
    }
    this.accounts = accounts;
    this.db = accounts.db;
  }

  timestamp() {
    let value;
    try { value = this.accounts.timestamp(); } catch (error) { if (!(error instanceof RangeError)) throw error; }
    if (!validInstant(value)) fail(500, 'Relógio comercial inválido.');
    return value;
  }

  metadata(account) {
    const value = account.data.commercialLifecycle;
    if (value === undefined || value === null) return { state: 'active', trialStartsAt: null, trialEndsAt: null, changedAt: null, changedBy: null, reason: null };
    if (typeof value !== 'object' || Array.isArray(value) || !COMMERCIAL_STATES.includes(value.state)
      || (value.trialStartsAt !== null && !validDate(value.trialStartsAt)) || (value.trialEndsAt !== null && !validDate(value.trialEndsAt))
      || Boolean(value.trialStartsAt) !== Boolean(value.trialEndsAt) || (value.trialStartsAt && value.trialStartsAt > value.trialEndsAt)
      || (value.trialExpiresAt !== undefined && value.trialExpiresAt !== null && (!validInstant(value.trialExpiresAt)
        || value.trialExpiresAt.slice(0, 10) !== value.trialEndsAt || value.trialExpiresAt.slice(0, 10) < value.trialStartsAt))
      || (value.state === 'trial' && !value.trialEndsAt) || !validInstant(value.changedAt)
      || !value.changedBy || !identity(value.changedBy.userId) || !identity(value.changedBy.workspaceId)
      || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 || /\p{Cc}/u.test(value.reason)) {
      fail(500, 'O registro do ciclo comercial está inválido. Preserve os dados e revise a conta.');
    }
    return { state: value.state, trialStartsAt: value.trialStartsAt, trialEndsAt: value.trialEndsAt, changedAt: value.changedAt,
      changedBy: { userId: value.changedBy.userId, workspaceId: value.changedBy.workspaceId }, reason: value.reason,
      ...(value.trialExpiresAt ? { trialExpiresAt: value.trialExpiresAt } : {}) };
  }

  /** The caller has already scoped the account; this helper adds no operational permission. */
  describe(account, timestamp = this.timestamp()) {
    const metadata = this.metadata(account);
    const expires = metadata.trialExpiresAt ? Date.parse(metadata.trialExpiresAt)
      : metadata.trialEndsAt ? Date.parse(`${metadata.trialEndsAt}T00:00:00Z`) + 86400000 : null;
    return { ...metadata, version: account.version, trialExpired: metadata.state === 'trial' && Date.parse(timestamp) >= expires,
      ...(metadata.state === 'trial' ? { trialExpiresAt: new Date(expires).toISOString(), daysRemaining: Math.max(0, Math.ceil((expires - Date.parse(timestamp)) / 86400000)), serverTime: timestamp } : {}) };
  }

  canManage(actor, account) {
    if (account.accountKind === 'platform') return false;
    if (this.accounts.platform(actor)) return true;
    const own = this.accounts.accountRow(actor.resellerId);
    return own.accountKind === 'reseller' && account.accountKind === 'business' && account.parentWorkspaceId === own.id;
  }

  overview(input, id = input?.resellerId) {
    const actor = this.accounts.actor(input), account = this.accounts.visible(actor, id);
    return { workspaceId: account.id, ...this.describe(account), canManage: this.canManage(actor, account) };
  }

  update(inputActor, id, input) {
    const allowed = ['version', 'state', 'trialEndsAt', 'reason'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os campos do ciclo comercial.');
    if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version >= Number.MAX_SAFE_INTEGER) fail(400, 'Informe a revisão atual da conta.');
    if (!COMMERCIAL_STATES.includes(input.state)) fail(400, 'Estado comercial inválido.');
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 500 || /\p{Cc}/u.test(input.reason)) fail(400, 'Registre um motivo válido para a alteração comercial.');
    if (input.state === 'trial' ? !validDate(input.trialEndsAt) : input.trialEndsAt !== undefined && input.trialEndsAt !== null) fail(400, 'Informe uma data final válida somente para o período de teste.');
    const firstActor = this.accounts.actor(inputActor), first = this.accounts.visible(firstActor, id);
    if (!this.canManage(firstActor, first)) fail(403, 'Somente o responsável comercial altera o estado desta conta.');
    return this.accounts.transaction(() => {
      const actor = this.accounts.actor(inputActor);
      if (actor.userId !== firstActor.userId || actor.resellerId !== firstActor.resellerId) fail(403, 'O acesso comercial mudou. Abra a conta novamente.');
      const previous = this.accounts.visible(actor, id);
      if (!this.canManage(actor, previous)) fail(403, 'Somente o responsável comercial altera o estado desta conta.');
      if (previous.version !== input.version) fail(409, 'A conta mudou. Atualize antes de alterar o estado comercial.');
      const timestamp = this.timestamp(), current = this.metadata(previous), today = timestamp.slice(0, 10);
      if (input.state === 'trial' && input.trialEndsAt < today) fail(400, 'O período de teste precisa terminar hoje ou em uma data futura.');
      const trialEndsAt = input.state === 'trial' ? input.trialEndsAt : current.trialEndsAt;
      if (current.state === input.state && current.trialEndsAt === trialEndsAt) {
        return { lifecycle: { workspaceId: id, ...this.describe(previous, timestamp), canManage: true }, unchanged: true };
      }
      const lifecycle = { ...previous.data.commercialLifecycle, state: input.state,
        trialStartsAt: input.state === 'trial' ? current.trialStartsAt || today : current.trialStartsAt, trialEndsAt,
        changedAt: timestamp, changedBy: { userId: actor.userId, workspaceId: actor.resellerId }, reason: input.reason.trim() };
      // A changed date chosen by the commercial owner replaces the exact signup deadline.
      if (input.state === 'trial' && trialEndsAt !== current.trialEndsAt) delete lifecycle.trialExpiresAt;
      const data = { ...previous.data, commercialLifecycle: lifecycle, version: previous.version + 1 };
      const result = this.db.prepare('UPDATE resellers SET data=? WHERE id=? AND data=?').run(JSON.stringify(data), id, previous.rawData);
      if (result.changes !== 1) fail(409, 'A conta mudou. Atualize antes de alterar o estado comercial.');
      for (const tenant of this.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(id)) {
        if (this.accounts.store.queuePostgres) sync(this.accounts.store.queuePostgres.bind(this.accounts.store), tenant.id);
      }
      const final = this.accounts.accountRow(id);
      this.accounts.audit(actor, final, `account.lifecycle.${input.state}`, previous.version);
      return { lifecycle: { workspaceId: id, ...this.describe(final, timestamp), canManage: true }, unchanged: false };
    });
  }

  /**
   * System transition driven by verified billing events (Stripe webhook). Runs inside the caller's transaction and
   * uses the same CAS/version/Postgres projection/audit as `update`. Moves only among trial/active/paused; never
   * overrides `archived` nor a pause recorded by a person (the pause source is `changedBy.userId`).
   * The manual `update` path is unchanged.
   */
  applyBillingState(id, target, { source, status, eventId } = {}) {
    const systemUser = `${source}-webhook`;
    if (source !== 'stripe' || !['active', 'paused'].includes(target) || typeof status !== 'string' || !/^[a-z_]{1,40}$/.test(status) || !identity(eventId)) fail(500, 'Transição comercial de sistema inválida.');
    if (this.db.isTransaction !== true) fail(500, 'A transição comercial de sistema exige a transação do evento.');
    const previous = this.accounts.accountRow(id), current = this.metadata(previous);
    if (current.state === 'archived') return { applied: false, reason: 'archived' };
    if (current.state === 'paused' && current.changedBy?.userId !== systemUser) return { applied: false, reason: 'manual-pause' };
    if (!['trial', 'active', 'paused'].includes(current.state)) return { applied: false, reason: 'unsupported-state' };
    if (current.state === target) return { applied: false, reason: 'unchanged' };
    const timestamp = this.timestamp(), platformWorkspaceId = this.accounts.platformWorkspaceId;
    const lifecycle = { ...previous.data.commercialLifecycle, state: target, trialStartsAt: current.trialStartsAt, trialEndsAt: current.trialEndsAt,
      changedAt: timestamp, changedBy: { userId: systemUser, workspaceId: platformWorkspaceId }, reason: `Assinatura ${source}: ${status}` };
    const data = { ...previous.data, commercialLifecycle: lifecycle, version: previous.version + 1 };
    const result = this.db.prepare('UPDATE resellers SET data=? WHERE id=? AND data=?').run(JSON.stringify(data), id, previous.rawData);
    if (result.changes !== 1) fail(409, 'A conta mudou durante o evento de cobrança.');
    const final = this.accounts.accountRow(id);
    this.metadata(final); // the written record must stay readable by describe()/listings; throws (and rolls back) otherwise
    for (const tenant of this.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(id)) {
      if (this.accounts.store.queuePostgres) sync(this.accounts.store.queuePostgres.bind(this.accounts.store), tenant.id);
    }
    this.accounts.audit({ userId: systemUser, resellerId: platformWorkspaceId }, final, `account.lifecycle.${target}`, previous.version);
    return { applied: true, state: target, version: final.version };
  }
}
