// CSS ratchet (FRONTEND-V2 §3.1, §8.1 and §8.2 commit 1a). One baseline per stylesheet in
// tests/css-baseline/<file>.json, owned by the package that owns the CSS. A counter may only go
// down; a stylesheet without a baseline (new CSS) must have zero of everything.
// After lowering counters, record the new floor with:
//   CSS_RATCHET_UPDATE=1 node --test tests/css-ratchet.test.js
// The update only lowers existing baselines; it never raises a counter nor creates a baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { METRICS, cssMetrics } from './helpers/css-metrics.js';

const publicDirectory = new URL('../public/', import.meta.url);
const baselineDirectory = new URL('./css-baseline/', import.meta.url);
const stylesheets = readdirSync(publicDirectory).filter(file => file.endsWith('.css')).sort();
const baselines = new Map(readdirSync(baselineDirectory).filter(file => file.endsWith('.css.json')).map(file => [file.slice(0, -'.json'.length), JSON.parse(readFileSync(new URL(file, baselineDirectory), 'utf8'))]));
const update = process.env.CSS_RATCHET_UPDATE === '1';

test('nenhum contador da catraca de CSS sobe e CSS novo nasce sem violações', () => {
  const increases = [];
  for (const file of stylesheets) {
    const current = cssMetrics(readFileSync(new URL(file, publicDirectory), 'utf8'), { tokens: file === 'tokens.css' });
    const baseline = baselines.get(file);
    for (const [metric, label] of Object.entries(METRICS)) {
      const allowed = baseline ? baseline[metric] : 0;
      assert.equal(Number.isInteger(allowed), true, `tests/css-baseline/${file}.json precisa registrar ${metric}`);
      if (current[metric] > allowed) increases.push(`${file}: ${label} subiu de ${allowed} para ${current[metric]}`);
    }
    if (update && baseline) {
      const lowered = Object.fromEntries(Object.keys(METRICS).map(metric => [metric, Math.min(baseline[metric], current[metric])]));
      writeFileSync(new URL(`${file}.json`, baselineDirectory), JSON.stringify(lowered, null, 2) + '\n');
    }
  }
  assert.deepEqual(increases, [], 'A catraca só desce: corrija o CSS (tokens, breakpoints 600/900/1280/1600, sem !important nem .app-shell[data-view]).');
});

test('toda baseline pertence a um CSS existente e registra todos os contadores', () => {
  for (const [file, baseline] of baselines) {
    assert.ok(stylesheets.includes(file), `baseline órfã: remova tests/css-baseline/${file}.json junto com public/${file}`);
    assert.deepEqual(Object.keys(baseline).sort(), Object.keys(METRICS).sort(), `tests/css-baseline/${file}.json com contadores inesperados`);
  }
});

test('os contadores reconhecem as violações proibidas em CSS novo', () => {
  const css = `/* #ffffff em comentário não conta */
.app-shell[data-view="inbox"] .x{color:#fff;font-size:11px;margin:0!important}
.y{font:600 10px/1.2 sans-serif;background:var(--surface-1);font-size:var(--text-sm)}
@media (max-width: 760px){.z{color:#12345678}}
@media (min-width: 900px){.w{font-size:.875rem}}
@media (max-width: 599.98px){.v{border-color:#abc}}`;
  assert.deepEqual(cssMetrics(css), { fontSizeBelow12px: 2, fontSizeLiteral: 3, hexOutsideTokens: 3, breakpointOutsideSet: 1, appShellDataView: 1, important: 1 });
  assert.equal(cssMetrics(':root{--bg:#f4f7fb;--accent:#3157d5}', { tokens: true }).hexOutsideTokens, 0);
});
