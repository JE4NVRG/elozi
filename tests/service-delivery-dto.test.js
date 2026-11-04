import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';

function fixture(t) {
  const store = new Store(':memory:'), auth = new Auth(store.db);
  t.after(() => store.close());
  const row = auth.insertUser({ username: 'delivery.owner', name: 'Admin sintético' }, Buffer.alloc(16, 6), Buffer.alloc(64, 6), 'reseller', [], 'mep-demo');
  const admin = auth.session(row).actor, tenant = store.createTenant(admin, { name: 'Entregas sintéticas', segment: 'QA' });
  const channelId = randomUUID(), conversationId = randomUUID(), base = Date.now() - 600000;
  const at = minutes => new Date(base + minutes * 60000).toISOString();
  store.mutate(admin, tenant.id, 'Fixture de entrega', state => {
    state.channels = [{ id: channelId, name: 'WhatsApp', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }];
    state.departments = [];
    state.agents = [{ id: 'ext', name: 'MCP sintético', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.conversations = [{ id: conversationId, channelId, contact: 'Cliente', conversationKind: 'direct', departmentId: null, owner: 'agent', agentId: 'ext', assignedUserId: null, status: 'open', version: 3,
      messages: [
        { id: 'm-customer', kind: 'customer', text: 'Foto do produto', createdAt: at(1), delivery: 'received', attachments: [{ id: 'att-1', kind: 'image', name: 'foto.jpg', mime: 'image/jpeg', size: 10, status: 'pending' }] },
        { id: 'm-agent', kind: 'agent', text: 'Recebi', createdAt: at(2), delivery: 'delivered' },
        { id: 'm-human', kind: 'human', text: 'Olá', createdAt: at(3), delivery: 'read' },
        { id: 'm-legacy', kind: 'agent', text: 'Sem estado', createdAt: at(4) },
        { id: 'm-odd', kind: 'agent', text: 'Estado inesperado', createdAt: at(5), delivery: 'teleported' },
        { id: 'm-note', kind: 'note', text: 'Nota interna', createdAt: at(6), delivery: 'read' }] }];
  });
  const principals = new ServicePrincipals(store, auth), api = new ServiceApi(store, principals, {});
  const created = principals.create(admin, tenant.id, { name: 'Leitor sintético', agentId: 'ext', capabilities: ['conversation.read'], channelIds: [channelId], departmentIds: null, dailyRequests: 50, maxConcurrent: 2, ttlHours: 24 });
  const actor = principals.authenticate('Bearer ' + created.token);
  const mutate = callback => store.mutate(admin, tenant.id, 'Atualização sintética do provedor', state => callback(state.conversations[0]));
  return { api, actor, conversationId, mutate, at };
}

test('leitura de serviço expõe delivery só de mensagens da equipe/agente com estados conhecidos', t => {
  const f = fixture(t);
  const { conversation } = f.api.read(f.actor, f.conversationId, 'delivery_read_0001');
  const byId = Object.fromEntries(conversation.messages.map(message => [message.id, message]));
  assert.equal(byId['m-agent'].delivery, 'delivered'); assert.equal(byId['m-human'].delivery, 'read');
  for (const id of ['m-customer', 'm-legacy', 'm-odd']) assert.equal(Object.hasOwn(byId[id], 'delivery'), false, id);
  assert.equal(byId['m-note'], undefined, 'internal notes stay out');
  assert.equal(byId['m-customer'].attachments[0].status, 'pending');
});

test('histórico expõe delivery e estado do anexo sem invalidar o cursor quando o provedor atualiza', t => {
  const f = fixture(t);
  const window = { after: f.at(0), before: f.at(10) };
  const first = f.api.readConversationHistory(f.actor, { requestId: 'delivery_history_01', conversationId: f.conversationId, limit: 2, ...window });
  assert.deepEqual(first.messages.map(message => message.id), ['m-legacy', 'm-odd']);
  assert.equal(Object.hasOwn(first.messages[0], 'delivery'), false); assert.equal(Object.hasOwn(first.messages[1], 'delivery'), false);
  f.mutate(c => { c.messages.find(m => m.id === 'm-agent').delivery = 'read'; c.messages[0].attachments[0].status = 'ready'; });
  const second = f.api.readConversationHistory(f.actor, { requestId: 'delivery_history_02', conversationId: f.conversationId, limit: 2, cursor: first.nextCursor, ...window });
  assert.deepEqual(second.messages.map(message => message.id), ['m-agent', 'm-human']);
  assert.equal(second.messages[0].delivery, 'read', 'a later page shows the current provider signal'); assert.equal(second.messages[1].delivery, 'read');
  const third = f.api.readConversationHistory(f.actor, { requestId: 'delivery_history_03', conversationId: f.conversationId, limit: 2, cursor: second.nextCursor, ...window });
  assert.deepEqual(third.messages.map(message => message.id), ['m-customer']);
  assert.equal(Object.hasOwn(third.messages[0], 'delivery'), false); assert.equal(third.messages[0].attachments[0].status, 'ready');
});
