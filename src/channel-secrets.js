import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export function encryptedChannelSecrets(db, key) {
  db.exec('CREATE TABLE IF NOT EXISTS channel_secrets (channel_id TEXT PRIMARY KEY, payload BLOB NOT NULL)');
  return {
    get(channelId) {
      const row = db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get(channelId);
      if (!row) return null;
      const blob = Buffer.from(row.payload), decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
      decipher.setAAD(Buffer.from(`mepchat:channel:${channelId}`)); decipher.setAuthTag(blob.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString());
    },
    set(channelId, value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`mepchat:channel:${channelId}`));
      const payload = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      db.prepare('INSERT OR REPLACE INTO channel_secrets VALUES (?,?)').run(channelId, Buffer.concat([iv, cipher.getAuthTag(), payload]));
    }
  };
}
