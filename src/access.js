const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };

export const BUSINESS_PERMISSIONS = Object.freeze([
  'inbox.read', 'inbox.reply', 'inbox.transfer', 'contacts.read', 'contacts.write', 'metrics.read', 'flows.read'
]);
export const OPERATOR_DEFAULT_PERMISSIONS = BUSINESS_PERMISSIONS;
export const PRESENCES = Object.freeze(['available', 'busy', 'away', 'offline']);
const vocabulary = new Set(BUSINESS_PERMISSIONS);
const scopeFields = new Map([['channelIds', 'channelId'], ['departmentIds', 'departmentId']]);

export function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

export function allowedFields(input, fields, message = 'Informe somente os campos permitidos.') {
  if (!plainObject(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !fields.includes(key))) invalid(message);
}

export function normalizePermissions(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > BUSINESS_PERMISSIONS.length
      || value.some(permission => typeof permission !== 'string' || !vocabulary.has(permission))) invalid('Escolha permissões válidas para a equipe.');
  const permissions = [...new Set(value)];
  if ((permissions.includes('inbox.reply') || permissions.includes('inbox.transfer')) && !permissions.includes('inbox.read')) invalid('Responder e transferir exigem acesso à leitura do atendimento.');
  if (permissions.includes('contacts.write') && !permissions.includes('contacts.read')) invalid('Editar contatos exige acesso à leitura dos contatos.');
  return BUSINESS_PERMISSIONS.filter(permission => permissions.includes(permission));
}

function scopeIds(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string'
      || !id || id !== id.trim() || id.length > 120 || /[\x00-\x1f\x7f]/.test(id))) invalid(`Informe uma lista válida de ${label}.`);
  return [...new Set(value)];
}

export function normalizeScopeRules(value, tenantIds, role) {
  if (value === null || value === undefined) return null;
  if (!plainObject(value) || Reflect.ownKeys(value).length > 100) invalid('Informe escopos válidos para a equipe.');
  const result = {};
  for (const tenantId of Reflect.ownKeys(value)) {
    if (typeof tenantId !== 'string' || ['__proto__','prototype','constructor'].includes(tenantId) || !tenantIds.includes(tenantId) || role !== 'operator') invalid('O escopo precisa pertencer a uma empresa vinculada ao atendente.');
    const rule = value[tenantId];
    if (rule === null) { result[tenantId] = null; continue; }
    allowedFields(rule, [...scopeFields.keys()], 'Edite somente os canais e departamentos do escopo.');
    const normalized = {};
    for (const [key] of scopeFields) if (Object.hasOwn(rule, key)) normalized[key] = scopeIds(rule[key], key === 'channelIds' ? 'canais' : 'departamentos');
    Object.defineProperty(result, tenantId, { value: normalized, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function accessOf(row) {
  return {
    permissions: row.permissions === null || row.permissions === undefined ? null : normalizePermissions(JSON.parse(row.permissions)),
    scopeRules: row.scope_rules === null || row.scope_rules === undefined ? null : normalizeScopeRules(JSON.parse(row.scope_rules), JSON.parse(row.tenant_ids), row.role),
    presence: PRESENCES.includes(row.presence) ? row.presence : 'available'
  };
}

export function effectivePermissions(row) {
  if (row.role === 'reseller') return BUSINESS_PERMISSIONS;
  return accessOf(row).permissions ?? OPERATOR_DEFAULT_PERMISSIONS;
}

export function scopeAllows(rules, tenantId, context) {
  const rule = rules?.[tenantId];
  if (rule === null || rule === undefined) return true;
  for (const [key, field] of scopeFields) {
    const ids = rule[key];
    if (ids === null || ids === undefined) continue;
    if (!ids.length) return false;
    if (context.aggregate === true && context[field] === undefined) continue;
    if (typeof context[field] !== 'string' || !ids.includes(context[field])) return false;
  }
  return true;
}

export function normalizePresence(value) {
  if (typeof value !== 'string' || !PRESENCES.includes(value)) invalid('Escolha disponível, ocupado, ausente ou offline.');
  return value;
}

export function ensureAccessSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(auth_users)').all().map(column => column.name));
  if (!columns.has('permissions')) db.exec('ALTER TABLE auth_users ADD COLUMN permissions TEXT');
  if (!columns.has('scope_rules')) db.exec('ALTER TABLE auth_users ADD COLUMN scope_rules TEXT');
  if (!columns.has('presence')) db.exec("ALTER TABLE auth_users ADD COLUMN presence TEXT NOT NULL DEFAULT 'available' CHECK(presence IN ('available','busy','away','offline'))");
}
