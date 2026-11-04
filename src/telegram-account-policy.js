import { fail } from './store.js';

export const TELEGRAM_ACCOUNT_HUMAN_ONLY_REASON = 'A conta pessoal do Telegram permite somente atendimento humano nesta versão.';

/** A transport change never turns a personal account into an AI-authorized source. */
export function isTelegramAccountChannel(channel) {
  return channel?.kind === 'telegram_user' || channel?.transport === 'telegram-user';
}

/** Resolve authority from the current tenant, never from caller-provided channel flags. */
export function telegramAccountAiAllowed(tenant, conversationOrContext) {
  const context = typeof conversationOrContext === 'string' ? { conversationId: conversationOrContext } : conversationOrContext;
  const conversationId = context?.conversationId || context?.id;
  const conversation = conversationId && tenant?.conversations?.find(item => item.id === conversationId);
  const channelId = conversation?.channelId || context?.channelId || context?.channelIdAtStart;
  return !isTelegramAccountChannel(tenant?.channels?.find(item => item.id === channelId));
}

/** No consent flag can enable AI for personal Telegram accounts in this release. */
export function assertTelegramAccountAiAllowed(tenant, conversationOrContext) {
  if (!telegramAccountAiAllowed(tenant, conversationOrContext)) fail(403, TELEGRAM_ACCOUNT_HUMAN_ONLY_REASON);
}
