/** Unsaved identities stay separate inside the current workspace/company only. */
export function createBrandDrafts() {
  let context = null;
  const drafts = new Map();
  const reset = () => { context = null; drafts.clear(); };
  const get = ({ workspaceId, tenantId, scope, brand }) => {
    const next = JSON.stringify([workspaceId, tenantId]);
    if (context !== next) { drafts.clear(); context = next; }
    if (!drafts.has(scope)) drafts.set(scope, { ...brand, key: [workspaceId, tenantId, scope].join(':'), logoChanged: false });
    return drafts.get(scope);
  };
  return { get, reset, invalidate: scope => drafts.delete(scope) };
}
