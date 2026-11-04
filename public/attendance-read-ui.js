import { t } from './i18n.js';

export function canSyncDeviceRead(conversation, { userId, supportGrantId, channels = [] } = {}) {
  const channel = channels.find(item => item.id === conversation?.channelId);
  return Boolean(userId && !supportGrantId && conversation?.owner === 'human' && conversation.assignedUserId === userId && channel?.kind === 'whatsapp_qr' && channel.transport === 'baileys');
}

export function readStateCommand(conversation, version, unread, context) {
  return { version, unread, ...(!unread && canSyncDeviceRead(conversation, context) ? { syncDevice: true } : {}) };
}

export function canRefreshDeviceReads(conversation, { role, supportGrantId, channels = [] } = {}) {
  const channel = channels.find(item => item.id === conversation?.channelId);
  return Boolean(role === 'reseller' && !supportGrantId && channel?.kind === 'whatsapp_qr' && channel.transport === 'baileys');
}

export function deviceReadStateNotice(result) {
  return result?.state === 'synced' ? t('{count} conversas atualizadas com as leituras do WhatsApp.', { count: Number(result.updatedConversations) || 0 })
    : t('O WhatsApp ainda não confirmou a atualização das leituras. As conversas sem confirmação continuam não lidas.');
}

export function readActionLabel(conversation, context) {
  if (!conversation?.unread) return t('Marcar como não lida no painel');
  return canSyncDeviceRead(conversation, context) ? t('Marcar como lida no WhatsApp e no painel') : t('Marcar como lida no painel');
}

export function readSyncNotice(result) {
  if (result?.readSync?.state === 'pending') return t('Lida no painel. A atualização no WhatsApp não foi confirmada. Você pode sincronizar a leitura pelo menu da conversa.');
  return result?.readSync?.state === 'synced' ? t('Leitura atualizada no painel e enviada ao WhatsApp.') : t('Leitura atualizada no painel.');
}

export function attendanceResponseIsCurrent(incoming, current) {
  if (!incoming || !current || incoming.id !== current.id || incoming.channelId !== current.channelId || Number(incoming.version) < Number(current.version)) return false;
  const ids = new Set((incoming.messages || []).map(message => message.id));
  return (current.messages || []).every(message => ids.has(message.id));
}
