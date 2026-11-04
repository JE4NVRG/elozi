import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

test('isolamento, permissões, origem da resposta e corrida humano/agente', async () => {
  const app = createApp({ databasePath: ':memory:' });
  app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('foreign-demo', JSON.stringify({ name: 'Outra revenda', brand: { name: 'Outra', initials: 'OT', accent: '#123456' } }));
  app.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('foreign-reseller-tenant', 'foreign-demo', JSON.stringify({ name: 'Cliente de outra revenda', brand: {}, channels: [], agents: [], conversations: [] }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { cookie = '', method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    assert.equal((await request('/api/bootstrap')).status, 401);
    const ownerInput = { username: 'owner-fixture', name: 'Administrador QA', password: 'Fixture!123A' };
    const operatorInput = { username: 'operator-fixture', name: 'Atendente QA', password: 'Operator!123A', role: 'operator', tenantIds: ['playtech-demo'] };
    const setup = await app.auth.setup(ownerInput);
    const operatorUser = await app.auth.createUser(setup.actor, operatorInput);
    app.store.mutate(setup.actor, 'playtech-demo', 'Fixture: copiloto configurado', state => { Object.assign(state.agents[0], { configured: true, mode: 'copilot' }); });
    assert.equal((await request('/api/demo-session', { method: 'POST', body: { role: 'operator' } })).status, 404);
    const resellerLogin = await request('/api/auth/login', { method: 'POST', body: { username: ownerInput.username, password: ownerInput.password } });
    const operatorLogin = await request('/api/auth/login', { method: 'POST', body: { username: operatorInput.username, password: operatorInput.password } });
    assert.equal(resellerLogin.status, 200); assert.equal(operatorLogin.status, 200);
    const reseller = resellerLogin.cookie, operator = operatorLogin.cookie;
    const operatorBoot = await request('/api/bootstrap', { cookie: operator });
    assert.deepEqual(operatorBoot.data.tenants.map(item => item.id), ['playtech-demo']);
    assert.equal((await request('/api/tenants/studio-demo', { cookie: operator })).status, 403);
    assert.equal((await request('/api/tenants/foreign-reseller-tenant', { cookie: reseller })).status, 404);
    assert.equal((await request('/api/tenants', { cookie: operator, method: 'POST', body: { name: 'Outro', segment: 'Teste' } })).status, 403);
    assert.equal((await request('/api/tenants/playtech-demo/brand', { cookie: operator, method: 'PATCH', body: { name: 'Outro', accent: '#3157d5', initials: 'OT' } })).status, 403);
    assert.equal((await request('/api/reseller/brand', { cookie: operator, method: 'PATCH', body: { name: 'Outro', accent: '#3157d5', initials: 'OT' } })).status, 403);
    assert.equal((await request('/api/tenants', { cookie: reseller, method: 'POST', body: { name: 'Teste', segment: 'Teste' }, headers: { Origin: 'https://foreign.example' } })).status, 403);
    const tenant = (await request('/api/tenants/playtech-demo', { cookie: operator })).data;
    const conversation = tenant.conversations[0], path = `/api/tenants/playtech-demo/conversations/${conversation.id}`;
    const initialClaim = await request(path + '/owner', { cookie: operator, method: 'POST', body: { owner: 'human', version: conversation.version } });
    assert.equal(initialClaim.status, 200);
    assert.equal(initialClaim.data.assignedUserId, operatorUser.id);
    assert.equal(initialClaim.data.version, conversation.version + 1);
    const wrongChannel = await request(path + '/messages', { cookie: operator, method: 'POST', body: { text: 'Resposta', version: initialClaim.data.version, channelId: tenant.channels[1].id } });
    assert.equal(wrongChannel.status, 400);
    const other = (await request('/api/tenants/studio-demo', { cookie: reseller })).data;
    assert.equal((await request(`/api/tenants/playtech-demo/conversations/${other.conversations[0].id}/owner`, { cookie: reseller, method: 'POST', body: { owner: 'human', version: other.conversations[0].version } })).status, 404);
    assert.equal((await request(path + '/owner', { cookie: operator, method: 'POST', body: { owner: 'agent', agentId: other.agents[0].id, version: initialClaim.data.version } })).status, 404);
    const assigned = await request(path + '/owner', { cookie: operator, method: 'POST', body: { owner: 'agent', agentId: tenant.agents[0].id, version: initialClaim.data.version } });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.data.owner, 'agent'); assert.equal(assigned.data.assignedUserId, null);
    assert.equal((await request(path + '/messages', { cookie: operator, method: 'POST', body: { text: 'Resposta indevida', version: assigned.data.version, channelId: conversation.channelId } })).status, 409);
    const draft = await request(path + '/draft', { cookie: operator, method: 'POST', body: { agentId: tenant.agents[0].id, version: assigned.data.version } });
    assert.equal(draft.status, 200);
    assert.equal(draft.data.providerCalled, false);
    const claimed = await request(path + '/owner', { cookie: operator, method: 'POST', body: { owner: 'human', version: assigned.data.version } });
    assert.equal(claimed.status, 200); assert.equal(claimed.data.version, assigned.data.version + 1);
    assert.equal(claimed.data.assignedUserId, operatorUser.id);
    assert.equal((await request(path + '/messages', { cookie: operator, method: 'POST', body: { text: draft.data.text, version: draft.data.version, channelId: conversation.channelId } })).status, 409);
    const sent = await request(path + '/messages', { cookie: operator, method: 'POST', body: { text: 'Resposta local válida', version: claimed.data.version, channelId: conversation.channelId } });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.messages.at(-1).delivery, 'sandbox');
    assert.equal(sent.data.messages.at(-1).authorUserId, operatorUser.id);
    assert.equal(sent.data.channelId, conversation.channelId);
    assert.equal((await request('/api/tenants/playtech-demo/channels', { cookie: reseller, method: 'POST', body: { name: 'Malicioso', kind: 'invalid' } })).status, 400);
    assert.equal((await request('/api/tenants/playtech-demo/brand', { cookie: reseller, method: 'PATCH', body: { name: 'Minha Marca', initials: 'MM', accent: 'url(https://foreign.example)' } })).status, 400);
    assert.equal((await request('/api/tenants/playtech-demo/brand', { cookie: reseller, method: 'PATCH', body: { name: 'Minha Marca', initials: 'MM', accent: '#123456' } })).status, 200);
    assert.equal((await request('/api/tenants/studio-demo', { cookie: reseller })).data.brand.name, 'Studio Aurora Chat');
    const created = await request('/api/tenants', { cookie: reseller, method: 'POST', body: { name: 'Nova Demo', segment: 'Serviço' } });
    assert.equal(created.status, 201);
    assert.equal(created.data.channels.length, 0);
    assert.equal(created.data.conversations.length, 0);
    assert.equal((await request('/api/tenants/' + created.data.id, { cookie: operator })).status, 403);
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
});
