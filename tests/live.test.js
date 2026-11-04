// Client scheduler (FRONTEND-V2 §7.1, §8.3 P2) with a fake clock, fake Web Locks and a fake
// BroadcastChannel: one list poll for N visible tabs, the attention pulse outside the inbox and with
// the tab hidden, backoff with jitter, pause/resume on re-authentication and the connection state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLive, createLiveRegistry, provideLiveContext, reportLive, registerLiveTask, backoffDelay, lockName, BACKOFF_STEPS, CADENCE, setLiveFeatures, liveFeatures, countsAsFailure } from '../public/live.js';
import { createDataSource } from '../public/data-source.js';

const settle = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); } };

function fakeClock(start = 0) {
  let now = start, sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    get pending() { return timers.size; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
        await settle();
      }
      now = end; await settle();
    }
  };
}
// Web Locks: one holder per name, the next waiter gets the lock when the holder's promise settles;
// signal aborts a queued request and steal takes the lock from the holder (its request rejects).
function fakeLocks() {
  const queues = new Map();
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  return {
    queues,
    request(name, options = {}, callback) {
      return new Promise((resolve, reject) => {
        const queue = queues.get(name) || [];
        queues.set(name, queue);
        if (options.signal?.aborted) { reject(abortError()); return; }
        const entry = { held: false, done: false };
        const leave = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); };
        entry.grant = () => { entry.held = true; queueMicrotask(() => Promise.resolve(callback({ name })).finally(() => { if (entry.done) return; entry.done = true; leave(); resolve(); queue[0]?.held || queue[0]?.grant(); })); };
        entry.steal = () => { if (entry.done) return; entry.done = true; leave(); reject(abortError()); };
        options.signal?.addEventListener?.('abort', () => { if (entry.held || entry.done) return; entry.done = true; leave(); reject(abortError()); });
        if (options.steal) { if (queue[0]?.held) queue[0].steal(); queue.unshift(entry); entry.grant(); return; }
        queue.push(entry);
        if (queue.length === 1) entry.grant();
      });
    }
  };
}
// BroadcastChannel: asynchronous structured copies to every other channel of the same name.
function fakeBus() {
  const channels = new Set(), sent = [];
  class Channel {
    constructor(name) { this.name = name; this.onmessage = null; channels.add(this); }
    postMessage(data) { sent.push(data); const copy = structuredClone(data); for (const other of channels) if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data: structuredClone(copy) })); }
    close() { channels.delete(this); }
  }
  return { Channel, sent };
}
function fakeServer() {
  const calls = [];
  return { calls, async request(path, options = {}) { calls.push([path, options]); return { workspaceId: options.headers?.['X-Elozi-Workspace'], items: [], total: 0, offset: 0, limit: 50, hasMore: false, countTabs: { mine: 1, queue: 2 }, counts: {} }; } };
}
const page = path => path;
function tab(world, { visible = true, view = 'inbox', path = '/api/inbox?status=active&tab=all', userId = 'u1', workspaceId = 'w1', presence = 'available', attention = null } = {}) {
  const registry = createLiveRegistry();
  const context = { userId, workspaceId, view };
  provideLiveContext(() => context, registry);
  const doc = { visibilityState: visible ? 'visible' : 'hidden', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, querySelector: selector => selector === '.sh-account [data-presence]' ? { getAttribute: () => presence } : null };
  const win = { listeners: {}, addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, fire(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); } };
  const source = createDataSource({ request: world.server.request, registry, now: world.clock.now });
  const runs = [];
  const live = createLive({ registry, timers: world.clock, now: world.clock.now, document: doc, window: win, navigator: world.navigator, BroadcastChannel: world.Channel, random: () => 0.5, attention,
    tasks: [{ name: 'inbox', every: 5000, run: () => { runs.push(world.clock.now()); return source.inboxPage(page(path), { workspaceId }); } }] });
  return { registry, live, source, doc, win, runs, context };
}
function world({ locks = true, channel = true } = {}) {
  const clock = fakeClock(1000), bus = fakeBus();
  return { clock, server: fakeServer(), navigator: { onLine: true, ...(locks ? { locks: fakeLocks() } : {}) }, Channel: channel ? bus.Channel : undefined, bus };
}
const listCalls = server => server.calls.filter(([path]) => path.startsWith('/api/inbox?status=active&tab=')).length;

for (const outcome of ['resolve', 'reject']) test(`invalidações durante atenção em voo são agrupadas numa consulta fresca serial após ${outcome}`, async () => {
  const w = world({ locks: false });
  let finish, fail, calls = 0, active = 0, peak = 0;
  const first = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const attention = { stale: () => false, subscribe() {}, snapshot: () => null, refresh() {
    calls++; active++; peak = Math.max(peak, active);
    return (calls === 1 ? first : Promise.resolve()).finally(() => { active--; });
  } };
  const item = tab(w, { view: 'overview', attention });
  item.live.start(); await w.clock.advance(0);
  assert.equal(calls, 1);
  for (let i = 0; i < 20; i++) item.live.kick('attention');
  await w.clock.advance(60000);
  assert.equal(calls, 1, 'nem invalidações nem a cadência iniciam consulta concorrente ou fazem o relógio girar');
  if (outcome === 'resolve') finish(); else fail(new Error('Falha sintética da consulta antiga'));
  await settle(); await w.clock.advance(0);
  assert.equal(calls, 2, 'a invalidação não espera o próximo pulso');
  assert.equal(peak, 1);
  await w.clock.advance(1000);
  assert.equal(calls, 2, 'vinte invalidações geram só uma consulta adicional');
  item.live.stop();
});

for (const action of ['pause', 'stop']) test(`atenção pendente não volta a executar depois de ${action}`, async () => {
  const w = world({ locks: false });
  let finish, calls = 0;
  const first = new Promise(resolve => { finish = resolve; });
  const attention = { stale: () => false, subscribe() {}, snapshot: () => null, refresh() { return ++calls === 1 ? first : Promise.resolve(); } };
  const item = tab(w, { view: 'overview', attention });
  item.live.start(); await w.clock.advance(0); item.live.kick('attention');
  item.live[action](); finish(); await settle(); await w.clock.advance(0);
  assert.equal(calls, 1);
  item.live.kick('attention'); await w.clock.advance(0);
  assert.equal(calls, 1, 'um kick também respeita a pausa/parada');
  if (action === 'pause') { item.live.resume(); await settle(); assert.equal(calls, 2, 'retomada faz uma consulta nova'); }
  item.live.stop();
});

test('troca de escopo descarta a invalidação antiga e nova solicitação usa o workspace atual', async () => {
  const w = world({ locks: false });
  let finish;
  const first = new Promise(resolve => { finish = resolve; }), calls = [];
  let item;
  const attention = { stale: () => false, subscribe() {}, snapshot: () => null, refresh() { calls.push(item.context.workspaceId); return calls.length === 1 ? first : Promise.resolve(); } };
  item = tab(w, { view: 'overview', attention });
  item.live.start(); await w.clock.advance(0); item.live.kick('attention');
  item.context.workspaceId = 'w2'; item.live.touch();
  finish(); await settle(); await w.clock.advance(0);
  assert.deepEqual(calls, ['w1']);
  item.live.kick('attention'); await settle();
  assert.deepEqual(calls, ['w1', 'w2']);
  item.live.stop();
});

test('atenção invalidada na seguidora é atualizada pela líder, sem consultas concorrentes ou cruzar escopos', async () => {
  const w = world(), calls = [0, 0, 0];
  const make = index => ({ stale: () => false, subscribe() {}, snapshot: () => null, refresh() { calls[index]++; return Promise.resolve(); } });
  const a = tab(w, { view: 'overview', attention: make(0) }), b = tab(w, { view: 'overview', attention: make(1) }), other = tab(w, { view: 'overview', workspaceId: 'w2', attention: make(2) });
  a.live.start(); b.live.start(); other.live.start(); await settle(); await w.clock.advance(0);
  assert.equal(a.live.leader, true); assert.equal(b.live.leader, false);
  const before = [...calls];
  b.live.kick('attention'); await settle();
  assert.deepEqual(calls, [before[0] + 1, before[1], before[2]]);
  for (const item of [a, b, other]) item.live.stop();
});

test('perder a liderança durante atenção em voo descarta o rerun da antiga líder', async () => {
  const w = world();
  let finish, aCalls = 0;
  const first = new Promise(resolve => { finish = resolve; });
  const a = tab(w, { view: 'overview', attention: { stale: () => false, subscribe() {}, snapshot: () => null, refresh() { aCalls++; return first; } } });
  const b = tab(w, { view: 'overview', attention: { stale: () => false, subscribe() {}, snapshot: () => null, refresh: async () => {} } });
  a.live.start(); b.live.start(); await settle(); await w.clock.advance(0);
  assert.equal(aCalls, 1); a.live.kick('attention');
  a.doc.visibilityState = 'hidden'; a.doc.listeners.visibilitychange(); await settle();
  assert.equal(a.live.leader, false); assert.equal(b.live.leader, true);
  finish(); await settle(); await w.clock.advance(0);
  assert.equal(aCalls, 1);
  a.live.stop(); b.live.stop();
});

test('N abas visíveis na mesma lista geram 1 poll de lista por ciclo (locks e BroadcastChannel falsos)', async () => {
  const w = world(), tabs = [tab(w), tab(w), tab(w)];
  for (const item of tabs) item.live.start();
  await settle();
  assert.equal(tabs.filter(item => item.live.state().leader).length, 1, 'uma única aba líder');
  assert.ok(tabs.every(item => item.live.state().coordinated));
  await w.clock.advance(30000);
  assert.ok(tabs.every(item => item.runs.length === 6), 'cada aba visível roda a própria tarefa (conversa aberta) a cada 5 s');
  assert.equal(listCalls(w.server), 6, 'a lista é buscada uma vez por ciclo para as três abas');
  for (const item of tabs) item.live.stop();
});

test('sem navigator.locks cada aba faz o próprio poll (comportamento anterior)', async () => {
  const w = world({ locks: false }), tabs = [tab(w), tab(w)];
  for (const item of tabs) item.live.start();
  await w.clock.advance(10000);
  assert.ok(tabs.every(item => item.live.state().leader && !item.live.state().coordinated));
  assert.equal(listCalls(w.server), 4);
  for (const item of tabs) item.live.stop();
});

test('filtros diferentes não se misturam e a líder que sai entrega a liderança', async () => {
  const w = world(), first = tab(w), second = tab(w, { path: '/api/inbox?status=active&tab=mine' });
  first.live.start(); second.live.start();
  await settle();
  await w.clock.advance(5000);
  assert.deepEqual(w.server.calls.map(([path]) => path).sort(), ['/api/inbox?status=active&tab=all', '/api/inbox?status=active&tab=mine']);
  const leader = first.live.state().leader ? first : second, other = leader === first ? second : first;
  leader.live.stop();
  await settle();
  assert.equal(other.live.state().leader, true, 'a outra aba assume a liderança ao ganhar o lock');
  other.live.stop();
});

test('o pulso de atenção roda fora da caixa (15 s), com a aba oculta (30 s, só a líder) e fora de atendimento (120 s)', async () => {
  const w = world({ locks: false }), pulses = [];
  const attention = { refresh: () => { pulses.push(w.clock.now()); return Promise.resolve(); }, subscribe() {}, snapshot: () => null, stale: () => false };
  const visible = tab(w, { view: 'overview', attention });
  visible.live.start();
  await w.clock.advance(31000);
  assert.deepEqual(pulses, [1000, 16000, 31000], 'imediato e a cada 15 s em outra tela');
  assert.equal(visible.runs.length, 0, 'a lista não roda fora da caixa');
  visible.doc.visibilityState = 'hidden'; visible.doc.listeners.visibilitychange();
  pulses.length = 0;
  await w.clock.advance(61000);
  assert.deepEqual(pulses, [61000, 91000], 'oculta: a cada 30 s');
  visible.live.stop();
  const away = tab(w, { view: 'overview', presence: 'offline', attention });
  pulses.length = 0; away.live.start();
  await w.clock.advance(240000);
  assert.equal(pulses.length, 3, 'fora de atendimento: imediato e a cada 120 s');
  away.live.stop();
  const follower = world(), lead = tab(follower, { view: 'overview', attention: { ...attention, refresh: () => { pulses.push('lead'); return Promise.resolve(); } } }), next = tab(follower, { view: 'overview', attention: { ...attention, refresh: () => { pulses.push('follower'); return Promise.resolve(); } } });
  pulses.length = 0; lead.live.start(); await settle(); next.live.start();
  await follower.clock.advance(45000);
  assert.ok(pulses.includes('lead') && !pulses.includes('follower'), 'só a líder faz o pulso; as outras recebem o snapshot');
  lead.live.stop(); next.live.stop();
});

test('backoff 5→10→20→40→60 s com jitter de ±20%, e online retoma na hora', async () => {
  assert.deepEqual(BACKOFF_STEPS, [5000, 10000, 20000, 40000, 60000]);
  assert.equal(backoffDelay(0), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => backoffDelay(n, () => 0.5)), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.deepEqual([1, 3, 5].map(n => backoffDelay(n, () => 0)), [4000, 16000, 48000], '-20%');
  assert.deepEqual([1, 3, 5].map(n => backoffDelay(n, () => 1)), [6000, 24000, 72000], '+20%');
  for (let i = 0; i < 200; i++) { const value = backoffDelay(3); assert.ok(value >= 16000 && value <= 24000); }
  const w = world({ locks: false }), failing = tab(w);
  failing.live.stop();
  const runs = [];
  const registry = failing.registry;
  const live = createLive({ registry, timers: w.clock, now: w.clock.now, document: failing.doc, window: failing.win, navigator: { onLine: true }, random: () => 0.5,
    tasks: [{ name: 'inbox', every: 5000, run: () => { runs.push(w.clock.now()); reportLive('failure', registry, w.clock.now()); } }] });
  live.start();
  await w.clock.advance(200000);
  assert.deepEqual(runs.map(time => time - 1000), [5000, 10000, 20000, 40000, 80000, 140000, 200000], 'atrasos 5, 10, 20, 40, 60, 60 s após cada falha');
  assert.equal(live.state().connection, 'offline', '3 falhas seguidas: offline');
  failing.win.fire('online');
  await settle();
  assert.equal(runs.at(-1), w.clock.now(), 'o evento online roda na hora');
  live.stop();
  assert.equal(countsAsFailure({ status: 403 }), false); assert.equal(countsAsFailure({ status: 503 }), true); assert.equal(countsAsFailure(new TypeError('Failed to fetch')), true);
  assert.equal(countsAsFailure(Object.assign(new Error('x'), { name: 'AbortError' })), false);
});

test('estado da conexão: desconhecido antes de medir, ao vivo ≤ 15 s, atrasado > 15 s ou 2 falhas, offline sem rede', async () => {
  const w = world({ locks: false }), item = tab(w, { view: 'inbox' });
  assert.equal(item.live.state().connection, null, 'antes do start');
  item.live.start();
  assert.equal(item.live.state().connection, null, 'nada medido ainda: nunca "ao vivo"');
  await w.clock.advance(5000);
  assert.equal(item.live.state().connection, 'live');
  item.live.pause();
  await w.clock.advance(16000);
  assert.equal(item.live.state().connection, 'late', 'mais de 15 s sem sucesso');
  item.live.resume(); await settle();
  assert.equal(item.live.state().connection, 'live');
  reportLive('failure', item.registry, w.clock.now()); reportLive('failure', item.registry, w.clock.now());
  assert.equal(item.live.state().connection, 'late', '2 falhas');
  w.navigator.onLine = false;
  assert.equal(item.live.state().connection, 'offline');
  item.live.stop();
});

test('sessão expirada pausa tudo e reauth-ok retoma o poll na hora', async () => {
  const w = world({ locks: false }), item = tab(w);
  item.live.start();
  await w.clock.advance(5000);
  assert.equal(item.runs.length, 1);
  item.win.fire('elozi:reauth');
  await w.clock.advance(30000);
  assert.equal(item.runs.length, 1, 'nenhum poll com a sessão expirada');
  assert.equal(item.live.state().paused, true);
  item.win.fire('elozi:reauth-ok');
  await settle();
  assert.equal(item.runs.length, 2, 'retoma na hora');
  await w.clock.advance(5000);
  assert.equal(item.runs.length, 3);
  item.live.stop();
});

test('tarefas registradas por outros módulos e recursos do bootstrap (evento de stream relaciona por nome)', async () => {
  const w = world({ locks: false }), item = tab(w, { view: 'overview' }), badge = [];
  const remove = registerLiveTask({ name: 'team-badge', run: () => { badge.push(w.clock.now()); }, cadence: env => env.visible ? CADENCE.teamClosed : null, events: ['teamchat.message'] }, item.registry);
  item.live.start();
  await w.clock.advance(60000);
  assert.equal(badge.length, 2, 'badge da Equipe a cada 30 s com a gaveta fechada');
  remove();
  await w.clock.advance(60000);
  assert.equal(badge.length, 2);
  item.live.stop();
  assert.throws(() => registerLiveTask({ name: 'x', run() {} }, item.registry), /cadence/);
  setLiveFeatures('w1', ['events', 'inbox-since', 3], item.registry);
  assert.deepEqual([...liveFeatures(item.registry)].sort(), ['events', 'inbox-since']);
  assert.equal(lockName({ userId: 'u', workspaceId: 'w' }), 'elozi-live:u:w');
  assert.equal(lockName({ userId: 'u', workspaceId: 'w', supportGrantId: 'g' }), 'elozi-live:u:w:g');
  assert.equal(lockName({ workspaceId: 'w' }), '', 'sem pessoa não há líder');
  assert.throws(() => createLive({ tasks: [], timers: { setInterval() {} } }), /setTimeout/);
});

test('stream de eventos (feature "events"): só a líder conecta, polls viram ressincronização de 60 s e os eventos chegam às outras abas', async () => {
  const w = world(), sources = [];
  class FakeSource { constructor(url) { this.url = url; this.listeners = {}; sources.push(this); } addEventListener(name, fn) { this.listeners[name] = fn; } close() { this.closed = true; } }
  const make = () => {
    const item = tab(w);
    item.live.stop();
    setLiveFeatures('w1', ['events'], item.registry);
    const runs = [];
    const live = createLive({ registry: item.registry, timers: w.clock, now: w.clock.now, document: item.doc, window: item.win, navigator: w.navigator, BroadcastChannel: w.Channel, EventSource: FakeSource, random: () => 0.5,
      tasks: [{ name: 'inbox', every: 5000, run: () => { runs.push(w.clock.now()); } }] });
    return { live, runs };
  };
  const a = make(), b = make();
  a.live.start(); await settle(); b.live.start(); await settle();
  assert.equal(sources.length, 1, 'uma conexão de eventos por pessoa e workspace');
  assert.equal(sources[0].url, '/api/events?workspace=w1');
  sources[0].onopen();
  await settle();
  assert.equal(a.live.state().stream || b.live.state().stream, true);
  assert.equal(b.live.state().stream && a.live.state().stream, true, 'as outras abas sabem que o stream está aberto');
  await w.clock.advance(60000);
  assert.ok(a.runs.length <= 1 && b.runs.length <= 1, 'com stream aberto o poll vira ressincronização de 60 s');
  const before = a.runs.length + b.runs.length;
  sources[0].listeners['inbox.changed']({ data: JSON.stringify({ tenantId: 't1', conversationId: 'c1' }) });
  await settle();
  assert.equal(a.runs.length + b.runs.length, before + 2, 'inbox.changed atualiza a lista nas duas abas na hora');
  a.live.stop(); b.live.stop();
});

test('data-source: inbox-since reaproveita a página inalterada; resumo e página da conversa só com o recurso; sucesso e falha alimentam a conexão', async () => {
  const registry = createLiveRegistry(), calls = [];
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1' }), registry);
  let revision = 'r_1';
  const request = async (path, options) => {
    calls.push(path);
    if (path.includes('fail')) throw Object.assign(new Error('Serviço indisponível'), { status: 503 });
    if (path.includes('denied')) throw Object.assign(new Error('Sem acesso'), { status: 403 });
    if (path.startsWith('/api/inbox')) return path.includes(`since=${revision}`) ? { workspaceId: 'w1', unchanged: true, revision } : { workspaceId: 'w1', items: [{ id: 'c1' }], revision };
    return { path, headers: options.headers };
  };
  const source = createDataSource({ request, registry, now: () => 5000 });
  assert.equal(await source.conversationPage('t', 'c'), null, 'sem o recurso o poll segue com o DTO da empresa');
  assert.equal(await source.tenantSummary('t'), null);
  setLiveFeatures('w1', ['inbox-since', 'conversation-delta', 'tenant-summary'], registry);
  const first = await source.inboxPage('/api/inbox?status=active', { workspaceId: 'w1' });
  const second = await source.inboxPage('/api/inbox?status=active', { workspaceId: 'w1' });
  assert.equal(second, first, 'unchanged: a mesma página volta sem novo payload');
  assert.deepEqual(calls.slice(-2), ['/api/inbox?status=active', '/api/inbox?status=active&since=r_1']);
  revision = 'r_2';
  assert.equal((await source.inboxPage('/api/inbox?status=active', { workspaceId: 'w1' })).revision, 'r_2');
  assert.equal((await source.conversationPage('t', 'c/1', { workspaceId: 'w1', after: 'm9', version: 4 })).path, '/api/tenants/t/conversations/c%2F1?limit=50&after=m9&version=4');
  assert.equal((await source.tenantSummary('t', { workspaceId: 'w1' })).path, '/api/tenants/t?summary=1');
  assert.equal(registry.health.lastSuccess, 5000);
  await assert.rejects(source.tenant('denied', { workspaceId: 'w1' }));
  assert.equal(registry.health.failures, 0, '403 não diz nada sobre a conexão');
  await assert.rejects(source.tenant('fail', { workspaceId: 'w1' }));
  assert.equal(registry.health.failures, 1);
});

test('stream recusado (401/403/429) fecha e tenta de novo um minuto depois; os polls cobrem o intervalo', async () => {
  const w = world({ locks: false }), sources = [];
  class FakeSource { constructor(url) { this.url = url; this.readyState = 0; sources.push(this); } addEventListener() {} close() { this.readyState = 2; } }
  const item = tab(w);
  item.live.stop();
  setLiveFeatures('w1', ['events'], item.registry);
  const runs = [];
  const live = createLive({ registry: item.registry, timers: w.clock, now: w.clock.now, document: item.doc, window: item.win, navigator: { onLine: true }, EventSource: FakeSource, random: () => 0.5,
    tasks: [{ name: 'inbox', every: 5000, run: () => { runs.push(w.clock.now()); } }] });
  live.start();
  assert.equal(sources.length, 1);
  sources[0].readyState = 2; sources[0].onerror();
  await w.clock.advance(30000);
  assert.equal(sources.length, 1, 'não insiste antes de um minuto');
  assert.equal(runs.length, 6, 'os polls seguem a cada 5 s sem stream');
  await w.clock.advance(35000);
  assert.equal(sources.length, 2, 'nova tentativa depois de um minuto');
  live.stop();
});

test('indicador de conexão: oculto sem medida, Ao vivo, Atrasado com Tentar agora e Offline com aviso; anuncia só transições', async () => {
  const { createConnectionStatus, connectionMarkup } = await import('../public/connection-status.js');
  assert.equal(connectionMarkup({ connection: null }), null);
  assert.match(String(connectionMarkup({ connection: 'live', lastSuccess: 8000 }, 10000)), /Ao vivo<\/span>/);
  assert.match(String(connectionMarkup({ connection: 'live', lastSuccess: 8000 }, 10000)), /title="Atualizado há 2 s"/);
  const late = String(connectionMarkup({ connection: 'late', lastSuccess: 0 + 1000 }, 33000));
  assert.match(late, /Atrasado/); assert.match(late, /atualizado há 32 s/); assert.match(late, /data-action="live:retry"/);
  assert.match(String(connectionMarkup({ connection: 'offline' })), /Offline/);
  let value = { connection: null, lastSuccess: null };
  const slot = { hidden: true, attrs: {}, innerHTML: '', status: { textContent: '' }, setAttribute(name, val) { this.attrs[name] = val; }, getAttribute(name) { return this.attrs[name] ?? null; }, removeAttribute(name) { delete this.attrs[name]; },
    querySelector(selector) { return selector === '[data-conn-status]' && this.innerHTML ? this.status : null; } };
  const banners = { html: '', node: null, querySelector(selector) { return selector === '[data-banner="connection"]' ? this.node : null; }, insertAdjacentHTML(_where, html) { this.html = html; this.node = { remove: () => { this.node = null; this.html = ''; } }; } };
  const doc = { querySelector: selector => selector === '[data-shell-slot="connection"]' ? slot : selector === '[data-shell-slot="banners"]' ? banners : null };
  const indicator = createConnectionStatus({ live: { state: () => value }, registry: createLiveRegistry(), now: () => 10000 });
  assert.equal(indicator.apply(doc), false); assert.equal(slot.hidden, true, 'desconhecido: nunca "ao vivo"');
  value = { connection: 'live', lastSuccess: 9000 };
  assert.equal(indicator.apply(doc), true); assert.equal(slot.hidden, false); assert.equal(slot.attrs['data-state'], 'live');
  assert.equal(slot.status.textContent, '', 'a primeira pintura não é anunciada');
  value = { connection: 'offline', lastSuccess: 9000 };
  indicator.apply(doc);
  assert.equal(slot.attrs['data-state'], 'offline'); assert.equal(slot.status.textContent, 'Conexão: Offline', 'transição real anunciada');
  assert.match(banners.html, /Sem conexão\./); assert.match(banners.html, /Seu texto fica no compositor/);
  assert.match(banners.html, /não é repetido/, 'o aviso não promete reenvio nem envio pausado');
  assert.doesNotMatch(banners.html, /Envio pausado|Tentaremos de novo/);
  value = { connection: 'live', lastSuccess: 10000 };
  indicator.apply(doc);
  assert.equal(banners.node, null, 'o aviso sai quando a conexão volta');
});

test('a aba que a pessoa olha lidera: a seguidora que volta a ficar visível toma o lock e a antiga segue', async () => {
  const w = world(), first = tab(w, { view: 'overview' }), second = tab(w, { view: 'overview', visible: false });
  first.live.start(); second.live.start();
  await settle();
  assert.equal(first.live.state().leader, true, 'a aba visível lidera');
  assert.equal(second.live.state().leader, false);
  first.doc.visibilityState = 'hidden'; first.doc.listeners.visibilitychange();
  second.doc.visibilityState = 'visible'; second.doc.listeners.visibilitychange();
  await settle();
  assert.equal(second.live.state().leader, true, 'a aba mostrada de novo toma a liderança (steal)');
  assert.equal(first.live.state().leader, false, 'a antiga líder vira seguidora');
  assert.equal(w.navigator.locks.queues.get(lockName({ userId: 'u1', workspaceId: 'w1' })).length, 2, 'a antiga líder volta para a fila, uma única vez');
  second.live.stop();
  await settle();
  assert.equal(first.live.state().leader, true, 'quando a nova líder sai, a da fila assume');
  first.live.stop();
});

test('a batida da líder mantém a seguidora "Ao vivo" sem mudança de snapshot e sem apagar as falhas dela', async () => {
  const w = world(), leader = tab(w, { view: 'overview' }), follower = tab(w, { view: 'overview', visible: false });
  leader.live.start(); follower.live.start();
  await settle();
  assert.equal(leader.live.state().leader, true);
  reportLive('success', leader.registry, w.clock.now());
  await settle();
  assert.equal(follower.registry.health.lastSuccess, w.clock.now(), 'a seguidora soube do sucesso da líder');
  await w.clock.advance(3000);
  reportLive('success', leader.registry, w.clock.now());
  await settle();
  assert.equal(follower.registry.health.lastSuccess, 1000, 'no máximo uma batida a cada 5 s');
  follower.registry.health.failures = 2;
  await w.clock.advance(3000);
  reportLive('success', leader.registry, w.clock.now());
  await settle();
  assert.equal(follower.registry.health.lastSuccess, 7000);
  assert.equal(follower.registry.health.failures, 2, 'falhas das requisições da própria aba continuam valendo');
  leader.live.stop(); follower.live.stop();
});

test('fora do poll a página da caixa é buscada na hora (depois de Assumir) e uma resposta antiga não substitui a nova', async () => {
  const w = world(), item = tab(w);
  item.live.start();
  await settle();
  await w.clock.advance(5000);
  assert.equal(listCalls(w.server), 1, 'poll aos 5 s');
  await w.clock.advance(1000);
  await item.source.inboxPage(page('/api/inbox?status=active&tab=all'), { workspaceId: 'w1' });
  assert.equal(listCalls(w.server), 2, 'atualização pedida pela pessoa não usa a cópia do último poll');
  assert.equal(item.live.polling('inbox'), false);
  // A poll in flight that started before the fresh request never puts its older page back in the cache.
  const slow = [], original = w.server.request;
  w.server.request = (path, options) => path.startsWith('/api/inbox') && !slow.length ? new Promise(resolve => slow.push(() => resolve(original(path, options)))) : original(path, options);
  const before = item.live.shared('k', () => w.server.request('/api/inbox?status=active&tab=all', { headers: { 'X-Elozi-Workspace': 'w1' } }).then(value => ({ ...value, marker: 'antiga' })));
  await settle();
  await w.clock.advance(100);
  await item.live.shared('k', () => original('/api/inbox?status=active&tab=all', { headers: { 'X-Elozi-Workspace': 'w1' } }).then(value => ({ ...value, marker: 'nova' })), { reuse: false });
  slow[0](); await before;
  assert.equal((await item.live.shared('k', () => assert.fail('a cópia nova responde'))).marker, 'nova');
  w.server.request = original;
  item.live.stop();
});

test('Pendências/Equipe: update() com o mesmo corpo não reescreve a gaveta (o navegador serializa <path/> de outro jeito)', async () => {
  const { liveDrawer } = await import('../public/live.js');
  let writes = 0;
  const host = { scrollTop: 0, contains: () => false, _html: '', get innerHTML() { return this._html.replace(/<path([^>]*)\/>/g, '<path$1></path>'); }, set innerHTML(value) { writes++; this._html = value; }, querySelector: () => null };
  const dialog = { open: false, isConnected: true, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, addEventListener() {}, show() { this.open = true; }, showModal() { this.open = true; }, close() { this.open = false; },
    set innerHTML(_value) {}, querySelector: selector => selector === '[data-live-drawer-body]' ? host : null };
  const doc = { body: { append() {} }, activeElement: null, createElement: () => dialog, getElementById: () => null };
  const drawer = liveDrawer('serial-test', { doc, matchMedia: () => ({ matches: false }) });
  const body = '<p>Uma pendência <svg viewBox="0 0 24 24"><path d="M1 1"/></svg></p>';
  drawer.open({ title: 'Pendências', body });
  assert.equal(drawer.update(body), false, 'o mesmo corpo não é reescrito');
  assert.equal(writes, 0);
  assert.equal(drawer.update(body + '<p>outra</p>'), true);
  assert.equal(writes, 1);
  assert.equal(drawer.update(body + '<p>outra</p>'), false);
  drawer.close();
});

test('indicador Atrasado: os segundos mudam no próprio nó e o botão Tentar agora focado continua o mesmo', async () => {
  const { createConnectionStatus } = await import('../public/connection-status.js');
  let value = { connection: 'late', lastSuccess: 1000 }, now = 33000, rebuilds = 0;
  const since = { textContent: '' }, text = { attrs: {}, setAttribute(name, val) { this.attrs[name] = val; } }, status = { textContent: '' };
  const slot = { hidden: true, attrs: {}, _html: '', get innerHTML() { return this._html; }, set innerHTML(html) { rebuilds++; this._html = html; since.textContent = (html.match(/sh-conn__since">([^<]*)</) || [])[1] || ''; },
    setAttribute(name, val) { this.attrs[name] = val; }, getAttribute(name) { return this.attrs[name] ?? null; }, removeAttribute(name) { delete this.attrs[name]; },
    querySelector(selector) { if (!this._html) return null; return { '[data-conn-status]': status, '.sh-conn__since': since, '.sh-conn__text': text }[selector] || null; } };
  const doc = { querySelector: selector => selector === '[data-shell-slot="connection"]' ? slot : null };
  const indicator = createConnectionStatus({ live: { state: () => value }, registry: createLiveRegistry(), now: () => now });
  indicator.apply(doc);
  assert.equal(rebuilds, 1); assert.equal(since.textContent, 'atualizado há 32 s');
  now = 38000; indicator.apply(doc);
  assert.equal(rebuilds, 1, 'mesmo estado: nada é redesenhado (o foco fica no botão)');
  assert.equal(since.textContent, 'atualizado há 37 s'); assert.equal(text.attrs.title, 'Atualizado há 37 s');
  value = { connection: 'live', lastSuccess: 38000 }; indicator.apply(doc);
  assert.equal(rebuilds, 2, 'mudança de estado redesenha');
  now = 44000; indicator.apply(doc);
  assert.equal(rebuilds, 2, 'Ao vivo: só o tooltip muda'); assert.equal(text.attrs.title, 'Atualizado há 6 s');
});
