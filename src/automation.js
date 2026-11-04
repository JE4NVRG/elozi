import { randomUUID } from 'node:crypto';
import { fail, text } from './store.js';
import { allowedFields } from './access.js';
import { FlowService } from './flows.js';
import { Operations } from './operations.js';
import { automationChannelSupported, automationChannelConnected } from '../public/automation-channels.js';

const copy = value => structuredClone(value);
const id = value => { if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 160 || /[\x00-\x20\x7f]/.test(value)) fail(400, 'Identidade inválida.'); return value; };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Informe a revisão atual da automação.'); return value; };
const millis = value => { const result = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(result) ? result : null; };
const iso = value => new Date(value).toISOString();
const confirmed = message => message.kind === 'human' && ['sent', 'delivered', 'read'].includes(message.delivery);
const defaultSla = () => ({ enabled: false, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null });
const defaults = () => ({ version: 1, bindings: [], sla: defaultSla(), updatedAt: null });

/** A same-day weekly calendar. No implicit overnight window, holiday or machine timezone. */
export function normalizeCalendar(input) {
  if (input === undefined || input === null) return null;
  allowedFields(input, ['timezone', 'days', 'start', 'end']);
  if (typeof input.timezone !== 'string' || input.timezone.length > 80) fail(400, 'Informe um fuso horário IANA válido.');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(0); } catch { fail(400, 'Informe um fuso horário IANA válido.'); }
  if (!Array.isArray(input.days) || !input.days.length || input.days.length > 7 || input.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) fail(400, 'Escolha dias da semana de 0 (domingo) a 6 (sábado).');
  const minute = value => { if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(400, 'Informe um horário no formato HH:mm.'); return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); };
  if (minute(input.end) - minute(input.start) < 15) fail(400, 'O horário deve terminar no mesmo dia e durar pelo menos 15 minutos.');
  return { timezone: input.timezone, days: [...new Set(input.days)].sort(), start: input.start, end: input.end };
}

const formatter = timezone => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function parts(format, instant) { return Object.fromEntries(format.formatToParts(instant).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])); }
function civilDate(format, instant) { const p = parts(format, instant); return Date.UTC(p.year, p.month - 1, p.day); }
function wallEpoch(format, instant) { const p = parts(format, instant); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }

function calendarClock(calendar) {
  const format = formatter(calendar.timezone), cache = new Map();
  const boundary = (date, clock, latest) => {
    const target = date + (Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))) * 60000;
    const offsets = new Set();
    for (let hours = -36; hours <= 36; hours += 6) {
      const probe = target + hours * 3600000; offsets.add(wallEpoch(format, probe) - probe);
    }
    const candidates = [...offsets].map(offset => target - offset).filter(instant => wallEpoch(format, instant) === target).sort((a, b) => a - b);
    if (candidates.length) return latest ? candidates.at(-1) : candidates[0];
    // A spring-forward boundary is the first real wall minute after the skipped time.
    // A skipped civil day has no interval. Fall-back starts early and ends late.
    const approximate = target - [...offsets][0];
    let best = null;
    for (let instant = approximate - 6 * 3600000; instant <= approximate + 6 * 3600000; instant += 60000) {
      const wall = wallEpoch(format, instant);
      if (civilDate(format, instant) === date && wall >= target && (best === null || instant < best)) best = instant;
    }
    return best;
  };
  const window = date => {
    if (cache.has(date)) return cache.get(date);
    const result = calendar.days.includes(new Date(date).getUTCDay()) ? [boundary(date, calendar.start, false), boundary(date, calendar.end, true)] : null;
    cache.set(date, result && result[0] !== null && result[1] > result[0] ? result : null);
    return cache.get(date);
  };
  return { format, window };
}

export function withinCalendar(calendar, instant = Date.now()) {
  if (!calendar) return true;
  const format = formatter(calendar.timezone), p = parts(format, instant), date = Date.UTC(p.year, p.month - 1, p.day), clock = p.hour * 60 + p.minute;
  const start = Number(calendar.start.slice(0, 2)) * 60 + Number(calendar.start.slice(3)), end = Number(calendar.end.slice(0, 2)) * 60 + Number(calendar.end.slice(3));
  return calendar.days.includes(new Date(date).getUTCDay()) && clock >= start && clock < end;
}

/** Returns null when an old observation exceeds the deliberately bounded one-year scan. */
export function businessElapsedMinutes(from, to, calendar = null) {
  from = millis(from); to = millis(to);
  if (from === null || to === null || to < from) return null;
  if (!calendar) return (to - from) / 60000;
  const clock = calendarClock(calendar), first = civilDate(clock.format, from), last = civilDate(clock.format, to);
  if ((last - first) / 86400000 > 371) return null;
  let total = 0;
  for (let date = first; date <= last; date += 86400000) {
    const window = clock.window(date); if (window) total += Math.max(0, Math.min(to, window[1]) - Math.max(from, window[0]));
  }
  return total / 60000;
}

export function businessDeadline(from, minutes, calendar = null) {
  from = millis(from);
  if (from === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (!calendar) return iso(from + minutes * 60000);
  const clock = calendarClock(calendar), first = civilDate(clock.format, from); let remaining = minutes * 60000;
  for (let day = 0; day <= 371; day++) {
    const window = clock.window(first + day * 86400000); if (!window) continue;
    const start = Math.max(from, window[0]), available = Math.max(0, window[1] - start);
    if (available >= remaining) return iso(start + remaining);
    remaining -= available;
  }
  return null;
}

function normalizeSla(input) {
  if (input === undefined) return defaultSla();
  allowedFields(input, ['enabled', 'firstReplyMinutes', 'resolutionMinutes', 'calendar']);
  if (typeof input.enabled !== 'boolean') fail(400, 'Informe se o SLA está ativo.');
  const calendar = normalizeCalendar(input.calendar);
  const target = value => { if (!Number.isInteger(value) || value < 1 || value > 43200) fail(400, 'Use metas de SLA entre 1 e 43200 minutos.'); return value; };
  const firstReplyMinutes = target(input.firstReplyMinutes), resolutionMinutes = target(input.resolutionMinutes);
  if (calendar) {
    const weekly = calendar.days.length * (Number(calendar.end.slice(0, 2)) * 60 + Number(calendar.end.slice(3)) - Number(calendar.start.slice(0, 2)) * 60 - Number(calendar.start.slice(3)));
    if (Math.max(firstReplyMinutes, resolutionMinutes) > weekly * 52) fail(400, 'A meta precisa caber em até um ano do calendário informado.');
  }
  return { enabled: input.enabled, firstReplyMinutes, resolutionMinutes, calendar };
}

function commandOf(value) { return typeof value === 'string' ? value.trim().split(/\s+/)[0].toLowerCase().replace(/@[a-z0-9_]+$/i, '') : ''; }
function departmentFor(tenant, conversation) { return (tenant.departments || []).find(item => conversation.departmentId ? item.id === conversation.departmentId : item.name === conversation.department) || null; }
function context(tenant, conversation) { return { tenantId: tenant.id, channelId: conversation.channelId, departmentId: departmentFor(tenant, conversation)?.id || 'unassigned' }; }
const skip = Symbol('automation-skip');

/** Only deterministic internal routing. This module has no external transport or provider calls. */
export class AutomationService {
  constructor(store, auth, flows, { now = Date.now, channelAvailable = () => true } = {}) {
    if (!store?.mutate || !auth?.can || !auth?.currentActor || !flows?.simulate || typeof now !== 'function' || typeof channelAvailable !== 'function') throw new TypeError('Configuração de automação inválida.');
    this.store = store.sync || store; this.auth = auth; this.flows = flows; this.now = now; this.channelAvailable = channelAvailable;
    this.operations = new Operations(this.store, auth, { now });
  }
  admin(actor) { this.store.admin(actor); return this.auth.admin(actor); }
  permission(actor, name, scope) { if (!this.auth.can(actor, name, scope)) fail(403, 'Seu acesso não permite esta operação neste canal ou departamento.'); }
  available(tenantId, channel) { return automationChannelConnected(channel) && this.channelAvailable(tenantId, channel) === true; }
  get(actor, tenantId) { this.admin(actor); return copy(this.store.tenant(actor, tenantId).automation || defaults()); }
  configure(actor, tenantId, input) {
    this.admin(actor); allowedFields(input, ['version', 'bindings', 'sla']); revision(input.version);
    if (!Array.isArray(input.bindings) || input.bindings.length > 50) fail(400, 'Informe até cinquenta vínculos de automação.');
    const sla = normalizeSla(input.sla);
    return this.store.mutate(actor, tenantId, 'Automação e SLA configurados', tenant => {
      const current = this.admin(actor), previous = tenant.automation || defaults();
      if (previous.version !== input.version) fail(409, 'A automação mudou. Atualize antes de salvar.');
      const date = iso(this.now()), used = new Set();
      const bindings = input.bindings.map(raw => {
        allowedFields(raw, ['id', 'name', 'enabled', 'channelId', 'flowId', 'flowVersion', 'trigger', 'command', 'calendar']);
        const bindingId = raw.id === undefined ? randomUUID() : id(raw.id);
        if (used.has(bindingId)) fail(400, 'Vínculo de automação duplicado.'); used.add(bindingId);
        if (typeof raw.enabled !== 'boolean' || !['incoming', 'new_conversation', 'command'].includes(raw.trigger)) fail(400, 'Escolha um gatilho válido e informe se está ativo.');
        const channelId = id(raw.channelId), flowId = id(raw.flowId), flowVersion = revision(raw.flowVersion);
        const channel = (tenant.channels || []).find(item => item.id === channelId), old = previous.bindings.find(item => item.id === bindingId);
        if (!automationChannelSupported(channel) || !this.available(tenantId, channel) && (raw.enabled || !old || old.channelId !== channelId)) fail(400, 'Escolha uma conexão ativa de WhatsApp QR, Telegram ou Webchat desta empresa.');
        const flow = (tenant.flows || []).find(item => item.id === flowId);
        if (!flow || !flow.versions?.some(item => item.version === flowVersion) || raw.enabled && flow.state === 'archived') fail(400, 'Escolha uma versão publicada de um fluxo ativo desta empresa.');
        let command = null;
        if (raw.trigger === 'command') { if (typeof raw.command !== 'string' || !/^\/[a-z][a-z0-9_]{0,31}$/i.test(raw.command)) fail(400, 'Use um comando como /ajuda, sem espaços.'); command = raw.command.toLowerCase(); }
        else if (raw.command !== undefined && raw.command !== null && raw.command !== '') fail(400, 'Informe um comando somente para esse tipo de gatilho.');
        return { id: bindingId, name: text(raw.name, 80), enabled: raw.enabled, channelId, flowId, flowVersion, trigger: raw.trigger, command, calendar: normalizeCalendar(raw.calendar), authorizedBy: current.id, createdAt: old?.createdAt || date, updatedAt: date };
      });
      tenant.automation = { version: previous.version + 1, bindings, sla, updatedAt: date };
      return copy(tenant.automation);
    });
  }
  authority(userId, resellerId) {
    const row = this.auth.db.prepare('SELECT * FROM auth_users WHERE id=?').get(userId);
    if (!row) fail(403, 'A autoridade da automação não está disponível.');
    const actor = { ...this.auth.actor(row), resellerId };
    this.auth.admin(actor); this.store.reseller(actor); return actor;
  }
  matching(tenant, conversation, message) {
    const channel = (tenant.channels || []).find(item => item.id === conversation.channelId);
    if (!this.available(tenant.id, channel)) return undefined;
    const first = (conversation.messages || []).find(item => item.kind === 'customer');
    return (tenant.automation?.bindings || []).find(binding => binding.enabled && binding.channelId === conversation.channelId
      && (binding.trigger === 'incoming' || binding.trigger === 'new_conversation' && first?.id === message.id || binding.trigger === 'command' && commandOf(message.text) === binding.command)
      && withinCalendar(binding.calendar, this.now()));
  }
  atomicFlows(tenant, actor) {
    const adapter = { tenant: () => tenant, mutate: (_actor, _id, _action, fn) => fn(tenant), admin: current => this.admin(current), getConversation: (...args) => this.store.getConversation(...args) };
    const service = new FlowService(adapter, { maxSteps: this.flows.maxSteps || 100 });
    service.authorize = (current, tenantId, conversation, apply) => {
      this.permission(current, 'flows.read', { tenantId, aggregate: true });
      this.permission(current, apply ? 'inbox.transfer' : 'inbox.read', context(tenant, conversation));
      this.flows.authorize?.(current, tenantId, conversation, apply);
    };
    service.routeOutput = (current, tenantId, state, conversation, output, graph, steps) => {
      const target = (state.departments || []).find(item => item.id === output.department || item.name === output.department);
      const changed = output.department !== conversation.department;
      if (changed && (!target || target.active === false)) fail(400, 'A rota precisa usar um departamento ativo.');
      const departmentId = target?.id || departmentFor(state, conversation)?.id || null;
      this.permission(current, 'inbox.transfer', { tenantId, channelId: conversation.channelId, departmentId: departmentId || 'unassigned' });
      if (this.flows.routeOutput) {
        const recorded = (conversation.attendantEvents || []).length;
        this.flows.routeOutput(current, tenantId, state, conversation, output, graph, steps);
        for (const event of (conversation.attendantEvents || []).slice(recorded)) event.origin = 'automation';
      }
      else if (changed || steps.some(step => step.type === 'handoff')) {
        const from = { owner: conversation.owner, assignedUserId: conversation.assignedUserId || null, departmentId: conversation.departmentId || null };
        this.operations.clearParticipants(conversation,current,{origin:'automation',reason:'Rota de transferência automática aplicada.'});
        conversation.assignedUserId = null; conversation.assignedUserName = null; conversation.departmentId = departmentId;
        output.owner = 'queue'; output.agentId = null;
        this.operations.event(conversation, current, { type: 'assignment', from, to: { owner: 'queue', assignedUserId: null, departmentId }, origin: 'automation' });
      }
      // Never manufacture a person from a legacy flow's owner=human output.
      if (steps.some(step => step.type === 'handoff') || changed) { output.owner = 'queue'; output.agentId = null; conversation.assignedUserId = null; conversation.assignedUserName = null; }
    };
    return service;
  }
  /** Internal gateway hook. Input IDs must refer to an already committed customer message. */
  onIncoming(tenantId, input) {
    id(tenantId); allowedFields(input, ['conversationId', 'messageId', 'conversationVersion', 'newConversation', 'reopened']);
    id(input.conversationId); id(input.messageId); revision(input.conversationVersion);
    for (const field of ['newConversation', 'reopened']) if (input[field] !== undefined && typeof input[field] !== 'boolean') fail(400, 'Marco de entrada inválido.');
    const row = this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId);
    if (!row) fail(404, 'Empresa não encontrada.');
    const system = { role: 'reseller', resellerId: row.reseller_id, name: 'Automação de entrada' };
    const addressable = typeof input.conversationId === 'string' && input.conversationId.length > 0;
    const read = typeof this.store.readonlyConversationTenant === 'function' ? this.store.readonlyConversationTenant : this.store.conversationTenant;
    const observed = addressable && typeof read === 'function' ? read.call(this.store, system, tenantId, input.conversationId) : this.store.tenant(system, tenantId), original = this.store.getConversation(observed, input.conversationId);
    const incoming = (original.messages || []).find(message => message.id === input.messageId);
    if (!incoming || incoming.kind !== 'customer') return { applied: false, outcome: 'not-incoming' };
    if (incoming.automationReceipt) return { ...copy(incoming.automationReceipt), applied: false, replayed: true };
    const reopened = [...(original.attendantEvents || [])].reverse().find(event => event.type === 'reopened');
    const selected = this.matching(observed, original, incoming), startsCycle = input.newConversation === true && original.messages.find(message => message.kind === 'customer')?.id === input.messageId || input.reopened === true && Boolean(reopened?.id && original.slaCycle?.reopenedEventId !== reopened.id);
    const fallback = Symbol('automation-needs-tenant');
    let scoped = addressable && !selected && !startsCycle && typeof this.store.mutateConversation === 'function';
    const evaluate = tenant => {
        const conversation = this.store.getConversation(tenant, input.conversationId), message = (conversation.messages || []).find(item => item.id === input.messageId);
        if (!message || message.kind !== 'customer') throw skip;
        if (message.automationReceipt) return { ...copy(message.automationReceipt), applied: false, replayed: true };
        const binding = this.matching(tenant, conversation, message), date = iso(this.now());
        if (scoped && binding) throw fallback;
        const receipt = { processedAt: date, bindingId: binding?.id || null, configurationVersion: tenant.automation?.version || 1, outcome: 'no-match', applied: false };
        if ((conversation.version || 1) !== input.conversationVersion) receipt.outcome = 'conversation-changed';
        else {
          if (startsCycle && conversation.status !== 'closed') {
            const lastReopen = [...(conversation.attendantEvents || [])].reverse().find(event => event.type === 'reopened');
            conversation.slaCycle = { startedAt: date, incomingMessageId: message.id, reopenedEventId: input.reopened ? lastReopen?.id || null : null, source: input.reopened ? 'gateway-reopened' : 'gateway-new-conversation' };
          }
          if (binding) {
            if (conversation.status === 'closed' || conversation.owner !== 'queue' || conversation.assignedUserId || conversation.agentId) receipt.outcome = 'not-in-queue';
            else {
              const currentFlow = (tenant.flows || []).find(flow => flow.id === binding.flowId);
              if (!currentFlow || currentFlow.state === 'archived' || !currentFlow.versions?.some(version => version.version === binding.flowVersion)) receipt.outcome = 'flow-unavailable';
              else {
                const actor = this.authority(binding.authorizedBy, row.reseller_id);
                const result = this.atomicFlows(tenant, actor).simulate(actor, tenantId, binding.flowId, { apply: true, flowVersion: binding.flowVersion, conversationId: conversation.id, conversationVersion: input.conversationVersion, text: message.text || '' });
                Object.assign(receipt, { outcome: 'applied', applied: true, flowId: binding.flowId, flowVersion: binding.flowVersion, steps: result.steps, conversationId: conversation.id, conversationVersion: result.conversationVersion });
              }
            }
          }
        }
        message.automationReceipt = receipt;
        return copy(receipt);
    };
    try {
      if (scoped) {
        try { return this.store.mutateConversation(system, tenantId, input.conversationId, 'Entrada avaliada pela automação', (conversation, metadata) => evaluate({ ...metadata, conversations: [conversation] })); }
        catch (error) { if (error !== fallback) throw error; scoped = false; }
      }
      return this.store.mutate(system, tenantId, 'Entrada avaliada pela automação', evaluate);
    } catch (error) {
      if (error === skip) return { applied: false, outcome: 'not-incoming' };
      // The failed transaction rolls back all route effects. A small receipt prevents retry loops.
      if (![400, 403, 404, 409].includes(error.status)) throw error;
      return this.store.mutate(system, tenantId, 'Automação de entrada bloqueada', tenant => {
        const conversation = this.store.getConversation(tenant, input.conversationId), message = conversation.messages.find(item => item.id === input.messageId);
        if (!message || message.kind !== 'customer') return { applied: false, outcome: 'not-incoming' };
        if (message.automationReceipt) return { ...copy(message.automationReceipt), applied: false, replayed: true };
        if (startsCycle && (conversation.version || 1) === input.conversationVersion && conversation.status !== 'closed') {
          conversation.slaCycle = { startedAt: iso(this.now()), incomingMessageId: message.id, reopenedEventId: input.reopened ? reopened.id : null, source: input.reopened ? 'gateway-reopened' : 'gateway-new-conversation' };
        }
        const receipt = { processedAt: iso(this.now()), bindingId: selected?.id || null, configurationVersion: tenant.automation?.version || 1, outcome: 'blocked', applied: false, errorStatus: error.status };
        message.automationReceipt = receipt; return copy(receipt);
      });
    }
  }
  sla(actor, tenantId) {
    this.permission(actor, 'metrics.read', { tenantId, aggregate: true }); this.permission(actor, 'inbox.read', { tenantId, aggregate: true });
    const tenant = this.store.tenant(actor, tenantId), policy = tenant.automation?.sla || defaultSla(), now = this.now(), rows = [];
    const totals = { tracked: 0, insufficient: 0, firstReplyPending: 0, firstReplyBreached: 0, resolutionPending: 0, resolutionBreached: 0 };
    if (policy.enabled) for (const conversation of tenant.conversations || []) {
      if (!this.auth.can(actor, 'inbox.read', context(tenant, conversation))) continue;
      const messages = (conversation.messages || []).filter(message => millis(message.createdAt) !== null);
      const lastReopen = [...(conversation.attendantEvents || [])].reverse().find(event => event.type === 'reopened');
      const marker = conversation.slaCycle;
      const anchored = marker && (!lastReopen || marker.reopenedEventId === lastReopen.id) && messages.some(message => message.id === marker.incomingMessageId && message.kind === 'customer');
      const first = anchored ? messages.find(message => message.id === marker.incomingMessageId) : !lastReopen ? messages.filter(message => message.kind === 'customer').sort((a, b) => millis(a.createdAt) - millis(b.createdAt))[0] : null;
      const started = first ? anchored ? millis(marker.startedAt) : millis(first.createdAt) : null;
      const index = first ? messages.indexOf(first) : -1;
      const reply = first ? messages.slice(index + 1).filter(confirmed).find(message => millis(message.createdAt) <= now && (anchored || millis(message.createdAt) >= started)) : null;
      const closure = started === null ? null : (conversation.attendantEvents || []).filter(event => event.type === 'closed' && event.from?.status !== 'closed' && event.to?.status === 'closed' && millis(event.createdAt) !== null && millis(event.createdAt) >= started && millis(event.createdAt) <= now).sort((a, b) => millis(a.createdAt) - millis(b.createdAt))[0];
      const timer = (minutes, completedAt, insufficient = false) => {
        const end = completedAt === null ? now : Math.max(started ?? now, completedAt), dueAt = started === null ? null : businessDeadline(started, minutes, policy.calendar);
        if (started === null || started > now || !dueAt || insufficient) return { state: 'insufficient-data', targetMinutes: minutes, dueAt: null, elapsedMinutes: null, completedAt: null };
        return { state: completedAt !== null ? end <= millis(dueAt) ? 'met' : 'breached' : now > millis(dueAt) ? 'breached' : 'pending', targetMinutes: minutes, dueAt, elapsedMinutes: businessElapsedMinutes(started, end, policy.calendar), completedAt: completedAt === null ? null : iso(completedAt) };
      };
      const firstReply = timer(policy.firstReplyMinutes, reply ? millis(reply.createdAt) : null), resolution = timer(policy.resolutionMinutes, closure ? millis(closure.createdAt) : null, conversation.status === 'closed' && !closure);
      const row = { conversationId: conversation.id, contact: conversation.contact || '', channelId: conversation.channelId, departmentId: departmentFor(tenant, conversation)?.id || null, assignedUserId: conversation.assignedUserId || null, owner: conversation.owner, status: conversation.status, startedAt: started === null ? null : iso(started), coverage: anchored ? 'gateway-cycle' : first ? 'original-incoming' : 'insufficient-cycle', firstReply, resolution };
      rows.push(row); totals.tracked++;
      if ([firstReply, resolution].some(timer => timer.state === 'insufficient-data')) totals.insufficient++;
      if (firstReply.state === 'pending') totals.firstReplyPending++; if (firstReply.state === 'breached') totals.firstReplyBreached++;
      if (resolution.state === 'pending') totals.resolutionPending++; if (resolution.state === 'breached') totals.resolutionBreached++;
    }
    return { asOf: iso(now), policy: copy(policy), configurationVersion: tenant.automation?.version || 1, totals, conversations: rows, coverage: { historicalPolicy: 'current-policy-only', resolution: 'recorded-closure-events-only', elapsedLimitDays: 371, calendar: 'weekly-without-holidays' } };
  }
}
