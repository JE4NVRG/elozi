// Cascade layers and design tokens (FRONTEND-V2 §3.1–§3.7, §8.2 commit 1b).
// - tokens.css is the first <link> and declares the layer order; base.css is the reset layer.
// - The legacy sheets still in use are wrapped mechanically in @layer legacy (P10 removed the 15 that their
//   packages had emptied); new sheets only use the new layers.
// - tokens.css holds the light and dark tokens of the spec (P10 unlocked dark: data-theme="dark" or the
//   system preference without data-theme="light") and the legacy aliases, now pointing at the v2 tokens.
// - The two global reduced-motion !important rules no longer reach ui-/sh-/pg- elements, and the
//   remaining legacy !important rules are an audited, closed inventory scoped to legacy classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PANEL_ASSETS } from '../src/panel-assets.js';
import { cssRules, parseCss, stripCssComments } from './helpers/css-tree.js';

const publicDirectory = new URL('../public/', import.meta.url);
const read = file => readFileSync(new URL(file, publicDirectory), 'utf8');
const LAYER_ORDER = ['reset', 'legacy', 'tokens', 'components', 'shell', 'screens', 'utilities'];
const NEW_SHEET_LAYERS = new Set(['components', 'shell', 'screens', 'utilities']);
// The 25 stylesheets of index.html before P1, in cascade order. A retiring package empties its file
// to a single comment (§8.1); P10 removes the link, the allowlist entry and the file.
const LEGACY_SHEETS = ['styles.css', 'automation.css', 'frontend.css', 'integrations.css', 'mcp.css', 'knowledge.css',
  'agent-memory.css', 'media.css', 'replies.css', 'chat-layout.css', 'attendance.css', 'team-chat.css', 'overview.css',
  'customer-context-ui.css', 'guide.css', 'accounts.css', 'workspace-shell.css', 'workspace-polish.css',
  'service-principals.css', 'commercial-usage.css', 'groups-workspace.css', 'group-history-import.css', 'locale.css',
  'product-review.css', 'platform-users.css'];
// Emptied by P1 (locale), P3 (inbox sheets), P7 (overview, group history import) and P8 (settings sheets);
// removed by P10 together with their link, allowlist entry and ratchet baseline.
const RETIRED_IN_P10 = ['integrations.css', 'media.css', 'replies.css', 'chat-layout.css', 'attendance.css', 'overview.css',
  'customer-context-ui.css', 'guide.css', 'accounts.css', 'commercial-usage.css', 'groups-workspace.css',
  'group-history-import.css', 'locale.css', 'product-review.css', 'platform-users.css'];
const NEW_ELEMENTS = '[class^="ui-"],[class*=" ui-"],[class^="sh-"],[class*=" sh-"],[class^="pg-"],[class*=" pg-"]';
const NOT_NEW = `*:not(:where(${NEW_ELEMENTS}))`;

const indexLinks = () => [...read('index.html').matchAll(/<link\b[^>]*>/g)].map(match => ({
  rel: match[0].match(/\srel="([^"]+)"/)?.[1], href: match[0].match(/\shref="\/([^"]+)"/)?.[1]
}));
const stylesheets = () => indexLinks().filter(link => link.rel === 'stylesheet').map(link => link.href);
const retired = css => parseCss(css).length === 0;
// Legacy sheets still linked and not emptied by their retiring package.
const liveLegacySheets = () => LEGACY_SHEETS.filter(sheet => stylesheets().includes(sheet) && !retired(read(sheet)));
const normalize = value => value.trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\s*\/\s*/g, '/').toLowerCase();

function layerBlocks(file) {
  return parseCss(read(file)).map(item => {
    assert.ok(item.children && /^@layer [a-z-]+$/.test(item.prelude), `${file}: tudo precisa ficar dentro de um bloco @layer (encontrado: ${item.prelude.slice(0, 80)})`);
    return { layer: item.prelude.slice('@layer '.length), children: item.children };
  });
}

function tokenScopes() {
  const items = parseCss(read('tokens.css'));
  const scopes = new Map();
  for (const rule of cssRules(items.slice(1))) {
    const key = [...rule.context.filter(context => context !== '@layer tokens'), rule.selector].join(' ');
    const scope = scopes.get(key) || {};
    for (const { property, value } of rule.declarations) scope[property] = value;
    scopes.set(key, scope);
  }
  return scopes;
}

// Resolves var() chains inside one theme so the test compares the colors the spec measured.
function resolve(scope, name, seen = new Set()) {
  assert.ok(!seen.has(name), `ciclo de var() em ${name}`);
  const value = scope[name];
  assert.notEqual(value, undefined, `token ausente: ${name}`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, reference) => resolve(scope, reference, new Set([...seen, name])));
}

const table = text => text.trim().split('\n').map(line => line.trim().split(/\s+/));
const NEUTRALS = table(`
  --bg #f4f7fb #0b0e14
  --surface-1 #ffffff #14171e
  --surface-2 #f1f4f8 #1b1f27
  --surface-3 #e6eaf0 #242931
  --border #dfe3ea #292e36
  --border-strong #c6cbd3 #3d434c
  --border-control #818690 #6f757f
  --text-1 #141b26 #e8ebf1
  --text-2 #474d59 #c0c4cc
  --text-3 #636975 #999fa9
  --text-disabled #9a9fa6 #595e66
  --accent #3157d5 #3961e0
  --on-accent #ffffff #ffffff
  --accent-hover #2547c4 #3157d5
  --accent-pressed #1a36b3 #2a4ecb
  --accent-text #3157d5 #a0bcff
  --accent-soft #e7efff #172757
  --accent-soft-border #bdd1ff #2a4287
  --accent-soft-text #2546bc #bdd1ff
  --focus #446eee #84a8fe
  --bg-hover #f1f4f8 #1b1f27
  --bg-pressed #e6eaf0 #242931
  --bg-selected #e7efff #172757`);
const SEMANTICS = table(`
  success #0d7737 #e4fbe7 #b1e3ba #1c8742 #83d395 #102b17 #244d2e #1c8742
  warning #895706 #fff1e2 #f3cda1 #9c6306 #ebb16b #322008 #583c17 #9c6306
  danger #a43b38 #ffefee #ffc3bd #b54a46 #fea199 #381a18 #62322f #b54a46
  info #006d91 #e6f6ff #b0dcf2 #1e7ca1 #82c8ea #102732 #244758 #1e7ca1
  agent #764aa2 #f6f0ff #e0c8fe #8559b2 #cfaafb #2a1d37 #4b3860 #8559b2`);
const AGENT_ALT = { light: ['#0b726e', '#dafcf9', '#97e5df', '#0b837e'], dark: ['#49d6cf', '#012b29', '#064d4a', '#0b837e'] };
const RAMP = '#f3f7ff #e5edfe #cbdbff #a5c0fe #779dfc #4e7bfc #3961e0 #2a4cc2 #1e3aa1 #11277a #061456'.split(' ');
const FIXED = {
  '--font-sans': '"Manrope","Segoe UI",system-ui,sans-serif', '--font-mono': 'ui-monospace,"Cascadia Code",Consolas,monospace',
  '--fs-xs': '12px', '--lh-xs': '16px', '--fs-sm': '13px', '--lh-sm': '18px', '--fs-md': '14px', '--lh-md': '20px',
  '--fs-msg': '15px', '--lh-msg': '22px', '--fs-lg': '16px', '--lh-lg': '24px', '--fs-xl': '18px', '--lh-xl': '26px',
  '--fs-2xl': '22px', '--lh-2xl': '28px', '--ls-2xl': '-.01em', '--fs-3xl': '28px', '--lh-3xl': '34px', '--ls-3xl': '-.02em',
  '--fs-mono': '13px', '--lh-mono': '20px',
  '--space-0_5': '2px', '--space-1': '4px', '--space-2': '8px', '--space-3': '12px', '--space-4': '16px', '--space-5': '20px',
  '--space-6': '24px', '--space-8': '32px', '--space-10': '40px', '--space-12': '48px', '--space-16': '64px',
  '--radius-xs': '4px', '--radius-sm': '6px', '--radius-md': '8px', '--radius-lg': '12px', '--radius-xl': '16px',
  '--radius-full': '999px', '--radius-agent': '30%',
  '--z-sticky': '10', '--z-sidebar': '20', '--z-topbar': '30', '--z-popover': '40', '--z-drawer': '50', '--z-toast': '70',
  '--z-tooltip': '80', '--z-skip': '90',
  '--control-sm': '32px', '--control-md': '36px', '--control-lg': '44px', '--row-height': '64px', '--row-height-compact': '48px',
  '--sidebar-width': '232px', '--sidebar-rail': '64px', '--bottombar-height': '56px',
  '--inbox-list-width': '340px', '--inbox-list-min': '280px', '--inbox-list-max': '480px',
  '--inbox-context-width': '340px', '--inbox-context-min': '300px', '--inbox-context-max': '440px'
};
const SHADOWS = {
  light: ['0 1px 2px rgb(16 24 40/.06)', '0 4px 12px rgb(16 24 40/.08),0 1px 3px rgb(16 24 40/.06)', '0 12px 32px rgb(16 24 40/.14)', '0 24px 64px rgb(16 24 40/.22)'],
  dark: ['none', '0 8px 24px rgb(0 0 0/.45),inset 0 0 0 1px rgb(255 255 255/.06)', '0 16px 40px rgb(0 0 0/.55),inset 0 0 0 1px rgb(255 255 255/.06)', '0 24px 64px rgb(0 0 0/.6),inset 0 0 0 1px rgb(255 255 255/.06)']
};
const MOTION = {
  '--dur-instant': '80ms', '--dur-fast': '140ms', '--dur-base': '200ms', '--dur-slow': '280ms', '--dur-count': '600ms',
  '--ease-standard': 'cubic-bezier(.2,0,0,1)', '--ease-enter': 'cubic-bezier(0,0,.2,1)', '--ease-exit': 'cubic-bezier(.4,0,1,1)',
  '--shift-xs': '4px', '--shift-sm': '8px', '--shift-md': '12px', '--shift-lg': '24px', '--scale-press': '.98', '--scale-enter': '.98'
};
const REDUCED_MOTION = {
  '--dur-instant': '0ms', '--dur-fast': '120ms', '--dur-base': '120ms', '--dur-slow': '120ms', '--dur-count': '0ms',
  '--shift-xs': '0px', '--shift-sm': '0px', '--shift-md': '0px', '--shift-lg': '0px', '--scale-press': '1', '--scale-enter': '1'
};
// Legacy aliases: frozen by P1 with the values that were effective in the legacy cascade; P10 points them at
// the v2 tokens, so the legacy screens follow the dark theme too.
const LEGACY_ALIASES = {
  '--canvas': 'var(--bg)', '--ink': 'var(--text-1)', '--muted': 'var(--text-3)', '--line': 'var(--border)', '--navy': 'var(--text-1)',
  '--mint': 'var(--success-border)', '--radius': '14px', '--white': 'var(--surface-1)', '--teal': 'var(--info-text)',
  '--surface-shadow': 'var(--shadow-1)', '--accent': 'var(--b-accent-l)'
};

test('index.html carrega tokens.css e base.css antes de qualquer outra folha e mantém a ordem legada', () => {
  const links = indexLinks();
  assert.deepEqual(links.slice(0, 2), [{ rel: 'stylesheet', href: 'tokens.css' }, { rel: 'stylesheet', href: 'base.css' }]);
  const sheets = stylesheets();
  assert.deepEqual(sheets.filter(sheet => LEGACY_SHEETS.includes(sheet)), LEGACY_SHEETS.filter(sheet => sheets.includes(sheet)), 'a ordem relativa das folhas legadas não muda');
  for (const sheet of sheets) assert.ok(PANEL_ASSETS.includes(sheet), `${sheet} precisa estar em src/panel-assets.js`);
  // P10 unlocked the dark theme: the page declares both schemes and one theme-color per scheme (theme-prefs.js
  // points both at the person's choice when it is not "Sistema").
  const index = read('index.html');
  assert.match(index, /<meta name="color-scheme" content="light dark">/, 'tema escuro liberado no P10');
  assert.match(index, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)" data-theme-value="light">/);
  assert.match(index, /<meta name="theme-color" content="#14171e" media="\(prefers-color-scheme: dark\)" data-theme-value="dark">/);
});

test('as 15 folhas esvaziadas por P1, P3, P7 e P8 saíram no P10: sem arquivo, link, allowlist ou baseline', () => {
  for (const sheet of RETIRED_IN_P10) {
    assert.ok(LEGACY_SHEETS.includes(sheet), sheet);
    assert.equal(existsSync(new URL(sheet, publicDirectory)), false, `public/${sheet} removido`);
    assert.ok(!stylesheets().includes(sheet), `${sheet} fora do index.html`);
    assert.ok(!PANEL_ASSETS.includes(sheet), `${sheet} fora de src/panel-assets.js`);
    assert.equal(existsSync(new URL(`./css-baseline/${sheet}.json`, import.meta.url)), false, `baseline de ${sheet} removida`);
  }
  for (const sheet of LEGACY_SHEETS.filter(sheet => !RETIRED_IN_P10.includes(sheet))) assert.ok(stylesheets().includes(sheet), `${sheet} continua ligado`);
});

test('tokens.css abre com a ordem das camadas e o resto fica na camada tokens', () => {
  const [order, ...rest] = parseCss(read('tokens.css'));
  assert.equal(order.statement, true);
  assert.equal(order.prelude, `@layer ${LAYER_ORDER.join(', ')}`);
  assert.ok(rest.length > 0 && rest.every(item => item.prelude === '@layer tokens' && item.children), 'tokens.css só declara a camada tokens');
});

test('tema escuro (P10): "Sistema" segue prefers-color-scheme sem data-theme="light" e "Escuro" usa data-theme="dark", com os mesmos valores', () => {
  const scopes = tokenScopes(), media = '@media (prefers-color-scheme: dark)';
  const explicit = scopes.get(':root[data-theme="dark"]'), system = scopes.get(`${media} :root:not([data-theme="light"])`);
  assert.ok(explicit && system, 'os dois blocos escuros existem');
  assert.deepEqual(system, explicit, 'mesmos tokens no escuro do sistema e no escolhido');
  assert.deepEqual(scopes.get(`${media} :root:not([data-theme="light"])[data-agent-hue="alt"]`), scopes.get(':root[data-theme="dark"][data-agent-hue="alt"]'));
  assert.equal(explicit['color-scheme'], 'dark');
  assert.equal(scopes.get(':root')['color-scheme'], 'light');
  // The only media query on color scheme is the dark one, so "Claro" (data-theme="light") always wins over the system.
  assert.deepEqual([...stripCssComments(read('tokens.css')).matchAll(/prefers-color-scheme:\s*(\w+)/g)].map(match => match[1]), ['dark']);
});

test('as folhas do painel ficam inteiras em camadas: legado mecânico, reset no base.css e novas nas camadas novas', () => {
  for (const sheet of stylesheets().slice(1)) {
    const css = read(sheet);
    if (LEGACY_SHEETS.includes(sheet)) {
      if (retired(css)) continue;
      const layers = layerBlocks(sheet).map(block => block.layer);
      // A package that rewrites a legacy sheet in place may move it whole into the new layers.
      if (layers.every(layer => NEW_SHEET_LAYERS.has(layer))) continue;
      assert.ok(css.startsWith('@layer legacy {\n') && css.endsWith('\n}\n'), `${sheet}: envolvimento mecânico em @layer legacy { … }`);
      assert.deepEqual(layers, ['legacy'], `${sheet}: um único bloco @layer legacy`);
    } else if (sheet === 'base.css') {
      assert.deepEqual(layerBlocks(sheet).map(block => block.layer), ['reset']);
    } else {
      for (const { layer } of layerBlocks(sheet)) assert.ok(NEW_SHEET_LAYERS.has(layer), `${sheet}: CSS novo usa components, shell, screens ou utilities (não ${layer})`);
    }
  }
  assert.equal(LEGACY_SHEETS.length, 25);
});

test('tokens.css define os tokens claros e escuros da especificação (§3.2–§3.7)', () => {
  const scopes = tokenScopes();
  const light = scopes.get(':root');
  const dark = { ...light, ...scopes.get(':root[data-theme="dark"]') };
  for (const [name, lightValue, darkValue] of NEUTRALS) {
    assert.equal(resolve(light, name), lightValue, `${name} (claro)`);
    assert.equal(resolve(dark, name), darkValue, `${name} (escuro)`);
  }
  for (const [role, ...values] of SEMANTICS) ['text', 'bg', 'border', 'solid'].forEach((part, index) => {
    assert.equal(resolve(light, `--${role}-${part}`), values[index], `--${role}-${part} (claro)`);
    assert.equal(resolve(dark, `--${role}-${part}`), values[index + 4], `--${role}-${part} (escuro)`);
  });
  const altLight = { ...light, ...scopes.get(':root[data-agent-hue="alt"]') };
  const altDark = { ...dark, ...scopes.get(':root[data-agent-hue="alt"]'), ...scopes.get(':root[data-theme="dark"][data-agent-hue="alt"]') };
  ['text', 'bg', 'border', 'solid'].forEach((part, index) => {
    assert.equal(resolve(altLight, `--agent-${part}`), AGENT_ALT.light[index]);
    assert.equal(resolve(altDark, `--agent-${part}`), AGENT_ALT.dark[index]);
  });
  assert.equal(resolve(light, '--note-bg'), resolve(light, '--warning-bg'));
  assert.equal(resolve(light, '--note-border'), resolve(light, '--warning-border'));
  assert.equal(normalize(light['--scrim']), 'rgb(11 18 32/.48)');
  assert.equal(normalize(dark['--scrim']), 'rgb(0 0 0/.6)');
  RAMP.forEach((value, index) => assert.equal(light[`--brand-${[50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950][index]}`], value));
  for (const [name, value] of Object.entries({ ...FIXED, ...MOTION })) assert.equal(normalize(light[name]), normalize(value), name);
  SHADOWS.light.forEach((value, index) => assert.equal(normalize(light[`--shadow-${index + 1}`]), normalize(value)));
  SHADOWS.dark.forEach((value, index) => assert.equal(normalize(dark[`--shadow-${index + 1}`]), normalize(value)));
  assert.equal(light['--gutter'], '16px');
  assert.equal(scopes.get('@media (min-width: 600px) :root')['--gutter'], '24px');
  assert.equal(scopes.get('@media (min-width: 1280px) :root')['--gutter'], '32px');
  for (const key of ['@media (prefers-reduced-motion: reduce) :root', ':root[data-motion="reduced"]']) assert.deepEqual(scopes.get(key), REDUCED_MOTION, key);
  for (const name of Object.keys(scopes.get(':root[data-theme="dark"]'))) assert.ok(name === 'color-scheme' || name in light, `${name} existe só no escuro`);
});

test('aliases legados apontam para os tokens v2 nos dois temas e nenhum :root legado concorre', () => {
  const scopes = tokenScopes(), light = scopes.get(':root'), dark = { ...light, ...scopes.get(':root[data-theme="dark"]') };
  for (const [name, value] of Object.entries(LEGACY_ALIASES)) assert.equal(light[name], value, `${name} ligado ao token v2`);
  assert.equal(resolve(light, '--accent'), '#3157d5');
  for (const [alias, token] of [['--canvas', '--bg'], ['--ink', '--text-1'], ['--muted', '--text-3'], ['--line', '--border'], ['--white', '--surface-1']]) {
    assert.equal(resolve(light, alias), resolve(light, token), `${alias} claro`);
    assert.equal(resolve(dark, alias), resolve(dark, token), `${alias} escuro`);
  }
  const tokenNames = new Set(Object.keys(light));
  for (const sheet of liveLegacySheets()) for (const rule of cssRules(parseCss(read(sheet)))) {
    if (!rule.selector.split(',').some(selector => /^(?::root|html|body)$/.test(selector.trim()))) continue;
    for (const { property } of rule.declarations) assert.ok(!tokenNames.has(property), `${sheet}: ${rule.selector} redefine ${property}, que agora vive em tokens.css`);
  }
  // Legacy markup reads --surface only with a fallback (frontend.css, contact-import-ui.js); defining it would recolor it.
  assert.ok(!tokenNames.has('--surface'));
});

test('as regras globais de movimento reduzido do legado não alcançam elementos ui-, sh- e pg-', () => {
  const rules = liveLegacySheets().flatMap(sheet => cssRules(parseCss(read(sheet))).map(rule => ({ sheet, ...rule })));
  for (const rule of rules) for (const selector of rule.selector.split(/,(?![^(]*\))/)) {
    if (!/^\*|\s\*/.test(selector.trim()) || !rule.declarations.some(declaration => declaration.important)) continue;
    assert.ok(selector.includes(NOT_NEW), `${rule.sheet}: ${selector} com !important precisa excluir ${NEW_ELEMENTS}`);
  }
  const motion = rules.filter(rule => rule.sheet === 'styles.css' && rule.declarations.some(declaration => declaration.property === 'scroll-behavior' && declaration.important));
  assert.deepEqual(motion.map(rule => rule.context.filter(context => !context.startsWith('@layer')).join(' ')), ['@media(prefers-reduced-motion:reduce)', '']);
  assert.ok(motion[1].selector.startsWith(':root[data-motion="reduced"],'));
  for (const rule of motion) assert.deepEqual(rule.declarations.map(({ property, value, important }) => `${property}:${value}${important ? '!' : ''}`).sort(), ['animation:none!', 'scroll-behavior:auto!', 'transition:none!']);
});

// Audit of the remaining legacy !important (FRONTEND-V2 §3.1). Inside @layer legacy an important
// declaration beats every later layer, so each one must stay scoped to legacy classes. The list may
// only shrink; a new !important in legacy CSS fails here (and in the CSS ratchet).
const IMPORTANT_AUDIT = {
  'styles.css': {
    '[hidden]': 'global de propósito: o atributo hidden esconde inclusive elementos novos',
    '.code-editor': 'tipografia monoespaçada do editor de código legado',
    '.permission-grid label': 'margem do label genérico dentro da grade de permissões'
  },
  'frontend.css': { '.file-dragover': 'realce temporário de arrastar arquivo sobre o compositor legado' },
  'mcp.css': { '.mcp-grant': 'linha de concessão sobre o label genérico', '.mcp-grant input': 'checkbox da concessão' },
  'knowledge.css': {
    '.knowledge-content-heading>label': 'margem do label genérico',
    '.knowledge-grant': 'linha de concessão sobre o label genérico',
    '.knowledge-grant input': 'checkbox da concessão',
    '.knowledge-run-references>p,.knowledge-run-no-match': 'nota de referências da execução'
  },
  'agent-memory.css': { '.memory-review': 'linha de revisão sobre o label genérico' },
  'service-principals.css': { '.service-journey-kicker': 'tamanho do sobretítulo' }
};

test('os !important legados restantes formam um inventário auditado e restrito a classes legadas', () => {
  for (const sheet of liveLegacySheets()) for (const rule of cssRules(parseCss(read(sheet)))) {
    if (!rule.declarations.some(declaration => declaration.important)) continue;
    if (rule.selector.includes(NOT_NEW)) continue;
    assert.ok(IMPORTANT_AUDIT[sheet]?.[rule.selector], `${sheet}: !important fora do inventário auditado em ${rule.selector}`);
  }
  for (const selectors of Object.values(IMPORTANT_AUDIT)) for (const selector of Object.keys(selectors)) {
    assert.doesNotMatch(selector, /(?:^|[\s,>+~])\*|\.(?:ui|sh|pg)-/, `${selector} não pode alcançar elementos novos`);
    assert.ok(selector === '[hidden]' || /\.[a-z]/.test(selector), `${selector} precisa ficar restrito a uma classe legada`);
  }
});

test('botões primários legados usam var(--on-accent) sobre a cor de destaque', () => {
  const primary = {
    'styles.css': ['.button.primary']
  };
  for (const [sheet, selectors] of Object.entries(primary)) {
    if (!liveLegacySheets().includes(sheet)) continue;
    const rules = cssRules(parseCss(read(sheet)));
    for (const selector of selectors) {
      const colors = rules.filter(rule => rule.selector.replace(/,\s+/g, ',') === selector).flatMap(rule => rule.declarations.filter(declaration => declaration.property === 'color'));
      assert.deepEqual(colors.map(declaration => declaration.value), ['var(--on-accent)'], `${sheet}: ${selector}`);
    }
  }
  for (const sheet of liveLegacySheets()) for (const rule of cssRules(parseCss(read(sheet)))) {
    const background = rule.declarations.find(declaration => /^background(?:-color)?$/.test(declaration.property))?.value || '';
    const color = rule.declarations.find(declaration => declaration.property === 'color')?.value;
    if (color && /primary/.test(rule.selector) && /var\(--(?:guide-)?accent\s*[,)]/.test(background)) assert.equal(color, 'var(--on-accent)', `${sheet}: ${rule.selector}`);
  }
});

test('base.css cobre o reset da especificação sem regras que vençam o legado', () => {
  const [{ children }] = layerBlocks('base.css');
  const selectors = cssRules(children).map(rule => rule.selector);
  for (const expected of [':where(:focus-visible)', '.sr-only', '[hidden]:not([hidden="until-found"])', 'kbd', 'body']) assert.ok(selectors.includes(expected), expected);
  const focus = cssRules(children).find(rule => rule.selector === ':where(:focus-visible)');
  assert.deepEqual(focus.declarations.map(({ property, value }) => `${property}:${value}`), ['outline:2px solid var(--focus)', 'outline-offset:2px']);
  assert.ok(selectors.some(selector => selector.startsWith('*,') && selector.includes(`:where(${NEW_ELEMENTS.replace(/,/g, ', ')})::before`)), 'border-box nos elementos e só nos pseudo-elementos novos');
});
