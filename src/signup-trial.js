import { createHmac } from 'node:crypto';
import { fail } from './store.js';

export const SIGNUP_TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
const canonicalInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const digit = remainder => remainder < 2 ? 0 : 11 - remainder;

/** Accept only the plain identifier or its complete standard punctuation. */
export function normalizeFiscalDocument(input) {
  if (typeof input !== 'string') fail(400, 'Informe um CPF ou CNPJ válido para iniciar o teste.');
  const value = input.trim().toUpperCase();
  let document, kind;
  if (/^\d{11}$/.test(value) || /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(value)) {
    document = value.replace(/[.-]/g, ''); kind = 'cpf';
    if (/^(\d)\1{10}$/.test(document)) fail(400, 'Informe um CPF ou CNPJ válido para iniciar o teste.');
    for (let length = 9; length <= 10; length++) {
      const sum = [...document.slice(0, length)].reduce((total, number, index) => total + Number(number) * (length + 1 - index), 0);
      if (Number(document[length]) !== digit(sum % 11)) fail(400, 'Informe um CPF ou CNPJ válido para iniciar o teste.');
    }
  } else if (/^[A-Z0-9]{12}\d{2}$/.test(value) || /^[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2}$/.test(value)) {
    document = value.replace(/[./-]/g, ''); kind = 'cnpj';
    if (/^(\d)\1{13}$/.test(document)) fail(400, 'Informe um CPF ou CNPJ válido para iniciar o teste.');
    // Receita Federal: each character is ASCII - 48, weights 2..9 right to left.
    for (let length = 12; length <= 13; length++) {
      const sum = [...document.slice(0, length)].reduce((total, character, index) => total + (character.charCodeAt(0) - 48) * (2 + (length - 1 - index) % 8), 0);
      if (Number(document[length]) !== digit(sum % 11)) fail(400, 'Informe um CPF ou CNPJ válido para iniciar o teste.');
    }
  } else fail(400, 'Informe um CPF ou CNPJ válido para iniciar o teste.');
  return { kind, document };
}

/** Private HMAC reservations. Neither raw document nor digest enters a workspace DTO. */
export class SignupTrials {
  #prepared = new WeakMap();

  constructor(db, { keyLoader, now = Date.now } = {}) {
    if (!db?.prepare || typeof keyLoader !== 'function' || typeof now !== 'function') throw new Error('O teste de cadastro exige banco, chave privada e relógio.');
    Object.assign(this, { db, keyLoader, now });
    db.exec(`CREATE TABLE IF NOT EXISTS signup_trial_registrations (
      workspace_id TEXT PRIMARY KEY REFERENCES resellers(id), identity_digest TEXT NOT NULL UNIQUE,
      document_kind TEXT NOT NULL CHECK(document_kind IN ('cpf','cnpj')),
      starts_at TEXT NOT NULL, expires_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS signup_trial_tombstones (
      identity_digest TEXT PRIMARY KEY, document_kind TEXT NOT NULL CHECK(document_kind IN ('cpf','cnpj')), deleted_at TEXT NOT NULL
    );`);
    // Tombstones survive account deletion (no workspace key): a deleted account's document cannot start a new trial.
  }

  trial(timestamp = this.now()) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isFinite(new Date(timestamp + SIGNUP_TRIAL_MS).getTime())) fail(500, 'Relógio do teste de cadastro inválido.');
    return Object.freeze({ startsAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + SIGNUP_TRIAL_MS).toISOString() });
  }

  window() { return this.trial(); }

  async prepare(input) {
    const { kind, document } = normalizeFiscalDocument(input);
    let key;
    try { key = await this.keyLoader(); } catch { fail(503, 'O cadastro de teste está temporariamente indisponível.'); }
    if (!Buffer.isBuffer(key) || key.length !== 32) fail(503, 'O cadastro de teste está temporariamente indisponível.');
    const digest = createHmac('sha256', key).update('mepchat-signup-document:v1\0').update(kind).update('\0').update(document).digest('hex');
    const onboardingTrial = this.window(), prepared = Object.freeze({ onboardingTrial });
    this.#prepared.set(prepared, { digest, kind, onboardingTrial });
    return prepared;
  }

  reserve(workspaceId, prepared) {
    const reservation = prepared && this.#prepared.get(prepared);
    if (!reservation || prepared.onboardingTrial !== reservation.onboardingTrial || this.db.isTransaction !== true) fail(500, 'A reserva de teste exige o cadastro preparado e sua transação.');
    if (typeof workspaceId !== 'string' || !/^reseller_[0-9a-f-]{36}$/.test(workspaceId)) fail(500, 'A reserva de teste exige a conta recém-criada.');
    const { digest, kind, onboardingTrial } = reservation;
    if (!canonicalInstant(onboardingTrial.startsAt) || !canonicalInstant(onboardingTrial.expiresAt)) fail(500, 'Período de teste inválido.');
    if (this.used(digest)) fail(409, 'Este CPF ou CNPJ já iniciou um teste. Entre na conta existente ou peça ajuda ao responsável.');
    this.db.prepare('INSERT INTO signup_trial_registrations VALUES (?,?,?,?,?)').run(workspaceId, digest, kind, onboardingTrial.startsAt, onboardingTrial.expiresAt);
    return onboardingTrial;
  }

  /** A digest is used while its registration exists and after the account is deleted (tombstone). */
  used(digest) { return Boolean(this.db.prepare('SELECT 1 FROM signup_trial_registrations WHERE identity_digest=? UNION ALL SELECT 1 FROM signup_trial_tombstones WHERE identity_digest=? LIMIT 1').get(digest, digest)); }

  registered(workspaceId) { return Boolean(this.db.prepare('SELECT 1 FROM signup_trial_registrations WHERE workspace_id=?').get(workspaceId)); }
}
