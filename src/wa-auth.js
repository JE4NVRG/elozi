import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

export async function loadLocalKey() {
  const path = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'MEPChat', 'wa-auth.key');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error('Chave local de sessão inválida.');
  return key;
}

export function encryptedAuthState(db, channelId, key) {
  db.exec('CREATE TABLE IF NOT EXISTS wa_auth (channel_id TEXT NOT NULL, category TEXT NOT NULL, item_id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(channel_id,category,item_id))');
  const aad = (category, id) => Buffer.from(JSON.stringify([channelId, category, id]));
  const read = (category, id) => {
    const row = db.prepare('SELECT payload FROM wa_auth WHERE channel_id=? AND category=? AND item_id=?').get(channelId, category, id);
    if (!row) return null;
    const blob = Buffer.from(row.payload), decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    decipher.setAAD(aad(category, id)); decipher.setAuthTag(blob.subarray(12, 28));
    const bytes = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
    return JSON.parse(bytes.toString(), BufferJSON.reviver);
  };
  const save = (category, id, data) => {
    if (data == null) { db.prepare('DELETE FROM wa_auth WHERE channel_id=? AND category=? AND item_id=?').run(channelId, category, id); return; }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(category, id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data, BufferJSON.replacer)), cipher.final()]);
    db.prepare('INSERT OR REPLACE INTO wa_auth VALUES (?,?,?,?)').run(channelId, category, id, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
  };
  const creds = read('creds', 'main') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            let value = read(type, id);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            result[id] = value;
          }
          return result;
        },
        set: async data => {
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const [category, items] of Object.entries(data)) for (const [id, value] of Object.entries(items)) save(category, id, value);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
      }
    },
    saveCreds: () => save('creds', 'main', creds)
  };
}
