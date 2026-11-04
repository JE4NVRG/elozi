// Public metadata only. A saved configuration or an inbound message is not a round-trip acceptance.
export const CHANNEL_VALIDATION_STATES = Object.freeze(['not_started', 'waiting_incoming', 'waiting_reply', 'waiting_confirmation', 'validated', 'stale']);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/\p{Cc}/u.test(value);
const date = value => value === null || typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const invalid = () => { throw new Error('O servidor não confirmou a validação deste canal.'); };

export function normalizeChannelValidation(value, { tenantId, channelId } = {}) {
  if (!value || !identity(tenantId) || !identity(channelId) || value.tenantId !== tenantId || value.channelId !== channelId
    || !Number.isSafeInteger(value.version) || value.version < 0 || !CHANNEL_VALIDATION_STATES.includes(value.state)
    || !date(value.startedAt) || !date(value.validatedAt)
    || !(value.conversationId === null || identity(value.conversationId))
    || ['incomingRecorded', 'replyRecorded', 'recipientConfirmed', 'channelAvailable'].some(key => typeof value[key] !== 'boolean')) invalid();
  if (value.state === 'validated' && (!value.incomingRecorded || !value.replyRecorded || !value.recipientConfirmed || !value.startedAt || !value.validatedAt || !value.conversationId)) invalid();
  if (value.recipientConfirmed && (!value.incomingRecorded || !value.replyRecorded)) invalid();
  if (value.replyRecorded && !value.incomingRecorded) invalid();
  if (['waiting_reply', 'waiting_confirmation'].includes(value.state) && (!value.startedAt || !value.conversationId || !value.incomingRecorded)) invalid();
  if (value.state === 'waiting_confirmation' && !value.replyRecorded) invalid();
  return {
    tenantId, channelId, version: value.version, state: value.state, startedAt: value.startedAt,
    validatedAt: value.validatedAt, conversationId: value.conversationId, incomingRecorded: value.incomingRecorded,
    replyRecorded: value.replyRecorded, recipientConfirmed: value.recipientConfirmed, channelAvailable: value.channelAvailable
  };
}

export function normalizeChannelValidationPage(value, { tenantId, channelIds = [] } = {}) {
  if (!identity(tenantId) || !value || value.tenantId !== tenantId || !Array.isArray(value.items) || value.items.length > 20
    || !Array.isArray(channelIds) || channelIds.some(id => !identity(id))) invalid();
  const allowed = new Set(channelIds), seen = new Set();
  return value.items.map(item => {
    if (!allowed.has(item?.channelId) || seen.has(item.channelId)) invalid();
    seen.add(item.channelId);
    return normalizeChannelValidation(item, { tenantId, channelId: item.channelId });
  });
}

export function channelValidatedForUse(value) {
  return value?.state === 'validated' && value.incomingRecorded === true && value.replyRecorded === true
    && value.recipientConfirmed === true && value.channelAvailable === true;
}
