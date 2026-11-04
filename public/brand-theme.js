// Brand tokens derived from one accent color (FRONTEND-V2 §3.3). Pure module: no DOM access at
// import time and no dependencies, so it runs in Node tests and in the panel alike.
//
// deriveBrandTokens(hex) → { input, ramp, light, dark, agentHue, report }
// applyBrandTokens(root, tokens) writes --b-<name>-l / --b-<name>-d and --brand-50…950 on root.style
// (CSSOM setProperty works under CSP); tokens.css resolves each theme without JS on theme change.
//
// Color math: sRGB ⇄ OKLab/OKLCH (Björn Ottosson's matrices) and WCAG 2.x contrast on the 8-bit
// sRGB value that is actually painted. Gamut fitting keeps L and H and reduces C ×0.95 per step.

export const DEFAULT_BRAND = '#3157d5';
export const INK = '#0b1220';
export const WHITE = '#ffffff';
/** Neutral surfaces of tokens.css (§3.2); tests/brand-theme.test.js keeps them in sync. */
export const SURFACES = Object.freeze({
  light: Object.freeze({ bg: '#f4f7fb', s1: '#ffffff', s2: '#f1f4f8', s3: '#e6eaf0' }),
  dark: Object.freeze({ bg: '#0b0e14', s1: '#14171e', s2: '#1b1f27', s3: '#242931' })
});
export const RAMP_STEPS = Object.freeze([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]);
const RAMP_L = [.975, .945, .89, .81, .71, .62, .54, .47, .40, .32, .24];
const RAMP_C = [.22, .32, .52, .78, .95, 1, 1, .95, .85, .72, .60];
/** Agent violet (~305°) and the minimum circular hue distance before switching agents to teal. */
export const AGENT_HUE = 305;
const AGENT_HUE_DISTANCE = 35;
// Below this chroma a color has no perceivable hue (grays, white, black): never conflicts with agent.
const ACHROMATIC = .03;
const MAX_CHROMA = .25;
const TEXT = 4.5, NON_TEXT = 3;
/** Token names written by applyBrandTokens, in the order of tokens.css. */
export const BRAND_TOKEN_NAMES = Object.freeze({
  accent: 'accent', onAccent: 'on-accent', accentHover: 'accent-hover', accentPressed: 'accent-pressed',
  accentText: 'accent-text', accentSoft: 'accent-soft', accentSoftBorder: 'accent-soft-border',
  accentSoftText: 'accent-soft-text', focus: 'focus', edge: 'edge'
});

/** '#abc', 'abc', '#AABBCC' → '#aabbcc'; anything else → null. */
export function normalizeHex(value) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join('') : match[1];
  return '#' + digits.toLowerCase();
}

const channels = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
const toLinear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const fromLinear = value => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055;
const toHex = rgb => '#' + rgb.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('');

/** WCAG 2.x relative luminance of a #rrggbb color. */
export function luminance(hex) {
  const [r, g, b] = channels(hex).map(toLinear);
  return .2126 * r + .7152 * g + .0722 * b;
}

/** WCAG 2.x contrast ratio between two #rrggbb colors (1–21). */
export function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

/** #rrggbb → { l, c, h } in OKLCH (h in degrees, 0 for achromatic colors). */
export function hexToOklch(hex) {
  const [r, g, b] = channels(hex).map(toLinear);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  const L = .2104542553 * l + .7936177850 * m - .0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s;
  const B = .0259040371 * l + .7827717662 * m - .8086757660 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-7 ? 0 : (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToLinear(L, C, H) {
  const angle = H * Math.PI / 180, A = C * Math.cos(angle), B = C * Math.sin(angle);
  const l = (L + .3963377774 * A + .2158037573 * B) ** 3;
  const m = (L - .1055613458 * A - .0638541728 * B) ** 3;
  const s = (L - .0894841775 * A - 1.2914855480 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.7076147010 * s
  ];
}

// A 1e-3 tolerance (well under one 8-bit step after clamping) reproduces the values measured in §3.3.
const inGamut = rgb => rgb.every(value => value >= -1e-3 && value <= 1 + 1e-3);

/** OKLCH → #rrggbb, fitting into sRGB by reducing chroma ×0.95 per iteration (L and H kept). */
export function oklchToHex(L, C, H) {
  const lightness = Math.min(1, Math.max(0, L));
  let chroma = Math.max(0, C), linear = oklchToLinear(lightness, chroma, H);
  for (let step = 0; !inGamut(linear) && step < 400; step++) {
    chroma = chroma < 1e-5 ? 0 : chroma * .95;
    linear = oklchToLinear(lightness, chroma, H);
  }
  return toHex(linear.map(value => fromLinear(Math.min(1, Math.max(0, value)))));
}

// Lightness steps of .01 without floating drift.
const step = (value, delta) => Math.round((value + delta) * 10000) / 10000;
const passes = (hex, against, ratio) => against.every(other => contrast(hex, other) >= ratio);

/** Darkens (direction −1) or lightens (+1) by .01 from `start` until `hex` passes every check. */
function search(start, direction, color, accept) {
  let lightness = start, hex = color(lightness);
  while (!accept(hex) && (direction < 0 ? lightness > 0 : lightness < 1)) {
    lightness = Math.min(1, Math.max(0, step(lightness, direction * .01)));
    hex = color(lightness);
  }
  return { lightness, hex };
}

// Solid fill + on color (§3.3 steps 3 and 8): white if it reaches 4.5, else ink if it reaches 4.5,
// else darken .01 at a time until white passes.
function solidFor(lightness, color) {
  const hex = color(lightness);
  if (contrast(hex, WHITE) >= TEXT) return { lightness, hex, on: WHITE, adjusted: false };
  if (contrast(hex, INK) >= TEXT) return { lightness, hex, on: INK, adjusted: false };
  const found = search(lightness, -1, color, candidate => contrast(candidate, WHITE) >= TEXT);
  return { ...found, on: WHITE, adjusted: true };
}

// Hover/pressed move by the spec step and must keep AA with the on color and differ from the solid.
// Darkening under white text or lightening under ink only raises contrast; the risky case is ink text
// darkened by −.04/−.08 (light theme). Then keep the farthest shade that still passes and, when there
// is no room at all in that direction (or the solid sits at black/white), step the other way.
function interaction(solid, delta, color) {
  const accept = hex => hex !== solid.hex && contrast(hex, solid.on) >= TEXT;
  const target = step(solid.lightness, delta), back = delta > 0 ? -.01 : .01;
  for (let lightness = target; delta > 0 ? lightness > solid.lightness : lightness < solid.lightness; lightness = step(lightness, back)) {
    const candidate = color(Math.min(1, Math.max(0, lightness)));
    if (accept(candidate)) return candidate;
  }
  for (let lightness = step(solid.lightness, -delta); lightness >= 0 && lightness <= 1; lightness = step(lightness, back)) {
    const candidate = color(lightness);
    if (accept(candidate)) return candidate;
  }
  return color(Math.min(1, Math.max(0, step(solid.lightness, -delta))));
}

const cache = new Map();

/**
 * Derives the brand ramp and the light/dark accent tokens of §3.3 from one hex color.
 * Invalid input uses DEFAULT_BRAND (report.fallback). The result is frozen and memoized per
 * normalized hex, so render() can call it on every pass and applyBrandTokens can skip repeats.
 */
export function deriveBrandTokens(value) {
  const normalized = normalizeHex(value), input = normalized || DEFAULT_BRAND;
  const key = normalized || '';
  if (cache.has(key)) return cache.get(key);
  const base = hexToOklch(input), L = base.l, H = base.h, C = Math.min(base.c, MAX_CHROMA);
  const unchanged = base.c <= MAX_CHROMA;
  // A tone at the brand's own lightness and full chroma is the brand itself (no round-trip drift).
  const tone = (lightness, factor = 1) => lightness === L && factor === 1 && unchanged ? input : oklchToHex(lightness, C * factor, H);
  // The solid starts from the exact brand color, even when its chroma is above the ramp cap.
  const solidColor = lightness => lightness === L ? input : oklchToHex(lightness, C, H);
  const light = SURFACES.light, dark = SURFACES.dark;
  const lightSurfaces = [light.bg, light.s1, light.s2, light.s3], darkSurfaces = [dark.bg, dark.s1, dark.s2, dark.s3];

  const ramp = Object.fromEntries(RAMP_STEPS.map((name, index) => [name, oklchToHex(RAMP_L[index], C * RAMP_C[index], H)]));

  // Light theme (steps 3–7).
  const solidL = solidFor(L, solidColor);
  const textL = search(Math.min(L, .56), -1, lightness => tone(lightness), hex => passes(hex, lightSurfaces, TEXT)).hex;
  const softL = tone(.95, .30);
  const softTextL = search(.45, -1, lightness => tone(lightness, .95), hex => contrast(hex, softL) >= TEXT).hex;
  const lightTokens = {
    accent: solidL.hex,
    onAccent: solidL.on,
    accentHover: interaction(solidL, solidL.on === WHITE ? -.05 : -.04, solidColor),
    accentPressed: interaction(solidL, solidL.on === WHITE ? -.10 : -.08, solidColor),
    accentText: textL,
    accentSoft: softL,
    accentSoftBorder: tone(.86, .60),
    accentSoftText: softTextL,
    focus: search(.58, -1, lightness => tone(lightness), hex => passes(hex, [light.s1, light.bg], NON_TEXT)).hex,
    edge: contrast(solidL.hex, light.s1) < NON_TEXT ? textL : 'transparent'
  };

  // Dark theme (steps 8–9).
  const solidD = solidFor(Math.min(.62, Math.max(.54, L)), solidColor);
  const textD = search(.80, 1, lightness => tone(lightness, .8), hex => passes(hex, darkSurfaces, TEXT)).hex;
  const softD = tone(.29, .45);
  const darkTokens = {
    accent: solidD.hex,
    onAccent: solidD.on,
    accentHover: interaction(solidD, solidD.on === WHITE ? -.03 : .03, solidColor),
    accentPressed: interaction(solidD, solidD.on === WHITE ? -.06 : .06, solidColor),
    accentText: textD,
    accentSoft: softD,
    accentSoftBorder: tone(.40, .60),
    accentSoftText: search(.86, 1, lightness => tone(lightness, .60), hex => contrast(hex, softD) >= TEXT).hex,
    focus: search(.74, 1, lightness => tone(lightness), hex => passes(hex, [dark.s1, dark.bg], NON_TEXT)).hex,
    edge: contrast(solidD.hex, dark.s1) < NON_TEXT ? textD : 'transparent'
  };

  // Step 10: agents switch to teal when the brand hue sits within 35° of the agent violet.
  const distance = Math.abs(((H - AGENT_HUE) % 360 + 540) % 360 - 180);
  const agentHue = base.c >= ACHROMATIC && distance < AGENT_HUE_DISTANCE ? 'alt' : 'default';

  // Step 11: facts for the Brand screen; the copy is rendered by the screen (ui.js brandReportLines).
  const report = {
    input: normalized,
    fallback: !normalized,
    whiteContrast: Math.round(contrast(input, WHITE) * 100) / 100,
    inkContrast: Math.round(contrast(input, INK) * 100) / 100,
    onAccent: solidL.on === WHITE ? 'white' : 'ink',
    adjusted: solidL.hex !== input,
    edge: lightTokens.edge !== 'transparent',
    agentHue
  };

  const result = deepFreeze({ input, ramp, light: lightTokens, dark: darkTokens, agentHue, report });
  cache.set(key, result);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return result;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}

/** Custom properties of a derived token set: [[name, value], …] in a stable order. */
export function brandTokenEntries(tokens) {
  const entries = [];
  for (const [theme, suffix] of [['light', 'l'], ['dark', 'd']]) {
    for (const [key, name] of Object.entries(BRAND_TOKEN_NAMES)) entries.push([`--b-${name}-${suffix}`, tokens[theme][key]]);
  }
  for (const name of RAMP_STEPS) entries.push([`--brand-${name}`, tokens.ramp[name]]);
  return entries;
}

/**
 * Stylesheet with the derived tokens of one brand on :root (GET /brand.css of the login page, P10).
 * Only normalized hex values come out of deriveBrandTokens, so no input reaches the CSS text; an
 * invalid or missing color gives the default brand, exactly like the panel.
 */
export function brandStylesheet(value) {
  const tokens = deriveBrandTokens(value);
  const lines = brandTokenEntries(tokens).map(([name, color]) => `  ${name}: ${color};`);
  return `/* Marca deste endereço: tokens derivados por brand-theme.js (FRONTEND-V2 §3.3). */\n:root {\n${lines.join('\n')}\n}\n`;
}

const applied = new WeakMap();

/**
 * Writes the derived tokens on `root` (normally <html>) through style.setProperty and sets
 * data-agent-hue="alt" when agents must use teal. Re-applying the same token set is a no-op.
 */
export function applyBrandTokens(root, tokens) {
  if (!root?.style?.setProperty || !tokens?.light || !tokens?.dark || !tokens?.ramp) return false;
  if (applied.get(root) === tokens) return false;
  for (const [name, value] of brandTokenEntries(tokens)) root.style.setProperty(name, value);
  if (tokens.agentHue === 'alt') root.setAttribute?.('data-agent-hue', 'alt');
  else root.removeAttribute?.('data-agent-hue');
  applied.set(root, tokens);
  return true;
}
