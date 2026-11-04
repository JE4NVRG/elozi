// Attention (FRONTEND-V2 §5.3.4, §7.1, §7.4, §8.3 P2): "não lidas para mim" from the pulse or from
// GET /api/me/attention, honest Pendências sections (null = "Indisponível nesta versão", never a
// false zero) and the snapshot handed from the leader tab to the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import { createAttention, EMPTY_ATTENTION, PULSE_PATH, normalizeAttention, pendingTotal, unreadFromPulse, waitingAgent } from '../public/attention.js';
import { createLiveRegistry, setLiveFeatures } from '../public/live.js';
import { registryEntries } from '../public/actions.js';

test.afterEach(() => i18n.setLocale('pt-BR', { persist: false, notify: false }));
const pulsePage = (mine, queue, workspaceId = 'w1') => ({ workspaceId, items: [], total: mine + queue, countTabs: { all: mine + queue + 4, mine, queue, agent: 0 } });

function fixture({ context = {}, features, responses = {} } = {}) {
  const calls = [], registry = createLiveRegistry();
  const value = { workspaceId: 'w1', userId: 'u1', supportGrantId: null, view: 'overview', ...context };
  if (features) setLiveFeatures('w1', features, registry);
  const request = async (path, options) => {
    calls.push([path, options.headers['X-Elozi-Workspace']]);
    const answer = responses[path.split('?')[0]] ?? responses[path];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(path) : answer;
  };
  const attention = createAttention({ request, context: () => value, registry, now: () => 1_700_000_000_000 });
  return { attention, calls, context: value, registry };
}

test('sem contexto nada é consultado e todas as seções ficam indisponíveis (nunca zero)', async () => {
  const attention = createAttention({ request: async () => assert.fail('sem contexto não há requisição') });
  assert.equal(await attention.refresh(), EMPTY_ATTENTION);
  for (const value of Object.values(EMPTY_ATTENTION)) assert.equal(value, null);
  assert.equal(attention.unreadForMe(), null); assert.equal(attention.pendingCount(), null);
});

test('pulso: GET /api/inbox?status=active&unread=1&limit=1 → countTabs.mine + countTabs.queue, recursos lidos uma vez', async () => {
  const f = fixture({ responses: { '/api/bootstrap': { features: [] }, '/api/inbox': pulsePage(3, 2) } });
  const changes = [];
  f.attention.subscribe(snapshot => changes.push(snapshot.unreadForMe?.total ?? null));
  const snapshot = await f.attention.refresh();
  assert.deepEqual(f.calls, [['/api/bootstrap', 'w1'], [PULSE_PATH, 'w1']]);
  assert.equal(snapshot.unreadForMe.total, 5); assert.equal(snapshot.source, 'pulse');
  assert.equal(snapshot.approvals, null, 'sem fonte: indisponível'); assert.equal(snapshot.handoffs, null); assert.equal(snapshot.parked, null);
  assert.equal(pendingTotal(snapshot), null, 'o sino não mostra zero falso');
  await f.attention.refresh();
  assert.deepEqual(f.calls.map(([path]) => path), ['/api/bootstrap', PULSE_PATH, PULSE_PATH], 'o bootstrap não é repetido');
  assert.equal(changes.at(-1), 5);
  assert.equal(unreadFromPulse(pulsePage(1, 1, 'outro'), 'w1'), null, 'página de outro workspace não conta');
  assert.equal(unreadFromPulse({ countTabs: { mine: 1 } }, 'w1'), null);
});

test('contexto da empresa aberta alimenta aprovações, canais e propostas (admin), sem inventar o resto', async () => {
  let proposals = 0;
  const f = fixture({ features: [], context: { tenantId: 't1', tenantName: 'Loja Centro', admin: true,
    runs: [{ id: 'r1', state: 'waiting_approval', conversationId: 'c1', agentName: 'Assistente', pendingTool: { title: 'ERP › Consultar pedido' } }, { id: 'r2', state: 'draft', conversationId: 'c2' }],
    channels: [{ id: 'ch1', name: 'WhatsApp Atacado', transport: 'baileys', state: 'logged_out' }, { id: 'ch2', name: 'Telegram', transport: 'telegram', state: 'connected' }] },
  responses: { '/api/inbox': pulsePage(0, 1), '/api/tenants/t1/agent-admin-proposals': () => { proposals++; return { proposals: [{ id: 'p1', state: 'pending', canApprove: true }, { id: 'p2', state: 'approved' }] }; } } });
  const snapshot = await f.attention.refresh();
  assert.deepEqual(snapshot.approvals.map(item => [item.conversationId, item.agentName, item.toolTitle]), [['c1', 'Assistente', 'ERP › Consultar pedido']]);
  assert.deepEqual(snapshot.channelsDown.map(item => [item.channelId, item.state]), [['ch1', 'logged_out']]);
  assert.deepEqual(snapshot.proposals, { total: 1, byTenant: { t1: 1 } });
  assert.equal(pendingTotal(snapshot), 3);
  await f.attention.refresh();
  assert.equal(proposals, 1, 'propostas no máximo uma vez por minuto');
  const operator = fixture({ features: [], context: { tenantId: 't1' }, responses: { '/api/inbox': pulsePage(1, 0) } });
  await operator.attention.refresh();
  assert.ok(operator.calls.every(([path]) => !path.includes('proposals')), 'quem não é admin não consulta propostas');
});

test('feature "attention": GET /api/me/attention normalizado; campos omitidos ficam indisponíveis', async () => {
  const dto = { workspaceId: 'w1', revision: 'a_1', generatedAt: '2026-10-06T12:00:00Z', unreadForMe: { total: 5, byTenant: { t1: 3, t2: 2 } },
    approvals: [{ tenantId: 't1', conversationId: 'c9', runId: 'r7', agentName: 'Hermes', toolTitle: 'ERP', external: true, expiresAt: '2026-10-06T12:06:00Z' }],
    handoffs: { total: 1, byTenant: { t2: 1 } }, parked: [{ tenantId: 't2', conversationId: 'c3', since: '2026-10-06T11:40:00Z' }], channelsDown: [] };
  const f = fixture({ features: ['attention'], responses: { '/api/me/attention': dto } });
  const snapshot = await f.attention.refresh();
  assert.deepEqual(f.calls, [['/api/me/attention', 'w1']]);
  assert.deepEqual(snapshot.unreadForMe, { total: 5, byTenant: { t1: 3, t2: 2 } });
  assert.equal(snapshot.proposals, null, 'omitido para quem não é admin'); assert.equal(snapshot.aiQuota, null);
  assert.deepEqual(snapshot.channelsDown, []); assert.equal(pendingTotal(snapshot), 3);
  assert.equal(normalizeAttention({ ...dto, workspaceId: 'w2' }, 'w1'), null, 'snapshot de outro workspace é recusado');
});

test('gaveta Pendências: seções parciais honestas e as seções do P6 quando existirem', async () => {
  const f = fixture({ features: [], responses: { '/api/inbox': pulsePage(2, 0) } });
  await f.attention.refresh();
  const markup = String(f.attention.drawerMarkup());
  assert.match(markup, /Não lidas para você <span class="lv-pending__count">\(2\)<\/span>/);
  for (const title of ['Aprovações dos agentes', 'Pedidos de apoio de agentes', 'Conversas paradas com agente', 'Canais com problema']) assert.match(markup, new RegExp(`${title}</h3><p class="lv-pending__unavailable">Indisponível nesta versão</p>`), title);
  assert.doesNotMatch(markup, /Propostas de configuração|Cota de IA/, 'seções de admin não aparecem para quem não é admin');
  assert.doesNotMatch(markup, /\(0\)/, 'nenhum zero falso');
  assert.match(markup, /href="#pending"/, 'Ver todas leva a #pending');
  i18n.setLocale('en', { persist: false, notify: false });
  assert.match(String(f.attention.drawerMarkup()), /Unavailable in this version/);
  i18n.setLocale('pt-BR', { persist: false, notify: false });
  const p6 = createAttention({ request: async () => pulsePage(0, 0), context: () => f.context, registry: f.registry, pending: { drawerSections: snapshot => ['<section data-p6>seções do P6</section>'] } });
  assert.match(String(p6.drawerMarkup()), /data-p6/);
  assert.doesNotMatch(String(p6.drawerMarkup()), /Aprovações dos agentes/);
});

test('snapshot da líder chega às outras abas; outro workspace é ignorado; troca de escopo deixa o snapshot velho', async () => {
  const f = fixture({ features: [], responses: { '/api/inbox': pulsePage(1, 1) } });
  const seen = [];
  f.attention.subscribe(snapshot => seen.push(snapshot.unreadForMe?.total));
  assert.equal(f.attention.stale(), true, 'antes do primeiro snapshot');
  assert.equal(f.attention.receive({ workspaceId: 'w1', unreadForMe: { total: 7, byTenant: null } }), true);
  assert.equal(f.attention.unreadForMe(), 7); assert.equal(f.attention.stale(), false);
  assert.equal(f.attention.receive({ workspaceId: 'w2', unreadForMe: { total: 9 } }), false);
  f.context.workspaceId = 'w2';
  assert.equal(f.attention.stale(), true);
  assert.deepEqual(seen, [7]);
});

test('o sino abre a gaveta: shell:pending é registrado depois dos padrões do P1', async () => {
  const doc = { body: { append() {} }, createElement: () => ({}) };
  createAttention({ request: async () => ({}), context: () => ({}), registry: createLiveRegistry(), document: doc });
  await Promise.resolve();
  assert.ok(registryEntries().actions.includes('shell:pending'));
});

test('o pulso informa o live.js: fora da caixa o indicador fica "Ao vivo" com pulsos bons e conta as falhas de rede', async () => {
  const { createLive } = await import('../public/live.js');
  let now = 1000, fail = false;
  const registry = createLiveRegistry(), timers = new Map();
  let sequence = 0;
  const clock = { now: () => now, setTimeout(fn, ms) { timers.set(++sequence, { at: now + ms, fn }); return sequence; }, clearTimeout(id) { timers.delete(id); } };
  const advance = async ms => { const end = now + ms; for (;;) { const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; timers.delete(next[0]); now = next[1].at; next[1].fn(); for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); } now = end; };
  setLiveFeatures('w1', [], registry);
  const request = async path => { if (fail) throw new TypeError('Failed to fetch'); return path.startsWith('/api/inbox') ? pulsePage(1, 0) : {}; };
  const attention = createAttention({ request, context: () => ({ workspaceId: 'w1', userId: 'u1', view: 'agents' }), registry, now: () => now });
  const doc = { visibilityState: 'visible', addEventListener() {}, querySelector: () => null };
  const live = createLive({ registry, timers: clock, now: clock.now, document: doc, window: null, navigator: { onLine: true }, attention, random: () => 0.5 });
  live.start();
  const seen = new Set();
  for (let step = 0; step < 12; step++) { await advance(5000); seen.add(live.state().connection); }
  assert.deepEqual([...seen], ['live'], 'tela Agentes, sem SSE: 60 s de pulsos bons nunca viram "Atrasado"');
  fail = true;
  await advance(15000); await advance(15000);
  assert.ok(registry.health.failures >= 2, 'falha de rede do pulso conta');
  assert.notEqual(live.state().connection, 'live');
  live.stop();
});

test('403 do pulso não diz nada sobre a conexão', async () => {
  const f = fixture({ responses: { '/api/bootstrap': { features: [] }, '/api/inbox': Object.assign(new Error('sem acesso'), { status: 403 }) } });
  await assert.rejects(f.attention.refresh());
  assert.equal(f.registry.health.failures, 0);
  const ok = fixture({ responses: { '/api/bootstrap': { features: [] }, '/api/inbox': pulsePage(1, 1) } });
  await ok.attention.refresh();
  assert.equal(ok.registry.health.lastSuccess, 1_700_000_000_000, 'sucesso do pulso registrado');
});

test('fila sem dono: normalizada com a linha de saúde do agente, conta no sino e servidor antigo fica indisponível', () => {
  const dto = { workspaceId: 'w1', revision: 'a_2', parked: [], waitingTotal: 3, waiting: [
    { tenantId: 't1', conversationId: 'c1', since: '2026-10-27T13:39:05.215Z', agent: { name: 'Sofia', lastSeenAt: '2026-10-27T13:40:00.000Z' } },
    { tenantId: 't1', conversationId: 'c2', since: '2026-10-27T13:41:00.608Z' }] };
  const snapshot = normalizeAttention(dto, 'w1');
  assert.deepEqual(snapshot.waiting, [
    { tenantId: 't1', conversationId: 'c1', since: '2026-10-27T13:39:05.215Z', agent: { name: 'Sofia', lastSeenAt: '2026-10-27T13:40:00.000Z' } },
    { tenantId: 't1', conversationId: 'c2', since: '2026-10-27T13:41:00.608Z', agent: null }]);
  assert.equal(pendingTotal(snapshot), 3, 'the bell counts every waiting conversation, not only the 50 listed');
  const old = normalizeAttention({ workspaceId: 'w1', parked: [] }, 'w1');
  assert.equal(old.waiting, null); assert.equal(pendingTotal(old), 0);
  const now = Date.parse('2026-10-27T13:56:00.000Z');
  assert.equal(waitingAgent({ name: 'Sofia', lastSeenAt: '2026-10-27T13:40:00.000Z' }, now), 'Sofia: última chamada há 16 min');
  assert.equal(waitingAgent({ name: 'Sofia', lastSeenAt: '2026-10-27T13:55:40.000Z' }, now), 'Sofia: ativo agora');
  assert.equal(waitingAgent({ name: 'Sofia', lastSeenAt: null }, now), 'Sofia: nenhuma chamada registrada');
  assert.equal(waitingAgent(null, now), '');
  i18n.setLocale('en', { persist: false, notify: false });
  assert.equal(waitingAgent({ name: 'Sofia', lastSeenAt: '2026-10-27T13:40:00.000Z' }, now), 'Sofia: last call 16 min ago');
});
