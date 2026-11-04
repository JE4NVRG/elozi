// Agent as attendant, administration (FRONTEND-V2 §5.3.2 Acesso): agent.autopilot through POST/PATCH /agents, version CAS,
// administrator only, validation against the company's channels and departments, and receipts never leaving SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeFixture } from './helpers/realtime-fixture.js';
import { knowledgeMetadataSnapshot } from '../src/postgres-bridge.js';

const config = extra => ({ enabled: true, channelIds: ['wa-a1'], maxRepliesPerHour: 4, requireKnowledge: true, handoffDepartmentId: 'support', ...extra });

test('administrador liga o piloto automático com CAS de versão; operador é recusado', async t => {
  const f = await realtimeFixture(t);
  const path = '/api/tenants/rt-a1/agents/agent-1';
  const denied = await f.request(path, { as: 'sales', method: 'PATCH', body: { version: 1, autopilot: config() } });
  assert.equal(denied.status, 403);
  const saved = await f.request(path, { method: 'PATCH', body: { version: 1, autopilot: config() } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.data.version, 2);
  assert.deepEqual(saved.data.autopilot, { enabled: true, channelIds: ['wa-a1'], maxRepliesPerHour: 4, requireKnowledge: true, quietHours: null, handoffDepartmentId: 'support' });
  const stale = await f.request(path, { method: 'PATCH', body: { version: 1, autopilot: config({ enabled: false }) } });
  assert.equal(stale.status, 409);
  const agent = f.tenant('rt-a1').agents.find(item => item.id === 'agent-1');
  assert.equal(agent.version, 2); assert.equal(agent.autopilot.maxRepliesPerHour, 4);
  assert.equal(agent.versions.at(-1).version, 1, 'a revisão anterior fica no histórico do agente');
  assert.equal(Object.hasOwn(agent.versions.at(-1).config, 'autopilot'), false);
  const cleared = await f.request(path, { method: 'PATCH', body: { version: 2, autopilot: null } });
  assert.equal(cleared.status, 200, cleared.text); assert.equal(cleared.data.autopilot, null);
  assert.equal(Object.hasOwn(f.tenant('rt-a1').agents.find(item => item.id === 'agent-1'), 'autopilot'), false);
});

test('configuração inválida, canal de outra empresa ou departamento inexistente não muda o agente', async t => {
  const f = await realtimeFixture(t);
  const path = '/api/tenants/rt-a1/agents/agent-1', before = JSON.stringify(f.tenant('rt-a1').agents);
  for (const autopilot of [config({ channelIds: [] }), config({ channelIds: ['wa-a2'] }), config({ handoffDepartmentId: 'nope' }), config({ maxRepliesPerHour: 31 }),
    config({ quietHours: { timezone: 'Mars/Base', start: '22:00', end: '07:00' } }), config({ extra: true }), 'on', ['wa-a1']]) {
    const result = await f.request(path, { method: 'PATCH', body: { version: 1, autopilot } });
    assert.equal(result.status, 400, JSON.stringify(autopilot));
  }
  assert.equal(JSON.stringify(f.tenant('rt-a1').agents), before);
});

test('cadastro aceita piloto só para Hermes; agente MCP responde pelas ferramentas de atendimento', async t => {
  const f = await realtimeFixture(t);
  const mcp = await f.request('/api/tenants/rt-a1/agents', { method: 'POST', body: { name: 'Externo', provider: 'mcp', mode: 'copilot', description: 'Agente conectado.', autopilot: config() } });
  assert.equal(mcp.status, 400);
  const hermes = await f.request('/api/tenants/rt-a1/agents', { method: 'POST', body: { name: 'Hermes novo', provider: 'hermes', mode: 'copilot', description: 'Atende.', autopilot: config({ enabled: false, channelIds: ['tg-a1'] }) } });
  assert.equal(hermes.status, 201, hermes.text);
  assert.deepEqual(hermes.data.autopilot.channelIds, ['tg-a1']);
  assert.equal(f.tenant('rt-a1').agents.length, 2);
});

test('recibos do piloto ficam fora do DTO, da conversa paginada e da projeção PostgreSQL', async t => {
  const f = await realtimeFixture(t);
  f.mutate('rt-a1', state => {
    state.agentAutopilotJobs = [{ id: 'autopilot_receipt_sintetico', conversationId: 'c-agent', state: 'sent' }];
    state.conversations.find(item => item.id === 'c-agent').messages.push({ id: 'c-agent-sent', kind: 'agent', text: 'Resposta automática sintética', agentId: 'agent-1', autopilotJobId: 'autopilot_receipt_sintetico', createdAt: new Date().toISOString() });
  });
  for (const path of ['/api/tenants/rt-a1', '/api/tenants/rt-a1?summary=1', '/api/tenants/rt-a1/conversations/c-agent']) {
    const result = await f.request(path);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.text.includes('autopilot_receipt_sintetico'), false, path);
    assert.equal(result.text.includes('agentAutopilotJobs'), false, path);
  }
  const projected = knowledgeMetadataSnapshot(structuredClone(f.tenant('rt-a1')));
  assert.equal(JSON.stringify(projected).includes('autopilot_receipt_sintetico'), false);
  assert.equal(projected.conversations.find(item => item.id === 'c-agent').messages.at(-1).text, 'Resposta automática sintética');
});

test('atribuição ao agente com piloto ativo no canal informa a resposta automática; sem piloto mantém o envio humano', async t => {
  const f = await realtimeFixture(t);
  const assign = async (cid, version) => f.request(`/api/tenants/rt-a1/conversations/${cid}/owner`, { method: 'POST', body: { version, owner: 'agent', agentId: 'agent-1' } });
  let result = await assign('c-sales', 3);
  assert.equal(result.status, 200, result.text);
  assert.match(result.data.messages.at(-1).text, /O envio permanece com a equipe humana/);
  assert.equal((await f.request('/api/tenants/rt-a1/agents/agent-1', { method: 'PATCH', body: { version: 1, autopilot: config({ handoffDepartmentId: null }) } })).status, 200);
  result = await assign('c-support', 1);
  assert.equal(result.status, 200, result.text);
  assert.match(result.data.messages.at(-1).text, /O piloto automático responde neste canal/);
});
