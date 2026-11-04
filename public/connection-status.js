// Connection indicator of the topbar (FRONTEND-V2 §4.3 .sh-conn, §7.2, §8.3 P2), patched in the
// [data-shell-slot="connection"] slot that shell-ui.js draws, without a full render:
//
// | Ao vivo  | last success ≤ 15 s (or the event stream open) | green dot, tooltip "Atualizado há 2 s"   |
// | Atrasado | > 15 s or 2 failures                           | amber, "atualizado há 32 s" + Tentar agora |
// | Offline  | navigator.onLine false or 3 failures in a row  | red, plus the banner "Sem conexão…"      |
//
// The state comes from live.state().connection; null (nothing measured yet) keeps the slot hidden,
// never "Ao vivo". role=status lives in a visually hidden node whose text changes only when the state
// changes, so the seconds counter is never announced. While the state stays the same, the age and the
// tooltip are patched in place: a focused "Tentar agora" keeps the focus. The offline banner promises
// only what happens: the text stays in the composer, the updates resume on their own and a send that
// failed is never repeated by itself.
import { h, t } from './i18n.js';
import './locales-live.js';
import { banner } from './ui.js';
import { registerAction } from './actions.js';
import { currentLive, liveRegistry } from './live.js';

const LABELS = { live: 'Ao vivo', late: 'Atrasado', offline: 'Offline' };

/** "há 2 s", "há 3 min" (null when unknown). */
export function sinceLabel(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 60 ? t('há {count} s', { count: seconds }) : t('há {count} min', { count: Math.round(seconds / 60) });
}

/** Texts of the indicator for a state of live.js: {tooltip, detail} (detail only while late). */
function connectionTexts({ connection, lastSuccess } = {}, now = Date.now()) {
  const since = sinceLabel(lastSuccess, now);
  const tooltip = connection === 'live' ? (since ? t('Atualizado {since}', { since }) : t('Atualizado agora')) : connection === 'late' ? (since ? t('Atualizado {since}', { since }) : t('Sem atualização recente')) : t('Sem conexão com o servidor');
  return { tooltip, detail: connection === 'late' && since ? t('atualizado {since}', { since }) : '' };
}

/** Markup of the indicator for a state of live.js ({connection, lastSuccess}). */
export function connectionMarkup({ connection, lastSuccess } = {}, now = Date.now()) {
  if (!LABELS[connection]) return null;
  const { tooltip, detail: since } = connectionTexts({ connection, lastSuccess }, now);
  const detail = since ? h`<span class="sh-conn__since">${since}</span>` : '';
  const retry = connection === 'late' ? h`<button type="button" class="ui-btn ui-btn--link ui-btn--sm sh-conn__retry" data-action="live:retry"><span class="ui-btn__label">${t('Tentar agora')}</span></button>` : '';
  return h`<span class="sh-conn__dot" aria-hidden="true"></span><span class="sh-conn__text" title="${tooltip}">${t(LABELS[connection])}</span>${detail}${retry}`;
}

/** createConnectionStatus({live}) → {apply(doc), state()}. live is the {state()} wrapper app.js passes. */
export function createConnectionStatus({ live, registry = liveRegistry, now = () => Date.now() } = {}) {
  let doc = null, subscribed = null, announced = null, applied = false;
  const read = () => { try { return live?.state?.() || null; } catch { return null; } };

  function patch() {
    const slot = doc?.querySelector?.('[data-shell-slot="connection"]');
    const value = read(), connection = value?.connection ?? null;
    if (slot) {
      const markup = connectionMarkup(value || {}, now());
      if (!markup) { slot.hidden = true; slot.removeAttribute?.('data-state'); slot.removeAttribute?.('data-conn-key'); }
      else {
        // The structure changes with the state (and with the age appearing); the age itself is text.
        const texts = connectionTexts(value || {}, now()), key = `${connection}|${texts.detail ? 'since' : ''}`;
        let status = slot.querySelector?.('[data-conn-status]');
        if (status && slot.getAttribute?.('data-conn-key') === key) {
          slot.querySelector?.('.sh-conn__text')?.setAttribute?.('title', texts.tooltip);
          const since = slot.querySelector?.('.sh-conn__since');
          if (since && since.textContent !== texts.detail) since.textContent = texts.detail;
        } else {
          const previous = status?.textContent || '';
          slot.innerHTML = `<span class="sh-conn__visual" data-conn-visual>${markup}</span><span class="sr-only" role="status" data-conn-status></span>`;
          status = slot.querySelector?.('[data-conn-status]');
          if (status && previous) status.textContent = previous;
          slot.setAttribute?.('data-conn-key', key);
        }
        slot.setAttribute?.('data-state', connection);
        slot.hidden = false;
        // Announce only real transitions: never the first paint after a render, never the seconds.
        if (status && announced && announced !== connection) status.textContent = t('Conexão: {state}', { state: t(LABELS[connection]) });
      }
    }
    if (connection) announced = connection;
    offlineBanner(connection);
    return Boolean(slot && connection);
  }
  function offlineBanner(connection) {
    const host = doc?.querySelector?.('[data-shell-slot="banners"]');
    if (!host) return;
    const current = host.querySelector?.('[data-banner="connection"]');
    if (connection !== 'offline') { current?.remove?.(); return; }
    if (current) return;
    host.insertAdjacentHTML?.('afterbegin', String(banner({ tone: 'offline', title: t('Sem conexão.'), body: t('Seu texto fica no compositor e a atualização volta sozinha. Um envio que falhou não é repetido: envie de novo quando a conexão voltar.'), live: 'polite', attrs: { 'data-banner': 'connection' } })));
  }

  return {
    /** Patches the slot of the shell (after every render and on every change of live.js). */
    apply(target = globalThis.document) {
      const slot = target?.querySelector?.('[data-shell-slot="connection"]');
      if (!slot) return false;
      doc = target;
      if (!applied) { applied = true; registerAction('live:retry', () => { currentLive(registry)?.retry(); }); }
      const scheduler = currentLive(registry);
      try {
        if (scheduler && subscribed !== scheduler) { subscribed = scheduler; scheduler.subscribe(() => patch()); }
        scheduler?.touch?.();
      } catch { /* the indicator never breaks the render */ }
      return patch();
    },
    /** 'live' | 'late' | 'offline', or null while nothing was measured. */
    state() { return read()?.connection ?? null; }
  };
}
