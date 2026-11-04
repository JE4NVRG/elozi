import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/login.js', import.meta.url), 'utf8');
const start = source.indexOf('function readLoginLocale()');
const end = source.indexOf("import './locales-auth.js';");
const setup = start >= 0 && end > start ? source.slice(start, end) : '';
function enter(href, previous = 'pt-BR') {
  assert.ok(setup, 'the actual login startup must contain the explicit locale handoff');
  const calls = [];
  const window = { location: { href }, history: { replaceState() { throw Error('locale initialization must not navigate'); } } };
  vm.runInNewContext(setup, { URL, window, getLocale: () => previous, setLocale: (value, options) => calls.push({ value, ...options }) }, { timeout: 1000 });
  assert.equal(window.location.href, href);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('login without an explicit locale retains the existing preference without persisting', () => {
  assert.deepEqual(enter('https://elozi.je4ndev.com/login?cadastro=1', 'en'), { value: 'en', persist: false, notify: false });
});
test('English sales entry selects and persists English before auth rendering', () => {
  assert.deepEqual(enter('https://elozi.je4ndev.com/login?cadastro=1&lang=en'), { value: 'en', persist: true, notify: false });
});
test('Portuguese entry can restore Portuguese from an English preference', () => {
  assert.deepEqual(enter('https://elozi.je4ndev.com/login?lang=pt-BR', 'en'), { value: 'pt-BR', persist: true, notify: false });
});
test('unsupported or malformed locale input never overrides a saved preference', () => {
  for (const href of ['https://elozi.je4ndev.com/login?lang=es', 'https://elozi.je4ndev.com/login?lang=%3Cscript%3E', 'not a valid URL']) {
    assert.deepEqual(enter(href, 'en'), { value: 'en', persist: false, notify: false });
  }
});
test('locale handoff preserves re-authentication, invitation and return routing parameters', () => {
  const href = 'https://elozi.je4ndev.com/login?return=close&next=%2F%23inbox&lang=en#inbox';
  assert.deepEqual(enter(href), { value: 'en', persist: true, notify: false });
});
