import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';

// Layout changes do not rebuild the conversation: media nodes, drafts and
// scroll positions belong to the existing DOM and stay in place.
export function createChatLayout({ document: doc = document, storage, icon, onConversations = () => {} } = {}) {
  let collapsed = false, expanded = false;
  const panels = createPanelSizing(doc, storage);
  try { collapsed = storage?.getItem('elozi-sidebar-collapsed') === 'true'; } catch {}
  const labels = () => ({ sidebar: collapsed ? i18nText('Expandir menu lateral') : i18nText('Recolher menu lateral'), chat: expanded ? i18nText('Voltar ao painel') : i18nText('Expandir chat') });
  function sync() {
    const shell = doc.querySelector('.app-shell');
    if (!shell) { expanded = false; return; }
    if (shell.dataset.view !== 'inbox' || !doc.querySelector('[data-layout-action="expand"]')) expanded = false;
    shell.classList.toggle('sidebar-collapsed', collapsed);
    shell.classList.toggle('chat-expanded', expanded);
    for (const button of doc.querySelectorAll('[data-layout-action="sidebar"]')) {
      button.setAttribute('aria-label', labels().sidebar);
      button.setAttribute('title', labels().sidebar);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.innerHTML = icon(collapsed ? 'sidebar-open' : 'sidebar-close');
    }
    for (const button of doc.querySelectorAll('[data-layout-action="expand"]')) {
      button.setAttribute('aria-label', labels().chat);
      button.setAttribute('title', expanded ? i18nText('Voltar ao painel (Esc)') : i18nText('Expandir chat'));
      button.setAttribute('aria-expanded', String(expanded));
      button.innerHTML = icon(expanded ? 'minimize' : 'maximize') + `<span class="chat-layout-button-label">${labels().chat}</span>`;
    }
    for (const button of doc.querySelectorAll('[data-layout-action="conversations"]')) button.hidden = !expanded;
    // On mobile a hidden browser menu must remain inert even after layout sync.
    const sidebar = doc.querySelector('#sidebar');
    if (expanded) sidebar?.setAttribute('inert', '');
    else if (sidebar && !sidebar.classList.contains('mobile-open') && typeof matchMedia !== 'undefined' && matchMedia('(max-width:760px)').matches) sidebar.setAttribute('inert', '');
    else sidebar?.removeAttribute('inert');
    panels.sync(shell);
  }
  function toggleSidebar() {
    collapsed = !collapsed;
    try { storage?.setItem('elozi-sidebar-collapsed', String(collapsed)); } catch {}
    sync();
  }
  function expand(value = !expanded) {
    expanded = Boolean(value);
    sync();
    const button = doc.querySelector('[data-layout-action="expand"]');
    const target = button?.getClientRects?.().length === 0 ? doc.querySelector('#conversation-search') : button;
    target?.focus({ preventScroll: true });
  }
  function escape(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !expanded || doc.querySelector('dialog[open]')) return false;
    event.preventDefault(); expand(false); return true;
  }
  function conversations() { expand(false); onConversations(); }
  return { sync, toggleSidebar, expand, escape, conversations, get collapsed() { return collapsed; }, get expanded() { return expanded; }, reset() { expanded = false; sync(); } };
}

// Only anonymous pixel preferences are retained. No conversation or draft data
// belongs to layout storage, and resizing never replaces existing content nodes.
function createPanelSizing(doc, storage) {
  const key = 'elozi-chat-panel-widths', view = doc.defaultView;
  const preferences = {};
  let workspace, shell, resizeObserver, classObserver, drag;
  const handles = {};
  // FRONTEND-V2 §3.6: list 340 (280–480) and context 340 (300–440), from 900 px.
  const ranges = { list: [280, 480], context: [300, 440] };
  try {
    const saved = JSON.parse(storage?.getItem(key) || '{}');
    for (const name of Object.keys(ranges)) {
      const value = saved?.[name], [min, max] = ranges[name];
      if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) preferences[name] = Math.round(value);
    }
  } catch {}
  function metrics() {
    if (!workspace || doc.querySelector('.inbox-workspace') !== workspace || shell.dataset.view !== 'inbox' || !view?.getComputedStyle) return null;
    const list = workspace.querySelector('.pg-inbox__list'), context = workspace.querySelector('.pg-inbox__context');
    const visible = element => element && view.getComputedStyle(element).display !== 'none';
    const desktop = !view.matchMedia('(max-width: 899.98px)').matches;
    const listVisible = desktop && !shell.classList.contains('chat-expanded') && visible(list);
    const contextVisible = desktop && !workspace.classList.contains('context-collapsed') && workspace.dataset?.context !== 'closed' && visible(context) && !['absolute', 'fixed'].includes(view.getComputedStyle(context).position);
    return { width: workspace.clientWidth, list: listVisible ? list.getBoundingClientRect().width : 0,
      context: contextVisible ? context.getBoundingClientRect().width : 0, listVisible, contextVisible,
      chatMin: shell.classList.contains('chat-expanded') ? 520 : 240 };
  }
  function limits(name, current) {
    const [min, max] = ranges[name], other = name === 'list' ? current.context : current.list;
    return { min, max: Math.min(max, Math.floor(current.width - other - current.chatMin)) };
  }
  function apply(name, value) {
    const current = metrics();
    if (!current?.[`${name}Visible`]) return false;
    const range = limits(name, current);
    if (range.max < range.min) return false;
    const width = Math.round(Math.max(range.min, Math.min(range.max, value)));
    workspace.style.setProperty(`--attendance-${name}-width`, `${width}px`);
    if (name === 'context') workspace.style.setProperty('--elozi-context-width', `${width}px`);
    return width;
  }
  function save() { try { storage?.setItem(key, JSON.stringify(preferences)); } catch {} }
  function finish(commit) {
    if (!drag) return;
    const previous = drag; drag = null;
    workspace?.classList.remove('panels-resizing');
    if (!commit) {
      if (previous.preference === undefined) delete preferences[previous.name];
      else preferences[previous.name] = previous.preference;
      workspace?.style.removeProperty(`--attendance-${previous.name}-width`);
      if (previous.name === 'context') workspace?.style.removeProperty('--elozi-context-width');
    } else save();
    try { previous.handle.releasePointerCapture(previous.pointerId); } catch {}
  }
  function refresh() {
    let current = metrics();
    if (!current) { finish(false); return; }
    for (const name of ['context', 'list']) {
      if (preferences[name] !== undefined) apply(name, preferences[name]);
    }
    current = metrics();
    for (const name of Object.keys(handles)) {
      const handle = handles[name], range = limits(name, current);
      handle.hidden = !current[`${name}Visible`] || range.max < range.min;
      if (handle.hidden) {
        if (drag?.name === name) finish(false);
        continue;
      }
      handle.style.left = `${name === 'list' ? current.list : current.width - current.context}px`;
      handle.setAttribute('aria-valuemin', String(range.min));
      handle.setAttribute('aria-valuemax', String(range.max));
      handle.setAttribute('aria-valuenow', String(Math.round(current[name])));
      handle.setAttribute('aria-valuetext', `${Math.round(current[name])} pixels`);
    }
  }
  function restore(name) {
    delete preferences[name];
    workspace.style.removeProperty(`--attendance-${name}-width`);
    if (name === 'context') workspace.style.removeProperty('--elozi-context-width');
    save(); refresh();
  }
  function addHandle(name) {
    const handle = doc.createElement('div');
    handle.className = 'chat-panel-resizer'; handle.dataset.panel = name; handle.tabIndex = 0;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-controls', name === 'list' ? 'conversation-items' : 'conversation-context');
    handle.setAttribute('aria-label', name === 'list' ? i18nText('Ajustar largura da lista de conversas') : i18nText('Ajustar largura do contexto'));
    handle.title = i18nText('Arraste ou use as setas. Enter restaura a largura padrão.');
    const active = () => handles[name] === handle && !handle.hidden && metrics()?.[`${name}Visible`];
    handle.addEventListener('pointerdown', event => {
      const current = metrics();
      if (drag || !active() || event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault(); handle.focus({ preventScroll: true });
      drag = { name, handle, pointerId: event.pointerId, x: event.clientX, width: current[name], preference: preferences[name] };
      workspace.classList.add('panels-resizing');
      try { handle.setPointerCapture(event.pointerId); } catch { finish(false); }
    });
    handle.addEventListener('pointermove', event => {
      if (drag?.handle !== handle || drag.pointerId !== event.pointerId) return;
      const current = metrics();
      if (!current?.[`${name}Visible`] || handle.hidden) { finish(false); refresh(); return; }
      const value = apply(name, drag.width + (event.clientX - drag.x) * (name === 'list' ? 1 : -1));
      if (value !== false) preferences[name] = value;
      refresh();
    });
    handle.addEventListener('pointerup', event => { if (drag?.handle === handle && drag.pointerId === event.pointerId) { finish(true); refresh(); } });
    for (const type of ['pointercancel', 'lostpointercapture']) handle.addEventListener(type, event => { if (drag?.handle === handle && drag.pointerId === event.pointerId) { finish(false); refresh(); } });
    handle.addEventListener('dblclick', () => { if (active()) { finish(false); restore(name); } });
    handle.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || !active()) return;
      if (event.key === 'Escape' && drag?.handle === handle) { event.preventDefault(); finish(false); refresh(); return; }
      if (drag) return;
      const current = metrics();
      if (!current?.[`${name}Visible`]) return;
      if (event.key === 'Enter') { event.preventDefault(); restore(name); return; }
      const range = limits(name, current), step = event.shiftKey ? 40 : 10;
      const delta = (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0) * (name === 'list' ? 1 : -1);
      const value = event.key === 'Home' ? range.min : event.key === 'End' ? range.max : delta ? current[name] + delta * step : null;
      if (value === null || range.max < range.min) return;
      event.preventDefault();
      const width = apply(name, value);
      if (width !== false) { preferences[name] = width; save(); refresh(); }
    });
    workspace.append(handle); handles[name] = handle;
  }
  return { sync(nextShell) {
    const nextWorkspace = nextShell.dataset.view === 'inbox' ? doc.querySelector('.inbox-workspace') : null;
    if (!doc.createElement || !view?.getComputedStyle) return;
    if (workspace !== nextWorkspace) {
      finish(false); resizeObserver?.disconnect(); classObserver?.disconnect();
      workspace = nextWorkspace; shell = nextShell;
      delete handles.list; delete handles.context;
      if (!workspace) return;
      workspace.dataset.panelLayout = '';
      addHandle('list'); addHandle('context');
      if (view.ResizeObserver) { resizeObserver = new view.ResizeObserver(refresh); resizeObserver.observe(workspace); }
      if (view.MutationObserver) {
        classObserver = new view.MutationObserver(refresh);
        classObserver.observe(workspace, { attributes: true, attributeFilter: ['class', 'data-context'] });
        classObserver.observe(shell, { attributes: true, attributeFilter: ['class'] });
      }
    }
    refresh();
  } };
}
