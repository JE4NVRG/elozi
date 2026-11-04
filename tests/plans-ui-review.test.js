import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlansUI } from '../public/plans-ui.js';
import { createBillingUI } from '../public/billing-ui.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const decode = value => String(value ?? '').replace(/&(quot|#39|lt|gt|amp);/g, (_, key) => ({ quot: '"', '#39': "'", lt: '<', gt: '>', amp: '&' }[key]));
const plan = () => ({ id: 'review-plan', version: 3, name: 'Plano acordado', targetKind: 'reseller', state: 'active', currency: 'BRL', periodMonths: 3,
  items: [{ kind: 'subscription', label: 'Preço acordado', unitCents: 10127, units: 2, metered: false }, { kind: 'email', label: 'Uso medido', unitCents: 3, units: 0, metered: true }], quotas: { subscription: 7, connections: 3 } });
const state = () => ({ view: 'platform-billing', workspaceId: 'mep-demo', supportGrantId: null,
  boot: { csrfToken: 'synthetic-review-token', session: { userId: 'review-owner', role: 'reseller', platformOwner: true }, reseller: { accountKind: 'platform' } } });
const accounts = [{ id: 'review-client', accountKind: 'reseller', parentWorkspaceId: 'mep-demo', name: 'Conta sintética' }];
class FormDataAdapter {
  constructor(form) { this.fields = form.fields; }
  get(name) { return this.fields[name] ?? null; }
  has(name) { return Object.hasOwn(this.fields, name); }
  [Symbol.iterator]() { return Object.entries(this.fields)[Symbol.iterator](); }
}
function globals(t) {
  const original = { FormData: globalThis.FormData, document: globalThis.document };
  globalThis.FormData = FormDataAdapter;
  t.after(() => { globalThis.FormData = original.FormData; globalThis.document = original.document; });
}
function catalogue(t, intercept = () => undefined, configuration = {}) {
  globals(t); const context = configuration.state || state(), sourcePlan = configuration.plan || plan(), calls = [], drafts = [];
  const dialog = { open: false, html: '', panel: null, useFields: null, error: { textContent: '' },
    querySelector(selector) { return selector === '[data-plans-panel]' ? this.panel : selector === '.form-error' ? this.error : selector === '[data-plans-form="use"]' && this.useFields ? { fields: this.useFields } : null; }, querySelectorAll() { return []; } };
  const ui = createPlansUI({ state: context, escape, getModal: () => dialog,
    api: async (path, init = {}) => {
      calls.push({ path, init }); const overridden = intercept(path, init); if (overridden !== undefined) return overridden;
      if (path.startsWith('/api/commercial/plans?')) return { workspaceId: context.workspaceId, accountVersion: 4, plans: [sourcePlan], total: 1, offset: 0, limit: 25, hasMore: false, canManage: true };
      if (path.startsWith('/api/accounts?')) { const params = new URL(path, 'http://local').searchParams; return { accounts, total: 1, offset: Number(params.get('offset')), limit: Number(params.get('limit')), hasMore: false }; }
      if (path.endsWith('/contract-draft')) { const body = JSON.parse(init.body); return { source: { workspaceId: context.workspaceId, planId: sourcePlan.id, version: sourcePlan.version, accountVersion: 4 }, requiresReview: true, draft: { targetWorkspaceId: body.targetWorkspaceId } }; }
      if (init.method === 'PATCH') { const body = JSON.parse(init.body); return { workspaceId: 'mep-demo', accountVersion: 5, canManage: true, plan: { ...plan(), ...body, version: 4 } }; }
      throw new Error('Unexpected synthetic request');
    }, openModal(title, subtitle, html) { dialog.open = true; dialog.html = html; dialog.useFields = null; dialog.panel = { dataset: { plansToken: html.match(/data-plans-panel data-plans-token="([^"]+)"/)[1] } }; }, onDraft: value => drafts.push(value) });
  const action = name => ui.action({ dataset: { plansAction: name, plansToken: dialog.panel?.dataset.plansToken, id: 'review-plan' } });
  return { ui, calls, dialog, action, state: context, drafts, pickerForm: (type, fields) => ({ dataset: { plansForm: type, plansToken: dialog.panel.dataset.plansToken }, fields, querySelector: () => dialog.error }), form: fields => ({ dataset: { plansForm: 'editor', plansToken: dialog.panel.dataset.plansToken }, fields,
    querySelector: () => dialog.error, querySelectorAll: () => [{ dataset: { planItem: '0' } }, { dataset: { planItem: '1' } }] }) };
}

test('leitura atrasada de contratantes não substitui um editor de plano aberto depois', async t => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const f = catalogue(t, path => path.startsWith('/api/accounts?') ? delayed : undefined);
  await f.ui.open(); const pending = f.action('use'); await f.action('edit');
  const editor = f.dialog.html, token = f.dialog.panel.dataset.plansToken; assert.match(editor, /data-plans-form="editor"/);
  release({ accounts }); await pending;
  assert.equal(f.dialog.panel.dataset.plansToken, token, 'An old accounts response must not replace the current modal or discard its edits');
  assert.ok(f.dialog.html === editor);
  assert.equal(f.calls.some(call => call.init.method), false);
});

test('catálogo e editor conservam preço explícito máximo sem perder centavos na apresentação',async t=>{
  const maximum=plan();maximum.items=[{kind:'subscription',label:'Preço máximo explícito',unitCents:Number.MAX_SAFE_INTEGER,units:1,metered:false}];
  const f=catalogue(t,()=>undefined,{plan:maximum});await f.ui.open();assert.ok(f.dialog.html.includes('90.071.992.547.409,91'));
  await f.action('edit');assert.ok(f.dialog.html.includes('value="90071992547409,91"'));assert.equal(f.calls.some(call=>call.init.method),false);
});

const page = (entries, offset = 0, total = entries.length) => ({ accounts: entries, total, offset, limit: 100, hasMore: offset + 100 < total });
const client = (id, overrides = {}) => ({ id, name: `Conta ${id}`, accountKind: 'reseller', parentWorkspaceId: 'mep-demo', ...overrides });
const queryOf = call => new URL(call.path, 'http://local').searchParams;

test('contratante após primeira centena usa paginação global e mantém plano e vigência', async t => {
  const first = Array.from({ length: 100 }, (_, index) => client(`client-${index}`)), last = client('client-100');
  const f = catalogue(t, path => {
    if (!path.startsWith('/api/accounts?')) return;
    const query = new URL(path, 'http://local').searchParams;
    assert.equal(query.get('view'), 'platform'); assert.equal(query.get('kind'), 'reseller'); assert.equal(query.get('limit'), '100');
    return query.get('offset') === '100' ? page([last], 100, 101) : page(first, 0, 101);
  });
  await f.ui.open(); await f.action('use');
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/accounts?')).length, 1, 'Do not fetch all pages eagerly');
  assert.match(f.dialog.html, /use-next/); assert.doesNotMatch(f.dialog.html, /client-100/);
  f.dialog.useFields = { targetWorkspaceId: 'client-0', startsAt: '2026-11-03', graceDays: '9' };
  const old = f.pickerForm('use', { targetWorkspaceId: 'client-0', startsAt: '2026-11-03', graceDays: '9' });
  await f.action('use-next'); assert.match(f.dialog.html, /101–101 de 101 contas/); assert.match(f.dialog.html, /value="client-100"/);
  assert.match(f.dialog.html, /value="client-0" selected/); assert.match(f.dialog.html, /name="startsAt" value="2026-11-03"/); assert.match(f.dialog.html, /name="graceDays" value="9"/);
  await f.ui.submit(old); assert.equal(f.drafts.length, 0, 'Old modal tokens cannot submit a target');
  await f.ui.submit(f.pickerForm('use', { targetWorkspaceId: last.id, startsAt: '2026-11-03', graceDays: '9' }));
  assert.equal(f.drafts.length, 1);
  const write = f.calls.find(call => call.init.method); assert.ok(write.path.endsWith('/review-plan/contract-draft'));
  assert.deepEqual(JSON.parse(write.init.body), { accountVersion: 4, version: 3, targetWorkspaceId: last.id, startsAt: '2026-11-03', graceDays: 9 });
  assert.equal(f.calls.some(call => call.path === '/api/billing/contracts'), false);
});

test('busca volta para primeira página e anterior mantém o mesmo filtro', async t => {
  const f = catalogue(t, path => {
    if (!path.startsWith('/api/accounts?')) return;
    const params = new URL(path, 'http://local').searchParams, offset = Number(params.get('offset'));
    return page([client(`found-${offset}`)], offset, 201);
  });
  await f.ui.open(); await f.action('use'); await f.action('use-next');
  await f.ui.submit(f.pickerForm('use-filter', { q: 'Acordo & nome' }));
  assert.equal(queryOf(f.calls.at(-1)).get('q'), 'Acordo & nome'); assert.equal(queryOf(f.calls.at(-1)).get('offset'), '0');
  await f.action('use-next'); await f.action('use-previous');
  assert.equal(queryOf(f.calls.at(-1)).get('q'), 'Acordo & nome'); assert.equal(queryOf(f.calls.at(-1)).get('offset'), '0');
  assert.equal(f.calls.some(call => call.init.method), false);
});

test('plataforma mostra empresa de outra revenda e revenda usa apenas diretório próprio', async t => {
  const businessPlan = { ...plan(), targetKind: 'business' }, nested = client('nested-business', { accountKind: 'business', parentWorkspaceId: 'other-reseller' });
  const f = catalogue(t, path => path.startsWith('/api/accounts?') ? page([nested]) : undefined, { plan: businessPlan });
  await f.ui.open(); await f.action('use'); assert.equal(queryOf(f.calls.at(-1)).get('view'), 'platform'); assert.equal(queryOf(f.calls.at(-1)).get('kind'), 'business'); assert.match(f.dialog.html, /nested-business/);
});

test('revenda filtra clientes próprios e rejeita conta de outro emissor', async t => {
  const context = state(); context.view = 'billing'; context.workspaceId = 'own-reseller'; context.boot.reseller.accountKind = 'reseller'; context.boot.session.platformOwner = false;
  let foreign = false;
  const f = catalogue(t, path => path.startsWith('/api/accounts?') ? page([client('own-business', { accountKind: 'business', parentWorkspaceId: foreign ? 'other-reseller' : 'own-reseller' })]) : undefined, { state: context, plan: { ...plan(), targetKind: 'business' } });
  await f.ui.open(); await f.action('use'); assert.equal(queryOf(f.calls.at(-1)).get('view'), 'account'); assert.equal(queryOf(f.calls.at(-1)).get('kind'), 'business'); assert.match(f.dialog.html, /own-business/);
  const token = f.dialog.panel.dataset.plansToken; foreign = true;
  await f.ui.submit(f.pickerForm('use-filter', { q: 'foreign' })); assert.equal(f.dialog.panel.dataset.plansToken, token); assert.equal(f.drafts.length, 0);
  assert.match(f.dialog.error.textContent, /página de contratantes/);
});

test('buscas fora de ordem cancelam a anterior e preservam resultado mais recente', async t => {
  const waiting = new Map();
  const f = catalogue(t, (path, init) => {
    if (!path.startsWith('/api/accounts?')) return;
    const q = new URL(path, 'http://local').searchParams.get('q'); if (!q) return page(accounts);
    return new Promise(resolve => waiting.set(q, { resolve, signal: init.signal }));
  });
  await f.ui.open(); await f.action('use');
  const old = f.ui.submit(f.pickerForm('use-filter', { q: 'old' })), recent = f.ui.submit(f.pickerForm('use-filter', { q: 'recent' }));
  assert.equal(waiting.get('old').signal.aborted, true);
  waiting.get('recent').resolve(page([client('recent-client')])); await recent; const current = f.dialog.html;
  waiting.get('old').resolve(page([client('old-client')])); await old; assert.ok(f.dialog.html === current); assert.match(current, /recent-client/); assert.doesNotMatch(current, /old-client/);
});

for (const change of ['workspace', 'user', 'csrf', 'grant', 'closed', 'reset']) test(`página atrasada é ignorada após ${change}`, async t => {
  let release; const f = catalogue(t, path => {
    if (!path.startsWith('/api/accounts?')) return;
    const q = new URL(path, 'http://local').searchParams.get('q'); return q ? new Promise(resolve => { release = resolve; }) : page(accounts);
  });
  await f.ui.open(); await f.action('use'); const original = f.dialog.html;
  const pending = f.ui.submit(f.pickerForm('use-filter', { q: 'delayed' }));
  if (change === 'workspace') f.state.workspaceId = 'new-workspace';
  if (change === 'user') f.state.boot.session.userId = 'new-user';
  if (change === 'csrf') f.state.boot.csrfToken = 'new-token';
  if (change === 'grant') f.state.supportGrantId = 'support-grant';
  if (change === 'closed') f.dialog.open = false;
  if (change === 'reset') f.ui.reset();
  release(page([client('stale-client')])); await pending;
  assert.ok(f.dialog.html === original); assert.equal(f.drafts.length, 0); assert.equal(f.calls.some(call => call.init.method), false);
});

test('editar nome do plano preserva quota válida que o formulário não expõe', async t => {
  const f = catalogue(t); await f.ui.open(); await f.action('edit');
  await f.ui.submit(f.form({ name: 'Plano renomeado', targetKind: 'reseller', state: 'active', periodMonths: '3',
    'kind-0': 'subscription', 'label-0': 'Preço acordado', 'price-0': '101,27', 'units-0': '2',
    'kind-1': 'email', 'label-1': 'Uso medido', 'price-1': '0,03', 'units-1': '0', 'metered-1': 'yes',
    'quota-connections': '3', reason: 'Somente nome revisado' }));
  const write = f.calls.find(call => call.init.method === 'PATCH'); assert.ok(write);
  const body = JSON.parse(write.init.body); assert.equal(body.accountVersion, 4); assert.equal(body.version, 3);
  assert.deepEqual(body.items, plan().items); assert.deepEqual(body.quotas, plan().quotas);
});

function billingForm(html) {
  const fields = {};
  for (const [, attributes] of html.matchAll(/<input\b([^>]*)>/g)) {
    const name = attributes.match(/\bname="([^"]+)"/)?.[1];
    if (!name || /type="checkbox"/.test(attributes) && !/\bchecked\b/.test(attributes)) continue;
    fields[decode(name)] = decode(attributes.match(/\bvalue="([^"]*)"/)?.[1]);
  }
  for (const [, attributes, content] of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attributes.match(/\bname="([^"]+)"/)?.[1], selected = [...content.matchAll(/<option\b([^>]*)>/g)].find(match => /\bselected\b/.test(match[1]));
    if (name) fields[decode(name)] = decode(selected?.[1].match(/\bvalue="([^"]*)"/)?.[1]);
  }
  return { fields, dataset: { billingForm: html.match(/data-billing-form="([^"]+)"/)?.[1], billingToken: html.match(/data-billing-token="([^"]+)"/)?.[1] } };
}

test('rascunho de catálogo entra na revisão e preserva todos os termos no contrato escolhido', async t => {
  globals(t); const context = state(), calls = [], opened = [];
  globalThis.document = { querySelector: () => ({ close() {} }) };
  const ui = createBillingUI({ state: context, escape, icon: () => '', render: () => {}, toast: () => {},
    openModal(title, description, html) { opened.push({ title, html }); },
    api: async (path, init = {}) => { calls.push({ path, init }); return init.method ? { id: 'reviewed-contract' } : { contracts: [], invoices: [], targets: accounts }; } });
  const agreed = plan(), preset = { requiresReview: true, source: { workspaceId: 'mep-demo', planId: agreed.id, version: agreed.version, accountVersion: 4 },
    draft: { name: agreed.name, items: agreed.items, quotas: agreed.quotas, currency: 'BRL', periodMonths: 3, startsAt: '2026-10-03', endsAt: '2027-10-03', graceDays: 7,
      state: 'active', scope: 'platform', targetKind: 'reseller', targetWorkspaceId: 'review-client' } };
  await ui.openFromPlan(preset); assert.equal(calls.some(call => call.init.method), false, 'Opening the plan must only load data and open a review');
  const form = billingForm(opened.at(-1).html); form.fields.reason = 'Termos revisados pelo administrador'; await ui.submit(form);
  const write = calls.find(call => call.init.method); assert.equal(write.path, '/api/billing/contracts');
  const body = JSON.parse(write.init.body); assert.deepEqual(body.items, agreed.items);
  for (const [metric, limit] of Object.entries(agreed.quotas)) assert.equal(body.quotas[metric], limit, `quota ${metric}`);
  for (const key of ['name', 'currency', 'periodMonths', 'startsAt', 'endsAt', 'graceDays', 'state', 'scope', 'targetKind', 'targetWorkspaceId']) assert.equal(body[key], preset.draft[key], key);
});
