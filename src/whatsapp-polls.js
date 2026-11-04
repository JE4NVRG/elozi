import { createHash, createHmac } from 'node:crypto';
import { decryptPollVote, jidNormalizedUser } from '@whiskeysockets/baileys';
import { fail } from './store.js';

/**
 * Native WhatsApp polls of a connected agent (reply.send with `poll`, WhatsApp QR only): single choice, sent through
 * Baileys. The poll's messageSecret is derived from the local session key, the channel and the Elozi message id, so a
 * vote can be decrypted later without the secret ever being written to the database, a backup or a DTO.
 *
 * A vote is a pollUpdateMessage encrypted with that secret (AES-256-GCM over a key bound to the poll id, the creator's
 * JID and the voter's JID). Since the LID migration either side may be addressed by its phone JID or its LID, so every
 * known pair is tried: the GCM tag authenticates the right one and rejects any other.
 */
export const POLL_LIMITS = Object.freeze({ question: 255, minOptions: 2, maxOptions: 12, option: 100, selectableCount: 1 });
const length = value => Array.from(value).length;
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const USER_JID = /^[^@\s]{1,80}@(s\.whatsapp\.net|lid)$/;

/** The poll of a reply request: question, 2 to 12 distinct one-line options and a single choice per vote. */
export function normalizePoll(value) {
  if (!plain(value) || Object.keys(value).some(key => !['question', 'options', 'selectableCount'].includes(key))) fail(400, 'Informe a enquete somente com question, options e selectableCount.');
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  if (!question || length(question) > POLL_LIMITS.question || /[\x00-\x09\x0b-\x1f\x7f]/.test(question)) fail(400, `A pergunta da enquete precisa ter de 1 a ${POLL_LIMITS.question} caracteres.`);
  if (!Array.isArray(value.options) || value.options.length < POLL_LIMITS.minOptions || value.options.length > POLL_LIMITS.maxOptions) fail(400, `A enquete precisa de ${POLL_LIMITS.minOptions} a ${POLL_LIMITS.maxOptions} opções.`);
  const options = value.options.map(option => typeof option === 'string' ? option.trim() : '');
  if (options.some(option => !option || length(option) > POLL_LIMITS.option || /[\x00-\x1f\x7f]/.test(option))) fail(400, `Cada opção da enquete precisa ter de 1 a ${POLL_LIMITS.option} caracteres, numa linha.`);
  if (new Set(options).size !== options.length) fail(400, 'As opções da enquete precisam ser diferentes.');
  if (value.selectableCount !== undefined && value.selectableCount !== POLL_LIMITS.selectableCount) fail(400, 'A enquete aceita uma opção por voto (selectableCount: 1).');
  return { question, options, selectableCount: POLL_LIMITS.selectableCount };
}
/** Readable line of a poll in the timeline, the outbox and the panel, in the same shape as a poll the contact sends. */
export const pollText = poll => `[Enquete] ${poll.question} · ${poll.options.join(' / ')}`;
/** A channel that sends native polls: the WhatsApp QR line through Baileys, direct conversations only. */
export const pollChannel = channel => channel?.kind === 'whatsapp_qr' && channel.transport === 'baileys';
/** 32-byte messageSecret of one poll, recomputed when its votes arrive. */
export function pollSecret(key, channelId, messageId) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail(503, 'Chave local da sessão indisponível para a enquete.');
  return createHmac('sha256', key).update(`elozi:whatsapp-poll-secret:v1\0${channelId}\0${messageId}`).digest();
}
/** WhatsApp identifies an option in a vote by the SHA-256 of its text. */
export const pollOptionHash = option => createHash('sha256').update(Buffer.from(option, 'utf8')).digest('hex');

/** The pollUpdateMessage of an incoming message (also inside an ephemeral wrapper), or null. */
export function incomingPollUpdate(message) {
  let inner = message;
  for (let depth = 0; depth < 5 && (inner?.ephemeralMessage?.message || inner?.deviceSentMessage?.message); depth++) inner = inner.ephemeralMessage?.message || inner.deviceSentMessage.message;
  const update = inner?.pollUpdateMessage, key = update?.pollCreationMessageKey;
  if (!update || typeof key?.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(key.id)) return null;
  const vote = update.vote, valid = bytes => bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 4096;
  return vote && valid(vote.encPayload) && valid(vote.encIv) ? update : null;
}
/** Normalized, distinct user JIDs (phone or LID), device suffix removed. */
export function pollJids(values) {
  const jids = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    let jid;
    try { jid = jidNormalizedUser(value); } catch { continue; }
    if (USER_JID.test(jid) && !jids.includes(jid)) jids.push(jid);
  }
  return jids.slice(0, 8);
}
/**
 * Decrypts a vote of a poll whose options are known. Returns { state: 'ok', selectedOptions } in the poll's order,
 * 'empty' for a withdrawn vote, 'invalid' when a selection is not one of the options or exceeds the single choice,
 * and 'undecryptable' when no creator/voter pair authenticates (another poll, another secret or a tampered payload).
 */
export function decryptPollSelection(update, { secret, pollMessageId, options, creatorJids, voterJids }) {
  for (const creator of pollJids(creatorJids)) for (const voter of pollJids(voterJids)) {
    let decoded;
    try { decoded = decryptPollVote(update.vote, { pollEncKey: secret, pollCreatorJid: creator, pollMsgId: pollMessageId, voterJid: voter }); }
    catch { continue; }
    const hashes = (Array.isArray(decoded?.selectedOptions) ? decoded.selectedOptions : []).map(hash => Buffer.from(hash).toString('hex'));
    if (!hashes.length) return { state: 'empty' };
    const byHash = new Map(options.map(option => [pollOptionHash(option), option]));
    if (hashes.length > POLL_LIMITS.selectableCount || hashes.some(hash => !byHash.has(hash))) return { state: 'invalid' };
    const chosen = new Set(hashes.map(hash => byHash.get(hash)));
    return { state: 'ok', selectedOptions: options.filter(option => chosen.has(option)) };
  }
  return { state: 'undecryptable' };
}
/**
 * Poll fields of a public message for a connected agent: the poll it sent ({ poll }) or a contact's vote, which the
 * service reads as kind 'poll_vote' with the Elozi id of the poll message and the chosen option texts.
 */
export function servicePollFields(message) {
  const vote = message?.kind === 'customer' ? message.pollVote : null;
  if (plain(vote) && typeof vote.pollMessageId === 'string' && Array.isArray(vote.selectedOptions)) return { kind: 'poll_vote', pollMessageId: vote.pollMessageId, selectedOptions: vote.selectedOptions.filter(option => typeof option === 'string') };
  const poll = ['agent', 'human'].includes(message?.kind) ? message.poll : null;
  if (plain(poll) && typeof poll.question === 'string' && Array.isArray(poll.options)) return { poll: { question: poll.question, options: poll.options.filter(option => typeof option === 'string'), selectableCount: POLL_LIMITS.selectableCount } };
  return {};
}
