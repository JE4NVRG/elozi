// DOM patch of live regions (FRONTEND-V2 §5.2.2, §7.5). Owned by P3.
//
// The inbox never recreates its list on a poll: rows are keyed (row-<tenantId>-<conversationId>)
// and patched in place, so the same nodes, their ids and the keyboard focus survive every update and
// a screen reader keeps its place. Only what changed is touched:
// - a row whose markup is the same as last time is left alone (no attribute or text write);
// - a changed row keeps its node: attributes are synchronised and its content replaced;
// - new keys are created, keys that left are removed;
// - the order follows the data unless the caller freezes it (pointer or focus on the list): then the
//   rows that stay keep their place and new keys wait in `pending` (the "↑ N novas conversas" pill).
// Moving a focused node blurs it in most browsers, so callers freeze the order while the focus is in
// the list. replaceWithMarkup stays for the context panels that are still redrawn whole.

const signatures = new WeakMap();

/** First element of `markup`, parsed with the template element of `doc` (null when empty). */
export function elementFromMarkup(doc, markup) {
  if (!doc?.createElement) return null;
  const template = doc.createElement('template');
  template.innerHTML = String(markup ?? '');
  return template.content?.firstElementChild || null;
}

/**
 * Replaces `element` with the first element of `markup` and returns the new element (null when the
 * element is detached or the markup is empty, in which case nothing changes).
 */
export function replaceWithMarkup(element, markup) {
  const doc = element?.ownerDocument;
  if (!doc || !element.isConnected) return null;
  const fresh = elementFromMarkup(doc, markup);
  if (!fresh) return null;
  element.replaceWith(fresh);
  return fresh;
}

const attributeList = node => [...(node?.attributes || [])].map(attribute => [attribute.name, attribute.value]);

/** Copies the attributes of `source` onto `target` (adds, changes, removes), except the names in `keep`. */
export function syncAttributes(target, source, { keep = [] } = {}) {
  const wanted = new Map(attributeList(source)), kept = new Set(keep);
  let changed = 0;
  for (const [name] of attributeList(target)) if (!wanted.has(name) && !kept.has(name)) { target.removeAttribute(name); changed++; }
  for (const [name, value] of wanted) if (!kept.has(name) && target.getAttribute(name) !== value) { target.setAttribute(name, value); changed++; }
  return changed;
}

/** Remembers the markup a node was built from, so the next patch with the same markup is a no-op. */
export function markRendered(node, markup) {
  if (node && typeof node === 'object') signatures.set(node, String(markup ?? ''));
  return node;
}

/**
 * Updates `node` in place to match `markup`: same node (identity, focus, listeners), new attributes
 * and content. Returns true when something was written. `keep` lists attributes owned by the live
 * node (the tabindex of a roving focus, a data-state set by an animation) that the markup does not
 * overwrite.
 */
export function patchNode(node, markup, { keep = [] } = {}) {
  const value = String(markup ?? '');
  if (!node || signatures.get(node) === value) return false;
  const fresh = elementFromMarkup(node.ownerDocument, value);
  if (!fresh || String(fresh.tagName).toLowerCase() !== String(node.tagName).toLowerCase()) return false;
  syncAttributes(node, fresh, { keep });
  if (node.innerHTML !== fresh.innerHTML) node.innerHTML = fresh.innerHTML;
  signatures.set(node, value);
  return true;
}

const keyAttribute = node => node?.getAttribute?.('data-key') || node?.id || '';
const firstChild = parent => parent.firstElementChild ?? parent.children?.[0] ?? null;

/**
 * Keyed diff of the element children of `parent`. entries: [{key, markup}] in the wanted order.
 * Options:
 * - keyOf(node): key of an existing child (default: data-key, then id);
 * - freeze: keep the order of the rows that stay and hold new keys back in `pending`;
 * - keep: attributes of existing nodes that the markup does not overwrite;
 * - create(markup): builds a new node (default: the template of the parent's document).
 * Children without a wanted key (an empty state, a loader, a row that left) are removed. Returns
 * {added:[nodes], removed:[keys], updated:[keys], moved:[keys], pending:[keys], order:[keys]}.
 */
export function patchKeyed(parent, entries, { keyOf = keyAttribute, freeze = false, keep = [], create } = {}) {
  const result = { added: [], removed: [], updated: [], moved: [], pending: [], order: [] };
  if (!parent) return result;
  const build = create || (markup => elementFromMarkup(parent.ownerDocument, markup));
  const wanted = new Map(), list = [];
  for (const entry of entries || []) {
    const key = String(entry?.key ?? '');
    if (!key || wanted.has(key)) continue;
    wanted.set(key, String(entry.markup ?? ''));
    list.push(key);
  }
  const existing = new Map(), current = [];
  for (const node of [...(parent.children || [])]) {
    const key = keyOf(node);
    if (!key || existing.has(key) || !wanted.has(key)) { if (key) result.removed.push(key); node.remove(); continue; }
    existing.set(key, node); current.push(key);
  }
  let order;
  if (freeze) {
    order = current;
    for (const key of list) if (!existing.has(key)) result.pending.push(key);
  } else order = list;
  const nodes = new Map();
  for (const key of order) {
    let node = existing.get(key);
    const markup = wanted.get(key);
    if (node) { if (patchNode(node, markup, { keep })) result.updated.push(key); }
    else {
      node = build(markup);
      if (!node) continue;
      markRendered(node, markup);
      result.added.push(node);
    }
    nodes.set(key, node);
  }
  let cursor = firstChild(parent);
  for (const key of order) {
    const node = nodes.get(key);
    if (!node) continue;
    if (node === cursor) { cursor = node.nextElementSibling ?? null; continue; }
    if (existing.has(key)) result.moved.push(key);
    parent.insertBefore(node, cursor);
  }
  result.order = order.filter(key => nodes.has(key));
  return result;
}
