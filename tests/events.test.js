import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus, createEventStreamHub, diffTenant, diffTenantChannels, diffTenantConversations, diffTenantRuns, indexTenantChannels, indexTenantConversations, indexTenantRuns,
  scopeEvent, snapshotTenant, visibleTo } from '../src/events.js';
import { Store } from '../src/store.js';

const status = expected => error => error.status === expected;
const settle = () => new Promise(resolve => setImmediate(resolve));
const message = (id, kind, text, extra = {}) => ({ id, kind, text, createdAt: '2026-10-06T12:00:00.000Z', ...extra });
const conversation = (id, extra = {}) => ({ id, contact: 'Maria Sintética', phone: '+55 11 90000-0000', remoteJid: '5511900000000@s.whatsapp.net', channelId: 'wa-1',
  departmentId: null, owner: 'queue', agentId: null, assignedUserId: null, status: 'open', version: 1, tags: ['VIP'], messages: [], ...extra });
const tenant = conversations => ({ id: 'tenant-a', name: 'Empresa A', conversations: structuredClone(conversations) });
const pointerFields = new Set(['id', 'at', 'type', 'tenantId', 'conversationId', 'channelId', 'departmentId', 'owner', 'agentId', 'assignedUserId', 'status', 'version',
  'conversationKind', 'messageId', 'kind', 'changes', 'previous', 'truncated', 'left']);

test('diff produz somente ponteiros: criação, mensagem anexada, atualização de rota e remoção', () => {
  const before = tenant([conversation('c1', { messages: [message('m1', 'customer', 'Meu CPF é 123.456.789-00')] }), conversation('c-old')]);
  const after = structuredClone(before);
  after.conversations[0].messages.push(message('m2', 'customer', 'Segue meu endereço: Rua Secreta, 42', { attachments: [{ id: 'a1', name: 'rg.jpg', url: 'https://private.example/rg.jpg' }] }));
  after.conversations[0].version = 2;
  after.conversations.push(conversation('c2', { owner: 'agent', agentId: 'hermes-1', messages: [message('n1', 'customer', 'Olá, sou a Ana')] }));
  after.conversations.splice(1, 1);
  const events = diffTenantConversations(before, after);
  assert.deepEqual(events.map(event => [event.type, event.conversationId, event.messageId ?? null]), [
    ['conversation.message', 'c1', 'm2'], ['conversation.created', 'c2', null], ['conversation.message', 'c2', 'n1'], ['conversation.removed', 'c-old', null]]);
  const serialized = JSON.stringify(events);
  for (const secret of ['CPF', '123.456', 'Rua Secreta', 'rg.jpg', 'private.example', 'Maria', 'Ana', '+55', 's.whatsapp.net', 'VIP']) assert.equal(serialized.includes(secret), false, secret);
  for (const event of events) for (const key of Object.keys(event)) assert.ok(pointerFields.has(key), key);
  assert.deepEqual(events[0], { type: 'conversation.message', tenantId: 'tenant-a', conversationId: 'c1', channelId: 'wa-1', departmentId: null, owner: 'queue', agentId: null,
    assignedUserId: null, status: 'open', version: 2, conversationKind: 'direct', messageId: 'm2', kind: 'customer' });
  // A version step caused only by appended messages does not create a separate update.
  assert.equal(events.some(event => event.type === 'conversation.updated'), false);
});

test('diff descreve mudança de responsável com campos alterados e valores anteriores', () => {
  const before = tenant([conversation('c1', { owner: 'agent', agentId: 'hermes-1', version: 4, messages: [message('m1', 'customer', 'oi')] })]);
  const after = structuredClone(before), item = after.conversations[0];
  Object.assign(item, { owner: 'human', agentId: null, assignedUserId: 'user-7', version: 5 });
  item.messages.push(message('s1', 'system', 'Atendimento atribuído a Joana.'));
  const [first, second] = diffTenantConversations(indexTenantConversations(before), after);
  assert.equal(first.type, 'conversation.message'); assert.equal(first.kind, 'system');
  assert.equal(second.type, 'conversation.updated');
  assert.deepEqual(second.changes, ['owner', 'agentId', 'assignedUserId', 'version']);
  assert.deepEqual(second.previous, { owner: 'agent', agentId: 'hermes-1', assignedUserId: null, version: 4 });
  // A version-only change without appended messages (tags, read state) is still announced.
  const tagged = structuredClone(after); tagged.conversations[0].version = 6; tagged.conversations[0].tags = ['Outro'];
  const [update] = diffTenantConversations(after, tagged);
  assert.deepEqual(update.changes, ['version']); assert.equal(JSON.stringify(update).includes('Outro'), false);
  assert.deepEqual(diffTenantConversations(tagged, structuredClone(tagged)), []);
});

test('diff tolera histórico reescrito e limita rajadas sem copiar texto', () => {
  const before = tenant([conversation('c1', { messages: [message('m1', 'customer', 'a'), message('m2', 'customer', 'b')] })]);
  const merged = structuredClone(before); merged.conversations[0].messages = [message('m2', 'customer', 'b'), message('m3', 'customer', 'c')]; merged.conversations[0].version = 3;
  const events = diffTenantConversations(before, merged);
  assert.deepEqual(events.map(event => event.type), ['conversation.message', 'conversation.updated']);
  assert.equal(events[0].messageId, 'm3'); assert.ok(events[1].changes.includes('messages'));
  const burst = structuredClone(before); burst.conversations[0].version = 9;
  for (let index = 0; index < 8; index++) burst.conversations[0].messages.push(message(`b${index}`, 'customer', 'texto'));
  const limited = diffTenantConversations(before, burst, { messageLimit: 3 });
  assert.deepEqual(limited.filter(event => event.type === 'conversation.message').map(event => event.messageId), ['b5', 'b6', 'b7']);
  assert.equal(limited.at(-1).truncated, true);
  assert.throws(() => diffTenantConversations(before, burst, { messageLimit: 0 }), TypeError);
});

test('publish remove qualquer campo fora da allowlist de ponteiros', t => {
  const bus = createEventBus({ now: () => Date.parse('2026-10-06T12:00:00Z') }); t.after(() => bus.close());
  const event = bus.publish({ type: 'conversation.message', tenantId: 'tenant-a', conversationId: 'c1', messageId: 'm1', kind: 'customer', version: 3,
    text: 'segredo', contact: { name: 'Maria' }, previous: { owner: 'queue', text: 'x' }, changes: ['owner', 'texto com espaço'], draft: 'rascunho' });
  assert.deepEqual(Object.keys(event).sort(), ['at', 'changes', 'conversationId', 'id', 'kind', 'messageId', 'previous', 'tenantId', 'type', 'version']);
  assert.deepEqual(event.previous, { owner: 'queue' }); assert.deepEqual(event.changes, ['owner']);
  assert.ok(Object.isFrozen(event)); assert.equal(event.at, '2026-10-06T12:00:00.000Z');
  assert.throws(() => bus.publish({ type: 'conversation.message' }), status(400));
  assert.throws(() => bus.publish({ type: 'Not A Type', tenantId: 'tenant-a' }), status(400));
});

test('ring por empresa, cursor opaco e resync quando o cursor saiu do ring ou do processo', t => {
  const bus = createEventBus({ ringSize: 3 }); t.after(() => bus.close());
  const start = bus.since('tenant-a', null);
  assert.equal(start.resync, true); assert.deepEqual(start.events, []);
  const first = bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1', version: 2 });
  bus.publish({ type: 'conversation.updated', tenantId: 'tenant-b', conversationId: 'x1', version: 1 });
  const partial = bus.since('tenant-a', start.cursor);
  assert.equal(partial.resync, false); assert.deepEqual(partial.events.map(event => event.id), [first.id]);
  // Other tenants never appear, and the global sequence still advances the cursor past them.
  const others = bus.since('tenant-b', start.cursor).events;
  assert.deepEqual(others.map(event => [event.tenantId, event.conversationId]), [['tenant-b', 'x1']]);
  for (let version = 3; version <= 6; version++) bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1', version });
  const lost = bus.since('tenant-a', start.cursor);
  assert.equal(lost.resync, true); assert.deepEqual(lost.events, []); assert.equal(lost.cursor, bus.head());
  const recent = bus.since('tenant-a', partial.cursor);
  assert.equal(recent.resync, true, 'four events after the cursor do not fit a ring of three');
  const fresh = bus.since('tenant-a', bus.since('tenant-a', lost.cursor).cursor);
  assert.equal(fresh.resync, false); assert.deepEqual(fresh.events, []);
  // Paged reads keep order and point the cursor at the last delivered event.
  const anchor = bus.head();
  for (let version = 7; version <= 9; version++) bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1', version });
  const page = bus.since('tenant-a', anchor, { limit: 2 });
  assert.deepEqual(page.events.map(event => event.version), [7, 8]); assert.equal(page.more, true);
  assert.deepEqual(bus.since('tenant-a', page.cursor).events.map(event => event.version), [9]);
  // Restart (another boot id), forged future cursor and malformed cursors.
  const restarted = createEventBus(); t.after(() => restarted.close());
  assert.equal(restarted.since('tenant-a', anchor).resync, true);
  assert.equal(bus.since('tenant-a', `${bus.bootId}-zzzz`).resync, true);
  assert.throws(() => bus.since('tenant-a', 'nao-e-cursor'), status(400));
  assert.throws(() => bus.since('tenant-a', anchor, { limit: 0 }), status(400));
  assert.throws(() => bus.since('', anchor), status(400));
});

test('empresas esquecidas pelo limite de rings sempre pedem resync', t => {
  const bus = createEventBus({ maxTenants: 1 }); t.after(() => bus.close());
  const cursor = bus.head();
  bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1', version: 2 });
  bus.publish({ type: 'conversation.updated', tenantId: 'tenant-b', conversationId: 'x1', version: 2 });
  assert.equal(bus.since('tenant-a', cursor).resync, true);
  assert.equal(bus.since('tenant-b', cursor).events.length, 1);
  assert.equal(bus.since('tenant-c', cursor).resync, true, 'an unknown tenant below the dropped floor is conservative');
});

test('waitFor expira sem eventos, acorda com evento visível e ignora eventos fora do filtro', async t => {
  const bus = createEventBus(); t.after(() => bus.close());
  const cursor = bus.head();
  const startedAt = performance.now(), empty = await bus.waitFor({ tenantId: 'tenant-a', cursor, timeoutMs: 30 });
  assert.equal(empty.timedOut, true); assert.deepEqual(empty.events, []); assert.ok(performance.now() - startedAt >= 25);
  const scope = { channelIds: ['wa-1'], departmentIds: null };
  const waiting = bus.waitFor({ tenantId: 'tenant-a', cursor: empty.cursor, timeoutMs: 5000, filter: { scope } });
  let resolved = false; waiting.then(() => { resolved = true; });
  bus.publish({ type: 'conversation.updated', tenantId: 'tenant-b', conversationId: 'x1', channelId: 'wa-1', version: 2 });
  bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c9', channelId: 'wa-2', version: 2 });
  await settle(); assert.equal(resolved, false, 'events of another tenant or outside the scope do not wake the waiter');
  const visible = bus.publish({ type: 'conversation.message', tenantId: 'tenant-a', conversationId: 'c1', channelId: 'wa-1', messageId: 'm1', kind: 'customer', version: 3 });
  const woke = await waiting;
  assert.deepEqual(woke.events.map(event => event.id), [visible.id]); assert.equal(woke.resync, false);
  assert.deepEqual((await bus.waitFor({ tenantId: 'tenant-a', cursor: woke.cursor, timeoutMs: 0 })).events, []);
  // Immediate return when events are already waiting, and without a cursor (resync).
  assert.equal((await bus.waitFor({ tenantId: 'tenant-a', cursor: empty.cursor, timeoutMs: 5000 })).events.length, 2);
  assert.equal((await bus.waitFor({ tenantId: 'tenant-a', timeoutMs: 5000 })).resync, true);
});

test('waitFor respeita cancelamento, limites de espera e encerramento do barramento', async t => {
  const bus = createEventBus({ maxWaiters: 2, maxWaitersPerTenant: 1 }); t.after(() => bus.close());
  const controller = new AbortController(), cursor = bus.head();
  const aborted = bus.waitFor({ tenantId: 'tenant-a', cursor, timeoutMs: 5000, signal: controller.signal });
  await assert.rejects(bus.waitFor({ tenantId: 'tenant-a', cursor, timeoutMs: 5000 }), status(429));
  controller.abort(Object.assign(new Error('cliente desconectou'), { status: 499 }));
  await assert.rejects(aborted, status(499));
  const pending = bus.waitFor({ tenantId: 'tenant-a', cursor, timeoutMs: 5000 });
  assert.equal(bus.stats().waiters, 1);
  bus.close();
  const closed = await pending;
  assert.equal(closed.closed, true); assert.deepEqual(closed.events, []); assert.equal(bus.stats().waiters, 0);
  assert.equal(bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1' }), null);
  await assert.rejects(bus.waitFor({ tenantId: 'tenant-a', cursor, timeoutMs: -1 }), status(400));
});

test('assinantes recebem eventos filtrados, falhas ficam isoladas e unsubscribe encerra a entrega', t => {
  const failures = [], bus = createEventBus({ onError: error => failures.push(error.message) }); t.after(() => bus.close());
  const seen = [], all = [];
  const stop = bus.subscribe({ tenantId: 'tenant-a', types: ['conversation.message'] }, event => seen.push(event.messageId));
  bus.subscribe(() => { throw new Error('assinante quebrado'); });
  bus.subscribe(event => all.push(event.type));
  bus.publish({ type: 'conversation.message', tenantId: 'tenant-a', conversationId: 'c1', messageId: 'm1', kind: 'customer' });
  bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1' });
  bus.publish({ type: 'conversation.message', tenantId: 'tenant-b', conversationId: 'x1', messageId: 'x-m1', kind: 'customer' });
  stop();
  bus.publish({ type: 'conversation.message', tenantId: 'tenant-a', conversationId: 'c1', messageId: 'm2', kind: 'customer' });
  assert.deepEqual(seen, ['m1']); assert.equal(all.length, 4); assert.equal(failures.length, 4);
  assert.throws(() => bus.subscribe({ types: 'conversation.message' }, () => {}), TypeError);
});

test('escopo de serviço: canais, departamentos, agente, grupos e saída do escopo', () => {
  const base = { id: 'e1', at: '2026-10-06T12:00:00.000Z', type: 'conversation.message', tenantId: 'tenant-a', conversationId: 'c1', channelId: 'wa-1',
    departmentId: null, owner: 'queue', agentId: null, conversationKind: 'direct', messageId: 'm1', kind: 'customer', version: 2 };
  assert.equal(visibleTo(base, { channelIds: null, departmentIds: null }), true);
  assert.equal(visibleTo(base, { channelIds: ['wa-1'], departmentIds: ['unassigned'] }), true);
  assert.equal(visibleTo(base, { channelIds: ['wa-2'], departmentIds: null }), false);
  assert.equal(visibleTo(base, { channelIds: null, departmentIds: ['dep-1'] }), false);
  assert.equal(visibleTo(base, { tenantId: 'tenant-b', channelIds: null, departmentIds: null }), false);
  assert.equal(visibleTo({ ...base, departmentId: 'dep-1' }, { channelIds: null, departmentIds: ['dep-1'] }), true);
  const other = { ...base, owner: 'agent', agentId: 'agent-2' };
  assert.equal(visibleTo(other, { channelIds: null, departmentIds: null, agentId: 'agent-1' }), false);
  assert.equal(visibleTo({ ...other, agentId: 'agent-1' }, { channelIds: null, departmentIds: null, agentId: 'agent-1', assignedOnly: true }), true);
  assert.equal(visibleTo(base, { channelIds: null, departmentIds: null, agentId: 'agent-1', assignedOnly: true }), false);
  assert.equal(visibleTo({ ...base, conversationKind: 'group' }, { channelIds: null, departmentIds: null }), false);
  assert.equal(visibleTo({ ...base, conversationKind: 'group' }, { channelIds: null, departmentIds: null, includeGroups: true }), true);
  assert.equal(visibleTo(base, null), false); assert.equal(visibleTo(base, { channelIds: 'wa-1', departmentIds: null }), false);
  // Moving out of scope: the previous location keeps the event visible, but the projection hides the new route.
  const moved = { ...base, type: 'conversation.updated', departmentId: 'dep-secret', changes: ['departmentId', 'version'], previous: { departmentId: null, version: 1 } };
  const scope = { channelIds: ['wa-1'], departmentIds: ['unassigned'] };
  assert.equal(visibleTo(moved, scope), true);
  assert.deepEqual(scopeEvent(moved, scope), { id: 'e1', at: base.at, type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1', version: 2, changes: ['departmentId', 'version'], left: true });
  // Moving into scope: the out-of-scope origin is not disclosed.
  const entered = { ...moved, departmentId: null, previous: { departmentId: 'dep-secret', version: 1 } };
  assert.deepEqual(scopeEvent(entered, scope).previous, { version: 1 });
  assert.equal(scopeEvent(base, { channelIds: ['wa-2'], departmentIds: null }), null);
  assert.equal(scopeEvent(base, scope), base);
});

test('since, waitFor e subscribe com escopo entregam a projeção e nunca a rota de destino', async t => {
  const bus = createEventBus(); t.after(() => bus.close());
  const scope = { channelIds: ['wa-1'], departmentIds: ['unassigned'] }, cursor = bus.head(), delivered = [];
  bus.subscribe({ tenantId: 't1', scope }, event => delivered.push(event));
  const waiting = bus.waitFor({ tenantId: 't1', cursor, filter: { scope }, timeoutMs: 5000 });
  const raw = bus.publish({ type: 'conversation.updated', tenantId: 't1', conversationId: 'c1', channelId: 'wa-1', departmentId: 'dep-secreto', owner: 'human',
    assignedUserId: 'user-diretoria', version: 4, changes: ['departmentId', 'owner', 'assignedUserId', 'version'],
    previous: { departmentId: null, owner: 'queue', assignedUserId: null, version: 3 } });
  const expected = { id: raw.id, at: raw.at, type: 'conversation.updated', tenantId: 't1', conversationId: 'c1', version: 4,
    changes: ['departmentId', 'owner', 'assignedUserId', 'version'], left: true };
  assert.deepEqual(bus.since('t1', cursor, { filter: { scope } }).events, [expected]);
  assert.deepEqual((await waiting).events, [expected]);
  assert.deepEqual(delivered, [expected]);
  for (const event of [...delivered, ...bus.since('t1', cursor, { filter: { scope } }).events]) {
    assert.equal(JSON.stringify(event).includes('dep-secreto'), false); assert.equal(JSON.stringify(event).includes('user-diretoria'), false);
  }
  // Without a scope the raw pointer is delivered (administrative consumers).
  assert.equal(bus.since('t1', cursor).events[0].departmentId, 'dep-secreto');
});

test('espera acorda só com evento que combina, pede resync quando o ring transborda e close exige resync', async t => {
  const bus = createEventBus({ ringSize: 3 }); t.after(() => bus.close());
  let checks = 0;
  const filter = event => { checks++; return event.conversationId === 'alvo'; };
  const quiet = bus.waitFor({ tenantId: 'tenant-a', cursor: bus.head(), filter, timeoutMs: 5000 });
  for (let index = 0; index < 2; index++) bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: `ruido-${index}`, version: index + 1 });
  assert.equal(checks, 2, 'each publication checks only the new event against the waiter');
  const hit = bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'alvo', version: 9 });
  assert.deepEqual((await quiet).events.map(event => event.id), [hit.id]);
  // More non-matching events than the ring holds: the waiter can no longer prove nothing was missed.
  const overflow = bus.waitFor({ tenantId: 'tenant-a', cursor: bus.head(), filter: () => false, timeoutMs: 5000 });
  for (let index = 0; index < 4; index++) bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: `ruido-${index}`, version: 20 + index });
  assert.equal((await overflow).resync, true);
  const old = bus.head();
  bus.publish({ type: 'conversation.updated', tenantId: 'tenant-a', conversationId: 'c1', version: 30 });
  const head = bus.head();
  bus.close();
  assert.deepEqual(bus.since('tenant-a', old), { events: [], cursor: head, resync: true, closed: true }, 'a cursor behind the head resyncs after close');
  assert.deepEqual(bus.since('tenant-a', head), { events: [], cursor: head, resync: false, closed: true });
});

test('diff reancora mensagens anexadas quando a última conhecida some na mesma mutação', () => {
  const before = tenant([conversation('c1', { owner: 'agent', agentId: 'hermes-1', messages: [message('m1', 'customer', 'a'), message('m2', 'system', 'aviso')] })]);
  const after = structuredClone(before);
  after.conversations[0].messages = [message('m1', 'customer', 'a'), message('m3', 'customer', 'nova pergunta')]; after.conversations[0].version = 3;
  const events = diffTenantConversations(indexTenantConversations(before), after);
  assert.deepEqual(events.map(event => [event.type, event.messageId ?? null]), [['conversation.message', 'm3'], ['conversation.updated', null]]);
  assert.ok(events[1].changes.includes('messages'));
  // No surviving anchor at all: the update carries `messages` so consumers re-read the conversation.
  const replaced = structuredClone(before); replaced.conversations[0].messages = [message('z1', 'customer', 'outra')]; replaced.conversations[0].version = 5;
  const [update, ...rest] = diffTenantConversations(before, replaced);
  assert.equal(update.type, 'conversation.updated'); assert.ok(update.changes.includes('messages')); assert.deepEqual(rest, []);
});

test('ponteiros resolvem departamento legado pelo nome como a caixa única e anunciam runs e canais sem conteúdo', () => {
  const before = { id: 'tenant-a', departments: [{ id: 'dep-sup', name: 'Suporte' }, { id: 'dep-dup', name: 'Suporte' }],
    channels: [{ id: 'wa-1', state: 'connected', token: 'segredo-do-canal' }],
    conversations: [conversation('c1', { departmentId: undefined, department: 'Suporte', messages: [message('m1', 'customer', 'oi')] })],
    runs: [{ id: 'r1', conversationId: 'c1', state: 'running', version: 1, updatedAt: '2026-10-06T12:00:00.000Z', draft: null }] };
  const after = structuredClone(before);
  after.conversations[0].messages.push(message('m2', 'customer', 'Pedido 123 do CPF secreto')); after.conversations[0].version = 2;
  Object.assign(after.runs[0], { state: 'draft', version: 2, draft: 'Rascunho com dado privado', updatedAt: '2026-10-06T12:00:05.000Z' });
  after.runs.push({ id: 'r-orphan', conversationId: 'gone', state: 'draft', version: 1, draft: 'x' });
  after.channels[0].state = 'logged_out'; after.channels.push({ id: 'tg-1', state: 'disconnected' });
  const [messageEvent] = diffTenantConversations(indexTenantConversations(before), after);
  assert.equal(messageEvent.departmentId, 'dep-sup', 'first department with the legacy name, like the inbox');
  assert.deepEqual(diffTenantRuns(indexTenantRuns(before), after), [{ type: 'run.changed', tenantId: 'tenant-a', conversationId: 'c1', channelId: 'wa-1',
    departmentId: 'dep-sup', owner: 'queue', agentId: null, assignedUserId: null, status: 'open', version: 2, conversationKind: 'direct', runId: 'r1', state: 'draft' }]);
  assert.deepEqual(diffTenantRuns(indexTenantRuns(after), after), [], 'unchanged runs are silent');
  assert.deepEqual(diffTenantChannels(indexTenantChannels(before), after), [{ type: 'channel.state', tenantId: 'tenant-a', channelId: 'wa-1', state: 'logged_out' },
    { type: 'channel.state', tenantId: 'tenant-a', channelId: 'tg-1', state: 'disconnected' }]);
  const all = diffTenant(snapshotTenant(before), after);
  assert.deepEqual(all.map(event => event.type), ['conversation.message', 'run.changed', 'channel.state', 'channel.state']);
  const serialized = JSON.stringify(all);
  for (const secret of ['CPF', 'Rascunho', 'segredo-do-canal', 'r-orphan', 'Maria']) assert.equal(serialized.includes(secret), false, secret);
  assert.throws(() => diffTenant(indexTenantConversations(before), after), TypeError);
  // run.changed pointers keep their runId and state through the publish allowlist.
  const bus = createEventBus(); const published = bus.publish(all[1]); bus.close();
  assert.equal(published.runId, 'r1'); assert.equal(published.state, 'draft'); assert.equal(published.departmentId, 'dep-sup');
});

function storeFixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Admin sintético' };
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('hook-tenant', 'mep-demo', JSON.stringify({ name: 'Empresa do gancho', channels: [{ id: 'wa-1', state: 'connected' }], departments: [],
    conversations: [conversation('c1', { messages: [message('m1', 'customer', 'Olá')] })], runs: [] }));
  return { store, actor };
}

test('Store.mutate publica ponteiros só depois do COMMIT e nada quando a transação volta atrás', t => {
  const { store, actor } = storeFixture(t), bus = createEventBus(); t.after(() => bus.close());
  store.events = bus;
  const seen = [];
  bus.subscribe({ tenantId: 'hook-tenant' }, event => {
    // The subscriber runs after COMMIT: it reads the committed row and may start its own transaction.
    const committed = JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('hook-tenant').data);
    seen.push([event.type, event.messageId ?? null, committed.conversations[0].messages.length]);
    if (event.type === 'conversation.message' && event.messageId === 'm2') store.mutate(actor, 'hook-tenant', 'Leitura marcada pelo assinante', state => { state.conversations[0].unread = 0; });
  });
  const result = store.mutate(actor, 'hook-tenant', 'Mensagem sintética', state => {
    state.conversations[0].messages.push(message('m2', 'customer', 'Texto que não entra no evento')); state.conversations[0].version = 2; return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(seen, [['conversation.message', 'm2', 2]]);
  assert.equal(store.tenant(actor, 'hook-tenant').conversations[0].unread, 0, 'the nested mutation of the subscriber committed');
  assert.throws(() => store.mutate(actor, 'hook-tenant', 'Falha sintética', state => {
    state.conversations[0].messages.push(message('m3', 'customer', 'perdida')); state.conversations[0].version = 3; throw Object.assign(new Error('falhou'), { status: 409 });
  }), error => error.status === 409);
  assert.equal(seen.length, 1, 'a rolled back mutation publishes nothing');
  assert.equal(store.tenant(actor, 'hook-tenant').conversations[0].messages.length, 2);
  bus.close();
  store.mutate(actor, 'hook-tenant', 'Depois do encerramento', state => { state.conversations[0].tags = ['Depois']; });
  assert.deepEqual(store.tenant(actor, 'hook-tenant').conversations[0].tags, ['Depois'], 'a closed bus never blocks a mutation');
});

test('falha ao publicar é reportada e nunca desfaz a mudança confirmada', t => {
  const { store, actor } = storeFixture(t), failures = [];
  store.events = { closed: false, publish() { throw new Error('barramento quebrado'); } };
  store.onEventError = failure => failures.push(failure.message);
  store.mutate(actor, 'hook-tenant', 'Mensagem sintética', state => { state.conversations[0].messages.push(message('m2', 'customer', 'oi')); state.conversations[0].version = 2; });
  assert.equal(store.tenant(actor, 'hook-tenant').conversations[0].version, 2);
  assert.deepEqual(failures, ['barramento quebrado']);
  store.onEventError = () => { throw new Error('o relator também falha'); };
  store.mutate(actor, 'hook-tenant', 'Outra mensagem', state => { state.conversations[0].messages.push(message('m3', 'customer', 'oi')); state.conversations[0].version = 3; });
  assert.equal(store.tenant(actor, 'hook-tenant').conversations[0].version, 3);
  // Without a bus nothing is indexed or published.
  delete store.events;
  store.mutate(actor, 'hook-tenant', 'Sem barramento', state => { state.conversations[0].version = 4; });
  assert.equal(store.tenant(actor, 'hook-tenant').conversations[0].version, 4);
});

function fakeResponse() {
  const listeners = new Map(), res = { chunks: [], ended: false, destroyed: false, writableLength: 0, status: null,
    writeHead(status) { res.status = status; }, write(text) { res.chunks.push(text); return true; }, end() { res.ended = true; listeners.get('close')?.(); },
    destroy() { res.destroyed = true; listeners.get('close')?.(); }, on(name, fn) { listeners.set(name, fn); } };
  return res;
}
const frames = res => res.chunks.join('').split('\n\n').filter(Boolean);

test('hub de SSE agrupa ponteiros por conversa, pede reset quando a fila transborda e corta cliente lento', async t => {
  const bus = createEventBus(); t.after(() => bus.close());
  let decisions = 0;
  const hub = createEventStreamHub({ bus, flushMs: 0, heartbeatMs: 60000, maxQueue: 3, maxBufferedBytes: 2048, workspaceOf: tenantId => tenantId === 'other' ? 'w2' : 'w1', tenantsOf: () => ['t1'],
    visibility: () => event => { decisions++; return event.conversationId === 'hidden' ? null : 'current'; } });
  t.after(() => hub.close());
  const principal = { workspaceId: 'w1', sessionKey: 's1', userKey: 'u1', resolve: () => ({ userId: 'u1' }) };
  const res = fakeResponse(); hub.open(res, principal);
  assert.equal(res.status, 200); assert.match(frames(res)[0], /^retry: 3000$/); assert.match(frames(res)[1], /event: ready/);
  for (const version of [2, 3]) bus.publish({ type: 'conversation.message', tenantId: 't1', conversationId: 'c1', channelId: 'wa', messageId: 'm' + version, kind: 'customer', version });
  bus.publish({ type: 'conversation.updated', tenantId: 't1', conversationId: 'hidden', channelId: 'wa', version: 1 });
  bus.publish({ type: 'conversation.updated', tenantId: 'other', conversationId: 'c9', channelId: 'wa', version: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const delivered = frames(res).slice(2);
  assert.deepEqual(delivered.map(frame => /event: (.*)/.exec(frame)[1]), ['inbox.changed', 'attention.changed'], 'two messages of one conversation become one pointer');
  assert.equal(decisions, 3, 'events of another workspace are not even evaluated');
  // Overflow: more pending events than the queue holds become a reset.
  res.chunks.length = 0;
  for (let version = 4; version < 10; version++) bus.publish({ type: 'conversation.updated', tenantId: 't1', conversationId: 'c' + version, channelId: 'wa', version });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(frames(res)[0], /event: reset/);
  // A client that stops reading is cut instead of buffering without bound.
  res.writableLength = 4096;
  bus.publish({ type: 'conversation.updated', tenantId: 't1', conversationId: 'c1', channelId: 'wa', version: 20 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(res.destroyed, true); assert.equal(hub.stats().connections, 0);
  assert.throws(() => createEventStreamHub({ bus, visibility: null, workspaceOf: () => null, tenantsOf: () => [] }), TypeError);
  assert.throws(() => hub.open(fakeResponse(), { workspaceId: 'w1', sessionKey: '', userKey: 'u', resolve() {} }), TypeError);
  hub.close();
  assert.throws(() => hub.open(fakeResponse(), principal), error => error.status === 503);
});

test('propostas administrativas e limite diário de IA alterados viram um aviso de pendências só para administração, sem conteúdo', () => {
  const before = { id: 'tenant-a', conversations: [], runs: [], channels: [], agentAdminProposals: [] };
  const after = { ...structuredClone(before), agentAdminProposals: [{ id: 'p1', state: 'pending', title: 'Proposta secreta' }] };
  assert.deepEqual(diffTenant(snapshotTenant(before), after, { tenantId: 'tenant-a' }), [{ type: 'attention.changed', tenantId: 'tenant-a', audience: 'admin' }]);
  assert.deepEqual(diffTenant(snapshotTenant(after), structuredClone(after), { tenantId: 'tenant-a' }), [], 'no change, no pulse');
  const decided = structuredClone(after); decided.agentAdminProposals[0].state = 'approved';
  assert.deepEqual(diffTenant(snapshotTenant(after), decided).map(event => [event.type, event.audience]), [['attention.changed', 'admin']]);
  const limited = { ...structuredClone(decided), aiDailyTokenLimit: 50000 };
  assert.deepEqual(diffTenant(snapshotTenant(decided), limited).map(event => [event.type, event.audience]), [['attention.changed', 'admin']], 'a new daily AI limit moves the quota section');
  const bus = createEventBus();
  try {
    const event = bus.publish({ type: 'attention.changed', tenantId: 'tenant-a', audience: 'admin', title: 'Proposta secreta' });
    assert.deepEqual(Object.keys(event).sort(), ['at', 'audience', 'id', 'tenantId', 'type']);
  } finally { bus.close(); }
});

test('cursores são opacos: não revelam o volume de outras empresas e order devolve a posição dentro do processo', t => {
  const bus = createEventBus(); t.after(() => bus.close());
  const heads = [bus.head()];
  for (let index = 0; index < 20; index++) { bus.publish({ type: 'conversation.updated', tenantId: index % 2 ? 'tenant-b' : 'tenant-a', conversationId: 'c1', version: index + 2 }); heads.push(bus.head()); }
  assert.deepEqual(heads.map(cursor => bus.order(cursor)), Array.from({ length: 21 }, (_, index) => index));
  for (const cursor of heads) assert.match(cursor, /^[0-9a-f]{12}-[0-9a-z]{1,11}$/);
  const raw = heads.map(cursor => parseInt(cursor.split('-')[1], 36));
  assert.notDeepEqual(raw, [...raw].sort((left, right) => left - right), 'the text is not a readable counter');
  assert.equal(new Set(raw).size, raw.length);
  // Reads still work across the permutation, and a value it never issues resyncs like a future cursor.
  assert.deepEqual(bus.since('tenant-a', heads[18]).events.map(event => event.version), [20]);
  assert.equal(bus.since('tenant-a', `${bus.bootId}-${(2 ** 48).toString(36)}`).resync, true);
  assert.equal(bus.order('nao-e-cursor'), -1); assert.equal(bus.order(`${'0'.repeat(12)}-1`), -1);
  // Another process (another key) never reads these positions.
  const other = createEventBus({ bootId: bus.bootId }); t.after(() => other.close());
  assert.equal(other.since('tenant-a', heads[10]).resync, true);
});
