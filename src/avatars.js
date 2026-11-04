import { selectedGroup } from './group-workspace.js';

export const AVATAR_MAX_BYTES = 512 * 1024;

/** Only raster bytes are returned. Provider URLs and credentials never enter the cache. */
export function avatarImage(bytes) {
  const data = Buffer.from(bytes);
  if (!data.length || data.length > AVATAR_MAX_BYTES) return null;
  const png = data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.readUInt32BE(8) === 13 && data.toString('latin1', 12, 16) === 'IHDR'
    && data.readUInt32BE(16) > 0 && data.readUInt32BE(16) <= 4096
    && data.readUInt32BE(20) > 0 && data.readUInt32BE(20) <= 4096
    && data.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  const jpeg = data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255
    && data[data.length - 2] === 255 && data[data.length - 1] === 217;
  const webp = data.length >= 20 && data.toString('latin1', 0, 4) === 'RIFF'
    && data.readUInt32LE(4) === data.length - 8 && data.toString('latin1', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('latin1', 12, 16));
  const mime = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : null;
  return mime ? { bytes: data, mime } : null;
}

export async function readAvatarResponse(response, signal) {
  if (!response?.ok || response.redirected || !response.body || signal?.aborted) {
    await response?.body?.cancel?.().catch(() => {}); return null;
  }
  const declared = Number(response.headers?.get('content-length') || 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > AVATAR_MAX_BYTES) {
    await response.body.cancel?.().catch(() => {}); return null;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) return avatarImage(Buffer.concat(chunks, size));
      size += value.byteLength;
      if (size > AVATAR_MAX_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
    return null;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

const bounded = (value, fallback, ceiling) => Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
const copyImage = image => image ? { bytes: Buffer.from(image.bytes), mime: image.mime } : null;

/** On-demand, bounded, volatile cache; authorization remains at the HTTP boundary. */
export class AvatarService {
  constructor(store, { gateway, telegram, telegramUser, fetchImpl, now = Date.now, positiveTtlMs = 15 * 60 * 1000, negativeTtlMs = 5 * 60 * 1000, maxEntries = 128, maxCacheBytes = 16 * 1024 * 1024, maxPending = 8, timeoutMs = 10000 } = {}) {
    this.store = store; this.gateway = gateway; this.telegram = telegram; this.telegramUser = telegramUser; this.fetchImpl = fetchImpl; this.now = now;
    this.positiveTtlMs = bounded(positiveTtlMs, 15 * 60 * 1000, 60 * 60 * 1000);
    this.negativeTtlMs = bounded(negativeTtlMs, 5 * 60 * 1000, 15 * 60 * 1000);
    this.maxEntries = bounded(maxEntries, 128, 256); this.maxCacheBytes = bounded(maxCacheBytes, 16 * 1024 * 1024, 32 * 1024 * 1024);
    this.maxPending = bounded(maxPending, 8, 16); this.timeoutMs = bounded(timeoutMs, 10000, 10000);
    this.cache = new Map(); this.pending = new Map(); this.cacheBytes = 0; this.pendingCount = 0;
    this.connections = new WeakMap(); this.nextConnection = 0;
  }
  resolve(actor, tenantId, channelId, peer) {
    const tenant = this.store.tenant(actor, tenantId), channel = tenant.channels.find(item => item.id === channelId);
    const gateway = channel?.transport === 'baileys' ? this.gateway : channel?.transport === 'telegram-bot' ? this.telegram : channel?.transport === 'telegram-user' ? this.telegramUser : null;
    const entry = gateway?.entries?.get(channelId);
    if (!entry || entry.tenantId !== tenantId || entry.state !== 'connected' || entry.stopped || gateway.closing || channel.state !== 'connected') return null;
    if (channel.transport === 'baileys' && (!entry.matched || !entry.socket)) return null;
    if (peer && channel.transport === 'baileys') {
      if (!/^(?:\d+(?::\d+)?@(s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(peer)) return null;
      if (peer.endsWith('@g.us') && !(channel.allowedGroups || []).includes(peer)) return null;
    }
    if (peer && channel.transport === 'telegram-bot') {
      if (!/^-?[1-9]\d{0,15}$/.test(peer) || !Number.isSafeInteger(Number(peer))) return null;
      if (peer.startsWith('-') && !selectedGroup(channel, { channelId, remoteChatId: peer })) return null;
    }
    if(peer && channel.transport==='telegram-user' && !(channel.telegramUser?.selectedPeerIds||[]).includes(peer))return null;
    if (!this.connections.has(entry)) this.connections.set(entry, ++this.nextConnection);
    return { gateway, entry, connectionId: this.connections.get(entry), channel, peer };
  }
  async conversation(actor, tenantId, conversationId) {
    try {
      const tenant = this.store.tenant(actor, tenantId), conversation = tenant.conversations.find(item => item.id === conversationId);
      if (!conversation) return null;
      const channel = tenant.channels.find(item => item.id === conversation.channelId);
      const peer = channel?.transport === 'baileys' ? conversation.remoteJid : ['telegram-bot','telegram-user'].includes(channel?.transport) ? conversation.remoteChatId : null;
      if (typeof peer !== 'string' || !peer) return null;
      return await this.get(actor, tenantId, conversation.channelId, peer);
    } catch { return null; }
  }
  async channel(actor, tenantId, channelId) {
    try { return await this.get(actor, tenantId, channelId); } catch { return null; }
  }
  remove(key) {
    const previous = this.cache.get(key);
    if (previous) { this.cacheBytes -= previous.image?.bytes.length || 0; this.cache.delete(key); }
  }
  trim() {
    for (const [key, value] of this.cache) if (value.expires <= this.now()) this.remove(key);
    while (this.cache.size > this.maxEntries || this.cacheBytes > this.maxCacheBytes) this.remove(this.cache.keys().next().value);
  }
  async get(actor, tenantId, channelId, peer) {
    const current = this.resolve(actor, tenantId, channelId, peer);
    if (!current) return null;
    const key = JSON.stringify([tenantId, channelId, current.channel.transport, peer || 'self']);
    this.trim();
    const cached = this.cache.get(key);
    if (cached && cached.connectionId === current.connectionId) {
      this.cache.delete(key); this.cache.set(key, cached);
      return copyImage(cached.image);
    }
    this.remove(key);
    const pending = this.pending.get(key);
    if (pending?.connectionId === current.connectionId) {
      const image = await pending.promise;
      return this.resolve(actor, tenantId, channelId, peer)?.connectionId === current.connectionId ? copyImage(image) : null;
    }
    if (this.pendingCount >= this.maxPending) return null;
    const controller = new AbortController();
    const task = { connectionId: current.connectionId }; this.pendingCount++;
    task.promise = (async () => {
      let timer;
      try {
        const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeoutMs); });
        const request = Promise.resolve().then(() => current.gateway.avatar(actor, tenantId, channelId, { peer, signal: controller.signal, fetchImpl: this.fetchImpl })).catch(() => null);
        const result = await Promise.race([request, timeout]);
        const stillCurrent = this.resolve(actor, tenantId, channelId, peer);
        if (!stillCurrent || stillCurrent.entry !== current.entry) return null;
        const image = result?.bytes ? avatarImage(result.bytes) : null;
        this.remove(key);
        this.cache.set(key, { connectionId: current.connectionId, image, expires: this.now() + (image ? this.positiveTtlMs : this.negativeTtlMs) });
        this.cacheBytes += image?.bytes.length || 0; this.trim();
        return image;
      } catch { return null; }
      finally { clearTimeout(timer); this.pendingCount--; if (this.pending.get(key) === task) this.pending.delete(key); }
    })();
    this.pending.set(key, task);
    return copyImage(await task.promise);
  }
}
