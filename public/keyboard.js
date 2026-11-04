// Keyboard map (FRONTEND-V2 §2.6, §8.3 P2). Scopes: global, list, conversation and composer.
//
// - Single-key shortcuts only work outside editable fields and can be switched off by the person
//   (WCAG 2.1.4): the "?" sheet holds the switch, kept in elozi:prefs:<userId> (singleKey).
// - Esc goes up one level (composer → conversation → list) and never drops the focus on <body>.
// - Keys never registered by the product (static test): Tab as an action, Ctrl+J, Ctrl+Shift+D,
//   Ctrl+Shift+O, Ctrl+T/W/N/L/H/D and Alt+letter. Approving or rejecting a tool never has a key:
//   Shift+A only moves the focus to the pending approval.
// - The default bindings act on the controls that are on screen (a hidden or disabled control does
//   nothing), so a key never reaches an action the server does not offer this person. The inbox
//   owner (P3) may replace the list, conversation and composer scopes with registerScope().
// - Ctrl/⌘K stays with the command palette (command-palette.js) and Ctrl/⌘+Enter with the composer.
import { h, t } from './i18n.js';
import './locales-live.js';
import { kbd } from './ui.js';
import { dispatchAction, registerAction } from './actions.js';
import { prefsKey } from './theme-prefs.js';
import { liveContext, liveDrawer, liveRegistry } from './live.js';
import { notifyControls } from './notify.js';

const MOD = 'mod';
const LETTERS = /^[a-z]$/;
/** Combinations the product never registers (§2.6). */
export const FORBIDDEN_KEYS = Object.freeze(['tab', 'mod+j', 'mod+shift+d', 'mod+shift+o', 'mod+t', 'mod+w', 'mod+n', 'mod+l', 'mod+h', 'mod+d']);

/** Normalizes 'Shift+A', 'Ctrl+K', '⌘K', 'g o' → 'shift+a', 'mod+k', 'g o' (sequences keep their spaces). */
export function normalizeCombo(combo) {
  return String(combo ?? '').trim().split(/\s+/).map(step => {
    const parts = step.split('+').map(part => part.trim().toLowerCase()).filter(Boolean);
    const key = parts.pop() || '';
    const mods = new Set(parts.map(part => ['ctrl', 'control', 'meta', 'cmd', '⌘', MOD].includes(part) ? MOD : part === 'option' ? 'alt' : part));
    return [...['mod', 'alt', 'shift'].filter(name => mods.has(name)), key === ' ' ? 'space' : key].join('+');
  }).join(' ');
}
/** True for a combination of the forbidden list, Tab as an action or any Alt+letter. */
export function isForbiddenCombo(combo) {
  return normalizeCombo(combo).split(' ').some(step => FORBIDDEN_KEYS.includes(step) || step.endsWith('+tab') || /(?:^|\+)alt\+[a-z]$/.test(step) && LETTERS.test(step.slice(-1)));
}
/** Combination of a keydown event ('mod+shift+d', 'shift+a', '?', 'arrowdown'). */
export function eventCombo(event) {
  const raw = String(event?.key ?? ''), key = raw.length === 1 ? raw.toLowerCase() : raw.toLowerCase();
  const mods = [];
  if (event?.ctrlKey || event?.metaKey) mods.push(MOD);
  if (event?.altKey) mods.push('alt');
  // Shift is part of the character for symbols ('?', '!'); for letters and named keys it is a modifier.
  if (event?.shiftKey && (LETTERS.test(key) || raw.length > 1)) mods.push('shift');
  return [...mods, key === ' ' ? 'space' : key].join('+');
}
const editable = target => Boolean(target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || target?.isContentEditable);
const visibleControl = node => node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' && !node.closest?.('[hidden], [inert]') && node.getClientRects?.().length !== 0;

/** createKeyboard() → {registerScope, setScope, singleKeyEnabled, setSingleKey, install, openSheet, scope}. */
export function createKeyboard({ storage, registry = liveRegistry } = {}) {
  const scopes = new Map();
  let current = 'global', doc = null, pending = null, pendingTimer = null;
  const store = () => { if (storage !== undefined) return storage; try { return globalThis.localStorage; } catch { return null; } };
  const userId = () => liveContext(registry).userId || '';
  const prefs = () => { try { const value = JSON.parse(store()?.getItem(prefsKey(userId())) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };

  /** Declares the bindings of a scope ({combo: handler | {run, label}}); throws on a forbidden key. */
  function registerScope(name, bindings = {}) {
    const scope = String(name || '');
    if (!scope) throw new TypeError('registerScope needs a name');
    const table = new Map();
    for (const [combo, binding] of Object.entries(bindings || {})) {
      if (isForbiddenCombo(combo)) throw new TypeError(`Tecla proibida no produto: ${combo}`);
      const run = typeof binding === 'function' ? binding : binding?.run;
      if (typeof run !== 'function') throw new TypeError(`Atalho sem ação: ${combo}`);
      table.set(normalizeCombo(combo), { run, label: binding?.label || '' });
    }
    scopes.set(scope, table);
    return () => { if (scopes.get(scope) === table) scopes.delete(scope); };
  }
  /** The screen in use (app.js passes the view after every render); installs the listener once. */
  function setScope(name) {
    current = String(name || 'global');
    if (globalThis.document) install(globalThis.document);
    return current;
  }
  /** Single-key shortcuts are on: the map listens on this page and the person did not switch them off. */
  function singleKeyEnabled() { return Boolean(doc) && prefs().singleKey !== false; }
  function setSingleKey(value) {
    const id = userId();
    if (!id) return false;
    try { store()?.setItem(prefsKey(id), JSON.stringify({ ...prefs(), singleKey: Boolean(value) })); return true; } catch { return false; }
  }

  // The screen's own scope (registered by its owner under the view name, e.g. 'inbox') comes before
  // the generic list/conversation defaults of this module, which only fill the keys it leaves free.
  function activeScopes(target) {
    const list = [];
    if (target?.closest?.('#message-text, #internal-note-text')) list.push('composer');
    list.push(current);
    if (current === 'inbox') {
      if (target?.closest?.('#conversation-items, .conversation-list, [data-inbox-list]')) list.push('list');
      else if (doc?.getElementById?.('messages')) list.push('conversation', 'list');
      else list.push('list');
    }
    list.push('global');
    return [...new Set(list)];
  }
  function lookup(combo, target) {
    const found = [];
    for (const name of activeScopes(target)) { const binding = scopes.get(name)?.get(combo); if (binding) found.push(binding); }
    return found;
  }
  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.repeat && !/^arrow/.test(String(event.key).toLowerCase())) return;
    if (doc?.querySelector?.('dialog[open]:not(.lv-drawer)')) return;
    // Inside an open shadow root (the webchat widget mounted on the visitor test page) event.target is the shadow host;
    // the field that really has the focus is the first node of the composed path, so typing "?" there stays text.
    const origin = typeof event.composedPath === 'function' ? event.composedPath()[0] || event.target : event.target;
    const combo = eventCombo(event), target = event.target, typing = editable(target) || origin !== target && editable(origin);
    const single = !combo.includes(`${MOD}+`) && !combo.includes('alt+') && combo !== 'escape';
    if (single && (typing || !singleKeyEnabled())) { pending = null; return; }
    if (typing && combo !== 'escape' && !combo.startsWith(`${MOD}+`)) return;
    const sequence = pending ? `${pending} ${combo}` : combo;
    clearTimeout(pendingTimer); pending = null;
    let bindings = lookup(sequence, target);
    if (!bindings.length && sequence !== combo) bindings = lookup(combo, target);
    if (!bindings.length) {
      if ([...activeScopes(target)].some(name => [...(scopes.get(name)?.keys() || [])].some(key => key.startsWith(`${combo} `)))) {
        pending = combo; pendingTimer = setTimeout(() => { pending = null; }, 1500); event.preventDefault();
      }
      return;
    }
    // A binding that answers false (nothing to do here) hands the key to the next scope.
    for (const binding of bindings) {
      let handled = false;
      try { handled = binding.run({ event, target, doc }); } catch { handled = false; }
      if (handled !== false) { event.preventDefault(); return; }
    }
  }
  /** Listens on the page once (setScope does it after the first render). */
  function install(target = globalThis.document) {
    if (!target?.addEventListener || doc === target) return false;
    doc = target;
    target.addEventListener('keydown', keydown);
    registerAction('shell:shortcuts', ({ element }) => { openSheet(element); });
    registerAction('keys:toggle-single', ({ element }) => { setSingleKey(!(prefs().singleKey !== false)); refreshSheet(); element?.focus?.(); });
    for (const name of ['sound', 'desktop', 'preview']) registerAction(`keys:notify-${name}`, async () => {
      const controls = notifyControls();
      if (!controls) return;
      const value = controls.prefs()[name];
      if (value) controls.disable({ [name]: false }); else await controls.enable({ [name]: true });
      refreshSheet();
    });
    return true;
  }

  // ---- "?" sheet: every shortcut of this version, by scope, and the preferences that go with them ----
  const sheet = () => doc ? liveDrawer('shortcuts', { doc }) : null;
  function rows() {
    const row = (keys, label) => h`<li class="lv-keys__row"><span class="lv-keys__keys">${keys}</span><span class="lv-keys__label">${label}</span></li>`;
    const then = (first, second) => h`${kbd(first)} <span class="lv-keys__then">${t('depois')}</span> ${kbd(second)}`;
    return [
      { title: t('Em qualquer tela'), items: [row(kbd('mod+k'), t('Buscar ou executar (paleta de comandos)')), row(kbd('?'), t('Mostrar esta lista')), row(kbd('['), t('Recolher ou expandir o menu lateral')),
        row(then('g', 'o'), t('Visão geral')), row(then('g', 'i'), t('Atendimento')), row(then('g', 'c'), t('Contatos')), row(then('g', 'a'), t('Agentes')),
        row(then('g', 'p'), t('Pendências')), row(then('g', 'e'), t('Equipe')), row(then('g', 's'), t('Configurações')), row(kbd('escape'), t('Fechar ou subir um nível'))] },
      { title: t('Lista de conversas'), items: [row([kbd('j'), ' ', kbd('k')], t('Mover o foco sem abrir')), row([kbd('enter'), ' ', kbd('o')], t('Abrir a conversa em foco')), row(kbd('/'), t('Buscar na lista')),
        row([kbd('1'), '–', kbd('4')], t('Todos, Comigo, Fila e Agentes')), row(kbd('u'), t('Só não lidas'))] },
      { title: t('Conversa aberta'), items: [row(kbd('r'), t('Escrever a resposta')), row(kbd('n'), t('Nota interna')), row(kbd('a'), t('Assumir')), row(kbd('t'), t('Transferir')), row(kbd('e'), t('Encerrar')),
        row(kbd('i'), t('Painel de contexto')), row(kbd('c'), t('Gerar rascunho com o agente')), row(kbd('d'), t('Inserir o rascunho pronto')), row(kbd('shift+a'), t('Ir até a aprovação pendente (aprovar exige clique)'))] },
      { title: t('Compositor'), items: [row(kbd('mod+enter'), t('Enviar a resposta ou salvar a nota')), row(kbd('/'), t('No início do texto, respostas rápidas')), row(kbd('escape'), t('Sair do compositor'))] }
    ];
  }
  function switchMarkup(action, label, on, note = '') {
    return h`<li class="lv-keys__pref"><button type="button" class="lv-switch" role="switch" aria-checked="${on ? 'true' : 'false'}" data-action="${action}" data-focus-key="${action}"><span class="lv-switch__track" aria-hidden="true"><span class="lv-switch__thumb"></span></span><span class="lv-switch__label">${label}</span></button>${note ? h`<small class="lv-keys__note">${note}</small>` : ''}</li>`;
  }
  function sheetMarkup() {
    const single = prefs().singleKey !== false, controls = notifyControls(), notifyPrefs = controls?.prefs?.() || null;
    const Notifier = globalThis.Notification, denied = Notifier?.permission === 'denied';
    const notifications = notifyPrefs ? h`${switchMarkup('keys:notify-sound', t('Som ao chegar algo novo'), notifyPrefs.sound)}${switchMarkup('keys:notify-desktop', t('Avisos do navegador com a aba em segundo plano'), notifyPrefs.desktop, denied ? t('O navegador bloqueou os avisos deste endereço. Libere nas configurações do site.') : !Notifier ? t('Este navegador não oferece avisos.') : '')}${switchMarkup('keys:notify-preview', t('Mostrar o nome do agente no aviso'), notifyPrefs.preview, t('Textos de clientes nunca aparecem nos avisos.'))}` : '';
    return h`<div class="lv-keys">${rows().map(group => h`<section class="lv-keys__group"><h3 class="lv-keys__title">${group.title}</h3><ul class="lv-keys__list">${group.items}</ul></section>`)}
      <section class="lv-keys__group"><h3 class="lv-keys__title">${t('Preferências')}</h3><ul class="lv-keys__list">${switchMarkup('keys:toggle-single', t('Atalhos de uma tecla'), single, single ? '' : t('Desligados: só valem os atalhos com Ctrl ou ⌘ e o Esc.'))}${notifications}</ul></section></div>`;
  }
  function openSheet(trigger) {
    const panel = sheet();
    if (!panel) return false;
    panel.open({ title: t('Atalhos do teclado'), body: sheetMarkup(), trigger });
    return true;
  }
  function refreshSheet() { const panel = sheet(); if (panel?.isOpen) panel.update(sheetMarkup()); }

  return { registerScope, setScope, singleKeyEnabled, setSingleKey, install, openSheet, keydown, get scope() { return current; }, scopes: () => [...scopes.keys()],
    /** [combo, run] of a scope (the sheet and the tests read the map from here). */
    bindings: name => [...(scopes.get(String(name)) || new Map())].map(([combo, binding]) => [combo, binding.run]) };
}

// ---- Default bindings over the controls on screen ----
const click = selector => ({ doc }) => {
  const node = [...(doc?.querySelectorAll?.(selector) || [])].find(visibleControl);
  if (!node) return false;
  node.click();
  return true;
};
const focus = selector => ({ doc }) => {
  const node = [...(doc?.querySelectorAll?.(selector) || [])].find(visibleControl);
  if (!node) return false;
  node.focus({ preventScroll: false });
  return true;
};
const ROWS = '#conversation-items [data-conversation], [data-inbox-list] [role="option"]';
// Shift+A reaches the title of the pending approval (tabindex=-1, agent-rail-ui.js), never one of its
// buttons: Enter right after it decides nothing (FRONTEND-V2 §2.6, approving takes a click).
export const APPROVAL_FOCUS = '.ui-approval__title[tabindex]';
const moveRow = step => ({ doc, target }) => {
  const rows = [...(doc?.querySelectorAll?.(ROWS) || [])].filter(visibleControl);
  if (!rows.length) return false;
  const index = rows.indexOf(target?.closest?.(ROWS));
  const next = rows[index < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + step))];
  next.focus({ preventScroll: false });
  next.scrollIntoView?.({ block: 'nearest' });
  return true;
};
const openRow = ({ target }) => { const row = target?.closest?.(ROWS); if (!row) return false; row.click(); return true; };
const go = href => click(`.sh-nav a[href^="${href}"], .sh-bottombar a[href^="${href}"], .sh-sheet a[href^="${href}"]`);
const shellAction = name => ({ doc }) => {
  const control = [...(doc?.querySelectorAll?.(`[data-action="${name}"]`) || [])].find(node => !node.closest?.('[hidden]'));
  if (!control) return false;
  void dispatchAction(name, control);
  return true;
};
const escapeUp = ({ doc, target }) => {
  if (target?.closest?.('#message-text, #internal-note-text')) { const messages = doc?.getElementById?.('messages') || doc?.getElementById?.('main-content'); if (!messages) return false; messages.tabIndex = -1; messages.focus({ preventScroll: true }); return true; }
  if (target?.closest?.('#messages')) { const row = doc?.querySelector?.('#conversation-items .selected, #conversation-items [aria-current="true"]') || doc?.querySelector?.(ROWS); if (!row) return false; row.focus({ preventScroll: true }); return true; }
  return false;
};

/** The panel's keyboard map. */
export const keyboard = createKeyboard();
keyboard.registerScope('global', {
  '?': ({ doc }) => keyboard.openSheet(doc?.activeElement),
  '[': click('.sh-topbar__rail'),
  'g o': go('#overview'), 'g i': go('#inbox'), 'g c': go('#contacts'), 'g a': go('#agents'), 'g s': go('#settings'),
  'g p': shellAction('shell:pending'), 'g e': shellAction('shell:team')
});
keyboard.registerScope('list', {
  j: moveRow(1), arrowdown: { run: context => context.target?.closest?.(ROWS) ? moveRow(1)(context) : false }, k: moveRow(-1), arrowup: { run: context => context.target?.closest?.(ROWS) ? moveRow(-1)(context) : false },
  o: openRow, '/': focus('#conversation-search'),
  1: click('[data-filter="all"]'), 2: click('[data-filter="mine"]'), 3: click('[data-filter="queue"]'), 4: click('[data-filter="agent"]'),
  u: click('#unread-filter')
});
keyboard.registerScope('conversation', {
  r: focus('#message-text'), n: click('[data-composer-mode="note"]'), a: click('[data-action="takeover"]'), t: click('[data-action="transfer-conversation"]'),
  e: click('[data-action="conversation-close"]'), i: click('[data-action="toggle-context"], [data-action="show-context"]'), c: click('[data-action="run-agent"]'),
  d: click('[data-action="use-run-draft"]'), 'shift+a': focus(APPROVAL_FOCUS), escape: escapeUp
});
keyboard.registerScope('composer', { escape: escapeUp });
