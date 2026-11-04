// Local presentation only. The connector owns the form, authorization and save action.
export const WIDGET_DESIGNER_TRANSLATIONS = Object.freeze({
  'Aparência': 'Appearance', 'Nome, avatar e cores': 'Name, avatar and colors',
  'Textos': 'Copy', 'Saudações e retorno': 'Greetings and handoff',
  'Comportamento': 'Behavior', 'Contato, anexos e avaliação': 'Contact, attachments and feedback',
  'Hermes': 'Hermes', 'Orientações privadas deste canal': 'Private instructions for this channel',
  'Padrão claro': 'Default light', 'Padrão escuro': 'Default dark',
  'Os padrões alteram apenas tema, cores e cantos.': 'Presets change only the theme, colors and corners.',
  'Prévia do chat': 'Chat preview', 'Abertura': 'Opening', 'Conversa': 'Conversation',
  'Idioma da prévia': 'Preview language', 'Português': 'Portuguese', 'Inglês': 'English',
  'Alterações ainda não salvas': 'Unsaved changes', 'Configuração atual': 'Current configuration',
  'Esta prévia não inicia atendimento nem envia mensagens.': 'This preview does not start a conversation or send messages.',
  'Avatar aplicado no site': 'Avatar applied on the website',
  'Exemplo de conversa': 'Example conversation', 'Atendimento': 'Support',
  'Abrir conversa': 'Open conversation', 'Como podemos ajudar?': 'How can we help?',
  'Seu nome': 'Your name', 'Seu e-mail (opcional)': 'Your email (optional)',
  'Iniciar conversa': 'Start conversation', 'Como configurar meu acesso?': 'How do I configure my access?',
  'Posso ajudar com o acesso. Conte um pouco mais sobre o que precisa.': 'I can help with access. Tell me a little more about what you need.',
  'Escreva uma mensagem…': 'Write a message…', 'Enviar': 'Send',
  'Mensagem de transferência': 'Handoff message', 'Avaliação ao encerrar': 'Feedback when the conversation ends',
  'Anexos disponíveis': 'Attachments available', 'Áudio disponível': 'Audio available',
  'Atendimento por Elozi': 'Support by Elozi'
});

const KEYS = ['panel', 'header', 'field', 'border', 'text', 'muted', 'primary', 'primaryText', 'accent'];
// Matches public/widget.js paintWidget(), including override precedence.
const DEFAULTS = Object.freeze({
  light: Object.freeze({ panel: '#ffffff', header: '#27644b', field: '#ffffff', border: '#dce6ec', text: '#193149', muted: '#60778b', primary: '#27644b', primaryText: '#ffffff', accent: '#27644b' }),
  dark: Object.freeze({ panel: '#0c0c0d', header: '#131316', field: '#18181b', border: '#2a2a2e', text: '#f4f1ea', muted: '#918f89', primary: '#f4f1ea', primaryText: '#000000', accent: '#c0a8e1' })
});
const language = value => value === 'en' ? 'en' : 'pt-BR';
const localized = (key, locale) => locale === 'en' ? WIDGET_DESIGNER_TRANSLATIONS[key] || key : key;
const clean = (value, max = 600) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : '';
const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const paletteMap = (value, previous = {}) => Object.fromEntries(KEYS.flatMap(key => {
  const input = value?.[key];
  if (hex(input)) return [[key, input]];
  // Empty inputs deliberately restore the theme; unfinished colors retain the last valid preview.
  return input && hex(previous[key]) ? [[key, previous[key]]] : [];
}));

/** Public visual fields only: never projects private instructions, recipient emails or remote image URLs. */
export function projectWidgetPreview(widget = {}, { locale = 'pt-BR', mode = 'opening', previous } = {}) {
  const value = widget && typeof widget === 'object' ? widget : {}, lang = language(locale);
  const theme = value.theme === 'dark' ? 'dark' : 'light';
  const colors = paletteMap(value.colors, previous?.overrides?.colors), lightColors = paletteMap(value.lightColors, previous?.overrides?.lightColors);
  const palette = { ...DEFAULTS[theme], ...(theme === 'light' && colors.accent ? { header: colors.accent, primary: colors.accent } : {}), ...colors, ...(theme === 'light' ? lightColors : {}) };
  const radius = typeof value.radius === 'number' ? value.radius : /^\d+$/.test(String(value.radius ?? '')) ? Number(value.radius) : NaN;
  const previousRadius = Number.isInteger(previous?.radius) && previous.radius >= 0 && previous.radius <= 24 ? previous.radius : 16;
  const title = clean(value.displayName, 80).trim() || localized('Atendimento', lang);
  const texts = key => clean(value[key]?.[lang]);
  return {
    locale: lang, mode: mode === 'conversation' ? 'conversation' : 'opening', theme, palette,
    overrides: { colors, lightColors }, headerText: theme === 'dark' || colors.header || lightColors.header ? palette.text : '#ffffff',
    radius: Number.isInteger(radius) && radius >= 0 && radius <= 24 ? radius : previousRadius,
    title, initials: title.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase(lang),
    openLabel: clean(value.openButtonLabel, 80).trim() || localized('Abrir conversa', lang),
    greeting: texts('greeting') || localized('Como podemos ajudar?', lang), handoff: texts('handoffMessage'),
    avatarApplied: Boolean(clean(value.avatarUrl, 1000) || clean(value.logoUrl, 1000)),
    emailPrompt: value.emailPrompt === true, feedbackEnabled: value.feedbackEnabled === true,
    attachmentsEnabled: value.attachmentsEnabled !== false, voiceEnabled: value.voiceEnabled !== false && value.attachmentsEnabled !== false,
    credit: { visible: value.credit?.visible !== false, text: clean(value.credit?.text, 120).trim() || localized('Atendimento por Elozi', lang) }
  };
}

/** Empty overrides restore the exact theme defaults without touching any other configuration. */
export function widgetAppearancePreset(theme) {
  return { theme: theme === 'dark' ? 'dark' : 'light', colors: {}, lightColors: {}, radius: 16 };
}

function previewMarkup(model, escape = html) {
  const e = escape, t = key => e(localized(key, model.locale)), p = model.palette;
  const styles = KEYS.map(key => `--wd-${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}:${p[key]}`).join(';') + `;--wd-header-text:${model.headerText};--wd-radius:${model.radius}px`;
  const opening = `<div class="widget-designer__opening"><div class="widget-designer__fake-field">${t('Seu nome')}</div>${model.emailPrompt ? `<div class="widget-designer__fake-field">${t('Seu e-mail (opcional)')}</div>` : ''}<span class="widget-designer__fake-button">${t('Iniciar conversa')}</span></div>`;
  const conversation = `<div class="widget-designer__messages"><p class="widget-designer__example-label">${t('Exemplo de conversa')}</p><p class="widget-designer__bubble widget-designer__bubble--customer">${t('Como configurar meu acesso?')}</p><p class="widget-designer__bubble">${t('Posso ajudar com o acesso. Conte um pouco mais sobre o que precisa.')}</p>${model.handoff ? `<div class="widget-designer__handoff"><small>${t('Mensagem de transferência')}</small><p>${e(model.handoff)}</p></div>` : ''}</div><div class="widget-designer__composer"><span>${t('Escreva uma mensagem…')}</span><span class="widget-designer__send">${t('Enviar')}</span></div>`;
  const flags = [model.attachmentsEnabled && 'Anexos disponíveis', model.voiceEnabled && 'Áudio disponível', model.feedbackEnabled && 'Avaliação ao encerrar'].filter(Boolean);
  return `<div class="widget-designer__chat" style="${styles}" data-widget-preview-chat>
    <header class="widget-designer__chat-header"><span class="widget-designer__avatar" aria-hidden="true">${e(model.initials)}</span><strong>${e(model.title)}</strong><span aria-hidden="true">×</span></header>
    <p class="widget-designer__greeting">${e(model.greeting)}</p>${model.mode === 'opening' ? opening : conversation}
    ${flags.length ? `<p class="widget-designer__capabilities">${flags.map(key => t(key)).join(' · ')}</p>` : ''}
    ${model.credit.visible ? `<p class="widget-designer__credit">${e(model.credit.text)}</p>` : ''}
  </div><div class="widget-designer__launcher" style="background:${p.primary};color:${p.primaryText};border-color:${p.border}"><span class="widget-designer__launcher-dot" aria-hidden="true">${e(model.initials)}</span><span>${e(model.openLabel)}</span></div>
  ${model.avatarApplied ? `<p class="widget-designer__avatar-note">${t('Avatar aplicado no site')}</p>` : ''}`;
}

export function renderWidgetDesigner({ sections = {}, widget = {}, locale = 'pt-BR', text, escape = html } = {}) {
  const uiLocale = language(locale), t = key => escape(typeof text === 'function' ? text(key) : localized(key, uiLocale));
  const details = [
    ['appearance', 'Aparência', 'Nome, avatar e cores'], ['copy', 'Textos', 'Saudações e retorno'],
    ['behavior', 'Comportamento', 'Contato, anexos e avaliação'], ['hermes', 'Hermes', 'Orientações privadas deste canal']
  ].map(([key, title, hint], index) => `<details class="widget-designer__section" ${key === 'appearance' ? 'open' : ''}><summary><span class="widget-designer__step" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><span><strong>${t(title)}</strong><small>${t(hint)}</small></span></summary><div class="widget-designer__fields">${key === 'appearance' ? `<div class="widget-designer__presets"><button type="button" data-widget-preview-preset="light">${t('Padrão claro')}</button><button type="button" data-widget-preview-preset="dark">${t('Padrão escuro')}</button><small>${t('Os padrões alteram apenas tema, cores e cantos.')}</small></div>` : ''}${typeof sections[key] === 'string' ? sections[key] : ''}</div></details>`).join('');
  return `<div class="widget-designer" data-widget-designer><div class="widget-designer__controls">${details}</div><aside class="widget-designer__preview" aria-label="${t('Prévia do chat')}">
    <div class="widget-designer__preview-heading"><h3>${t('Prévia do chat')}</h3><span class="widget-designer__state" data-widget-preview-dirty role="status">${t('Configuração atual')}</span></div>
    <div class="widget-designer__switches" role="group" aria-label="${t('Prévia do chat')}"><button type="button" data-widget-preview-mode="opening" aria-pressed="true">${t('Abertura')}</button><button type="button" data-widget-preview-mode="conversation" aria-pressed="false">${t('Conversa')}</button></div>
    <div class="widget-designer__languages" role="group" aria-label="${t('Idioma da prévia')}"><button type="button" data-widget-preview-locale="pt-BR" aria-pressed="${uiLocale !== 'en'}">PT</button><button type="button" data-widget-preview-locale="en" aria-pressed="${uiLocale === 'en'}">EN</button></div>
    <div class="widget-designer__stage" data-widget-preview-stage>${previewMarkup(projectWidgetPreview(widget, { locale: uiLocale }), escape)}</div>
    <p class="widget-designer__disclaimer">${t('Esta prévia não inicia atendimento nem envia mensagens.')}</p>
  </aside></div>`;
}

function formProjection(designer, widget) {
  const value = { ...widget, colors: { ...widget?.colors }, lightColors: { ...widget?.lightColors }, credit: { ...widget?.credit } };
  const fields = Array.from(designer.querySelectorAll?.('[name]') || []), find = name => fields.find(field => field.name === name);
  for (const key of ['displayName', 'openButtonLabel', 'avatarUrl', 'logoUrl', 'radius']) if (find(key)) value[key] = find(key).value;
  const selectedTheme = fields.find(field => field.name === 'theme' && field.checked);
  if (selectedTheme) value.theme = selectedTheme.value;
  for (const group of ['colors', 'lightColors']) for (const key of KEYS) if (find(`${group}-${key}`)) value[group][key] = find(`${group}-${key}`).value;
  for (const key of ['greeting', 'handoffMessage']) {
    value[key] = { ...widget?.[key] };
    for (const locale of ['pt-BR', 'en']) if (find(`${key}-${locale}`)) value[key][locale] = find(`${key}-${locale}`).value;
  }
  for (const key of ['emailPrompt', 'attachmentsEnabled', 'voiceEnabled', 'feedbackEnabled']) if (find(key)) value[key] = find(key).checked;
  if (find('creditVisible')) value.credit.visible = find('creditVisible').checked;
  if (find('creditText')) value.credit.text = find('creditText').value;
  return value;
}

/** Attaches only local DOM listeners. Caller must dispose when the guarded connector panel changes. */
export function mountWidgetDesigner(root, { widget = {}, locale = 'pt-BR', text, guard = () => true } = {}) {
  const designer = root?.matches?.('[data-widget-designer]') ? root : root?.querySelector?.('[data-widget-designer]');
  const stage = designer?.querySelector?.('[data-widget-preview-stage]');
  if (!designer || !stage || typeof designer.addEventListener !== 'function') return () => {};
  let disposed = false, dirty = false, previewLocale = language(locale), mode = 'opening', previous;
  const uiText = key => typeof text === 'function' ? text(key) : localized(key, language(locale));
  const valid = () => { try { return !disposed && designer.isConnected !== false && guard() === true; } catch { return false; } };
  const colorName = value => KEYS.some(key => value === `colors-${key}` || value === `lightColors-${key}`);
  const named = name => Array.from(designer.querySelectorAll?.('[name]') || []).find(field => field.name === name);
  const update = () => {
    if (!valid()) return;
    const model = projectWidgetPreview(formProjection(designer, widget), { locale: previewLocale, mode, previous }); previous = model;
    stage.innerHTML = previewMarkup(model);
    const notice = designer.querySelector('[data-widget-preview-dirty]');
    if (notice) { notice.textContent = uiText(dirty ? 'Alterações ainda não salvas' : 'Configuração atual'); notice.dataset.dirty = String(dirty); }
    for (const picker of designer.querySelectorAll?.('[data-widget-preview-color]') || []) {
      const name = picker.dataset.widgetPreviewColor, field = colorName(name) && named(name);
      if (!field) continue;
      const key = name.slice(name.indexOf('-') + 1);
      if (hex(field.value)) picker.value = field.value;
      else if (!field.value) picker.value = name.startsWith('lightColors-') && model.theme === 'dark' ? DEFAULTS.light[key] : model.palette[key];
    }
    for (const button of designer.querySelectorAll?.('[data-widget-preview-mode]') || []) button.setAttribute('aria-pressed', String(button.dataset.widgetPreviewMode === mode));
    for (const button of designer.querySelectorAll?.('[data-widget-preview-locale]') || []) button.setAttribute('aria-pressed', String(button.dataset.widgetPreviewLocale === previewLocale));
  };
  const edit = event => {
    if (!valid() || !designer.contains?.(event.target)) return;
    const target = event.target, pickerName = target?.dataset?.widgetPreviewColor;
    if (pickerName) {
      if (!colorName(pickerName) || !hex(target.value)) return;
      const field = target.form?.elements?.namedItem?.(pickerName) || named(pickerName);
      if (!field || field.disabled) return;
      field.value = target.value;
    } else if (!target?.name) return;
    dirty = true; update();
  };
  const click = event => {
    if (!valid()) return;
    const button = event.target?.closest?.('[data-widget-preview-mode], [data-widget-preview-locale], [data-widget-preview-preset]');
    if (!button || !designer.contains?.(button)) return;
    event.preventDefault();
    if (button.dataset.widgetPreviewMode) mode = button.dataset.widgetPreviewMode === 'conversation' ? 'conversation' : 'opening';
    else if (button.dataset.widgetPreviewLocale) previewLocale = language(button.dataset.widgetPreviewLocale);
    else {
      const preset = widgetAppearancePreset(button.dataset.widgetPreviewPreset), fields = Array.from(designer.querySelectorAll?.('[name]') || []);
      for (const field of fields) {
        if (field.name === 'theme') field.checked = field.value === preset.theme;
        else if (field.name === 'radius') field.value = String(preset.radius);
        else if (KEYS.some(key => field.name === `colors-${key}` || field.name === `lightColors-${key}`)) field.value = '';
      }
      previous = undefined; dirty = true;
    }
    update();
  };
  designer.addEventListener('input', edit); designer.addEventListener('change', edit); designer.addEventListener('click', click); update();
  return () => { if (disposed) return; disposed = true; designer.removeEventListener('input', edit); designer.removeEventListener('change', edit); designer.removeEventListener('click', click); };
}
