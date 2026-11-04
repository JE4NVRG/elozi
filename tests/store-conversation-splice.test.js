import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createEventBus } from '../src/events.js';
import { SCOPED_REPLACEMENT_PROOF_ERROR } from '../src/service-read-model.js';

function source() {
  return { name: 'Synthetic splice fixture', privateHeader: { keep: 'synthetic-only' }, contacts: [],
    channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }], agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [],
    conversations: [{ id: 'target', channelId: 'wa', remoteJid: 'synthetic-target', remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1,
      privateField: { keep: true }, messages: [{ id: 'old-target', externalId: 'old-provider', kind: 'customer', text: 'Synthetic old history' }] },
    { id: 'sibling', channelId: 'wa', remoteJid: 'synthetic-sibling', remoteAliases: [], owner: 'queue', status: 'open', version: 1,
      messages: [{ id: 'old-sibling', kind: 'customer', text: 'Synthetic sibling history' }] }] };
}
const change = conversation => { conversation.version++; conversation.messages.push({ id: 'new-message', externalId: 'new-provider', kind: 'agent', text: 'Synthetic new reply' }); };
const canonical = db => db.prepare('SELECT data FROM tenants WHERE id=?').get('splice-tenant').data;
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
function fixture(t, { value = source(), rawSource } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-splice-fixture-')), path = join(directory, 'synthetic.sqlite'), store = new Store(path);
  const actor = { role: 'reseller', resellerId: 'splice-workspace', name: 'Synthetic splice actor' };
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(actor.resellerId, '{}');
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('splice-tenant', actor.resellerId, rawSource ?? JSON.stringify(value));
  store.db.exec(`CREATE TABLE synthetic_wa_seen(id TEXT PRIMARY KEY);
    CREATE TABLE synthetic_statement_effects(phase TEXT NOT NULL);
    CREATE TRIGGER synthetic_splice_before BEFORE UPDATE OF data ON tenants WHEN OLD.id='splice-tenant'
      BEGIN INSERT INTO synthetic_statement_effects VALUES ('before'); END;
    CREATE TRIGGER synthetic_splice_after AFTER UPDATE OF data ON tenants WHEN OLD.id='splice-tenant'
      BEGIN INSERT INTO synthetic_statement_effects VALUES ('after'); END;`);
  const state = { store, actor, value, originalRaw: canonical(store.db), callbacks: 0, bridges: 0, attempts: [], failures: [], events: [], injectedError: null };
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (/^\s*UPDATE\s+tenants\s+SET\s+data\s*=/i.test(sql) && sql.includes('service_tenant_private')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        const attempt = { kind: /\binstr\s*\(/i.test(sql) ? 'replacement' : 'fallback' }; state.attempts.push(attempt);
        try {
          const injected = state.injectedError?.(attempt, state.attempts.length); if (injected) throw injected;
          const result = run(...args); attempt.changes = result.changes; return result;
        } catch (error) {
          attempt.error = error;
          state.failures.push({ raw: canonical(store.db), statementEffects: count(store.db, 'synthetic_statement_effects'), seen: count(store.db, 'synthetic_wa_seen'),
            audits: store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get('splice-tenant').n,
            guard: store.db.prepare('SELECT validated,strict_write FROM service_conversation_write_guard WHERE tenant_id=?').get('splice-tenant') });
          throw error;
        }
      };
    }
    return statement;
  };
  store.queuePostgres = () => { state.bridges++; };
  store.events = createEventBus(); store.events.subscribe(event => state.events.push(event));
  t.after(() => { store.events.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  state.mutate = (mutate = change) => store.mutateConversation(actor, 'splice-tenant', 'target', 'Synthetic splice mutation', conversation => {
    state.callbacks++; store.db.prepare('INSERT INTO synthetic_wa_seen VALUES (?)').run('one-domain-effect'); return mutate(conversation);
  });
  return state;
}
function expected(f, mutate = change) {
  const next = structuredClone(f.value); mutate(next.conversations[0]);
  const raw = f.store.db.prepare("SELECT json_set(?,'$.conversations[0]',json(?)) AS data").get(f.originalRaw, JSON.stringify(next.conversations[0])).data;
  return { value: next, raw };
}
function assertCommitted(f, wanted) {
  assert.equal(canonical(f.store.db), wanted.raw); assert.deepEqual(JSON.parse(canonical(f.store.db)), wanted.value);
  assert.equal(f.callbacks, 1); assert.equal(f.bridges, 1); assert.equal(count(f.store.db, 'synthetic_wa_seen'), 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get('splice-tenant').n, 1);
  assert.deepEqual(f.store.db.prepare('SELECT phase FROM synthetic_statement_effects ORDER BY rowid').all().map(row => row.phase), ['before', 'after']);
  assert.equal(f.events.filter(event => event.type === 'conversation.message' && event.messageId === 'new-message').length, 1);
  assert.ok(f.events.every(event => !event.conversationId || event.conversationId === 'target'));
  assert.equal(count(f.store.db, 'service_conversation_write_guard'), 0);
  assert.deepEqual(f.store.readonlyConversationTenant(f.actor, 'splice-tenant', 'target').conversations[0], wanted.value.conversations[0]);
}
function assertRolledBack(f, raw = f.originalRaw) {
  assert.equal(canonical(f.store.db), raw); assert.equal(count(f.store.db, 'synthetic_wa_seen'), 0); assert.equal(count(f.store.db, 'synthetic_statement_effects'), 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get('splice-tenant').n, 0);
  assert.equal(f.bridges, 0); assert.deepEqual(f.events, []); assert.equal(count(f.store.db, 'service_conversation_write_guard'), 0);
}

test('a byte-identical nested header object before the array aborts the wrong first splice and retries SQL without repeating any domain effect', t => {
  const base = source(), { conversations, ...header } = base, value = { ...header, nestedIdentical: { object: structuredClone(conversations[0]) }, conversations };
  const f = fixture(t, { value }), wanted = expected(f);
  f.mutate(); assertCommitted(f, wanted);
  assert.deepEqual(f.attempts.map(attempt => attempt.kind), ['replacement', 'fallback']);
  assert.equal(f.attempts[0].error.code, 'ERR_SQLITE_ERROR'); assert.equal(f.attempts[0].error.errcode, 1811); assert.equal(f.attempts[0].error.message, SCOPED_REPLACEMENT_PROOF_ERROR);
  assert.equal(f.attempts[1].changes, 1); assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].raw, f.originalRaw); assert.equal(f.failures[0].statementEffects, 0); assert.equal(f.failures[0].seen, 1); assert.equal(f.failures[0].audits, 0);
  assert.equal(f.failures[0].guard.validated, 0); assert.equal(f.failures[0].guard.strict_write, 1);
  assert.deepEqual(wanted.value.nestedIdentical.object, base.conversations[0]); assert.deepEqual(wanted.value.conversations[1], base.conversations[1]);
});

test('compact, pretty, BMP/non-BMP, escaped literals and escaped NUL remain exactly equivalent to the independent canonical JSON update', t => {
  for (const mode of ['compact', 'pretty', 'escaped']) {
    const value = source(); value.privateHeader.keep = 'ç🌙前\\literal\n'; value.conversations[0].messages[0].text = 'á🌙前 "quote" \\ slash \u0000 tail';
    let rawSource = JSON.stringify(value, null, mode === 'pretty' ? 2 : undefined);
    if (mode === 'escaped') rawSource = rawSource.replaceAll('🌙', '\\ud83c\\udf19').replaceAll('á', '\\u00e1').replaceAll('前', '\\u524d');
    const f = fixture(t, { value, rawSource }), wanted = expected(f); f.mutate(); assertCommitted(f, wanted);
    assert.ok(f.attempts.length >= 1 && f.attempts.length <= 2);
    if (f.attempts.length === 2) assert.equal(f.attempts[0].error.message, SCOPED_REPLACEMENT_PROOF_ERROR);
  }
});

test('a semantically identical private raw conversation absent from canonical text takes the safe JSON update inside one SQL attempt', t => {
  const f = fixture(t), pretty = JSON.stringify(f.value.conversations[0], null, 2);
  f.store.db.prepare('UPDATE service_conversation_private SET data=? WHERE tenant_id=? AND id=?').run(pretty, 'splice-tenant', 'target');
  assert.equal(f.originalRaw.includes(pretty), false); const wanted = expected(f);
  f.mutate(); assertCommitted(f, wanted); assert.equal(f.attempts.length, 1); assert.equal(f.attempts[0].changes, 1); assert.deepEqual(f.failures, []);
});

test('duplicate IDs and identical later objects never change a later position or pretend lookup coverage is complete', t => {
  for (const identical of [false, true]) {
    const value = source(); value.conversations[1] = identical ? structuredClone(value.conversations[0]) : { ...value.conversations[1], id: 'target', channelId: 'other' };
    const f = fixture(t, { value }), wanted = expected(f); f.mutate(); assertCommitted(f, wanted);
    assert.deepEqual(JSON.parse(canonical(f.store.db)).conversations[1], value.conversations[1]);
    assert.equal(f.store.serviceReadModel.lookupConversationIds({ tenantId: 'splice-tenant', workspaceId: f.actor.resellerId, channelId: 'wa', kind: 'external', values: ['new-provider'] }), null);
    assert.equal(f.attempts.length, 1);
  }
});

test('callback changes to current header, target, position, workspace, identity or role cannot turn CAS denial into a retry', t => {
  for (const mode of ['header', 'target', 'position', 'workspace', 'identity', 'role']) {
    const f = fixture(t);
    assert.throws(() => f.mutate(conversation => {
      if (mode === 'header') f.store.db.prepare("UPDATE tenants SET data=json_set(data,'$.privateHeader.keep','changed') WHERE id=?").run('splice-tenant');
      if (mode === 'target') f.store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].version',99) WHERE id=?").run('splice-tenant');
      if (mode === 'position') { const moved = structuredClone(f.value); moved.conversations.reverse(); f.store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(moved), 'splice-tenant'); }
      if (mode === 'workspace') f.store.db.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run('mep-demo', 'splice-tenant');
      if (mode === 'identity') conversation.id = 'changed-id';
      if (mode === 'role') { f.actor.role = 'operator'; f.actor.tenantIds = ['denied']; }
      change(conversation);
    }), error => error.status === (mode === 'role' ? 403 : 409));
    assert.equal(f.callbacks, 1); assert.ok(f.attempts.length <= 1); assert.equal(f.attempts.some(attempt => attempt.kind === 'fallback'), false);
    if (f.attempts.length) assert.equal(f.attempts[0].changes, 0);
    assertRolledBack(f);
  }
});

test('only the exact SQLite trigger proof error may retry the first SQL statement; unrelated and crossed error identities propagate', t => {
  for (const properties of [
    { code: 'ERR_SQLITE_ERROR', errcode: 1811, message: 'Synthetic unrelated trigger error' },
    { code: 'OTHER_ERROR', errcode: 1811, message: SCOPED_REPLACEMENT_PROOF_ERROR },
    { code: 'ERR_SQLITE_ERROR', errcode: 5, message: SCOPED_REPLACEMENT_PROOF_ERROR }
  ]) {
    const f = fixture(t), failure = Object.assign(new Error(properties.message), properties);
    f.injectedError = () => failure;
    assert.throws(() => f.mutate(), error => error === failure); assert.equal(f.callbacks, 1); assert.equal(f.attempts.length, 1); assertRolledBack(f);
  }
});

test('a failing fallback, even carrying the same proof identity, is propagated without a third SQL attempt or hidden domain replay', t => {
  const base = source(), { conversations, ...header } = base, f = fixture(t, { value: { ...header, nestedIdentical: structuredClone(conversations[0]), conversations } });
  const failure = Object.assign(new Error(SCOPED_REPLACEMENT_PROOF_ERROR), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
  f.injectedError = (_attempt, index) => index === 2 ? failure : null;
  assert.throws(() => f.mutate(), error => error === failure); assert.equal(f.callbacks, 1); assert.equal(f.attempts.length, 2); assertRolledBack(f);
});

test('a domain callback error matching the proof identity and malformed canonical input never enter SQL retry handling', t => {
  const f = fixture(t), failure = Object.assign(new Error(SCOPED_REPLACEMENT_PROOF_ERROR), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
  assert.throws(() => f.mutate(() => { throw failure; }), error => error === failure);
  assert.equal(f.callbacks, 1); assert.deepEqual(f.attempts, []); assertRolledBack(f);
  const malformed = fixture(t, { rawSource: '{' }); assert.throws(() => malformed.mutate(), /malformed JSON/i);
  assert.equal(malformed.callbacks, 0); assert.deepEqual(malformed.attempts, []); assertRolledBack(malformed);
});
