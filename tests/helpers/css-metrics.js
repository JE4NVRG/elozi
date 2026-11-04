// Metrics of the CSS ratchet (FRONTEND-V2 §3.1 and §8.2, commit 1a). Every counter may only go
// down: legacy files start from their recorded baseline, new files start at zero.
export const BREAKPOINTS = Object.freeze([600, 900, 1280, 1600]);

export const METRICS = Object.freeze({
  fontSizeBelow12px: 'font-size literal abaixo de 12 px',
  fontSizeLiteral: 'font-size literal (CSS novo usa os tokens de tipografia)',
  hexOutsideTokens: 'cor hexadecimal fora de tokens.css',
  breakpointOutsideSet: `breakpoint de @media fora de {${BREAKPOINTS.join(', ')}}`,
  appShellDataView: 'seletor .app-shell[data-view',
  important: '!important'
});

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(css) {
  const list = [];
  for (const block of css.matchAll(/\{([^{}]*)\}/g)) for (const declaration of block[1].split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) list.push({ property: declaration.slice(0, colon).trim().toLowerCase(), value: declaration.slice(colon + 1).trim() });
  }
  return list;
}

function lengthInPx(token) {
  const match = /^(-?\d*\.?\d+)(px|rem)$/i.exec(token);
  if (!match) return null;
  return Number(match[1]) * (match[2].toLowerCase() === 'rem' ? 16 : 1);
}

// Size of a font-size value or of the font shorthand ("600 11px/1.3 Manrope").
function fontSize({ property, value }) {
  const clean = value.replace(/!\s*important/i, '').trim();
  if (property === 'font-size') return { literal: /^-?\d*\.?\d+(?:px|rem|em|%|pt|vw|vh)$/i.test(clean) || /^(?:clamp|min|max)\(/i.test(clean) && !/var\(/i.test(clean), px: lengthInPx(clean) };
  if (property === 'font') {
    const size = clean.split(/\s+/).map(part => part.split('/')[0]).find(part => /^-?\d*\.?\d+(?:px|rem|em|%|pt)$/i.test(part));
    return size ? { literal: true, px: lengthInPx(size) } : { literal: false, px: null };
  }
  return null;
}

function breakpointAllowed(feature, value) {
  if (/^min-width$/.test(feature)) return BREAKPOINTS.includes(value);
  return BREAKPOINTS.some(point => value === point || value >= point - 1 && value < point);
}

/** Counters of one stylesheet; `tokens` marks public/tokens.css, the only file allowed to hold hex colors. */
export function cssMetrics(css, { tokens = false } = {}) {
  const source = stripComments(css), counts = Object.fromEntries(Object.keys(METRICS).map(key => [key, 0]));
  for (const declaration of declarations(source)) {
    const size = fontSize(declaration);
    if (size?.literal) counts.fontSizeLiteral++;
    if (size?.px !== null && size?.px !== undefined && size.px < 12) counts.fontSizeBelow12px++;
    if (!tokens) counts.hexOutsideTokens += [...declaration.value.matchAll(/#([0-9a-f]+)\b/gi)].filter(match => [3, 4, 6, 8].includes(match[1].length)).length;
  }
  for (const media of source.matchAll(/@media([^{]+)\{/gi)) {
    for (const condition of media[1].matchAll(/\(\s*(min-width|max-width|width)\s*(?::|[<>]=?)\s*(\d*\.?\d+)(px|em|rem)\s*\)/gi)) {
      const value = Number(condition[2]) * (condition[3].toLowerCase() === 'px' ? 1 : 16);
      if (!breakpointAllowed(condition[1].toLowerCase(), value)) counts.breakpointOutsideSet++;
    }
  }
  counts.appShellDataView = (source.match(/\.app-shell\[data-view/g) || []).length;
  counts.important = (source.match(/!\s*important/gi) || []).length;
  return counts;
}
