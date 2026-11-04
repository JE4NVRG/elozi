import { brazilianMobileAliases } from './whatsapp.js';
import { effectiveTenantDataSql } from './conversation-journal.js';

/**
 * Own lines: the WhatsApp numbers one workspace paired in Elozi (wa_number_bindings). Our products talk to each other
 * through them (a test phone of one product writing to another product's line), and two agents must never answer each
 * other without end. The rule: in a pair of conversations between two own lines, at most one side is with an agent.
 * Only lines of the same workspace are compared, so no company learns that a contact is another customer's line.
 * The contact is recognised by the phone address WhatsApp delivered (remoteJid and aliases); a LID-only contact is not.
 */
export class OwnLinePairError extends Error {
  constructor() {
    super('A outra ponta desta conversa é uma linha própria da operação que já está com um agente. Para não criar um laço entre agentes, transfira para a equipe com elozi_transfer_to_human.');
    this.name = 'OwnLinePairError'; this.status = 409; this.code = 'OWN_LINE_AGENT_PAIR';
  }
}

const aliasesOf = number => { try { return brazilianMobileAliases(number); } catch { return []; } };
/** Phone numbers of a direct WhatsApp conversation, from the addresses the gateway stored. */
export const conversationPhones = conversation => [...new Set([conversation?.remoteJid, ...(conversation?.remoteAliases || [])]
  .filter(jid => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')).map(jid => jid.split('@')[0].split(':')[0]).filter(digits => /^\d{8,15}$/.test(digits)))];

export class OwnLines {
  constructor(db, { onBlocked = () => {} } = {}) { this.db = db; this.onBlocked = onBlocked; }
  bindings() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wa_number_bindings'").get()) return [];
    return this.db.prepare('SELECT b.number, b.channel_id AS channelId, b.tenant_id AS tenantId, t.reseller_id AS workspaceId FROM wa_number_bindings b JOIN tenants t ON t.id = b.tenant_id').all();
  }
  tenantState(tenantId) {
    const row = this.db.prepare(`SELECT ${effectiveTenantDataSql(this.db, 't')} AS data FROM tenants t WHERE t.id=?`).get(tenantId);
    try { return row ? JSON.parse(row.data) : null; } catch { return null; }
  }
  /**
   * The other own line this direct conversation talks to, and the mirror conversation on that line (the same pair seen
   * from the other side), or null. `state` is the live copy when the caller is inside a mutation of that tenant.
   */
  pair(tenantId, conversation, { state = null, bindings = this.bindings() } = {}) {
    if (!conversation || conversation.conversationKind === 'group') return null;
    const self = bindings.find(binding => binding.channelId === conversation.channelId && binding.tenantId === tenantId);
    const phones = self ? conversationPhones(conversation) : [];
    if (!phones.length) return null;
    const other = bindings.find(binding => binding.channelId !== self.channelId && binding.workspaceId === self.workspaceId && aliasesOf(binding.number).some(number => phones.includes(number)));
    if (!other) return null;
    const ownNumbers = aliasesOf(self.number), source = other.tenantId === tenantId && state ? state : this.tenantState(other.tenantId);
    const mirror = (source?.conversations || []).filter(item => item.channelId === other.channelId && item.conversationKind !== 'group' && item.id !== conversation.id
      && conversationPhones(item).some(number => ownNumbers.includes(number))).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
    return { line: { tenantId: other.tenantId, channelId: other.channelId, tail: String(other.number).slice(-4) }, self: { channelId: self.channelId, tail: String(self.number).slice(-4) },
      mirror: mirror && { id: mirror.id, owner: mirror.owner || 'queue', agentId: mirror.agentId || null, status: mirror.status || 'open' } };
  }
  /** True when the other side of this own-line pair is open and with an agent. */
  agentOnOtherSide(tenantId, conversation, options) {
    const found = this.pair(tenantId, conversation, options);
    return Boolean(found?.mirror && found.mirror.status !== 'closed' && found.mirror.owner === 'agent');
  }
  /** True, and recorded, when an agent here would put agents on both sides of an own-line pair. */
  blocksAgent(tenantId, conversation, { action = 'reply', principalId = null, state = null } = {}) {
    if (!this.agentOnOtherSide(tenantId, conversation, { state })) return false;
    try { this.onBlocked({ tenantId, conversationId: conversation.id, action, principalId }); } catch { /* The decision stands even if the activity log fails. */ }
    return true;
  }
  /** Refuses an automatic reply or an agent assignment that would put agents on both sides of an own-line pair. */
  assertAgentAllowed(tenantId, conversation, options = {}) {
    if (this.blocksAgent(tenantId, conversation, options)) throw new OwnLinePairError();
  }
}
