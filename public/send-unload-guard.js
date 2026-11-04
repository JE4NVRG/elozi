// A native exit warning, not a durable receipt or a delivery retry. Browsers may
// suppress the prompt without user activation; deliberately leaving can still
// lose this tab's pending command. Never reconstruct a POST from a saved draft.
export function installPendingSendUnloadGuard({ target = globalThis, pending = () => false } = {}) {
  if (!target?.addEventListener) return () => {};
  const beforeUnload = event => {
    if (!pending()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  target.addEventListener('beforeunload', beforeUnload);
  return () => target.removeEventListener('beforeunload', beforeUnload);
}
