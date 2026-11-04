import { createRequire } from 'node:module';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export const READ_SYNC_SDK_VERSION = '7.0.0-rc14';
let installedVersion;
try { installedVersion = createRequire(import.meta.url)('@whiskeysockets/baileys/package.json').version; } catch { /* An unknown SDK must not change shared read state. */ }
export const readJid = value => typeof value === 'string' && /^(?:\d+(?::\d+)?@(s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(value) ? jidNormalizedUser(value) : null;
function positiveInteger(value) {
  try {
    if (typeof value !== 'number' && !(value && typeof value === 'object' && typeof value.toNumber === 'function')) return null;
    const number = typeof value === 'number' ? value : value.toNumber();
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  } catch { return null; }
}
export function providerReadMilliseconds(value, now, { seconds = false } = {}) {
  const stamp = positiveInteger(value), millis = stamp === null ? null : stamp * (seconds ? 1000 : 1);
  return Number.isSafeInteger(millis) && millis > 0 && millis <= now + 300000 ? millis : null;
}
export function afterManualUnread(conversation, readAtMs) {
  const markedAt = Date.parse(conversation.whatsappManualUnreadAt);
  return !Number.isFinite(markedAt) || Number.isSafeInteger(readAtMs) && readAtMs > markedAt;
}

/** Private, bounded projection of the authenticated SDK action. Never return the raw action or message content. */
export function projectReadSync(metadata, message, now, version = installedVersion) {
  if (version !== READ_SYNC_SDK_VERSION || message !== 'processing sync action' || typeof metadata?.initialSync !== 'boolean') return null;
  const mutation = metadata.syncAction, action = mutation?.syncAction?.value, read = action?.markChatAsReadAction;
  if (!Array.isArray(mutation?.index) || mutation.index.length !== 2 || mutation.index[0] !== 'markChatAsRead' || read?.read !== true) return null;
  const chatJid = readJid(mutation.index[1]), readAtMs = providerReadMilliseconds(action.timestamp, now);
  const range = read.messageRange, rangeMs = providerReadMilliseconds(range?.lastMessageTimestamp, now, { seconds: true });
  if (!chatJid || readAtMs === null || rangeMs === null || !Array.isArray(range?.messages) || !range.messages.length || range.messages.length > 256) return null;
  const anchors = [];
  for (const item of range.messages) {
    const key = item?.key, remoteJid = readJid(key?.remoteJid), hasParticipant = key?.participant !== undefined && key?.participant !== null;
    const participant = hasParticipant ? readJid(key.participant) : null;
    const messageMs = providerReadMilliseconds(item?.timestamp, now, { seconds: true });
    if (!remoteJid || typeof key?.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(key.id) || typeof key.fromMe !== 'boolean'
      || hasParticipant && !participant || messageMs === null || messageMs > rangeMs || messageMs > readAtMs
      || chatJid.endsWith('@g.us') && (remoteJid !== chatJid || !key.fromMe && !participant)
      || !chatJid.endsWith('@g.us') && remoteJid.endsWith('@g.us')) return null;
    anchors.push({ key: { id: key.id, remoteJid, fromMe: key.fromMe, ...(participant ? { participant } : {}) }, providerTs: messageMs / 1000 });
  }
  return { chatJid, readAtMs, initialSync: metadata.initialSync, anchors };
}

/** The pinned SDK exposes its range only to this exact trace hook. All diagnostics stay silent. */
export function createReadSyncLogger({ onRead, now = Date.now, version = installedVersion } = {}) {
  return { level: 'silent', child() { return this; },
    trace(metadata, message) { try { const evidence = projectReadSync(metadata, message, now(), version); if (evidence) onRead?.(evidence); } catch { /* An incompatible shape or stale connection cannot affect read state or print protocol data. */ } },
    debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}
