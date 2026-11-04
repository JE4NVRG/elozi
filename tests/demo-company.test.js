import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp, demoRouteRefusal } from '../src/server.js';
import { Store, DEMO_CHANNEL_REFUSAL } from '../src/store.js';
import { PostgresBridge } from '../src/postgres-bridge.js';
import { createUnitsUI } from '../public/units-ui.js';
import { setLocale } from '../public/i18n.js';

// On-demand demo company (tenant.demo): fixture data in RAM, every external transport and model call denied.
const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const AGENT_REFUSAL = 'Empresa de demonstração não conecta agentes externos nem chama modelos de IA. Use uma empresa real.';

async function fixture(t) {
  const key = randomBytes(32), external = [];
  const denied = async (...args) => { external.push(args); throw new Error('Transporte externo proibido na demo sintética.'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: denied,
    gatewayOptions: { authKey: key, socketFactory: denied }, telegramOptions: { authKey: key, polling: false, fetchImpl: denied },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', cookie = '', body } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie()[0]?.split(';')[0] || '' };
  };
  const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Admin demo QA', username: 'demo.owner', password: password() } });
  assert.equal(setup.status, 200);
  const owner = { cookie: setup.cookie, actor: app.auth.workspaceActor(app.auth.authenticate(setup.cookie.slice('mep_session='.length))) };
  const real = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Empresa real QA', segment: 'Varejo' } });
  assert.equal(real.status, 201);
  return { app, request, owner, real: real.data, external };
}
const createDemo = async c => {
  const created = await c.request('/api/tenants/demo', { method: 'POST', cookie: c.owner.cookie, body: {} });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
};
const tenantRows = (db, id) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  .filter(({ name }) => db.prepare(`PRAGMA table_info("${name}")`).all().some(column => column.name === 'tenant_id'))
  .map(({ name }) => [name, db.prepare(`SELECT count(*) AS n FROM "${name}" WHERE tenant_id=?`).get(id).n]).filter(([, n]) => n > 0));

test('a demo nasce do fixture, marcada, sem transporte, uma por conta e não reabre no boot', async t => {
  const c = await fixture(t);
  assert.equal((await c.request('/api/tenants/demo', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Outra' } })).status, 400);
  const demo = await createDemo(c);
  assert.match(demo.id, /^tenant_[0-9a-f-]{36}$/);
  assert.deepEqual(demo.demo.createdBy, c.owner.actor.userId);
  assert.equal(demo.name, 'Empresa de demonstração');
  assert.equal(demo.parentTenantId, null);
  assert.equal(demo.channels.length, 4);
  assert.ok(demo.channels.every(channel => channel.transport === undefined && ['sandbox', 'planned'].includes(channel.state)));
  assert.equal(demo.conversations.length, 6);
  assert.ok(demo.conversations.every(conversation => conversation.contact.endsWith(' (demo)') && demo.departments.some(item => item.id === conversation.departmentId)));
  assert.ok(demo.conversations.filter(conversation => conversation.owner === 'human').every(conversation => conversation.assignedUserId === c.owner.actor.userId));
  const again = await c.request('/api/tenants/demo', { method: 'POST', cookie: c.owner.cookie, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'Esta conta já tem uma empresa de demonstração.');
  const boot = await c.request('/api/bootstrap', { cookie: c.owner.cookie });
  assert.deepEqual(boot.data.tenants.filter(tenant => tenant.demo).map(tenant => tenant.id), [demo.id]);
  assert.equal(boot.data.tenants.find(tenant => tenant.id === c.real.id).demo, false);
  await c.app.gateway.restore(); await c.app.telegram.restore(); await c.app.telegramUser.restore();
  assert.equal(c.app.gateway.entries.size, 0);
  assert.equal(c.external.length, 0);
});

test('a demo recusa canais, agentes externos e modelos, mas responde em sandbox', async t => {
  const c = await fixture(t), demo = await createDemo(c), path = `/api/tenants/${demo.id}`;
  for (const [route, body, message] of [
    ['channels', { name: 'WhatsApp real', kind: 'whatsapp_qr', real: true }, DEMO_CHANNEL_REFUSAL],
    [`channels/${demo.channels[0].id}/connect`, {}, DEMO_CHANNEL_REFUSAL],
    ['agents', { name: 'Hermes', provider: 'hermes', mode: 'copilot', description: 'Teste' }, AGENT_REFUSAL],
    [`agents/${demo.agents[0].id}`, { name: 'Outro' }, AGENT_REFUSAL],
    ['service-principals', { agentId: demo.agents[0].id }, AGENT_REFUSAL],
    [`conversations/${demo.conversations[0].id}/run`, { agentId: demo.agents[0].id }, AGENT_REFUSAL]
  ]) {
    const response = await c.request(`${path}/${route}`, { method: route.startsWith('agents/') ? 'PATCH' : 'POST', cookie: c.owner.cookie, body });
    assert.equal(response.status, 403, route);
    assert.equal(response.data.code, 'DEMO_COMPANY', route);
    assert.equal(response.data.error, message, route);
  }
  assert.throws(() => c.app.store.mutate(c.owner.actor, demo.id, 'Transporte forçado', tenant => { tenant.channels[0].transport = 'baileys'; }), { status: 403, code: 'DEMO_COMPANY', message: DEMO_CHANNEL_REFUSAL });
  assert.throws(() => c.app.store.mutate(c.owner.actor, demo.id, 'Marcação removida', tenant => { delete tenant.demo; }), { status: 409 });
  assert.ok(c.app.store.tenant(c.owner.actor, demo.id).channels.every(channel => channel.transport === undefined));
  const conversation = demo.conversations.find(item => item.owner === 'human');
  const reply = await c.request(`${path}/conversations/${conversation.id}/messages`, { method: 'POST', cookie: c.owner.cookie,
    body: { text: 'Resposta de demonstração.', version: conversation.version, channelId: conversation.channelId } });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(c.app.store.tenant(c.owner.actor, demo.id).conversations.find(item => item.id === conversation.id).messages.at(-1).delivery, 'sandbox');
  const renamed = c.app.store.updateTenantIdentity(c.owner.actor, demo.id, { name: 'Demo da apresentação', segment: 'Varejo', parentTenantId: null, version: 1 });
  assert.equal(renamed.name, 'Demo da apresentação');
  assert.throws(() => c.app.store.updateTenantIdentity(c.owner.actor, demo.id, { name: 'Demo', segment: 'Varejo', parentTenantId: c.real.id, version: 2 }), { status: 400 });
  assert.throws(() => c.app.store.createTenant(c.owner.actor, { name: 'Filial da demo', segment: 'QA', parentTenantId: demo.id }), { status: 400 });
  assert.equal(c.app.gateway.entries.size, 0);
  assert.equal(c.external.length, 0);
});

test('rotas recusadas pela demo: escritas de canal, agente externo e modelo; leitura e atendimento seguem', () => {
  assert.equal(demoRouteRefusal('channels', 'POST'), DEMO_CHANNEL_REFUSAL);
  assert.equal(demoRouteRefusal('channels/wa/widget-configuration', 'PUT'), DEMO_CHANNEL_REFUSAL);
  for (const action of ['agents', 'agents/a1', 'agents/a1/preview', 'agents/a1/mcp-grants', 'service-principals', 'service-principals/p1/rotate', 'mcp/servers', 'mcp/servers/s1', 'conversations/c1/run', 'conversations/c1/group-summary'])
    assert.equal(demoRouteRefusal(action, action === 'agents/a1' ? 'PATCH' : 'POST'), AGENT_REFUSAL, action);
  for (const [action, method] of [['channels', 'GET'], ['channels/wa/onboarding', 'GET'], ['conversations/c1/messages', 'POST'], ['conversations/c1/owner', 'POST'],
    ['conversations/c1/draft', 'POST'], ['agents/usage/limit', 'PATCH'], ['identity', 'PATCH'], ['contacts', 'POST'], ['flows', 'POST'], ['quick-replies', 'POST']])
    assert.equal(demoRouteRefusal(action, method), null, `${method} ${action}`);
});

test('a demo fica fora de inventário, cobrança e alertas; o inbox só a mostra selecionada', async t => {
  const c = await fixture(t);
  const usage = async () => (await c.request('/api/accounts/mep-demo/usage?scope=own', { cookie: c.owner.cookie })).data.inventory;
  const before = await usage(), counts = c.app.accounts.counts('mep-demo');
  const demo = await createDemo(c), after = await usage();
  assert.equal(after.tenants, before.tenants);
  assert.equal(after.channels.registered, before.channels.registered);
  assert.equal(after.agents.registered, before.agents.registered);
  assert.deepEqual(c.app.accounts.counts('mep-demo'), counts);
  assert.ok(!c.app.billing.getTenants(c.owner.actor, 'mep-demo').some(tenant => tenant.id === demo.id));
  const all = await c.request('/api/inbox?status=all&limit=100', { cookie: c.owner.cookie });
  assert.equal(all.status, 200);
  assert.ok(!all.data.items.some(item => item.tenantId === demo.id));
  assert.ok(!all.data.channels.some(item => item.tenantId === demo.id) && !all.data.departments.some(item => item.tenantId === demo.id));
  assert.deepEqual(all.data.tenants.find(item => item.id === demo.id), { id: demo.id, tenantId: demo.id, name: demo.name, demo: true });
  const selected = await c.request(`/api/inbox?status=all&limit=100&tenantId=${demo.id}`, { cookie: c.owner.cookie });
  assert.equal(selected.data.items.length, 6);
  assert.ok(selected.data.items.every(item => item.tenantId === demo.id));
  const attention = await c.request('/api/me/attention', { cookie: c.owner.cookie });
  assert.equal(attention.status, 200);
  const bell = JSON.stringify(attention.data);
  assert.ok(!bell.includes(demo.id), 'o sino da operação real não vê a demo');
});

test('a ponte PostgreSQL nunca enfileira a demo', t => {
  const store = new Store(':memory:'), bridge = new PostgresBridge(store, { pool: { on() {}, async end() {}, async connect() { throw new Error('sem banco'); } } });
  t.after(async () => { await bridge.close(); store.close(); });
  const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Ponte demo QA', userId: 'synthetic-admin' };
  const real = store.createTenant(actor, { name: 'Real', segment: 'QA' }), demo = store.createDemoTenant(actor);
  bridge.queue(demo.id); store.mutate(actor, demo.id, 'Edição da demo', tenant => { tenant.segment = 'Outro'; });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM postgres_spool WHERE tenant_id=?').get(demo.id).n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM postgres_spool WHERE tenant_id=?').get(real.id).n, 1);
});

test('remoção: só administrador, só a demo, acesso da equipe primeiro, linhas apagadas e outras contas isoladas', async t => {
  const c = await fixture(t), demo = await createDemo(c), path = `/api/tenants/${demo.id}`, db = c.app.store.db;
  const other = { role: 'reseller', resellerId: 'reseller_' + randomUUID(), name: 'Outra conta QA', userId: 'synthetic-other' };
  c.app.store.provisionReseller({ resellerId: other.resellerId, tenantId: 'tenant_' + randomUUID(), name: 'Outra conta QA' });
  assert.throws(() => c.app.store.tenant(other, demo.id), { status: 404 });
  assert.throws(() => c.app.store.removeDemoTenant(other, demo.id), { status: 404 });
  const otherDemo = c.app.store.createDemoTenant(other);
  const secret = password(), operator = await c.request('/api/users', { method: 'POST', cookie: c.owner.cookie,
    body: { name: 'Atendente demo QA', username: 'demo.operator', password: secret, role: 'operator', tenantIds: [demo.id, c.real.id] } });
  assert.equal(operator.status, 201, JSON.stringify(operator.data));
  const signed = await c.request('/api/auth/login', { method: 'POST', body: { username: 'demo.operator', password: secret } });
  assert.equal((await c.request(path, { method: 'DELETE', cookie: signed.cookie })).status, 403);
  const realDelete = await c.request(`/api/tenants/${c.real.id}`, { method: 'DELETE', cookie: c.owner.cookie });
  assert.equal(realDelete.status, 409);
  assert.equal(realDelete.data.error, 'Somente a empresa de demonstração pode ser removida.');
  const held = await c.request(path, { method: 'DELETE', cookie: c.owner.cookie });
  assert.equal(held.status, 409);
  assert.match(held.data.error, /Atendente demo QA/);
  assert.equal((await c.request(`/api/users/${operator.data.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { tenantIds: [c.real.id] } })).status, 200);
  db.prepare('INSERT INTO ai_usage (tenant_id,day,agent_id) VALUES (?,?,?)').run(demo.id, '2026-10-27', demo.agents[0].id);
  const seeded = tenantRows(db, demo.id);
  assert.ok(seeded.audit === 1 && seeded.service_tenant_private === 1 && seeded.service_conversation_private === 6 && seeded.ai_usage === 1, JSON.stringify(seeded));
  const tenantsBefore = db.prepare('SELECT count(*) AS n FROM tenants').get().n;
  const removed = await c.request(path, { method: 'DELETE', cookie: c.owner.cookie });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.deepEqual(removed.data, { id: demo.id, removed: true });
  assert.deepEqual(tenantRows(db, demo.id), {});
  assert.equal(db.prepare('SELECT count(*) AS n FROM tenants').get().n, tenantsBefore - 1);
  assert.equal((await c.request(path, { cookie: c.owner.cookie })).status, 404);
  assert.equal(c.app.store.tenant(c.owner.actor, c.real.id).name, 'Empresa real QA');
  assert.equal(c.app.store.tenant(other, otherDemo.id).demo.createdBy, 'synthetic-other');
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal((await c.request('/api/tenants/demo', { method: 'POST', cookie: c.owner.cookie, body: {} })).status, 201);
});

test('Empresas e filiais: selo, criação e remoção só para administrador; a demo não vira matriz nem filial', async t => {
  setLocale('pt-BR', { persist: false, notify: false });
  const previousLocation = globalThis.location; globalThis.location = { hash: '#settings/tenants' };
  t.after(() => { globalThis.location = previousLocation; });
  const real = { id: 'tenant-real', name: 'Loja real', segment: 'Varejo', channels: 2, conversations: 1, demo: false };
  const demo = { id: 'tenant-demo', name: 'Empresa de demonstração', segment: 'Atendimento e vendas · dados fictícios', channels: 4, conversations: 6, demo: true };
  const state = { workspaceId: 'workspace', supportGrantId: null, tenant: real, boot: { session: { userId: 'admin', role: 'reseller' }, tenants: [real] } };
  const modals = [], requests = [], refreshed = [], switched = [], toasts = [];
  let closed = 0;
  const ui = createUnitsUI({ state, escape: value => String(value), formModal: (...args) => modals.push(args), render: () => {}, toast: message => toasts.push(message),
    api: async (path, options) => { requests.push([path, options?.method]); return path === '/api/tenants/demo' ? { id: demo.id } : { id: demo.id, removed: true }; },
    refresh: async id => { refreshed.push(id); state.boot.tenants = requests.at(-1)?.[1] === 'DELETE' ? [real] : [real, demo]; return true; },
    getModal: () => ({ close: () => { closed++; } }), changeTenant: async id => { switched.push(id); return true; } });
  assert.match(ui.markup(), /data-action="new-demo-tenant"/);
  await ui.action('new-demo-tenant');
  assert.deepEqual(modals[0].slice(0, 3), ['Criar empresa de demonstração', 'Cria uma empresa com clientes, conversas e agentes fictícios para apresentar o atendimento. Nenhum canal é conectado, nada é enviado a clientes e ela não conta no plano nem nas métricas. Remova quando terminar.', 'demo-tenant']);
  assert.equal(await ui.submit({ dataset: { dialogForm: 'demo-tenant' } }), true);
  assert.deepEqual(requests[0], ['/api/tenants/demo', 'POST']);
  assert.deepEqual([refreshed[0], switched[0], globalThis.location.hash, closed], [demo.id, demo.id, `#inbox?tenant=${demo.id}`, 1]);
  const page = ui.markup();
  assert.doesNotMatch(page, /data-action="new-demo-tenant"/, 'uma demo por conta');
  assert.match(page, /ui-badge--info">Demonstração</);
  assert.match(page, /data-action="remove-demo-tenant" data-id="tenant-demo"|data-action="remove-demo-tenant"[^>]*data-id="tenant-demo"/);
  assert.doesNotMatch(page, /data-action="new-tenant"[^>]*data-id="tenant-demo"/);
  await ui.action('new-tenant');
  assert.doesNotMatch(String(modals.at(-1)[3]), /tenant-demo/, 'a demo não aparece como matriz');
  await ui.action('edit-tenant', demo.id);
  assert.match(String(modals.at(-1)[3]), /<label hidden>Estrutura/);
  await ui.action('remove-demo-tenant', demo.id);
  assert.deepEqual(modals.at(-1).slice(0, 3), ['Remover demonstração', 'Apaga a empresa de demonstração e todos os dados fictícios dela. Suas empresas reais não mudam.', 'demo-tenant-remove']);
  const form = { dataset: { dialogForm: 'demo-tenant-remove' } }, previousFormData = globalThis.FormData;
  globalThis.FormData = class { get(name) { return name === 'id' ? demo.id : null; } };
  t.after(() => { globalThis.FormData = previousFormData; });
  assert.equal(await ui.submit(form), true);
  assert.deepEqual(requests.at(-1), [`/api/tenants/${demo.id}`, 'DELETE']);
  assert.deepEqual(toasts, ['Empresa de demonstração criada.', 'Empresa de demonstração removida.']);
  assert.equal(await ui.submit({ dataset: { dialogForm: 'tenant' } }), false);
  state.boot.session.role = 'operator';
  assert.doesNotMatch(ui.markup(), /new-demo-tenant|remove-demo-tenant/);
});
