import { fail } from './store.js';

const defaults = () => ({ customerMessagesAfter: null, excludedChannelIds: [], allowGroups: true });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19) || 0) > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
/** Manager-authored restriction, never a grant. null restores the existing unrestricted policy. */
export function normalizeServiceConversationPolicy(value) {
  if (value === undefined || value === null) return defaults();
  if (typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key => !['customerMessagesAfter', 'excludedChannelIds', 'allowGroups'].includes(key))) fail(400, 'Informe somente as restrições de conversa permitidas.');
  const result = defaults();
  if (value.customerMessagesAfter !== undefined && value.customerMessagesAfter !== null) {
    result.customerMessagesAfter = timestamp(value.customerMessagesAfter);
    if (!result.customerMessagesAfter) fail(400, 'Informe um corte de mensagens com data, hora e fuso válidos.');
  }
  if (value.excludedChannelIds !== undefined) {
    if (!Array.isArray(value.excludedChannelIds) || value.excludedChannelIds.length > 100 || value.excludedChannelIds.some(item => !identifier(item))) fail(400, 'Escolha até 100 canais válidos para excluir.');
    result.excludedChannelIds = [...new Set(value.excludedChannelIds)].sort();
  }
  if (value.allowGroups !== undefined) {
    if (typeof value.allowGroups !== 'boolean') fail(400, 'Defina explicitamente se grupos são permitidos.');
    result.allowGroups = value.allowGroups;
  }
  return result;
}
/** Evaluate the latest recorded customer message, NOT conversation.updatedAt or a human/system action. */
export function serviceConversationDecision(policy, conversation) {
  if (!conversation) return { allowed: false, reason: 'missing_conversation' };
  if (policy.excludedChannelIds.includes(conversation.channelId)) return { allowed: false, reason: 'excluded_channel' };
  if (!policy.allowGroups && conversation.conversationKind === 'group') return { allowed: false, reason: 'groups_disabled' };
  if (!policy.customerMessagesAfter) return { allowed: true, reason: null };
  const latest = (Array.isArray(conversation.messages) ? conversation.messages : []).findLast(message => message?.kind === 'customer');
  const at = timestamp(latest?.createdAt);
  if (!at) return { allowed: false, reason: 'customer_timestamp_unknown' };
  if (latest.deliveredLate === true) return { allowed: false, reason: 'customer_message_delivered_late' };
  if (at < policy.customerMessagesAfter) return { allowed: false, reason: 'customer_message_before_cutoff' };
  return { allowed: true, reason: null };
}
