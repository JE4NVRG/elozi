import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCss } from './helpers/css-tree.js';

test('modern stacked agent register resets legacy table width inside screens without changing legacy tables', () => {
  const css = readFileSync(new URL('../public/screen-agents.css', import.meta.url), 'utf8');
  const legacy = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(legacy, /table\{min-width:540px\}/);
  assert.match(legacy, /^@layer legacy\s*\{/);
  assert.ok(parseCss(css).every(rule => rule.prelude === '@layer screens'), 'no global unlayered escape from the cascade contract');
  const boundary = css.indexOf('/* Legacy table compatibility');
  assert.ok(boundary > 0, 'explicit local compatibility boundary');
  const reset = css.slice(boundary);
  assert.match(reset, /@media\s*\(max-width:\s*599\.98px\)/);
  assert.match(reset, /\.pg-agents--list \.pg-agents__table--agents\s*\{\s*min-width:\s*0;\s*max-width:\s*100%/);
  assert.match(reset, /white-space:\s*normal;\s*overflow-wrap:\s*anywhere/);
  assert.match(reset, /\.pg-agents--list \.pg-agents__table--agents tbody th\s*\{\s*font-size:\s*var\(--fs-sm\)/);
  assert.doesNotMatch(reset, /!important|table\s*\{\s*min-width/);
  // A selector contract is not browser acceptance: source-bound captures additionally
  // measure the table wrapper scrollWidth/clientWidth and every visible row's geometry.
});
