import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { loadLocalKey } from './wa-auth.js';
import { buildSupportTicketContext, renderSupportTicketEmail } from './support-ticket-context.js';

const PROVIDER_URL = 'https://api-mepmail.je4ndev.com/emails';
const STATES = ['pending', 'in_flight', 'confirmed', 'failed', 'unknown'];
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const validApiKey = value => typeof value === 'string' && /^ms_[A-Za-z0-9_-]{12,509}$/.test(value);

function address(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s<>\r\n]/.test(value)) return null;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value) ? value : null;
}

function sender(value) {
  if (typeof value !== 'string' || value.length > 340 || /[\r\n\x00-\x1f\x7f]/.test(value)) return null;
  const normalized = value.trim();
  if (address(normalized)) return normalized;
  const display = normalized.match(/^([^<>]{1,80})\s<([^<>]+)>$/);
  return display && address(display[2]) ? normalized : null;
}

function origin(value) {
  let url;
  try { url = new URL(value); } catch { invalid('Endereço público do produto inválido.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) invalid('Use HTTPS no endereço público ou HTTP apenas no computador local.');
  return url.origin;
}

function metadata(row) {
  return { id: row.id, state: row.state, messageId: row.message_id || null, attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class EmailService {
  #apiKey;
  #from;
  #origin;
  #fetch;
  #keyPromise;
  #running = null;
  #controller = null;
  #closed = false;

  constructor(db, { apiKey, from, publicOrigin = 'http://127.0.0.1:4318', fetchImpl = fetch, key } = {}) {
    this.db = db;
    this.#apiKey = validApiKey(apiKey) ? apiKey : null;
    this.#from = sender(from);
    this.#origin = origin(publicOrigin);
    this.#fetch = fetchImpl;
    if (typeof fetchImpl !== 'function') invalid('Transporte de e-mail inválido.');
    if (key !== undefined && (!(key instanceof Uint8Array) || key.length !== 32)) invalid('Chave local de e-mail inválida.');
    this.#keyPromise = key === undefined ? null : Promise.resolve(Buffer.from(key));
    db.exec(`CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      request_hash TEXT NOT NULL UNIQUE, payload BLOB NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','in_flight','confirmed','failed','unknown')),
      attempts INTEGER NOT NULL DEFAULT 0, message_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    // A stopped process may already have delivered the message to the provider.
    db.prepare("UPDATE email_outbox SET state='unknown',updated_at=? WHERE state='in_flight'").run(new Date().toISOString());
  }

  validateConfiguration({ apiKey, from, publicOrigin } = {}) {
    if (this.#closed) throw Object.assign(new Error('Transporte de e-mail encerrado.'), { status: 409 });
    if (this.#running) throw Object.assign(new Error('Aguarde o envio em andamento para alterar o provedor.'), { status: 409 });
    if (apiKey !== undefined && apiKey !== '' && !validApiKey(apiKey)) invalid('Chave de envio MepMail inválida.');
    if (from !== undefined && from !== '' && !sender(from)) invalid('Remetente de e-mail inválido.');
    return publicOrigin === undefined ? this.#origin : origin(publicOrigin);
  }

  configure({ apiKey, from, publicOrigin } = {}) {
    const nextOrigin = this.validateConfiguration({apiKey,from,publicOrigin});
    if (apiKey !== undefined) this.#apiKey = apiKey || null;
    if (from !== undefined) this.#from = sender(from);
    this.#origin = nextOrigin;
    return this.status();
  }

  status() {
    const counts = Object.fromEntries(STATES.map(state => [state === 'in_flight' ? 'inFlight' : state, 0]));
    for (const row of this.db.prepare('SELECT state,count(*) AS count FROM email_outbox GROUP BY state').all()) counts[row.state === 'in_flight' ? 'inFlight' : row.state] = row.count;
    return { provider: 'mepmail', configured: Boolean(this.#apiKey && this.#from), from: this.#from, ...counts };
  }

  async #key() {
    this.#keyPromise ||= loadLocalKey();
    const key = await this.#keyPromise;
    if (!(key instanceof Uint8Array) || key.length !== 32) invalid('Chave local de e-mail inválida.');
    return key;
  }

  #locale(value, userId, invitationId) {
    if (value !== undefined) {
      if (!['pt-BR', 'en'].includes(value)) invalid('Escolha Português (Brasil) ou English para o e-mail.');
      return value;
    }
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_users'").get() || !this.db.prepare('PRAGMA table_info(auth_users)').all().some(column => column.name === 'locale')) return 'pt-BR';
    let id = userId;
    if (invitationId && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_invitations'").get()) id = this.db.prepare('SELECT creator_id FROM auth_invitations WHERE id=?').get(invitationId)?.creator_id;
    return this.db.prepare('SELECT locale FROM auth_users WHERE id=?').get(typeof id === 'string' ? id : '')?.locale === 'en' ? 'en' : 'pt-BR';
  }

  async enqueueVerification({ userId, email, name = '', token, locale } = {}) {
    if (this.#closed) throw Object.assign(new Error('Transporte de e-mail encerrado.'), { status: 409 });
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 160 || /[\x00-\x1f\x7f]/.test(userId)) invalid('Usuário de confirmação inválido.');
    if (!address(email)) invalid('E-mail de confirmação inválido.');
    if (typeof name !== 'string' || name.length > 160 || /[\x00-\x1f\x7f]/.test(name)) invalid('Nome de confirmação inválido.');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(token)) invalid('Confirmação de e-mail inválida.');
    const english = this.#locale(locale, userId) === 'en';
    const key = await this.#key();
    if (this.#closed) throw Object.assign(new Error('Transporte de e-mail encerrado.'), { status: 409 });
    const hash = createHmac('sha256', key).update(JSON.stringify([userId, email.toLowerCase(), token])).digest('hex');
    const existing = this.db.prepare('SELECT * FROM email_outbox WHERE request_hash=?').get(hash);
    if (existing) return metadata(existing);
    const id = randomUUID(), date = new Date().toISOString();
    const link = `${this.#origin}/verify-email?token=${encodeURIComponent(token)}`;
    const greeting = name.trim() ? `${english ? 'Hello' : 'Olá'}, ${name.trim()}!` : english ? 'Hello!' : 'Olá!';
    const title = english ? 'Confirm your email' : 'Confirme seu e-mail', explanation = english ? 'Confirm your email to start using Elozi' : 'Confirme seu e-mail para começar a usar a Elozi';
    const notice = english ? 'If you did not create this account, ignore this message.' : 'Se você não criou esta conta, ignore esta mensagem.', team = english ? 'The Elozi team' : 'Equipe Elozi';
    const payload = {
      from: this.#from,
      to: [email],
      subject: `${title} — Elozi`,
      text: `${greeting}\n\n${explanation}:\n${link}\n\n${notice}\n\n${team}`,
      html: `<div style="font-family:Arial,sans-serif;color:#182132;line-height:1.6"><p>${escapeHtml(greeting)}</p><h1 style="font-size:24px">${title}</h1><p>${explanation}.</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2458e8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${english ? 'Confirm email' : 'Confirmar e-mail'}</a></p><p>${notice}</p><p>${team}</p></div>`
    };
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`elozi:email:${id}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    this.db.prepare('INSERT INTO email_outbox VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, userId, 'verification', hash, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), 'pending', 0, null, date, date);
    return metadata(this.db.prepare('SELECT * FROM email_outbox WHERE id=?').get(id));
  }

  async enqueueInvitation({ invitationId, email, name = '', token, workspaceName, expiresAt, locale } = {}) {
    if (typeof invitationId !== 'string' || !invitationId.trim() || invitationId.length > 120 || /\p{Cc}/u.test(invitationId)) invalid('Convite de acesso inválido.');
    return this.#enqueueAccess({ kind: 'invitation', userId: `invitation:${invitationId}`, email, name, token, workspaceName, expiresAt, locale: this.#locale(locale, null, invitationId) });
  }
  async enqueueSupportHandoff({tenantId,channelId,conversationId,jobId,email,reason,authorize,getContext,locale = 'pt-BR'} = {}) {
    if (typeof authorize !== 'function' || authorize() !== true) invalid('Autorização de suporte necessária.');
    for (const value of [tenantId,channelId,conversationId,jobId,reason]) if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) invalid('Transferência de suporte inválida.');
    if (!address(email)) invalid('E-mail de suporte inválido.');
    if (typeof getContext !== 'function' || !['pt-BR','en'].includes(locale)) invalid('Contexto autorizado de suporte necessário.');
    const key = await this.#key();
    if (this.#closed || authorize() !== true) throw Object.assign(new Error('A transferência de suporte mudou.'),{status:409});
    const digest = createHmac('sha256',key).update(JSON.stringify(['support_handoff',tenantId,channelId,conversationId,jobId,email.toLowerCase()])).digest('hex');
    // Resolve only after the key await: pre-await tenant/contact snapshots can become stale.
    const records = getContext();
    if (records?.then) { Promise.resolve(records).catch(()=>{}); invalid('O contexto de suporte precisa ser síncrono.'); }
    if (authorize() !== true) throw Object.assign(new Error('A transferência de suporte mudou.'),{status:409});
    const context = buildSupportTicketContext({tenantId,channelId,conversationId,jobId,reason,records,locale});
    const existing = this.db.prepare('SELECT * FROM email_outbox WHERE request_hash=?').get(digest);
    if (existing) return metadata(existing);
    const link = `${this.#origin}/#inbox/${encodeURIComponent(tenantId)}/${encodeURIComponent(conversationId)}`;
    const payload = renderSupportTicketEmail(context,{from:this.#from,email,link});
    const id = randomUUID(),date = new Date().toISOString(),iv = randomBytes(12),cipher = createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from(`elozi:email:${id}`));const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final()]);
    if (authorize() !== true) throw Object.assign(new Error('A transferência de suporte mudou.'),{status:409});
    this.db.prepare('INSERT INTO email_outbox VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,`support:${tenantId}`,'support_handoff',digest,Buffer.concat([iv,cipher.getAuthTag(),encrypted]),'pending',0,null,date,date);
    return metadata(this.db.prepare('SELECT * FROM email_outbox WHERE id=?').get(id));
  }

  async enqueuePasswordReset({ userId, email, name = '', token, expiresAt, locale } = {}) {
    return this.#enqueueAccess({ kind: 'password_reset', userId, email, name, token, expiresAt, locale: this.#locale(locale, userId) });
  }

  supportHandoffStatus({id,tenantId,authorize} = {}) {
    if (typeof authorize !== 'function' || authorize() !== true) invalid('Autorização de suporte necessária.');
    if (![id,tenantId].every(value=>typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value))) invalid('Recibo de suporte inválido.');
    const row = this.db.prepare("SELECT id,state,message_id,attempts,created_at,updated_at FROM email_outbox WHERE id=? AND user_id=? AND kind='support_handoff'").get(id,`support:${tenantId}`);
    return row ? metadata(row) : null;
  }

  async #enqueueAccess({ kind, userId, email, name, token, workspaceName, expiresAt, locale }) {
    if (this.#closed) throw Object.assign(new Error('Transporte de e-mail encerrado.'), { status: 409 });
    if (!['invitation', 'password_reset'].includes(kind) || typeof userId !== 'string' || !userId.trim() || userId.length > 160 || /[\x00-\x1f\x7f]/.test(userId)) invalid('Identidade de acesso inválida.');
    if (!address(email)) invalid('E-mail de acesso inválido.');
    const english = locale === 'en';
    if (workspaceName === undefined) workspaceName = kind === 'invitation' ? english ? 'your team' : 'sua equipe' : '';
    for (const value of [name, workspaceName]) if (typeof value !== 'string' || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) invalid('Nome de acesso inválido.');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(token) || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) invalid('Link de acesso inválido.');
    const key = await this.#key();
    if (this.#closed) throw Object.assign(new Error('Transporte de e-mail encerrado.'), { status: 409 });
    const hash = createHmac('sha256', key).update(JSON.stringify([kind, userId, email.toLowerCase(), token])).digest('hex');
    const existing = this.db.prepare('SELECT * FROM email_outbox WHERE request_hash=?').get(hash);
    if (existing) return metadata(existing);
    const invitation = kind === 'invitation', link = `${this.#origin}/${invitation ? 'accept-invite' : 'reset-password'}#token=${encodeURIComponent(token)}`;
    const greeting = name.trim() ? `${english ? 'Hello' : 'Olá'}, ${name.trim()}!` : english ? 'Hello!' : 'Olá!';
    const title = invitation ? english ? 'Your invitation to Elozi' : 'Seu convite para a Elozi' : english ? 'Reset your Elozi password' : 'Redefina sua senha da Elozi';
    const explanation = invitation ? english ? `You have been invited to ${workspaceName}. Choose your sign-in details and your own password.` : `Você recebeu um convite para ${workspaceName}. Escolha seus dados de acesso e sua própria senha.` : english ? 'You requested a new password for your account. Resetting it will end your previous sessions.' : 'Você solicitou uma nova senha para a sua conta. Ao redefini-la, as sessões anteriores serão encerradas.';
    const action = invitation ? english ? 'Accept invitation' : 'Aceitar convite' : english ? 'Set a new password' : 'Definir nova senha';
    const notice = invitation ? english ? 'If you were not expecting this invitation, ignore this message.' : 'Se você não esperava este convite, ignore esta mensagem.' : english ? 'If you did not request this change, ignore this message. Your password remains unchanged.' : 'Se você não pediu a alteração, ignore esta mensagem. Sua senha permanece a mesma.';
    const expiry = new Date(expiresAt).toLocaleString(english ? 'en-US' : 'pt-BR', { timeZone: 'America/Sao_Paulo' });
    const validity = english ? `Valid until ${expiry} (Brasília time).` : `Válido até ${expiry} (horário de Brasília).`, team = english ? 'The Elozi team' : 'Equipe Elozi';
    const payload = { from: this.#from, to: [email], subject: title,
      text: `${greeting}\n\n${explanation}\n${link}\n\n${validity}\n${notice}\n\n${team}`,
      html: `<div style="font-family:Arial,sans-serif;color:#182132;line-height:1.6"><p>${escapeHtml(greeting)}</p><h1 style="font-size:24px">${escapeHtml(title)}</h1><p>${escapeHtml(explanation)}</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2458e8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${action}</a></p><p>${escapeHtml(validity)}</p><p>${escapeHtml(notice)}</p><p>${team}</p></div>` };
    const id = randomUUID(), date = new Date().toISOString(), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`elozi:email:${id}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    this.db.prepare('INSERT INTO email_outbox VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, userId, kind, hash, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), 'pending', 0, null, date, date);
    return metadata(this.db.prepare('SELECT * FROM email_outbox WHERE id=?').get(id));
  }

  async flush() {
    if (this.#closed || !this.#apiKey || !this.#from) return this.status();
    if (this.#running) return this.#running;
    this.#running = this.#drain();
    try { return await this.#running; } finally { this.#running = null; }
  }

  async #drain() {
    const key = await this.#key();
    const rows = this.db.prepare("SELECT id FROM email_outbox WHERE state='pending' ORDER BY created_at,id LIMIT 100").all();
    for (const { id } of rows) {
      if (this.#closed) break;
      const claimed = this.db.prepare("UPDATE email_outbox SET state='in_flight',attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), id);
      if (claimed.changes !== 1) continue;
      let state = 'failed', messageId = null, attempted = false;
      try {
        const row = this.db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(id);
        const blob = Buffer.from(row.payload), decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
        decipher.setAAD(Buffer.from(`elozi:email:${id}`)); decipher.setAuthTag(blob.subarray(12, 28));
        const payload = JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString());
        payload.from ||= this.#from;
        this.#controller = new AbortController();
        attempted = true;
        const response = await this.#fetch(PROVIDER_URL, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
          body: JSON.stringify(payload), signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(30_000)])
        });
        if (response.ok) {
          const result = await response.json();
          if (typeof result?.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(result.id)) { state = 'confirmed'; messageId = result.id; }
          else state = 'unknown';
        } else state = response.status >= 400 && response.status < 500 ? 'failed' : 'unknown';
      } catch { state = attempted ? 'unknown' : 'failed'; }
      finally { this.#controller = null; }
      this.db.prepare("UPDATE email_outbox SET state=?,message_id=?,updated_at=? WHERE id=? AND state='in_flight'").run(state, messageId, new Date().toISOString(), id);
    }
    return this.status();
  }

  async close() {
    this.#closed = true;
    this.#controller?.abort();
    if (this.#running) await this.#running;
  }
}
