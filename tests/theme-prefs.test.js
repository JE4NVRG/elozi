// Appearance preferences (FRONTEND-V2 §2.3, §3.7, §8.2 commit 1c, §8.11): theme Sistema/Claro/Escuro
// (dark unlocked in P10, theme-color follows), density and motion become data attributes on <html>,
// storage merges per person, motionOK() honors both the person's choice and the system setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DARK_THEME_AVAILABLE, DEFAULT_THEME_PREFS, THEME_COLORS, applyThemePrefs, motionOK, normalizeThemePrefs, prefsKey, readThemePrefs,
  resolveTheme, saveThemePrefs, syncThemePrefs, updateCurrentThemePrefs, updateThemePrefs
} from '../public/theme-prefs.js';

const storage = (initial = {}) => {
  const data = new Map(Object.entries(initial)), reads = [];
  return { data, reads, getItem(key) { reads.push(key); return data.get(key) ?? null; }, setItem(key, value) { data.set(key, String(value)); } };
};
const meta = theme => {
  const attributes = new Map([['name', 'theme-color'], ['data-theme-value', theme], ['content', THEME_COLORS[theme]]]);
  return { attributes, setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name) ?? null };
};
const element = () => {
  const attributes = new Map(), metas = [meta('light'), meta('dark')];
  return { attributes, metas, ownerDocument: { querySelectorAll: selector => selector === 'meta[name="theme-color"]' ? metas : [] },
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name), getAttribute: name => attributes.get(name) ?? null };
};
const colors = root => root.metas.map(item => item.getAttribute('content'));

test('tema liberado no P10: Sistema segue o sistema sem data-theme, Claro e Escuro gravam data-theme e o theme-color acompanha', () => {
  assert.equal(DARK_THEME_AVAILABLE, true);
  assert.equal(DEFAULT_THEME_PREFS.theme, 'system');
  assert.equal(resolveTheme({ theme: 'dark' }, { systemDark: false }), 'dark');
  assert.equal(resolveTheme({ theme: 'light' }, { systemDark: true }), 'light', 'Claro vence o sistema escuro');
  assert.equal(resolveTheme({ theme: 'system' }, { systemDark: true }), 'dark');
  assert.equal(resolveTheme({ theme: 'system' }, { systemDark: false }), 'light');
  assert.equal(resolveTheme({ theme: 'dark' }, { darkAvailable: false }), 'light', 'a trava continua disponível para testes');
  const root = element();
  applyThemePrefs(root, { theme: 'dark' });
  assert.equal(root.attributes.get('data-theme'), 'dark'); assert.deepEqual(colors(root), [THEME_COLORS.dark, THEME_COLORS.dark]);
  applyThemePrefs(root, { theme: 'light' });
  assert.equal(root.attributes.get('data-theme'), 'light', 'Claro precisa do atributo para vencer o prefers-color-scheme');
  assert.deepEqual(colors(root), [THEME_COLORS.light, THEME_COLORS.light]);
  applyThemePrefs(root, { theme: 'system' });
  assert.equal(root.attributes.has('data-theme'), false, 'Sistema: tokens.css segue prefers-color-scheme');
  assert.deepEqual(colors(root), [THEME_COLORS.light, THEME_COLORS.dark], 'cada meta volta à cor do próprio esquema');
  assert.deepEqual({ ...THEME_COLORS }, { light: '#ffffff', dark: '#14171e' }, 'a barra do navegador acompanha o topo (--surface-1)');
  assert.doesNotThrow(() => applyThemePrefs({ setAttribute() {}, removeAttribute() {} }, { theme: 'dark' }), 'sem documento (render dos testes) nada quebra');
});

test('o menu da conta troca o tema da pessoa aplicada pelo último render, sem conhecer o userId', () => {
  const store = storage({ [prefsKey('ana')]: JSON.stringify({ sidebar: 'rail', motion: 'reduced' }) }), root = element();
  syncThemePrefs(root, 'ana', store);
  assert.equal(root.attributes.has('data-theme'), false);
  assert.deepEqual({ ...updateCurrentThemePrefs({ theme: 'dark' }, store) }, { theme: 'dark', density: 'comfortable', motion: 'reduced', privacy: 'off' });
  assert.equal(root.attributes.get('data-theme'), 'dark');
  assert.deepEqual(JSON.parse(store.data.get(prefsKey('ana'))), { sidebar: 'rail', motion: 'reduced', theme: 'dark', density: 'comfortable', privacy: 'off' }, 'merge preserva as outras chaves');
  assert.equal(syncThemePrefs(root, 'ana', store).theme, 'dark', 'o próximo render não relê nem desfaz a escolha');
  updateCurrentThemePrefs({ theme: 'bogus' }, store);
  assert.equal(root.attributes.has('data-theme'), false, 'valor desconhecido volta ao padrão (Sistema), como em saveThemePrefs');
  assert.doesNotThrow(() => updateCurrentThemePrefs({ theme: 'light' }, { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } }));
  assert.equal(root.attributes.get('data-theme'), 'light', 'sem armazenamento a escolha vale nesta página');
});

test('densidade e movimento viram atributos; valores desconhecidos voltam ao padrão', () => {
  assert.deepEqual({ ...normalizeThemePrefs({ theme: 'neon', density: 'compact', motion: 'reduced', extra: 1 }) }, { theme: 'system', density: 'compact', motion: 'reduced', privacy: 'off' });
  assert.deepEqual({ ...normalizeThemePrefs(null) }, { ...DEFAULT_THEME_PREFS });
  const root = element();
  root.setAttribute('data-agent-hue', 'alt');
  applyThemePrefs(root, { density: 'compact', motion: 'reduced' });
  assert.equal(root.attributes.get('data-density'), 'compact'); assert.equal(root.attributes.get('data-motion'), 'reduced');
  applyThemePrefs(root, DEFAULT_THEME_PREFS);
  assert.equal(root.attributes.has('data-density'), false); assert.equal(root.attributes.has('data-motion'), false);
  assert.equal(root.attributes.get('data-agent-hue'), 'alt', 'a cor de agente pertence à marca, não às preferências');
  assert.doesNotThrow(() => applyThemePrefs(null, { density: 'compact' }));
});

test('preferências por pessoa em elozi:prefs:<userId>, com merge que preserva chaves de outros donos', () => {
  const store = storage({ [prefsKey('ana')]: JSON.stringify({ sidebar: 'rail', density: 'compact' }) });
  assert.equal(prefsKey('ana'), 'elozi:prefs:ana');
  assert.equal(readThemePrefs('ana', store).density, 'compact');
  assert.deepEqual({ ...saveThemePrefs('ana', { motion: 'reduced', theme: 'bogus' }, store) }, { theme: 'system', density: 'compact', motion: 'reduced', privacy: 'off' });
  assert.deepEqual(JSON.parse(store.data.get('elozi:prefs:ana')), { sidebar: 'rail', density: 'compact', motion: 'reduced', theme: 'system', privacy: 'off' });
  assert.equal(readThemePrefs('bia', store).density, 'comfortable', 'outra pessoa não herda');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual({ ...readThemePrefs('ana', broken) }, { ...DEFAULT_THEME_PREFS });
  assert.doesNotThrow(() => saveThemePrefs('ana', { density: 'compact' }, broken));
  assert.deepEqual({ ...readThemePrefs('ana', storage({ [prefsKey('ana')]: '[1,2]' })) }, { ...DEFAULT_THEME_PREFS });
  assert.deepEqual({ ...readThemePrefs('ana', storage({ [prefsKey('ana')]: '{bad' })) }, { ...DEFAULT_THEME_PREFS });
});

test('syncThemePrefs lê o armazenamento uma vez por pessoa; updateThemePrefs salva e aplica na hora', () => {
  const store = storage({ [prefsKey('ana')]: JSON.stringify({ motion: 'reduced' }) }), root = element();
  syncThemePrefs(root, 'ana', store); syncThemePrefs(root, 'ana', store); syncThemePrefs(root, 'ana', store);
  assert.equal(store.reads.length, 1, 'render() pode chamar a cada passada sem reler o storage');
  assert.equal(root.attributes.get('data-motion'), 'reduced');
  syncThemePrefs(root, 'bia', store);
  assert.equal(root.attributes.has('data-motion'), false); assert.equal(store.reads.length, 2);
  updateThemePrefs(root, 'bia', { density: 'compact' }, store);
  assert.equal(root.attributes.get('data-density'), 'compact');
  assert.equal(syncThemePrefs(root, 'bia', store).density, 'compact'); assert.equal(store.reads.length, 3, 'só a leitura do merge do update');
});

test('motionOK respeita a escolha "Reduzidas" e o prefers-reduced-motion do sistema', () => {
  const root = element(), media = reduce => query => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' });
  assert.equal(motionOK({ root, matchMedia: media(false) }), true);
  assert.equal(motionOK({ root, matchMedia: media(true) }), false);
  root.setAttribute('data-motion', 'reduced');
  assert.equal(motionOK({ root, matchMedia: media(false) }), false);
  assert.equal(motionOK({ root: null, matchMedia: () => { throw new Error('no media'); } }), true);
});
