import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeFixture } from './helpers/realtime-fixture.js';

async function previewFixture(t) {
  const calls = [];
  let reply = async () => ({ text: 'Rascunho de prévia', usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } });
  const f = await realtimeFixture(t, { providerCall: async context => { calls.push(context); return reply(context, calls.length); } });
  const version = cid => f.tenant('rt-a1').conversations.find(item => item.id === cid).version;
  const preview = (body, { as = 'admin', agentId = 'agent-1', tenant = 'rt-a1' } = {}) => f.request(`/api/tenants/${tenant}/agents/${agentId}/preview`, { as, method: 'POST', body });
  return { ...f, calls, version, preview, setReply: value => { reply = value; } };
}

test('prévia gera rascunho com instruções de teste sem gravar run, mensagem ou conversa e consome cota', async t => {
  const f = await previewFixture(t);
  f.mutate('rt-a1', tenant => { tenant.agents[0].instructions = 'Instrução salva.'; });
  const before = JSON.stringify(f.tenant('rt-a1').conversations), runsBefore = f.tenant('rt-a1').runs.length, agentBefore = JSON.stringify(f.tenant('rt-a1').agents);
  const result = await f.preview({ conversationId: 'c-sales', conversationVersion: f.version('c-sales'), instructions: 'Responda sempre com o nome da loja.', instruction: 'Seja breve.' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.draft, 'Rascunho de prévia'); assert.equal(result.data.persisted, false);
  assert.deepEqual(result.data.toolSteps, []); assert.deepEqual(result.data.wouldPropose, []); assert.deepEqual(result.data.tokens, { input: 40, output: 8 });
  assert.ok(Number.isInteger(result.data.latencyMs));
  assert.equal(f.calls.length, 1);
  const system = f.calls[0].messages[0].content;
  assert.ok(system.includes('Responda sempre com o nome da loja.')); assert.equal(system.includes('Instrução salva.'), false, 'unsaved instructions replace the saved ones in the preview only');
  assert.ok(f.calls[0].messages.some(message => message.content.includes('Seja breve.')));
  assert.match(f.calls[0].runId, /^preview_/);
  assert.equal(JSON.stringify(f.tenant('rt-a1').conversations), before); assert.equal(f.tenant('rt-a1').runs.length, runsBefore);
  assert.equal(JSON.stringify(f.tenant('rt-a1').agents), agentBefore);
  assert.equal(f.app.runtime.usage({ role: 'reseller', resellerId: 'ws-a' }, 'rt-a1', { days: 1 }).today.totalTokens, 48);
  assert.ok((await f.request('/api/bootstrap')).data.features.includes('agent-preview'));
});

test('prévia nunca executa ferramenta: a proposta vira wouldPropose e uma segunda chamada sem ferramentas escreve', async t => {
  const f = await previewFixture(t);
  const mcp = f.app.runtime.mcp, original = { snapshot: mcp.snapshot, definitions: mcp.definitions };
  t.after(() => Object.assign(mcp, original));
  mcp.snapshot = () => [{ alias: 'elozi_mcp_erp', serverName: 'ERP sintético', toolName: 'erp_cancel_order', title: 'Cancelar pedido', readOnly: false }];
  mcp.definitions = tools => tools.map(tool => ({ type: 'function', function: { name: tool.alias, description: tool.title, parameters: { type: 'object' } } }));
  f.setReply(async (context, index) => index === 1 ? { toolCall: { id: 'call_1', name: 'elozi_mcp_erp', arguments: { orderId: '42' } }, usage: { prompt_tokens: 10, completion_tokens: 2 } }
    : { text: 'Vou verificar seu pedido com a equipe.', usage: { prompt_tokens: 12, completion_tokens: 6 } });
  const result = await f.preview({ conversationId: 'c-sales', conversationVersion: f.version('c-sales') });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.wouldPropose, [{ serverName: 'ERP sintético', toolName: 'erp_cancel_order', title: 'Cancelar pedido', external: true }]);
  assert.deepEqual(result.data.toolSteps, []); assert.equal(result.data.draft, 'Vou verificar seu pedido com a equipe.');
  assert.deepEqual(result.data.tokens, { input: 22, output: 8 });
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].tools.length, 1); assert.deepEqual(f.calls[1].tools, []);
  assert.ok(f.calls[1].messages.some(message => message.content.includes('nenhuma ferramenta é executada')));
  assert.equal(f.tenant('rt-a1').runs.length, 0);
});

test('prévia isola empresa, departamento e papel, confere a versão e a cota antes do provedor', async t => {
  const f = await previewFixture(t);
  const body = () => ({ conversationId: 'c-sales', conversationVersion: f.version('c-sales') });
  for (const as of ['sales', 'support', 'a2']) assert.equal((await f.preview(body(), { as })).status, 403, as);
  assert.equal((await f.preview(body(), { as: 'foreign' })).status, 404);
  assert.equal((await f.preview({ conversationId: 'c-b1', conversationVersion: 1 }, { tenant: 'rt-b1' })).status, 404);
  assert.equal((await f.preview({ conversationId: 'c-a2', conversationVersion: 1 }, { tenant: 'rt-a2' })).status, 404, 'the agent belongs to another company');
  assert.equal((await f.preview({ conversationId: 'c-sales', conversationVersion: 999 })).status, 409);
  assert.equal((await f.preview({ conversationId: 'missing', conversationVersion: 1 })).status, 404);
  for (const invalid of [{}, { conversationId: 'c-sales' }, { ...body(), extra: true }, { ...body(), instruction: 'x'.repeat(1001) }, { ...body(), instructions: 'x'.repeat(4001) }]) assert.equal((await f.preview(invalid)).status, 400, JSON.stringify(Object.keys(invalid)));
  f.mutate('rt-a1', tenant => { tenant.aiDailyTokenLimit = 10; });
  f.app.runtime._meter('rt-a1', 'agent-1', { prompt: 10 });
  const quota = await f.preview(body());
  assert.equal(quota.status, 429); assert.equal(quota.data.code, 'ai_quota_exceeded');
  assert.equal(f.calls.length, 0, 'no refused preview reached the provider');
});

test('prévia em curso bloqueia outra da mesma pessoa e libera ao terminar', async t => {
  const f = await previewFixture(t);
  let release; const waiting = new Promise(resolve => { release = resolve; });
  f.setReply(async () => { await waiting; return { text: 'Pronto' }; });
  const first = f.preview({ conversationId: 'c-sales', conversationVersion: f.version('c-sales') });
  while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 5));
  const busy = await f.preview({ conversationId: 'c-sales', conversationVersion: f.version('c-sales') });
  assert.equal(busy.status, 429); assert.equal(busy.data.code, undefined);
  release(); assert.equal((await first).status, 200);
  f.setReply(async () => ({ text: 'De novo' }));
  assert.equal((await f.preview({ conversationId: 'c-sales', conversationVersion: f.version('c-sales') })).data.draft, 'De novo');
});

test('busca de conhecimento em prévia: trechos das fontes concedidas ao agente, só para administração', async t => {
  const f = await previewFixture(t);
  const api = (path, options = {}) => f.request('/api/tenants/rt-a1/' + path, options);
  const source = await api('knowledge/sources', { method: 'POST', body: { title: 'Prazo de entrega', category: 'Logística', content: 'O prazo de entrega para capitais é de três dias úteis.' } });
  assert.equal(source.status, 201, JSON.stringify(source.data));
  const published = (await api(`knowledge/sources/${source.data.id}/publish`, { method: 'POST', body: { version: source.data.version } })).data;
  const grants = await api('agents/agent-1/knowledge-grants');
  assert.equal((await api('agents/agent-1/knowledge-grants', { method: 'PUT', body: { version: grants.data.version, grants: [{ sourceId: published.id, publicationVersion: published.published.version, publicationHash: published.published.hash }] } })).status, 200);
  const found = await api('knowledge/search-preview', { method: 'POST', body: { agentId: 'agent-1', query: 'Qual o prazo de entrega nas capitais?' } });
  assert.equal(found.status, 200, JSON.stringify(found.data));
  assert.equal(found.data.state, 'matched'); assert.equal(found.data.truncated, false);
  assert.deepEqual(Object.keys(found.data.matches[0]).sort(), ['excerpt', 'score', 'sourceId', 'title']);
  assert.equal(found.data.matches[0].sourceId, published.id); assert.match(found.data.matches[0].excerpt, /três dias úteis/);
  assert.equal((await api('knowledge/search-preview', { method: 'POST', body: { agentId: 'agent-1', query: 'xyzw' } })).data.matches.length, 0);
  for (const as of ['sales', 'a2']) assert.equal((await api('knowledge/search-preview', { as, method: 'POST', body: { agentId: 'agent-1', query: 'prazo' } })).status, 403, as);
  assert.equal((await f.request('/api/tenants/rt-a2/knowledge/search-preview', { method: 'POST', body: { agentId: 'agent-1', query: 'prazo' } })).status, 404);
  assert.equal((await f.request('/api/tenants/rt-b1/knowledge/search-preview', { method: 'POST', body: { agentId: 'agent-1', query: 'prazo' } })).status, 404);
  for (const invalid of [{ agentId: 'agent-1' }, { agentId: 'agent-1', query: '' }, { agentId: 'agent-1', query: 'x'.repeat(1301) }, { agentId: 'agent-1', query: 'a', extra: 1 }]) assert.equal((await api('knowledge/search-preview', { method: 'POST', body: invalid })).status, 400);
  assert.ok((await f.request('/api/bootstrap')).data.features.includes('knowledge-preview'));
});
