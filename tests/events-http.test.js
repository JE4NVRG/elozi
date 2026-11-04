import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { realtimeFixture, message, at } from './helpers/realtime-fixture.js';

const parse = block => {
  const event = { comment: false };
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) { event.comment = true; continue; }
    const separator = line.indexOf(':'), field = line.slice(0, separator), value = line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') event.data = JSON.parse(value); else event[field] = value;
  }
  return event;
};
function open(f, as, { query = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/api/events' + query, { headers: { ...(as ? { Cookie: f.users[as].cookie } : {}), Accept: 'text/event-stream', ...headers } }, res => {
      const client = { status: res.statusCode, headers: res.headers, events: [], raw: '', closed: false, close: () => req.destroy() };
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { client.raw += chunk; buffer += chunk; let index; while ((index = buffer.indexOf('\n\n')) >= 0) { client.events.push(parse(buffer.slice(0, index))); buffer = buffer.slice(index + 2); } });
      res.on('end', () => { client.closed = true; }); res.on('error', () => { client.closed = true; }); res.on('close', () => { client.closed = true; });
      resolve(client);
    });
    req.on('error', reject); req.end();
  });
}
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 15000) {
  const started = performance.now();
  while (!check()) { if (performance.now() - started > timeoutMs) throw new Error('Tempo esgotado esperando o fluxo de eventos.'); await settle(10); }
}
const named = (client, name) => client.events.filter(event => event.event === name);
const fixture = (t, realtimeOptions = {}) => realtimeFixture(t, { appOptions: { realtimeOptions: { flushMs: 5, heartbeatMs: 60000, ...realtimeOptions } } });
const append = (f, tenantId, cid, id) => f.mutate(tenantId, tenant => { const c = tenant.conversations.find(item => item.id === cid); c.messages.push(message(id, 'customer', 'Texto confidencial ' + id, 9)); c.version++; c.unread++; c.updatedAt = at(9); });

test('SSE autentica sessão e workspace antes de abrir e respeita o limite de conexões', async t => {
  const f = await fixture(t, { maxPerSession: 2, maxPerUser: 3 });
  const anonymous = await f.request('/api/events', { as: null });
  assert.equal(anonymous.status, 401); assert.match(anonymous.headers['content-type'], /application\/json/);
  assert.equal((await f.request('/api/events?workspace=ws-a', { as: 'foreign' })).status, 403);
  assert.equal((await f.request('/api/events?other=1')).status, 400);
  assert.equal((await f.request('/api/events?cursor=' + 'x'.repeat(65))).status, 400);
  const first = await open(f, 'admin'), second = await open(f, 'admin');
  t.after(() => { first.close(); second.close(); });
  assert.equal(first.status, 200); assert.match(first.headers['content-type'], /^text\/event-stream/);
  assert.equal(first.headers['cache-control'], 'no-store'); assert.equal(first.headers['x-accel-buffering'], 'no');
  await until(() => named(first, 'ready').length === 1);
  assert.match(first.raw, /^retry: 3000\n\n/); assert.equal(named(first, 'ready')[0].data.resumed, false); assert.ok(named(first, 'ready')[0].id);
  const third = await f.request('/api/events');
  assert.equal(third.status, 429); assert.ok(Number(third.headers['retry-after']) > 0);
  second.close(); await until(() => f.app.realtime.stats().connections === 1);
  const again = await open(f, 'admin'); t.after(() => again.close());
  assert.equal(again.status, 200);
  assert.ok((await f.request('/api/bootstrap')).data.features.includes('events'));
});

test('SSE entrega só ponteiros do mesmo predicado do inbox: empresa, departamento, canal e saída do escopo', async t => {
  const f = await fixture(t);
  const clients = Object.fromEntries(await Promise.all(['admin', 'sales', 'support', 'a2', 'foreign'].map(async as => [as, await open(f, as)])));
  t.after(() => { for (const client of Object.values(clients)) client.close(); });
  await until(() => Object.values(clients).every(client => named(client, 'ready').length === 1));
  append(f, 'rt-a1', 'c-support', 'n1');   // support department
  append(f, 'rt-a1', 'c-tg', 'n2');        // Telegram channel outside every operator scope
  append(f, 'rt-a1', 'c-sales', 'n3');     // sales department
  append(f, 'rt-a2', 'c-a2', 'n4');        // other company
  append(f, 'rt-b1', 'c-b1', 'n5');        // other workspace
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-mine'); c.departmentId = 'support'; c.version++; });
  f.mutate('rt-a1', tenant => { tenant.channels.find(item => item.id === 'tg-a1').state = 'logged_out'; tenant.channels.find(item => item.id === 'wa-a1').state = 'reconnecting'; });
  f.mutate('rt-a1', tenant => { tenant.runs.push({ id: 'run-support', conversationId: 'c-support', state: 'running', version: 1, updatedAt: at(10) }, { id: 'run-sales', conversationId: 'c-sales', state: 'draft', draft: 'Rascunho secreto', version: 2, updatedAt: at(10) }); });
  await until(() => named(clients.admin, 'run.changed').length === 2 && named(clients.foreign, 'inbox.changed').length === 1 && named(clients.a2, 'inbox.changed').length === 1);
  await settle(80);
  const inbox = name => named(clients[name], 'inbox.changed').map(event => event.data.conversationId + (event.data.left ? ':left' : '')).sort();
  assert.deepEqual(inbox('admin'), ['c-a2', 'c-mine', 'c-sales', 'c-support', 'c-tg']);
  assert.deepEqual(inbox('sales'), ['c-mine:left', 'c-sales']);
  assert.deepEqual(inbox('support'), ['c-mine', 'c-support']);
  assert.deepEqual(inbox('a2'), ['c-a2']); assert.deepEqual(inbox('foreign'), ['c-b1']);
  const runs = name => named(clients[name], 'run.changed').map(event => event.data.runId).sort();
  assert.deepEqual(runs('admin'), ['run-sales', 'run-support']); assert.deepEqual(runs('sales'), ['run-sales']); assert.deepEqual(runs('support'), ['run-support']); assert.deepEqual(runs('a2'), []);
  assert.deepEqual(named(clients.sales, 'run.changed')[0].data, { tenantId: 'rt-a1', conversationId: 'c-sales', runId: 'run-sales', state: 'draft' });
  const channels = name => named(clients[name], 'channel.state').map(event => event.data.channelId + ':' + event.data.state).sort();
  assert.deepEqual(channels('admin'), ['tg-a1:logged_out', 'wa-a1:reconnecting']); assert.deepEqual(channels('sales'), ['wa-a1:reconnecting']); assert.deepEqual(channels('a2'), []);
  for (const [name, client] of Object.entries(clients)) {
    assert.ok(named(client, 'attention.changed').length >= 1, name);
    for (const secret of ['Texto confidencial', 'Contato sintético', 'Rascunho secreto', 'Vendas', 'expectedNumber']) assert.equal(client.raw.includes(secret), false, name + ' ' + secret);
  }
  for (const hidden of ['c-support', 'c-tg', 'c-a2', 'c-b1', 'rt-a2', 'rt-b1', 'tg-a1', 'run-support']) assert.equal(clients.sales.raw.includes(hidden), false, 'sales ' + hidden);
  for (const hidden of ['rt-a1', 'rt-a2', 'c-sales']) assert.equal(clients.foreign.raw.includes(hidden), false, 'foreign ' + hidden);
  // Ids follow the bus order so EventSource resumes from the right place, but they are opaque outside the process.
  const ids = clients.admin.events.filter(event => event.id && event.event !== 'ready').map(event => f.app.events.order(event.id));
  assert.ok(ids.every(id => id > 0)); assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
});

test('SSE reavalia a autorização a cada rodada e encerra a sessão revogada', async t => {
  const f = await fixture(t);
  const sales = await open(f, 'sales'); t.after(() => sales.close());
  await until(() => named(sales, 'ready').length === 1);
  // Scope narrowed after the stream opened: the next round already uses the new rules.
  f.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ 'rt-a1': { channelIds: ['wa-a1'], departmentIds: ['support'] } }), f.users.sales.id);
  append(f, 'rt-a1', 'c-sales', 'p1'); append(f, 'rt-a1', 'c-support', 'p2');
  await until(() => named(sales, 'inbox.changed').length === 1);
  await settle(50);
  assert.deepEqual(named(sales, 'inbox.changed').map(event => event.data.conversationId), ['c-support']);
  const eventsBeforeLogout = structuredClone(sales.events);
  f.app.auth.logout(f.users.sales.token);
  append(f, 'rt-a1', 'c-support', 'p3');
  await until(() => sales.closed);
  // SSE emits opaque random cursors rather than message IDs. A random cursor can contain "p3";
  // the security property is that revocation prevents every further event, including invalidation pointers.
  assert.deepEqual(sales.events, eventsBeforeLogout);
  await until(() => f.app.realtime.stats().connections === 0);
});

test('SSE retoma por Last-Event-ID só com eventos visíveis, pede reset fora do buffer e mantém heartbeat', async t => {
  const f = await fixture(t, { heartbeatMs: 40 });
  const first = await open(f, 'sales'); t.after(() => first.close());
  await until(() => named(first, 'ready').length === 1);
  const cursor = named(first, 'ready')[0].id;
  first.close(); await until(() => f.app.realtime.stats().connections === 0);
  append(f, 'rt-a1', 'c-support', 'r1'); append(f, 'rt-a1', 'c-sales', 'r2'); append(f, 'rt-a1', 'c-tg', 'r3');
  const resumed = await open(f, 'sales', { headers: { 'Last-Event-ID': cursor } }); t.after(() => resumed.close());
  await until(() => named(resumed, 'inbox.changed').length === 1);
  assert.equal(named(resumed, 'ready')[0].data.resumed, true); assert.equal(named(resumed, 'ready')[0].id, undefined, 'replayed events carry the ids');
  assert.deepEqual(named(resumed, 'inbox.changed').map(event => event.data.conversationId), ['c-sales']);
  assert.equal(resumed.raw.includes('c-support'), false);
  // Heartbeats arrive and move the cursor past the invisible event that came after the last visible one.
  append(f, 'rt-a1', 'c-support', 'r4');
  await until(() => resumed.events.some(event => event.comment && event.id));
  const advanced = resumed.events.filter(event => event.comment && event.id).at(-1).id;
  assert.ok(f.app.events.order(advanced) > f.app.events.order(named(resumed, 'inbox.changed')[0].id));
  // A cursor of another process (or garbage) cannot be replayed: the client reloads.
  for (const stale of ['000000000000-1', 'nao-e-cursor']) {
    const reset = await open(f, 'sales', { query: '?cursor=' + stale }); t.after(() => reset.close());
    await until(() => named(reset, 'reset').length === 1);
    assert.equal(named(reset, 'ready')[0].data.resumed, false); assert.ok(named(reset, 'reset')[0].id);
    reset.close();
  }
});

test('SSE avisa mensagens da equipe só para membros da sala e encerra todos os fluxos ao fechar o servidor', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/tenants/rt-a1/team-chat/rooms', { method: 'POST', body: { name: 'Sala sintética', memberIds: [f.users.sales.id] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const roomId = created.data.id || created.data.room?.id;
  const sales = await open(f, 'sales'), support = await open(f, 'support');
  await until(() => named(sales, 'ready').length === 1 && named(support, 'ready').length === 1);
  const room = await f.request(`/api/tenants/rt-a1/team-chat/rooms/${roomId}`);
  const sent = await f.request(`/api/tenants/rt-a1/team-chat/rooms/${roomId}/messages`, { method: 'POST', body: { version: room.data.version ?? room.data.room?.version, text: 'Mensagem interna secreta', requestId: 'request-synthetic-0001' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  await until(() => named(sales, 'teamchat.message').length === 1);
  await settle(50);
  assert.deepEqual(named(sales, 'teamchat.message')[0].data, { tenantId: 'rt-a1', roomId });
  assert.equal(named(support, 'teamchat.message').length, 0); assert.equal(sales.raw.includes('secreta'), false);
  await new Promise(resolve => f.app.server.close(resolve));
  await until(() => sales.closed && support.closed);
  assert.equal(f.app.realtime.closed, true);
});


test('SSE: pendências fora da conversa (propostas) só para administração; pedido de apoio segue o escopo da conversa', async t => {
  const f = await fixture(t);
  const clients = Object.fromEntries(await Promise.all(['admin', 'sales', 'support'].map(async as => [as, await open(f, as)])));
  t.after(() => { for (const client of Object.values(clients)) client.close(); });
  await until(() => Object.values(clients).every(client => named(client, 'ready').length === 1));
  // A committed change of the administrative proposals: one pulse for administrators, nothing else.
  f.mutate('rt-a1', tenant => { tenant.agentAdminProposals = [{ id: 'proposta-sintetica', state: 'pending', title: 'Título confidencial' }]; });
  await until(() => named(clients.admin, 'attention.changed').length === 1);
  await settle(80);
  assert.equal(named(clients.sales, 'attention.changed').length, 0); assert.equal(named(clients.support, 'attention.changed').length, 0);
  assert.equal(named(clients.admin, 'inbox.changed').length, 0, 'a pulse only, never an inbox change');
  // A support request of c-support (kept outside the tenant JSON): the people who see that conversation.
  f.app.serviceApi.announceAttention('rt-a1', 'c-support');
  await until(() => named(clients.support, 'attention.changed').length === 1 && named(clients.admin, 'attention.changed').length === 2);
  await settle(80);
  assert.equal(named(clients.sales, 'attention.changed').length, 0, 'out of the department scope');
  assert.equal(named(clients.support, 'inbox.changed').length, 0);
  for (const [name, client] of Object.entries(clients)) for (const secret of ['Título confidencial', 'proposta-sintetica']) assert.equal(client.raw.includes(secret), false, name + ' ' + secret);
});
