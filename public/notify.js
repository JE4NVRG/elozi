// Notifications (FRONTEND-V2 §5.1, §7.3, §8.3 P2): the counters of the shell patched in place (menu,
// bottom bar, bell, Equipe), "(n)" in the title and the dot of the favicon — all from the single
// "não lidas para mim" number of attention.js — plus sound and desktop notifications.
//
// - Sound (WebAudio, two 250 ms tones, no file) and the Notification API only after the person opts
//   in (preferences sheet, or the banner shown after the first event missed with the tab hidden; the
//   gesture also unlocks the AudioContext). Only the leader tab plays, at most once per conversation
//   every 10 s, only with the tab hidden or away from the inbox, and never outside "Disponível".
// - No preview by default ("Nova mensagem"); a notification never carries customer text, one tag per
//   conversation, and the click focuses the tab and opens the deep link.
// - Preferences live in elozi:prefs:<userId> (shared with theme-prefs.js; writes merge the keys).
import { h, t } from './i18n.js';
import './locales-live.js';
import { banner } from './ui.js';
import { registerAction } from './actions.js';
import { conversationHash, hashForView } from './nav-config.js';
import { prefsKey } from './theme-prefs.js';
import { currentLive, liveContext, liveCount, liveRegistry, onLiveCount } from './live.js';

export const DEFAULT_NOTIFY_PREFS = Object.freeze({ sound: false, desktop: false, preview: false, prompted: false });
const SOUND_GAP = 10000;
const TONES = { queue: [660, 880], message: [880, 660], approval: [520, 780] };
const defaultStorage = () => { try { return globalThis.localStorage; } catch { return null; } };
function record(userId, storage) {
  try { const value = JSON.parse(storage?.getItem(prefsKey(userId)) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
/** Notification preferences of the person (booleans; everything off until the person opts in). */
export function readNotifyPrefs(userId, storage = defaultStorage()) {
  const value = record(userId, storage).notify || {};
  return Object.fromEntries(Object.keys(DEFAULT_NOTIFY_PREFS).map(key => [key, value[key] === true]));
}
/** Merges a patch into the notify key of the person's preferences; false when storage is blocked. */
export function saveNotifyPrefs(userId, patch, storage = defaultStorage()) {
  if (!userId) return false;
  try {
    const all = record(userId, storage), next = { ...readNotifyPrefs(userId, storage) };
    for (const key of Object.keys(DEFAULT_NOTIFY_PREFS)) if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
    storage.setItem(prefsKey(userId), JSON.stringify({ ...all, notify: next }));
    return true;
  } catch { return false; }
}

/** Title with "(n) " in front, n = não lidas para mim (99+ above 99); the prefix of a previous count leaves. */
export function titleWithCount(title, count) {
  const base = String(title ?? '').replace(/^\(\d+\+?\) /, '');
  return Number.isSafeInteger(count) && count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}

/** The changes of attention that deserve a sound or a notification (increases only). */
export function attentionEvents(previous, next) {
  const events = [];
  if (!previous || !next || previous.workspaceId && next.workspaceId && previous.workspaceId !== next.workspaceId) return events;
  const before = previous.unreadForMe?.total, after = next.unreadForMe?.total;
  if (Number.isSafeInteger(before) && Number.isSafeInteger(after) && after > before) events.push({ type: 'message', key: 'unread', count: after });
  const known = new Set((previous.approvals || []).map(item => item.runId || item.conversationId));
  if (Array.isArray(previous.approvals)) for (const item of next.approvals || []) if (!known.has(item.runId || item.conversationId)) events.push({ type: 'approval', key: item.conversationId, item });
  return events;
}

let active = null;
/** Controls of the notifications for the preferences sheet (keyboard.js); null before app.js creates them. */
export const notifyControls = () => active;

/**
 * createNotify({attention}) → {apply(doc), enabled(), prefs(), enable(patch), disable(patch), handle(events)}.
 * Audio, Notification, storage, document and window are injectable for tests.
 */
export function createNotify({ attention, registry = liveRegistry, storage = defaultStorage(), Notification: Notifier = globalThis.Notification, AudioContext: Audio = globalThis.AudioContext || globalThis.webkitAudioContext,
  window: win = globalThis.window, now = () => Date.now() } = {}) {
  let doc = null, audio = null, previous = null, missed = false, applied = false;
  const lastSound = new Map(), favicons = new Map(), messageNotifications = new Set();
  let notificationScope = '';
  const userId = () => liveContext(registry).userId || '';
  const prefs = () => readNotifyPrefs(userId(), storage);
  const leader = () => { const live = currentLive(registry); return !live || !live.state().coordinated || live.leader; };
  const presence = () => doc?.querySelector?.('.sh-account [data-presence]')?.getAttribute?.('data-presence') || 'available';
  const hidden = () => doc?.visibilityState === 'hidden';
  const scopeKey = () => { const context = liveContext(registry); return context.userId && context.workspaceId ? JSON.stringify([context.userId, context.workspaceId, context.supportGrantId || null]) : ''; };
  function closeMessages(matches) {
    for (const entry of messageNotifications) if (matches(entry)) {
      messageNotifications.delete(entry);
      try { entry.notification.close?.(); } catch {}
    }
  }
  function syncNotificationScope() {
    const next = scopeKey();
    if (next !== notificationScope) {
      closeMessages(entry => entry.scope !== next);
      previous = null; lastSound.clear(); notificationScope = next;
    }
    return next;
  }

  function counts() {
    const snapshot = attention?.snapshot?.() || {};
    return { inbox: snapshot.unreadForMe?.total ?? null, pending: attention?.pendingCount?.() ?? null, team: liveCount('team', registry) };
  }
  function patchCount(node, value) {
    const show = Number.isSafeInteger(value) && value > 0, label = show ? (value > 99 ? '99+' : String(value)) : '';
    if (node.textContent !== label) node.textContent = label;
    if (node.hidden !== !show) node.hidden = !show;
  }
  function patchLabels(value, selector, base, withCount) {
    for (const button of doc.querySelectorAll(selector)) {
      if (!button.hasAttribute('aria-label')) continue;
      const label = Number.isSafeInteger(value) && value > 0 ? withCount(value) : base;
      if (button.getAttribute('aria-label') !== label) { button.setAttribute('aria-label', label); button.setAttribute('title', label); }
    }
  }
  // Brand favicon of the shell with a --danger-solid dot drawn over it (cached per base image).
  function favicon(count) {
    const link = doc?.head?.querySelector?.('link[data-shell-favicon]');
    if (!link) return false;
    const href = link.getAttribute('href') || '';
    const base = [...favicons].find(([, dotted]) => dotted === href)?.[0] || href;
    if (!(count > 0)) { if (href !== base) link.setAttribute('href', base); return true; }
    if (favicons.has(base)) { if (href !== favicons.get(base)) link.setAttribute('href', favicons.get(base)); return true; }
    const canvas = doc.createElement?.('canvas'), context = canvas?.getContext?.('2d'), Img = win?.Image;
    if (!context || typeof Img !== 'function' || !/^data:image\//.test(base)) return false;
    const image = new Img();
    image.onload = () => {
      canvas.width = 64; canvas.height = 64;
      context.drawImage(image, 0, 0, 64, 64);
      context.beginPath(); context.arc(52, 12, 11, 0, Math.PI * 2);
      context.fillStyle = win.getComputedStyle?.(doc.documentElement)?.getPropertyValue?.('--danger-solid')?.trim() || 'red';
      context.fill();
      try { favicons.set(base, canvas.toDataURL('image/png')); } catch { return; }
      if (link.getAttribute('href') === base && (counts().inbox || 0) > 0) link.setAttribute('href', favicons.get(base));
    };
    image.src = base;
    return true;
  }
  function optInBanner() {
    const host = doc?.querySelector?.('[data-shell-slot="banners"]');
    if (!host) return;
    const current = host.querySelector('[data-banner="notify-optin"]');
    const show = missed && !hidden() && Notifier && Notifier.permission !== 'denied' && !prefs().desktop && !prefs().prompted;
    if (!show) { current?.remove(); return; }
    if (current) return;
    host.insertAdjacentHTML('beforeend', String(banner({ tone: 'info', title: t('Quer ser avisado com esta aba em segundo plano?'), body: t('Uma conversa chegou enquanto a aba estava oculta. Ative os avisos do navegador e o som; nenhum texto de cliente aparece no aviso.'),
      action: { label: t('Ativar avisos'), action: 'live:notify-enable' }, attrs: { 'data-banner': 'notify-optin' } })));
    host.querySelector('[data-banner="notify-optin"]')?.insertAdjacentHTML('beforeend', String(h`<button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-action="live:notify-dismiss"><span class="ui-btn__label">${t('Agora não')}</span></button>`));
  }

  /** Re-applies counters, title, favicon and the opt-in banner (after every render and each change). */
  function apply(target = globalThis.document) {
    if (!target?.querySelectorAll) return false;
    doc = target;
    syncNotificationScope();
    if (!applied) { applied = true; attention?.register?.(); register(); }
    const value = counts();
    for (const node of doc.querySelectorAll('[data-shell-count]')) patchCount(node, value[node.getAttribute('data-shell-count')] ?? null);
    patchLabels(value.pending, '[data-action="shell:pending"][aria-label]', t('Pendências'), n => t('Pendências: {count}', { count: n }));
    patchLabels(value.team, '[data-action="shell:team"][aria-label]', t('Equipe'), n => t('Equipe: {count} novas', { count: n }));
    const title = titleWithCount(doc.title, value.inbox);
    if (doc.title !== title) doc.title = title;
    favicon(value.inbox);
    optInBanner();
    return true;
  }

  function tone(type) {
    if (!audio) return false;
    try {
      if (audio.state === 'suspended') audio.resume?.();
      const [first, second] = TONES[type] || TONES.message, start = audio.currentTime;
      [first, second].forEach((frequency, index) => {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), at = start + index * 0.25;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(at); oscillator.stop(at + 0.25);
      });
      return true;
    } catch { return false; }
  }
  function desktop(event, settings) {
    if (!Notifier || Notifier.permission !== 'granted') return false;
    const context = liveContext(registry);
    const title = event.type === 'approval' ? t('Aprovação pendente') : t('Nova mensagem');
    const body = event.type === 'approval'
      ? (settings.preview && event.item?.agentName ? t('{agent} aguarda sua decisão.', { agent: event.item.agentName }) : t('Um agente aguarda sua decisão.'))
      : t('Você tem {count} conversas não lidas.', { count: event.count });
    const target = event.item?.conversationId ? conversationHash({ tenantId: event.item.tenantId, conversationId: event.item.conversationId }) : hashForView('inbox');
    try {
      const notification = new Notifier(title, { body, tag: `elozi:${context.workspaceId || ''}:${event.key}`, silent: settings.sound });
      if (event.type === 'message') {
        const entry = { notification, scope: notificationScope, count: event.count };
        messageNotifications.add(entry);
        notification.onclose = () => messageNotifications.delete(entry);
      }
      notification.onclick = () => { try { win?.focus?.(); if (win?.location) win.location.hash = target; notification.close?.(); } catch {} };
      return true;
    } catch { return false; }
  }
  /** Plays and shows what the events deserve under the rules of §7.3; returns what was delivered. */
  function handle(events) {
    const delivered = [];
    if (!events.length || !leader()) return delivered;
    const settings = prefs(), view = liveContext(registry).view;
    if (hidden()) missed = true;
    if (presence() !== 'available' || !settings.sound && !settings.desktop) return delivered;
    for (const event of events) {
      const openHere = !hidden() && (event.type === 'message' ? view === 'inbox' : doc?.defaultView?.location?.hash?.includes?.(encodeURIComponent(event.key)));
      if (openHere) continue;
      if (now() - (lastSound.get(event.key) || 0) < SOUND_GAP) continue;
      lastSound.set(event.key, now());
      if (settings.sound && tone(event.type === 'message' ? (view === 'inbox' ? 'message' : 'queue') : event.type)) delivered.push(['sound', event.type]);
      if (settings.desktop && hidden() && desktop(event, settings)) delivered.push(['desktop', event.type]);
    }
    return delivered;
  }

  /** Opt-in from a gesture: unlocks audio and asks the browser permission for desktop notifications. */
  async function enable(patch = { sound: true, desktop: true }) {
    if (patch.sound && !audio && typeof Audio === 'function') { try { audio = new Audio(); } catch { audio = null; } }
    audio?.resume?.();
    let granted = Notifier?.permission === 'granted';
    if (patch.desktop && Notifier && !granted && Notifier.permission !== 'denied') { try { granted = (await Notifier.requestPermission()) === 'granted'; } catch { granted = false; } }
    saveNotifyPrefs(userId(), { ...patch, desktop: Boolean(patch.desktop && granted), prompted: true }, storage);
    missed = false;
    if (doc) apply(doc);
    return prefs();
  }
  function disable(patch = { sound: false, desktop: false }) { saveNotifyPrefs(userId(), { ...patch, prompted: true }, storage); missed = false; if (doc) apply(doc); return prefs(); }

  function register() {
    registerAction('live:notify-enable', () => enable({ sound: true, desktop: true }));
    registerAction('live:notify-dismiss', () => disable({}));
  }

  attention?.subscribe?.(snapshot => {
    const scope = syncNotificationScope(), context = liveContext(registry);
    if (snapshot?.workspaceId && snapshot.workspaceId !== context.workspaceId) return;
    // Only a confirmed lower count in this same session makes its generic message notice obsolete.
    // Missing/unknown counts do not acknowledge anything, and approval notices have their own life.
    const count = snapshot?.unreadForMe?.total;
    if (scope && ['attention', 'pulse'].includes(snapshot?.source) && Number.isSafeInteger(count) && count >= 0) closeMessages(entry => entry.scope === scope && entry.count > count);
    const events = attentionEvents(previous, snapshot);
    previous = snapshot;
    if (prefs().sound && !audio && typeof Audio === 'function') { try { audio = new Audio(); } catch { audio = null; } }
    handle(events);
    if (doc) apply(doc);
  });
  onLiveCount(() => { if (doc) apply(doc); }, registry);
  doc?.addEventListener?.('visibilitychange', () => { if (doc) apply(doc); });
  win?.document?.addEventListener?.('visibilitychange', () => { if (doc) optInBanner(); });

  const api = {
    apply, handle, enable, disable, prefs,
    /** Whether sound or desktop notifications are on for this person (nothing before the opt-in). */
    enabled() { const value = prefs(); return Boolean(userId() && (value.sound || value.desktop)); }
  };
  if (attention) active = api;
  return api;
}
