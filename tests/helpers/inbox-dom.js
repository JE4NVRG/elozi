// A small DOM for the inbox tests (P3): enough HTML parsing, serialization, selectors and focus to run
// dom-patch.js, inbox-list-ui.js and composer-ui.js against real markup, with the browser rules
// that matter here:
// - removing (or moving) a node that holds the focus sends the focus to <body>, like a browser;
// - :hover is a flag the test sets on an element (pointer over the list);
// - attributes keep their order and innerHTML serializes them back.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const decode = value => value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name) => name[0] === '#' ? String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name] ?? match);
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const kebab = name => name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());

class Text {
  constructor(document, data) { this.ownerDocument = document; this.data = data; this.parentNode = null; this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  remove() { this.parentNode?._detach(this); }
}

class Element {
  constructor(document, tagName) {
    this.ownerDocument = document; this.tagName = tagName.toUpperCase(); this.localName = tagName.toLowerCase(); this.nodeType = 1;
    this.childNodes = []; this.parentNode = null; this._attributes = new Map(); this._listeners = new Map(); this.__hover = false;
    this.style = { _values: new Map(), setProperty(name, value) { this._values.set(name, value); }, removeProperty(name) { this._values.delete(name); }, getPropertyValue(name) { return this._values.get(name) || ''; } };
    this._scrollTop = 0; this.value = ''; this.disabled = false; this.checked = false;
    if (this.localName === 'template') this.content = new Fragment(document);
  }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(Number(value) || 0, this.scrollHeight - this.clientHeight)); }
  get attributes() { return [...this._attributes].map(([name, value]) => ({ name, value })); }
  getAttribute(name) { return this._attributes.has(name) ? this._attributes.get(name) : null; }
  setAttribute(name, value) { this._attributes.set(name, String(value)); if (name === 'value') this.value = String(value); if (name === 'disabled') this.disabled = true; if (name === 'checked') this.checked = true; }
  removeAttribute(name) { this._attributes.delete(name); if (name === 'disabled') this.disabled = false; }
  hasAttribute(name) { return this._attributes.has(name); }
  toggleAttribute(name, force) { const on = force ?? !this.hasAttribute(name); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on; }
  get id() { return this.getAttribute('id') || ''; }
  get name() { return this.getAttribute('name') || ''; }
  get type() { return this.getAttribute('type') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
  set tabIndex(value) { this.setAttribute('tabindex', String(value)); }
  get classList() {
    const element = this, read = () => element.className.split(/\s+/).filter(Boolean), write = list => element.setAttribute('class', list.join(' '));
    return { contains: name => read().includes(name), add: (...names) => write([...new Set([...read(), ...names])]), remove: (...names) => write(read().filter(item => !names.includes(item))), toggle: (name, force) => { const on = force ?? !read().includes(name); write(on ? [...new Set([...read(), name])] : read().filter(item => item !== name)); return on; } };
  }
  get dataset() {
    const element = this;
    return new Proxy({}, {
      get: (_, key) => typeof key === 'string' ? element.getAttribute('data-' + kebab(key)) ?? undefined : undefined,
      set: (_, key, value) => { element.setAttribute('data-' + kebab(key), value); return true; },
      deleteProperty: (_, key) => { element.removeAttribute('data-' + kebab(key)); return true; },
      has: (_, key) => element.hasAttribute('data-' + kebab(key)),
      ownKeys: () => [...element._attributes.keys()].filter(name => name.startsWith('data-')).map(name => camel(name.slice(5))),
      getOwnPropertyDescriptor: (_, key) => element.hasAttribute('data-' + kebab(key)) ? { enumerable: true, configurable: true, value: element.getAttribute('data-' + kebab(key)) } : undefined
    });
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get nextElementSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.documentElement; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this._clear(); if (value !== '') this._append(new Text(this.ownerDocument, String(value))); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(markup) { this._clear(); for (const node of parse(this.ownerDocument, String(markup))) (this.localName === 'template' ? this.content : this)._append(node); }
  get outerHTML() { return serialize(this); }
  set outerHTML(markup) { const parent = this.parentNode; if (!parent) return; for (const node of parse(this.ownerDocument, String(markup))) parent.insertBefore(node, this); parent._detach(this); }
  insertAdjacentHTML(position, markup) {
    const nodes = parse(this.ownerDocument, String(markup));
    if (position === 'beforeend') for (const node of nodes) this._append(node);
    else if (position === 'afterbegin') for (const node of nodes.reverse()) this.insertBefore(node, this.childNodes[0] || null);
    else if (position === 'beforebegin') for (const node of nodes) this.parentNode?.insertBefore(node, this);
    else if (position === 'afterend') { const next = this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; for (const node of nodes) this.parentNode?.insertBefore(node, next); }
  }
  _clear() { for (const node of [...this.childNodes]) this._detach(node); }
  _detach(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) return;
    if (node.nodeType === 1 && (node === this.ownerDocument.activeElement || node.contains(this.ownerDocument.activeElement))) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.childNodes.splice(index, 1); node.parentNode = null;
  }
  _append(node) { node.parentNode?._detach(node); node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { for (const node of nodes) this._append(typeof node === 'string' ? new Text(this.ownerDocument, node) : node); }
  insertBefore(node, reference) {
    if (reference === null || reference === undefined) return this._append(node);
    if (node === reference) return node;
    node.parentNode?._detach(node);
    const index = this.childNodes.indexOf(reference);
    if (index < 0) throw new Error('reference is not a child');
    node.parentNode = this; this.childNodes.splice(index, 0, node); return node;
  }
  remove() { this.parentNode?._detach(this); }
  replaceWith(node) { const parent = this.parentNode; if (!parent) return; parent.insertBefore(node, this); parent._detach(this); }
  contains(node) { while (node) { if (node === this) return true; node = node.parentNode; } return false; }
  matches(selector) { return selector.split(',').some(part => matchComplex(this, part.trim())); }
  closest(selector) { let node = this; while (node?.nodeType === 1) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
  querySelectorAll(selector) { const found = []; const visit = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.focusCount = (this.ownerDocument.focusCount || 0) + 1; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  scrollIntoView() {}
  getBoundingClientRect() { const index = this.parentNode ? this.parentNode.children.indexOf(this) : 0; return { top: index * 64, height: 64, width: 320 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  addEventListener(type, listener) { const list = this._listeners.get(type) || []; list.push(listener); this._listeners.set(type, list); }
  removeEventListener(type, listener) { this._listeners.set(type, (this._listeners.get(type) || []).filter(item => item !== listener)); }
  dispatchEvent(event) { event.target ||= this; for (const listener of this._listeners.get(event.type) || []) listener.call(this, event); if (event.bubbles && this.parentNode?.dispatchEvent) this.parentNode.dispatchEvent(event); return !event.defaultPrevented; }
  click() { this.dispatchEvent(new FakeEvent('click', { bubbles: true })); }
  get offsetWidth() { return 100; }
  // Layout of the timeline tests: every child is 100 px tall in a 400 px viewport.
  get scrollHeight() { return Math.max(this.clientHeight, this.children.length * 100); }
  get clientHeight() { return this._clientHeight ?? 400; }
  set clientHeight(value) { this._clientHeight = value; }
}

class Fragment {
  constructor(document) { this.ownerDocument = document; this.childNodes = []; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  _append(node) { node.parentNode = this; this.childNodes.push(node); }
  _detach(node) { const index = this.childNodes.indexOf(node); if (index >= 0) { this.childNodes.splice(index, 1); node.parentNode = null; } }
  querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
}

export class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.bubbles = Boolean(init.bubbles); this.defaultPrevented = false; Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  const attributes = node.attributes.map(({ name, value }) => value === '' ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`).join('');
  return VOID.has(node.localName) ? `<${node.localName}${attributes}/>` : `<${node.localName}${attributes}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

function parse(document, markup) {
  const root = new Fragment(document), stack = [root];
  const pattern = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
  let match;
  while ((match = pattern.exec(markup))) {
    const parent = stack.at(-1);
    if (match[1]) { const name = match[1].toLowerCase(); for (let index = stack.length - 1; index > 0; index--) if (stack[index].localName === name) { stack.length = index; break; } continue; }
    if (match[2]) {
      const element = new Element(document, match[2]);
      for (const attribute of (match[3] || '').matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) element.setAttribute(attribute[1].toLowerCase(), decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
      if (element.localName === 'textarea' || element.localName === 'input') element.value = element.getAttribute('value') ?? '';
      parent._append(element);
      if (!VOID.has(element.localName) && !match[4]) stack.push(element.localName === 'template' ? element.content : element);
      continue;
    }
    if (match[5] || match[6]) parent._append(new Text(document, decode(match[5] || match[6])));
  }
  return [...root.childNodes];
}

// Selectors: compound parts (tag, #id, .class, [attr], [attr="v"], [attr^="v"], :hover, :not(...)) and
// the descendant combinator.
function matchCompound(element, compound) {
  if (!compound || compound === '*') return true;
  const rest = compound.replace(/:not\(([^)]*)\)/g, (_, inner) => { if (element.matches(inner)) throw 'nomatch'; return ''; });
  const tokens = rest.match(/(\[[^\]]+\]|[#.]?[\w-]+|:[\w-]+)/g) || [];
  for (const token of tokens) {
    if (token.startsWith('#')) { if (element.id !== token.slice(1)) return false; }
    else if (token.startsWith('.')) { if (!element.classList.contains(token.slice(1))) return false; }
    else if (token === ':hover') { if (!element.__hover) return false; }
    else if (token.startsWith(':')) return false;
    else if (token.startsWith('[')) {
      const attribute = /^\[([\w-]+)(?:([\^$*]?=)["']?([^"'\]]*)["']?)?\]$/.exec(token);
      if (!attribute) return false;
      const value = element.getAttribute(attribute[1]);
      if (value === null) return false;
      if (attribute[2] === '=' && value !== attribute[3]) return false;
      if (attribute[2] === '^=' && !value.startsWith(attribute[3])) return false;
    } else if (element.localName !== token.toLowerCase()) return false;
  }
  return true;
}
function matchComplex(element, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  try {
    if (!matchCompound(element, parts.at(-1))) return false;
    let node = element.parentNode;
    for (let index = parts.length - 2; index >= 0; index--) {
      while (node?.nodeType === 1 && !matchCompound(node, parts[index])) node = node.parentNode;
      if (node?.nodeType !== 1) return false;
      node = node.parentNode;
    }
    return true;
  } catch (signal) { if (signal === 'nomatch') return false; throw signal; }
}

/** A document with <html><body>…</body></html>; markup goes into the body. */
export function createDocument(markup = '') {
  const document = { activeElement: null, focusCount: 0 };
  document.documentElement = new Element(document, 'html');
  document.body = new Element(document, 'body');
  document.documentElement._append(document.body);
  document.activeElement = document.body;
  document.createElement = tag => new Element(document, tag);
  document.getElementById = id => [...document.documentElement.querySelectorAll('[id]')].find(node => node.id === id) || null;
  document.querySelector = selector => document.documentElement.querySelector(selector);
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.defaultView = { Event: FakeEvent, getComputedStyle: () => ({ getPropertyValue: () => '' }), matchMedia: () => ({ matches: false }) };
  document.body.innerHTML = markup;
  return document;
}
