// A broken transport can reject after the response headers arrived (for example HTTP/3).
// Bound the entire GET, including its body. Never retry a command or an HTTP refusal.
export function createJsonRead({ fetch: request = globalThis.fetch, timeoutMs = 12000,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  return async function readJsonResponse(path, options = {}) {
    const read = String(options.method || 'GET').toUpperCase() === 'GET';
    const external = options.signal;
    for (let attempt = 0; ; attempt++) {
      if (external?.aborted) throw external.reason || new DOMException('Aborted', 'AbortError');
      const controller = read ? new AbortController() : null;
      let timer, abort, rejectBoundary;
      const boundary = read ? new Promise((_, reject) => { rejectBoundary = reject; }) : null;
      if (read) {
        abort = () => { const reason = external.reason || new DOMException('Aborted', 'AbortError'); controller.abort(reason); rejectBoundary(reason); };
        external?.addEventListener('abort', abort, { once: true });
        timer = setTimeoutImpl(() => {
          const error = Object.assign(new Error('A conexão demorou mais que o esperado. Tente novamente.'), { code: 'READ_TIMEOUT' });
          controller.abort(error); rejectBoundary(error);
        }, timeoutMs);
      }
      let response;
      try {
        const pending = (async () => {
          response = await request(path, { ...options, ...(read ? { signal: controller.signal } : {}) });
          try { return { response, result: await response.json(), parsed: true }; }
          catch (error) {
            // Status takes precedence: an interrupted 401/403 body must still revoke/refuse.
            if (response.ok && error?.name === 'TypeError') throw error;
            return { response, result: undefined, parsed: false };
          }
        })();
        return await (read ? Promise.race([pending, boundary]) : pending);
      } catch (error) {
        if (external?.aborted) throw external.reason || error;
        if (response && !response.ok) return { response, result: undefined, parsed: false };
        const transport = error?.name === 'TypeError' || error?.code === 'READ_TIMEOUT';
        if (read && attempt === 0 && transport && (!response || response.ok)) continue;
        if (response && error?.name === 'TypeError') return { response, result: undefined, parsed: false };
        throw error;
      } finally {
        if (read) { clearTimeoutImpl(timer); external?.removeEventListener('abort', abort); }
      }
    }
  };
}
