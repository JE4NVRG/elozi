/**
 * What connected agents ran into since this process started: reply limits (with or without the notice) and replies or
 * assignments refused between own lines. Kept in memory and bounded; it feeds the Connected products screen and never
 * holds message text, contacts or phone numbers.
 */
export class ServiceActivity {
  constructor({ now = Date.now, max = 500 } = {}) {
    this.now = now; this.max = max; this.items = []; this.startedAt = new Date(now()).toISOString();
  }
  record(entry) {
    this.items.push({ at: new Date(this.now()).toISOString(), ...entry });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }
  /** Newest first, optionally only for some companies. */
  list({ tenantIds = null, limit = 50 } = {}) {
    const allowed = tenantIds && new Set(tenantIds);
    return this.items.filter(item => !allowed || allowed.has(item.tenantId)).slice(-limit).reverse().map(item => ({ ...item }));
  }
  counts(tenantId) {
    const own = this.items.filter(item => item.tenantId === tenantId);
    return { limitHits: own.filter(item => item.type === 'reply-limit').length, noticesSent: own.filter(item => item.type === 'reply-limit' && item.noticeSent).length,
      ownLineBlocks: own.filter(item => item.type === 'own-line').length };
  }
}
