// libsignal imprime SessionEntry com chaves mesmo quando o logger Baileys é silencioso.
const prefixes = ['Closing session:', 'Opening session:', 'Session already closed', 'Removing old closed session:', 'V1 session storage migration error:'];
export function isSensitiveProtocolDiagnostic(args) {
  return prefixes.some(prefix => typeof args[0] === 'string' && args[0].startsWith(prefix)) || args.some(value => value && typeof value === 'object' && ('currentRatchet' in value || '_chains' in value || 'privKey' in value || 'rootKey' in value));
}
let installed = false;
export function installProtocolLogGuard() {
  if (installed) return;
  installed = true;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...args) => { if (!isSensitiveProtocolDiagnostic(args)) original(...args); };
  }
}
