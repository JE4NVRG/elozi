// Shared synthetic fixture of the P9 realtime/delta tests (FRONTEND-V2 §8.10): two workspaces, two companies in the first,
// channel/department scoped operators and an administrator. No external transport, provider or database is reached.
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../../src/server.js';

export const at = (minutes = 0) => new Date(Date.parse('2026-10-06T12:00:00.000Z') + minutes * 60000).toISOString();
export const message = (id, kind, text, minutes = 0, extra = {}) => ({ id, kind, text, createdAt: at(minutes), ...extra });
export function conversation(id, extra = {}) {
  return { id, contact: 'Contato sintético ' + id, initials: 'CS', channelId: 'wa-a1', departmentId: 'sales', owner: 'queue', status: 'open',
    unread: 0, version: 1, tags: [], updatedAt: at(), messages: [message(id + '-m1', 'customer', 'Pergunta pública ' + id)], ...extra };
}

export async function realtimeFixture(t, { providerCall, appOptions = {} } = {}) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido na fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: providerCall || deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny }, ...appOptions });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const db = app.store.db;
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('ws-a', JSON.stringify({ name: 'Workspace A', brand: { name: 'Marca A', initials: 'A', accent: '#3157d5', domain: '' } }));
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('ws-b', JSON.stringify({ name: 'Workspace B', brand: { name: 'Marca B', initials: 'B', accent: '#3157d5', domain: '' } }));
  const user = (name, role, tenantIds, resellerId, permissions, scopeRules) => {
    const row = app.auth.insertUser({ name, username: name.toLowerCase().replace(/\W+/g, '.') }, randomBytes(16), randomBytes(64), role, tenantIds, resellerId);
    if (permissions || scopeRules) db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions ? JSON.stringify(permissions) : null, scopeRules ? JSON.stringify(scopeRules) : null, row.id);
    const session = app.auth.session(db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    return { id: row.id, name, cookie: 'mep_session=' + session.token, token: session.token };
  };
  const users = {
    admin: user('Admin A', 'reseller', [], 'ws-a'),
    sales: user('Operador Vendas', 'operator', ['rt-a1'], 'ws-a', ['inbox.read', 'inbox.reply', 'contacts.read'], { 'rt-a1': { channelIds: ['wa-a1'], departmentIds: ['sales'] } }),
    support: user('Operador Suporte', 'operator', ['rt-a1'], 'ws-a', ['inbox.read', 'inbox.reply', 'contacts.read'], { 'rt-a1': { channelIds: ['wa-a1'], departmentIds: ['support'] } }),
    a2: user('Operador A2', 'operator', ['rt-a2'], 'ws-a', ['inbox.read', 'inbox.reply']),
    foreign: user('Admin B', 'reseller', [], 'ws-b')
  };
  const agent = { id: 'agent-1', name: 'Assistente sintético', provider: 'hermes', mode: 'copilot', state: 'configured', configured: true, version: 1, description: 'Agente sintético.', tools: ['conversation.read', 'reply.draft'] };
  const tenants = {
    'rt-a1': { name: 'Empresa A1', segment: 'QA', channels: [{ id: 'wa-a1', name: 'WhatsApp A1', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', expectedNumber: '5511000000001' },
      { id: 'tg-a1', name: 'Telegram A1', kind: 'telegram', transport: 'telegram-bot', state: 'connected' }],
      departments: [{ id: 'sales', name: 'Vendas' }, { id: 'support', name: 'Suporte' }], agents: [agent], runs: [], flows: [],
      conversations: [
        conversation('c-sales', { unread: 2, messages: [message('c-sales-m1', 'customer', 'Primeira', 1), message('c-sales-m2', 'human', 'Resposta', 2), message('c-sales-m3', 'customer', 'Segunda', 3)], version: 3, updatedAt: at(3) }),
        conversation('c-support', { departmentId: 'support', unread: 1, updatedAt: at(2) }),
        conversation('c-mine', { owner: 'human', assignedUserId: users.sales.id, assignedUserName: 'Operador Vendas', unread: 1, updatedAt: at(1) }),
        conversation('c-agent', { owner: 'agent', agentId: 'agent-1', updatedAt: at(-30), messages: [message('c-agent-m1', 'customer', 'Alguém aí?', -30)] }),
        conversation('c-tg', { channelId: 'tg-a1', unread: 4, updatedAt: at(4) })
      ] },
    'rt-a2': { name: 'Empresa A2', segment: 'QA', channels: [{ id: 'wa-a2', name: 'WhatsApp A2', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }],
      departments: [], agents: [], runs: [], flows: [], conversations: [conversation('c-a2', { channelId: 'wa-a2', departmentId: null, unread: 1 })] },
    'rt-b1': { name: 'Empresa B1', segment: 'QA', channels: [{ id: 'wa-b1', name: 'WhatsApp B1', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }],
      departments: [], agents: [], runs: [], flows: [], conversations: [conversation('c-b1', { channelId: 'wa-b1', departmentId: null, unread: 1 })] }
  };
  for (const [id, data] of Object.entries(tenants)) db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, id === 'rt-b1' ? 'ws-b' : 'ws-a', JSON.stringify(data));
  app.gateway.entries.set('wa-a1', { tenantId: 'rt-a1', channelId: 'wa-a1', state: 'connected' });
  const system = tenantId => ({ role: 'reseller', resellerId: tenantId === 'rt-b1' ? 'ws-b' : 'ws-a', name: 'Fixture sintética' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { as = 'admin', method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const cookie = as ? users[as].cookie : '';
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: response.statusCode, headers: response.headers, data, text });
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, db, users, base, request, mutate: (tenantId, fn) => app.store.mutate(system(tenantId), tenantId, 'Fixture sintética', fn),
    tenant: tenantId => app.store.tenant(system(tenantId), tenantId) };
}
