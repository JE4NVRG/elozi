// Reply pace of the agent in one conversation, for the conversation header (agent visible in the inbox).
// It mirrors the server guardrail of src/service-api.js: a team/QA conversation keeps only the 60-per-minute loop guard;
// a product-assistant channel has per-minute and per-hour limits; attendance shows the hour count only, because a
// private operator override may change its hourly limit and the panel never sees it.
export const TEAM_LOOP_GUARD_PER_MINUTE = 60;

export function replyPace({ messages = [], policy = null, exempt = false, now = Date.now() } = {}) {
  const times = messages.filter(message => message?.kind === 'agent').map(message => Date.parse(message.createdAt)).filter(Number.isFinite);
  const minute = times.filter(at => at > now - 60000 && at <= now).length, hour = times.filter(at => at > now - 3600000 && at <= now).length;
  if (exempt) return { mode: 'team', minute, hour, perMinute: TEAM_LOOP_GUARD_PER_MINUTE, perHour: null };
  if (policy?.profile === 'assistant') return { mode: 'assistant', minute, hour, perMinute: policy.perMinute, perHour: policy.perHour };
  return { mode: 'attendance', minute, hour, perMinute: null, perHour: null };
}
