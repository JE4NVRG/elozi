// Action registry of the panel (FRONTEND-V2 §8.1, seam 1). act() in app.js asks this registry before
// its legacy switch, so the packages of wave 1 add or replace behaviour without editing app.js.
//
// - Names are namespaced ('<ns>:<verb>', §3.1): 'shell:pending', 'rail:insert-draft',
//   'agents:save-instructions'. Legacy names ('new-agent', 'mcp-approve') stay in app.js until P10
//   and never reach the registry.
// - registerAction(name, handler): the last registration of a name wins. P1 registers the defaults
//   (shell:* in app.js) and the owning package replaces them (P2: the Pendências and Equipe drawers).
//   The handler receives { name, id, element, event }; it returns the unregister function.
// - registerScreen(namespace, screen): a delegated screen ({act, submit} of the §8.2 contracts)
//   answers the '<namespace>:*' actions without a registration of their own and the forms whose
//   data-form is '<namespace>:<form>'. The last registration of a namespace wins as well.
// - dispatchAction(name, element, event, id) resolves true when the registry handled the action;
//   dispatchSubmit(form, event) resolves true for every namespaced form (never posted to the page).
//   false sends the caller back to the legacy code.
const ACTION = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const NAMESPACE = /^[a-z][a-z0-9-]*$/;
const actions = new Map();
const screens = new Map();

/** True for a registry name: '<namespace>:<verb>' in lowercase ASCII. */
export const isNamespacedName = name => typeof name === 'string' && ACTION.test(name);
const namespaceOf = name => name.slice(0, name.indexOf(':'));

/** Registers (or replaces) one namespaced action; returns a function that removes this registration. */
export function registerAction(name, handler) {
  if (!isNamespacedName(name)) throw new TypeError(`Action names need a namespace: ${name}`);
  if (typeof handler !== 'function') throw new TypeError(`Action ${name} needs a handler`);
  actions.set(name, handler);
  return () => { if (actions.get(name) === handler) actions.delete(name); };
}

/** Registers several actions at once ({name: handler}); returns one function that removes them all. */
export function registerActions(map) {
  const undo = Object.entries(map || {}).map(([name, handler]) => registerAction(name, handler));
  return () => { for (const remove of undo) remove(); };
}

/** Connects a delegated screen ({act(name, id, element, event), submit(form, event)}) to its namespace. */
export function registerScreen(namespace, screen) {
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) throw new TypeError(`Invalid screen namespace: ${namespace}`);
  if (!screen || typeof screen.act !== 'function' && typeof screen.submit !== 'function') throw new TypeError(`Screen ${namespace} needs act or submit`);
  screens.set(namespace, screen);
  return () => { if (screens.get(namespace) === screen) screens.delete(namespace); };
}

/**
 * Runs the action registered for `name`, else the act() of the screen of its namespace. element is
 * the control that triggered it (data-id, focus return), event the DOM event when there is one and
 * id the data-id when act() runs without an element. Resolves true when something handled it.
 */
export async function dispatchAction(name, element = null, event = null, id = element?.dataset?.id ?? null) {
  if (!isNamespacedName(name)) return false;
  const handler = actions.get(name);
  if (handler) {
    await handler({ name, id: id ?? null, element, event });
    return true;
  }
  const screen = screens.get(namespaceOf(name));
  if (typeof screen?.act !== 'function') return false;
  return Boolean(await screen.act(name, id ?? null, element, event));
}

/**
 * Sends a form whose data-form is '<namespace>:<form>' to the submit() of its screen. The default
 * submission is prevented synchronously, before any await, even when no screen answers the
 * namespace (a namespaced form never posts the page). Resolves true for every namespaced form and
 * false for the others, which the legacy listeners of app.js keep handling.
 */
export async function dispatchSubmit(form, event = null) {
  const name = form?.dataset?.form;
  if (!isNamespacedName(name)) return false;
  event?.preventDefault?.();
  const screen = screens.get(namespaceOf(name));
  if (typeof screen?.submit === 'function') await screen.submit(form, event);
  return true;
}

/** Registered action names and screen namespaces, sorted (diagnostics and tests). */
export function registryEntries() {
  return { actions: [...actions.keys()].sort(), screens: [...screens.keys()].sort() };
}
