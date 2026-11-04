import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlansUI } from '../public/plans-ui.js';

const example = () => ({ id: 'plan-qa', version: 1, name: 'Plano QA', targetKind: 'reseller', state: 'active', currency: 'BRL', periodMonths: 1, items: [{ kind: 'subscription', label: 'Preço QA', unitCents: 10000, units: 1, metered: false }], quotas: { connections: 3 } });
function fixture(t, intercept) {
  const old = globalThis.FormData; globalThis.FormData = class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name] ?? null; } }; t.after(() => { globalThis.FormData = old; });
  const state = { view: 'platform-billing', workspaceId: 'mep-demo', supportGrantId: null, boot: { csrfToken: 'qa', session: { userId: 'owner-qa', role: 'reseller', platformOwner: true }, reseller: { accountKind: 'platform' } } }, calls = [], drafts = [], messages = [];
  const dialog = { open: false, html: '', panel: null, error: { textContent: '' }, querySelector(selector) { return selector === '[data-plans-panel]' ? this.panel : selector === '.form-error' ? this.error : null; }, querySelectorAll() { return []; }, close() { this.open = false; } };
  const fallback = (path, init) => {
    if (path.startsWith('/api/commercial/plans?')) { const params = new URL(path, 'http://local').searchParams; return { workspaceId: 'mep-demo', accountVersion: 2, plans: [example()], total: 1, offset: Number(params.get('offset')), limit: Number(params.get('limit')), hasMore: false, canManage: true }; }
    if (path.startsWith('/api/accounts?')) { const params = new URL(path, 'http://local').searchParams; return { accounts: [{ id: 'reseller-qa', accountKind: 'reseller', parentWorkspaceId: 'mep-demo', name: 'Revenda QA' }], total: 1, offset: Number(params.get('offset')), limit: Number(params.get('limit')), hasMore: false }; }
    if (path.endsWith('/contract-draft')) return { source: { workspaceId: 'mep-demo', planId: 'plan-qa' }, requiresReview: true, draft: { targetWorkspaceId: 'reseller-qa', scope: 'platform', targetKind: 'reseller', name: 'Plano QA' } };
    const body = JSON.parse(init.body); return { workspaceId: 'mep-demo', accountVersion: 3, canManage: true, plan: { ...example(), ...body, version: 2 } };
  };
  const ui = createPlansUI({ state, api: async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, fallback) : fallback(path, init); }, openModal(title, subtitle, html) { dialog.open = true; dialog.html = html; dialog.panel = { dataset: { plansToken: html.match(/data-plans-panel data-plans-token="([^"]+)"/)[1] } }; }, getModal: () => dialog, toast: (...args) => messages.push(args), onDraft: value => drafts.push(value) });
  const action = name => ui.action({ dataset: { plansAction: name, plansToken: dialog.panel?.dataset.plansToken, id: 'plan-qa' } });
  const form = (type, fields = {}) => ({ dataset: { plansForm: type, plansToken: dialog.panel?.dataset.plansToken }, fields, querySelector: () => dialog.error, querySelectorAll: () => [{ dataset: { planItem: '0' } }] });
  const values = { name: 'Plano revisado QA', targetKind: 'reseller', state: 'active', periodMonths: '1', 'kind-0': 'subscription', 'label-0': 'Preço QA', 'price-0': '101,27', 'units-0': '1', 'quota-connections': '3', reason: 'Acordo QA' };
  return { state, calls, dialog, drafts, messages, ui, action, form, values };
}

test('catálogo usa workspace correto, escapa nomes e abre rascunho sem criar contrato', async t => {
  const f = fixture(t); await f.ui.open(); assert.match(f.dialog.html, /Planos e adicionais|Guarde preços/); await f.action('use');
  await f.ui.submit(f.form('use', { targetWorkspaceId: 'reseller-qa', startsAt: '2026-10-01', graceDays: '3' }));
  assert.equal(f.drafts.length, 1); assert.equal(f.calls.some(call => call.path === '/api/billing/contracts'), false); assert.deepEqual(JSON.parse(f.calls.at(-1).init.body), { accountVersion: 2, version: 1, targetWorkspaceId: 'reseller-qa', startsAt: '2026-10-01', graceDays: 3 });
});
test('edição converte centavos exatamente e grava CAS da conta e do plano', async t => {
  const f = fixture(t); await f.ui.open(); await f.action('edit'); await f.ui.submit(f.form('editor', f.values));
  const call = f.calls.find(call => call.init.method === 'PATCH'), body = JSON.parse(call.init.body); assert.equal(body.items[0].unitCents, 10127); assert.equal(body.version, 1); assert.equal(body.accountVersion, 2); assert.match(body.requestId, /^[a-f0-9-]{36}$/); assert.equal(f.drafts.length, 0);
});
test('resposta incerta reconcilia com a mesma chave e payload sem criar plano duplicado', async t => {
  let writes = 0;
  const f = fixture(t, (path, init, fallback) => { if (init.method === 'POST') { if (++writes === 1) throw new Error('Sem confirmação'); } return fallback(path, init); });
  await f.ui.open(); await f.action('new'); await f.ui.submit(f.form('editor', f.values)); assert.match(f.dialog.html, /Verificar resultado/); await f.action('verify');
  const calls = f.calls.filter(call => call.init.method === 'POST'); assert.equal(calls.length, 2); assert.equal(calls[0].init.body, calls[1].init.body); assert.equal(f.drafts.length, 0);
});
test('troca de autoridade ou workspace impede enviar formulário e resultado antigo', async t => {
  const f = fixture(t); await f.ui.open(); await f.action('edit'); const form = f.form('editor', f.values); f.state.workspaceId = 'reseller-other'; await f.ui.submit(form);
  assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false);
  f.state.workspaceId = 'mep-demo'; f.state.supportGrantId = 'support-qa'; await assert.rejects(f.ui.open(), /indisponível/);
});
test('evento de formulário antigo não edita outro modal válido', async t => {
  const f = fixture(t); await f.ui.open(); await f.action('edit'); const old = f.form('editor', f.values); await f.action('back'); await f.action('new'); await f.ui.submit(old);
  assert.equal(f.calls.some(call => call.init.method === 'POST' || call.init.method === 'PATCH'), false);
});
