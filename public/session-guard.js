// Expired session (FRONTEND-V2 §7.2, §8.3 P2). A request answered 401 (outside the current-password
// check) no longer leaves the page:
//
// 1. sessionExpired() stops the loaders of the old session (abort), fires `elozi:reauth` (live.js
//    pauses every poll), keeps the drafts in sessionStorage (drafts-store.js holds its clear) and
//    shows the dialog "Sua sessão expirou. [Entrar novamente]" — once, whatever the number of 401s.
// 2. The button opens /login?return=close in a new window. After the login, login.js posts
//    {type:'elozi:reauth-ok', userId} to location.origin (opener and BroadcastChannel 'elozi-auth')
//    and closes the window.
// 3. Same person: the dialog closes, `elozi:reauth-ok` resumes the GETs and a toast asks to review and
//    send again; failed sends are never repeated on their own. The composer, the notes and the
//    attachments in memory are untouched (discard is not called).
//    Another person: the drafts of the previous one are cleared and the panel reloads as the new one.
//
// Without a document to show the dialog, the behaviour of before stays: discard and open the login.
import { h, t } from './i18n.js';
import './locales-live.js';
import { glyph } from './icons.js';
import { toasts } from './ui.js';
import { liveContext, liveRegistry } from './live.js';
import { clearDraftsStorage, holdDrafts } from './drafts-store.js';
import { parseHash, formatHash } from './router.js';

export const REAUTH_EVENT = 'elozi:reauth';
export const REAUTH_OK = 'elozi:reauth-ok';
export const AUTH_CHANNEL = 'elozi-auth';
export const REAUTH_URL = '/login?return=close&reason=session-expired';

const guard = { pending: false, initialRedirected: false, userId: '', dialog: null, listening: null, channel: null, win: null, doc: null, location: null, reason: '' };

/** Whether a re-authentication is pending on this page. */
export const reauthPending = () => guard.pending;

function dialogMarkup() {
  return h`<form method="dialog" class="lv-reauth__panel" data-reauth-form>
    <span class="lv-reauth__icon" aria-hidden="true">${glyph('shield')}</span>
    <h2 class="lv-reauth__title" id="lv-reauth-title">${t('Sua sessão expirou.')}</h2>
    <p class="lv-reauth__body" id="lv-reauth-body">${t('A resposta em andamento, as notas e os anexos do atendimento continuam nesta página. Entre novamente em uma nova janela para continuar de onde parou.')}</p>
    <p class="lv-reauth__error" role="alert" data-reauth-error hidden></p>
    <div class="lv-reauth__actions">
      <button type="button" class="ui-btn ui-btn--secondary ui-btn--md" data-reauth-here hidden><span class="ui-btn__label">${t('Entrar nesta aba')}</span></button>
      <button type="button" class="ui-btn ui-btn--primary ui-btn--md" data-reauth-open autofocus><span class="ui-btn__label">${t('Entrar novamente')}</span></button>
    </div>
  </form>`;
}

function show() {
  const doc = guard.doc;
  if (!doc?.body) return;
  let dialog = guard.dialog;
  if (!dialog?.isConnected) {
    dialog = doc.createElement('dialog');
    dialog.className = 'lv-reauth';
    dialog.setAttribute('aria-labelledby', 'lv-reauth-title');
    dialog.setAttribute('aria-describedby', 'lv-reauth-body');
    dialog.innerHTML = String(dialogMarkup());
    // The dialog only leaves after the login: Esc would leave the page inert behind nothing.
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.addEventListener('click', event => {
      if (event.target?.closest?.('[data-reauth-open]')) { event.preventDefault(); openLogin(); }
      else if (event.target?.closest?.('[data-reauth-here]')) { event.preventDefault(); guard.location?.assign?.('/login?reason=' + encodeURIComponent(guard.reason || 'session-expired')); }
    });
    doc.body.append(dialog);
    guard.dialog = dialog;
  }
  if (!dialog.open) { try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); } }
  dialog.querySelector('[data-reauth-open]')?.focus?.({ preventScroll: true });
}

function openLogin() {
  const popup = guard.win?.open?.(REAUTH_URL, 'elozi-reauth', 'popup=yes,width=480,height=720');
  const error = guard.dialog?.querySelector('[data-reauth-error]'), here = guard.dialog?.querySelector('[data-reauth-here]');
  if (popup) { popup.focus?.(); if (error) { error.hidden = true; error.textContent = ''; } return true; }
  if (error) { error.textContent = t('O navegador bloqueou a janela de entrada. Permita janelas deste endereço e tente de novo, ou entre nesta aba: o texto fica salvo, mas anexos ainda não enviados se perdem.'); error.hidden = false; }
  if (here) here.hidden = false;
  return false;
}

function finish(data) {
  if (!guard.pending || data?.type !== REAUTH_OK) return false;
  const userId = typeof data.userId === 'string' ? data.userId : '';
  if (userId && guard.userId && userId !== guard.userId) {
    // Another person signed in: nothing of the previous one stays on the page.
    clearDraftsStorage();
    guard.location?.assign?.('/');
    return true;
  }
  guard.pending = false;
  holdDrafts(false);
  if (guard.dialog?.open) guard.dialog.close();
  guard.dialog?.remove?.(); guard.dialog = null;
  try { guard.win?.dispatchEvent?.(new CustomEvent(REAUTH_OK, { detail: { userId } })); } catch {}
  toasts.show({ message: t('Sessão renovada. Revise e envie de novo o que não foi enviado.'), tone: 'info' });
  return true;
}

function listen(win) {
  if (guard.listening === win) return;
  guard.listening = win;
  win.addEventListener('message', event => {
    if (event?.origin !== win.location?.origin) return;
    finish(event.data);
  });
  try { const Channel = win.BroadcastChannel; if (typeof Channel === 'function') { guard.channel = new Channel(AUTH_CHANNEL); guard.channel.onmessage = event => finish(event?.data); guard.channel.unref?.(); } } catch {}
}

/**
 * sessionExpired({reason}) — app.js calls it on 401 with:
 * - reason: value of /login?reason= ('session-expired');
 * - abort(): stops the requests and loaders bound to the old session (always called);
 * - discard(): drops the in-memory private state (only on the fallback that leaves the page);
 * - location, document, window: injectable for tests (default: the page).
 */
export function sessionExpired({ reason = 'session-expired', initial = false, abort, discard, location = globalThis.location, document: doc = globalThis.document, window: win = globalThis.window, registry = liveRegistry } = {}) {
  abort?.();
  if (initial) {
    if (guard.initialRedirected) return true;
    guard.initialRedirected = true;
    const route = parseHash(location?.hash), next = route ? '/' + formatHash({ ...route, query: {} }) : null;
    location?.assign?.('/login?reason=' + encodeURIComponent(String(reason)) + (next ? '&next=' + encodeURIComponent(next) : ''));
    return true;
  }
  if (!doc?.body || typeof doc.createElement !== 'function' || typeof win?.addEventListener !== 'function') {
    discard?.();
    location?.assign?.('/login?reason=' + encodeURIComponent(String(reason)));
    return true;
  }
  Object.assign(guard, { doc, win, location, reason: String(reason) });
  listen(win);
  if (guard.pending) { show(); return true; }
  guard.pending = true;
  guard.userId = String(liveContext(registry).userId || '');
  holdDrafts(true);
  try { win.dispatchEvent(new CustomEvent(REAUTH_EVENT, { detail: { reason: String(reason) } })); } catch {}
  show();
  return true;
}

/** Test hook: forgets the pending state of this page. */
export function resetSessionGuard() {
  try { guard.channel?.close?.(); } catch {}
  guard.dialog?.remove?.();
  Object.assign(guard, { pending: false, initialRedirected: false, userId: '', dialog: null, listening: null, channel: null, win: null, doc: null, location: null, reason: '' });
  holdDrafts(false);
}
