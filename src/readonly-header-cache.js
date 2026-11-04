const DEFAULTS = Object.freeze({ maxEntries: 32, maxBytes: 32 * 1024 ** 2, maxHeaderBytes: 4 * 1024 ** 2 });

export function freezeReadonly(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeReadonly(nested);
  }
  return value;
}

/** Parse reuse only. A token hit requires current SQL authority and the same SQL-maintained header token. */
export class ReadonlyHeaderCache {
  #entries = new Map();
  #bytes = 0;
  #limits;

  constructor(options = {}) {
    this.#limits = { ...DEFAULTS, ...options };
    for (const [name, maximum] of Object.entries(DEFAULTS)) {
      if (!Number.isSafeInteger(this.#limits[name]) || this.#limits[name] < 1 || this.#limits[name] > maximum) throw new TypeError('Limite interno de cache inválido.');
    }
  }
  get size() { return this.#entries.size; }
  get bytes() { return this.#bytes; }

  #key(workspaceId, tenantId) {
    if (typeof workspaceId !== 'string' || typeof tenantId !== 'string') throw new TypeError('Escopo interno de cache inválido.');
    return JSON.stringify([workspaceId, tenantId]);
  }
  #remove(key) {
    const previous = this.#entries.get(key);
    if (previous) { this.#entries.delete(key); this.#bytes -= previous.bytes; }
  }
  invalidate(workspaceId, tenantId) { this.#remove(this.#key(workspaceId, tenantId)); }
  clear() { this.#entries.clear(); this.#bytes = 0; }

  // A hint is never authority. It only controls whether the live SQL SELECT needs
  // to return its large header. Neither the hint nor this cache authorizes a read.
  token(workspaceId, tenantId) { return this.#entries.get(this.#key(workspaceId, tenantId))?.token ?? null; }
  readToken(workspaceId, tenantId, token) {
    const key = this.#key(workspaceId, tenantId), previous = this.#entries.get(key);
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) { this.#remove(key); throw new TypeError('Token interno de cache inválido.'); }
    if (!previous || previous.token !== token) { this.#remove(key); return undefined; }
    this.#entries.delete(key); this.#entries.set(key, previous);
    return { value: previous.value };
  }

  read(workspaceId, tenantId, rawHeader, token) {
    const key = this.#key(workspaceId, tenantId);
    if (typeof rawHeader !== 'string') { this.#remove(key); throw new TypeError('Header interno de cache inválido.'); }
    if (token !== undefined && (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token))) { this.#remove(key); throw new TypeError('Token interno de cache inválido.'); }
    const previous = this.#entries.get(key);
    if (previous?.raw === rawHeader) {
      if (token !== undefined) previous.token = token;
      this.#entries.delete(key); this.#entries.set(key, previous);
      return previous.value;
    }
    // Never keep another version of this scope, including parse failure or an oversized replacement.
    this.#remove(key);
    const bytes = Buffer.byteLength(rawHeader, 'utf8'), value = freezeReadonly(JSON.parse(rawHeader));
    if (bytes > this.#limits.maxHeaderBytes || bytes > this.#limits.maxBytes) return value;
    while (this.#entries.size >= this.#limits.maxEntries || this.#bytes + bytes > this.#limits.maxBytes) this.#remove(this.#entries.keys().next().value);
    this.#entries.set(key, { raw: rawHeader, value, bytes, token }); this.#bytes += bytes;
    return value;
  }
}
