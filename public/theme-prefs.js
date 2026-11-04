// Appearance preferences of the panel (FRONTEND-V2 §2.3 "Menu da conta", §3.7, §8.2 commit 1c and
// §8.11, where P10 unlocked the dark theme).
// - Theme: Sistema (default) / Claro / Escuro. "Sistema" leaves <html> without data-theme, so tokens.css
//   follows prefers-color-scheme; "Claro" writes data-theme="light" (which also wins over a dark system)
//   and "Escuro" data-theme="dark". <meta name="theme-color"> follows the same choice.
// - Density: Confortável/Compacta → data-density="compact" (paddings only, never the font).
// - Motion: Sistema/Reduzidas → data-motion="reduced" (tokens.css shortens durations and shifts). The
//   system setting is always honoured: there is no choice that forces motion back on.
// - Privacy: Desligado/Ligado → data-privacy="on" (shell.css blurs customer names, phones, photos and previews for a
//   demo or a shared screen). Only the screen changes: the data the person may read and the API are the same.
// Preferences live per person in localStorage under elozi:prefs:<userId>, the same record the shell
// uses for its own keys (sidebar, notice); writes merge so each owner keeps the other keys intact.
// data-agent-hue belongs to the brand (brand-theme.js applyBrandTokens), not to these preferences.

export const DARK_THEME_AVAILABLE = true;
export const THEME_CHOICES = Object.freeze(['system', 'light', 'dark']);
export const DENSITY_CHOICES = Object.freeze(['comfortable', 'compact']);
export const MOTION_CHOICES = Object.freeze(['system', 'reduced']);
export const PRIVACY_CHOICES = Object.freeze(['off', 'on']);
export const DEFAULT_THEME_PREFS = Object.freeze({ theme: 'system', density: 'comfortable', motion: 'system', privacy: 'off' });
/** Color of the browser UI per theme: the top bar (--surface-1 of tokens.css, §3.2). */
export const THEME_COLORS = Object.freeze({ light: '#ffffff', dark: '#14171e' });
const CHOICES = { theme: THEME_CHOICES, density: DENSITY_CHOICES, motion: MOTION_CHOICES, privacy: PRIVACY_CHOICES };

export const prefsKey = userId => `elozi:prefs:${String(userId || 'anonymous')}`;
// Reading globalThis.localStorage itself throws where storage is blocked; every default goes through here.
const defaultStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

/** Keeps only known keys with allowed values; anything else falls back to the default. */
export function normalizeThemePrefs(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.freeze(Object.fromEntries(Object.entries(DEFAULT_THEME_PREFS).map(([key, fallback]) => [key, CHOICES[key].includes(source[key]) ? source[key] : fallback])));
}

function readRecord(key, storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function saveRecord(key, patch, storage) {
  const record = readRecord(key, storage), next = normalizeThemePrefs({ ...normalizeThemePrefs(record), ...patch });
  try { storage?.setItem(key, JSON.stringify({ ...record, ...next })); } catch {}
  return next;
}

/** Preferences of one person; private windows, blocked storage or bad JSON give the defaults. */
export function readThemePrefs(userId, storage = defaultStorage()) {
  return normalizeThemePrefs(readRecord(prefsKey(userId), storage));
}

/** Merges valid keys of `patch` into the stored record and returns the resulting preferences. */
export function saveThemePrefs(userId, patch, storage = defaultStorage()) {
  return saveRecord(prefsKey(userId), patch, storage);
}

const systemPrefersDark = () => { try { return Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches); } catch { return false; } };

/** 'light' or 'dark' for the given preferences ("Sistema" follows the system setting). */
export function resolveTheme(prefs, { systemDark = systemPrefersDark(), darkAvailable = DARK_THEME_AVAILABLE } = {}) {
  if (!darkAvailable) return 'light';
  const { theme } = normalizeThemePrefs(prefs);
  return theme === 'dark' || theme === 'system' && systemDark ? 'dark' : 'light';
}

/**
 * Points <meta name="theme-color"> at the chosen theme. index.html carries one meta per theme, each with
 * its media query and data-theme-value; "Sistema" gives each meta back its own color.
 */
function applyThemeColor(root, theme) {
  const metas = root?.ownerDocument?.querySelectorAll?.('meta[name="theme-color"]') || [];
  for (const meta of metas) {
    const own = meta.getAttribute?.('data-theme-value') === 'dark' ? 'dark' : 'light';
    const color = THEME_COLORS[theme === 'system' ? own : theme];
    if (meta.getAttribute?.('content') !== color) meta.setAttribute?.('content', color);
  }
}

/** Reflects the preferences on <html> as data attributes; absent attributes mean the defaults. */
export function applyThemePrefs(root, prefs, { darkAvailable = DARK_THEME_AVAILABLE } = {}) {
  if (!root?.setAttribute || !root?.removeAttribute) return normalizeThemePrefs(prefs);
  const next = normalizeThemePrefs(prefs);
  const theme = darkAvailable ? next.theme : 'light';
  const attributes = {
    'data-theme': theme === 'system' ? null : theme,
    'data-density': next.density === 'compact' ? 'compact' : null,
    'data-motion': next.motion === 'reduced' ? 'reduced' : null,
    'data-privacy': next.privacy === 'on' ? 'on' : null
  };
  for (const [name, value] of Object.entries(attributes)) {
    if (value) root.setAttribute(name, value);
    else root.removeAttribute(name);
  }
  applyThemeColor(root, theme);
  return next;
}

let synced = null;
/** Applies the stored preferences of `userId` once per person (render() calls it on every pass). */
export function syncThemePrefs(root, userId, storage = defaultStorage()) {
  const key = prefsKey(userId);
  if (synced?.root === root && synced.key === key) return synced.prefs;
  const prefs = applyThemePrefs(root, readRecord(key, storage));
  synced = { root, key, prefs };
  return prefs;
}

/** Saves a change made in the account menu and applies it right away. */
export function updateThemePrefs(root, userId, patch, storage = defaultStorage()) {
  const key = prefsKey(userId), prefs = applyThemePrefs(root, saveRecord(key, patch, storage));
  synced = { root, key, prefs };
  return prefs;
}

/**
 * Same as updateThemePrefs for the person whose preferences render() applied last: the shell's account
 * menu changes the theme without knowing who is signed in. null before the first render.
 */
export function updateCurrentThemePrefs(patch, storage = defaultStorage()) {
  if (!synced) return null;
  const prefs = applyThemePrefs(synced.root, saveRecord(synced.key, patch, storage));
  synced = { ...synced, prefs };
  return prefs;
}

/**
 * Whether decorative motion may run (WAAPI, FLIP, count-up, startViewTransition). False when the
 * person chose "Reduzidas" or the system asks for reduced motion.
 */
export function motionOK({ root = globalThis.document?.documentElement, matchMedia = globalThis.matchMedia } = {}) {
  if (root?.getAttribute?.('data-motion') === 'reduced') return false;
  try { if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false; } catch {}
  return true;
}
