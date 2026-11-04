import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import { renderAgentAdminProposals, agentProposalsMarkup, bindAgentAdminProposals, pendingProposalItems } from '../public/agent-admin-proposals-ui.js';

const proposal = (more = {}) => ({ id: 'proposal-a', version: 2, state: 'pending', type: 'agent', name: 'Agente de triagem', description: 'Rascunhos para revisão', serviceName: 'Meu agente externo', canApprove: true, ...more });
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attr = (source, name) => decode(new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(source)?.[1] || '');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const receipt = (action = 'approve', more = {}) => ({ proposal: proposal({ version: 3, state: action === 'approve' ? 'approved' : 'rejected', entityId: action === 'approve' ? 'entity-a' : null }), entity: action === 'approve' ? { id: 'entity-a', name: 'Agente de triagem', provider: 'mcp', mode: 'copilot', configured: true } : null, humanApprovalRequired: true, ...more });

function fixture(t, { intercept, onRefresh } = {}) {
  const calls = [], messages = [], cards = [], buttons = [], attributes = {};
  let source = [proposal()], body = '', text = '', refreshes = 0, member = true;
  const target = { get innerHTML() { return body; }, set innerHTML(value) {
    body = value; cards.splice(0); buttons.splice(0);
    for (const match of value.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)) {
      const local = [], error = { textContent: '', hidden: true, focused: 0, focus() { this.focused++; } };
      const card = { buttons: local, error, querySelectorAll(selector) { assert.equal(selector, 'button'); return local; }, querySelector(selector) { assert.equal(selector, '[data-proposal-error]'); return error; } };
      for (const buttonMarkup of match[1].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const listeners = new Map();
        const button = { disabled: /\bdisabled\b/.test(buttonMarkup[1]), textContent: buttonMarkup[2], dataset: { proposalId: attr(buttonMarkup[1], 'data-proposal-id'), proposalVersion: attr(buttonMarkup[1], 'data-proposal-version'), proposalAction: attr(buttonMarkup[1], 'data-proposal-action') },
          addEventListener(name, listener) { listeners.set(name, listener); }, closest(selector) { assert.equal(selector, 'article'); return card; },
          async click() { const listener = listeners.get('click'); assert.ok(listener, 'o módulo precisa instalar a ação real'); return listener(); } };
        local.push(button); buttons.push(button);
      }
      cards.push(card);
    }
  }, get textContent() { return text; }, set textContent(value) { text = value; body = ''; cards.splice(0); buttons.splice(0); },
    querySelectorAll(selector) { assert.equal(selector, '[data-proposal-action]'); return buttons; }, setAttribute(name, value) { attributes[name] = value; } };
  const panel = { isConnected: true, querySelector: selector => selector === '[data-agent-proposals-content]' ? target : null };
  const root = { querySelector: selector => selector === '[data-agent-admin-proposals-root]' ? panel : null, contains: candidate => member && candidate === panel };
  const fallback = (_path, init) => init.method === 'POST' ? receipt(JSON.parse(init.body).action) : { proposals: structuredClone(source) };
  const api = async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, () => fallback(path, init)) : fallback(path, init); };
  const refresh = async () => { refreshes++; await onRefresh?.(); };
  const bind = (more = {}) => bindAgentAdminProposals({ root, tenantId: 'tenant-a', api, refresh, toast: message => messages.push(message), admin: true, ...more });
  return { bind, root, panel, target, cards, buttons, calls, messages, attributes, refresh, api, refreshes: () => refreshes,
    detach: () => { panel.isConnected = false; }, remove: () => { member = false; }, source: value => { source = value; } };
}

test('shell oferece aprovação humana somente ao administrador humano fora do suporte delegado', () => {
  for (const role of ['operator', 'service', 'viewer', undefined]) assert.equal(renderAgentAdminProposals({ boot: { session: { role } } }), '');
  assert.equal(renderAgentAdminProposals({ boot: { session: { role: 'reseller' } }, supportGrantId: 'delegated' }), '');
  const html = renderAgentAdminProposals({ boot: { session: { role: 'reseller' } } });
  assert.match(html, /Aprovação humana/); assert.match(html, /confere e decide antes de criar/); assert.match(html, /aria-live="polite"/); assert.match(html, /Carregando propostas/);
});

test('proposta e grafo são exibidos com escape e não executam código nem expõem campos privados', () => {
  const html = agentProposalsMarkup([proposal({ id: 'a" onclick="bad', name: '<img onerror="bad()">', description: '<script>bad()</script>', serviceName: '<Serviço>', type: 'flow', graph: { nodes: [{ name: '</pre><script>bad()</script>' }] }, token: 'do-not-render', reasoning: 'do-not-render' })]);
  for (const value of ['&lt;img onerror=&quot;bad()&quot;&gt;', '&lt;script&gt;bad()&lt;/script&gt;', '&lt;Serviço&gt;', 'Novo fluxograma em rascunho', 'Aprovar e criar', 'Recusar']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<img|<script|onclick="bad|do-not-render/); assert.match(html, /data-proposal-error tabindex="-1" hidden/);
});

test('canApprove booleano controla criação e propostas encerradas não oferecem decisão', () => {
  for (const canApprove of [false, undefined, 'true', 1]) {
    const html = agentProposalsMarkup([proposal({ canApprove })]);
    assert.match(html, /data-proposal-action="approve" disabled/); assert.doesNotMatch(html, /data-proposal-action="reject" disabled/);
  }
  for (const state of ['approved', 'rejected', 'invalidated']) assert.doesNotMatch(agentProposalsMarkup([proposal({ state })]), /data-proposal-action/);
  assert.match(agentProposalsMarkup([]), /Conectar meu agente/); assert.match(agentProposalsMarkup([]), /Ajudar na gestão/); assert.match(agentProposalsMarkup([]), /ler a empresa e propor fluxos e agentes/);
  const many = agentProposalsMarkup(Array.from({ length: 45 }, (_unused, index) => proposal({ id: 'proposal-' + index }))); assert.equal([...many.matchAll(/<article /g)].length, 40);
});

test('binding exige admin booleano e empresa atual antes de ler propostas', async t => {
  const f = fixture(t);
  for (const admin of [undefined, false, 'true', 1]) f.bind({ admin });
  f.bind({ tenantId: '' }); f.bind({ root: null }); f.bind({ root: { querySelector: () => null } }); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.buttons.length, 0);
});

test('carga apresenta propostas sem aprovar nem criar recursos por inferência', async t => {
  const f = fixture(t); f.bind(); await settle();
  assert.deepEqual(f.calls.map(call => call.path), ['/api/tenants/tenant-a/agent-admin-proposals']); assert.equal(f.calls[0].init.method, undefined);
  assert.match(f.target.innerHTML, /Agente de triagem/); assert.equal(f.buttons.length, 2); assert.equal(f.buttons[0].disabled, false); assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0);
});

test('falha de carga é texto seguro em alerta local e não monta HTML do erro', async t => {
  const f = fixture(t, { intercept: async () => { throw new Error('<img onerror="bad()">'); } }); f.bind(); await settle();
  assert.equal(f.target.innerHTML, ''); assert.equal(f.target.textContent, '<img onerror="bad()">'); assert.equal(f.attributes.role, 'alert'); assert.equal(f.buttons.length, 0);
});

test('resposta e erro da empresa anterior não alteram novo painel após troca de workspace', async t => {
  for (const failure of [false, true]) await t.test(failure ? 'erro' : 'resposta', async child => {
    const d = deferred(), f = fixture(child, { intercept: () => d.promise }); f.bind(); f.remove();
    if (failure) d.reject(new Error('Resultado da empresa anterior')); else d.resolve({ proposals: [proposal({ name: 'Empresa anterior' })] }); await settle();
    assert.equal(f.target.innerHTML, ''); assert.equal(f.target.textContent, ''); assert.equal(f.buttons.length, 0); assert.equal(f.messages.length, 0);
  });
});

test('aprovação bloqueada não despacha e recusa com erro conserva bloqueio de canApprove=false', async t => {
  const f = fixture(t, { intercept: (_path, init, fallback) => { if (init.method === 'POST') throw Object.assign(new Error('Proposta mudou. Atualize.'), { status: 409 }); return fallback(); } });
  f.source([proposal({ canApprove: false })]); f.bind(); await settle(); const [approve, reject] = f.buttons;
  await approve.click(); assert.equal(f.calls.length, 1); await reject.click();
  assert.equal(f.cards[0].error.hidden, false); assert.equal(f.cards[0].error.focused, 1); assert.match(f.cards[0].error.textContent, /Proposta mudou/);
  assert.equal(approve.disabled, true, 'erro na recusa não autoriza aprovação que já estava bloqueada'); assert.equal(reject.disabled, false);
  await approve.click(); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0);
});

test('aprovar e recusar usam versão CAS e recibo confirmado antes de anunciar resultado', async t => {
  for (const action of ['approve', 'reject']) await t.test(action, async child => {
    const f = fixture(child); f.bind(); await settle(); await f.buttons.find(button => button.dataset.proposalAction === action).click();
    const write = f.calls.find(call => call.init.method === 'POST'); assert.equal(write.path, '/api/tenants/tenant-a/agent-admin-proposals/proposal-a/decide'); assert.deepEqual(JSON.parse(write.init.body), { version: 2, action });
    assert.equal(f.messages.length, 1); assert.match(f.messages[0], action === 'approve' ? /aprovada.*cadastro criado/ : /recusada/); assert.equal(f.refreshes(), 1);
  });
});

test('duplo clique em aprovação ou recusa enquanto decide faz somente um POST', async t => {
  const d = deferred(), f = fixture(t, { intercept: (_path, init, fallback) => init.method === 'POST' ? d.promise : fallback() }); f.bind(); await settle(); const [approve, reject] = f.buttons;
  const pending = approve.click(); assert.equal(approve.disabled, true); assert.equal(reject.disabled, true); await approve.click(); await reject.click();
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(f.messages.length, 0);
  d.resolve(receipt()); await pending; assert.equal(f.messages.length, 1); assert.equal(f.refreshes(), 1);
});

test('recibo vazio ou divergente não declara recurso criado nem confirmação de decisão', async t => {
  const valid = receipt();
  const cases = [['vazio', {}], ['sem corpo', undefined], ['outra proposta', { ...valid, proposal: { ...valid.proposal, id: 'other' } }], ['estado errado', { ...valid, proposal: { ...valid.proposal, state: 'rejected' } }], ['CAS antigo', { ...valid, proposal: { ...valid.proposal, version: 2 } }], ['recurso diferente', { ...valid, entity: { ...valid.entity, id: 'other' } }], ['sem aprovação humana', { ...valid, humanApprovalRequired: false }]];
  for (const [name, result] of cases) await t.test(name, async child => {
    const f = fixture(child, { intercept: (_path, init, fallback) => init.method === 'POST' ? result : fallback() }); f.bind(); await settle(); await f.buttons[0].click();
    assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0); assert.equal(f.cards[0].error.hidden, false); assert.equal(f.cards[0].error.focused, 1);
    assert.match(f.cards[0].error.textContent, /confirmar|Atualize/i); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  });
});

test('decisão atrasada da empresa anterior não anuncia resultado nem recarrega workspace novo', async t => {
  for (const failure of [false, true]) await t.test(failure ? 'erro' : 'sucesso', async child => {
    const d = deferred(), f = fixture(child, { intercept: (_path, init, fallback) => init.method === 'POST' ? d.promise : fallback() }); f.bind(); await settle();
    const pending = f.buttons[0].click(); f.detach(); if (failure) d.reject(new Error('Erro antigo')); else d.resolve(receipt()); await pending;
    assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0); assert.equal(f.cards[0].error.hidden, true); assert.equal(f.cards[0].error.focused, 0);
  });
});

test('hook real refaz cadastro da empresa e painel de propostas após decisão humana', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), binding = source.split('\n').find(line => line.includes("if(state.view==='agents'") && line.includes('bindAgentAdminProposals('));
  assert.ok(binding); const effects = []; let options;
  runInNewContext(binding, { ...i18n, state: { view: 'agents', boot: { session: { role: 'reseller' } }, supportGrantId: null, tenant: { id: 'tenant-a' } },
    $: () => ({}), api: () => {}, toast: () => {}, bindAgentAdminProposals: value => { options = value; }, refresh: async () => effects.push('refresh'), render: () => effects.push('render') });
  assert.equal(options.tenantId, 'tenant-a'); assert.equal(options.admin, true); await options.refresh(); assert.deepEqual(effects, ['refresh', 'render']);
});

test('Pendências (P6): só propostas pendentes e bem formadas viram itens, sem grafo e com escape no consumo', () => {
  const items = pendingProposalItems([proposal({ type: 'flow', name: 'Trocas <b>', graph: { secret: 'no' } }), proposal({ id: 'p2', state: 'approved' }), proposal({ id: 'bad id' }), null, proposal({ id: 'p3', type: 'agent', name: 'Triagem', serviceName: 'Hermes do Jean' })]);
  assert.deepEqual(items.map(item => item.id), ['proposal-a', 'p3']);
  assert.equal(items[0].title, 'Novo fluxo “Trocas <b>”'); assert.equal(items[1].title, 'Novo agente “Triagem”'); assert.equal(items[1].serviceName, 'Hermes do Jean');
  assert.equal(JSON.stringify(items).includes('secret'), false); assert.deepEqual(pendingProposalItems(undefined), []);
  assert.equal(pendingProposalItems(Array.from({ length: 50 }, (_unused, index) => proposal({ id: 'p' + index }))).length, 40);
});
