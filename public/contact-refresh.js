import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';

// Refresh only the server-authorized agenda. Forms, drafts and conversation
// players remain owned by their existing controllers.
export function createContactRefresh({getContext, request, onContacts, onDenied}) {
  let sequence = 0, pending = null, cacheScope = '', revision = '', deniedScope = '';
  const scope = c => JSON.stringify([c.userId, c.workspaceId, c.tenantId, c.supportGrantId || null, c.authorityKey, c.refreshSequence]);
  const requestKey = c => JSON.stringify([scope(c), c.view]);
  const active = c => Boolean(c.userId && c.workspaceId && c.tenantId && ['contacts', 'inbox'].includes(c.view));
  const validContacts = items => Array.isArray(items) && items.every(c => c && typeof c === 'object' && !Array.isArray(c) &&
    typeof c.id === 'string' && c.id && typeof c.name === 'string' &&
    ['phone','email','notes'].every(field => c[field] == null || typeof c[field] === 'string') &&
    (c.tags === undefined || Array.isArray(c.tags) && c.tags.every(tag => typeof tag === 'string')) &&
    (c.identities === undefined || Array.isArray(c.identities) && c.identities.every(i => i && typeof i === 'object' && !Array.isArray(i) && typeof i.channelId === 'string')));
  function reset() {
    sequence++; pending?.controller.abort(); pending = null;
    cacheScope = ''; revision = ''; deniedScope = '';
  }
  function refresh({force = false} = {}) {
    const context = getContext();
    if (!active(context) || context.paused || !context.canRead) return Promise.resolve(false);
    const currentScope = scope(context), key = requestKey(context);
    if (deniedScope === currentScope && !force) return Promise.resolve(false);
    if (pending?.key === key && !force) return pending.promise;
    pending?.controller.abort();
    const ticket = ++sequence, controller = new AbortController();
    const current = () => ticket === sequence && active(getContext()) && requestKey(getContext()) === key;
    const since = cacheScope === currentScope ? revision : '';
    const operation = {key, controller, promise: null};
    pending = operation;
    operation.promise = (async () => {
      try {
        const result = await request(`/api/tenants/${encodeURIComponent(context.tenantId)}/contacts?archived=true&snapshot=true${since ? '&since=' + since : ''}`, {
          signal: controller.signal,
          headers: {'X-Elozi-Workspace': context.workspaceId, 'X-Elozi-Support-Grant': context.supportGrantId || ''}
        });
        if (!current() || getContext().paused || !getContext().canRead) return false;
        if (!result || !/^[a-f0-9]{64}$/.test(result.revision || '') || typeof result.unchanged !== 'boolean' ||
            result.unchanged && (!since || result.revision !== since) || !result.unchanged && !validContacts(result.contacts)) throw Error(i18nText('O servidor retornou uma agenda inválida.'));
        if (!result.unchanged) onContacts(result.contacts);
        cacheScope = currentScope; revision = result.revision; deniedScope = '';
        return true;
      } catch (error) {
        if (current() && [403, 404].includes(error.status)) {
          cacheScope = ''; revision = ''; deniedScope = currentScope;
          onDenied(error);
        }
        // Transient errors retain the last authorized records and drafts.
        return false;
      } finally {
        if (pending === operation) pending = null;
      }
    })();
    return operation.promise;
  }
  return {refresh, reset};
}
