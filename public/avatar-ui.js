export function rasterAvatar(photo, maxLength = 700 * 1024) {
  if (typeof photo !== 'string' || photo.length > maxLength) return false;
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
  return Boolean(match && match[1].length % 4 === 0);
}

export function createAvatarUI({ escape: e, context, fetchImpl = fetch }) {
  let scope = '', generation = 0, observer;
  const cache = new Map(), pending = new Map(), controllers = new Set();
  let inFlight = 0;
  const waiting = [];
  const acquire = () => new Promise(resolve => { if (inFlight < 4) { inFlight++; resolve(); } else waiting.push(resolve); });
  const release = () => { if (waiting.length) waiting.shift()(); else inFlight--; };
  const initials = name => String(name || '?').trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
  // A consolidated list can show several companies before one is selected. An explicit
  // authorized company catalog keeps that cache alive when opening another company.
  // Legacy callers without a catalog remain confined to their selected company.
  const tenantIds = actor => Array.isArray(actor?.tenantIds) ? [...new Set(actor.tenantIds.filter(id => typeof id === 'string' && id))].sort() : null;
  const contextKey = actor => JSON.stringify([actor?.userId || '', actor?.workspaceId || '', actor?.accessVersion || '', tenantIds(actor) ?? actor?.tenantId ?? '']);
  const current = epoch => epoch === generation && scope === contextKey(context());
  function markup(name, photo, cls = '', reference) {
    const owner = reference?.tenantId || context()?.tenantId;
    const attrs = reference ? ` data-avatar-kind="${e(reference.kind)}" data-avatar-id="${e(reference.id)}"${owner ? ` data-avatar-tenant="${e(owner)}"` : ''}` : '';
    return `<span class="avatar ${e(cls)}" aria-hidden="true"${attrs}><span class="avatar-initials">${e(initials(name))}</span>${rasterAvatar(photo) ? `<img src="${e(photo)}" alt="" decoding="async"/>` : ''}</span>`;
  }
  function reset() {
    generation++; observer?.disconnect(); observer = null;
    for (const controller of controllers) controller.abort();
    controllers.clear(); pending.clear();
    for (const item of cache.values()) if (item.url) URL.revokeObjectURL(item.url);
    cache.clear(); scope = '';
    if (typeof document !== 'undefined') for (const image of document.querySelectorAll('[data-avatar-provider]')) {
      image.closest('.avatar,.ui-avatar')?.classList.remove('has-photo'); image.remove();
    }
  }
  function show(element, url) {
    if (!element.isConnected || !url || element.querySelector('img')) return;
    const image = document.createElement('img'); image.alt = ''; image.decoding = 'async';
    image.dataset.avatarProvider = 'true';
    if (element.classList.contains('ui-avatar')) image.className = 'ui-avatar__img';
    image.addEventListener('load', () => element.classList.add('has-photo'), { once: true });
    image.addEventListener('error', () => { element.classList.remove('has-photo'); image.remove(); }, { once: true });
    image.src = url; element.append(image);
  }
  function remember(key, url) {
    cache.set(key, { url, expires: Date.now() + (url ? 15 * 60_000 : 60_000) });
    while (cache.size > 96) { const oldest = cache.keys().next().value; const entry = cache.get(oldest); if (entry.url) URL.revokeObjectURL(entry.url); cache.delete(oldest); }
  }
  async function load(element, actor) {
    const kind = element.dataset.avatarKind, id = element.dataset.avatarId, tenantId = element.dataset.avatarTenant || actor.tenantId;
    const allowed = tenantIds(actor);
    if (!['conversations', 'contacts', 'channels'].includes(kind) || !id || !actor.userId || !actor.workspaceId || !tenantId
      || (allowed ? !allowed.includes(tenantId) : tenantId !== actor.tenantId)) return;
    const key = JSON.stringify([tenantId, kind, id]), epoch = generation;
    const sameReference = () => element.dataset.avatarKind === kind && element.dataset.avatarId === id
      && (element.dataset.avatarTenant || context()?.tenantId) === tenantId;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) { if (current(epoch) && sameReference()) show(element, cached.url); return; }
    if (cached) { if (cached.url) URL.revokeObjectURL(cached.url); cache.delete(key); }
    if (!pending.has(key)) {
      const controller = new AbortController(); controllers.add(controller);
      const request = (async () => {
        await acquire();
        try {
          if (!current(epoch) || controller.signal.aborted) return null;
          const response = await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/${kind}/${encodeURIComponent(id)}/avatar`, {
            headers: { 'X-Elozi-Workspace': actor.workspaceId }, credentials: 'same-origin', signal: controller.signal
          });
          if (!response.ok || !/^image\/(?:png|jpeg|webp)$/.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > 512 * 1024) return null;
          const bytes = await response.arrayBuffer();
          if (!current(epoch) || controller.signal.aborted || !bytes.byteLength || bytes.byteLength > 512 * 1024) return null;
          return URL.createObjectURL(new Blob([bytes], { type: response.headers.get('content-type') }));
        } catch { return null; }
        finally { controllers.delete(controller); release(); }
      })().then(url => { if (current(epoch)) remember(key, url); else if (url) URL.revokeObjectURL(url); return current(epoch) ? url : null; });
      pending.set(key, request);
      request.finally(() => { if (pending.get(key) === request) pending.delete(key); });
    }
    const url = await pending.get(key);
    if (current(epoch) && element.isConnected && sameReference()) show(element, url);
  }
  function bind() {
    const actor = context(), nextScope = contextKey(actor);
    if (nextScope !== scope) { reset(); scope = nextScope; }
    observer?.disconnect();
    for (const image of document.querySelectorAll('.avatar img,.ui-avatar img')) {
      const element = image.closest('.avatar,.ui-avatar');
      const loaded = () => element.classList.add('has-photo');
      image.addEventListener('load', loaded, { once: true });
      image.addEventListener('error', () => { element.classList.remove('has-photo'); image.remove(); }, { once: true });
      if (image.complete && image.naturalWidth) loaded();
    }
    const elements = document.querySelectorAll('[data-avatar-kind]:not(:has(img))');
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); load(entry.target, actor); } }, { rootMargin: '100px' });
      for (const element of elements) observer.observe(element);
    } else for (const element of elements) load(element, actor);
  }
  return { markup, bind, reset };
}
