// Brand tokens derived from one accent color (FRONTEND-V2 §3.3, §8.2 commit 1c). brand-theme.js is a
// pure module: these tests pin the values measured in the spec, keep the CSS defaults of tokens.css
// equal to the JS derivation, and require AA for 500 deterministic pseudo-random brands plus the
// listed extremes in both themes (text ≥ 4.5, focus ≥ 3, solid ≥ 3 against surface-1 or outline on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_BRAND, INK, WHITE, SURFACES, RAMP_STEPS, BRAND_TOKEN_NAMES, applyBrandTokens, brandTokenEntries,
  contrast, deriveBrandTokens, hexToOklch, normalizeHex, oklchToHex
} from '../public/brand-theme.js';
import { cssRules, parseCss } from './helpers/css-tree.js';

const tokensCss = readFileSync(new URL('../public/tokens.css', import.meta.url), 'utf8');
function rootDeclarations(selector) {
  const values = {};
  for (const rule of cssRules(parseCss(tokensCss).slice(1))) {
    if (rule.selector === selector && rule.context.every(context => context === '@layer tokens')) for (const { property, value } of rule.declarations) values[property] = value;
  }
  return values;
}

// §3.3 "Valores para a marca padrão #3157d5".
const DEFAULT_LIGHT = { accent: '#3157d5', onAccent: '#ffffff', accentHover: '#2547c4', accentPressed: '#1a36b3', accentText: '#3157d5', accentSoft: '#e7efff', accentSoftBorder: '#bdd1ff', accentSoftText: '#2546bc', focus: '#446eee', edge: 'transparent' };
const DEFAULT_DARK = { accent: '#3961e0', onAccent: '#ffffff', accentHover: '#3157d5', accentPressed: '#2a4ecb', accentText: '#a0bcff', accentSoft: '#172757', accentSoftBorder: '#2a4287', accentSoftText: '#bdd1ff', focus: '#84a8fe', edge: 'transparent' };
const DEFAULT_RAMP = ['#f3f7ff', '#e5edfe', '#cbdbff', '#a5c0fe', '#779dfc', '#4e7bfc', '#3961e0', '#2a4cc2', '#1e3aa1', '#11277a', '#061456'];
const EXTREMES = ['#000000', '#ffffff', '#ffff00', '#00ffff', '#777777', '#f2a900', '#58c8aa', '#e11d48', '#3157d5'];

function randomBrands(count, seed = 0x5eed1c) {
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  return Array.from({ length: count }, () => '#' + (next() >>> 8).toString(16).padStart(6, '0'));
}

function accessibilityFailures(hex) {
  const tokens = deriveBrandTokens(hex), failures = [];
  for (const theme of ['light', 'dark']) {
    const set = tokens[theme], surfaces = SURFACES[theme], check = (name, ok) => { if (!ok) failures.push(`${hex} ${theme} ${name}`); };
    for (const fill of ['accent', 'accentHover', 'accentPressed']) check(`${fill}/on-accent ≥ 4.5`, contrast(set[fill], set.onAccent) >= 4.5);
    check('hover ≠ sólido', set.accentHover !== set.accent && set.accentPressed !== set.accent);
    for (const surface of ['bg', 's1', 's2', 's3']) check(`accent-text/${surface} ≥ 4.5`, contrast(set.accentText, surfaces[surface]) >= 4.5);
    check('soft-text/soft ≥ 4.5', contrast(set.accentSoftText, set.accentSoft) >= 4.5);
    check('focus ≥ 3 (s1 e bg)', contrast(set.focus, surfaces.s1) >= 3 && contrast(set.focus, surfaces.bg) >= 3);
    const solidVisible = contrast(set.accent, surfaces.s1) >= 3;
    check('sólido ≥ 3 ou contorno', solidVisible ? set.edge === 'transparent' : set.edge !== 'transparent' && contrast(set.edge, surfaces.s1) >= 3);
  }
  return failures;
}

test('a marca padrão reproduz os valores medidos no §3.3 (claro, escuro e rampa)', () => {
  const tokens = deriveBrandTokens(DEFAULT_BRAND);
  assert.deepEqual({ ...tokens.light }, DEFAULT_LIGHT);
  assert.deepEqual({ ...tokens.dark }, DEFAULT_DARK);
  assert.deepEqual(RAMP_STEPS.map(step => tokens.ramp[step]), DEFAULT_RAMP);
  const base = hexToOklch(DEFAULT_BRAND);
  assert.equal(base.l.toFixed(3), '0.509'); assert.equal(base.c.toFixed(3), '0.198'); assert.equal(base.h.toFixed(1), '266.4');
  assert.equal(contrast(DEFAULT_LIGHT.accent, WHITE).toFixed(2), '6.08');
  assert.equal(contrast(DEFAULT_DARK.accent, SURFACES.dark.s1).toFixed(2), '3.38');
  assert.deepEqual({ ...tokens.report }, { input: DEFAULT_BRAND, fallback: false, whiteContrast: 6.08, inkContrast: Math.round(contrast(DEFAULT_BRAND, INK) * 100) / 100, onAccent: 'white', adjusted: false, edge: false, agentHue: 'default' });
});

test('os padrões de tokens.css são exatamente a derivação da marca padrão, e as superfícies batem', () => {
  const light = rootDeclarations(':root'), dark = rootDeclarations(':root[data-theme="dark"]');
  for (const [name, value] of brandTokenEntries(deriveBrandTokens(DEFAULT_BRAND))) assert.equal(light[name], value, `${name} em tokens.css`);
  const neutral = { bg: '--bg', s1: '--surface-1', s2: '--surface-2', s3: '--surface-3' };
  for (const [key, name] of Object.entries(neutral)) {
    assert.equal(SURFACES.light[key], light[name], `${name} claro`);
    assert.equal(SURFACES.dark[key], dark[name], `${name} escuro`);
  }
  for (const name of Object.values(BRAND_TOKEN_NAMES)) {
    assert.ok(light[`--b-${name}-l`] && light[`--b-${name}-d`], `--b-${name}-l/-d declarados`);
  }
});

test('casos-limite medidos no §3.3 mantêm a identidade e escolhem o texto certo', () => {
  const cases = [
    ['#f2a900', '#f2a900', INK, '9.32', '#b07b0b', INK, '5.07'],
    ['#58c8aa', '#58c8aa', INK, '9.14', '#1f9c80', INK, '5.46'],
    ['#e11d48', '#e11d48', WHITE, '4.70', '#e11d48', WHITE, '4.70'],
    ['#777777', '#747474', WHITE, '4.67']
  ];
  for (const [brand, light, onLight, ratioLight, dark, onDark, ratioDark] of cases) {
    const tokens = deriveBrandTokens(brand);
    assert.equal(tokens.light.accent, light, `${brand} sólido claro`);
    assert.equal(tokens.light.onAccent, onLight, `${brand} on claro`);
    assert.equal(contrast(tokens.light.accent, tokens.light.onAccent).toFixed(2), ratioLight, `${brand} contraste claro`);
    if (dark) {
      assert.equal(tokens.dark.accent, dark, `${brand} sólido escuro`);
      assert.equal(tokens.dark.onAccent, onDark, `${brand} on escuro`);
      assert.equal(contrast(tokens.dark.accent, tokens.dark.onAccent).toFixed(2), ratioDark, `${brand} contraste escuro`);
    }
  }
  assert.equal(deriveBrandTokens('#777777').report.adjusted, true, 'cinza médio: tom do botão ajustado');
  const white = deriveBrandTokens('#ffffff');
  assert.equal(white.light.accent, '#ffffff'); assert.equal(white.light.onAccent, INK);
  assert.equal(white.light.edge, white.light.accentText, 'marca branca ganha contorno interno em accent-text');
  assert.equal(white.report.edge, true); assert.equal(white.report.onAccent, 'ink');
  assert.equal(deriveBrandTokens('#f2a900').report.onAccent, 'ink', 'amarelo mantém a identidade com texto escuro');
});

test('AA para 500 marcas pseudoaleatórias determinísticas e os extremos, nos dois temas', () => {
  const brands = [...EXTREMES, ...randomBrands(500)];
  assert.equal(new Set(brands).size > 500, true, 'amostra sem colapsar em poucas cores');
  const failures = brands.flatMap(accessibilityFailures);
  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} falhas de contraste`);
});

test('a amostra cobre os dois caminhos de texto e o contorno, então o teste de AA exercita cada regra', () => {
  const sample = [...EXTREMES, ...randomBrands(500)].map(hex => deriveBrandTokens(hex));
  assert.ok(sample.some(tokens => tokens.light.onAccent === WHITE) && sample.some(tokens => tokens.light.onAccent === INK));
  assert.ok(sample.some(tokens => tokens.dark.onAccent === WHITE) && sample.some(tokens => tokens.dark.onAccent === INK));
  assert.ok(sample.some(tokens => tokens.light.edge !== 'transparent'), 'algum sólido claro demais ativa o contorno');
  assert.ok(sample.some(tokens => tokens.report.adjusted), 'algum sólido precisou escurecer até o branco passar');
  assert.ok(sample.some(tokens => tokens.agentHue === 'alt') && sample.some(tokens => tokens.agentHue === 'default'));
});

test('entrada inválida usa a marca padrão; hex curto ou sem # é normalizado', () => {
  for (const value of [undefined, null, '', 'blue', '#12345', '#ggg000', 'javascript:alert(1)', 42, {}]) {
    const tokens = deriveBrandTokens(value);
    assert.equal(tokens.input, DEFAULT_BRAND); assert.equal(tokens.report.fallback, true); assert.equal(tokens.light.accent, DEFAULT_LIGHT.accent);
  }
  assert.equal(normalizeHex('#ABC'), '#aabbcc'); assert.equal(normalizeHex('3157D5'), '#3157d5'); assert.equal(normalizeHex(' #3157d5 '), '#3157d5');
  assert.equal(deriveBrandTokens('3157D5'), deriveBrandTokens('#3157d5'), 'memoizado pela forma normalizada');
  assert.equal(deriveBrandTokens('#3157d5').report.fallback, false);
  assert.ok(Object.isFrozen(deriveBrandTokens('#3157d5').light), 'tokens congelados');
});

test('cor de agente vira teal só quando o matiz da marca fica a menos de 35° do violeta', () => {
  assert.equal(deriveBrandTokens('#8a2be2').agentHue, 'alt');
  assert.equal(deriveBrandTokens('#7c3aed').agentHue, 'alt');
  assert.equal(deriveBrandTokens('#3157d5').agentHue, 'default', '266,4° fica a 38,6° do violeta');
  assert.equal(deriveBrandTokens('#58c8aa').agentHue, 'default');
  for (const gray of ['#000000', '#777777', '#ffffff']) assert.equal(deriveBrandTokens(gray).agentHue, 'default', `${gray} não tem matiz`);
});

test('gama sRGB: OKLCH fora da gama reduz o croma e preserva luminosidade', () => {
  const vivid = oklchToHex(.7, .4, 140), fitted = hexToOklch(vivid);
  assert.match(vivid, /^#[0-9a-f]{6}$/);
  assert.ok(Math.abs(fitted.l - .7) < .01, 'L preservado'); assert.ok(fitted.c < .4, 'croma reduzido');
  assert.equal(oklchToHex(1, 0, 0), '#ffffff'); assert.equal(oklchToHex(0, 0, 0), '#000000');
  for (const hex of ['#3157d5', '#e11d48', '#58c8aa']) { const { l, c, h } = hexToOklch(hex); assert.equal(oklchToHex(l, c, h), hex, `ida e volta de ${hex}`); }
});

test('applyBrandTokens escreve --b-*-l/-d e a rampa via setProperty, controla data-agent-hue e ignora repetições', () => {
  const writes = [], attributes = new Map();
  const root = { style: { setProperty: (name, value) => writes.push([name, value]) }, setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  const violet = deriveBrandTokens('#8a2be2');
  assert.equal(applyBrandTokens(root, violet), true);
  assert.equal(writes.length, Object.keys(BRAND_TOKEN_NAMES).length * 2 + RAMP_STEPS.length);
  assert.deepEqual(writes, brandTokenEntries(violet));
  assert.ok(writes.every(([name, value]) => /^--(?:b-[a-z-]+-[ld]|brand-\d+)$/.test(name) && (/^#[0-9a-f]{6}$/.test(value) || value === 'transparent')));
  assert.equal(attributes.get('data-agent-hue'), 'alt');
  assert.equal(applyBrandTokens(root, violet), false, 'o mesmo conjunto não reescreve o estilo a cada render()');
  assert.equal(writes.length, 31);
  applyBrandTokens(root, deriveBrandTokens('#3157d5'));
  assert.equal(attributes.has('data-agent-hue'), false);
  assert.equal(writes.length, 62);
  assert.equal(applyBrandTokens(null, violet), false); assert.equal(applyBrandTokens(root, {}), false);
  assert.doesNotThrow(() => applyBrandTokens({ style: { setProperty() {} } }, deriveBrandTokens('#123456')), 'raiz sem atributos (fixtures) continua funcionando');
});
