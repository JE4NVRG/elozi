// Base components of the panel (FRONTEND-V2 §4, commit 1c). Every function returns SafeHTML built
// with h``, so interpolated values are escaped unless they are SafeHTML themselves. Labels arrive
// already translated (t('…') at the call site); the literal copy written here is translated by h``.
// Styles live in components.css (.ui-*, @layer components). Behaviour that needs listeners (tab
// arrows, segmented indicator, copy, dismiss) is delegated once by installUI(document).
import { h, raw, escapeHTML, t, getLocale } from './i18n.js';
import './locales-shell.js';
import { glyph, channelMark, brandForKind } from './icons.js';
import { deriveBrandTokens } from './brand-theme.js';
import { motionOK } from './theme-prefs.js';

const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'link'];
const BUTTON_SIZES = ['sm', 'md', 'lg'];
const TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info', 'agent'];
const BANNER_TONES = ['info', 'warning', 'danger', 'offline', 'success'];
const BANNER_GLYPHS = { info: 'info', warning: 'warning', danger: 'warning', offline: 'offline', success: 'check' };
const AVATAR_KINDS = ['person', 'agent', 'company', 'group'];
const AVATAR_SIZES = [24, 32, 40, 56];
const PRESENCE = ['available', 'busy', 'away', 'offline'];
const CHANNEL_GLYPHS = { whatsapp_qr: 'chat', whatsapp_cloud: 'chat', telegram: 'send', instagram: 'chat', messenger: 'chat', webchat: 'globe', email: 'mail' };
// Event-handler attributes never come through attrs (CSP blocks them anyway); names stay plain.
const ATTRIBUTE_NAME = /^(?!on)[a-z_:][-a-z0-9_:.]*$/i;

const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

/** Extra attributes as escaped markup: {name: value}; true → bare attribute, null/false → omitted. */
export function attributes(map) {
  let markup = '';
  for (const [name, value] of Object.entries(map || {})) {
    if (!ATTRIBUTE_NAME.test(name)) throw new TypeError(`Invalid attribute name: ${name}`);
    if (value === null || value === undefined || value === false) continue;
    markup += value === true ? ` ${name}` : ` ${name}="${escapeHTML(value)}"`;
  }
  return raw(markup);
}

/** Only same-origin paths, fragments and https/mailto links; anything else becomes '#'. */
export function safeHref(value) {
  const href = String(value ?? '').trim();
  return /^(?:#|\/(?!\/)|https:\/\/|mailto:)/i.test(href) ? href : '#';
}

/** Message copy: a small text grammar, never HTML or executable/autolink markup. */
export function messageTextMarkup(value) {
  const inline = text => {
    const pattern = /(?<![\p{L}\p{N}_/])(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)(?![\p{L}\p{N}_])/gu;
    let output = '', cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const token = match[0], delimiter = token.startsWith('**') ? '**' : token[0];
      const content = token.slice(delimiter.length, -delimiter.length);
      output += escapeHTML(text.slice(cursor, match.index));
      if (content.trim() !== content || !content.trim()) output += escapeHTML(token);
      else {
        const tag = { '`': 'code', '**': 'strong', '*': 'strong', '_': 'em', '~': 's' }[delimiter];
        output += `<${tag}>${escapeHTML(content)}</${tag}>`;
      }
      cursor = match.index + token.length;
    }
    return output + escapeHTML(text.slice(cursor));
  };
  const blocks = [];
  let paragraph = [], bullets = [];
  const flushParagraph = () => { if (paragraph.length) blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; };
  const flushBullets = () => { if (bullets.length) blocks.push(`<ul>${bullets.map(line => `<li>${inline(line)}</li>`).join('')}</ul>`); bullets = []; };
  for (const line of String(value ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = /^\s*[-•*]\s+(.+)$/.exec(line);
    if (!line.trim()) { flushParagraph(); flushBullets(); }
    else if (bullet) { flushParagraph(); bullets.push(bullet[1]); }
    else { flushBullets(); paragraph.push(line); }
  }
  flushParagraph(); flushBullets();
  return raw(blocks.join(''));
}

// Avatar images: inline raster data, blob URLs and same-origin paths (CSP img-src 'self' data: blob:).
const safeImage = value => typeof value === 'string' && /^(?:data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}|blob:|\/(?!\/))/.test(value) ? value : '';

const spinner = (cls = '') => h`<span class="ui-spinner ${cls}" aria-hidden="true"></span>`;

/** Button. Labels stay in the DOM while busy so screen readers keep the name. */
export function button({ label, action, variant = 'secondary', size = 'md', icon, kbd: keys, busy = false, disabled = false, disabledReason, type = 'button', className = '', attrs } = {}) {
  const tone = pick(variant, BUTTON_VARIANTS, 'secondary'), scale = pick(size, BUTTON_SIZES, 'md');
  const state = {
    'data-action': action || null,
    'aria-busy': busy ? 'true' : null,
    // Busy or explained-disabled buttons stay focusable; plain disabled ones use the native attribute.
    'aria-disabled': busy || !disabled && disabledReason ? 'true' : null,
    disabled: Boolean(disabled) && !busy,
    title: !disabled && disabledReason ? disabledReason : null
  };
  const lead = busy ? spinner(icon ? 'ui-btn__icon' : 'ui-btn__spinner--overlay') : icon ? glyph(icon, 'ui-btn__icon') : '';
  return h`<button type="${pick(type, ['button', 'submit', 'reset'], 'button')}" class="ui-btn ui-btn--${tone} ui-btn--${scale}${className ? ` ${className}` : ''}"${attributes(state)}${attributes(attrs)}>${lead}<span class="ui-btn__label">${label}</span>${keys ? kbd(keys) : ''}</button>`;
}

/** Icon-only button: aria-label is mandatory; the tooltip repeats the label and the shortcut. */
export function iconButton({ label, icon, action, pressed, kbd: keys, size = 'sm', disabled = false, attrs } = {}) {
  if (!label) throw new TypeError('iconButton requires a label');
  const shortcut = keys ? keyText(keys) : '';
  const state = {
    'data-action': action || null,
    'aria-label': label,
    title: shortcut ? `${label} (${shortcut})` : label,
    'aria-pressed': pressed === undefined || pressed === null ? null : pressed ? 'true' : 'false',
    'aria-keyshortcuts': keys ? ariaShortcut(keys) : null,
    disabled: Boolean(disabled)
  };
  return h`<button type="button" class="ui-iconbtn ui-iconbtn--${pick(size, ['sm', 'md'], 'sm')}"${attributes(state)}${attributes(attrs)}>${glyph(icon)}</button>`;
}

/** Status badge (20 px); tone ∈ neutral/accent/success/warning/danger/info/agent. */
export function badge(text, tone = 'neutral') {
  return h`<span class="ui-badge ui-badge--${pick(tone, TONES, 'neutral')}">${text}</span>`;
}

/** Filter chip: a toggle (aria-pressed) or, when removable, a label with a × button. */
export function chip({ label, count, removable = false, selected = false, action, value, removeLabel, attrs } = {}) {
  const counter = count === undefined || count === null ? '' : h`<span class="ui-chip__count">${count}</span>`;
  if (removable) {
    const name = removeLabel || t('Remover {label}', { label });
    return h`<span class="ui-chip"${attributes({ 'data-state': selected ? 'selected' : null, ...attrs })}><span class="ui-chip__label">${label}</span>${counter}<button type="button" class="ui-chip__remove"${attributes({ 'data-action': action || null, 'data-value': value ?? null, 'aria-label': name, title: name })}>${glyph('close')}</button></span>`;
  }
  return h`<button type="button" class="ui-chip"${attributes({ 'data-action': action || null, 'data-value': value ?? null, 'aria-pressed': selected ? 'true' : 'false' })}${attributes(attrs)}><span class="ui-chip__label">${label}</span>${counter}</button>`;
}

/** Up to `count` initials from the first letters of the words of a name ('?' when empty). */
export function initials(name, count = 2) {
  const letters = String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, count).map(word => Array.from(word)[0]);
  return (letters.join('') || '?').toLocaleUpperCase(getLocale());
}

const presenceLabel = presence => ({ available: t('Disponível'), busy: t('Ocupado'), away: t('Ausente'), offline: t('Fora de atendimento') })[presence];

/**
 * Avatar. person = circle (+ presence ring); agent = square with 30% radius, agent colors and ✦;
 * company = monogram with the company's derived accent; group = stack of two initials.
 * Decorative by default (aria-hidden): the name is expected next to it. label:true exposes it.
 */
export function avatar({ kind = 'person', name = '', src, presence, channel, size = 32, accent, members, label = false } = {}) {
  const type = pick(kind, AVATAR_KINDS, 'person'), dimension = pick(Number(size), AVATAR_SIZES, 32);
  const image = safeImage(src), status = type === 'person' ? pick(presence, PRESENCE, null) : null;
  const a11y = label
    ? { role: 'img', 'aria-label': status ? `${name} · ${presenceLabel(status)}` : name }
    : { 'aria-hidden': 'true' };
  let style = null, content;
  if (type === 'agent') {
    content = image ? h`<img class="ui-avatar__img" src="${image}" alt="" decoding="async"/><span class="ui-avatar__mark">✦</span>` : h`<span class="ui-avatar__glyph">✦</span>`;
  } else if (type === 'group') {
    const people = Array.isArray(members) && members.length ? members.slice(0, 2) : [name];
    content = people.map(member => h`<span class="ui-avatar__stack">${initials(member, 1)}</span>`);
  } else {
    if (type === 'company') {
      const tokens = deriveBrandTokens(accent);
      style = `--company-bg:${tokens.light.accent};--company-fg:${tokens.light.onAccent};--company-edge:${tokens.light.edge}`;
    }
    content = h`<span class="ui-avatar__initials">${initials(name, type === 'company' ? 1 : 2)}</span>${image ? h`<img class="ui-avatar__img" src="${image}" alt="" decoding="async"/>` : ''}`;
  }
  const badgeGlyph = channel ? CHANNEL_GLYPHS[channel] || 'chat' : '';
  return h`<span class="ui-avatar ui-avatar--${type} ui-avatar--${dimension}"${attributes({ ...a11y, 'data-presence': status, 'data-channel': channel || null, style })}>${content}${badgeGlyph ? h`<span class="ui-avatar__channel"${attributes({ 'data-brand': brandForKind(channel) })}>${brandForKind(channel) ? channelMark(brandForKind(channel), { tile: true }) : glyph(badgeGlyph)}</span>` : ''}</span>`;
}

/**
 * Company monogram (18 px, radius 4) with the company's derived light solid and on color, always
 * followed by the company name in text (§3.3 "Acento por empresa"). Never changes the global theme.
 */
export function companyMark(tenant, { showName = true } = {}) {
  const name = String(tenant?.name ?? ''), brand = tenant?.brand || {};
  const tokens = deriveBrandTokens(brand.accent);
  const letter = initials(brand.initials || name, 1);
  const style = `--company-bg:${tokens.light.accent};--company-fg:${tokens.light.onAccent};--company-edge:${tokens.light.edge}`;
  return h`<span class="ui-company"><span class="ui-company__mark" aria-hidden="true"${attributes({ style })}>${letter}</span>${showName ? h`<span class="ui-company__name">${name}</span>` : ''}</span>`;
}

const tabId = (id, item) => `${id}-tab-${item}`;
const panelId = (id, item) => `${id}-panel-${item}`;

/** Tab list (role=tablist). Arrows move focus, Enter/Space activate (manual activation). */
export function tabs({ id, items = [], active, label } = {}) {
  if (!id) throw new TypeError('tabs requires an id');
  const current = items.find(item => item.id === active && !item.disabled) || items.find(item => !item.disabled);
  return h`<div class="ui-tabs" role="tablist"${attributes({ id, 'aria-label': label || null })}>${items.map(item => {
    const selected = item === current;
    const state = { role: 'tab', id: tabId(id, item.id), 'aria-selected': selected ? 'true' : 'false', 'aria-controls': item.panel || panelId(id, item.id), tabindex: selected ? '0' : '-1', 'data-tab': item.id, 'data-action': !item.disabled && item.action || null, disabled: Boolean(item.disabled), 'aria-disabled': item.disabled ? 'true' : null };
    const count = item.count === undefined || item.count === null ? '' : h`<span class="ui-tabs__count">${item.count}</span>`;
    return item.href
      // Fallback selection is a focus target, not evidence that its route is the current page.
      ? h`<a class="ui-tabs__tab"${attributes({ ...state, disabled: null, href: item.disabled ? null : safeHref(item.href), 'aria-current': selected && item.id === active ? 'page' : null })}>${item.label}${count}</a>`
      : h`<button type="button" class="ui-tabs__tab"${attributes(state)}>${item.label}${count}</button>`;
  })}</div>`;
}

/** Panel paired with tabs({id}); hidden unless active. */
export function tabPanel({ tabsId, id, active = false, content = '', focusable = true } = {}) {
  // focusable:false for panels that hold their own focusable controls (a page under route tabs).
  return h`<div class="ui-tabpanel" role="tabpanel"${attributes({ id: panelId(tabsId, id), 'aria-labelledby': tabId(tabsId, id), tabindex: focusable ? '0' : null, hidden: !active })}>${content}</div>`;
}

/** Segmented control: native radios in a radiogroup; the indicator slides between equal columns. */
export function segmented({ name, items = [], value, label, disabled = false } = {}) {
  if (!name) throw new TypeError('segmented requires a name');
  const index = items.findIndex(item => item.value === value);
  const style = `--seg-count:${Math.max(1, items.length)};--seg-index:${Math.max(0, index)}`;
  return h`<div class="ui-seg" role="radiogroup"${attributes({ 'aria-label': label || null, 'data-state': index < 0 ? 'empty' : null, style })}><span class="ui-seg__indicator" aria-hidden="true"></span>${items.map(item => h`<label class="ui-seg__item"><input class="ui-seg__input" type="radio"${attributes({ name, value: item.value, checked: item.value === value, disabled: Boolean(disabled || item.disabled) })}/><span class="ui-seg__label">${item.label}</span></label>`)}</div>`;
}

/** Empty state: icon in a soft circle, title, one sentence, one primary action and an optional link. */
export function emptyState({ icon = 'spark', title, body, action, secondary, level = 2 } = {}) {
  const heading = raw(`h${pick(Number(level), [2, 3, 4], 2)}`);
  const primary = action ? button({ size: 'md', ...action, variant: 'primary' }) : '';
  const link = !secondary ? '' : secondary.href
    ? h`<a class="ui-btn ui-btn--link ui-btn--md"${attributes({ href: safeHref(secondary.href) })}><span class="ui-btn__label">${secondary.label}</span></a>`
    : button({ ...secondary, variant: 'link' });
  return h`<div class="ui-empty"><span class="ui-empty__icon" aria-hidden="true">${glyph(icon)}</span><${heading} class="ui-empty__title">${title}</${heading}>${body ? h`<p class="ui-empty__body">${body}</p>` : ''}${primary || link ? h`<div class="ui-empty__actions">${primary}${link}</div>` : ''}</div>`;
}

/**
 * Banner (info/warning/danger/offline/success). Critical tones (danger, offline) are never
 * dismissible. live: 'polite' → role=status, 'assertive' → role=alert; omit for static banners
 * that re-render with the page, so polls do not re-announce them.
 */
export function banner({ tone = 'info', title, body, action, dismissible = false, live, attrs } = {}) {
  const kind = pick(tone, BANNER_TONES, 'info'), closable = dismissible && !['danger', 'offline'].includes(kind);
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : null;
  return h`<div class="ui-banner ui-banner--${kind}"${attributes({ role, ...attrs })}><span class="ui-banner__icon" aria-hidden="true">${glyph(BANNER_GLYPHS[kind])}</span><div class="ui-banner__text">${title ? h`<strong class="ui-banner__title">${title}</strong>` : ''}${title && body ? ' ' : ''}${body ? h`<span class="ui-banner__body">${body}</span>` : ''}</div>${action ? button({ size: 'sm', variant: 'secondary', ...action }) : ''}${closable ? iconButton({ label: t('Dispensar aviso'), icon: 'close', attrs: { 'data-ui-dismiss': 'banner' } }) : ''}</div>`;
}

/** Loading placeholder: appears after 300 ms (CSS), at most 8 lines; never for background updates. */
export function skeleton({ lines = 3, label } = {}) {
  const count = Math.min(8, Math.max(1, Math.round(Number(lines) || 1)));
  return h`<div class="ui-skeleton" role="status"><span class="sr-only">${label || t('Carregando…')}</span>${Array.from({ length: count }, () => raw('<span class="ui-skeleton__line" aria-hidden="true"></span>'))}</div>`;
}

/** Progress bar with role=progressbar; value null/undefined renders an indeterminate bar. */
export function progress({ value, max = 100, label, valueText } = {}) {
  const limit = Number(max) > 0 ? Number(max) : 100;
  const known = value !== null && value !== undefined && Number.isFinite(Number(value));
  const current = known ? Math.min(limit, Math.max(0, Number(value))) : null;
  const state = {
    role: 'progressbar', 'aria-label': label || null, 'aria-valuemin': '0', 'aria-valuemax': String(limit),
    'aria-valuenow': known ? String(current) : null, 'aria-valuetext': valueText || null,
    'data-state': known ? null : 'indeterminate',
    style: known ? `--ui-progress:${Math.round(current / limit * 1000) / 10}%` : null
  };
  return h`<div class="ui-progress"${attributes(state)}><span class="ui-progress__bar"></span></div>`;
}

const applePlatform = () => /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
const KEY_NAMES = { mod: ['⌘', 'Ctrl'], alt: ['⌥', 'Alt'], shift: ['⇧', 'Shift'], ctrl: ['⌃', 'Ctrl'], enter: ['↵', 'Enter'], escape: ['Esc', 'Esc'], esc: ['Esc', 'Esc'] };
const keyList = keys => (Array.isArray(keys) ? keys : String(keys ?? '').split('+')).map(key => String(key).trim()).filter(Boolean);
/** Shortcut as shown to people: "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function keyText(keys, apple = applePlatform()) {
  const names = keyList(keys).map(key => KEY_NAMES[key.toLowerCase()]?.[apple ? 0 : 1] ?? (key.length === 1 ? key.toUpperCase() : key));
  return names.join(apple ? '' : ' ');
}
const ariaShortcut = (keys, apple = applePlatform()) => keyList(keys).map(key => key.toLowerCase() === 'mod' ? (apple ? 'Meta' : 'Control') : key.length === 1 ? key.toUpperCase() : key).join('+');

/** Keyboard shortcut chip (<kbd class="ui-kbd">), ⌘ or Ctrl by platform. */
export function kbd(keys) {
  return h`<kbd class="ui-kbd">${keyText(keys)}</kbd>`;
}

/** Code block: focusable <pre> plus a Copy button. Never pass a real secret here (§5.3.3). */
export function codeBlock({ code = '', language, copyLabel, label } = {}) {
  return h`<div class="ui-code"><pre class="ui-code__pre" tabindex="0"${attributes({ 'data-language': language || null, 'aria-label': label || t('Trecho de código') })}><code>${code}</code></pre>${button({ label: copyLabel || t('Copiar'), icon: 'copy', variant: 'ghost', size: 'sm', className: 'ui-code__copy', attrs: { 'data-ui-copy': 'code' } })}</div>`;
}

/** Copy lines for the Brand screen from deriveBrandTokens(hex).report (§3.3 step 11). */
export function brandReportLines(report) {
  if (!report) return [];
  // A passing ratio is rounded; a failing one is floored so it never reads as 4,5 while below it.
  const passes = report.whiteContrast >= 4.5, shown = (passes ? Math.round : Math.floor)(report.whiteContrast * 10) / 10;
  const ratio = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(shown);
  const lines = [passes ? t('Texto branco sobre sua cor: {ratio}:1 ✓', { ratio }) : t('Texto branco sobre sua cor: {ratio}:1, abaixo do mínimo de leitura', { ratio })];
  if (report.onAccent === 'ink') lines.push(t('Usaremos texto escuro nos botões'));
  if (report.adjusted) lines.push(t('Ajustamos o tom do botão para manter a leitura'));
  if (report.edge) lines.push(t('Os botões ganham um contorno para continuar visíveis no fundo claro'));
  if (report.agentHue === 'alt') lines.push(t('Os agentes usam verde-azulado para não se confundir com a sua cor'));
  return lines;
}

/**
 * Toasts in the two live regions of index.html: #toast (role=status) for success/info, which hides
 * after 4 s and pauses on hover or focus, and #toast-alert (role=alert) for errors, which stay until
 * dismissed. At most 3 are stacked: the oldest status toast leaves first, then the oldest error.
 * An identical toast already visible is replaced by the new one (announced again, never stacked).
 */
export function createToasts({ document: doc, timeout = 4000, max = 3, timers = globalThis } = {}) {
  const items = [];
  let sequence = 0;
  const root = () => doc || globalThis.document;
  const region = tone => root()?.getElementById?.(tone === 'error' ? 'toast-alert' : 'toast') || null;
  // Injected timers may bring their own clock (tests); the page uses Date.now.
  const now = () => typeof timers.now === 'function' ? timers.now() : Date.now();

  function schedule(item) {
    if (item.tone === 'error' || item.paused) return;
    timers.clearTimeout(item.timer);
    item.started = now();
    item.timer = timers.setTimeout(() => dismiss(item.id), item.remaining);
  }
  function pause(item) {
    if (item.tone === 'error' || item.paused) return;
    item.paused = true;
    timers.clearTimeout(item.timer);
    item.remaining = Math.max(1000, item.remaining - (now() - item.started));
  }
  function resume(item) {
    if (!item.paused || item.element.matches?.(':hover') || item.element.contains?.(root().activeElement)) return;
    item.paused = false;
    schedule(item);
  }

  function show({ message, tone = 'info', action, duration } = {}) {
    const text = String(message ?? '').trim(), kind = pick(tone, ['success', 'info', 'error'], 'info');
    const host = region(kind), d = root();
    if (!text || !host || !d?.createElement) return null;
    const existing = items.find(item => item.tone === kind && item.text === text);
    if (existing) dismiss(existing.id, { immediate: true });
    while (items.length >= Math.max(1, max)) dismiss((items.find(item => item.tone !== 'error') || items[0]).id, { immediate: true });
    const id = `toast-${++sequence}`, element = d.createElement('div');
    element.className = `ui-toast ui-toast--${kind}`;
    element.dataset.toastId = id;
    if (kind === 'error') element.insertAdjacentHTML('beforeend', String(h`<span class="ui-toast__icon" aria-hidden="true">${glyph('warning')}</span>`));
    const body = d.createElement('p');
    body.className = 'ui-toast__message';
    body.textContent = text;
    element.append(body);
    const item = { id, tone: kind, text, element, action: Boolean(action), timer: null, paused: false, duration: Math.max(1000, Number(duration) || timeout) };
    item.remaining = item.duration;
    if (action?.label) {
      const control = d.createElement('button');
      control.type = 'button';
      control.className = 'ui-btn ui-btn--link ui-btn--sm ui-toast__action';
      control.textContent = action.label;
      control.addEventListener('click', () => { dismiss(id); action.onSelect?.(); });
      element.append(control);
    }
    const close = d.createElement('button');
    close.type = 'button';
    close.className = 'ui-iconbtn ui-iconbtn--sm ui-toast__close';
    close.setAttribute('aria-label', t('Dispensar notificação'));
    close.setAttribute('title', t('Dispensar notificação'));
    close.insertAdjacentHTML('beforeend', String(glyph('close')));
    close.addEventListener('click', () => dismiss(id));
    element.append(close);
    for (const name of ['pointerenter', 'focusin']) element.addEventListener(name, () => pause(item));
    element.addEventListener('pointerleave', () => resume(item));
    element.addEventListener('focusout', () => timers.setTimeout(() => resume(item), 0));
    items.push(item);
    host.append(element);
    schedule(item);
    return id;
  }

  function dismiss(id, { immediate = false } = {}) {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [item] = items.splice(index, 1);
    timers.clearTimeout(item.timer);
    const d = root();
    if (item.element.contains?.(d?.activeElement)) d.getElementById?.('main-content')?.focus?.({ preventScroll: true });
    if (immediate || !motionOK()) item.element.remove();
    else {
      item.element.dataset.state = 'leaving';
      timers.setTimeout(() => item.element.remove(), 200);
    }
    return true;
  }

  function clear() { for (const item of [...items]) dismiss(item.id, { immediate: true }); }

  return { show, dismiss, clear, get items() { return items.map(({ id, tone, text }) => ({ id, tone, text })); } };
}

/** The panel's toast stack (regions #toast and #toast-alert of index.html). */
export const toasts = createToasts();

function guardDisabledTab(event) {
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
  const tab = event.target?.closest?.('.ui-tabs [role="tab"]');
  if (!tab || !tab.matches('[disabled], [aria-disabled="true"]')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function moveTab(event) {
  const tab = event.target?.closest?.('.ui-tabs [role="tab"]');
  if (!tab || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const list = [...tab.closest('.ui-tabs').querySelectorAll('[role="tab"]:not([disabled]):not([aria-disabled="true"])')];
  const index = list.indexOf(tab);
  if (index < 0 || !list.length) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
  event.preventDefault();
  list[next].focus();
}

function syncSegment(event) {
  const input = event.target;
  if (!input?.classList?.contains('ui-seg__input')) return;
  const group = input.closest('.ui-seg'), inputs = [...group.querySelectorAll('.ui-seg__input')];
  group.style.setProperty('--seg-index', String(Math.max(0, inputs.indexOf(input))));
  group.removeAttribute('data-state');
}

async function copyCode(control, ownToasts) {
  const text = control.closest('.ui-code')?.querySelector('pre')?.textContent ?? '';
  try {
    await globalThis.navigator.clipboard.writeText(text);
    ownToasts.show({ message: t('Copiado.'), tone: 'success' });
  } catch {
    ownToasts.show({ message: t('Não foi possível copiar. Selecione o texto e copie manualmente.'), tone: 'error' });
  }
}

function clickHandler(ownToasts) {
  return event => {
    const copy = event.target?.closest?.('[data-ui-copy]');
    if (copy) { event.preventDefault(); void copyCode(copy, ownToasts); return; }
    const dismiss = event.target?.closest?.('[data-ui-dismiss="banner"]');
    if (dismiss) { event.preventDefault(); dismiss.closest('.ui-banner')?.remove(); }
  };
}

const installed = new WeakSet();
/** Delegated behaviour of the components (tab arrows, segmented indicator, copy, dismiss). Idempotent. */
export function installUI(doc = globalThis.document, { toasts: ownToasts = toasts } = {}) {
  if (!doc?.addEventListener || installed.has(doc)) return false;
  installed.add(doc);
  doc.addEventListener('keydown', moveTab);
  doc.addEventListener('change', syncSegment);
  doc.addEventListener('click', clickHandler(ownToasts));
  // Capture runs before bubble delegation regardless of listener registration order.
  doc.addEventListener('click', guardDisabledTab, true);
  doc.addEventListener('keydown', guardDisabledTab, true);
  return true;
}
