// Source contracts, NOT browser geometry or a complete CSS cascade engine.
// Reach: index.html loads both screens in the screens layer; the real renderers emit
// these classes. The composer selector deliberately matches the base specificity
// (two classes) and occurs later under <600px. Browser acceptance remains required
// for competing stylesheets, runtime sizing, real keyboards and visible hit targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const clean = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const inbox = clean(read('screen-inbox.css'));
const home = clean(read('screen-home.css'));
const tokens = clean(read('tokens.css'));
const composer = '.pg-inbox__composer .pg-inbox__field';

// Balanced at-rule extraction keeps the narrow declarations tied to their actual
// media query instead of allowing a desktop-only literal to satisfy the contract.
function groups(css, header) {
  const found = [];
  for (let start = css.indexOf(header); start !== -1; start = css.indexOf(header, start + header.length)) {
    const open = css.indexOf('{', start);
    assert.notEqual(open, -1);
    let depth = 1, end = open + 1;
    for (; end < css.length && depth; end++) {
      if (css[end] === '{') depth++;
      if (css[end] === '}') depth--;
    }
    assert.equal(depth, 0, `balanced ${header}`);
    found.push({ start, body: css.slice(open + 1, end - 1) });
  }
  return found;
}

function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selector: match[1].trim(),
    declarations: Object.fromEntries(match[2].split(';').filter(part => part.includes(':')).map(part => {
      const colon = part.indexOf(':');
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
    }))
  }));
}
function rule(css, selector) {
  const match = rules(css).find(entry => entry.selector === selector);
  assert.ok(match, `missing rule: ${selector}`);
  return match.declarations;
}

const mobileHeader = '@media (max-width: 599.98px)';
const compact = groups(inbox, mobileHeader).find(group => rules(group.body).some(entry => entry.selector === composer));

test('responsive contract selectors are emitted by the served inbox/home renderers', () => {
  const index = read('index.html');
  for (const file of ['screen-inbox.css', 'screen-home.css']) assert.ok(index.includes(`/${file}`));
  assert.match(inbox, /@layer screens\s*\{/);
  assert.match(home, /@layer screens\s*\{/);
  assert.match(read('inbox-list-ui.js'), /<div class="pg-inbox__row"/);
  assert.match(read('overview-ui.js'), /<button[^>]*class="pg-home__row"/);
  assert.match(read('app.js'), /<textarea[^>]*class="pg-inbox__field"/);
});

test('phone textarea bounds have the base two-class specificity and later source order', () => {
  assert.ok(compact, 'compact bounds must be under the phone media query, using the composer selector');
  const basePosition = inbox.indexOf(`${composer} {`);
  assert.ok(basePosition >= 0 && basePosition < compact.start);
  const base = rule(inbox.slice(0, compact.start), composer);
  assert.equal(base['min-height'], '64px');
  assert.equal(base['max-height'], '180px');
  const phone = rule(compact.body, composer);
  assert.deepEqual(phone, {
    height: 'var(--target-touch)',
    'min-height': 'var(--target-touch)',
    'max-height': '96px'
  }, 'compact sizing changes bounds only, not text, focus, disabled or scrolling');
  assert.ok(!rules(compact.body).some(entry => entry.selector === '.pg-inbox__field'), 'do not size filter labels sharing the field class');
});

test('row press is token tint only; disabled and selected inbox rows do not match', () => {
  const inboxPress = '.pg-inbox__row:active:not(:disabled, [aria-disabled="true"], [aria-selected="true"])';
  const homePress = '.pg-home__row:active:not(:disabled, [aria-disabled="true"])';
  for (const [css, selector, row] of [[inbox, inboxPress, '.pg-inbox__row'], [home, homePress, '.pg-home__row']]) {
    assert.deepEqual(rule(css, selector), { background: 'var(--bg-pressed)' });
    assert.ok(css.indexOf(selector) > css.indexOf(`${row}:hover`));
    assert.ok(!('transform' in rule(css, row)), 'dense row text must not scale');
    const activeRules = rules(css).filter(entry => entry.selector.includes(`${row}:active`));
    assert.equal(activeRules.length, 1, 'no unguarded competing press rule');
  }
  assert.match(tokens, /--bg-pressed:\s*var\(--surface-3\)/);
  const selected = rule(inbox, '.pg-inbox__row[aria-selected="true"]');
  assert.equal(selected.background, 'color-mix(in srgb, var(--accent) 8%, var(--surface-1))');
  assert.equal(selected['box-shadow'], 'inset 2px 0 0 var(--accent)');
});

test('existing focus and reduced-motion paths remain separate from press tint', () => {
  assert.deepEqual(rule(inbox, '.pg-inbox__row:focus-visible'), {
    outline: '2px solid var(--focus)', 'outline-offset': '-2px'
  });
  assert.equal(rule(clean(read('base.css')), ':where(:focus-visible)').outline, '2px solid var(--focus)');
  for (const css of [inbox, home]) {
    for (const entry of rules(css).filter(entry => /\.pg-(?:inbox|home)__row:active/.test(entry.selector))) {
      assert.deepEqual(Object.keys(entry.declarations), ['background'], 'press cannot replace focus or add motion');
    }
  }
  const reduced = groups(tokens, '@media (prefers-reduced-motion: reduce)')[0];
  assert.ok(reduced);
  assert.equal(rule(reduced.body, ':root')['--scale-press'], '1');
  assert.equal(rule(tokens, ':root[data-motion="reduced"]')['--scale-press'], '1');
});

test('compact composer preserves readable text and the 44px nonshrinking send target', () => {
  assert.match(tokens, /--target-touch:\s*44px;/);
  const base = rule(inbox, composer);
  assert.equal(base['font-size'], 'var(--fs-lg)');
  assert.equal(base['line-height'], 'var(--lh-lg)');
  assert.equal(rule(inbox, '.pg-inbox__timeline .message')['font-size'], 'var(--fs-lg)');
  const narrowChat = groups(inbox, '@container inbox-chat (max-width: 600px)')[0];
  assert.ok(narrowChat);
  const send = rules(narrowChat.body).find(entry => entry.selector.split(',').some(selector => selector.trim() === '.pg-inbox__send'));
  assert.ok(send);
  for (const size of ['min-width', 'width', 'min-height', 'height']) assert.equal(send.declarations[size], 'var(--target-touch)');
  assert.equal(send.declarations.flex, 'none');
});
