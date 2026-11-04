// Reply composer (FRONTEND-V2 §5.2.3). Owned by P3. composerBridge is the only way other modules touch
// the composer (P4 inserts an agent draft through it); it works over the #message-text textarea with
// the same effects as typing: the value changes and an `input` event lets app.js keep its draft and
// its character counter.
//
// The composer has exactly two modes (§5.2.3): "Responder ao cliente" and "Nota interna". The note
// has its own background (--note-bg), the label "Nota interna · visível só para a equipe" and the
// button "Salvar nota"; the reply has "Enviar ao cliente". The line "Responder por [monograma]
// Empresa › Canal …número" stays visible above the field, so nobody answers through the wrong
// company or number.
//
// Inserting an agent draft (insertDraft) fills the composer only when it is empty. With text, it
// asks "Substituir | Acrescentar | Cancelar" inline (never a shortcut, never silently), flashes
// --accent-soft for 400 ms and remembers the run (sourceRunId) for the send, while the textarea that
// received it is still on screen.
import { h, t } from './i18n.js';
import { companyMark, segmented } from './ui.js';
import { glyph } from './icons.js';
import './locales-inbox.js';

export const COMPOSER_MODES = Object.freeze(['reply', 'note']);
const FLASH_MS = 400;

/** Segmented control Responder ao cliente | Nota interna (native radios, name="composer-mode"). */
export function composerModeMarkup(mode = 'reply', { disabled = false } = {}) {
  return segmented({ name: 'composer-mode', label: t('Tipo de mensagem'), value: mode === 'note' ? 'note' : 'reply', disabled,
    items: [{ value: 'reply', label: t('Responder ao cliente') }, { value: 'note', label: t('Nota interna') }] });
}

/** "…4471" from the channel label ("Número de teste · final 4471") or its number, else ''. */
export function channelNumberHint(channel) {
  const label = String(channel?.label ?? ''), digits = /final (\d{2,6})$/.exec(label)?.[1] || /(\d{4})\D*$/.exec(String(channel?.number ?? ''))?.[1];
  return digits ? `…${digits}` : '';
}

/**
 * Origin of the reply (§5.2.3): "Responder por [monograma] Empresa › Canal …número" in reply mode,
 * "Nota interna · visível só para a equipe" in note mode. tenant: {name, brand}; channel: {name, label}.
 */
export function composerOriginMarkup({ mode = 'reply', tenant = {}, channel = null, channelKind = '', access = '' } = {}) {
  if (mode === 'note') return h`<p class="pg-inbox__origin pg-inbox__origin--note" data-composer-origin>${glyph('shield')}<span><strong>Nota interna</strong> · visível só para a equipe</span></p>`;
  const number = channelNumberHint(channel);
  const name = channel?.name || channelKind || t('Canal');
  return h`<p class="pg-inbox__origin" data-composer-origin title="${tenant.name || ''} › ${name}${number ? ` ${number}` : ''}"><span class="pg-inbox__origin-label">Responder por</span>${companyMark(tenant, { showName: true })}<span class="pg-inbox__origin-sep" aria-hidden="true">›</span><span class="pg-inbox__origin-channel"><span class="pg-inbox__origin-name">${name}</span>${number ? h`<span class="pg-inbox__origin-number"> ${number}</span>` : ''}</span>${access ? h`<span class="pg-inbox__origin-access" data-composer-access>${access}</span>` : ''}</p>`;
}

/** Label of the submit button of each mode (reply and note never share a label). */
export const composerSubmitLabel = mode => mode === 'note' ? t('Salvar nota') : t('Enviar ao cliente');

/**
 * createComposerBridge({doc, getMode}) → {getText, setText, focus, flash, mode, insertDraft, sourceRunId, cancelChoice}.
 * - setText(text, {mode:'replace'|'append'}): replace swaps the text, append adds it on a new line;
 *   refused (false) when the composer is absent or disabled.
 * - flash(): the 400 ms --accent-soft flash of the composer (data-flash on .pg-inbox__composer).
 * - insertDraft(text, {sourceRunId}) → Promise<'inserted'|'replaced'|'appended'|'cancelled'|false>:
 *   an empty composer is filled; one with text asks Substituir | Acrescentar | Cancelar first.
 * - sourceRunId: the run whose draft is in the composer (null once the textarea is replaced).
 * - mode: 'reply' | 'note', the composer mode in use (getMode).
 */
export function createComposerBridge({ doc = globalThis.document, getMode = () => 'reply', timers = globalThis } = {}) {
  const field = () => doc?.querySelector?.('#message-text') || null;
  let source = null, choice = null, flashTimer = null;
  const dispatchInput = node => {
    const EventType = doc?.defaultView?.Event || globalThis.Event;
    if (typeof EventType === 'function') node.dispatchEvent?.(new EventType('input', { bubbles: true }));
  };
  function setText(text, { mode = 'replace', sourceRunId } = {}) {
    const node = field();
    if (!node || node.disabled) return false;
    const value = String(text ?? '');
    node.value = mode === 'append' && node.value ? `${node.value}${node.value.endsWith('\n') ? '' : '\n'}${value}` : value;
    // A draft written by the agent rail keeps its run for the send (feature "source-run-id").
    if (sourceRunId !== undefined) source = sourceRunId ? { runId: String(sourceRunId), node } : null;
    dispatchInput(node);
    return true;
  }
  function focus() {
    const node = field();
    if (!node) return false;
    node.focus();
    return true;
  }
  function flash() {
    const host = field()?.closest?.('.pg-inbox__composer');
    if (!host?.setAttribute) return false;
    host.removeAttribute('data-flash');
    void host.offsetWidth;
    host.setAttribute('data-flash', '');
    timers.clearTimeout?.(flashTimer);
    flashTimer = timers.setTimeout?.(() => host.removeAttribute('data-flash'), FLASH_MS);
    return true;
  }
  function cancelChoice() {
    if (!choice) return false;
    const current = choice; choice = null;
    current.release();
    current.host.hidden = true; current.host.innerHTML = '';
    current.resolve('cancelled');
    return true;
  }
  function apply(text, how, sourceRunId) {
    if (!setText(text, { mode: how === 'append' ? 'append' : 'replace' })) return false;
    source = sourceRunId ? { runId: String(sourceRunId), node: field() } : null;
    flash(); focus();
    return true;
  }
  function insertDraft(text, { sourceRunId = null } = {}) {
    const node = field(), value = String(text ?? '');
    if (!node || node.disabled || !value.trim()) return Promise.resolve(false);
    cancelChoice();
    if (!node.value.trim()) return Promise.resolve(apply(value, 'replace', sourceRunId) ? 'inserted' : false);
    const host = doc.querySelector?.('[data-composer-choice]');
    if (!host) return Promise.resolve(false);
    return new Promise(resolve => {
      // Each question is its own object: the host persists between questions, so a later Esc or click
      // answers only the question on screen, and its keydown listener leaves with it.
      const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); finish('cancel'); } };
      const ask = { host, resolve, release: () => host.removeEventListener?.('keydown', onKey) };
      choice = ask;
      host.innerHTML = String(h`<span class="pg-inbox__choice-text">O compositor já tem texto. O que fazer com o rascunho?</span><span class="pg-inbox__choice-actions"><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-choice="replace"><span class="ui-btn__label">Substituir</span></button><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-choice="append"><span class="ui-btn__label">Acrescentar</span></button><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-choice="cancel"><span class="ui-btn__label">Cancelar</span></button></span>`);
      host.hidden = false;
      const finish = how => {
        if (choice !== ask) return;
        choice = null; ask.release(); host.hidden = true; host.innerHTML = '';
        if (how === 'cancel') { focus(); resolve('cancelled'); return; }
        resolve(apply(value, how, sourceRunId) ? (how === 'append' ? 'appended' : 'replaced') : false);
      };
      for (const button of host.querySelectorAll?.('[data-choice]') || []) button.addEventListener?.('click', () => finish(button.dataset.choice));
      host.addEventListener?.('keydown', onKey);
      host.querySelector?.('[data-choice="replace"]')?.focus?.();
    });
  }
  return {
    getText() { return field()?.value ?? ''; },
    setText, focus, flash, insertDraft, cancelChoice,
    /** Run of the draft now in the composer, while the textarea that received it is on screen and not emptied. */
    get sourceRunId() { const node = field(); return source && source.node === node && node?.value?.trim() ? source.runId : null; },
    clearSource() { source = null; },
    get mode() { return getMode() === 'note' ? 'note' : 'reply'; }
  };
}

/** Host of the inline Substituir | Acrescentar | Cancelar question (hidden until insertDraft asks). */
export function composerChoiceMarkup() {
  return h`<div class="pg-inbox__choice" data-composer-choice role="group" aria-label="Inserir rascunho" hidden></div>`;
}

