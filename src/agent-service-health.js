import { createHermesProvider } from './agent-runtime.js';

const TIMEOUT_MS = 5000;
const HEALTH_BYTES = 4096;
const CATALOG_BYTES = 16 * 1024;
const FAILURE = 'O serviço não respondeu com o modelo configurado.';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The deadline covers headers AND streaming the decoded body. Never use an unbounded text()/json() fallback.
async function boundedJson(target, { apiKey, fetchImpl }, maxBytes) {
  const controller = new AbortController();
  let response, reader, complete = false, cancelled;
  const cancelBody = () => {
    const body = reader ?? response?.body;
    if (!body || body === cancelled) return;
    cancelled = body;
    try { Promise.resolve(body.cancel()).catch(() => {}); } catch {}
  };
  controller.signal.addEventListener('abort', cancelBody, { once: true });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(FAILURE)); }, TIMEOUT_MS);
  });
  const request = (async () => {
    try {
      response = await fetchImpl(target.href, {
        method: 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!response?.ok || response.redirected || response.url && new URL(response.url).origin !== target.origin) throw new Error(FAILURE);
      const declared = response.headers?.get('content-length');
      if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error(FAILURE);
      if (typeof response.body?.getReader !== 'function') throw new Error(FAILURE);
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (chunk.done) { complete = true; break; }
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new Error(FAILURE);
        chunks.push(chunk.value);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    } finally {
      if (!complete) cancelBody();
      try { reader?.releaseLock(); } catch {}
    }
  })();
  try { return await Promise.race([request, deadline]); }
  finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', cancelBody);
    if (!complete) controller.abort();
  }
}

/**
 * Server-owned configuration only; this is discovery, NOT an inference/readiness test.
 * One GET /health, and at most one GET /v1/models on the exact validated origin. No retries or POSTs.
 * Returns only proven metadata; neither remote bodies nor transport exceptions escape to the caller.
 */
export async function checkAgentServiceHealth({ endpoint, allowedOrigins = [], apiKey, model, fetchImpl = globalThis.fetch } = {}) {
  try {
    // Reuse the production endpoint/credential/origin guard without ever invoking its inference closure.
    createHermesProvider({ endpoint, allowedOrigins, apiKey, model, fetchImpl });
    const healthTarget = new URL('/health', endpoint);
    const health = await boundedJson(healthTarget, { apiKey, fetchImpl }, HEALTH_BYTES);
    if (!record(health) || health.status !== 'ok') throw new Error(FAILURE);
    if (Object.hasOwn(health, 'model')) {
      // An explicit null, empty or different model is authoritative failure, never a catalog fallback.
      if (health.model !== model) throw new Error(FAILURE);
      return { reachable: true, model, source: 'health' };
    }
    if (health.platform !== 'hermes-agent') throw new Error(FAILURE);
    const catalogTarget = new URL('/v1/models', healthTarget);
    const catalog = await boundedJson(catalogTarget, { apiKey, fetchImpl }, CATALOG_BYTES);
    if (!record(catalog) || catalog.object !== 'list' || !Array.isArray(catalog.data)
      || !catalog.data.every(item => record(item) && item.object === 'model' && typeof item.id === 'string' && item.id.trim())
      || !catalog.data.some(item => item.id === model)) throw new Error(FAILURE);
    return { reachable: true, model, source: 'catalog' };
  } catch {
    // No cause/status/body/URL/API key from an untrusted service or transport exception.
    throw new Error(FAILURE);
  }
}
