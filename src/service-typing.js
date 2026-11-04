import { createHash } from 'node:crypto';
import { fail } from './store.js';

/**
 * "Digitando…" of a connected agent (presence.typing, elozi_send_typing): an ephemeral provider signal, never a message.
 *
 * Authority is exactly the private reply's (service-principals.js revalidate: the conversation belongs to this identity's
 * MCP copilot agent, inside its tenant/channel/department scope). The call is quota-free and receiptless, like the long
 * event wait: it reserves no daily request, writes nothing to the conversation and keeps no persistent row, so it can
 * never exhaust the quota or the concurrency of a later elozi_send_reply. The requestId still de-duplicates a retried
 * call for a minute (same answer, no second provider signal; another payload under the same key is refused).
 *
 * Pace: per identity and conversation at most one composing every 4 s and one paused every second (a faster call returns
 * sent:false with reason throttled and retryAfterMs, not an error); per identity at most TYPING_PER_HOUR provider signals
 * an hour (429 beyond it). A channel without a typing signal answers supported:false. A provider failure or timeout is
 * reported as sent:false; only a loss of authority is an error.
 */
export const TYPING_STATES = Object.freeze(['composing', 'paused']);
export const TYPING_MIN_INTERVAL_MS = 4000;
export const TYPING_PAUSE_MIN_INTERVAL_MS = 1000;
export const TYPING_PER_HOUR = 1200;
const REPLAY_MS = 60000, HOUR_MS = 3600000, PROVIDER_TIMEOUT_MS = 4000, MAX_ENTRIES = 5000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,120}$/, CONVERSATION_ID = /^[A-Za-z0-9_-]{1,120}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const AUTHORITY = Symbol('typingAuthority');

export class ServiceTyping {
  constructor(api, { sendTyping = null, timeoutMs = PROVIDER_TIMEOUT_MS, perHour = TYPING_PER_HOUR, minIntervalMs = TYPING_MIN_INTERVAL_MS, pauseIntervalMs = TYPING_PAUSE_MIN_INTERVAL_MS } = {}) {
    if (sendTyping !== null && typeof sendTyping !== 'function') throw new TypeError('Informe um adaptador válido para o aviso de digitação.');
    if (![timeoutMs, perHour, minIntervalMs, pauseIntervalMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Informe limites válidos para o aviso de digitação.');
    Object.assign(this, { api, sendTyping, timeoutMs, perHour, minIntervalMs, pauseIntervalMs });
    this.replays = new Map(); this.last = new Map(); this.windows = new Map();
  }
  /** What elozi_me tells the identity about its typing signal. */
  describe(principal) {
    return { enabled: Boolean(principal?.capabilities?.includes('presence.typing')), states: [...TYPING_STATES], minIntervalMs: this.minIntervalMs, perHour: this.perHour, quotaFree: true, receipt: false };
  }
  prune(now) {
    for (const [key, entry] of this.replays) if (now - entry.at > REPLAY_MS) this.replays.delete(key);
    for (const [key, entry] of this.last) if (now - Math.max(entry.composing || 0, entry.paused || 0) > HOUR_MS) this.last.delete(key);
    for (const [key, entry] of this.windows) if (now - entry.start >= HOUR_MS) this.windows.delete(key);
    for (const map of [this.replays, this.last]) while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  }
  async send(actor, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['requestId', 'conversationId', 'state'].includes(key))) fail(400, 'Informe somente os campos permitidos da solicitação.');
    if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) fail(400, 'Informe uma chave de solicitação válida.');
    if (typeof input.conversationId !== 'string' || !CONVERSATION_ID.test(input.conversationId)) fail(400, 'Informe um atendimento válido.');
    if (!TYPING_STATES.includes(input.state)) fail(400, 'Use state composing ou paused.');
    const { api } = this, now = api.principals.now(), { requestId, conversationId, state } = input;
    this.prune(now);
    // Authority is always checked again, also for a replayed key: a revoked or moved conversation never gets an answer.
    const context = api.privateContext(actor, conversationId), authority = api.principals.revalidate(actor, 'presence.typing', context);
    const replayKey = `${actor.principalId}\u0000${requestId}`, hash = digest([conversationId, state]), prior = this.replays.get(replayKey);
    if (prior) {
      if (prior.hash !== hash) fail(409, 'A chave já foi usada com outra solicitação.');
      return { ...prior.result, replayed: true };
    }
    const tenant = api.store.tenant(api.internalActor(actor, authority), actor.tenantId), conversation = api.store.getConversation(tenant, conversationId);
    const channel = (tenant.channels || []).find(item => item.id === conversation.channelId);
    const base = { requestId, conversationId, channelId: conversation.channelId, channelKind: channel?.kind || null, state };
    const remember = result => { this.replays.set(replayKey, { at: now, hash, result }); return result; };
    // Between two own lines only one side may have an agent; where the reply is refused the typing signal is not sent.
    if (api.ownLines?.agentOnOtherSide?.(actor.tenantId, conversation)) return remember({ ...base, supported: true, sent: false, reason: 'own-line' });
    if (!this.sendTyping) return remember({ ...base, supported: false, sent: false, reason: 'unavailable' });
    const slotKey = `${actor.principalId}\u0000${conversationId}`, slot = this.last.get(slotKey) || {}, gap = state === 'composing' ? this.minIntervalMs : this.pauseIntervalMs;
    if (slot[state] && now - slot[state] < gap) return remember({ ...base, supported: true, sent: false, reason: 'throttled', retryAfterMs: gap - (now - slot[state]) });
    const window = this.windows.get(actor.principalId);
    if (window && now - window.start < HOUR_MS && window.count >= this.perHour) {
      const retryAfter = Math.max(1, Math.ceil((window.start + HOUR_MS - now) / 1000));
      throw Object.assign(new Error('O aviso de digitação deste serviço atingiu o limite por hora.'), { status: 429, retryAfter });
    }
    // Counted before the provider call, so concurrent calls of the same conversation are paced too.
    if (!window || now - window.start >= HOUR_MS) this.windows.set(actor.principalId, { start: now, count: 1 }); else window.count++;
    this.last.set(slotKey, { ...slot, [state]: now });
    const reauthorize = () => {
      try { api.principals.revalidate(actor, 'presence.typing', api.privateContext(actor, conversationId)); return true; }
      catch (error) { if (error && typeof error === 'object') error[AUTHORITY] = true; throw error; }
    };
    const target = { id: conversation.id, channelId: conversation.channelId, conversationKind: conversation.conversationKind || 'direct', remoteJid: conversation.remoteJid || null, remoteChatId: conversation.remoteChatId || null, threadId: conversation.threadId || null };
    let timer, outcome, providerActive = true;
    try {
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ supported: true, sent: false, reason: 'timeout' }), this.timeoutMs); timer.unref?.(); });
      const providerAuthorize = () => {
        if (!providerActive) throw new Error('O prazo do aviso de digitação terminou.');
        return reauthorize();
      };
      const call = Promise.resolve().then(() => this.sendTyping(actor, { context, tenantId: actor.tenantId, channel, conversation: target, state, reauthorize: providerAuthorize }));
      call.catch(() => {});
      outcome = await Promise.race([call, deadline]);
    } catch (error) {
      if (error?.[AUTHORITY]) throw error;
      outcome = { supported: true, sent: false, reason: 'provider' };
    } finally { providerActive = false; clearTimeout(timer); }
    const supported = outcome?.supported !== false, sent = supported && outcome?.sent === true;
    const reason = sent ? undefined : typeof outcome?.reason === 'string' && /^[a-z-]{1,40}$/.test(outcome.reason) ? outcome.reason : supported ? 'provider' : 'channel';
    // A signal that did not leave does not hold the pace slot.
    if (!sent) { const current = this.last.get(slotKey); if (current?.[state] === now) this.last.set(slotKey, { ...current, [state]: slot[state] }); }
    reauthorize();
    return remember({ ...base, supported, sent, ...(reason ? { reason } : {}) });
  }
}
