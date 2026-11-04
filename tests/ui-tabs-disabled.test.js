import test from 'node:test';
import assert from 'node:assert/strict';
import { tabs, tabPanel, installUI } from '../public/ui.js';

const items = () => [
  { id: 'A', label: 'A', disabled: true },
  { id: 'B', label: 'B', panel: 'custom-panel-b', action: 'choose-b', count: 2 },
  { id: 'C', label: 'C', action: 'choose-c' }
];
function render(options = {}) {
  const markup = String(tabs({ id: 'example', label: 'Example', items: items(), ...options }));
  const nodes = [...markup.matchAll(/<(button|a)\b([^>]*)>/g)].map(([, tag, attributes]) => ({
    tag,
    attrs: Object.fromEntries([...attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']))
  }));
  return { markup, nodes, byId: id => nodes.find(node => node.attrs['data-tab'] === id)?.attrs };
}
function assertSelection(result, selected) {
  assert.deepEqual(result.nodes.filter(node => node.attrs.tabindex === '0').map(node => node.attrs['data-tab']), selected ? [selected] : []);
  assert.deepEqual(result.nodes.filter(node => node.attrs['aria-selected'] === 'true').map(node => node.attrs['data-tab']), selected ? [selected] : []);
  for (const node of result.nodes) {
    if (node.attrs['data-tab'] !== selected) {
      assert.equal(node.attrs.tabindex, '-1');
      assert.equal(node.attrs['aria-selected'], 'false');
    }
  }
}

test('tabs normalize missing, invalid and disabled active to first enabled B', () => {
  for (const active of [undefined, 'missing', 'A']) {
    const result = render({ active });
    assertSelection(result, 'B');
    assert.equal(result.byId('A')['aria-disabled'], 'true');
    assert.equal(result.byId('A').disabled, '');
    assert.equal(result.byId('B')['aria-controls'], 'custom-panel-b');
    assert.equal(result.byId('C')['aria-controls'], 'example-panel-C');
    assert.equal(result.byId('B')['data-action'], 'choose-b');
    assert.match(result.markup, /role="tablist"[^>]*aria-label="Example"/);
    assert.match(result.markup, /ui-tabs__count">2<\/span>/);
  }
});
test('valid enabled active and panel associations preserve the consumer contract', () => {
  const result = render({ active: 'C' });
  assertSelection(result, 'C');
  assert.equal(result.byId('C').id, 'example-tab-C');
  assert.equal(result.byId('C')['data-action'], 'choose-c');
  const panel = String(tabPanel({ tabsId: 'example', id: 'C', active: true, content: 'Content' }));
  assert.match(panel, /id="example-panel-C" aria-labelledby="example-tab-C"/);
  assert.doesNotMatch(panel, / hidden/);
});
test('all-disabled and empty tablists have no selected tab or sequential tabstop', () => {
  for (const active of [undefined, 'A', 'missing']) {
    const result = render({ active, items: items().map(item => ({ ...item, disabled: true, href: item.id === 'A' ? '/a' : undefined })) });
    assertSelection(result, null);
    assert.ok(result.nodes.every(node => node.attrs['aria-disabled'] === 'true'));
    assert.doesNotMatch(result.markup, /aria-current| href=/);
  }
  assertSelection(render({ items: [] }), null);
});
test('disabled anchor announces unavailability without an address, action or current-page claim', () => {
  const result = render({ active: 'A', items: items().map(item => ({ ...item, href: `/${item.id.toLowerCase()}`, action: `choose-${item.id}` })) });
  assertSelection(result, 'B');
  assert.equal(result.nodes[0].tag, 'a');
  assert.equal(result.byId('A')['aria-disabled'], 'true');
  for (const name of ['href', 'data-action', 'aria-current', 'disabled']) assert.equal(name in result.byId('A'), false, name);
  assert.equal(result.byId('B').href, '/b');
  assert.equal(result.byId('B')['aria-current'], undefined, 'focus fallback must not claim a route is current');
  const valid = render({ active: 'C', items: items().map(item => ({ ...item, href: `/${item.id.toLowerCase()}` })) });
  assert.equal(valid.byId('C')['aria-current'], 'page');
  assert.equal(valid.byId('C').href, '/c');
});

// Small attribute-selector fixture: exercises the real installed listeners, with no DOM dependency.
function fixture(options = {}) {
  const result = render(options), listeners = [], focused = [], activated = [];
  const matches = (node, selector) => selector.split(',').some(part => {
    const negative = [...part.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
    if (negative.some(condition => matches(node, condition))) return false;
    const positive = part.replace(/:not\([^)]+\)/g, '');
    return [...positive.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => name in node.attrs && (value === undefined || node.attrs[name] === value));
  });
  const list = { querySelectorAll: selector => result.nodes.filter(node => matches(node, selector)) };
  for (const node of result.nodes) {
    node.matches = selector => matches(node, selector);
    node.closest = selector => selector === '.ui-tabs' ? list : selector === '.ui-tabs [role="tab"]' ? node : null;
    node.focus = () => focused.push(node.attrs['data-tab']);
  }
  const doc = { addEventListener: (type, handler, capture = false) => listeners.push({ type, handler, capture }) };
  assert.equal(installUI(doc), true);
  assert.equal(installUI(doc), false);
  function dispatch(id, type, key) {
    const target = result.nodes.find(node => node.attrs['data-tab'] === id);
    const event = { target, type, key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const capture of [true, false]) {
      for (const listener of listeners.filter(listener => listener.type === type && listener.capture === capture)) {
        listener.handler(event);
        if (event.stopped) return event;
      }
    }
    if (type === 'click' || type === 'keydown' && ['Enter', ' '].includes(key)) activated.push(id);
    return event;
  }
  return { ...result, focused, activated, dispatch };
}
test('manual arrows wrap over enabled tabs, skip disabled anchors, and preserve selection', () => {
  const env = fixture({ active: 'A', items: items().map(item => ({ ...item, href: `/${item.id}` })) });
  for (const [id, key] of [['B', 'ArrowRight'], ['C', 'ArrowRight'], ['B', 'ArrowLeft'], ['B', 'End'], ['C', 'Home']]) {
    assert.equal(env.dispatch(id, 'keydown', key).prevented, true);
  }
  assert.deepEqual(env.focused, ['C', 'B', 'C', 'C', 'B']);
  assertSelection(env, 'B');
  assert.deepEqual(env.activated, []);
  for (const key of ['Enter', ' ']) {
    const event = env.dispatch('C', 'keydown', key);
    assert.equal(event.prevented, false);
    assert.equal(event.stopped, false);
  }
  assert.equal(env.dispatch('C', 'click').prevented, false);
  assert.deepEqual(env.activated, ['C', 'C', 'C']);
});
test('disabled anchors block click and Enter/Space before delegated consumers', () => {
  const env = fixture({ active: 'A', items: items().map(item => ({ ...item, href: `/${item.id}` })) });
  for (const [type, key] of [['click'], ['keydown', 'Enter'], ['keydown', ' ']]) {
    const event = env.dispatch('A', type, key);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  assert.deepEqual(env.activated, []);
  assert.deepEqual(env.focused, []);
});
test('all-disabled arrow keys cannot focus an unavailable tab', () => {
  const env = fixture({ items: items().map(item => ({ ...item, disabled: true, href: `/${item.id}` })) });
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) env.dispatch('A', 'keydown', key);
  assert.deepEqual(env.focused, []);
  assertSelection(env, null);
});
