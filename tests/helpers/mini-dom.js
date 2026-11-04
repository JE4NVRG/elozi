// Minimal DOM for markup-driven behaviour tests (shell-ui.test.js): parses the HTML that a module
// really produces and offers the small API its behaviour uses: getElementById, querySelector(All)
// with simple selectors (tag, .class, #id, [attr], [attr="v"], [attr~="v"], :not(...), :checked,
// descendant combinator and comma lists), closest/matches/contains, attributes, hidden, checked,
// focus/activeElement with focusin, and document-level listeners. Not a browser: no layout, no CSS.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' };
const decode = text => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]);

class Text {
  constructor(value) { this.nodeType = 3; this.value = value; this.parent = null; }
  get textContent() { return this.value; }
}

class Element {
  constructor(tag, owner) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.children = []; this.parent = null;
    this.ownerDocument = owner; this.style = { values: new Map(), setProperty(name, value) { this.values.set(name, String(value)); }, getPropertyValue(name) { return this.values.get(name) || ''; } };
    this._checked = null;
  }
  get elements() { return this.children.filter(child => child.nodeType === 1); }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) { const on = force === undefined ? !this.hasAttribute(name) : Boolean(force); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on; }
  get id() { return this.getAttribute('id') || ''; }
  get name() { return this.getAttribute('name') || ''; }
  get value() { return this.getAttribute('value') || ''; }
  set value(next) { this.setAttribute('value', next); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { this.toggleAttribute('hidden', Boolean(value)); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(value) {
    if (value && this.getAttribute('type') === 'radio') for (const other of this.ownerDocument.querySelectorAll(`input[name="${this.name}"]`)) other._checked = false;
    this._checked = Boolean(value);
  }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === this.ownerDocument.root; }
  contains(node) { for (let current = node; current; current = current.parent) if (current === this) return true; return false; }
  append(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  matches(selector) { return parseSelector(selector).some(chain => matchChain(this, chain)); }
  closest(selector) { for (let node = this; node && node.nodeType === 1; node = node.parent) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { const chains = parseSelector(selector), found = []; walk(this, node => { if (chains.some(chain => matchChain(node, chain))) found.push(node); }); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { const doc = this.ownerDocument; doc.activeElement = this; doc.dispatch('focusin', { target: this }); }
  click() { this.ownerDocument.dispatch('click', { target: this }); }
  set innerHTML(html) { for (const child of this.children) child.parent = null; this.children = []; for (const node of parseNodes(html, this.ownerDocument)) this.append(node); }
}

function walk(root, visit) { for (const child of root.elements) { visit(child); walk(child, visit); } }

// Selectors: list of chains; a chain is a list of compounds joined by descendant combinators.
function splitTop(text, separator) {
  const parts = []; let depth = 0, quote = '', current = '';
  for (const char of text) {
    if (quote) { if (char === quote) quote = ''; current += char; continue; }
    if (char === '"' || char === "'") quote = char;
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (depth === 0 && (separator === ' ' ? /\s/.test(char) : char === separator)) { if (current.trim()) parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
function parseSelector(selector) { return splitTop(selector, ',').map(chain => splitTop(chain, ' ').map(parseCompound)); }
function parseCompound(text) {
  const tests = [], pattern = /^([a-z][a-z0-9-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:(~?=)"([^"]*)")?\]|:not\(((?:[^()]|\([^()]*\))*)\)|:checked/gi;
  let index = 0, match;
  pattern.lastIndex = 0;
  const re = new RegExp(pattern.source, 'giy');
  while (index < text.length && (re.lastIndex = index, match = re.exec(text))) {
    const [all, tag, cls, id, attr, op, value, not] = match;
    if (tag) tests.push(node => node.tagName === tag.toUpperCase());
    else if (cls) tests.push(node => (node.getAttribute('class') || '').split(/\s+/).includes(cls));
    else if (id) tests.push(node => node.id === id);
    else if (attr) tests.push(node => node.hasAttribute(attr) && (!op || (op === '=' ? node.getAttribute(attr) === value : node.getAttribute(attr).split(/\s+/).includes(value))));
    else if (not !== undefined) { const inner = parseSelector(not); tests.push(node => !inner.some(chain => matchChain(node, chain))); }
    else if (all === ':checked') tests.push(node => node.checked === true);
    index += all.length;
  }
  if (index !== text.length) throw new Error(`mini-dom: seletor não suportado: ${text}`);
  return node => tests.every(check => check(node));
}
function matchChain(node, chain) {
  if (!chain.at(-1)(node)) return false;
  let ancestor = node.parent;
  for (let index = chain.length - 2; index >= 0; index--) {
    while (ancestor && ancestor.nodeType === 1 && !chain[index](ancestor)) ancestor = ancestor.parent;
    if (!ancestor || ancestor.nodeType !== 1) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function parseNodes(html, owner) {
  const fragment = new Element('#fragment', owner), stack = [fragment];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/"']+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const match of html.matchAll(token)) {
    const [, close, open, attrs, selfClose, text] = match, top = stack.at(-1);
    if (close) { while (stack.length > 1 && stack.pop().tagName !== close.toUpperCase()); continue; }
    if (open) {
      const element = new Element(open, owner);
      for (const [, name, value] of (attrs || '').matchAll(/\s+([^\s=>/"']+)(?:="([^"]*)")?/g)) element.setAttribute(name, value === undefined ? '' : decode(value));
      top.append(element);
      if (!selfClose && !VOID.has(open.toLowerCase())) stack.push(element);
      continue;
    }
    if (text) top.append(new Text(decode(text)));
  }
  const nodes = fragment.children; for (const node of nodes) node.parent = null;
  return nodes;
}

/** A document whose <body> holds `html`; listeners run in registration order like the browser's bubbling at document. */
export function createDocument(html = '') {
  const doc = { activeElement: null, listeners: {} };
  doc.root = new Element('html', doc);
  doc.head = new Element('head', doc); doc.body = new Element('body', doc);
  doc.root.append(doc.head); doc.root.append(doc.body);
  doc.body.innerHTML = html;
  doc.documentElement = doc.root;
  doc.getElementById = id => doc.root.querySelector(`#${id}`);
  doc.querySelector = selector => doc.root.querySelector(selector);
  doc.querySelectorAll = selector => doc.root.querySelectorAll(selector);
  doc.createElement = tag => new Element(tag, doc);
  doc.addEventListener = (type, listener) => { (doc.listeners[type] ||= []).push(listener); };
  doc.dispatch = (type, init = {}) => {
    const event = { type, defaultPrevented: false, isComposing: false, ...init, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of doc.listeners[type] || []) listener(event);
    return event;
  };
  return doc;
}
