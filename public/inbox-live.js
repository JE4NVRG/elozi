// Timeline of the open conversation (FRONTEND-V2 §5.2.3, §6, §7.5). Owned by P3.
//
// - Existing message nodes (and their media players) stay in place while new events arrive: the
//   timeline reconciles by message id and only re-renders a message whose content changed (a new
//   delivery receipt only rewrites its meta line).
// - Window of 60 messages: the latest 60 are rendered; "Carregar anteriores" opens 60 more from
//   memory (P9 will bring ?before=) and keeps the reader's anchor. Once open, the window is anchored
//   to its first message, so messages that arrive never push content above the reader.
// - Inline receipts of the agent (extras(): [{id, at, markup}] from agentRail.timelineItems, P4) are
//   interleaved by time; this module never draws run state itself.
// - #messages is role="log" with aria-live="polite", announced only for received messages: an
//   update that adds none of them is made with aria-live="off".
// - Never scrolls by itself while the person reads the history: the "N novas ↓" pill counts what
//   arrived below. Arrival animates opacity + translateY(--shift-sm) (CSS, data-enter).
import { h, t } from './i18n.js';
import './locales-inbox.js';

export const TIMELINE_WINDOW = 60;
const NEAR_BOTTOM = 90;
const ENTER_MS = 400;

const idOf = (message, index) => String(message?.id || `position-${index}`);
const signature = (message, previous) => { const { delivery, ...content } = message; return JSON.stringify([content, previous?.createdAt?.slice(0, 10) ?? null]); };
const nearBottomOf = element => element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM;
const keyOf = node => node?.dataset?.messageId || '';

/** "Carregar anteriores" (first child of the timeline while older messages stay hidden). */
export function earlierMarkup(hidden) {
  return String(h`<div class="pg-inbox__earlier" data-message-id="__earlier"><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-action="inbox:earlier"><span class="ui-btn__label">${hidden === 1 ? t('Carregar 1 mensagem anterior') : t('Carregar anteriores ({count})', { count: hidden })}</span></button></div>`);
}

/** Wrapper of an inline agent receipt (its markup comes from the agent rail, P4). */
export function receiptMarkup(item) {
  return `<div class="pg-inbox__entry pg-inbox__entry--receipt" data-message-id="receipt:${String(item.id).replace(/[&<>"']/g, '')}">${String(item.markup ?? '')}</div>`;
}

/**
 * createInboxTimeline({renderMessage, extras, windowSize, pill, timers}) →
 * {slice, markup, bind, update, showEarlier, reset, unseen}.
 * renderMessage(message, previous, index) is the markup of one message (app.js conversationMessage).
 */
export function createInboxTimeline({ renderMessage, extras = () => [], windowSize = TIMELINE_WINDOW, pill = () => null, timers = globalThis } = {}) {
  let container = null, snapshots = new Map(), context = null, startId = null, unseen = 0, liveTimer = null;
  const scrolled = new WeakSet(), pins = new WeakMap();

  function start(messages) {
    if (!messages.length) return 0;
    if (startId !== null) {
      // Anchored to its first message, but never fewer than the window: a reorder or a late message
      // with an older time does not hide what fits in 60.
      const index = messages.findIndex((message, position) => idOf(message, position) === startId);
      if (index >= 0) return Math.min(index, Math.max(0, messages.length - windowSize));
    }
    const index = Math.max(0, messages.length - windowSize);
    startId = messages.length ? idOf(messages[index], index) : null;
    return index;
  }

  /**
   * The visible part of `messages` for the conversation `key` (a new key opens at the latest 60):
   * {start, hidden, items:[{message, previous, index}]} — first paint and reconciliation share it.
   */
  function slice(messages = [], key = context) {
    if (key !== context) { context = key; startId = null; unseen = 0; }
    const first = start(messages);
    return { start: first, hidden: first, items: messages.slice(first).map((message, offset) => ({ message, previous: offset ? messages[first + offset - 1] : null, index: first + offset })) };
  }

  function receipts(firstAt) {
    let list = [];
    try { list = Array.isArray(extras()) ? extras() : []; } catch { list = []; }
    return list.filter(item => item && item.id && item.markup && Number.isFinite(Date.parse(item.at)) && (!firstAt || Date.parse(item.at) >= Date.parse(firstAt)))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  // Ordered entries of the window: [earlier?] + messages and receipts merged by time.
  function entries(messages) {
    const view = slice(messages), list = [];
    if (view.hidden) list.push({ key: '__earlier', value: `earlier:${view.hidden}`, markup: () => earlierMarkup(view.hidden), kind: 'control' });
    const extra = receipts(view.items[0]?.message?.createdAt);
    let next = 0;
    for (const { message, previous, index } of view.items) {
      const at = Date.parse(message.createdAt);
      while (next < extra.length && Number.isFinite(at) && Date.parse(extra[next].at) <= at) { const item = extra[next++]; list.push({ key: `receipt:${item.id}`, value: `receipt:${item.markup}`, markup: () => receiptMarkup(item), kind: 'receipt' }); }
      list.push({ key: idOf(message, index), value: signature(message, previous), markup: () => renderMessage(message, previous, index), kind: message.kind, message });
    }
    while (next < extra.length) { const item = extra[next++]; list.push({ key: `receipt:${item.id}`, value: `receipt:${item.markup}`, markup: () => receiptMarkup(item), kind: 'receipt' }); }
    return list;
  }

  function watch(element) {
    if (!element?.addEventListener || scrolled.has(element)) return;
    scrolled.add(element);
    element.addEventListener('scroll', () => { if (unseen && nearBottomOf(element)) { unseen = 0; paintPill(); } }, { passive: true });
  }

  function paintPill() {
    const node = pill?.();
    if (!node) return;
    const label = node.querySelector?.('[data-unseen-label]');
    if (unseen > 0) {
      const text = unseen === 1 ? t('1 nova') : t('{count} novas', { count: unseen });
      if (label && label.textContent !== text) label.textContent = text;
      if (node.hidden) { node.hidden = false; node.setAttribute?.('data-enter', ''); timers.setTimeout?.(() => node.removeAttribute?.('data-enter'), ENTER_MS); }
    } else if (!node.hidden) node.hidden = true;
  }

  /** Markup of the window for the first paint (same entries the later updates reconcile). */
  function markup(messages = [], key = context) {
    slice(messages, key);
    return entries(messages).map(entry => entry.markup()).join('');
  }

  function bind(element, messages = []) {
    container = element;
    snapshots = new Map(entries(messages).map(entry => [entry.key, entry.value]));
    watch(element);
  }

  /**
   * A conversation opens at its newest message and stays there while it settles: photos and videos take their size when
   * decoded, the web font swaps in, attachments and the agent rail arrive after the first paint, and the composer or the
   * phone keyboard shrink the timeline. Until the person scrolls up, each of these keeps the end in view (a ResizeObserver
   * on the timeline and on every entry, media load events and DOM changes); scrolling back to the end follows again. A
   * re-bound element keeps the person's choice. Entries are laid out in full (screen-inbox.css has no content-visibility
   * on them): placeholder heights moved the end until each entry came into view, and a conversation opened at the top.
   */
  function pin(element) {
    if (!element) return;
    let state = pins.get(element);
    if (!state) {
      state = { pinned: true };
      pins.set(element, state);
      const follow = () => { if (state.pinned && element.isConnected !== false) element.scrollTop = element.scrollHeight; };
      const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null;
      sizes?.observe(element);
      for (const child of element.children || []) sizes?.observe(child);
      element.addEventListener?.('scroll', () => { state.pinned = nearBottomOf(element); }, { passive: true });
      // load (photos) and loadedmetadata (videos) do not bubble; the capturing listener of the timeline still gets them.
      for (const type of ['load', 'loadedmetadata']) element.addEventListener?.(type, follow, true);
      if (typeof MutationObserver === 'function') new MutationObserver(records => {
        for (const record of records) {
          if (record.target !== element) continue;
          for (const node of record.removedNodes) if (node.nodeType === 1) sizes?.unobserve(node);
          for (const node of record.addedNodes) if (node.nodeType === 1) sizes?.observe(node);
        }
        follow();
      }).observe(element, { childList: true, subtree: true });
    }
    if (state.pinned) element.scrollTop = element.scrollHeight;
  }

  function create(markup) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    return template.content.firstElementChild;
  }

  function quiet(element) {
    if (!element?.setAttribute) return;
    element.setAttribute('aria-live', 'off');
    timers.clearTimeout?.(liveTimer);
    liveTimer = timers.setTimeout?.(() => element.setAttribute('aria-live', 'polite'), 100);
  }

  /**
   * Reconciles the window with `messages`; returns {added, nearBottom, incoming}. Entries that land
   * below the last one already on screen are arrivals (animated, counted in the "N novas" pill);
   * arrival:false (older messages opened above) never animates nor counts.
   */
  function update(element, messages = [], { arrival = true } = {}) {
    if (!element) return { added: 0, nearBottom: false };
    if (container !== element) bind(element, []);
    // A timeline pinned to its end is still there while a photo or the composer changes its size.
    const nearBottom = nearBottomOf(element) || pins.get(element)?.pinned === true;
    const oldScroll = element.scrollTop;
    const existing = new Map([...element.children].filter(node => keyOf(node)).map(node => [keyOf(node), node]));
    const wanted = entries(messages), next = new Map(), arrivals = [];
    const lastSeen = wanted.reduce((last, entry, position) => existing.has(entry.key) ? position : last, -1);
    const appended = wanted.filter((entry, position) => position > lastSeen && !existing.has(entry.key) && entry.kind !== 'control');
    if (appended.length && !appended.some(entry => entry.kind === 'customer') || !arrival) quiet(element);
    let added = 0, incoming = 0;
    wanted.forEach((entry, position) => {
      let node = existing.get(entry.key);
      const label = node && entry.kind === 'control' && snapshots.get(entry.key) !== entry.value ? node.querySelector?.('.ui-btn__label') : null;
      if (label) {
        // "Carregar anteriores" keeps its node (and the focus of whoever activated it): only the count changes.
        const text = create(entry.markup())?.querySelector?.('.ui-btn__label')?.textContent ?? '';
        if (label.textContent !== text) label.textContent = text;
      } else if (!node || snapshots.get(entry.key) !== entry.value) {
        const replacement = create(entry.markup());
        if (node) node.replaceWith(replacement);
        else if (entry.kind !== 'control') {
          added++;
          if (entry.kind === 'customer') incoming++;
          if (arrival && lastSeen >= 0 && position > lastSeen) arrivals.push(replacement);
        }
        node = replacement;
      } else if (entry.kind === 'human') {
        const markup = create(entry.markup());
        const currentMeta = node.querySelector('.message-meta'), nextMeta = markup?.querySelector?.('.message-meta');
        if (currentMeta && nextMeta && currentMeta.textContent !== nextMeta.textContent) currentMeta.textContent = nextMeta.textContent;
      }
      const current = element.children[position];
      if (current !== node) element.insertBefore(node, current || null);
      existing.delete(entry.key); next.set(entry.key, entry.value);
    });
    for (const node of existing.values()) node.remove();
    snapshots = next;
    for (const node of arrivals) { node.setAttribute?.('data-enter', ''); timers.setTimeout?.(() => node.removeAttribute?.('data-enter'), ENTER_MS); }
    element.scrollTop = nearBottom ? element.scrollHeight : oldScroll;
    if (arrival && arrivals.length && !nearBottom) unseen += arrivals.length;
    if (nearBottom) unseen = 0;
    paintPill();
    return { added, nearBottom, incoming };
  }

  /** Opens 60 older messages above, keeping the reader's anchor (the scroll position never jumps). */
  function showEarlier(element, messages = []) {
    if (!element || !messages.length) return 0;
    const first = start(messages);
    if (!first) return 0;
    const target = Math.max(0, first - windowSize);
    const height = element.scrollHeight, top = element.scrollTop;
    startId = idOf(messages[target], target);
    update(element, messages, { arrival: false });
    element.scrollTop = top + (element.scrollHeight - height);
    return first - target;
  }

  function reset() { container = null; snapshots.clear(); context = null; startId = null; unseen = 0; paintPill(); }
  return { slice, markup, bind, pin, update, showEarlier, reset, get unseen() { return unseen; }, clearUnseen() { unseen = 0; paintPill(); } };
}
