import { createWebchatWidget } from './widget.js';

const opaque = value => typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,160}$/.test(value);
const account = value => {
  if (value === null) return null;
  if (!value || !opaque(value.accountId) || !opaque(value.userId)) throw new TypeError('Informe a conta e o usuário atuais do SaaS.');
  return Object.freeze({ accountId: value.accountId, userId: value.userId });
};

/** One mounted support session per active SaaS account/user. Authentication remains on the server. */
export function createSaasWebchat({ identity = null, getIdentityToken, widgetFactory = createWebchatWidget, ...options } = {}) {
  if (typeof getIdentityToken !== 'function') throw new TypeError('Configure o endpoint de identidade do SaaS.');
  let current = null, widget = null, destroyed = false, epoch = 0;
  function setAccount(value) {
    if (destroyed) return false;
    const next = account(value);
    if (current?.accountId === next?.accountId && current?.userId === next?.userId) return false;
    epoch++; widget?.destroy(); widget = null; current = next;
    if (next) {
      const owner = epoch;
      widget = widgetFactory({ ...options, identityRequired: true, expectedIdentity: next, getIdentityToken: async () => {
        if (destroyed || owner !== epoch) return null;
        const token = await getIdentityToken(next);
        return !destroyed && owner === epoch ? token : null;
      } });
    }
    return true;
  }
  function destroy() { if (destroyed) return; setAccount(null); destroyed = true; epoch++; getIdentityToken = null; }
  const support = { setAccount, destroy, open: () => widget?.open(), close: () => widget?.close(), get host() { return widget?.host ?? null; } };
  setAccount(identity);
  return support;
}
