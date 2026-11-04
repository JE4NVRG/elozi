// Conectar produto: six steps, one idempotent creation call, the key only in memory and a live end-to-end checklist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectedProductsUI } from '../public/connected-products-ui.js';

const products = { generatedAt: '2026-10-19T04:00:00.000Z', activitySince: '2026-10-19T03:34:00.000Z', ownLines: 1, pairs: [], events: [],
  products: [{ tenantId: 't-fp', name: 'FamilyPoints', qaConversations: 0, ownLineConversations: 0, last24h: { agentReplies: 0, notices: 0 }, sinceStart: { limitHits: 0, noticesSent: 0, ownLineBlocks: 0 },
    channels: [{ id: 'wa', name: 'WhatsApp', kind: 'whatsapp_qr', state: 'connected', tail: '4662', ownLine: true, automation: [], defaultAgent: null, replyPolicy: { profile: 'attendance' } }], agents: [] }] };
const form = (name, entries) => { const data = new FormData(); for (const [key, value] of entries) data.append(key, value); return [{ dataset: { productConnectForm: name } }, data]; };

function harness({ fail = null } = {}) {
  const calls = [], toasts = [], copied = [], timers = [];
  let lastSeenAt = null, replies24h = 0, webhookEnabled = false, defaultAgent = null;
  const request = async (path, options = {}) => {
    calls.push([options.method || 'GET', path, options.body ? JSON.parse(options.body) : null]);
    if (fail && fail(path, options)) throw new Error('Falha sintética do servidor.');
    if (path === '/api/platform/connected-products') {
      const agents = calls.some(([method, target]) => method === 'POST' && target === '/api/platform/product-connections')
        ? [{ id: 'p1', name: 'FamilyPoints · Agente', state: 'active', lastSeenAt, replies24h, webhook: { configured: true, enabled: webhookEnabled, lastStatus: webhookEnabled ? 200 : null, failures: 0, pending: 0 } }] : [];
      return { ...products, products: [{ ...products.products[0], agents, channels: [{ ...products.products[0].channels[0], defaultAgent }] }] };
    }
    if (path === '/api/tenants/t-fp?summary=1') return { channels: [{ id: 'wa', name: 'WhatsApp', kind: 'whatsapp_qr', state: 'connected', label: 'final 4662' }, { id: 'off', name: 'Desligado', kind: 'telegram', enabled: false }] };
    if (path === '/api/platform/product-connections') return { replay: false, tenantId: 't-fp', channelId: 'wa', kind: 'assistant', agent: { id: 'a1', name: 'FamilyPoints · Agente' },
      principal: { id: 'p1', revision: 1 }, token: 'elozi_svc_SEGREDO-DE-TESTE-1234567890', keyLost: false, webhook: { configured: true, enabled: false }, secret: 'elozi_whsec_SEGREDO-WEBHOOK-ABCDEFGH', secretLost: false, replyPolicy: { profile: 'assistant' } };
    if (path === '/api/tenants/t-fp/service-principals/p1/webhook' && !options.method) return { webhook: { revision: 1, enabled: webhookEnabled } };
    if (path === '/api/tenants/t-fp/service-principals/p1/webhook' && options.method === 'PUT') { webhookEnabled = true; return { webhook: { configured: true, enabled: true } }; }
    if (path === '/api/tenants/t-fp/channels/wa/default-agent') { defaultAgent = 'FamilyPoints · Agente'; return {}; }
    throw new Error(`rota inesperada ${path}`);
  };
  let clock = Date.parse('2026-10-19T04:00:00Z');
  const ui = createConnectedProductsUI({ request, toast: (message, isError) => toasts.push([message, Boolean(isError)]),
    wizardOptions: { copy: async value => { copied.push(value); }, origin: () => 'https://elozi.example', now: () => clock, schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {}, visible: () => true } });
  return { ui, calls, toasts, copied, timers, html: () => String(ui.view()), set: values => { ({ lastSeenAt = lastSeenAt, replies24h = replies24h } = values); }, tick: ms => { clock += ms; } };
}

test('caminho completo: seis passos, uma chamada de criação, chave só mascarada e checklist ao vivo', async () => {
  const f = harness();
  await f.ui.load();
  assert.ok(f.html().includes('data-action="product-connect-start"'));
  await f.ui.action('product-connect-start');
  assert.ok(f.html().includes('Qual produto vai falar com os clientes?'));
  await f.ui.submit(...form('product', [['tenantId', 't-fp'], ['kind', 'assistant']]));
  assert.ok(f.html().includes('Por onde os clientes chegam?')); assert.ok(f.html().includes('final 4662')); assert.equal(f.html().includes('Desligado'), false, 'disabled channels stay out');
  await f.ui.submit(...form('channel', [['channelId', 'wa']]));
  assert.ok(f.html().includes('value="FamilyPoints · Agente"'), 'agent name suggested from the product');
  await f.ui.submit(...form('agent', [['agentName', 'FamilyPoints · Agente'], ['capabilities', 'reply.send'], ['capabilities', 'events.read']]));
  await f.ui.submit(...form('events', [['events', 'webhook'], ['webhookUrl', 'http://inseguro'], ['secretMode', 'generate']]));
  assert.ok(f.html().includes('Informe o endereço HTTPS do webhook'));
  await f.ui.submit(...form('events', [['events', 'webhook'], ['webhookUrl', 'https://fp.example/elozi'], ['secretMode', 'generate']]));
  await f.ui.submit(...form('replies', [['perHour', '120'], ['perMinute', '12'], ['notice', 'Espera um minutinho.']]));
  const creations = f.calls.filter(([, path]) => path === '/api/platform/product-connections');
  assert.equal(creations.length, 1);
  assert.deepEqual({ ...creations[0][2], requestId: 'x' }, { requestId: 'x', tenantId: 't-fp', channelId: 'wa', kind: 'assistant', agentName: 'FamilyPoints · Agente',
    capabilities: ['conversation.read', 'reply.send', 'events.read'], replyPolicy: { perHour: 120, perMinute: 12, notice: 'Espera um minutinho.' }, webhook: { url: 'https://fp.example/elozi' } });
  assert.match(creations[0][2].requestId, /^product-/);
  let html = f.html();
  assert.equal(html.includes('SEGREDO-DE-TESTE-1234567890'), false, 'the key is never rendered in full'); assert.ok(html.includes('elozi_svc_SEGR••••7890'));
  assert.equal(html.includes('SEGREDO-WEBHOOK'), false); assert.ok(html.includes('https://elozi.example/api/service/v1'));
  assert.match(html, /data-action="product-connect-finish"[^>]*disabled/, 'finishing waits for the saved key');
  await f.ui.action('product-connect-copy-key'); await f.ui.action('product-connect-copy-secret');
  assert.deepEqual(f.copied, ['elozi_svc_SEGREDO-DE-TESTE-1234567890', 'elozi_whsec_SEGREDO-WEBHOOK-ABCDEFGH']);
  await f.ui.action('product-connect-key-saved', { checked: true });
  // Live checklist: key used, webhook turned on and delivered, first agent reply, default agent.
  f.set({ lastSeenAt: '2026-10-19T04:01:00.000Z' }); await f.timers[0]();
  assert.match(f.html(), /data-complete="true"[^]*O produto usou a chave/);
  await f.ui.action('product-connect-webhook-on');
  assert.ok(f.calls.some(([method, path, body]) => method === 'PUT' && path.endsWith('/p1/webhook') && body.enabled === true && body.revision === 1));
  f.set({ replies24h: 2 }); await f.timers[0]();
  await f.ui.action('product-connect-default-agent'); await f.timers[0]();
  html = f.html();
  assert.equal((html.match(/data-complete="true"/g) || []).length, 4, html);
  await f.ui.action('product-connect-finish');
  assert.equal(f.ui.wizard.active, false); assert.ok(f.toasts.some(([message]) => message === 'Produto conectado.'));
  assert.equal(f.html().includes('Conectar produto</h2>'), false); assert.equal(f.html().includes('elozi_svc_'), false, 'the key left with the wizard');
});

test('falha na criação mantém a requestId para repetir; produto novo cria a empresa; sem canal abre Canais', async () => {
  let failing = true;
  const f = harness({ fail: path => failing && path === '/api/platform/product-connections' });
  await f.ui.load(); await f.ui.action('product-connect-start');
  await f.ui.submit(...form('product', [['tenantId', 't-fp'], ['kind', 'attendance']]));
  await f.ui.submit(...form('channel', [['channelId', 'wa']]));
  await f.ui.submit(...form('agent', [['agentName', 'Atendente']]));
  await f.ui.submit(...form('events', [['events', 'wait']]));
  await f.ui.submit(...form('replies', []));
  assert.ok(f.html().includes('Falha sintética do servidor.'));
  failing = false;
  await f.ui.submit(...form('replies', []));
  const ids = f.calls.filter(([, path]) => path === '/api/platform/product-connections').map(([, , body]) => body.requestId);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1], 'the retry reuses the requestId');
  const body = f.calls.filter(([, path]) => path === '/api/platform/product-connections')[1][2];
  assert.equal(body.kind, 'attendance'); assert.equal('replyPolicy' in body, false); assert.equal('webhook' in body, false);
  assert.deepEqual(body.capabilities, ['conversation.read']);
  await f.ui.action('product-connect-cancel'); assert.equal(f.ui.wizard.active, false);

  const opened = [];
  const g = harness();
  const ui = createConnectedProductsUI({ request: async (path, options = {}) => {
    if (path === '/api/tenants' && options.method === 'POST') return { id: 't-new', name: 'Produto novo' };
    if (path === '/api/tenants/t-new?summary=1') return { channels: [] };
    if (path === '/api/platform/connected-products') return products;
    throw new Error(path);
  }, openChannels: async tenantId => { opened.push(tenantId); } });
  await ui.load(); await ui.action('product-connect-start');
  await ui.submit(...form('product', [['tenantId', 'new'], ['newCompany', ''], ['kind', 'assistant']]));
  assert.ok(String(ui.view()).includes('Dê um nome ao novo produto.'));
  await ui.submit(...form('product', [['tenantId', 'new'], ['newCompany', 'Produto novo'], ['kind', 'assistant']]));
  assert.ok(String(ui.view()).includes('Esta empresa ainda não tem canal'));
  await ui.action('product-connect-open-channels');
  assert.deepEqual(opened, ['t-new']); assert.equal(ui.wizard.active, false);
  assert.ok(g.ui);
});
