// Channel default agent on WhatsApp QR: a new or reopened direct attendance is born owned by a connected MCP agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WhatsAppGateway } from '../src/whatsapp.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Teste' };
const expected = '5511999990000';
const contact = n => `55119888800${String(n).padStart(2, '0')}@s.whatsapp.net`;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, { defaultAgentId = 'sellers', agents } = {}) {
  const store = new Store(':memory:'), sockets = [];
  const tenant = store.createTenant(admin, { name: 'Agente padrão', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Canal e agentes', state => {
    state.channels.push({ id: 'qr', kind: 'whatsapp_qr', name: 'WhatsApp', expectedNumber: expected, transport: 'baileys', state: 'disconnected', label: 'final 0000', ...(defaultAgentId ? { defaultAgentId } : {}) });
    state.agents = agents || [{ id: 'sellers', name: 'Agente dos sellers', provider: 'mcp', mode: 'copilot', configured: true, version: 1 },
      { id: 'admin', name: 'Agente admin', provider: 'mcp', mode: 'copilot', configured: true, version: 1 },
      { id: 'hermes-1', name: 'Hermes', provider: 'hermes', mode: 'copilot', configured: true, version: 1 }];
  });
  const factory = config => { const socket = { config, ev: new EventEmitter(), user: { id: expected + ':1@s.whatsapp.net' }, end() {}, logout: async () => {}, sendMessage: async () => ({ key: { id: 'x' } }) }; sockets.push(socket); return socket; };
  const gateway = new WhatsAppGateway(store, { socketFactory: factory, authKey: randomBytes(32), reconnectDelay: 10 });
  gateway.operations = new Operations(store, new Auth(store.db));
  t.after(async () => { await gateway.close(); store.close(); });
  await gateway.start(admin, tenant.id, 'qr');
  sockets.at(-1).config.auth.creds.me = { id: expected + ':1@s.whatsapp.net' }; sockets.at(-1).ev.emit('creds.update', {});
  sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await tick();
  const entry = gateway.entries.get('qr');
  let seq = 0;
  const receive = (n, extra = {}, text = 'Olá') => gateway.receive(entry, { key: { id: `msg-${++seq}`, remoteJid: contact(n), fromMe: false, ...extra.key }, pushName: 'Seller', messageTimestamp: extra.timestamp ?? Math.floor(Date.now() / 1000), message: { conversation: text } }, extra.options);
  const conversation = n => store.tenant(admin, tenant.id).conversations.find(item => item.remoteJid === contact(n));
  const mutate = (n, change) => store.mutate(admin, tenant.id, 'Fixture', state => { const c = state.conversations.find(item => item.remoteJid === contact(n)); change(c); c.version++; });
  return { store, tenant, gateway, receive, conversation, mutate };
}

test('conversa nova nasce com o agente padrão; reaberta volta ao agente dono no encerramento ou ao padrão', async t => {
  const f = await setup(t);
  await f.receive(1);
  assert.deepEqual([f.conversation(1).owner, f.conversation(1).agentId], ['agent', 'sellers']);
  assert.match(f.conversation(1).messages.find(item => item.kind === 'system').text, /Agente padrão do canal/);
  // Handed over to the admin agent, closed, then the customer writes again: back to the admin agent.
  f.mutate(1, c => { c.agentId = 'admin'; c.status = 'closed'; });
  await f.receive(1);
  assert.deepEqual([f.conversation(1).status, f.conversation(1).owner, f.conversation(1).agentId], ['open', 'agent', 'admin']);
  // Closed while with a person: the new cycle goes to the default agent.
  f.mutate(1, c => { c.owner = 'human'; c.agentId = null; c.status = 'closed'; });
  await f.receive(1);
  assert.deepEqual([f.conversation(1).owner, f.conversation(1).agentId], ['agent', 'sellers']);
  // In the queue after a transfer to the team, a new message does not hand it back to an agent.
  f.mutate(1, c => { c.owner = 'queue'; c.agentId = null; });
  await f.receive(1);
  assert.deepEqual([f.conversation(1).owner, f.conversation(1).agentId], ['queue', null]);
});

test('sem agente padrão, agente inválido, mensagem do próprio aparelho ou backlog antigo mantêm a fila', async t => {
  const none = await setup(t, { defaultAgentId: null });
  await none.receive(2); assert.equal(none.conversation(2).owner, 'queue');
  const invalid = await setup(t, { defaultAgentId: 'hermes-1' });
  await invalid.receive(3); assert.equal(invalid.conversation(3).owner, 'queue');
  const f = await setup(t);
  await f.receive(4, { key: { fromMe: true } }); assert.notEqual(f.conversation(4).owner, 'agent');
  await f.receive(5, { timestamp: Math.floor(Date.now() / 1000) - 7 * 86400, options: { backlog: true } }); assert.equal(f.conversation(5).owner, 'queue');
  // The admin agent no longer valid: a reopened attendance falls back to the default agent.
  await f.receive(6); f.mutate(6, c => { c.agentId = 'admin'; c.status = 'closed'; });
  f.store.mutate(admin, f.tenant.id, 'Admin desconfigurado', state => { state.agents.find(agent => agent.id === 'admin').configured = false; });
  await f.receive(6); assert.deepEqual([f.conversation(6).owner, f.conversation(6).agentId], ['agent', 'sellers']);
});
