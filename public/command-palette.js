// Command palette (FRONTEND-V2 §2.5, §8.3 P2): Ctrl/⌘K and the search of the topbar. It replaces the
// finder of areas of navigation-search-ui.js (no longer used; removed in P10).
//
// - Combobox with a listbox and aria-activedescendant: ↑/↓ move, Enter opens, Shift+Enter opens and
//   keeps the palette open, Esc closes (the dialog of the panel, #modal, returns the focus).
// - Prefixes: none = mixed search with the recent routes first; ">" contextual actions (only the
//   controls this person has on screen); "@" contacts of the open company; "#" companies, channels
//   and workspaces of this person.
// - Sources: the screens this person may open (getItems of app.js, old names included and shown as
//   "agora em Configurações › Equipe"), GET /api/inbox?q=&limit=8 for conversations and GET
//   /api/tenants/:id/contacts?search= from 2 characters (cut to 8 on the client), debounced 150 ms
//   with an AbortController per keystroke. Authority is checked again when an item is chosen.
// - Privacy: the recent list keeps only routes (never a customer name); labels are resolved on show.
import { h, t } from './i18n.js';
import './locales-live.js';
import './locales-palette-recovery.js';
import { glyph } from './icons.js';
import { badge } from './ui.js';
import { dispatchAction } from './actions.js';
import { conversationHash, hubOf, navItemOf } from './nav-config.js';
import { formatHash, parseHash } from './router.js';
import { liveContext, liveFeatures, liveRegistry } from './live.js';
import { sessionExpired } from './session-guard.js';

export const PALETTE_DEBOUNCE = 150;
const RECENT_LIMIT = 8, RESULT_LIMIT = 8;
const normalize = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (haystack, query) => { const terms = normalize(query).trim().split(/\s+/).filter(Boolean); const words = normalize(haystack); return terms.every(term => words.includes(term)); };

/** Splits the prefix of the query: {mode: 'all'|'actions'|'people'|'places', text}. */
export function parseQuery(value) {
  const raw = String(value ?? '').replace(/^\s+/, ''), first = raw[0];
  const mode = first === '>' ? 'actions' : first === '@' ? 'people' : first === '#' ? 'places' : 'all';
  return { mode, text: (mode === 'all' ? raw : raw.slice(1)).trim() };
}

/** Where a screen of the old menu lives now ("agora em Configurações › Equipe"), or ''. */
export function newHome(key) {
  const owner = navItemOf(key), place = hubOf(key);
  if (!owner) return '';
  const tab = place?.tab?.label && place.tab.label !== owner.label ? place.tab.label : '';
  return [owner.label, tab].filter(Boolean).join(' › ');
}

/** Screens matching the text, with the old name and the new place in the searchable text. */
export function screenResults(items, text) {
  return items.map(item => {
    const home = newHome(item.key), moved = home && home !== item.label ? home : '';
    return { kind: 'screen', id: item.key, label: item.label, detail: moved ? t('agora em {place}', { place: moved }) : item.description || '', glyph: item.glyph || 'arrow', route: item.key, search: [item.label, item.description, item.key, moved].join(' ') };
  }).filter(item => !text || matches(item.search, text));
}

/** Contextual actions: only the controls that are on screen and enabled for this person. */
export function actionResults(doc, text) {
  const visible = node => node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' && !node.closest?.('[hidden], [inert]');
  const find = selector => [...(doc?.querySelectorAll?.(selector) || [])].find(visible);
  const list = [
    { id: 'takeover', label: t('Assumir a conversa'), selector: '[data-action="takeover"]', glyph: 'user' },
    { id: 'transfer', label: t('Transferir a conversa'), selector: '[data-action="transfer-conversation"]', glyph: 'arrow' },
    { id: 'close', label: t('Encerrar a conversa'), selector: '[data-action="conversation-close"]', glyph: 'check' },
    { id: 'draft', label: t('Gerar rascunho com o agente'), selector: '[data-action="run-agent"]', glyph: 'spark' },
    { id: 'presence', label: t('Mudar disponibilidade'), selector: '[data-shell-toggle="account"]', glyph: 'user', focus: 'input[name="shell-presence"]:checked' },
    { id: 'locale', label: t('Trocar idioma'), selector: '[data-shell-toggle="account"]', glyph: 'globe', focus: 'input[name="shell-locale"]:checked' },
    { id: 'pending', label: t('Abrir Pendências'), selector: '[data-action="shell:pending"]', glyph: 'bell', action: 'shell:pending' },
    { id: 'team', label: t('Abrir Equipe'), selector: '[data-action="shell:team"]', glyph: 'users', action: 'shell:team' },
    { id: 'shortcuts', label: t('Atalhos do teclado'), selector: '[data-action="shell:shortcuts"]', glyph: 'keyboard', action: 'shell:shortcuts', always: true }
  ];
  return list.map(item => ({ ...item, control: item.always ? doc?.querySelector?.(item.selector) || true : find(item.selector) }))
    .filter(item => item.control && (!text || matches(item.label, text)))
    .map(item => ({ kind: 'action', id: item.id, label: item.label, detail: '', glyph: item.glyph, run: item }));
}

/** Workspaces and companies of the scope selector of the shell (what this person may open). */
export function placeResults(doc, catalog, text, tenantId) {
  const results = [];
  for (const node of doc?.querySelectorAll?.('#sh-scope-panel [data-shell-option]') || []) {
    const action = node.getAttribute('data-action'), label = (node.getAttribute('data-shell-search') || node.textContent || '').trim();
    if (!['shell:workspace', 'shell:tenant'].includes(action) || node.getAttribute('aria-current') === 'true') continue;
    results.push({ kind: action === 'shell:workspace' ? 'workspace' : 'company', id: node.getAttribute('data-id'), grant: node.getAttribute('data-grant') || '', label, detail: action === 'shell:workspace' ? t('Workspace') : t('Empresa'), glyph: action === 'shell:workspace' ? 'grid' : 'building', search: label });
  }
  for (const channel of catalog?.channels || []) if (channel?.id && channel.tenantId === tenantId) {
    results.push({ kind: 'channel', id: channel.id, label: String(channel.name || t('Canal')), detail: t('Canal'), glyph: 'link', search: `${channel.name || ''} ${channel.kind || ''}` });
  }
  return results.filter(item => !text || matches(item.search, text));
}

/**
 * createCommandPalette({getItems, getAuthority, openModal, getModal, navigate, canOpen, request}) →
 * {open, keydown, close}. getItems/getAuthority/openModal/getModal/navigate/canOpen are the ones
 * app.js already passes; request (api) is optional: without it only screens, places and actions appear.
 */
export function createCommandPalette({ getItems = () => [], getAuthority = () => '', openModal, getModal = () => null, navigate = () => {}, canOpen = () => true, request = null,
  registry = liveRegistry, storage, timers = globalThis, document: doc = globalThis.document, location: loc = globalThis.location } = {}) {
  let session = null, sequence = 0;
  // app.js does not hand its api() to the palette yet: the same GET with the session cookie, the
  // workspace and the support grant of the context; a 401 goes to the session guard like any other.
  request ||= typeof globalThis.fetch === 'function' ? async (path, { signal, headers } = {}) => {
    const context = liveContext(registry);
    const response = await globalThis.fetch(path, { signal, credentials: 'same-origin', headers: { ...(context.supportGrantId ? { 'X-Elozi-Support-Grant': context.supportGrantId } : {}), ...headers } });
    if (response.status === 401) { sessionExpired({ reason: 'session-expired' }); throw Object.assign(new Error(t('Entre para continuar.')), { status: 401 }); }
    if (!response.ok) throw Object.assign(new Error(t('Não foi possível buscar agora.')), { status: response.status });
    return response.json();
  } : null;
  const store = () => { if (storage !== undefined) return storage; try { return globalThis.localStorage; } catch { return null; } };
  const recentKey = () => `elozi:palette:recent:${liveContext(registry).userId || 'anonymous'}`;
  const readRecent = () => { try { const value = JSON.parse(store()?.getItem(recentKey()) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, RECENT_LIMIT) : []; } catch { return []; } };
  function remember(route) {
    if (!route) return;
    try { store()?.setItem(recentKey(), JSON.stringify([route, ...readRecent().filter(item => item !== route)].slice(0, RECENT_LIMIT))); } catch {}
  }
  const api = (path, signal) => request(path, { signal, headers: { 'X-Elozi-Workspace': liveContext(registry).workspaceId } });
  const tenantId = () => { const context = liveContext(registry); if (context.tenantId) return context.tenantId; try { return store()?.getItem(`elozi-tenant:${context.workspaceId}`) || ''; } catch { return ''; } };

  function recentResults(items, catalog) {
    const screens = new Map(items.map(item => [item.key, item]));
    return readRecent().map(route => {
      if (route.startsWith('view:')) { const item = screens.get(route.slice(5)); return item ? { kind: 'screen', id: item.key, label: item.label, detail: t('Recente'), glyph: item.glyph || 'clock', route: item.key, recent: true } : null; }
      const parsed = parseHash(route);
      if (parsed?.section === 'inbox' && parsed.params?.conversationId) {
        const company = (catalog?.tenants || []).find(item => item.id === parsed.params.tenantId)?.name;
        return { kind: 'conversation', id: route, label: t('Conversa recente'), detail: company || t('Recente'), glyph: 'chat', hash: route, recent: true };
      }
      return null;
    }).filter(Boolean);
  }

  async function search(text, mode, signal) {
    const tasks = [];
    const collect = (path, source, rows) => api(path, signal).then(page => ({ items: rows(page), failed: null }))
      .catch(() => ({ items: [], failed: source }));
    if (request && (mode === 'all' || mode === 'conversations') && text.length >= 1) {
      tasks.push(collect(`/api/inbox?${new URLSearchParams({ status: 'all', q: text.slice(0, 200), limit: String(RESULT_LIMIT) })}`, 'conversations', page => {
        if (!Array.isArray(page?.items)) throw new TypeError('Invalid conversation search');
        return page.items.slice(0, RESULT_LIMIT).map(item => ({
          kind: 'conversation', id: `${item.tenantId}/${item.id}`, label: String(item.contact || t('Conversa')), detail: [item.tenantName, item.channelName].filter(Boolean).join(' · '), glyph: 'chat', hash: conversationHash({ tenantId: item.tenantId, conversationId: item.id })
        }));
      }));
    }
    const company = tenantId();
    if (request && company && (mode === 'all' || mode === 'people') && text.length >= 2) {
      // limit=8 only where the server lists "contacts-limit"; otherwise the client cuts the list.
      const query = new URLSearchParams({ search: text.slice(0, 120), ...(liveFeatures(registry).has('contacts-limit') ? { limit: String(RESULT_LIMIT) } : {}) });
      tasks.push(collect(`/api/tenants/${encodeURIComponent(company)}/contacts?${query}`, 'contacts', result => {
        if (!Array.isArray(result?.contacts)) throw new TypeError('Invalid contact search');
        return result.contacts.slice(0, RESULT_LIMIT).map(contact => {
          let hash = '#contacts';
          try { hash = formatHash({ section: 'contacts', params: { tenantId: company, contactId: contact.id }, query: {} }); } catch {}
          return { kind: 'contact', id: contact.id, label: String(contact.name || contact.phone || t('Contato')), detail: t('Contato'), glyph: 'user', hash };
        });
      }));
    }
    const pages = await Promise.all(tasks);
    return { items: pages.flatMap(page => page.items), failures: pages.map(page => page.failed).filter(Boolean) };
  }

  async function catalogOf(signal) {
    if (!request) return null;
    try { return await api('/api/inbox?status=active&unread=1&limit=1', signal); } catch { return null; }
  }

  function optionMarkup(item, index, active) {
    const kinds = { screen: t('Tela'), conversation: t('Conversa'), contact: t('Contato'), action: t('Ação'), company: t('Empresa'), workspace: t('Workspace'), channel: t('Canal') };
    return h`<li class="lv-palette__option" role="option" id="${`lv-palette-option-${index}`}" aria-selected="${index === active ? 'true' : 'false'}" data-palette-index="${index}"><span class="lv-palette__glyph" aria-hidden="true">${glyph(item.glyph || 'arrow')}</span><span class="lv-palette__copy"><span class="lv-palette__label">${item.label}</span>${item.detail ? h`<span class="lv-palette__detail">${item.detail}</span>` : ''}</span>${badge(item.recent ? t('Recente') : kinds[item.kind] || '', item.recent ? 'accent' : 'neutral')}</li>`;
  }
  function paint() {
    if (!session) return;
    const { list, input, status, recovery, failureNote } = session;
    list.innerHTML = String(h`${session.results.map((item, index) => optionMarkup(item, index, session.active))}`);
    const current = session.results[session.active];
    if (current) input.setAttribute?.('aria-activedescendant', `lv-palette-option-${session.active}`); else input.removeAttribute?.('aria-activedescendant');
    list.querySelector?.('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    const failed = session.searchFailures?.length > 0;
    const failure = failed ? (session.searchFailures.includes('contacts') && !session.searchFailures.includes('conversations') ? t('Não foi possível buscar contatos. Os demais resultados foram preservados.') : session.searchFailures.includes('conversations') && !session.searchFailures.includes('contacts') ? t('Não foi possível buscar conversas. Os demais resultados foram preservados.') : t('Não foi possível concluir a busca. Os resultados exibidos são parciais.')) : '';
    status.textContent = session.loading ? t('Buscando…') : failed ? failure : session.results.length ? t('{count} resultados', { count: session.results.length }) : session.query.text || session.query.mode !== 'all' ? t('Nada encontrado. Tente outro termo ou prefixo.') : '';
    if (recovery) recovery.hidden = session.loading || !failed;
    if (failureNote) failureNote.textContent = failure;
  }
  function local(query) {
    const items = getItems(), screens = screenResults(items, query.text);
    if (query.mode === 'actions') return actionResults(doc, query.text);
    if (query.mode === 'places') return placeResults(doc, session.catalog, query.text, tenantId());
    if (query.mode === 'people') return [];
    if (!query.text) return [...recentResults(items, session.catalog), ...screens.filter(item => !readRecent().includes(`view:${item.id}`))].slice(0, 12);
    return [...screens.slice(0, 6), ...actionResults(doc, query.text).slice(0, 3), ...placeResults(doc, session.catalog, query.text, tenantId()).slice(0, 3)];
  }
  function update(value) {
    if (!session) return;
    const query = parseQuery(value), ticket = ++sequence;
    session.query = query;
    session.controller?.abort();
    session.controller = null;
    session.results = local(query); session.active = session.results.length ? 0 : -1; session.loading = false; session.searchFailures = [];
    timers.clearTimeout?.(session.timer);
    const remote = request && (query.mode === 'all' && query.text.length >= 1 || query.mode === 'people' && query.text.length >= 2);
    if (remote) {
      session.loading = true;
      session.timer = timers.setTimeout(async () => {
        if (!session || ticket !== sequence) return;
        const controller = new AbortController(); session.controller = controller;
        const found = await search(query.text, query.mode, controller.signal);
        if (!session || ticket !== sequence || controller.signal.aborted) return;
        session.results = query.mode === 'people' ? found.items : [...session.results.slice(0, 6), ...found.items];
        session.searchFailures = found.failures;
        session.active = session.results.length ? Math.max(0, session.active) : -1; session.loading = false;
        paint();
      }, PALETTE_DEBOUNCE);
    }
    paint();
  }

  async function choose(index, { keep = false } = {}) {
    const item = session?.results[index];
    if (!item) return false;
    const authority = session.authority, modal = session.modal;
    if (authority !== getAuthority()) { modal?.close?.(); return false; }
    if (!keep) modal?.close?.();
    if (item.kind === 'screen') {
      if (!getItems().some(entry => entry.key === item.route)) return false;
      remember(`view:${item.route}`);
      navigate(item.route);
    } else if (item.kind === 'conversation' || item.kind === 'contact') {
      if (item.kind === 'conversation') remember(item.hash);
      if (loc) loc.hash = item.hash;
    } else if (item.kind === 'company') await dispatchAction('shell:tenant', null, null, item.id);
    else if (item.kind === 'workspace') await dispatchAction('shell:workspace', { dataset: { id: item.id, grant: item.grant } }, null, item.id);
    else if (item.kind === 'channel') { try { if (loc) loc.hash = formatHash({ section: 'channels', params: { channelId: item.id }, query: {} }); } catch {} }
    else if (item.kind === 'action') {
      const { run } = item;
      if (run.action) await dispatchAction(run.action, run.control === true ? null : run.control);
      else if (run.control?.click) { run.control.click(); if (run.focus) timers.setTimeout(() => doc?.querySelector?.(run.focus)?.focus?.(), 0); }
    }
    if (keep && session) session.input.focus();
    return true;
  }

  function close() { session?.modal?.close?.(); }
  /** Opens the palette in the dialog of the panel; false when another dialog is open or the panel is busy. */
  function open(initial = '') {
    if (!canOpen() || getModal()?.open || typeof openModal !== 'function') return false;
    const returnFocus = doc?.activeElement;
    openModal(t('Buscar ou executar'), t('Telas, conversas e contatos. Use > para ações, @ para pessoas e # para empresas e canais.'), h`<div class="lv-palette" data-palette>
      <label class="sr-only" for="lv-palette-input">${t('Buscar ou executar')}</label>
      <input id="lv-palette-input" class="lv-palette__input" type="text" role="combobox" aria-expanded="true" aria-controls="lv-palette-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" maxlength="200" placeholder="${t('Buscar conversa, contato ou tela')}" data-palette-input/>
      <ul id="lv-palette-list" class="lv-palette__list" role="listbox" aria-label="${t('Resultados')}" data-palette-list></ul>
      <p class="lv-palette__foot"><span>${t('↑ ↓ escolhem · Enter abre · Shift+Enter abre e mantém aberta · Esc fecha')}</span></p>
      <div data-palette-recovery hidden><p class="lv-palette__foot" data-palette-failure></p><button type="button" class="ui-btn ui-btn--secondary ui-btn--md" data-palette-retry>${t('Tentar busca novamente')}</button></div>
      <p class="sr-only" role="status" aria-live="polite" data-palette-status></p>
    </div>`);
    const modal = getModal(), input = modal?.querySelector?.('[data-palette-input]'), list = modal?.querySelector?.('[data-palette-list]'), status = modal?.querySelector?.('[data-palette-status]');
    if (!input || !list || !status) return true;
    modal.classList?.add?.('lv-palette-dialog');
    const recovery = modal.querySelector?.('[data-palette-recovery]'), failureNote = modal.querySelector?.('[data-palette-failure]'), retry = modal.querySelector?.('[data-palette-retry]');
    session = { modal, input, list, status, recovery, failureNote, authority: getAuthority(), results: [], active: -1, query: parseQuery(''), controller: null, timer: null, catalog: null, loading: false, searchFailures: [] };
    const mine = session;
    const onInput = () => update(input.value);
    const onRetry = () => { if (session !== mine) return; if (mine.authority !== getAuthority()) { close(); return; } update(input.value); input.focus?.(); };
    const onKey = event => {
      if (!session || session !== mine) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const size = session.results.length;
        if (!size) return;
        session.active = (session.active + (event.key === 'ArrowDown' ? 1 : -1) + size) % size;
        paint();
      } else if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        if (session.active >= 0) void choose(session.active, { keep: event.shiftKey });
      }
    };
    const onClick = event => {
      const option = event.target?.closest?.('[data-palette-index]');
      if (!option || !mine.list.contains?.(option)) return;
      event.preventDefault?.();
      void choose(Number(option.getAttribute('data-palette-index')), { keep: Boolean(event.shiftKey) });
    };
    const onMove = event => { const option = event.target?.closest?.('[data-palette-index]'); if (!option) return; const index = Number(option.getAttribute('data-palette-index')); if (index !== mine.active) { mine.active = index; paint(); } };
    const cleanup = () => {
      input.removeEventListener?.('input', onInput); input.removeEventListener?.('keydown', onKey); list.removeEventListener?.('click', onClick); list.removeEventListener?.('pointermove', onMove);
      retry?.removeEventListener?.('click', onRetry);
      modal.removeEventListener?.('close', cleanup); modal.classList?.remove?.('lv-palette-dialog');
      mine.controller?.abort(); timers.clearTimeout?.(mine.timer);
      if (session === mine) session = null;
      if (returnFocus?.isConnected && !doc?.querySelector?.('dialog[open]')) returnFocus.focus?.();
    };
    input.addEventListener?.('input', onInput); input.addEventListener?.('keydown', onKey); list.addEventListener?.('click', onClick); list.addEventListener?.('pointermove', onMove);
    retry?.addEventListener?.('click', onRetry);
    modal.addEventListener?.('close', cleanup);
    input.value = initial;
    update(initial);
    input.focus?.();
    if (request) catalogOf().then(catalog => { if (session === mine) { mine.catalog = catalog; if (mine.query.mode === 'places' || !mine.query.text) update(input.value); } });
    return true;
  }

  return {
    open, close,
    keydown(event) {
      if (!event.repeat && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'k') {
        if (open()) event.preventDefault();
      }
    },
    get isOpen() { return Boolean(session); }
  };
}
