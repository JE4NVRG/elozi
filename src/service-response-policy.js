/**
 * Descriptive response contract, not conversation authority. A capability still
 * needs the persisted grant, current scope, assignment/selection and guardrails
 * checked by the action itself. This module never changes grants or autonomy.
 */
export function serviceResponsePolicy(principal, agent) {
  const capabilities = new Set(Array.isArray(principal?.capabilities) ? principal.capabilities : []);
  // v2 public mode is effective; adapterMode retains the persisted compatibility mode.
  const adapterMode = agent?.adapterMode ?? agent?.mode ?? null;
  const copilot = agent?.configured === true && adapterMode === 'copilot';
  const mcp = copilot && agent.provider === 'mcp';
  const blockedByConversationPolicy = principal?.conversationPolicy?.allowGroups === false;
  const privateSend = capabilities.has('reply.send') && mcp;
  const hasDrafts = capabilities.has('reply.submit') && mcp
    || capabilities.has('reply.draft') && copilot && agent.provider === 'hermes';
  const hasDirectActions = !blockedByConversationPolicy
    && (capabilities.has('reply.send') || capabilities.has('message.schedule'));
  const effectiveMode = privateSend ? 'autonomous' : hasDrafts ? 'copilot' : hasDirectActions ? 'direct-actions' : 'read-only';
  const requiresHumanConversationAuthorization = effectiveMode === 'copilot';
  const policy = {
    version: 2,
    adapterMode,
    effectiveMode,
    // Version 2 defines the old ambiguous name as a HUMAN approval alias only.
    requiresConversationAuthorization: requiresHumanConversationAuthorization,
    requiresHumanConversationAuthorization,
    humanApprovalRequired: requiresHumanConversationAuthorization,
    requiresServerConversationAuthorization: true,
    privateReplies: {
      capable: capabilities.has('reply.send') && mcp,
      requiresAgentAssignment: true,
      requiresPerMessageApproval: false
    },
    drafts: {
      submitCapable: capabilities.has('reply.submit') && mcp,
      draftCapable: capabilities.has('reply.draft') && copilot && agent.provider === 'hermes',
      requiresHumanSend: true
    },
    groups: {
      sendCapable: capabilities.has('reply.send') && !blockedByConversationPolicy,
      scheduleCapable: capabilities.has('message.schedule') && !blockedByConversationPolicy,
      requiresSelection: true,
      requiresPerMessageApproval: false,
      blockedByConversationPolicy
    }
  };
  // Copy only the public policy contract, never arbitrary principal/agent data.
  if (principal?.conversationPolicy) {
    const { customerMessagesAfter, excludedChannelIds, allowGroups } = principal.conversationPolicy;
    policy.conversationPolicy = { customerMessagesAfter, excludedChannelIds: [...excludedChannelIds], allowGroups };
  }
  return policy;
}
