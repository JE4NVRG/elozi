/**
 * Connected products: for the operator of a workspace, each company with its lines, the automation answering on each,
 * the connected agents and their signed webhook, the reply policy and what the agents ran into. It never carries
 * message text, contact names or full phone numbers: a line shows its last four digits, as the channel labels do.
 */
const DAY_MS = 86400000;

const webhookSummary = dto => {
  if (!dto?.configured) return { configured: false };
  let origin = '';
  try { origin = new URL(dto.url).origin; } catch { /* An unreadable address shows no origin. */ }
  return { configured: true, enabled: dto.enabled === true, origin, lastStatus: dto.lastStatus ?? null, failures: dto.failures || 0, pending: dto.pending || 0 };
};

export function connectedProducts({ store, actor, principals, webhooks, ownLines, activity, now = Date.now }) {
  const at = now(), since = at - DAY_MS, bindings = ownLines.bindings().filter(binding => binding.workspaceId === actor.resellerId);
  const companies = store.list(actor).map(item => store.tenant(actor, item.id)), byId = new Map(companies.map(tenant => [tenant.id, tenant]));
  const channelName = (tenantId, channelId) => (byId.get(tenantId)?.channels || []).find(channel => channel.id === channelId)?.name || '';
  const agentName = (tenantId, agentId) => agentId ? (byId.get(tenantId)?.agents || []).find(agent => agent.id === agentId)?.name || null : null;
  const pairs = new Map();
  const products = companies.map(tenant => {
    const listed = principals.list(actor, tenant.id).principals, active = listed.filter(principal => principal.state === 'active');
    const autopilot = new Set((tenant.agents || []).filter(agent => agent.autopilot?.enabled === true).flatMap(agent => agent.autopilot.channelIds || []));
    const channels = (tenant.channels || []).map(channel => {
      const binding = bindings.find(item => item.channelId === channel.id && item.tenantId === tenant.id);
      const services = active.filter(principal => principal.capabilities.includes('reply.send') && (principal.channelIds === null || principal.channelIds.includes(channel.id)));
      return { id: channel.id, name: channel.name || '', kind: channel.kind, state: channel.state || null, ...(binding ? { tail: String(binding.number).slice(-4) } : {}),
        ownLine: Boolean(binding), automation: [channel.defaultAgentId && 'default-agent', autopilot.has(channel.id) && 'autopilot', services.length && 'connected-agent'].filter(Boolean),
        defaultAgent: agentName(tenant.id, channel.defaultAgentId),
        replyPolicy: channel.replyPolicy?.profile === 'assistant'
          ? { profile: 'assistant', perHour: channel.replyPolicy.perHour, perMinute: channel.replyPolicy.perMinute, notice: Boolean(channel.replyPolicy.notice) } : { profile: 'attendance' } };
    });
    let agentReplies = 0, notices = 0, qaConversations = 0, ownLineConversations = 0;
    const repliesBy = new Map();
    for (const conversation of tenant.conversations || []) {
      if (conversation.conversationKind === 'group') continue;
      if (conversation.replyExempt === true) qaConversations++;
      for (const message of conversation.messages || []) {
        if (message?.kind !== 'agent' || !message.authorServiceId || !(Date.parse(message.createdAt) >= since)) continue;
        if (String(message.serviceCommandId || '').startsWith('svcnotice_')) notices++; else { agentReplies++; repliesBy.set(message.authorServiceId, (repliesBy.get(message.authorServiceId) || 0) + 1); }
      }
      const pair = ownLines.pair(tenant.id, conversation, { state: tenant, bindings });
      if (!pair) continue;
      ownLineConversations++;
      const here = { tenantId: tenant.id, company: tenant.name, channel: channelName(tenant.id, conversation.channelId), tail: pair.self.tail,
        owner: conversation.status === 'closed' ? 'closed' : conversation.owner || 'queue', agent: agentName(tenant.id, conversation.agentId), qa: conversation.replyExempt === true };
      const there = { tenantId: pair.line.tenantId, company: byId.get(pair.line.tenantId)?.name || '', channel: channelName(pair.line.tenantId, pair.line.channelId), tail: pair.line.tail,
        owner: pair.mirror ? pair.mirror.status === 'closed' ? 'closed' : pair.mirror.owner : 'none', agent: pair.mirror ? agentName(pair.line.tenantId, pair.mirror.agentId) : null, qa: null };
      const ids = [`${tenant.id}:${conversation.id}`, pair.mirror ? `${pair.line.tenantId}:${pair.mirror.id}` : `${pair.line.tenantId}:${pair.line.channelId}:none`].sort().join('|');
      if (!pairs.has(ids)) pairs.set(ids, { sides: [here, there] });
    }
    return { tenantId: tenant.id, name: tenant.name, channels,
      agents: listed.map(principal => ({ id: principal.id, name: principal.name, agent: agentName(tenant.id, principal.agentId), state: principal.state,
        channels: principal.channelIds === null ? null : principal.channelIds.length, lastSeenAt: principal.lastSeenAt ?? null, replies24h: repliesBy.get(principal.id) || 0,
        webhook: webhookSummary(webhooks.dto(webhooks.row(principal.id))) })),
      qaConversations, ownLineConversations, last24h: { agentReplies, notices }, sinceStart: activity.counts(tenant.id) };
  });
  const pairList = [...pairs.values()].map(pair => {
    const withAgent = pair.sides.filter(side => side.owner === 'agent').length;
    return { ...pair, state: withAgent > 1 ? 'both-agents' : withAgent === 1 ? 'one-agent' : 'no-agent' };
  }).sort((a, b) => ({ 'both-agents': 0, 'one-agent': 1, 'no-agent': 2 })[a.state] - ({ 'both-agents': 0, 'one-agent': 1, 'no-agent': 2 })[b.state]);
  const tenantIds = companies.map(tenant => tenant.id);
  return { generatedAt: new Date(at).toISOString(), activitySince: activity.startedAt, ownLines: bindings.length, products, pairs: pairList,
    events: activity.list({ tenantIds, limit: 30 }).map(event => ({ at: event.at, type: event.type, company: byId.get(event.tenantId)?.name || '', action: event.action || null,
      window: event.window || null, max: event.max ?? null, noticeSent: event.noticeSent === true })) };
}
