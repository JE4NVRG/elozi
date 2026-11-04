import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderWidgetDesigner, mountWidgetDesigner, projectWidgetPreview, widgetAppearancePreset, WIDGET_DESIGNER_TRANSLATIONS } from '../public/widget-designer.js';

const keys = ['panel', 'header', 'field', 'border', 'text', 'muted', 'primary', 'primaryText', 'accent'];
const widget = { displayName: 'Suporte MepMail', openButtonLabel: 'Fale com a equipe', theme: 'dark', radius: 12,
  colors: { panel: '#202020', accent: '#aabbcc' }, lightColors: { panel: '#fafafa' },
  greeting: { 'pt-BR': 'Olá! Como podemos ajudar?', en: 'Hi! How can we help?' },
  handoffMessage: { 'pt-BR': 'A equipe continuará por aqui.', en: 'The team will continue here.' },
  assistantInstructions: 'SYNTHETIC-PRIVATE-INSTRUCTIONS', handoffNotificationEmail: 'private@example.test',
  avatarUrl: 'https://assets.example.test/private-avatar.png', logoUrl: 'https://assets.example.test/logo.png',
  emailPrompt: true, attachmentsEnabled: true, voiceEnabled: true, feedbackEnabled: true, credit: { visible: false, text: 'Equipe própria' } };

function fixture(initial = widget, { guard = () => true } = {}) {
  const listeners = new Map(), mutations = [];
  const field = (name, value, checked = false) => ({ name, value: String(value ?? ''), checked, disabled: false, dataset: {} });
  const fields = [field('displayName', initial.displayName), field('openButtonLabel', initial.openButtonLabel), field('avatarUrl', initial.avatarUrl), field('logoUrl', initial.logoUrl),
    field('radius', initial.radius), field('theme', 'light', initial.theme === 'light'), field('theme', 'dark', initial.theme !== 'light'),
    field('assistantInstructions', initial.assistantInstructions), field('handoffNotificationEmail', initial.handoffNotificationEmail),
    field('creditVisible', 'yes', initial.credit?.visible !== false), field('creditText', initial.credit?.text)];
  for (const group of ['colors', 'lightColors']) for (const key of keys) fields.push(field(`${group}-${key}`, initial[group]?.[key]));
  for (const key of ['greeting', 'handoffMessage']) for (const locale of ['pt-BR', 'en']) fields.push(field(`${key}-${locale}`, initial[key]?.[locale]));
  for (const key of ['emailPrompt', 'attachmentsEnabled', 'voiceEnabled', 'feedbackEnabled']) fields.push(field(key, 'yes', initial[key] === true));
  const button = dataset => ({ dataset, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, closest() { return this; } });
  const modes = [button({ widgetPreviewMode: 'opening' }), button({ widgetPreviewMode: 'conversation' })], locales = [button({ widgetPreviewLocale: 'pt-BR' }), button({ widgetPreviewLocale: 'en' })];
  const presets = [button({ widgetPreviewPreset: 'light' }), button({ widgetPreviewPreset: 'dark' })];
  const pickers = keys.map(key => ({ value: '#000000', dataset: { widgetPreviewColor: `colors-${key}` }, form: { elements: { namedItem: name => fields.find(item => item.name === name) } } }));
  const stage = { set innerHTML(value) { mutations.push(value); this.markup = value; } }, dirty = { textContent: '', dataset: {} };
  const designer = { isConnected: true, contains: node => [...fields, ...modes, ...locales, ...presets, ...pickers].includes(node),
    querySelector: selector => ({ '[data-widget-preview-stage]': stage, '[data-widget-preview-dirty]': dirty }[selector] || null),
    querySelectorAll: selector => ({ '[name]': fields, '[data-widget-preview-mode]': modes, '[data-widget-preview-locale]': locales, '[data-widget-preview-color]': pickers }[selector] || []),
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); } };
  const root = { querySelector: selector => selector === '[data-widget-designer]' ? designer : null };
  const dispose = mountWidgetDesigner(root, { widget: initial, guard });
  return { root, designer, fields, pickers, modes, locales, presets, stage, dirty, mutations, listeners, dispose,
    get: name => fields.find(item => item.name === name),
    emit(type, target) { const event = { target, prevented: false, preventDefault() { this.prevented = true; } }; listeners.get(type)?.(event); return event; } };
}

test('preview palettes follow the served widget defaults and override precedence', () => {
  const light = projectWidgetPreview({ theme: 'light' }), dark = projectWidgetPreview({ theme: 'dark' });
  assert.equal(light.palette.panel, '#ffffff'); assert.equal(light.palette.header, '#27644b'); assert.equal(light.palette.primary, '#27644b'); assert.equal(light.headerText, '#ffffff');
  assert.equal(dark.palette.panel, '#0c0c0d'); assert.equal(dark.palette.field, '#18181b'); assert.equal(dark.palette.accent, '#c0a8e1'); assert.equal(dark.headerText, '#f4f1ea');
  const custom = { theme: 'light', colors: { accent: '#112233', header: '#445566', text: '#123456' }, lightColors: { header: '#778899', primary: '#aabbcc' } };
  const model = projectWidgetPreview(custom); assert.equal(model.palette.header, '#778899'); assert.equal(model.palette.primary, '#aabbcc'); assert.equal(model.headerText, '#123456');
  assert.equal(projectWidgetPreview({ theme: 'light', colors: { accent: '#112233' } }).palette.header, '#112233');
  assert.equal(projectWidgetPreview({ ...custom, theme: 'dark' }).palette.header, '#445566', 'Dark theme ignores optional light palette.');
});

test('incomplete HEX and corner input keep the previous valid preview, while empty colors restore defaults', () => {
  const previous = projectWidgetPreview({ theme: 'light', colors: { panel: '#123456' }, radius: 9 });
  const partial = projectWidgetPreview({ theme: 'light', colors: { panel: '#12' }, radius: '' }, { previous });
  assert.equal(partial.palette.panel, '#123456'); assert.equal(partial.radius, 9);
  assert.equal(projectWidgetPreview({ theme: 'light', colors: { panel: '' } }, { previous }).palette.panel, '#ffffff');
  assert.equal(projectWidgetPreview({ colors: { panel: 'url(javascript:alert(1))' }, radius: -1 }, { previous: { radius: 'unsafe' } }).radius, 16);
  assert.equal(projectWidgetPreview({ radius: 0 }).radius, 0); assert.equal(projectWidgetPreview({ radius: 24 }).radius, 24);
});

test('launcher preview uses primary colors independently of header colors like the served widget', () => {
  const markup = renderWidgetDesigner({ widget: { theme: 'dark', colors: { header: '#112233', text: '#aabbcc', primary: '#774411', primaryText: '#fcfafa', border: '#123456' } } });
  assert.match(markup, /--wd-header:#112233/); assert.match(markup, /--wd-header-text:#aabbcc/);
  assert.match(markup, /class="widget-designer__launcher" style="background:#774411;color:#fcfafa;border-color:#123456"/);
});

test('pure projection is PT/EN and mode aware, without private fields or remote image URLs', () => {
  const en = projectWidgetPreview(widget, { locale: 'en', mode: 'conversation' }), pt = projectWidgetPreview(widget);
  assert.equal(en.locale, 'en'); assert.equal(en.mode, 'conversation'); assert.equal(en.greeting, widget.greeting.en); assert.equal(en.handoff, widget.handoffMessage.en);
  assert.equal(pt.mode, 'opening'); assert.equal(pt.greeting, widget.greeting['pt-BR']); assert.equal(en.initials, 'SM'); assert.equal(en.avatarApplied, true);
  assert.doesNotMatch(JSON.stringify(en), /SYNTHETIC-PRIVATE|private@example|https:|assistantInstructions|handoffNotificationEmail|avatarUrl|logoUrl/);
  assert.equal(projectWidgetPreview(null).title, 'Atendimento'); assert.equal(projectWidgetPreview({}, { locale: 'en' }).title, 'Support');
});

test('renderer keeps supplied sections in one progressive layout without creating a form, names or save action', () => {
  const sections = { appearance: '<p>APPEARANCE-FIELDS</p>', copy: '<p>COPY-FIELDS</p>', behavior: '<p>BEHAVIOR-FIELDS</p>', hermes: '<p>PRIVATE-FIELDS</p>' };
  const markup = renderWidgetDesigner({ sections, widget, locale: 'en' });
  const markers = Object.values(sections).map(section => markup.indexOf(section)); assert.ok(markers.every((at, index) => at >= 0 && (!index || at > markers[index - 1])));
  assert.equal((markup.match(/<details class="widget-designer__section"/g) || []).length, 4); assert.equal((markup.match(/class="widget-designer__section" open/g) || []).length, 1);
  assert.match(markup, /data-widget-designer/); assert.match(markup, /Chat preview/); assert.match(markup, /Default dark/); assert.match(markup, /Hi! How can we help\?/);
  assert.doesNotMatch(markup, /<form|\bname=|type="submit"|data-connector-action|<img|<iframe|https:\/\/assets/);
});

test('rendered projection escapes content and never treats a string as style or markup', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const markup = renderWidgetDesigner({ widget: { ...widget, displayName: payload, openButtonLabel: payload, greeting: { 'pt-BR': payload }, handoffMessage: { 'pt-BR': payload }, credit: { text: payload }, colors: { panel: '"><script>unsafe</script>' } } });
  assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img|<script|SYNTHETIC-PRIVATE|private@example/);
  assert.match(markup, /--wd-panel:#0c0c0d/);
});

test('local edits refresh unsaved preview, preserve HEX typing and switch modes/languages without submitting', () => {
  const c = fixture(); c.get('displayName').value = '<b>Nova marca</b>'; c.emit('input', c.get('displayName'));
  assert.match(c.stage.markup, /&lt;b&gt;Nova marca&lt;\/b&gt;/); assert.equal(c.dirty.dataset.dirty, 'true');
  c.get('colors-panel').value = '#123456'; c.emit('input', c.get('colors-panel')); c.get('colors-panel').value = '#12'; c.emit('input', c.get('colors-panel'));
  assert.match(c.stage.markup, /--wd-panel:#123456/); assert.equal(c.get('colors-panel').value, '#12');
  assert.equal(c.emit('click', c.modes[1]).prevented, true); assert.match(c.stage.markup, /Exemplo de conversa/); assert.equal(c.modes[1].attributes['aria-pressed'], 'true');
  c.emit('click', c.locales[1]); assert.match(c.stage.markup, /Example conversation/); assert.match(c.stage.markup, /Hi! How can we help\?/); assert.equal(c.locales[1].attributes['aria-pressed'], 'true');
  assert.doesNotMatch(c.stage.markup, /SYNTHETIC-PRIVATE|private@example/); c.dispose();
});

test('appearance presets modify only existing theme, colors, lightColors and radius fields', () => {
  const c = fixture(); const unchanged = c.fields.filter(field => !['theme', 'radius'].includes(field.name) && !field.name.startsWith('colors-') && !field.name.startsWith('lightColors-')).map(field => ({ name: field.name, value: field.value, checked: field.checked }));
  for (const [index, theme] of [[0, 'light'], [1, 'dark']]) {
    c.emit('click', c.presets[index]);
    assert.equal(c.fields.find(field => field.name === 'theme' && field.checked).value, theme); assert.equal(c.get('radius').value, '16');
    assert.ok(c.fields.filter(field => /^(colors|lightColors)-/.test(field.name)).every(field => field.value === ''));
    assert.deepEqual(unchanged.map(before => { const field = c.get(before.name); return { name: field.name, value: field.value, checked: field.checked }; }), unchanged);
    assert.equal(c.dirty.dataset.dirty, 'true');
  }
  assert.deepEqual(widgetAppearancePreset('dark'), { theme: 'dark', colors: {}, lightColors: {}, radius: 16 }); c.dispose();
});

test('nameless native picker synchronizes only its existing HEX field and valid HEX synchronizes picker', () => {
  const c = fixture(); const picker = c.pickers.find(item => item.dataset.widgetPreviewColor === 'colors-panel');
  assert.equal(picker.name, undefined); picker.value = '#abcdef'; c.emit('input', picker);
  assert.equal(c.get('colors-panel').value, '#abcdef'); assert.match(c.stage.markup, /--wd-panel:#abcdef/);
  c.get('colors-panel').value = '#fedcba'; c.emit('change', c.get('colors-panel')); assert.equal(picker.value, '#fedcba');
  picker.dataset.widgetPreviewColor = 'handoffNotificationEmail'; picker.value = '#123456'; c.emit('input', picker); assert.equal(c.get('handoffNotificationEmail').value, widget.handoffNotificationEmail); c.dispose();
});

test('guard/disposal prevent stale panel writes, presets and picker edits; absent wrapper safely mounts nothing', () => {
  let allowed = true; const c = fixture(widget, { guard: () => allowed }), before = c.mutations.length;
  allowed = false; c.emit('click', c.presets[0]); assert.equal(c.fields.find(field => field.name === 'theme' && field.checked).value, 'dark');
  c.pickers[0].value = '#abcdef'; c.emit('input', c.pickers[0]); assert.equal(c.get('colors-panel').value, '#202020'); assert.equal(c.mutations.length, before);
  allowed = true; c.designer.isConnected = false; c.emit('click', c.locales[1]); assert.equal(c.mutations.length, before);
  c.dispose(); c.dispose(); assert.equal(c.listeners.size, 0);
  assert.doesNotThrow(() => mountWidgetDesigner({ querySelector: () => null })());
});

test('designer stays offline and stylesheet is namespaced, responsive and keeps accessible targets', async () => {
  const js = await readFile(new URL('../public/widget-designer.js', import.meta.url), 'utf8'), css = await readFile(new URL('../public/widget-designer.css', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /\bfetch\s*\(|\bXMLHttpRequest\b|\blocalStorage\b|\bsessionStorage\b|createWebchatWidget|^import /m);
  assert.match(css, /^@layer components\{/); assert.match(css, /#modal:has\(\[data-widget-designer\]\)\{width:min\(1240px,calc\(100vw - 32px\)\);max-width:calc\(100vw - 32px\);max-height:calc\(100dvh - 32px\)\}/);
  assert.match(css, /position:sticky/); assert.match(css, /@media\(max-width:600px\)/); assert.match(css, /grid-template-columns:minmax\(0,1fr\)/); assert.match(css, /min-height:44px/); assert.match(css, /focus-visible/);
  assert.doesNotMatch(css, /font-size:\d|#[0-9a-f]{3,8}\b|440px/); assert.match(css, /font-size:var\(--fs-xs\)/); assert.match(css, /box-shadow:var\(--shadow-2\)/);
  assert.ok(Object.entries(WIDGET_DESIGNER_TRANSLATIONS).every(([pt, en]) => pt && en));
});
