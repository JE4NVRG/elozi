import { createHash, randomUUID } from 'node:crypto';
import { Billing } from './billing.js';
import { fail } from './store.js';

export const COMMERCIAL_PLAN_STATES = Object.freeze(['active', 'archived']);
export const COMMERCIAL_PLAN_TARGETS = Object.freeze(['business', 'reseller']);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/\p{Cc}/u.test(value);
const fields = (value, allowed) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'Informe somente os campos desta operação de planos.'); };
const label = (value, name, max = 160) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /\p{Cc}/u.test(value)) fail(400, `${name} inválido.`); return value.trim(); };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail(400, 'Informe a revisão atual do plano e da conta.'); return value; };
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
const ordered = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const copy = value => JSON.parse(JSON.stringify(value));
const termsFields = ['name', 'targetKind', 'state', 'currency', 'periodMonths', 'items', 'quotas'];
const sync = (fn, ...args) => { const value = fn(...args); if (value && typeof value.then === 'function') { value.catch?.(() => {}); fail(500, 'A atualização de planos exige persistência síncrona.'); } return value; };

/** Reusable commercial terms only: no invoice, payment, provisioning or operational grant. */
export class CommercialPlans {
  constructor(accounts) {
    if (!accounts?.db || !accounts?.store || !identity(accounts.platformWorkspaceId)
      || ['actor', 'platform', 'accountRow', 'visible', 'transaction', 'audit', 'timestamp'].some(name => typeof accounts[name] !== 'function')) throw new Error('O catálogo exige a gestão de contas comerciais.');
    this.accounts = accounts;
    this.db = accounts.db;
  }

  timestamp() {
    let value;
    try { value = this.accounts.timestamp(); } catch (error) { if (!(error instanceof RangeError)) throw error; }
    if (!instant(value)) fail(500, 'Relógio do catálogo inválido.');
    return value;
  }

  // Reuse the actual Billing validators without constructing Billing or changing its schema.
  items(value) { return Billing.prototype.items.call(this, value); }
  quotas(value) { return Billing.prototype.quotas.call(this, value); }
  terms(input) {
    if (!COMMERCIAL_PLAN_TARGETS.includes(input.targetKind) || !COMMERCIAL_PLAN_STATES.includes(input.state)) fail(400, 'Escolha o público e o estado do plano.');
    if (input.currency !== 'BRL') fail(400, 'A moeda do plano é BRL.');
    if (!Number.isInteger(input.periodMonths) || input.periodMonths < 1 || input.periodMonths > 12) fail(400, 'Escolha periodicidade entre 1 e 12 meses.');
    return { name: label(input.name, 'Nome do plano'), targetKind: input.targetKind, state: input.state, currency: 'BRL', periodMonths: input.periodMonths,
      items: this.items(input.items), quotas: this.quotas(input.quotas) };
  }

  owner(actor, workspaceId) {
    const owner = this.accounts.accountRow(workspaceId);
    const permitted = owner.accountKind === 'platform' && owner.id === this.accounts.platformWorkspaceId ? this.accounts.platform(actor)
      : owner.accountKind === 'reseller' && owner.id === actor.resellerId;
    if (!permitted) fail(404, 'Catálogo não encontrado neste acesso.');
    return owner;
  }

  catalogue(owner) {
    const catalogue = owner.data.commercialPlans;
    if (catalogue === undefined || catalogue === null) return { plans: [], requests: [] };
    if (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue) || !Array.isArray(catalogue.plans) || !Array.isArray(catalogue.requests)) fail(500, 'Catálogo inválido; preserve os dados para revisão.');
    const ids = new Set();
    const validatePlan = plan => {
      if (!plan || !identity(plan.id) || !Number.isSafeInteger(plan.version) || plan.version < 1
        || !instant(plan.createdAt) || !instant(plan.updatedAt) || !identity(plan.changedBy?.userId) || !identity(plan.changedBy?.workspaceId)
        || (owner.accountKind === 'reseller' && plan.targetKind !== 'business')) fail(400, 'Registro de plano inválido.');
      this.terms(plan); label(plan.reason, 'Motivo', 500);
    };
    try {
      for (const plan of catalogue.plans) {
        validatePlan(plan);
        if (ids.has(plan.id)) fail(400, 'Registro de plano duplicado.');
        ids.add(plan.id);
      }
      const requests = new Set();
      for (const request of catalogue.requests) {
        const key = canonical([request?.actorId, request?.actorWorkspaceId, request?.requestId]);
        if (!request || !identity(request.actorId) || !identity(request.actorWorkspaceId) || !identity(request.requestId) || request.requestId.length < 8 || requests.has(key)
          || !/^[a-f0-9]{64}$/.test(request.hash) || !instant(request.createdAt) || request.result?.workspaceId !== owner.id
          || !Number.isSafeInteger(request.result.accountVersion) || request.result.accountVersion < 1 || !ids.has(request.result.plan?.id)) fail(400, 'Recibo de plano inválido.');
        validatePlan(request.result.plan);
        requests.add(key);
      }
    } catch (error) { if (error.status !== 400) throw error; fail(500, 'Catálogo inválido; preserve os dados para revisão.'); }
    return catalogue;
  }

  dto(plan) {
    return copy({ id: plan.id, ...this.terms(plan), version: plan.version, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
      changedBy: { userId: plan.changedBy.userId, workspaceId: plan.changedBy.workspaceId }, reason: plan.reason });
  }

  find(catalogue, id) {
    if (!identity(id)) fail(400, 'Plano inválido.');
    const plan = catalogue.plans.find(plan => plan.id === id);
    if (!plan) fail(404, 'Plano não encontrado neste catálogo.');
    return plan;
  }

  detail(input, workspaceId, planId) {
    const actor = this.accounts.actor(input), owner = this.owner(actor, workspaceId);
    return { workspaceId: owner.id, accountVersion: owner.version, plan: this.dto(this.find(this.catalogue(owner), planId)), canManage: true };
  }

  list(input, options = {}) {
    fields(options, ['workspaceId', 'q', 'state', 'targetKind', 'offset', 'limit']);
    const actor = this.accounts.actor(input), { workspaceId = actor.resellerId, q = '', state = 'all', targetKind = 'all', offset = 0, limit = 50 } = options;
    if (typeof q !== 'string' || q.trim().length > 200 || /\p{Cc}/u.test(q) || !['all', ...COMMERCIAL_PLAN_STATES].includes(state)
      || !['all', ...COMMERCIAL_PLAN_TARGETS].includes(targetKind) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'Informe filtros e página válidos para os planos.');
    const owner = this.owner(actor, workspaceId), search = normalize(q.trim());
    const all = this.catalogue(owner).plans.filter(plan => (state === 'all' || plan.state === state) && (targetKind === 'all' || plan.targetKind === targetKind)
      && (!search || normalize(plan.name).includes(search))).sort((a, b) => normalize(a.name).localeCompare(normalize(b.name), 'pt-BR') || a.id.localeCompare(b.id));
    return { workspaceId: owner.id, accountVersion: owner.version, plans: all.slice(offset, offset + limit).map(plan => this.dto(plan)),
      total: all.length, offset, limit, hasMore: offset + limit < all.length, canManage: true };
  }

  write(inputActor, workspaceId, planId, input) {
    const updating = planId !== null;
    fields(input, ['requestId', 'accountVersion', ...(updating ? ['version'] : []), ...termsFields, 'reason']);
    if (!identity(input.requestId) || input.requestId.length < 8) fail(400, 'Informe a identificação desta operação.');
    revision(input.accountVersion); if (updating) revision(input.version);
    const terms = this.terms(input), reason = label(input.reason, 'Motivo', 500);
    const firstActor = this.accounts.actor(inputActor), initialOwner = this.owner(firstActor, workspaceId);
    if (initialOwner.accountKind === 'reseller' && terms.targetKind !== 'business') fail(400, 'A revenda cadastra planos para empresas clientes.');
    if (updating) this.find(this.catalogue(initialOwner), planId);
    const hash = createHash('sha256').update(canonical({ operation: updating ? 'update' : 'create', workspaceId, planId, accountVersion: input.accountVersion,
      ...(updating ? { version: input.version } : {}), ...terms, reason })).digest('hex');
    return this.accounts.transaction(() => {
      const actor = this.accounts.actor(inputActor);
      if (actor.userId !== firstActor.userId || actor.resellerId !== firstActor.resellerId) fail(403, 'O acesso ao catálogo mudou. Abra os planos novamente.');
      const owner = this.owner(actor, workspaceId), catalogue = this.catalogue(owner);
      if (owner.accountKind === 'reseller' && terms.targetKind !== 'business') fail(400, 'A revenda cadastra planos para empresas clientes.');
      if (updating) this.find(catalogue, planId);
      const previousRequest = catalogue.requests.find(request => request.actorId === actor.userId && request.actorWorkspaceId === actor.resellerId && request.requestId === input.requestId);
      if (previousRequest) {
        if (previousRequest.hash !== hash) fail(409, 'Esta identificação já foi usada com outros dados.');
        return { workspaceId: owner.id, accountVersion: previousRequest.result.accountVersion, plan: this.dto(previousRequest.result.plan), canManage: true, replayed: true };
      }
      if (owner.version !== input.accountVersion) fail(409, 'A conta mudou. Atualize o catálogo antes de salvar.');
      const previous = updating ? this.find(catalogue, planId) : null;
      if (previous && previous.version !== input.version) fail(409, 'O plano mudou. Atualize antes de salvar.');
      const timestamp = this.timestamp(), id = previous?.id || `plan_${randomUUID()}`;
      const plan = { ...previous, ...terms, id, version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt || timestamp,
        updatedAt: timestamp, changedBy: { userId: actor.userId, workspaceId: actor.resellerId }, reason };
      const result = { workspaceId: owner.id, accountVersion: owner.version + 1, plan: this.dto(plan), canManage: true };
      const commercialPlans = { ...catalogue, plans: previous ? catalogue.plans.map(existing => existing.id === id ? plan : existing) : [...catalogue.plans, plan],
        requests: [...catalogue.requests, { actorId: actor.userId, actorWorkspaceId: actor.resellerId, requestId: input.requestId, hash, createdAt: timestamp, result }] };
      const data = { ...owner.data, commercialPlans, version: owner.version + 1 };
      const changed = this.db.prepare('UPDATE resellers SET data=? WHERE id=? AND data=?').run(JSON.stringify(data), owner.id, owner.rawData);
      if (changed.changes !== 1) fail(409, 'A conta mudou. Atualize o catálogo antes de salvar.');
      for (const tenant of this.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(owner.id)) {
        if (this.accounts.store.queuePostgres) sync(this.accounts.store.queuePostgres.bind(this.accounts.store), tenant.id);
      }
      this.accounts.audit(actor, this.accounts.accountRow(owner.id), updating ? 'account.plan.updated' : 'account.plan.created', owner.version);
      return { ...result, replayed: false };
    });
  }

  create(input, workspaceId, body) { return this.write(input, workspaceId, null, body); }
  update(input, workspaceId, planId, body) {
    if (!identity(planId)) fail(400, 'Plano inválido.');
    return this.write(input, workspaceId, planId, body);
  }

  contractDraft(input, workspaceId, planId, body) {
    fields(body, ['accountVersion', 'version', 'targetWorkspaceId', 'startsAt', 'endsAt', 'graceDays']);
    revision(body.accountVersion); revision(body.version);
    const actor = this.accounts.actor(input), owner = this.owner(actor, workspaceId), plan = this.find(this.catalogue(owner), planId);
    if (owner.version !== body.accountVersion || plan.version !== body.version) fail(409, 'O catálogo ou plano mudou. Atualize antes de revisar o contrato.');
    if (plan.state !== 'active') fail(409, 'Ative o plano antes de preparar um contrato.');
    const target = this.accounts.visible(actor, body.targetWorkspaceId);
    if (target.accountKind !== plan.targetKind || (owner.accountKind === 'reseller' && (target.accountKind !== 'business' || target.parentWorkspaceId !== owner.id))) fail(400, 'Escolha uma conta cliente compatível com o plano e o emissor.');
    const terms = Billing.prototype.terms.call(this, { name: plan.name, currency: plan.currency, periodMonths: plan.periodMonths, items: plan.items, quotas: plan.quotas,
      startsAt: body.startsAt, endsAt: body.endsAt, graceDays: body.graceDays, state: 'active' });
    return { source: { workspaceId: owner.id, planId: plan.id, version: plan.version, accountVersion: owner.version }, requiresReview: true,
      draft: { ...terms, scope: owner.accountKind === 'platform' ? 'platform' : 'workspace', targetKind: 'reseller', targetWorkspaceId: target.id } };
  }
}
