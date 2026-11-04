import { runInNewContext as runExcerpt } from 'node:vm';
import { createModalRouteLifecycle } from '../../public/modal-route-lifecycle.js';
import { formatHash } from '../../public/router.js';
import { inboxFilterQuery } from '../../public/inbox-route-filters.js';
import { defaultLens } from '../../public/inbox-list-ui.js';

// Existing excerpts exercise their own guards without a generic modal fixture. The modal-route
// regressions supply the real dialog/context; keep the other scopes' assertions and VM identity.
export function runInNewContext(source, context, options) {
  context.modalRouteLifecycle ??= createModalRouteLifecycle({ getModal: () => null, getContext: () => '' });
  // Same real dependencies as app.js; never replace serializer/role behavior with mocks.
  context.formatHash ??= formatHash;
  context.inboxFilterQuery ??= inboxFilterQuery;
  context.defaultLens ??= defaultLens;
  return runExcerpt(source, context, options);
}
