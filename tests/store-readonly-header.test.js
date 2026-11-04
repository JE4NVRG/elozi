import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ReadonlyHeaderCache } from '../src/readonly-header-cache.js';

const actor = { role: 'reseller', resellerId: 'readonly-workspace-a', name: 'Synthetic readonly actor' };
const otherActor = { ...actor, resellerId: 'readonly-workspace-b' };
const status = value => error => error.status === value;
function source() {
  return { name: 'Synthetic complete private header', privateHeader: { unknown: { array: [{ allow: true }], secret: 'synthetic-only' } },
    contacts: [{ id: 'contact', name: 'Synthetic contact', identities: [{ channelId: 'wa', kind: 'person', externalId: 'synthetic@lid', extra: { labels: ['identity'] } }], unknown: { tags: ['contact'] } }],
    channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', allowedGroups: ['123@g.us'], groupNames: { '123@g.us': 'Synthetic group' },
      telegramGroups: { mode: 'selected', groupIds: ['-123'] }, unknown: { permissions: ['private'] } }],
    departments: [{ id: 'support', memberIds: ['operator'], distribution: 'manual', unknown: { priority: 3 } }],
    agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true, instructions: 'Synthetic private instruction', tools: ['conversation.read'] }],
    automation: { version: 1, bindings: [] }, flowBindings: [{ id: 'binding', unknown: ['preserve'] }],
    conversations: Array.from({ length: 2 }, (_, index) => ({ id: `conversation-${index}`, channelId: 'wa', remoteJid: `synthetic-${index}`, remoteAliases: [],
      owner: 'agent', agentId: 'agent', status: 'open', version: 1, privateConversation: { note: `synthetic-${index}` },
      webchatVisitor: { key: 'synthetic-visitor' }, supportAssistantHandoff: { state: 'human' },
      messages: [{ id: `message-${index}`, externalId: `provider-${index}`, kind: 'customer', text: `Synthetic history ${index}` }] })) };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-readonly-header-')), path = join(directory, 'synthetic.sqlite'), store = new Store(path);
  for (const label of ['a', 'b']) {
    store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(`readonly-workspace-${label}`, '{}');
    store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(`readonly-tenant-${label}`, `readonly-workspace-${label}`, JSON.stringify(source()));
  }
  const resource = { store, path, closed: false };
  t.after(() => { if (!resource.closed) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return resource;
}
const read = (store, session = actor, id = 'conversation-0', tenant = 'readonly-tenant-a') => store.readonlyConversationTenant(session, tenant, id);
const canonical = store => JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('readonly-tenant-a').data);
const header = store => store.db.prepare('SELECT data FROM service_tenant_private WHERE tenant_id=?').get('readonly-tenant-a').data;
const write = (db, value) => db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), 'readonly-tenant-a');

test('readonly reads reuse deeply frozen complete headers while every selected conversation is parsed fresh and mutable', t => {
  const { store } = fixture(t), rawHeader = header(store), parse = JSON.parse; let parsedHeaders = 0, a, b;
  store.tenant = () => { throw new Error('Full tenant parsing is forbidden in the readonly helper'); };
  JSON.parse = (value, ...args) => { if (value === rawHeader) parsedHeaders++; return parse(value, ...args); };
  try { a = read(store); b = read(store); }
  finally { JSON.parse = parse; }
  assert.equal(parsedHeaders, 1); assert.strictEqual(a.contacts, b.contacts); assert.strictEqual(a.channels, b.channels); assert.strictEqual(a.departments, b.departments);
  assert.deepEqual(a, { id: 'readonly-tenant-a', resellerId: actor.resellerId, ...source(), conversations: [source().conversations[0]] });
  for (const nested of [a.contacts, a.contacts[0].identities, a.contacts[0].identities[0].extra.labels, a.contacts[0].unknown.tags,
    a.channels[0].allowedGroups, a.channels[0].groupNames, a.channels[0].telegramGroups.groupIds, a.channels[0].unknown.permissions,
    a.departments[0].memberIds, a.departments[0].unknown, a.privateHeader.unknown.array[0], a.flowBindings[0].unknown]) assert.ok(Object.isFrozen(nested));
  assert.throws(() => { a.contacts[0].identities[0].externalId = 'poison'; }, TypeError);
  assert.throws(() => a.channels[0].allowedGroups.push('forged@g.us'), TypeError);
  assert.throws(() => a.departments[0].memberIds.pop(), TypeError);
  assert.throws(() => { a.privateHeader.unknown.array[0].allow = false; }, TypeError);
  assert.notStrictEqual(a.conversations, b.conversations); assert.notStrictEqual(a.conversations[0], b.conversations[0]);
  a.conversations[0].messages.push({ id: 'local-only', text: 'Must never persist' }); a.conversations[0].privateConversation.note = 'local';
  assert.deepEqual(read(store).conversations[0], source().conversations[0]); assert.deepEqual(canonical(store), source());
});

test('the original conversationTenant API remains fully mutable and cannot poison the readonly cache', t => {
  const { store } = fixture(t), warm = read(store), mutable = store.conversationTenant(actor, 'readonly-tenant-a', 'conversation-0');
  assert.notStrictEqual(mutable.contacts, warm.contacts); assert.equal(Object.isFrozen(mutable.contacts), false);
  mutable.contacts[0].identities[0].externalId = 'local-only'; mutable.channels[0].allowedGroups.push('local@g.us');
  mutable.departments[0].memberIds.push('local'); mutable.privateHeader.unknown.array[0].allow = false;
  mutable.conversations[0].messages[0].text = 'local-only';
  const current = read(store); assert.strictEqual(current.contacts, warm.contacts); assert.deepEqual(current.contacts, source().contacts);
  assert.deepEqual(current.channels, source().channels); assert.deepEqual(current.departments, source().departments);
  assert.deepEqual(store.conversationTenant(actor, 'readonly-tenant-a', 'conversation-0').contacts, source().contacts); assert.deepEqual(canonical(store), source());
});

test('mutateConversation shares frozen cached metadata, preserves DB writes and returns only local conversation references', t => {
  const { store } = fixture(t), warm = read(store), queued = [];
  store.queuePostgres = id => queued.push(id);
  const result = store.mutateConversation(actor, 'readonly-tenant-a', 'conversation-0', 'Synthetic cached metadata', (conversation, metadata) => {
    assert.ok(Object.isFrozen(metadata)); assert.strictEqual(metadata.contacts, warm.contacts); assert.strictEqual(metadata.departments, warm.departments);
    assert.equal(metadata.id, 'readonly-tenant-a'); assert.equal(metadata.resellerId, actor.resellerId); assert.equal(metadata.conversations, undefined);
    assert.throws(() => { metadata.name = 'poison'; }, TypeError); assert.throws(() => metadata.contacts[0].unknown.tags.push('poison'), TypeError);
    conversation.version++; conversation.messages.push({ id: 'new-synthetic-message', externalId: 'new-provider', text: 'Synthetic persisted reply', kind: 'agent' });
    return { metadata, conversation };
  });
  const current = read(store); assert.equal(current.conversations[0].version, 2); assert.equal(current.conversations[0].messages.length, 2);
  assert.strictEqual(current.contacts, warm.contacts); assert.strictEqual(result.metadata.channels, warm.channels); assert.deepEqual(queued, ['readonly-tenant-a']);
  result.conversation.messages.push({ id: 'after-commit-local', text: 'Must never persist' });
  assert.equal(read(store).conversations[0].messages.length, 2); assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get('readonly-tenant-a').n, 1);
});

test('warm headers never bypass operator/workspace/version/target checks, and denied reads never reach the cache', t => {
  const { store } = fixture(t); read(store);
  const cache = store.readonlyHeaderCache, original = cache.read.bind(cache), originalToken = cache.readToken.bind(cache); let calls = 0;
  cache.read = (...args) => { calls++; return original(...args); };
  cache.readToken = (...args) => { const hit = originalToken(...args); if (hit !== undefined) calls++; return hit; };
  const denied = { ...actor, role: 'operator', tenantIds: ['elsewhere'] }, allowed = { ...actor, role: 'operator', tenantIds: ['readonly-tenant-a'] };
  const rejectMutation = (session, code, id = 'conversation-0') => {
    let called = false;
    assert.throws(() => store.mutateConversation(session, 'readonly-tenant-a', id, 'Must remain denied after warm cache', () => { called = true; }), status(code));
    assert.equal(called, false);
  };
  assert.throws(() => read(store, denied), status(403)); assert.throws(() => read(store, otherActor), status(404)); assert.throws(() => read(store, actor, 'missing'), status(404));
  rejectMutation(denied, 403); rejectMutation(otherActor, 404); rejectMutation(actor, 404, 'missing');
  assert.equal(calls, 0); read(store, allowed); assert.equal(calls, 1); allowed.tenantIds = [];
  assert.throws(() => read(store, allowed), status(403)); assert.equal(calls, 1);
  store.db.prepare("UPDATE service_read_model_meta SET version=5 WHERE id='routing'").run();
  assert.throws(() => read(store), status(404)); rejectMutation(actor, 404); assert.equal(calls, 1);
  store.db.prepare("DELETE FROM service_read_model_meta WHERE id='routing'").run(); assert.throws(() => read(store), status(404)); assert.equal(calls, 1);
  store.db.prepare("INSERT INTO service_read_model_meta VALUES ('routing',9)").run();
  const value = source(); value.conversations.shift(); write(store.db, value);
  assert.throws(() => read(store), status(404)); rejectMutation(actor, 404); assert.equal(calls, 1);
  write(store.db, source()); read(store); assert.equal(calls, 2);
  store.db.prepare('DELETE FROM tenants WHERE id=?').run('readonly-tenant-a'); assert.throws(() => read(store), status(404)); assert.equal(calls, 2);
});

test('raw SQL header changes invalidate without an app version while conversation-only updates retain the header and refresh history', t => {
  const { store, path } = fixture(t), raw = new DatabaseSync(path), warm = read(store), oldRaw = header(store);
  try {
    raw.prepare("UPDATE tenants SET data=json_set(data,'$.contacts[0].name','Changed by legacy writer','$.channels[0].allowedGroups',json('[\"456@g.us\"]'),'$.privateHeader.unknown.array[0].allow',json('false')) WHERE id=?").run('readonly-tenant-a');
    const current = read(store); assert.notEqual(header(store), oldRaw); assert.notStrictEqual(current.contacts, warm.contacts);
    assert.equal(current.contacts[0].name, 'Changed by legacy writer'); assert.deepEqual(current.channels[0].allowedGroups, ['456@g.us']);
    assert.equal(current.privateHeader.unknown.array[0].allow, false); assert.equal(warm.privateHeader.unknown.array[0].allow, true); assert.equal(store.readonlyHeaderCache.size, 1);
    const currentRaw = header(store);
    raw.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].version',2,'$.conversations[0].messages[0].text','Fresh history') WHERE id=?").run('readonly-tenant-a');
    const fresh = read(store); assert.equal(header(store), currentRaw); assert.strictEqual(fresh.contacts, current.contacts);
    assert.equal(fresh.conversations[0].version, 2); assert.equal(fresh.conversations[0].messages[0].text, 'Fresh history'); assert.equal(store.readonlyHeaderCache.size, 1);
  } finally { raw.close(); }
});

test('invalid canonical JSON or a malformed private header cannot serve the previous cached version', t => {
  const { store } = fixture(t), warm = read(store), cache = store.readonlyHeaderCache, original = cache.read.bind(cache); let calls = 0;
  cache.read = (...args) => { calls++; return original(...args); };
  store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run('{', 'readonly-tenant-a');
  assert.throws(() => read(store), /malformed JSON/i); assert.equal(calls, 0); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
  assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('readonly-tenant-a').data, '{');
  write(store.db, source()); assert.notStrictEqual(read(store).contacts, warm.contacts); assert.equal(cache.size, 1);
  store.db.prepare('UPDATE service_tenant_private SET data=? WHERE tenant_id=?').run('{', 'readonly-tenant-a');
  assert.throws(() => read(store), SyntaxError); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0); assert.deepEqual(canonical(store), source());
  store.serviceReadModel.rebuild(); assert.deepEqual(read(store).contacts, source().contacts);
});

test('header reuse is isolated by workspace and tenant even when every raw header byte is identical', t => {
  const { store } = fixture(t), a = read(store), b = read(store, otherActor, 'conversation-0', 'readonly-tenant-b');
  assert.deepEqual(a.contacts, b.contacts); assert.notStrictEqual(a.contacts, b.contacts); assert.equal(store.readonlyHeaderCache.size, 2);
  assert.equal(a.id, 'readonly-tenant-a'); assert.equal(b.id, 'readonly-tenant-b'); assert.equal(b.resellerId, otherActor.resellerId);
  store.db.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run(otherActor.resellerId, 'readonly-tenant-a');
  assert.throws(() => read(store), status(404)); const moved = read(store, otherActor);
  assert.equal(moved.resellerId, otherActor.resellerId); assert.notStrictEqual(moved.contacts, a.contacts); assert.notStrictEqual(moved.contacts, b.contacts);
});

test('live SQL scope and cache keys distinguish workspace a:b/tenant c from workspace a/tenant b:c', t => {
  const { store } = fixture(t);
  for (const [workspace, tenant] of [['a:b', 'c'], ['a', 'b:c']]) {
    store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspace, '{}');
    store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(tenant, workspace, JSON.stringify(source()));
  }
  const leftActor = { ...actor, resellerId: 'a:b' }, rightActor = { ...actor, resellerId: 'a' };
  const left = read(store, leftActor, 'conversation-0', 'c'), right = read(store, rightActor, 'conversation-0', 'b:c');
  assert.deepEqual(left.contacts, right.contacts); assert.notStrictEqual(left.contacts, right.contacts); assert.equal(store.readonlyHeaderCache.size, 2);
  assert.equal(left.id, 'c'); assert.equal(right.id, 'b:c'); assert.equal(left.resellerId, 'a:b'); assert.equal(right.resellerId, 'a');
  assert.throws(() => read(store, rightActor, 'conversation-0', 'c'), status(404));
  assert.throws(() => read(store, leftActor, 'conversation-0', 'b:c'), status(404));
  assert.strictEqual(read(store, leftActor, 'conversation-0', 'c').contacts, left.contacts);
  assert.strictEqual(read(store, rightActor, 'conversation-0', 'b:c').contacts, right.contacts);
});

test('a warm cache and target are read from one WAL snapshot across a concurrent header/history change or workspace move', t => {
  for (const move of [false, true]) {
    const { store, path } = fixture(t), raw = new DatabaseSync(path), warm = read(store), prepare = store.db.prepare.bind(store.db); let injected = false;
    store.db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes(' AS header') && sql.includes('FROM tenants')) {
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          const value = get(...args);
          if (!injected) {
            injected = true; const next = source(); next.contacts[0].name = 'New snapshot'; next.conversations[0].messages[0].text = 'New snapshot history';
            raw.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run(move ? otherActor.resellerId : actor.resellerId, JSON.stringify(next), 'readonly-tenant-a');
          }
          return value;
        };
      }
      return statement;
    };
    try {
      store.db.exec('BEGIN'); const old = read(store); assert.equal(injected, true);
      assert.strictEqual(old.contacts, warm.contacts); assert.equal(old.contacts[0].name, 'Synthetic contact'); assert.equal(old.conversations[0].messages[0].text, 'Synthetic history 0');
      assert.equal(read(store).conversations[0].messages[0].text, 'Synthetic history 0'); store.db.exec('ROLLBACK');
      if (move) assert.throws(() => read(store), status(404));
      const fresh = read(store, move ? otherActor : actor); assert.equal(fresh.contacts[0].name, 'New snapshot'); assert.equal(fresh.conversations[0].messages[0].text, 'New snapshot history');
      assert.notStrictEqual(fresh.contacts, warm.contacts);
    } finally { store.db.prepare = prepare; raw.close(); }
  }
});

test('oversize headers bypass retention without losing immutability and Store.close clears retained raw bytes', t => {
  const resource = fixture(t), store = resource.store, raw = header(store);
  store.readonlyHeaderCache = new ReadonlyHeaderCache({ maxHeaderBytes: Buffer.byteLength(raw) - 1 });
  const a = read(store), b = read(store); assert.deepEqual(a, b); assert.notStrictEqual(a.contacts, b.contacts);
  assert.ok(Object.isFrozen(a.contacts[0].identities[0])); assert.equal(store.readonlyHeaderCache.size, 0); assert.equal(store.readonlyHeaderCache.bytes, 0);
  store.readonlyHeaderCache = new ReadonlyHeaderCache(); read(store); const cache = store.readonlyHeaderCache;
  assert.equal(cache.size, 1); assert.equal(cache.bytes, Buffer.byteLength(raw));
  store.close(); resource.closed = true; assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
});
