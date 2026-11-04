// A modal belongs to the admitted screen and authority, not to a hash that may still be rejected.
export function modalScopeContext(state) {
  const session = state.boot?.session || {};
  return JSON.stringify([state.workspaceId, state.supportGrantId || session.supportGrantId || null, state.tenant?.id, session.userId,
    state.boot?.csrfToken || session.csrfToken, session.role, session.kind,
    session.platformOwner, session.platformAdmin, session.permissions, session.scopeRules,
    (state.boot?.workspaces || []).map(item => [item.id, item.supportGrantId || null]),
    (state.boot?.tenants || []).map(item => item.id), state.boot?.publicOrigin, state.boot?.canonicalPublicOrigin]);
}
export function modalRouteContext(state) {
  return JSON.stringify([state.view, state.screenRoutes?.[state.view] || null,
    state.view === 'inbox' ? state.conversation : null, modalScopeContext(state)]);
}

const controls = modal => [...(modal?.querySelectorAll?.('input, select, textarea') || [])]
  .filter(field => !['hidden', 'button', 'submit', 'reset', 'image'].includes(field.type)
    && !field.readOnly && !field.hasAttribute?.('readonly'));
const fieldValue = field => JSON.stringify(
  ['checkbox', 'radio'].includes(field.type) ? Boolean(field.checked)
    : field.type === 'file' ? [...(field.files || [])].map(file => [file.name, file.size, file.lastModified])
      : field.multiple ? [...(field.selectedOptions || [])].map(option => option.value) : field.value);
const keyedControls = modal => {
  const counts = new Map();
  return controls(modal).map(field => {
    const identity = JSON.stringify([field.name || field.id || '', field.type,
      ['checkbox', 'radio'].includes(field.type) ? field.value : null]);
    const occurrence = counts.get(identity) || 0; counts.set(identity, occurrence + 1);
    return [JSON.stringify([identity, occurrence]), field];
  });
};

export function createModalRouteLifecycle({ getModal, getContext, getScopeContext = getContext, getRoute = () => '',
  confirmDiscard = () => false, protectedNavigation = () => false } = {}) {
  let record = null;
  const bound = new WeakSet();
  function canLeave({ navigation = true } = {}) {
    const modal = getModal();
    if (!modal?.open) return true;
    // A second hashchange during an admitted View Transition is the same departure. Authority
    // changes already applied by bootstrap also cannot ask to keep an old form actionable.
    if (record && record.context !== getContext()) return true;
    // Flow-save and cross-workspace confirmations own their choices and close listeners.
    if (navigation && protectedNavigation(modal)) return false;
    const dirty = record && [...record.edited].some(field => modal.contains(field) && record.fields.get(field) !== fieldValue(field));
    return !dirty || confirmDiscard() === true;
  }
  function opened() {
    const modal = getModal();
    if (!modal) return;
    if (!bound.has(modal)) {
      bound.add(modal);
      modal.addEventListener('cancel', event => { if (!canLeave({ navigation: false })) event.preventDefault(); });
      modal.addEventListener('close', () => { if (!modal.open) record = null; });
      const capture = event => {
        const field = event.target;
        if (record && controls(modal).includes(field) && !record.edited.has(field)) record.fields.set(field, fieldValue(field));
      };
      // Async loaders may insert a form or fill .value without editing it. Capture its current
      // baseline before the first user change, and track edits per element so undo stays clean.
      for (const name of ['focusin', 'beforeinput', 'pointerdown', 'keydown']) modal.addEventListener(name, capture, true);
      for (const name of ['input', 'change']) modal.addEventListener(name, event => {
        const field = event.target;
        if (record && controls(modal).includes(field)) record.edited.add(field);
      }, true);
      modal.addEventListener('click', () => {
        if (!record) return;
        const clickedRecord = record, before = new Map(keyedControls(modal).map(([key, field]) => [key,
          { value: fieldValue(field), baseline: record.edited.has(field) ? record.fields.get(field) : fieldValue(field), edited: record.edited.has(field) }]));
        queueMicrotask(() => {
          if (record !== clickedRecord || !modal.open || record.context !== getContext()) return;
          // Explicit actions such as applying suggested permissions may replace a fieldset without
          // firing input/change. Match controls across that replacement and keep their undo baseline.
          for (const [key, field] of keyedControls(modal)) {
            const previous = before.get(key);
            if (!previous || !previous.edited && previous.value === fieldValue(field)) continue;
            if (!record.edited.has(field)) record.fields.set(field, previous.baseline);
            record.edited.add(field);
          }
        });
      }, true);
    }
    record = { context: getContext(), scope: getScopeContext(), route: getRoute(), fields: new Map(controls(modal).map(field => [field, fieldValue(field)])), edited: new Set() };
  }
  function close() {
    record = null;
    const modal = getModal();
    // A browser may queue close until another dialog has opened. Scrub the old DOM immediately.
    for (const field of modal?.querySelectorAll?.('input[type="password"]') || []) field.value = '';
    // Native close keeps the modal owners' abort, private-field scrubbing and dismissal hooks.
    if (modal?.open) modal.close();
  }
  function sync() {
    if (!getModal()?.open || !record || record.context === getContext()) return false;
    close();
    return true;
  }
  function syncScope() {
    if (!getModal()?.open || !record || record.scope === getScopeContext()) return false;
    close();
    return true;
  }
  function originRoute(fallback) { return record && record.context === getContext() ? record.route || fallback : fallback; }
  return { opened, canLeave, sync, syncScope, close, originRoute };
}
