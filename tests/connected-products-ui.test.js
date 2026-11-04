// Plataforma › Produtos conectados: the markup shows products, the protection between own lines and agent events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedProductsMarkup, createConnectedProductsUI } from '../public/connected-products-ui.js';

const data = {
  generatedAt: '2026-10-19T03:00:00.000Z', activitySince: '2026-10-19T01:41:00.000Z', ownLines: 3,
  products: [
    { tenantId: 't-fp', name: 'FamilyPoints', qaConversations: 1, ownLineConversations: 3, last24h: { agentReplies: 148, notices: 2 }, sinceStart: { limitHits: 3, noticesSent: 2, ownLineBlocks: 0 },
      channels: [{ id: 'fp', name: 'FamilyPoints · WhatsApp', kind: 'whatsapp_qr', state: 'connected', tail: '4662', ownLine: true, automation: ['connected-agent'], defaultAgent: null,
        replyPolicy: { profile: 'assistant', perHour: 120, perMinute: 12, notice: true } }],
      agents: [{ id: 'p1', name: 'Tuca', agent: 'Tuca', state: 'active', channels: 1, webhook: { configured: false } }] },
    { tenantId: 't-fc', name: 'FullCommerce', qaConversations: 0, ownLineConversations: 1, last24h: { agentReplies: 0, notices: 0 }, sinceStart: { limitHits: 0, noticesSent: 0, ownLineBlocks: 1 },
      channels: [{ id: 'fc', name: 'FullCommerce · WhatsApp', kind: 'whatsapp_qr', state: 'connected', tail: '6828', ownLine: true, automation: [], defaultAgent: null, replyPolicy: { profile: 'attendance' } }],
      agents: [{ id: 'p2', name: 'Sellers', agent: 'Agente dos sellers', state: 'active', channels: 1, webhook: { configured: true, enabled: false, origin: 'https://fc.example', lastStatus: null, failures: 0, pending: 0 } }] }
  ],
  pairs: [{ state: 'one-agent', sides: [
    { company: 'FamilyPoints', channel: 'FamilyPoints · WhatsApp', tail: '4662', owner: 'agent', agent: 'Tuca', qa: true },
    { company: 'FullCommerce', channel: 'FullCommerce · WhatsApp', tail: '6828', owner: 'queue', agent: null, qa: null }] }],
  events: [
    { at: '2026-10-19T02:41:00.000Z', type: 'reply-limit', company: 'FamilyPoints', action: null, window: 'minute', max: 12, noticeSent: true },
    { at: '2026-10-19T02:10:00.000Z', type: 'own-line', company: 'FullCommerce', action: 'claim', window: null, max: null, noticeSent: false }
  ]
};

test('produtos, proteção entre linhas e eventos aparecem sem número completo nem marca', () => {
  const html = String(connectedProductsMarkup(data));
  for (const text of ['Produtos conectados', 'FamilyPoints', 'FullCommerce', 'WhatsApp · final 4662', 'Assistente · 120/h · 12/min · aviso ligado', 'Atendimento',
    'Protegido: agente só de um lado', 'Webhook desligado', 'Espera de eventos', '1 conversas sem limite por hora', 'Limite por minuto atingido (12)', 'Aviso enviado ao usuário',
    'Agente bloqueado entre linhas próprias (ao assumir)', 'Nenhum laço possível agora', 'data-action="connected-products-refresh"']) assert.ok(html.includes(text), text);
  assert.equal(html.includes('Elozi'), false);
  assert.match(html, /aria-labelledby="own-lines-title"/);
  const blocked = String(connectedProductsMarkup({ ...data, pairs: [{ ...data.pairs[0], state: 'both-agents' }] }));
  assert.ok(blocked.includes('Agentes nos dois lados: respostas bloqueadas')); assert.ok(blocked.includes('1 pares com agentes nos dois lados'));
});

test('estados de carga, erro e vazio, e a atualização pelo botão', async () => {
  assert.ok(String(connectedProductsMarkup(null)).includes('Carregando os produtos…'));
  assert.ok(String(connectedProductsMarkup(null, { error: 'Sem acesso' })).includes('Sem acesso'));
  assert.ok(String(connectedProductsMarkup({ ...data, products: [], pairs: [], events: [] })).includes('Nenhuma empresa nesta operação'));
  let calls = 0, renders = 0;
  const toasts = [];
  const ui = createConnectedProductsUI({ request: async path => { calls++; assert.equal(path, '/api/platform/connected-products'); return data; }, onRender: () => { renders++; }, toast: message => toasts.push(message) });
  await ui.load();
  assert.equal(calls, 1); assert.ok(renders >= 2); assert.ok(String(ui.view()).includes('FamilyPoints'));
  assert.equal(await ui.action('outra-acao'), false);
  assert.equal(await ui.action('connected-products-refresh'), true); assert.equal(calls, 2); assert.deepEqual(toasts, ['Produtos atualizados.']);
  const failing = createConnectedProductsUI({ request: async () => { throw new Error('Somente a administração da operação vê os produtos conectados.'); } });
  await failing.load();
  assert.ok(String(failing.view()).includes('Somente a administração'));
});
