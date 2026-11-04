import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountsUI } from '../public/accounts-ui.js';
import { getLocale, setLocale } from '../public/i18n.js';

const account = (more = {}) => ({ id: 'business-a', name: 'Empresa QA', accountKind: 'business', parentWorkspaceId: 'reseller-a', version: 2, createdAt: '2026-10-03T10:00:00Z', counts: { tenants: 2, users: 0, channels: 1, connectedChannels: 0, agents: 1, activeAgents: 0 }, onboarding: { companyCreated: true, administratorActive: false, channelConnected: false, teamReady: false, contractConfigured: false }, ...more });
const reseller = (more = {}) => account({ id: 'reseller-a', name: 'Revenda QA', accountKind: 'reseller', parentWorkspaceId: 'mep-demo', ...more });
const page = (accounts = [reseller(), account()], more = {}) => ({ accounts, total: accounts.length, offset: 0, limit: 25, summary: { activeUsers: 7, connectedChannels: 3, activeAgents: 1 }, ...more });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, { platform = false, intercept } = {}) {
  const oldFormData = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name] ?? null; } };
  t.after(() => { globalThis.FormData = oldFormData; });
  const state = { view: platform ? 'platform' : 'accounts', workspaceId: platform ? 'mep-demo' : 'reseller-a', tenant: null, supportGrantId: null, boot: { csrfToken: 'csrf-qa', session: { userId: 'person-qa', role: 'reseller', platformOwner: platform }, reseller: { name: platform ? 'Elozi' : 'Revenda QA', accountKind: platform ? 'platform' : 'reseller' }, workspaces: [{ id: 'mep-demo', name: 'Elozi', platformWorkspace: true }, { id: 'reseller-a', name: 'Revenda QA' }] } };
  const calls = [], renders = [], messages = [], changes = [], callbacks = [], opened = [], listeners = new Map();
  let rows = [reseller(), account()];
  const modal = { open: false, html: '', panel: null, feedback: { textContent: '' },
    querySelector(selector) { return selector === '[data-accounts-panel]' ? this.panel : selector === '.form-error' ? this.feedback : null; },
    addEventListener(event, fn) { listeners.set(event, fn); }, close() { this.open = false; listeners.get('close')?.(); }
  };
  const fallback = (path, init = {}) => {
    const url = new URL(path, 'http://local');
    if (/^\/api\/accounts\/[^/]+\/lifecycle$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2)), found = rows.find(item => item.id === id), data = JSON.parse(init.body);
      if (!found) throw Object.assign(new Error('Conta não encontrada.'), { status: 404 });
      if (data.version !== found.version) throw Object.assign(new Error('A conta mudou.'), { status: 409 });
      Object.assign(found, { version: found.version + 1, lifecycle: { state: data.state, canManage: true, trialEndsAt: data.trialEndsAt || null, trialExpired: false } });
      return { account: structuredClone(found), lifecycle: structuredClone(found.lifecycle) };
    }
    if (url.pathname === '/api/accounts' && init.method === 'POST') {
      const data = JSON.parse(init.body), created = account({ id: 'created-qa', version: 1, name: data.name, accountKind: data.accountKind, parentWorkspaceId: data.parentWorkspaceId, counts: { tenants: 1, users: 0, channels: 0, connectedChannels: 0, agents: 0, activeAgents: 0 } }); rows.push(created); return { account: structuredClone(created), replayed: false };
    }
    if (/^\/api\/accounts\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)), found = rows.find(item => item.id === id);
      if (!found) throw Object.assign(new Error('Conta não encontrada.'), { status: 404 });
      if (init.method === 'PATCH') { const data = JSON.parse(init.body); Object.assign(found, { name: data.name, version: found.version + 1 }); }
      return { account: structuredClone(found) };
    }
    const kind = url.searchParams.get('kind') || 'all', q = (url.searchParams.get('q') || '').toLocaleLowerCase('pt-BR'), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
    const selected = rows.filter(item => (kind === 'all' || item.accountKind === kind) && item.name.toLocaleLowerCase('pt-BR').includes(q));
    return page(structuredClone(selected.slice(offset, offset + limit)), { total: selected.length, offset, limit, summary: { ...page().summary, total: rows.length } });
  };
  const ui = createAccountsUI({ state, api: async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, fallback) : fallback(path, init); },
    openModal(title, subtitle, html) { modal.open = true; modal.html = html; modal.feedback = { textContent: '' }; const token = html.match(/data-accounts-panel data-accounts-token="([^"]+)"/)?.[1]; modal.panel = token ? { dataset: { accountsToken: token }, querySelector: selector => selector === '.form-error' ? modal.feedback : null } : null; opened.push({ title, subtitle, html }); },
    render: () => renders.push(true), toast: (message, failed) => messages.push({ message, failed }), getModal: () => modal,
    changeWorkspace: async (...args) => changes.push(args), onInvite: async data => callbacks.push({ kind: 'invite', data }), onFinance: async data => callbacks.push({ kind: 'finance', data }), onUsage: async data => callbacks.push({ kind: 'usage', data, modalOpen: modal.open }), onSupport: async data => callbacks.push({ kind: 'support', data }), onDomains: async data => callbacks.push({ kind: 'domains', data, modalOpen: modal.open }), onOperationalAccess: async data => callbacks.push({ kind: 'operational-access', data })
  });
  const html = () => ui.markup(platform);
  const pageToken = () => html().match(/data-accounts-page-token="([^"]+)"/)?.[1];
  function form(type, fields = {}) { const feedback = { textContent: '' }, button = { disabled: false }; return { dataset: { accountsForm: type, accountsToken: modal.panel?.dataset.accountsToken, accountsPageToken: pageToken() }, fields, feedback, button, querySelector: selector => selector === '.form-error' ? feedback : selector === '[type="submit"]' ? button : null }; }
  async function action(name, id = '', { modalAction = false, nodeForm } = {}) {
    const inModal = modalAction || ['close', 'wizard-back', 'detail-refresh', 'detail-retry', 'invite', 'finance', 'support', 'domains', 'operational-access', 'verify-write'].includes(name);
    return ui.handleAction({ dataset: { accountsAction: name, id, ...(inModal ? { accountsToken: modal.panel?.dataset.accountsToken } : { accountsPageToken: pageToken() }) }, closest: selector => selector === 'form' ? nodeForm : null });
  }
  async function wizard(kind = 'business', fields = {}) {
    await action('create'); await ui.submit(form('wizard', { accountKind: kind }));
    await ui.submit(form('wizard', { name: '  Nova conta QA  ', parentWorkspaceId: platform ? 'mep-demo' : 'reseller-a', initialTenantName: ' Matriz QA ', segment: ' Serviços ', ...fields }));
    return form('wizard');
  }
  return { state, ui, calls, renders, messages, changes, callbacks, opened, modal, html, form, action, wizard, fallback, pageToken, setRows: next => { rows = next; } };
}



test('contagem e paginação concordam 0/1/muitas contas em PT→EN→PT após busca e atualização', async t => {
  const previousLocale = getLocale(); t.after(() => setLocale(previousLocale, { persist: false, notify: false }));
  const f = fixture(t, { platform: true });
  const stats = html => [...html.matchAll(/<dt class="pg-settings__stat-label">([^<]+)<\/dt><dd class="pg-settings__stat-value">([^<]+)<\/dd>/g)].map(match => match.slice(1));
  for (const locale of ['pt-BR', 'en', 'pt-BR']) {
    setLocale(locale, { persist: false, notify: false });
    for (const [q, count] of [['ausente', 0], ['Empresa', 1], ['', 2]]) {
      await f.ui.load(true);
      await f.ui.submit(f.form('filter', { q, kind: 'all', state: 'all' }));
      const expectedCount = `${count} ${locale === 'en' ? count === 1 ? 'account' : 'accounts' : count === 1 ? 'conta' : 'contas'}`;
      const start = count ? 1 : 0;
      for (const html of [f.html(), (await f.action('refresh'), f.html())]) {
        assert.ok(html.includes(`<p class="pg-settings__total" role="status">${expectedCount}</p>`));
        assert.ok(html.includes(`<span role="status">${start}–${count} ${locale === 'en' ? 'of' : 'de'} ${expectedCount}</span>`));
        assert.deepEqual(stats(html).map(item => item[1]), ['2', '7', '3', '1']);
      }
      const query = new URL(f.calls.at(-1).path, 'http://local');
      assert.equal(query.searchParams.get('q'), q); assert.equal(query.searchParams.get('offset'), '0');
    }
  }
  assert.equal(f.calls.some(call => call.init.method !== 'GET'), false);
});

test('KPI usa summary.total autorizado e não soma linhas, tipos ou cache; total filtrado tem rótulo honesto', async t => {
  const previousLocale = getLocale(); t.after(() => setLocale(previousLocale, { persist: false, notify: false }));
  let globalTotal = 82;
  const f = fixture(t, { platform: true, intercept: (path, init, fallback) => {
    const result = fallback(path, init);
    return { ...result, summary: { ...page().summary, ...(globalTotal === undefined ? {} : { total: globalTotal }), reseller: 999, business: 999 } };
  } });
  for (const locale of ['pt-BR', 'en', 'pt-BR']) {
    setLocale(locale, { persist: false, notify: false }); globalTotal = 82;
    await f.ui.load(true); await f.ui.submit(f.form('filter', { q: 'Empresa', kind: 'business', state: 'all' }));
    const access = locale === 'en' ? 'Accounts available with this access' : 'Contas neste acesso';
    assert.ok(f.html().includes(`<dt class="pg-settings__stat-label">${access}</dt><dd class="pg-settings__stat-value">82</dd>`));
    assert.equal(f.ui.summary(true).total, 1); assert.equal(f.ui.summary(true).summary.total, 82);
    globalTotal = 0; await f.action('refresh');
    assert.ok(f.html().includes(`<dt class="pg-settings__stat-label">${access}</dt><dd class="pg-settings__stat-value">0</dd>`));
    for (const absent of [undefined, -1, '82']) {
      globalTotal = absent; await f.action('refresh');
      const filtered = locale === 'en' ? 'Accounts in this filter' : 'Contas neste filtro';
      assert.ok(f.html().includes(`<dt class="pg-settings__stat-label">${filtered}</dt><dd class="pg-settings__stat-value">1</dd>`));
      assert.equal(f.html().includes(`<dt class="pg-settings__stat-label">${access}</dt>`), false);
    }
    globalTotal = 82; await f.ui.submit(f.form('filter', { q: '', kind: 'all', state: 'all' }));
    assert.ok(f.html().includes(`<dt class="pg-settings__stat-label">${access}</dt><dd class="pg-settings__stat-value">82</dd>`));
  }
});

test('main admin consulta contas sem tenant e renderiza métricas reais, filtros, dados escapados e nenhum segredo', async t => {
  const f = fixture(t, { platform: true }); f.setRows([reseller({ name: '<img onerror="bad()">', credential: 'should-not-render' }), account()]);
  await f.ui.load(true); const html = f.html(); assert.equal(f.state.tenant, null); assert.match(html, /<p class="pg-settings__eyebrow">Administração da plataforma<\/p>/); assert.match(html, /&lt;img onerror=&quot;bad\(\)&quot;&gt;/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('should-not-render'), false);
  const url = new URL(f.calls[0].path, 'http://local'); assert.equal(url.pathname, '/api/platform/accounts'); assert.equal(url.searchParams.get('limit'), '25'); assert.equal(f.calls[0].init.headers['X-Elozi-Workspace'], 'mep-demo'); assert.equal(f.calls[0].init.signal.aborted, false);
  assert.match(html, /<dt class="pg-settings__stat-label">Pessoas ativas<\/dt><dd class="pg-settings__stat-value">7<\/dd>/); assert.match(html, /0 canais conectados/); assert.match(html, /1\/5 etapas confirmadas/); assert.equal(html.includes('Criar usuário'), false);
});

test('ciclo comercial envia a revisão da conta e confirma estado sem alterar acesso ou dados operacionais', async t => {
  const f = fixture(t); f.setRows([account({ lifecycle: { state: 'active', canManage: true } })]);
  await f.ui.load(); await f.action('detail', 'business-a'); assert.match(f.modal.html, /Alterar estado comercial/);
  await f.ui.submit(f.form('lifecycle', { state: 'trial', trialEndsAt: '2026-12-31', reason: 'Teste interno acordado' }));
  const call = f.calls.find(item => item.path.endsWith('/lifecycle'));
  assert.equal(call.init.method, 'PATCH'); assert.deepEqual(JSON.parse(call.init.body), { state: 'trial', version: 2, trialEndsAt: '2026-12-31', reason: 'Teste interno acordado' });
  assert.match(f.modal.html, /Estado comercial confirmado/); assert.match(f.modal.html, /Em teste/); assert.equal(f.changes.length, 0);
  assert.equal(f.calls.some(item => /billing|platform-access|invitations/.test(item.path)), false);
});

test('estado da própria revenda é consultável, sem formulário que altere o acordo contratado', async t => {
  const f = fixture(t); f.setRows([reseller({ lifecycle: { state: 'paused', canManage: false } })]);
  await f.ui.load(); await f.action('detail', 'reseller-a'); assert.match(f.modal.html, /Pausada/); assert.equal(f.modal.html.includes('data-accounts-form="lifecycle"'), false);
  await f.ui.submit(f.form('lifecycle', { state: 'active', reason: 'Forjado' })); assert.equal(f.calls.some(item => item.init.method === 'PATCH'), false);
});

test('falha incerta do estado comercial consulta confirmação e nunca repete o PATCH', async t => {
  let updated;
  const f = fixture(t, { intercept: async (path, init, fallback) => {
    if (path.endsWith('/lifecycle')) { updated = fallback(path, init); throw new Error('Conexão interrompida após salvar'); }
    if (updated && path === '/api/accounts/business-a') return { account: updated.account };
    return fallback(path, init);
  } });
  f.setRows([account({ lifecycle: { state: 'active', canManage: true } })]); await f.ui.load(); await f.action('detail', 'business-a');
  await f.ui.submit(f.form('lifecycle', { state: 'archived', reason: 'Conta encerrada comercialmente' }));
  await f.action('verify-write', '', { modalAction: true });
  assert.equal(f.calls.filter(item => item.path.endsWith('/lifecycle')).length, 1); assert.match(f.modal.html, /Estado comercial confirmado/); assert.match(f.modal.html, /Arquivada/);
});

test('data ausente de conta legada não fabrica cadastro em 1970', async t => {
  const f = fixture(t); f.setRows([account({ createdAt: null }), reseller({ createdAt: '' })]); await f.ui.load(); const html = f.html(); assert.equal(html.includes('1970'), false); assert.match(html, /Cadastro anterior/);
});

test('conta sem vínculo registrado conserva o tipo comercial e não presume pertencer à plataforma', async t => {
  const f = fixture(t, { platform: true });
  const rows = [
    account({ id: 'mep-demo', name: 'Plataforma QA', accountKind: 'platform', parentWorkspaceId: null }),
    reseller({ parentWorkspaceId: null }),
    account({ parentWorkspaceId: null })
  ];
  f.setRows(rows); await f.ui.load(true); const html = f.html();
  assert.equal((html.match(/<span class="pg-settings__sub">Conta da plataforma<\/span>/g) || []).length, 1);
  assert.equal((html.match(/<span class="pg-settings__sub">Vínculo não registrado<\/span>/g) || []).length, 2);
  for (const row of rows) {
    await f.action('detail', row.id);
    const context = f.modal.html.match(/<div class="pg-settings__context">(.*?)<\/div>/)?.[1];
    assert.ok(context);
    assert.match(context, row.accountKind === 'platform' ? /Administração da plataforma/ : /Vínculo não registrado/);
    if (row.accountKind !== 'platform') assert.equal(context.includes('Administração da plataforma'), false);
  }
  assert.equal(f.calls.some(call => call.init.method === 'POST' || call.init.method === 'PATCH'), false);
});

test('linhas de operação concordam unidade, pessoa e canal conectado com as quantidades reais', async t => {
  const f = fixture(t);
  f.setRows([0, 1, 2].map(count => account({ id: `count-${count}`, counts: { ...account().counts, tenants: count, users: count, connectedChannels: count } })));
  await f.ui.load(); const html = f.html();
  for (const [count, unit, person, channel] of [[0, 'unidades', 'pessoas', 'canais conectados'], [1, 'unidade', 'pessoa', 'canal conectado'], [2, 'unidades', 'pessoas', 'canais conectados']]) {
    assert.ok(html.includes(`<strong>${count} ${unit}</strong>`));
    assert.ok(html.includes(`${count} ${person} · ${count} ${channel}`));
  }
  assert.equal(html.includes('1 unidades'), false); assert.equal(html.includes('1 pessoas'), false); assert.equal(html.includes('1 canais conectados'), false);
});

test('revenda lista própria conta e clientes separados, mas vínculo comercial não habilita operação', async t => {
  const f = fixture(t); await f.ui.load(); const html = f.html(); assert.match(f.calls[0].path, /^\/api\/accounts\?/); assert.match(html, /Sua conta e seus clientes/);
  assert.equal((html.match(/data-accounts-action="operation"/g) || []).length, 1); await f.action('operation', 'business-a'); assert.equal(f.changes.length, 0); assert.match(f.messages.at(-1).message, /não permite entrar/);
  await f.action('detail', 'business-a'); assert.match(f.modal.html, /vínculo comercial não concede acesso/i); assert.equal(f.modal.html.includes('data-accounts-form="rename"'), false);
});

test('cliente business vê nome próprio editável sem cadastro de novas contas e sem papel de revenda no texto', async t => {
  const f = fixture(t); f.state.workspaceId = 'business-a'; f.state.boot.reseller = { name: 'Empresa QA', accountKind: 'business' }; f.state.boot.workspaces = [{ id: 'business-a' }]; f.setRows([account()]);
  await f.ui.load(); assert.match(f.html(), /Sua empresa/); assert.equal(f.html().includes('data-accounts-action="create"'), false); await f.action('detail', 'business-a'); assert.match(f.modal.html, /data-accounts-form="rename"/);
  const calls = f.calls.length; await f.action('create'); assert.equal(f.calls.length, calls); assert.match(f.messages.at(-1).message, /não permite criar/);
});

test('atendente e suporte delegado não consultam ou mutam contas mesmo com flags de plataforma', async t => {
  for (const mode of ['operator', 'support']) await t.test(mode, async child => {
    const f = fixture(child, { platform: true }); if (mode === 'operator') f.state.boot.session.role = 'operator'; else f.state.supportGrantId = 'grant-qa';
    assert.equal(f.html(), ''); assert.equal(await f.ui.load(true), false); await f.action('create'); await f.ui.submit(f.form('wizard', { accountKind: 'reseller' })); assert.equal(f.calls.length, 0); assert.equal(f.callbacks.length, 0);
  });
});

test('troca de workspace, pessoa, autoridade, tipo, rota ou grant aborta leitura e suprime resultado tardio', async t => {
  for (const change of ['workspace', 'person', 'csrf', 'kind', 'route', 'grant']) await t.test(change, async child => {
    const waiting = deferred(), f = fixture(child, { intercept: () => waiting.promise }); const loading = f.ui.load();
    if (change === 'workspace') f.state.workspaceId = 'other'; if (change === 'person') f.state.boot.session.userId = 'other'; if (change === 'csrf') f.state.boot.csrfToken = 'new'; if (change === 'kind') f.state.boot.reseller.accountKind = 'business'; if (change === 'route') f.state.view = 'inbox'; if (change === 'grant') f.state.supportGrantId = 'new-grant';
    f.html(); assert.equal(f.calls[0].init.signal.aborted, true); waiting.resolve(page([account({ name: 'Resposta antiga' })])); await loading;
    assert.equal(f.html().includes('Resposta antiga'), false); assert.equal(f.renders.length, 0);
  });
});

test('listas concorrentes conservam somente a resposta mais recente', async t => {
  const first = deferred(), second = deferred(); let n = 0; const f = fixture(t, { intercept: () => ++n === 1 ? first.promise : second.promise });
  const older = f.ui.load(), newer = f.ui.load(); assert.equal(f.calls[0].init.signal.aborted, true);
  second.resolve(page([account({ name: 'Lista atual' })])); await newer; first.resolve(page([account({ name: 'Lista antiga' })])); await older;
  assert.match(f.html(), /Lista atual/); assert.equal(f.html().includes('Lista antiga'), false); assert.equal(f.ui.loading, false);
});

test('listagem repetida, fora de escopo ou incompleta falha sem projetar contas', async t => {
  for (const response of [page([account(), account()]), page([account({ parentWorkspaceId: 'outside' })]), { accounts: [account()] }]) await t.test(JSON.stringify(response.accounts?.map(item => item.parentWorkspaceId)), async child => {
    const f = fixture(child, { intercept: () => response }); assert.equal(await f.ui.load(), false); assert.match(f.html(), /não confirmou|fora deste acesso/); assert.equal(f.html().includes('Gerenciar'), false);
  });
});

test('403 após página válida descarta metadados e encerra apenas o modal próprio', async t => {
  let denied = false; const f = fixture(t, { intercept: (path, init, fallback) => { if (denied) throw Object.assign(new Error('Acesso revogado.'), { status: 403 }); return fallback(path, init); } });
  await f.ui.load(); await f.action('detail', 'business-a'); denied = true; await f.ui.load(); assert.equal(f.modal.open, false); assert.match(f.html(), /Acesso revogado/); assert.equal(f.html().includes('Empresa QA'), false);
});

test('busca e tipo são codificados na API, página volta ao início e total vem do servidor', async t => {
  const f = fixture(t, { intercept: (path, init, fallback) => path.includes('q=Empresa') ? page([account()], { total: 81, offset: Number(new URL(path, 'http://local').searchParams.get('offset')) }) : fallback(path, init) });
  await f.ui.load(); await f.ui.submit(f.form('filter', { q: 'Empresa & QA', kind: 'business' })); let url = new URL(f.calls.at(-1).path, 'http://local');
  assert.equal(url.searchParams.get('q'), 'Empresa & QA'); assert.equal(url.searchParams.get('kind'), 'business'); assert.equal(url.searchParams.get('offset'), '0'); assert.match(f.html(), /81 contas/);
  await f.action('next'); url = new URL(f.calls.at(-1).path, 'http://local'); assert.equal(url.searchParams.get('offset'), '25'); await f.action('previous'); assert.equal(new URL(f.calls.at(-1).path, 'http://local').searchParams.get('offset'), '0');
  const n = f.calls.length; await f.ui.submit(f.form('filter', { q: 'x'.repeat(201), kind: 'business' })); assert.equal(f.calls.length, n);
});

test('cadastro da revenda envia identidade comercial fixa e nenhuma credencial, pessoa ou preço', async t => {
  const f = fixture(t); await f.ui.load(); const final = await f.wizard('business', { parentWorkspaceId: 'forged', name: '  Cliente novo  ' });
  assert.match(f.modal.html, /Criar conta e empresa/); assert.match(f.modal.html, /não cadastra pessoas, senhas ou preços/); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
  await f.ui.submit(final); const post = f.calls.find(call => call.init.method === 'POST'), body = JSON.parse(post.init.body);
  assert.deepEqual(Object.keys(body).sort(), ['accountKind', 'initialTenantName', 'name', 'parentWorkspaceId', 'requestId', 'segment']); assert.equal(body.parentWorkspaceId, 'reseller-a'); assert.equal(body.name, 'Cliente novo'); assert.equal(body.initialTenantName, 'Matriz QA'); assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.match(f.modal.html, /Conta criada/); assert.match(f.modal.html, /Administrador ativo/); assert.match(f.modal.html, /Pendente/); assert.equal(f.callbacks.length, 0); assert.equal(f.calls.some(call => /auth|users|invitations|billing/.test(call.path)), false);
});

test('main cadastra cliente direto ou revenda e consulta opções de vínculo paginadas', async t => {
  for (const kind of ['business', 'reseller']) await t.test(kind, async child => {
    const f = fixture(child, { platform: true, intercept: (path, init, fallback) => path.includes('kind=reseller') ? page([reseller()], { total: 103, limit: 100 }) : fallback(path, init) });
    await f.ui.load(true); await f.action('create'); assert.match(f.calls.at(-1).path, /kind=reseller&offset=0&limit=100/); await f.ui.submit(f.form('wizard', { accountKind: kind }));
    if (kind === 'business') { assert.match(f.modal.html, /primeiras 100 revendas/); assert.match(f.modal.html, /value="reseller-a"/); }
    await f.ui.submit(f.form('wizard', { name: 'Conta principal QA', parentWorkspaceId: 'mep-demo', initialTenantName: 'Matriz QA', segment: 'Serviços' })); await f.ui.submit(f.form('wizard'));
    const body = JSON.parse(f.calls.find(call => call.init.method === 'POST').init.body); assert.equal(body.accountKind, kind); assert.equal(body.parentWorkspaceId, 'mep-demo');
  });
});

test('tipo e parent forjados não passam revisão nem criam conta', async t => {
  const f = fixture(t, { platform: true }); await f.ui.load(true); await f.action('create'); const invalid = f.form('wizard', { accountKind: 'platform' }); await f.ui.submit(invalid); assert.match(invalid.feedback.textContent, /tipo de conta permitido/);
  await f.ui.submit(f.form('wizard', { accountKind: 'business' })); const fields = f.form('wizard', { name: 'Cliente QA', parentWorkspaceId: 'outside', initialTenantName: 'Matriz', segment: 'Serviços' }); await f.ui.submit(fields); assert.match(fields.feedback.textContent, /responsável disponível/); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
});

test('consulta de revendas em andamento não substitui inputs nem deixa avançar antes de confirmar opções', async t => {
  const waiting = deferred(), f = fixture(t, { platform: true, intercept: (path, init, fallback) => path.includes('kind=reseller') ? waiting.promise : fallback(path, init) });
  await f.ui.load(true); const opening = f.action('create'), form = f.form('wizard', { accountKind: 'business' }); await f.ui.submit(form); assert.match(form.feedback.textContent, /Aguarde a consulta/); assert.equal(f.modal.html.includes('name="name"'), false);
  waiting.resolve(page([reseller()], { limit: 100 })); await opening; await f.ui.submit(form); assert.match(f.modal.html, /value="reseller-a"/);
});

test('duplo submit ou clique durante criação dispara somente um POST', async t => {
  const waiting = deferred(), f = fixture(t, { intercept: (path, init, fallback) => init.method === 'POST' ? waiting.promise : fallback(path, init) }); await f.ui.load(); const final = await f.wizard();
  const first = f.ui.submit(final); assert.equal(f.ui.busy, true); assert.equal(final.button.disabled, true); await f.ui.submit(final); await f.action('create'); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  const data = JSON.parse(f.calls.find(call => call.init.method === 'POST').init.body); waiting.resolve({ account: account({ id: 'created-qa', version: 1, name: data.name }) }); await first; assert.equal(f.ui.busy, false);
});

test('criação incerta conserva requestId e payload mesmo após fechar, verificar não duplica cadastro', async t => {
  let writes = 0; const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'POST' && ++writes === 1) throw new Error('Resposta perdida.'); return fallback(path, init); } }); await f.ui.load(); const final = await f.wizard(); await f.ui.submit(final);
  assert.match(f.modal.html, /mesmo identificador/); await f.ui.submit(final); assert.equal(writes, 1); await f.action('close'); await f.action('create'); assert.match(f.modal.html, /Verificar resultado/); await f.action('verify-write');
  const bodies = f.calls.filter(call => call.init.method === 'POST').map(call => call.init.body); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.match(f.modal.html, /Conta criada/);
});

test('400 de cadastro preserva resumo e campos para corrigir sem repetir automaticamente', async t => {
  const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'POST') throw Object.assign(new Error('Nome inválido.'), { status: 400 }); return fallback(path, init); } }); await f.ui.load(); await f.ui.submit(await f.wizard());
  assert.match(f.modal.feedback.textContent, /Nome inválido/); assert.match(f.modal.html, /Nova conta QA/); await f.action('wizard-back'); assert.match(f.modal.html, /value="Nova conta QA"/); assert.match(f.modal.html, /value="Matriz QA"/); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('nome usa CAS e resposta400 mantém o input, editar não cria usuário ou convite', async t => {
  const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'PATCH') throw Object.assign(new Error('Nome recusado.'), { status: 400 }); return fallback(path, init); } }); await f.ui.load(); await f.action('detail', 'reseller-a'); const rename = f.form('rename', { name: 'Novo nome preservado' }); await f.ui.submit(rename);
  assert.equal(rename.fields.name, 'Novo nome preservado'); assert.match(f.modal.feedback.textContent, /Nome recusado/); assert.deepEqual(JSON.parse(f.calls.find(call => call.init.method === 'PATCH').init.body), { name: 'Novo nome preservado', version: 2 }); assert.equal(rename.button.disabled, false);
});

test('PATCH incerto é conferido por GET sem reenvio e conflito mantém revisão explícita', async t => {
  for (const committed of [true, false]) await t.test(String(committed), async child => {
    const f = fixture(child, { intercept: (path, init, fallback) => { if (init.method === 'PATCH') { if (committed) fallback(path, init); throw new Error('Conexão interrompida.'); } return fallback(path, init); } }); await f.ui.load(); await f.action('detail', 'reseller-a'); await f.ui.submit(f.form('rename', { name: 'Nome conferido' })); assert.match(f.modal.html, /não será enviada novamente/); await f.action('verify-write');
    assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1); assert.match(f.modal.html, committed ? /Nome atualizado e confirmado/ : /Revise antes de alterar novamente/);
  });
});

test('resposta de criação sem correspondência vira incerteza e não projeta outro parent ou nome', async t => {
  const f = fixture(t, { intercept: (path, init, fallback) => init.method === 'POST' ? { account: account({ name: 'Outra conta', parentWorkspaceId: 'outside' }) } : fallback(path, init) }); await f.ui.load(); await f.ui.submit(await f.wizard());
  assert.match(f.modal.html, /Verificar alteração|mesmo identificador/); assert.equal(f.modal.html.includes('Outra conta'), false); assert.equal(f.messages.some(message => /criadas/.test(message.message)), false);
});

test('checklist usa booleanos persistidos e não deduz administrador ativo por usuários existentes', async t => {
  const f = fixture(t); f.setRows([account({ counts: { tenants: 2, users: 22, channels: 5, agents: 3 }, onboarding: { companyCreated: true, administratorActive: false } })]); await f.ui.load(); await f.action('detail', 'business-a');
  assert.match(f.modal.html, /Administrador ativo/); assert.equal((f.modal.html.match(/Confirmado/g) || []).length, 1); assert.match(f.modal.html, /A confirmar/); assert.match(f.modal.html, />22<\/strong>/); assert.equal(f.modal.html.includes('Contrato ativo'), false);
});

test('convite, financeiro e suporte passam DTO comercial aos callbacks sem trocar workspace ou fazer envio', async t => {
  const f = fixture(t); await f.ui.load();
  for (const kind of ['invite', 'finance', 'support']) { await f.action('detail', 'business-a'); await f.action(kind); }
  assert.deepEqual(f.callbacks.map(item => item.kind), ['invite', 'finance', 'support']); for (const callback of f.callbacks) assert.equal(callback.data.id, 'business-a'); assert.equal(f.changes.length, 0); assert.equal(f.calls.some(call => call.init.method !== 'GET'), false);
});

test('Ver consumo abre a conta da linha e do detalhe sem conceder acesso à operação', async t => {
  const f = fixture(t, { platform: true }); await f.ui.load(true);
  assert.match(f.html(), /data-accounts-action="usage"/);
  await f.action('usage', 'business-a');
  assert.equal(f.callbacks.length, 1); assert.equal(f.callbacks[0].data.id, 'business-a');
  await f.action('detail', 'reseller-a');
  const node = { dataset: { accountsAction: 'usage', accountsToken: f.modal.panel.dataset.accountsToken, id: 'business-a' } };
  await f.ui.handleAction(node);
  assert.equal(f.callbacks.length, 2); assert.equal(f.callbacks[1].data.id, 'reseller-a'); assert.equal(f.callbacks[1].modalOpen, false);
  assert.equal(f.changes.length, 0); assert.equal(f.calls.some(call => call.init.method !== 'GET'), false);
  await f.ui.handleAction(node); assert.equal(f.callbacks.length, 2);
});

test('Ver consumo recusa linhas antigas, contas fora da lista e detalhe após mudança de autoridade', async t => {
  const f = fixture(t); await f.ui.load();
  const old = { dataset: { accountsAction: 'usage', accountsPageToken: f.pageToken(), id: 'business-a' } };
  await f.ui.handleAction({ dataset: { ...old.dataset, id: 'foreign-account' } });
  f.ui.reset(); await f.ui.handleAction(old); assert.equal(f.callbacks.length, 0);
  await f.ui.load(); await f.action('detail', 'business-a');
  const detail = { dataset: { accountsAction: 'usage', accountsToken: f.modal.panel.dataset.accountsToken } };
  f.state.boot.session.role = 'operator'; await f.ui.handleAction(detail);
  assert.equal(f.callbacks.length, 0); assert.equal(f.changes.length, 0); assert.equal(f.calls.some(call => call.init.method !== 'GET'), false);
});

test('Domínio e HTTPS usa token do modal atual, entrega cópia da conta correta e fecha antes do callback', async t => {
  const responses = new Map(), f = fixture(t, { intercept: (path, init, fallback) => { const result = fallback(path, init); if (/^\/api\/accounts\/[^/]+$/.test(path)) responses.set(path, result.account); return result; } });
  await f.ui.load(); await f.action('detail', 'business-a');
  const domainNode = () => { const button = f.modal.html.match(/<button\b[^>]*data-accounts-action="domains"[^>]*>/)?.[0]; assert.ok(button, 'O botão real deve estar presente no detalhe.'); return { dataset: { accountsAction: 'domains', accountsToken: button.match(/data-accounts-token="([^"]+)"/)?.[1] } }; };
  const stale = domainNode(); assert.equal(stale.dataset.accountsToken, f.modal.panel.dataset.accountsToken); await f.action('detail', 'reseller-a');
  const current = domainNode(), snapshot = structuredClone(responses.get('/api/accounts/reseller-a')), calls = f.calls.length;
  assert.notEqual(current.dataset.accountsToken, stale.dataset.accountsToken);
  await f.ui.handleAction(stale); await f.ui.handleAction({ dataset: { accountsAction: 'domains', accountsPageToken: f.pageToken(), id: 'business-a' } });
  assert.equal(f.callbacks.length, 0); assert.equal(f.modal.open, true); assert.equal(f.calls.length, calls);
  current.dataset.id = 'business-a'; await f.ui.handleAction(current);
  assert.equal(f.callbacks.length, 1); const callback = f.callbacks[0]; assert.equal(callback.kind, 'domains'); assert.equal(callback.data.id, 'reseller-a'); assert.equal(callback.data.version, snapshot.version); assert.equal(callback.modalOpen, false); assert.equal(f.modal.open, false);
  assert.notStrictEqual(callback.data, responses.get('/api/accounts/reseller-a')); assert.notStrictEqual(callback.data.counts, responses.get('/api/accounts/reseller-a').counts); assert.notStrictEqual(callback.data.onboarding, responses.get('/api/accounts/reseller-a').onboarding);
  assert.deepEqual(callback.data.counts, snapshot.counts); assert.deepEqual(callback.data.onboarding, snapshot.onboarding);
  callback.data.name = 'Nome mutado pelo consumidor'; callback.data.counts.tenants = 999; callback.data.onboarding.companyCreated = false;
  assert.deepEqual(responses.get('/api/accounts/reseller-a'), snapshot); assert.equal(f.html().includes('Nome mutado pelo consumidor'), false); assert.equal(f.html().includes('999 unidades'), false);
  await f.ui.handleAction(current); assert.equal(f.callbacks.length, 1, 'Um botão do modal fechado não repete o callback.'); assert.equal(f.calls.length, calls); assert.equal(f.changes.length, 0); assert.equal(f.calls.some(call => call.init.method !== 'GET'), false);
});

test('Domínio e HTTPS não entrega conta após mudança de identidade, autoridade, workspace, rota ou suporte', async t => {
  for (const change of ['workspace', 'person', 'csrf', 'role', 'route', 'grant']) await t.test(change, async child => {
    const f = fixture(child); await f.ui.load(); await f.action('detail', 'business-a'); const node = { dataset: { accountsAction: 'domains', accountsToken: f.modal.panel.dataset.accountsToken } }, calls = f.calls.length;
    if (change === 'workspace') f.state.workspaceId = 'other'; if (change === 'person') f.state.boot.session.userId = 'other'; if (change === 'csrf') f.state.boot.csrfToken = 'revoked'; if (change === 'role') f.state.boot.session.role = 'operator'; if (change === 'route') f.state.view = 'inbox'; if (change === 'grant') f.state.supportGrantId = 'grant-qa';
    await f.ui.handleAction(node); assert.equal(f.callbacks.length, 0); assert.equal(f.calls.length, calls); assert.equal(f.changes.length, 0); assert.equal(f.modal.open, false);
  });
});

test('operação só usa workspace já autorizado sem grant e um nodo velho não revive ação', async t => {
  const f = fixture(t); f.state.boot.workspaces.push({ id: 'business-a', supportGrantId: 'grant-qa' }); await f.ui.load(); await f.action('operation', 'business-a'); assert.equal(f.changes.length, 0);
  f.state.boot.workspaces.push({ id: 'business-a' }); await f.action('operation', 'business-a'); assert.deepEqual(f.changes, [['business-a', null]]);
  const stale = { dataset: { accountsAction: 'create', accountsPageToken: f.pageToken() } }; f.ui.reset(); await f.ui.handleAction(stale); assert.equal(f.modal.open, false);
});

test('main fora do suporte mostra revisão explícita de acesso próprio sem concessão ou entrada automática', async t => {
  const f = fixture(t, { platform: true }); await f.ui.load(true); await f.action('detail', 'business-a');
  assert.match(f.modal.html, /Acessar como administrador/); assert.match(f.modal.html, /registrada na auditoria/); assert.equal(f.callbacks.length, 0); assert.equal(f.changes.length, 0);
  await f.action('operational-access'); assert.deepEqual(f.callbacks.map(item => item.kind), ['operational-access']); assert.equal(f.callbacks[0].data.id, 'business-a'); assert.equal(f.callbacks[0].data.version, 2); assert.equal(f.changes.length, 0); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
});

test('revenda, suporte e flag platformAdmin isolada não habilitam callback de acesso operacional main', async t => {
  for (const mode of ['reseller', 'support', 'platformAdmin-only']) await t.test(mode, async child => {
    const f = fixture(child, { platform: mode !== 'reseller' }); await f.ui.load(mode !== 'reseller'); await f.action('detail', 'business-a');
    if (mode === 'support') f.state.supportGrantId = 'grant-qa';
    if (mode === 'platformAdmin-only') { f.state.boot.session.platformOwner = false; f.state.boot.session.platformAdmin = true; }
    const token = f.modal.panel?.dataset.accountsToken; await f.ui.handleAction({ dataset: { accountsAction: 'operational-access', accountsToken: token } });
    assert.equal(f.callbacks.length, 0); assert.equal(f.changes.length, 0); if (mode === 'reseller') assert.equal(f.modal.html.includes('Acessar como administrador'), false);
  });
});

test('main que já possui acesso próprio vê Abrir operação sem solicitar nova concessão', async t => {
  const f = fixture(t, { platform: true }); f.state.boot.workspaces.push({ id: 'business-a' }); await f.ui.load(true); await f.action('detail', 'business-a'); assert.match(f.modal.html, /Abrir operação/); assert.equal(f.modal.html.includes('Acessar como administrador'), false);
  await f.action('operational-access'); assert.equal(f.callbacks.length, 0);
});

test('fechar ou mudar contexto durante escrita não abre outro modal nem anuncia sucesso tardio', async t => {
  for (const mode of ['closed', 'changed', 'replaced']) await t.test(mode, async child => {
    const waiting = deferred(), f = fixture(child, { intercept: (path, init, fallback) => init.method === 'POST' ? waiting.promise : fallback(path, init) }); await f.ui.load(); const final = await f.wizard(), initialRenders = f.renders.length; const writing = f.ui.submit(final);
    if (mode === 'closed') f.modal.close(); if (mode === 'changed') { f.state.boot.csrfToken = 'revoked'; f.html(); } if (mode === 'replaced') f.modal.panel = { dataset: { accountsToken: 'another-module' } };
    waiting.resolve({ account: account({ id: 'created-qa', name: 'Nova conta QA', version: 1 }) }); await writing;
    assert.equal(f.messages.length, 0); assert.equal(f.renders.length, initialRenders); assert.equal(f.opened.at(-1).html.includes('Conta criada'), false);
  });
});

test('detalhe concorrente e DTO de outra conta não substituem a escolha atual', async t => {
  const waiting = deferred(); const f = fixture(t, { intercept: (path, init, fallback) => path === '/api/accounts/business-a' ? waiting.promise : fallback(path, init) }); await f.ui.load(); const first = f.action('detail', 'business-a'); await f.action('detail', 'reseller-a'); waiting.resolve({ account: account({ name: 'Detalhe antigo' }) }); await first; assert.match(f.modal.html, /Revenda/); assert.equal(f.modal.html.includes('Detalhe antigo'), false);
  const other = fixture(t, { intercept: (path, init, fallback) => path === '/api/accounts/business-a' ? { account: reseller() } : fallback(path, init) }); await other.ui.load(); await other.action('detail', 'business-a'); assert.match(other.modal.html, /não corresponde/);
});

test('formulário e botão de modal forjados ou de outro módulo não chamam mutações ou callbacks', async t => {
  const f = fixture(t); await f.ui.load(); await f.action('detail', 'reseller-a'); const forged = f.form('rename', { name: 'Forjado' }); forged.dataset.accountsToken = 'other'; await f.ui.submit(forged); await f.ui.handleAction({ dataset: { accountsAction: 'invite', accountsToken: 'other' } });
  assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false); assert.equal(f.callbacks.length, 0); assert.equal(await f.ui.handleAction({ dataset: {} }), false); assert.equal(await f.ui.submit({ dataset: {} }), false);
});
