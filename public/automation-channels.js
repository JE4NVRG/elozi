/** Public channel metadata shared by the editor and internal routing service. */
export function automationChannelSupported(channel) {
  return Boolean(channel && typeof channel.id === 'string' && channel.id && (
    channel.kind === 'whatsapp_qr' && channel.transport === 'baileys'
    || channel.kind === 'telegram' && channel.transport === 'telegram-bot'
    || channel.kind === 'webchat' && channel.transport === 'elozi-webchat'
  ));
}

export function automationChannelConnected(channel) {
  if (!automationChannelSupported(channel) || channel.state !== 'connected') return false;
  if (channel.kind !== 'webchat') return true;
  return channel.webchat?.enabled === true
    && Number.isSafeInteger(channel.webchat.version) && channel.webchat.version > 0
    && Array.isArray(channel.webchat.origins) && channel.webchat.origins.length > 0;
}
