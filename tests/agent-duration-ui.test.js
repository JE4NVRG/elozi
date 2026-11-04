import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latencyOf } from '../public/agent-detail-ui.js';

const source = readFileSync(new URL('../public/agent-rail-ui.js', import.meta.url), 'utf8');
const definition = source.match(/  function adminMeta\(run\) \{([\s\S]*?)\n  \}/);
assert.ok(definition, 'execute the actual rail function body, not a reimplementation');
const time = value => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : null; };
const adminMeta = Function('isAdmin', 'time', 'stateOf', 'i18nText', 'getLocale', 'formatDuration', 'return function adminMeta(run) {' + definition[1] + '\n}')(
  () => true, time, run => run.state || run.status, text => text, () => 'en', ms => `duration:${ms}`);
const start = '2026-10-24T12:00:00.000Z';
const run = (extra = {}) => ({ state: 'invalidated', startedAt: start, updatedAt: '2026-10-29T12:00:00.000Z', ...extra });

test('legacy late invalidation does not invent duration from updatedAt in either real UI function', () => {
  assert.equal(latencyOf(run()), null);
  assert.equal(adminMeta(run()), '');
});

test('recorded completion survives later edits consistently in detail and rail', () => {
  const value = run({ completedAt: '2026-10-24T12:00:02.500Z' });
  assert.equal(latencyOf(value), 2500);
  assert.equal(adminMeta(value), 'duration:2500');
});

test('active or waiting approval state does not present a final duration even with an old numeric field', () => {
  for (const state of ['queued', 'running', 'tool_running', 'waiting_approval']) {
    const value = run({ state, latencyMs: 9000, completedAt: '2026-10-24T12:00:09Z' });
    assert.equal(latencyOf(value), null); assert.equal(adminMeta(value), '');
  }
});

test('terminal numeric duration is respected; malformed or reversed completion stays unknown', () => {
  assert.equal(latencyOf(run({ latencyMs: 180 })), 180);
  assert.equal(adminMeta(run({ latencyMs: 180 })), 'duration:180');
  for (const completedAt of [null, '', 'invalid', '2026-10-23T00:00:00Z']) {
    assert.equal(latencyOf(run({ completedAt })), null);
    assert.equal(adminMeta(run({ completedAt })), '');
  }
});
