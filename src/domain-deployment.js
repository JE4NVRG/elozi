import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { publicAddress } from './mcp-transport.js';
import { normalizeWorkspaceHost } from './workspace-domains.js';

export const DOMAIN_CHECK_HEADER = 'x-elozi-domain-check';
export const DOMAIN_CHECK_HEADER_VALUE = '1';
export const DOMAIN_NONCE_HEADER = 'x-elozi-domain-nonce';
const revisionPattern = /^[a-f0-9]{40}$/;
const challengePattern = /^[a-f0-9]{64}$/;
const challengeValid = value => typeof value === 'string' && challengePattern.test(value);
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const workspaceValid = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/\p{Cc}/u.test(value);
const versionValid = value => Number.isSafeInteger(value) && value >= 1;

/** Private runtime key stays server-side; challenge/version are taken from the current binding. */
export function signDomainProbe(proof, context, key) {
  const nonce = context?.nonce, challenge = context?.challenge, version = context?.version;
  if (!proof || !workspaceValid(proof.workspaceId) || typeof proof.sourceRevision !== 'string' || !revisionPattern.test(proof.sourceRevision) || !challengeValid(nonce) || !challengeValid(challenge) || !versionValid(version)) throw failure('Contexto da prova de domínio inválido.', 400);
  const host = normalizeWorkspaceHost(proof.host), canonicalHost = normalizeWorkspaceHost(proof.canonicalHost);
  if (host !== proof.host || canonicalHost !== proof.canonicalHost || host === canonicalHost) throw failure('Contexto da prova de domínio inválido.', 400);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw failure('A chave privada da inspeção está indisponível.');
  return createHmac('sha256', key).update(JSON.stringify(['elozi-domain-proof-v1', host, proof.workspaceId, canonicalHost, proof.sourceRevision, nonce, challenge, version])).digest('hex');
}

function normalizedAddress(value) {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  let address;
  try { address = new URL(`https://[${value}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return null; }
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(address);
  if (mapped) { const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16); return [high >> 8, high & 255, low >> 8, low & 255].join('.'); }
  return address;
}

export function isPublicDeploymentAddress(value) {
  if (typeof value !== 'string') return false;
  const address = normalizedAddress(value);
  if (!address || !publicAddress(address)) return false;
  if (isIP(address) === 4 && address.startsWith('192.88.99.')) return false;
  // Also reject transition/special-use ranges that can encapsulate another address.
  if (isIP(address) === 6) {
    const words = address.split(':');
    if (words[0] === '2002' || words[0] === '3fff' || words[0] === '2001' && parseInt(words[1] || '0', 16) <= 0x1ff) return false;
  }
  return true;
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** A single, public DNS-pinned HTTPS probe. No cookies, redirects, custom CAs or TLS exceptions. */
export function createDomainDeploymentInspector({ sourceRevision, keyLoader, lookupImpl = lookup, requestImpl = request, timeoutMs = 5000, maxBytes = 32768, maxAddresses = 16, now = Date.now } = {}) {
  if (typeof sourceRevision !== 'string' || !revisionPattern.test(sourceRevision) || [keyLoader, lookupImpl, requestImpl, now].some(value => typeof value !== 'function')) throw new Error('A inspeção de domínio exige a revisão SHA40, keyLoader privado e provedores válidos.');
  const deadlineMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000 ? timeoutMs : 5000;
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 32768 ? maxBytes : 32768;
  const addressLimit = Number.isSafeInteger(maxAddresses) && maxAddresses > 0 && maxAddresses <= 16 ? maxAddresses : 16;
  return async (value, context) => {
    const host = normalizeWorkspaceHost(value), canonicalHost = normalizeWorkspaceHost(context?.canonicalHost);
    if (!context || !workspaceValid(context.workspaceId) || !challengeValid(context.challenge) || !versionValid(context.version) || host === canonicalHost) throw failure('Contexto de implantação inválido.', 400);
    const workspaceId = context.workspaceId, challenge = context.challenge, version = context.version, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(failure('A inspeção técnica excedeu o prazo.', 504)), deadlineMs);
    let privateKey;
    try {
      let loaded;
      try { loaded = await abortable(() => keyLoader(), controller.signal); }
      catch { throw controller.signal.aborted ? controller.signal.reason : failure('A chave privada da inspeção está indisponível.'); }
      if (!Buffer.isBuffer(loaded) || loaded.length !== 32) throw failure('A chave privada da inspeção está indisponível.');
      privateKey = Buffer.from(loaded);
      const nonce = randomBytes(32).toString('hex');
      let records;
      try { records = await abortable(() => lookupImpl(host, { all: true, verbatim: true }), controller.signal); }
      catch { throw controller.signal.aborted ? controller.signal.reason : failure('Não foi possível consultar o endereço público do domínio.'); }
      if (!Array.isArray(records) || !records.length || records.length > addressLimit || records.some(record => !record || isIP(record.address) !== record.family || !isPublicDeploymentAddress(record.address))) throw failure('A resolução do domínio contém um endereço não autorizado.');
      const pinned = { address: records[0].address, family: records[0].family };
      if (controller.signal.aborted) throw controller.signal.reason;
      return await probe({ host, canonicalHost, workspaceId, sourceRevision, challenge, version, nonce, privateKey, pinned, signal: controller.signal, requestImpl, byteLimit, deadlineMs, now });
    } finally { clearTimeout(timer); privateKey?.fill(0); }
  };
}

function probe({ host, canonicalHost, workspaceId, sourceRevision, challenge, version, nonce, privateKey, pinned, signal, requestImpl, byteLimit, deadlineMs, now }) {
  return new Promise((resolve, reject) => {
    let outgoing, response, settled = false;
    const finish = (error, proof) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', aborted);
      if (error) { response?.destroy(); outgoing?.destroy(); reject(error); } else resolve(proof);
    };
    const aborted = () => finish(signal.reason || failure('A inspeção técnica excedeu o prazo.', 504));
    signal.addEventListener('abort', aborted, { once: true });
    const onResponse = incoming => {
      response = incoming;
      if (settled) { response.destroy(); return; }
      try {
        if (response.statusCode !== 200 || response.headers?.[DOMAIN_CHECK_HEADER] !== DOMAIN_CHECK_HEADER_VALUE || typeof response.headers?.['content-type'] !== 'string'
          || !/^application\/json(?:\s*;.*)?$/i.test(response.headers['content-type']) || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw failure('O domínio não retornou a prova esperada da aplicação.');
        const declared = response.headers['content-length'];
        if (declared !== undefined && (typeof declared !== 'string' || !/^\d+$/.test(declared) || Number(declared) > byteLimit)) throw failure('A prova de implantação excedeu o limite.');
        const socket = response.socket, peer = socket?.getPeerCertificate?.(true), instant = now();
        const expires = peer && Date.parse(peer.valid_to), begins = peer && Date.parse(peer.valid_from);
        if (!socket?.encrypted || socket.authorized !== true || normalizedAddress(socket.remoteAddress) !== normalizedAddress(pinned.address)
          || !peer || checkServerIdentity(host, peer) || !Number.isFinite(instant) || !Number.isFinite(expires) || !Number.isFinite(begins) || begins > instant || expires <= instant) throw failure('O certificado HTTPS ou o endereço conectado não foi comprovado.');
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
          if (bytes > byteLimit) { finish(failure('A prova de implantação excedeu o limite.')); return; }
          chunks.push(buffer);
        });
        response.once('error', () => finish(failure('A leitura da prova de implantação falhou.')));
        response.once('aborted', () => finish(failure('A prova de implantação foi interrompida.')));
        response.once('close', () => { if (!settled) finish(failure('A prova de implantação foi interrompida.')); });
        response.once('end', () => {
          if (settled) return;
          try {
            const proof = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
            if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).sort().join(',') !== 'canonicalHost,host,nonce,signature,sourceRevision,workspaceId'
              || proof.host !== host || proof.workspaceId !== workspaceId || proof.canonicalHost !== canonicalHost || proof.sourceRevision !== sourceRevision || proof.nonce !== nonce || !challengeValid(proof.signature)) throw failure('A prova de implantação não corresponde à conta e à revisão atuais.');
            const expected = signDomainProbe(proof, { nonce, challenge, version }, privateKey);
            if (!timingSafeEqual(Buffer.from(proof.signature, 'hex'), Buffer.from(expected, 'hex'))) throw failure('A assinatura privada da implantação não foi comprovada.');
            finish(null, { host, httpsOrigin: `https://${host}`, tlsValid: true, proxyVerified: true,signedRouteVerified:true, certificateExpiresAt: new Date(expires).toISOString(), sourceRevision });
          } catch { finish(failure('A prova de implantação não corresponde à conta e à revisão atuais.')); }
        });
      } catch { finish(failure('HTTPS, certificado ou prova de implantação não comprovados.')); }
    };
    try {
      outgoing = requestImpl(new URL(`https://${host}/api/domain-check`), {
        method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'Elozi-Domain-Inspector', connection: 'close', [DOMAIN_CHECK_HEADER]: DOMAIN_CHECK_HEADER_VALUE, [DOMAIN_NONCE_HEADER]: nonce },
        agent: false, servername: host, rejectUnauthorized: true, checkServerIdentity, autoSelectFamily: false, family: pinned.family, signal, timeout: deadlineMs, maxHeaderSize: 8192,
        lookup: (requestedHost, options, done) => {
          if (requestedHost !== host) { done(failure('O domínio tentou mudar o endereço inspecionado.')); return; }
          if (options?.all) done(null, [pinned]); else done(null, pinned.address, pinned.family);
        },
      }, onResponse);
      outgoing.on('error', () => finish(signal.aborted ? signal.reason : failure('Não foi possível consultar a implantação HTTPS.')));
      outgoing.on('timeout', () => finish(failure('A inspeção técnica excedeu o prazo.', 504)));
      if (settled || signal.aborted) { outgoing.destroy(); if (signal.aborted) aborted(); return; }
      outgoing.end();
    } catch { finish(failure('Não foi possível iniciar a inspeção HTTPS.')); }
  });
}
