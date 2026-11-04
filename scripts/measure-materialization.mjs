import { performance } from 'node:perf_hooks';

// Observe only the existing synthetic materialization. No extra SQL, payloads,
// retries or extrapolation from ninety dirty conversations to ten thousand.
export function measureMaterialization(db, materialize) {
  const prepare = db.prepare, exec = db.exec, records = [];
  let snapshotRows = 0, snapshotCounts = 0;
  const round = value => Math.round(value * 1000) / 1000;
  const observe = (label, method, receiver, original, args) => {
    const started = performance.now(); let result, ok = false;
    try { result = original.apply(receiver, args); ok = true; return result; }
    finally {
      const record = { operation: label, method, elapsedMs: round(performance.now() - started), ok };
      if (ok && method === 'run') record.changedRows = Number(result.changes);
      if (ok && method === 'all') record.returnedRows = result.length;
      records.push(record);
    }
  };
  db.prepare = function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    let label, method;
    if (/^\s*UPDATE tenants AS t SET data=/i.test(sql)) { label = 'tenantUpdateIncludingTriggers'; method = 'run'; }
    else if (/^\s*DELETE FROM conversation_journal WHERE /i.test(sql)) { label = 'journalDeleteIncludingProofs'; method = 'run'; }
    else if (/^SELECT t\.id,t\.reseller_id,/i.test(sql)) { label = `snapshotRows${++snapshotRows}`; method = 'all'; }
    else if (/^WITH current AS MATERIALIZED /i.test(sql)) { label = `snapshotCounts${++snapshotCounts}`; method = 'get'; }
    else if (/^PRAGMA foreign_key_check$/i.test(sql)) { label = 'foreignKeyCheck'; method = 'all'; }
    else if (/^PRAGMA quick_check$/i.test(sql)) { label = 'quickCheck'; method = 'get'; }
    if (method) {
      const original = statement[method];
      statement[method] = function (...values) { return observe(label, method, this, original, values); };
    }
    return statement;
  };
  db.exec = function (sql, ...args) {
    return /^\s*COMMIT\s*;?\s*$/i.test(sql)
      ? observe('commitFull', 'exec', this, exec, [sql, ...args]) : exec.call(this, sql, ...args);
  };
  const started = performance.now();
  try {
    const receipt = materialize();
    return { receipt, diagnostics: { elapsedMs: round(performance.now() - started), records,
      method: 'Existing materialization only. UPDATE/DELETE include their triggers; snapshot SQL excludes JS hashing. Records are subsets of the inclusive total and must not be added to it. Unobserved work remains unattributed.' } };
  } finally { db.prepare = prepare; db.exec = exec; }
}
